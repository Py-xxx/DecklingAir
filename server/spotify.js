'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPOTIFY_API = 'https://api.spotify.com/v1';
// ReccoBeats: free drop-in for Spotify's deprecated /audio-features endpoint.
// Takes Spotify track IDs, returns the same feature schema (0-1 floats, key 0-11, mode 0/1).
const RECCOBEATS_API = 'https://api.reccobeats.com/v1';
const SPOTIFY_ACCOUNTS = 'accounts.spotify.com';
// Adaptive playback polling. Instead of a fixed fast interval, the monitor self-
// schedules: a slow base cadence while a song plays through, a single precise poll
// fired right at the predicted song-end boundary, and an immediate refresh on any
// UI action (play/pause/skip/seek). This keeps Spotify calls minimal and well-
// spaced while still reacting instantly to track changes.
const POLL_BASE       = 12000;  // slow base cadence while a song is mid-play
const POLL_IDLE       = 20000;  // nothing playing — check rarely
const POLL_END_MARGIN = 1200;   // fire this long AFTER predicted song-end to catch the next track
const POLL_MIN        = 4000;   // floor for scheduled polls (UI refresh bypasses this)
const POLL_REFRESH_DEBOUNCE = 450; // coalesce a burst of UI actions into one refresh; let state settle

// ── Smart Queue ────────────────────────────────────────────────────────────
// The unified auto-queue engine. It lets Spotify's native Autoplay drive the
// "spine" of upcoming songs, then weaves OUR slider-tuned picks in between them
// — inserting ours just-in-time (only while the song right before them is the
// current track) so they land in the correct slot ahead of the next autoplay
// pick (manual queue adds always take priority over autoplay). See the big
// block comment above the Smart Queue engine section for the full model.
// Window depth (anchor count) and the extend trigger are now derived from the
// Lookahead slider — see _sqAnchorCount() / _sqExtendAhead().
const SQ_RATIO_MIN     = 0.40;   // our share of a window must stay within this band …
const SQ_RATIO_MAX     = 0.60;   // … 40–60% ours / 40–60% Spotify (balanced)
// Local-first discovery: minimum spacing between API-backed anchor fetches. Within
// this window the Smart Queue fills its spine from the local library only.
const SQ_API_ANCHOR_COOLDOWN = 90 * 1000;

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',        // required by GET /me/library/contains (Feb 2026 API)
  'user-read-recently-played',
  'user-top-read',
].join(' ');

// Scopes that must be present in the stored token; if any are missing the user
// needs to disconnect and reconnect to get a fresh authorisation.
const REQUIRED_SCOPES = [
  'user-library-modify',
  'user-library-read',
  'user-follow-read',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-private',
];

const CONFIG_FILE        = path.join(__dirname, 'data', 'spotify-config.json');
const TOKENS_FILE        = path.join(__dirname, 'data', 'spotify-tokens.json');
const HISTORY_FILE       = path.join(__dirname, 'data', 'listening-history.ndjson');
const SESSIONS_FILE      = path.join(__dirname, 'data', 'sessions.ndjson');
const VIBE_NAMES_FILE    = path.join(__dirname, 'data', 'vibe-names.json');
const VIBE_ARCHIVE_FILE  = path.join(__dirname, 'data', 'vibe-archive.ndjson');
const USER_PREFS_FILE    = path.join(__dirname, 'data', 'user-prefs.json');
const TRACK_FEATURES_FILE = path.join(__dirname, 'data', 'track-features.json');
const LIVE_STATE_FILE    = path.join(__dirname, 'data', 'live-session.json');
const TASTE_PROFILE_FILE = path.join(__dirname, 'data', 'taste-profile.json');
const FEELING_LOG_FILE   = path.join(__dirname, 'data', 'feeling-log.ndjson');
const BREAKER_FILE       = path.join(__dirname, 'data', 'spotify-breaker.json');

// ── Background feature warming ────────────────────────────────────────────────
// An idle-time job that fetches audio features for the WHOLE saved library + top
// tracks (not just songs replayed live), so energy/valence mood & vibe matching
// can draw from the entire library instead of only recent history.
const FEATURE_WARM_START_DELAY = 2 * 60 * 1000;      // first run 2 min after startup
const FEATURE_WARM_INTERVAL    = 6 * 60 * 60 * 1000; // re-scan every 6h for newly-liked songs
// Startup stagger for the other background jobs, so they don't storm Spotify
// alongside the first interactive player/queue/playlist loads.
const SEED_START_DELAY         = 8 * 1000;           // history seed: after the first live read settles
const RECONCILE_START_DELAY    = 60 * 1000;          // away-listening reconcile: 1 min after startup
const GENRE_BACKFILL_START_DELAY = 3 * 60 * 1000;    // artist-genre backfill: after seed + feature warm kick off
const FEATURE_WARM_DELAY_MS    = 1200;               // gentle pause between each ReccoBeats fetch

const SESSION_PRUNE_DAYS       = 90;
// ── Engagement / adaptive listening ──────────────────────────────────────────
// We infer how the user feels about a track from how much of it they hear before
// it changes. Skipping early = dislike; finishing = like. This nudges selection
// toward what's actually landing (artist/track taste learning).
// The strong/soft skip thresholds are derived from the "Skip sensitivity" tuning
// slider (see _tSkipStrong/_tSkipSoft) rather than fixed constants.
const FINISH_FRAC      = 0.80;  // heard ≥80% → engaged / liked
const ARTIST_DISLIKE_SCORE = -3; // net (skips − engaged listens) at/below this → avoid the artist
// Durable cross-session taste profile (persisted to disk). Artist scores are clamped
// so taste can always recover, and a track is only soft-banned once it's been hard-
// skipped repeatedly (not on a single wrong-vibe skip).
const ARTIST_TASTE_MIN    = -8;
const ARTIST_TASTE_MAX    =  8;
const TRACK_SOFTBAN_COUNT =  2;  // net hard-skips before a track is durably soft-banned

// ── Global tuning profile ─────────────────────────────────────────────────────
// Six user-adjustable sliders (0–100, except lookahead) that shape EVERY Spotify
// feature — autoplay, smart shuffle, vibes, moods, routines and check-in feelings.
// Defaults reproduce the previous hard-coded behaviour. Persisted in user prefs.
const TUNING_DEFAULTS = {
  freshness:       45,  // % of each batch that is genuinely new music vs your library
  variety:         50,  // how far it wanders from your core taste
  fadeSmooth:      50,  // how closely consecutive tracks must match (smooth fades)
  moodFlow:        50,  // 0 = lock to the chosen mood, 100 = go with the flow
  skipSensitivity: 50,  // how hard an early skip steers it away / bans an artist
  lookahead:        5,  // tracks staged per refill batch (1–10)
};
let _tuning = { ...TUNING_DEFAULTS };

function _clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _lerp(a, b, t) { return a + (b - a) * _clampNum(t, 0, 1); }

// Derived engine knobs — every feature reads these, never the raw slider values.
function _tDiscoveryRatio() { return _clampNum(_tuning.freshness / 100, 0, 0.9); }
function _tVariety()        { return _clampNum(_tuning.variety / 100, 0, 1); }
// Feeling-band padding. Variety sets the MAX widening (±0–25); moodFlow gates how
// much of it actually applies. At moodFlow=0 (lock) we even TIGHTEN a little below
// the raw mood range to keep it pure; at 100 (flow) the full Variety pad applies.
// This is what makes "lock to mood" actually narrow the energy/valence window so a
// low-energy sad song can't bleed into the high-energy Angsty band.
function _tMoodPad()        { return Math.round(_lerp(-6, _lerp(0, 25, _tVariety()), _tuning.moodFlow / 100)); }
function _tMoodFlow()       { return _clampNum(_tuning.moodFlow / 100, 0, 1); }     // 0 lock … 1 flow
function _tDiscoveryGenres(){ return 2 + Math.round(_tVariety() * 3); }            // 2–5 genres searched
function _tFlowOn()         { return _tuning.fadeSmooth >= 50; }                   // harmonic flow ordering
function _tDriftThreshold() { return _lerp(0.45, 0.20, _tuning.moodFlow / 100); } // lock → flow
function _tSkipStrong()     { return _lerp(0.08, 0.25, _tuning.skipSensitivity / 100); }
function _tSkipSoft()       { return _lerp(0.35, 0.60, _tuning.skipSensitivity / 100); }
function _tLookahead()      { return _clampNum(Math.round(_tuning.lookahead), 1, 10); }
// Smart Queue window depth derives from the Lookahead slider: how many discovery
// anchors form each window's spine, and how few slots may remain ahead of the
// current track before we extend. Capped small (≤5 anchors) on purpose — the app
// is local-first now and a shallow window means rare, well-spaced discovery fetches
// instead of building a deep queue that hammers the API.
function _sqAnchorCount()   { return _clampNum(_tLookahead() + 1, 3, 5); }
function _sqExtendAhead()   { return _clampNum(Math.ceil(_tLookahead() / 2), 2, 4); }

// Validate + apply an incoming tuning patch, clamping each field to its range.
function _applyTuning(patch = {}) {
  const n = { ..._tuning };
  if (patch.freshness       != null) n.freshness       = _clampNum(+patch.freshness,       0, 100);
  if (patch.variety         != null) n.variety         = _clampNum(+patch.variety,         0, 100);
  if (patch.fadeSmooth      != null) n.fadeSmooth      = _clampNum(+patch.fadeSmooth,      0, 100);
  if (patch.moodFlow        != null) n.moodFlow        = _clampNum(+patch.moodFlow,        0, 100);
  if (patch.skipSensitivity != null) n.skipSensitivity = _clampNum(+patch.skipSensitivity, 0, 100);
  if (patch.lookahead       != null) n.lookahead       = _clampNum(Math.round(+patch.lookahead), 1, 10);
  _tuning = n;
  return _tuning;
}

const SESSION_GAP_MS      = 10 * 60 * 1000;  // 10 min silence → close session
const SESSION_MIN_MS      = 15 * 1000;        // ignore sessions shorter than 15s
const RECONCILE_INTERVAL  = 30 * 60 * 1000;  // reconcile away-plays every 30 min
const PROGRESS_DELTA_MAX  = POLL_BASE * 2.5; // sanity cap on progress delta between polls

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _io = null;
let _pollTimeout = null;     // handle for the next self-scheduled poll (adaptive)
let _polling = false;        // true while the playback monitor loop is active
let _featureWarmTimer = null;
let _lastState = null;
let _lastTrackId = null;
let _autoQueueCount = 0;

// ── Smart Queue state ───────────────────────────────────────────────────────
// _smartQueueEnabled is the user toggle (Playback panel). When OFF we leave
// searched songs / playlist-ends to Spotify's own native Autoplay untouched —
// BUT moods & vibes ALWAYS run on Smart Queue regardless of this flag.
let _smartQueueEnabled = true;
// The single active Smart Queue session, or null. Shape documented at the
// Smart Queue engine section (window[], pos, noRepeat, ourUris, …).
let _sq = null;
let _sqSessionSeq = 0; // monotonically increasing session id for logging
let _sqLastApiAnchorFetch = 0; // last time we topped up anchors from the live API (cooldown gate)

let _userProfile = null;
let _userId = null;
let _sessionStats = {
  startTime: Date.now(),
  tracksPlayed: [], // { id, title, artist, startTime, durationMs }
};

// ── Persistent session tracking ───────────────────────────────────────────────
// _sessions:       closed sessions loaded from sessions.ndjson + newly closed ones
// _activeSession:  in-progress session (null when nothing is playing)
// _lastProgress:   last progress_ms from poll (null when paused/unknown)
let _sessions       = [];
let _activeSession  = null;  // { id, startTime, lastActivityTime, listenedMs, trackCount }
let _lastProgress   = null;
let _reconcileTimer = null;
let _statsBroadcastTick = 0; // counter to throttle periodic stats broadcasts
let _liveSaveTick       = 0; // counter to throttle live-session snapshots to disk

let _history        = [];   // all-time log entries, loaded from file on start
let _seededHistory  = [];   // in-memory only: entries seeded from Spotify API
let _seedTimestamp  = 0;    // when _seededHistory was last populated
let _seedInFlight   = false; // guard so the startup seed and the hourly refresh can't overlap
let _librarySeeds   = [];   // whole saved library + top tracks, feature-warmed in the
                            // background so mood/vibe matching draws from the full library
let _libraryWarmedAt = 0;   // when _librarySeeds was last (re)built
let _vibeNames      = {};   // { vibeKey: 'Custom Name' }
let _activeVibeKey  = null;  // currently running continuous vibe (null = stopped)
let _activeMoodKey  = null;  // currently running continuous mood (null = stopped)
// _activeMixTarget: the unified "mood map" target driving continuous playback —
// { energy, valence, spread, label, vibeKey }. A point in energy×valence space the
// user picked on the 2D pad (or a named cluster's centroid). Supersedes mood/vibe as
// the single selection model; null = no mix running.
let _activeMixTarget = null;
// Track IDs played OR auto-queued during the current session. Every automatic queueing
// method skips tracks already in here so a song never repeats within a session.
// Reset when a session opens/closes.
let _sessionTrackIds = new Set();

// Rolling cap on session memory. Without this the Set grows unbounded over a long
// session and eventually excludes every candidate the builders can find (top-tracks,
// curated playlists, history) — starving vibes/moods/autoplay so they queue 3-5 then
// stall. A Set keeps insertion order, so we prune oldest-first once over the cap.
const SESSION_TRACK_MEMORY = 200;
function _markPlayed(id) {
  if (!id) return;
  _sessionTrackIds.add(id);
  const overflow = _sessionTrackIds.size - SESSION_TRACK_MEMORY;
  if (overflow > 0) {
    const it = _sessionTrackIds.values();
    for (let i = 0; i < overflow; i++) _sessionTrackIds.delete(it.next().value);
  }
}

// URIs WE deliberately staged into the queue (Smart Queue picks + manual search
// adds). Spotify's own Autoplay can silently append recommended tracks to the queue;
// those injected tracks aren't in here, so we can tell our picks apart from autoplay's.
let _stagedUris = new Set();
function _setStaged(uris) { _stagedUris = new Set((uris || []).filter(Boolean)); }
function _addStaged(uris) { for (const u of (uris || [])) if (u) _stagedUris.add(u); }

// Ordered IDs of the tracks we've ACTUALLY played most recently (pushed on track
// change, newest last). Unlike _sessionTrackIds — which also holds merely-staged
// tracks and caps at 200 — this is a tight "don't replay this soon" window. The
// refill's never-starve fallback (fresh = tracks) used to re-stage already-played
// songs when a narrow vibe pool ran dry, causing the same track to come back after
// only 3-5 songs. We hard-block anything in this window from being re-staged.
let _recentPlayIds = [];
const RECENT_PLAY_GUARD = 30; // no song repeats until this many others have played
function _notePlayed(id) {
  if (!id) return;
  const i = _recentPlayIds.indexOf(id);
  if (i !== -1) _recentPlayIds.splice(i, 1); // move to most-recent
  _recentPlayIds.push(id);
  if (_recentPlayIds.length > RECENT_PLAY_GUARD) _recentPlayIds.shift();
}
function _isRecentlyPlayed(id) { return !!id && _recentPlayIds.includes(id); }

// ── Adaptive engagement ───────────────────────────────────────────────────────
// _artistTaste:  lowercase artist → durable net score, PERSISTED across sessions.
//                Each hard skip −1, each engaged listen +1 (clamped). An artist is
//                avoided once the net hits ARTIST_DISLIKE_SCORE; later listens recover it.
// _trackDislikes: trackId → durable hard-skip count, PERSISTED across sessions. A track
//                is soft-banned once skipped TRACK_SOFTBAN_COUNT times; a full listen
//                decays the count back down (recovery).
let _artistTaste   = new Map();
// _artistRating: lowercase artist → EXPLICIT user rating, PERSISTED. This is a
// deliberate override of the learned/play-count heuristics: the engine over-promotes
// artists you merely play a lot, so an explicit rating wins. Levels:
//   2 Love · 1 Like · 0 Neutral · -1 Dislike · -2 Never (strong down-weight, not a block).
let _artistRating  = new Map();
// _artistGenres: Spotify artistId → raw Spotify genre strings, PERSISTED. Genres
// live on artists (not tracks/audio-features) and effectively never change, so we
// fetch once and cache to disk. Powers the Genres tab's macro-genre filtering.
let _artistGenres  = new Map();
let _genreBackfillTimer = null;
let _trackDislikes = new Map();
// _skipSlot: trackId → the time-slot key ("weekday:evening") of its LAST hard skip.
// Lets the engine spot a "rescued" pick: a track you skipped in one context that
// now fits THIS context. PERSISTED alongside the taste profile.
let _skipSlot = new Map();

// _slotBias: composite context key ("weekday:evening") → { dE, dV } learned nudge
// applied to that slot's centroid. Skips are negative signal that NEVER reach the
// history-derived centroid (you skipped it, so it's not in history) — this is how
// a skip at 11pm sharpens the late-night model: it pushes the slot centroid AWAY
// from what didn't fit. Bounded so it can only refine, never hijack, the learned
// sound. Persisted alongside the taste profile.
const _slotBias = new Map();
const SLOT_BIAS_MAX = 12;   // ± clamp on energy/valence (0–100 scale)
const SLOT_BIAS_STEP = 1.5; // per-skip nudge; small so it takes a pattern to move

// ── Transition learning (Feature 6) ───────────────────────────────────────────
// _transitions: "fromId>toId" → net score. A transition that survives (the next
// track gets an engaged listen) nudges the pair positive; a skip nudges it
// negative. flowOrder reads this so sequencing learns the user's actual taste in
// what-follows-what, not just harmonic mixing. PERSISTED across sessions.
let _transitions     = new Map();
let _transitionPrevId = null;    // id of the track that played immediately before the current one
// When the APP forces a context change (new song / playlist / mood / vibe), the
// outgoing track must NOT be judged as a user skip — the listener didn't reject
// it, they changed the station. Set to a short future deadline on every manual
// change; the next track-change in the poll loop consults it (then clears it) so
// engagement scoring is skipped exactly once. Auto-expires so a forced play that
// never actually changes the track can't silently eat a later genuine skip.
let _suppressEngageUntil = 0;
const _SUPPRESS_ENGAGE_MS = 12000;
const TRANSITION_KEY = (from, to) => `${from}>${to}`;
const TRANSITION_CLAMP = 5;      // bound each pair so one outlier can't dominate
const TRANSITION_WEIGHT = 0.20;  // how much a learned transition can shift a flow score
const REDISCOVER_MIN_AGE_MS = 21 * 24 * 60 * 60 * 1000; // "haven't heard in a while" floor (#2)

// ── Cluster & feeling detection ───────────────────────────────────────────────
let _currentCluster    = [];     // tracks in the current emerging cluster (with features)
let _currentCentroid   = null;   // { energy, valence, bpm } mean of _currentCluster
let _driftBuffer       = [];     // consecutive tracks that are "far" from _currentCentroid
let _pendingCheckIn    = null;   // { fingerprint, guessedFeeling, clusterSnapshot, timestamp }
let _activeFeeling     = null;   // { key, label, emoji, confirmedAt, centroid, clusterTracks }
let _lastCheckInAt     = 0;      // cluster size when last check-in was triggered
let _checkInAutoEnabled = true;  // user preference

// ── Display timezone ──────────────────────────────────────────────────────
// The Raspberry Pi host may be left on UTC, which skews every hour-of-day (`h`)
// and day-of-week (`dow`) field we derive — vibes, time-slots, the heatmap and
// learned stop-time all read those. Since every log entry also stores an
// absolute `ts`, we can be authoritative: setting process.env.TZ makes ALL Date
// local methods (getHours/getDay/setHours/toLocaleString) operate in this zone
// regardless of the host clock, and migrateHistoryTimezone() repairs past
// entries by recomputing h/dow from their ts. IANA names handle DST per-instant.
let _displayTZ = null;
function _tzValid(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}
function applyDisplayTZ(tz) {
  if (!_tzValid(tz)) return false;
  _displayTZ = tz;
  process.env.TZ = tz; // Node re-reads TZ for Date objects constructed afterwards
  return true;
}

// ---------------------------------------------------------------------------
// Config / token storage
// ---------------------------------------------------------------------------

function loadCfg() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCfg(data) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('[Spotify] Failed to save config:', err.message);
    return false;
  }
}

function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTokens(data) {
  try {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('[Spotify] Failed to save tokens:', err.message);
    return false;
  }
}

function deleteTokens() {
  try {
    fs.unlinkSync(TOKENS_FILE);
  } catch {
    // ignore
  }
}

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n');
    _history = lines
      .map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } })
      .filter(Boolean);
    const withFeatures = _history.filter(e => e.energy != null).length;
    console.log(`[Spotify] Loaded ${_history.length} history entries (${withFeatures} with audio features)`);
    if (_history.length > 0) {
      const sample = _history[_history.length - 1];
      console.log(`[Spotify] History sample keys: ${Object.keys(sample).join(',')} — id=${sample.id} energy=${sample.energy}`);
    }
  } catch (err) {
    console.error('[Spotify] Failed to load history:', err.message);
    _history = [];
  }
}

// Rewrite one NDJSON log file in place, recomputing each entry's h/dow from its
// absolute ts in the active timezone. Backs up to <file>.bak first. Returns
// { migrated, total } (entries changed / entries with a ts), or null on failure.
function _migrateNdjsonTZ(file) {
  try {
    if (!fs.existsSync(file)) return { migrated: 0, total: 0 };
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let migrated = 0, total = 0;
    const out = lines.map((line) => {
      const s = line.trim();
      if (!s) return line;
      let e;
      try { e = JSON.parse(s); } catch { return line; }
      if (!e || e.ts == null) return line;
      total++;
      const d = new Date(e.ts);
      const nh = d.getHours();
      const nd = d.getDay();
      if (e.h !== nh || e.dow !== nd) { e.h = nh; e.dow = nd; migrated++; }
      return JSON.stringify(e);
    });
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, out.join('\n'));
    return { migrated, total };
  } catch (err) {
    console.error(`[Spotify] TZ migration failed for ${file}:`, err.message);
    return null;
  }
}

// One-time repair across both timestamped logs after the display timezone is
// (re)configured, then reload them so the corrected h/dow take effect at once.
function migrateHistoryTimezone() {
  const hist = _migrateNdjsonTZ(HISTORY_FILE);
  const feel = _migrateNdjsonTZ(FEELING_LOG_FILE);
  loadHistory();
  loadFeelingLog();
  const sum = {
    timeZone: _displayTZ,
    history: hist || { migrated: 0, total: 0 },
    feelings: feel || { migrated: 0, total: 0 },
  };
  console.log(`[Spotify] TZ migration → zone=${_displayTZ} history ${sum.history.migrated}/${sum.history.total}, feelings ${sum.feelings.migrated}/${sum.feelings.total}`);
  return sum;
}

function loadVibeNames() {
  try {
    if (fs.existsSync(VIBE_NAMES_FILE))
      _vibeNames = JSON.parse(fs.readFileSync(VIBE_NAMES_FILE, 'utf8'));
  } catch { _vibeNames = {}; }
}

function saveVibeNames() {
  try {
    fs.mkdirSync(path.dirname(VIBE_NAMES_FILE), { recursive: true });
    fs.writeFileSync(VIBE_NAMES_FILE, JSON.stringify(_vibeNames, null, 2));
  } catch (err) { console.error('[Spotify] Failed to save vibe names:', err.message); }
}

// ── Persistent cross-session taste profile ───────────────────────────────────
// _artistTaste + _trackDislikes are durable: the signals we already compute from
// listening engagement (skips / finishes) are written through to disk so taste
// carries across sessions instead of resetting each time.
let _tasteSaveTimer = null;
let _tasteDirty = false;

// ── Feeling log ───────────────────────────────────────────────────────────────
// When the user answers a check-in ("how have you been feeling?"), we DON'T start
// playback — we just record the answer as a labeled sample: at this time/day, with
// this audio fingerprint and these tracks, you reported feeling X. These labels are
// the ground truth that powers the slot prediction (what vibe you're usually going
// for right now) — far more reliable than guessing a feeling purely from audio.
let _feelingLog = []; // [{ ts, h, dow, feeling, energy, valence, bpm, trackIds }]
const FEELING_LOG_MAX = 2000;

function loadFeelingLog() {
  try {
    if (!fs.existsSync(FEELING_LOG_FILE)) return;
    _feelingLog = fs.readFileSync(FEELING_LOG_FILE, 'utf8').split('\n')
      .map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } })
      .filter(Boolean);
    console.log(`[Spotify] Loaded ${_feelingLog.length} feeling labels`);
  } catch (err) {
    console.error('[Spotify] loadFeelingLog error:', err.message);
  }
}

function _recordFeeling(feeling, fingerprint, clusterSnapshot) {
  const entry = {
    ts: Date.now(),
    h:  new Date().getHours(),
    dow: new Date().getDay(),
    feeling,
    energy:  fingerprint?.energy  != null ? Math.round(fingerprint.energy)  : null,
    valence: fingerprint?.valence != null ? Math.round(fingerprint.valence) : null,
    bpm:     fingerprint?.bpm      ? Math.round(fingerprint.bpm) : null,
    trackIds: (clusterSnapshot || []).map(t => t && t.id).filter(Boolean).slice(0, 30),
  };
  _feelingLog.push(entry);
  if (_feelingLog.length > FEELING_LOG_MAX) _feelingLog = _feelingLog.slice(-FEELING_LOG_MAX);
  _contextProfilesAt = 0; // invalidate cached prediction so the new label counts immediately
  try {
    fs.mkdirSync(path.dirname(FEELING_LOG_FILE), { recursive: true });
    fs.appendFileSync(FEELING_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[Spotify] feeling log append error:', err.message);
  }
  return entry;
}

function loadTasteProfile() {
  try {
    if (!fs.existsSync(TASTE_PROFILE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(TASTE_PROFILE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj.artistScores || {})) {
      if (typeof v === 'number') _artistTaste.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.artistRatings || {})) {
      if (typeof v === 'number' && v >= -2 && v <= 2) _artistRating.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.artistGenres || {})) {
      if (Array.isArray(v)) _artistGenres.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.trackDislikes || {})) {
      if (typeof v === 'number') _trackDislikes.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.skipSlot || {})) {
      if (typeof v === 'string') _skipSlot.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.transitions || {})) {
      if (typeof v === 'number') _transitions.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.slotBias || {})) {
      if (v && typeof v === 'object') _slotBias.set(k, { dE: Number(v.dE) || 0, dV: Number(v.dV) || 0 });
    }
    console.log(`[Spotify] Loaded taste profile — ${_artistTaste.size} artists, ${_artistRating.size} rated, ${_trackDislikes.size} disliked tracks, ${_transitions.size} transitions, ${_slotBias.size} slot biases`);
  } catch (err) {
    console.error('[Spotify] loadTasteProfile error:', err.message);
  }
}

function saveTasteProfile() {
  _tasteDirty = false;
  try {
    fs.mkdirSync(path.dirname(TASTE_PROFILE_FILE), { recursive: true });
    const obj = {
      artistScores:  Object.fromEntries(_artistTaste),
      artistRatings: Object.fromEntries(_artistRating),
      artistGenres:  Object.fromEntries(_artistGenres),
      trackDislikes: Object.fromEntries(_trackDislikes),
      skipSlot:      Object.fromEntries(_skipSlot),
      transitions:   Object.fromEntries(_transitions),
      slotBias:      Object.fromEntries(_slotBias),
    };
    fs.writeFileSync(TASTE_PROFILE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('[Spotify] saveTasteProfile error:', err.message);
  }
}

// Debounced so a burst of engagement updates collapses into one disk write.
function _scheduleTasteSave() {
  _tasteDirty = true;
  if (_tasteSaveTimer) return;
  _tasteSaveTimer = setTimeout(() => {
    _tasteSaveTimer = null;
    if (_tasteDirty) saveTasteProfile();
  }, 3000);
}

function loadUserPrefs() {
  try {
    if (fs.existsSync(USER_PREFS_FILE)) {
      const prefs = JSON.parse(fs.readFileSync(USER_PREFS_FILE, 'utf8'));
      if (prefs.checkInAuto != null) _checkInAutoEnabled = !!prefs.checkInAuto;
      if (prefs.smartQueue != null) _smartQueueEnabled = !!prefs.smartQueue;
      if (prefs.tuning && typeof prefs.tuning === 'object') {
        _applyTuning(prefs.tuning);
      }
    }
  } catch { }
}

function saveUserPrefs() {
  try {
    fs.mkdirSync(path.dirname(USER_PREFS_FILE), { recursive: true });
    fs.writeFileSync(USER_PREFS_FILE, JSON.stringify({ checkInAuto: _checkInAutoEnabled, smartQueue: _smartQueueEnabled, tuning: _tuning }, null, 2));
  } catch (err) { console.error('[Spotify] Failed to save user prefs:', err.message); }
}

function appendHistory(entry) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
    _history.push(entry);
  } catch (err) { console.error('[Spotify] Failed to append history:', err.message); }
}

// ── Session persistence ───────────────────────────────────────────────────────

function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) { _sessions = []; return; }
    const lines = fs.readFileSync(SESSIONS_FILE, 'utf8')
      .split('\n').filter(l => l.trim());
    _sessions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
                     .filter(Boolean);
    console.log(`[Spotify] Loaded ${_sessions.length} past sessions`);
    pruneAndArchiveSessions();
  } catch (err) {
    console.error('[Spotify] Failed to load sessions:', err.message);
    _sessions = [];
  }
}

function appendSession(session) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.appendFileSync(SESSIONS_FILE, JSON.stringify(session) + '\n');
  } catch (err) { console.error('[Spotify] Failed to append session:', err.message); }
}

/**
 * Move sessions older than SESSION_PRUNE_DAYS into the compact vibe archive,
 * then rewrite sessions.ndjson with only the recent entries.
 *
 * vibe-archive.ndjson — one line per unique track URI:
 *   { "uri": "spotify:track:…", "vibeKey": "hype", "count": 5, "lastSeen": <ms> }
 *
 * The archive is never pruned — it's small (one line per unique track) and is the
 * long-term memory for vibe clustering.
 */
function pruneAndArchiveSessions() {
  const cutoffMs = Date.now() - SESSION_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const toKeep   = _sessions.filter(s => (s.endTime || s.startTime) >= cutoffMs);
  const toPrune  = _sessions.filter(s => (s.endTime || s.startTime) <  cutoffMs);

  if (!toPrune.length) return;
  console.log(`[Spotify] Pruning ${toPrune.length} sessions older than ${SESSION_PRUNE_DAYS} days`);

  // ── Load existing vibe archive ──────────────────────────────────────────────
  const archiveMap = new Map(); // uri → entry
  try {
    if (fs.existsSync(VIBE_ARCHIVE_FILE)) {
      const lines = fs.readFileSync(VIBE_ARCHIVE_FILE, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.uri) archiveMap.set(entry.uri, entry);
        } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    console.error('[Spotify] Failed to load vibe archive:', err.message);
  }

  // ── Extract track → vibe mappings from pruned sessions ─────────────────────
  const allHistory = [..._history, ..._seededHistory];
  for (const session of toPrune) {
    const trackIds = session.trackIds || [];
    for (const trackId of trackIds) {
      const histEntry = allHistory.find(h => h.id === trackId);
      if (!histEntry) continue;
      const vibeKey = getVibeKey(histEntry);
      if (!vibeKey) continue;

      const uri = `spotify:track:${trackId}`;
      const existing = archiveMap.get(uri);
      if (existing) {
        existing.count    = (existing.count || 1) + 1;
        existing.lastSeen = Math.max(existing.lastSeen || 0, session.endTime || session.startTime);
        // If observed in a different vibe now, keep the most recent assignment
        if ((session.endTime || session.startTime) > (existing.lastSeen || 0)) {
          existing.vibeKey = vibeKey;
        }
      } else {
        archiveMap.set(uri, {
          uri,
          vibeKey,
          count:    1,
          lastSeen: session.endTime || session.startTime,
        });
      }
    }
  }

  // ── Write updated vibe archive ──────────────────────────────────────────────
  try {
    fs.mkdirSync(path.dirname(VIBE_ARCHIVE_FILE), { recursive: true });
    const content = [...archiveMap.values()].map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(VIBE_ARCHIVE_FILE, content + (content ? '\n' : ''));
    console.log(`[Spotify] Vibe archive updated — ${archiveMap.size} unique tracks`);
  } catch (err) {
    console.error('[Spotify] Failed to write vibe archive:', err.message);
    return; // Don't prune sessions.ndjson if the archive write failed
  }

  // ── Rewrite sessions.ndjson with only the recent entries ───────────────────
  try {
    _sessions = toKeep;
    const content = toKeep.map(s => JSON.stringify(s)).join('\n');
    fs.writeFileSync(SESSIONS_FILE, content + (content ? '\n' : ''));
    console.log(`[Spotify] sessions.ndjson pruned — ${toKeep.length} sessions kept`);
  } catch (err) {
    console.error('[Spotify] Failed to rewrite sessions file:', err.message);
  }
}

function openActiveSession() {
  _activeSession = {
    id:               `session_${Date.now()}`,
    startTime:        Date.now(),
    lastActivityTime: Date.now(),
    listenedMs:       0,
    trackCount:       0,
    trackIds:         [],
  };
  // Fresh session → fresh no-repeat memory.
  // (Artist taste + track dislikes are durable now — they live in the taste profile.)
  _sessionTrackIds  = new Set();
}

function closeActiveSession() {
  if (!_activeSession) return;
  const session = _activeSession;
  _activeSession = null;
  _lastProgress  = null;

  // Reset cluster state when session ends
  _currentCluster  = [];
  _currentCentroid = null;
  _driftBuffer     = [];
  _pendingCheckIn  = null;
  _lastCheckInAt   = 0;
  _sessionTrackIds  = new Set();
  if (_activeFeeling) {
    _activeFeeling = null;
    if (_io) _io.emit('spotify:feeling_expired');
  }

  if (session.listenedMs < SESSION_MIN_MS) return; // too short to bother saving

  const record = {
    id:          session.id,
    startTime:   session.startTime,
    endTime:     Date.now(),
    listenedMs:  session.listenedMs,
    trackCount:  session.trackCount,
    trackIds:    session.trackIds || [],
    source:      'live',
  };
  _sessions.push(record);
  appendSession(record);
  clearLiveState(); // session genuinely over — drop the resume snapshot
  console.log(`[Spotify] Session closed — ${Math.round(record.listenedMs / 60000)} min listened, ${record.trackCount} tracks`);
}

// ── Live session persistence ───────────────────────────────────────────────
// The active session + its derived "intelligence" (emerging cluster, adaptive
// artist scores, recent likes, active feeling, UI session stats) live only in
// memory, so a `pm2 restart` would wipe them mid-session. We snapshot them to
// disk periodically and restore on boot — but only if the gap since the last
// activity is within SESSION_GAP_MS. A longer gap means the session genuinely
// ended while the server was down, so we finalize it as a closed session.
function saveLiveState() {
  try {
    if (!_activeSession) { clearLiveState(); return; }
    const snap = {
      savedAt:          Date.now(),
      sessionStats:     _sessionStats,
      activeSession:    _activeSession,
      sessionTrackIds:  [..._sessionTrackIds],
      currentCluster:   _currentCluster,
      currentCentroid:  _currentCentroid,
      driftBuffer:      _driftBuffer,
      activeFeeling:    _activeFeeling,
      pendingCheckIn:   _pendingCheckIn,
      lastCheckInAt:    _lastCheckInAt,
      lastTrackId:      _lastTrackId,
    };
    fs.mkdirSync(path.dirname(LIVE_STATE_FILE), { recursive: true });
    fs.writeFileSync(LIVE_STATE_FILE, JSON.stringify(snap));
  } catch (err) {
    console.error('[Spotify] saveLiveState error:', err.message);
  }
}

function clearLiveState() {
  try { if (fs.existsSync(LIVE_STATE_FILE)) fs.unlinkSync(LIVE_STATE_FILE); }
  catch (err) { console.error('[Spotify] clearLiveState error:', err.message); }
}

function loadLiveState() {
  try {
    if (!fs.existsSync(LIVE_STATE_FILE)) return;
    const snap = JSON.parse(fs.readFileSync(LIVE_STATE_FILE, 'utf8'));
    const sess = snap.activeSession;
    if (!sess) { clearLiveState(); return; }
    const lastActivity = sess.lastActivityTime || snap.savedAt || 0;
    const gap = Date.now() - lastActivity;

    if (gap <= SESSION_GAP_MS) {
      // Same session — restore everything so the UI + intelligence continue seamlessly
      _sessionStats     = snap.sessionStats     || _sessionStats;
      _activeSession    = sess;
      _sessionTrackIds  = new Set(snap.sessionTrackIds  || []);
      _currentCluster   = snap.currentCluster   || [];
      _currentCentroid  = snap.currentCentroid  || null;
      _driftBuffer      = snap.driftBuffer      || [];
      _activeFeeling    = snap.activeFeeling     || null;
      _pendingCheckIn   = snap.pendingCheckIn    || null;
      _lastCheckInAt    = snap.lastCheckInAt     || 0;
      _lastTrackId      = snap.lastTrackId       || null;
      const mins = Math.round((_activeSession.listenedMs || 0) / 60000);
      console.log(`[Spotify] Restored live session — ${mins} min, ${_activeSession.trackCount} tracks, cluster=${_currentCluster.length} (gap ${Math.round(gap / 1000)}s)`);
    } else {
      // Session ended while the server was down — finalize it as a closed session
      if ((sess.listenedMs || 0) >= SESSION_MIN_MS && !_sessions.some(s => s.id === sess.id)) {
        const record = {
          id:         sess.id,
          startTime:  sess.startTime,
          endTime:    lastActivity,
          listenedMs: sess.listenedMs,
          trackCount: sess.trackCount,
          trackIds:   sess.trackIds || [],
          source:     'live',
        };
        _sessions.push(record);
        appendSession(record);
        console.log(`[Spotify] Finalized stale session from before restart — ${Math.round(record.listenedMs / 60000)} min (gap ${Math.round(gap / 60000)} min)`);
      }
      clearLiveState();
    }
  } catch (err) {
    console.error('[Spotify] loadLiveState error:', err.message);
  }
}

// Manual full reset: archive the current session (if worth keeping) to history,
// then wipe ALL live session + intelligence state for a clean fresh start.
// Used by the "reset session" buttons in the UI.
function resetSessionState() {
  if (_activeSession && (_activeSession.listenedMs || 0) >= SESSION_MIN_MS &&
      !_sessions.some(s => s.id === _activeSession.id)) {
    const session = _activeSession;
    const record = {
      id:         session.id,
      startTime:  session.startTime,
      endTime:    Date.now(),
      listenedMs: session.listenedMs,
      trackCount: session.trackCount,
      trackIds:   session.trackIds || [],
      source:     'live',
    };
    _sessions.push(record);
    appendSession(record);
  }
  _activeSession    = null;
  _lastProgress     = null;
  // Forget the current track so the next poll treats the now-playing song as the
  // first track of a brand-new session (fresh cluster + counter), exactly as if the
  // user had stepped away past the session gap and come back.
  _lastTrackId      = null;
  _currentCluster   = [];
  _currentCentroid  = null;
  _driftBuffer      = [];
  _pendingCheckIn   = null;
  _lastCheckInAt    = 0;
  _sessionTrackIds  = new Set();
  _stagedUris       = new Set();
  _recentPlayIds    = [];     // fresh session = no recent-repeat history to guard against
  _transitionPrevId = null;   // new session = no prior track to chain a transition from
  // Durable taste (artist scores + track dislikes) intentionally survives a reset —
  // it's a long-term profile, not session state.
  // Stop any running continuous engine — otherwise it keeps refilling from the old
  // context and the reset looks like it did nothing.
  const hadFeeling = !!_activeFeeling;
  const hadEngine  = !!(_activeMoodKey || _activeVibeKey || _activeFeeling || _activeMixTarget);
  _activeMoodKey   = null;
  _activeVibeKey   = null;
  _activeMixTarget = null;
  _activeFeeling   = null;
  _autoQueueCount = 0;
  if (hadFeeling && _io) _io.emit('spotify:feeling_expired');
  if (hadEngine && _io) {
    _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null, activeMix: null });
  }
  _sessionStats = { startTime: Date.now(), tracksPlayed: [] };
  clearLiveState();
  console.log('[Spotify] Session manually reset — fresh session started');
}

// ── Away-listening reconciliation ─────────────────────────────────────────────

async function reconcileRecentlyPlayed() {
  if (!isAuthed() || _spotifyRateLimited()) return;
  try {
    const rp = await api('GET', '/me/player/recently-played', { params: { limit: 50 }, priority: 'low' });
    const items = rp?.items || [];
    if (!items.length) return;

    // Build a set of timestamp ranges we already have covered (live sessions)
    const covered = [..._sessions, ...(_activeSession ? [{
      startTime: _activeSession.startTime,
      endTime:   _activeSession.lastActivityTime + SESSION_GAP_MS,
    }] : [])];

    const isCovered = (ts) => covered.some(s =>
      ts >= (s.startTime - 5 * 60 * 1000) && ts <= (s.endTime + 5 * 60 * 1000)
    );

    // Also skip plays already in our own log (within 2 min)
    const ownTimestamps = new Set(_history.map(e => e.ts));
    const isInHistory = (ts) => {
      for (const t of ownTimestamps) {
        if (Math.abs(t - ts) < 120000) return true;
      }
      return false;
    };

    // Collect uncovered plays
    const awayPlays = [];
    for (const item of items) {
      const t = item.track;
      if (!t?.id) continue;
      const ts = new Date(item.played_at).getTime();
      if (isCovered(ts) || isInHistory(ts)) continue;
      awayPlays.push({ ts, durMs: t.duration_ms || 0, id: t.id });
    }

    if (!awayPlays.length) return;

    // Sort ascending and group into sessions by gap
    awayPlays.sort((a, b) => a.ts - b.ts);
    const awaySessions = [];
    let cur = null;
    for (const play of awayPlays) {
      if (!cur || (play.ts - cur.lastTs) > SESSION_GAP_MS) {
        if (cur) awaySessions.push(cur);
        cur = { startTime: play.ts, lastTs: play.ts, listenedMs: 0, trackCount: 0, trackIds: [] };
      }
      cur.lastTs     = play.ts;
      cur.listenedMs += Math.round(play.durMs * 0.85); // ~85%: Spotify logs at 30s+ completion
      cur.trackCount += 1;
      if (play.id) cur.trackIds.push(play.id);
    }
    if (cur) awaySessions.push(cur);

    // Save only sessions not already reconciled (check startTime overlap)
    const existingStarts = new Set(_sessions.filter(s => s.source === 'away').map(s => s.startTime));
    for (const s of awaySessions) {
      if (existingStarts.has(s.startTime)) continue;
      if (s.listenedMs < SESSION_MIN_MS) continue;
      const record = {
        id:         `away_${s.startTime}`,
        startTime:  s.startTime,
        endTime:    s.lastTs,
        listenedMs: s.listenedMs,
        trackCount: s.trackCount,
        trackIds:   s.trackIds || [],
        source:     'away',
      };
      _sessions.push(record);
      appendSession(record);
      console.log(`[Spotify] Away session added — ${Math.round(record.listenedMs / 60000)} min, ${record.trackCount} tracks`);
    }
  } catch (err) {
    console.warn('[Spotify] Reconcile recently-played failed:', err.message);
  }
}

/**
 * Merge our own logged history with Spotify-seeded entries.
 * Seeded entries without timestamps (top-tracks) are only included once
 * per unique track ID that isn't already covered by _history.
 */
function combinedHistory() {
  const ownIds = new Set(_history.map(e => e.id));
  const seen   = new Set();
  const extra  = [];
  for (const e of [..._seededHistory, ..._librarySeeds]) {
    if (e.ts) {
      // Recently-played: real play event — include as-is (already deduped vs _history at seed time)
      extra.push(e);
    } else {
      // Top-tracks (no timestamp): only include if track not already in our own log
      if (ownIds.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      extra.push(e);
    }
  }
  return [..._history, ...extra];
}

/**
 * Fetch recently-played and top-tracks from Spotify to seed _seededHistory.
 * Called once on startup (after auth) and lazily refreshed every hour.
 */
async function seedFromSpotify() {
  if (!isAuthed() || _spotifyRateLimited()) return;
  if (_seedInFlight) return; // already seeding — don't stack a second pass
  _seedInFlight = true;
  try {
    console.log('[Spotify] Seeding history from Spotify API…');
    const seeds = [];

    // 1. Recently played — has real played_at timestamps
    try {
      const rp = await api('GET', '/me/player/recently-played', { params: { limit: 50 }, priority: 'low' });
      for (const item of (rp?.items || [])) {
        const t = item.track;
        if (!t?.id) continue;
        const ts = new Date(item.played_at).getTime();
        // Skip if we already logged this exact play ourselves (within 2 min)
        const dupe = _history.some(h => h.id === t.id && Math.abs((h.ts || 0) - ts) < 120000);
        if (dupe) continue;
        const d = new Date(ts);
        seeds.push({
          id: t.id, uri: t.uri,
          title: t.name,
          artist: t.artists?.map(a => a.name).join(', ') || '',
          album: t.album?.name || '',
          art: t.album?.images?.[0]?.url || '',
          ts, h: d.getHours(), dow: d.getDay(),
          seeded: true, source: 'recently_played',
        });
      }
      console.log(`[Spotify] Seed: ${seeds.length} recently-played entries`);
    } catch (e) { console.warn('[Spotify] recently-played seed failed:', e.message); }

    // 2. Top tracks (long + medium term) — no timestamps, not for time-based analysis
    const ownIds      = new Set(_history.map(e => e.id));
    const seededTopIds = new Set();
    for (const range of ['long_term', 'medium_term']) {
      try {
        const tt = await api('GET', '/me/top/tracks', { params: { time_range: range, limit: 50 }, priority: 'low' });
        let added = 0;
        for (const t of (tt?.items || [])) {
          if (!t?.id || ownIds.has(t.id) || seededTopIds.has(t.id)) continue;
          seededTopIds.add(t.id);
          seeds.push({
            id: t.id, uri: t.uri,
            title: t.name,
            artist: t.artists?.map(a => a.name).join(', ') || '',
            album: t.album?.name || '',
            art: t.album?.images?.[0]?.url || '',
            seeded: true, source: range,
          });
          added++;
        }
        console.log(`[Spotify] Seed: ${added} top-tracks (${range})`);
      } catch (e) { console.warn(`[Spotify] top-tracks ${range} seed failed:`, e.message); }
    }

    // 3. Fetch audio features for all seeds in batches of 100 so they can
    //    participate in vibe clustering (energy/valence/bpm etc.)
    const seedIds = seeds.map(s => s.id).filter(Boolean);
    const idToSeed = new Map(seeds.map(s => [s.id, s]));
    for (let i = 0; i < seedIds.length; i += 100) {
      const batch = seedIds.slice(i, i + 100);
      try {
        const features = await getBatchAudioFeatures(batch, 'low');
        features.forEach((f, idx) => {
          if (!f) return;
          const seed = idToSeed.get(batch[idx]);
          if (!seed) return;
          seed.bpm      = Math.round(f.tempo || 0);
          seed.energy   = Math.round((f.energy        || 0) * 100);
          seed.valence  = Math.round((f.valence        || 0) * 100);
          seed.dance    = Math.round((f.danceability   || 0) * 100);
          seed.acoustic = Math.round((f.acousticness   || 0) * 100);
          seed.inst     = Math.round((f.instrumentalness || 0) * 100);
        });
      } catch (e) {
        console.warn('[Spotify] Seed audio features batch failed:', e.message);
      }
    }
    const withFeatures = seeds.filter(s => s.energy != null).length;
    console.log(`[Spotify] Seed audio features: ${withFeatures}/${seeds.length} enriched`);

    _seededHistory = seeds;
    _seedTimestamp = Date.now();
    console.log(`[Spotify] Seed complete — ${_seededHistory.length} total seeded entries`);
  } catch (err) {
    console.error('[Spotify] seedFromSpotify error:', err.message);
  } finally {
    _seedInFlight = false;
  }
}

// Build a feature-bearing seed entry (no timestamp) from a raw Spotify track object.
function _libSeedFromTrack(t, source) {
  return {
    id: t.id, uri: t.uri,
    title: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '',
    album: t.album?.name || '',
    art: t.album?.images?.[0]?.url || '',
    seeded: true, source,
  };
}

// Copy a raw feature object (energy/valence 0-1) onto a seed entry on the 0-100 scale
// the rest of the engine (vibe clustering, feeling bands) expects.
function _applyFeatToSeed(seed, f) {
  if (!seed || !f) return;
  seed.bpm      = Math.round(f.tempo || 0);
  seed.energy   = Math.round((f.energy           || 0) * 100);
  seed.valence  = Math.round((f.valence          || 0) * 100);
  seed.dance    = Math.round((f.danceability     || 0) * 100);
  seed.acoustic = Math.round((f.acousticness     || 0) * 100);
  seed.inst     = Math.round((f.instrumentalness || 0) * 100);
}

let _featureWarmRunning = false;

/**
 * Background-warm the audio-features DB for the WHOLE saved library + top tracks,
 * then publish them as `_librarySeeds` so mood / vibe / feeling matching can draw
 * from the entire library instead of only songs that happened to be replayed live.
 *
 * Idempotent & resumable: features already on disk are reused instantly, only the
 * genuinely-missing ones hit ReccoBeats (throttled + an extra gentle delay so it
 * never competes with live playback fetches). Safe to re-run periodically to pick
 * up newly-liked songs.
 */
async function warmFeatureLibrary() {
  if (_featureWarmRunning || !isAuthed() || _spotifyRateLimited()) return;
  _featureWarmRunning = true;
  try {
    // 1. Gather library + top-track metadata (deduped by id)
    const byId = new Map();
    try {
      const liked = await getAllLikedSongs('low');
      for (const entry of liked) {
        const t = entry.item || entry.track;
        if (t?.id && !byId.has(t.id)) byId.set(t.id, _libSeedFromTrack(t, 'liked_library'));
      }
    } catch (e) {
      console.warn('[Spotify] Feature warm: liked-library fetch failed:', e.message);
    }
    for (const range of ['short_term', 'medium_term', 'long_term']) {
      try {
        const tt = await api('GET', '/me/top/tracks', { params: { time_range: range, limit: 50 }, priority: 'low' });
        for (const t of (tt?.items || [])) {
          if (t?.id && !byId.has(t.id)) byId.set(t.id, _libSeedFromTrack(t, 'top_' + range));
        }
      } catch { /* non-fatal */ }
    }
    if (!byId.size) { console.log('[Spotify] Feature warm: no library tracks found'); return; }

    // 2. Attach already-cached features; queue up whatever's still missing
    const missing = [];
    for (const [id, seed] of byId) {
      const feat = _audioFeaturesCache.get(id);
      if (feat) _applyFeatToSeed(seed, feat);
      else if (!_negCached(id)) missing.push(id);
    }
    // Publish immediately so the already-warm portion is usable right away
    _librarySeeds = [...byId.values()];
    _libraryWarmedAt = Date.now();
    const have = byId.size - missing.length;
    console.log(`[Spotify] Feature warm: ${byId.size} library tracks (${have} already featured, ${missing.length} to fetch)`);

    // 3. Gently fetch the missing features one at a time
    let got = 0, done = 0;
    for (const id of missing) {
      if (!isAuthed() || !_polling || _spotifyRateLimited()) break; // auth lost / shutting down / rate-limited — stop cleanly
      if (_audioFeaturesCache.has(id)) { _applyFeatToSeed(byId.get(id), _audioFeaturesCache.get(id)); done++; continue; }
      try {
        const recco = await getReccoBeatsFeatures(id);
        if (recco) { _cacheFeatures(id, recco); _applyFeatToSeed(byId.get(id), recco); got++; }
        else _audioFeaturesNegCache.set(id, Date.now());
      } catch { /* transient — leave for the next run */ }
      done++;
      if (done % 25 === 0) console.log(`[Spotify] Feature warm: ${done}/${missing.length} fetched (${got} new)`);
      await new Promise(r => setTimeout(r, FEATURE_WARM_DELAY_MS));
    }
    console.log(`[Spotify] Feature warm complete — ${got} new features (${byId.size} library tracks now pooled for matching)`);
  } catch (err) {
    console.error('[Spotify] warmFeatureLibrary error:', err.message);
  } finally {
    _featureWarmRunning = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Low-level HTTPS request wrapper.
 * opts: { headers, body (string) }
 */
function httpsRequest(method, urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: method.toUpperCase(),
      headers: opts.headers || {},
    };

    if (opts.body) {
      const bodyBuf = Buffer.from(opts.body);
      options.headers['Content-Length'] = bodyBuf.length;
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        // In raw mode the caller wants the status + headers (for ETag / 304
        // conditional requests), not just the parsed body.
        const wrap = (data) => (opts.raw ? { status: res.statusCode, headers: res.headers || {}, data } : data);

        // 304 Not Modified (conditional GET hit) and 204 No Content carry no body.
        if (res.statusCode === 304 || res.statusCode === 204) {
          return resolve(wrap(null));
        }

        // Try to parse JSON
        let parsed = null;
        if (raw.trim()) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
        }

        if (res.statusCode >= 400) {
          const message =
            (parsed && parsed.error && parsed.error.message) ||
            (typeof parsed === 'string' ? parsed : `HTTP ${res.statusCode}`);
          const err = new Error(message);
          err.status = res.statusCode;
          err.body = parsed;
          err.headers = res.headers || {};
          return reject(err);
        }

        resolve(wrap(parsed));
      });
    });

    req.on('error', reject);

    // Guard the serialized request chain against a hung socket: if no response
    // arrives in time, abort so the queue can keep draining.
    req.setTimeout(opts.timeoutMs || 15000, () => {
      req.destroy(Object.assign(new Error('Request timed out'), { status: 0 }));
    });

    if (opts.body) {
      req.write(opts.body);
    }

    req.end();
  });
}

/**
 * Spotify Web API request. Auto-refreshes token when expired.
 * opts: { body (object), params (object) }
 */
// ---------------------------------------------------------------------------
// Spotify request throttle
//
// Every Spotify Web API call is funnelled through one serialized promise chain
// with a minimum gap between requests. The gap widens automatically on HTTP 429
// (Too Many Requests) and relaxes on sustained success — so bursty seeding work
// drains slowly instead of hammering the API. On a 429 we honour the server's
// Retry-After header and pause the *entire* chain for that long, which means a
// single rate-limit response slows every queued request, not just the one that
// tripped it.
// ---------------------------------------------------------------------------
let _spotifyLastTs = 0;
let _spotifyGap = 350;                 // current spacing between requests (ms)
const SPOTIFY_GAP_MIN = 350;
const SPOTIFY_GAP_MAX = 8000;
const SPOTIFY_MAX_RETRIES = 2;
// Two kinds of 429 response, handled very differently:
//
//  • SOFT limit (short Retry-After, ≤ SPOTIFY_HARD_BAN_MS): a transient burst.
//    We pause the affected tier for the FULL Retry-After (it's short) and let the
//    interactive tier recover on its own. Tiers are kept SEPARATE so a background
//    rate-limit (history/top-tracks/library warm) doesn't stall the player.
//
//  • HARD ban (large Retry-After): the account is banned for minutes-to-hours.
//    Probing during this window is what *extends* the ban, so we open a global
//    CIRCUIT BREAKER (`_spotifyOpenUntil`): while it's open NOTHING touches the
//    Spotify host — every request fails fast locally. No caps that cause early
//    reprobing; we honour the server's full Retry-After. When it lapses, the next
//    single request probes; if it 429s again the breaker simply re-opens.
let _spotifyPauseLowUntil  = 0;        // background tier waits this out (soft limit)
let _spotifyPauseHighUntil = 0;        // interactive tier waits this out (soft limit)
let _spotifyOpenUntil      = 0;        // circuit breaker: while now < this, refuse ALL requests w/o network
const SPOTIFY_HARD_BAN_MS  = 15000;    // a Retry-After above this is treated as a hard ban → open the breaker

// ANSI colors for the at-a-glance API log: green ✓ healthy, yellow ⏳ expected
// backoff (soft 429 / circuit open), red ✗ genuine failure needing attention.
const _C = { grn: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', rst: '\x1b[0m' };

// Persist the circuit-breaker deadline so a `pm2 restart` mid-ban doesn't forget
// it and start probing Spotify again (probing is exactly what renews a hard ban).
// We only persist the HARD-ban open deadline; the short soft-pause tiers are
// transient and not worth surviving a restart.
function saveBreakerState() {
  try {
    fs.mkdirSync(path.dirname(BREAKER_FILE), { recursive: true });
    fs.writeFileSync(BREAKER_FILE, JSON.stringify({ openUntil: _spotifyOpenUntil }));
  } catch (err) {
    console.error('[Spotify] saveBreakerState error:', err.message);
  }
}

function loadBreakerState() {
  try {
    if (!fs.existsSync(BREAKER_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(BREAKER_FILE, 'utf8'));
    const until = Number(obj?.openUntil) || 0;
    if (until > Date.now()) {
      // Still inside a ban window — restore it and pause both tiers so the app
      // comes back up silent instead of immediately probing into a longer ban.
      _spotifyOpenUntil = until;
      _spotifyPauseLowUntil = _spotifyPauseHighUntil = until;
      console.warn(`${_C.yel}[Spotify] ⏳ Restored circuit breaker from disk — OPEN for ${Math.ceil((until - Date.now()) / 1000)}s more (no requests until then)${_C.rst}`);
    } else if (until) {
      // Stale ban from before the restart — clear the file so it doesn't linger.
      try { fs.unlinkSync(BREAKER_FILE); } catch { /* best effort */ }
    }
  } catch (err) {
    console.error('[Spotify] loadBreakerState error:', err.message);
  }
}

// ── Rolling health metrics ──────────────────────────────────────────────────
// One glanceable line per minute (skipped entirely on idle minutes) so you don't
// have to scan the whole log to know the integration is healthy. Counters reset
// each window; last429 persists as a rolling "how long since trouble" memory.
const _apiMetrics = { calls: 0, ok: 0, fail: 0, soft429: 0, hard429: 0, last429: 0 };
let _healthTimer = null;

function _logHealth() {
  const m = _apiMetrics;
  if (m.calls === 0 && m.soft429 === 0 && m.hard429 === 0) return; // idle minute → stay quiet
  const now = Date.now();
  const breaker = _spotifyOpenUntil > now ? `OPEN ${Math.ceil((_spotifyOpenUntil - now) / 1000)}s` : 'closed';
  const last429 = m.last429 ? `${Math.round((now - m.last429) / 1000)}s ago` : 'none';
  const color = (m.fail || m.hard429) ? _C.red : (m.soft429 ? _C.yel : _C.grn);
  const tick = (m.fail || m.hard429) ? '✗' : (m.soft429 ? '⏳' : '✓');
  console.log(`${color}[Spotify health] ${tick} ${m.ok}/${m.calls} ok · ${m.fail} fail · 429 soft ${m.soft429}/hard ${m.hard429} · last429 ${last429} · breaker ${breaker} · gap ${_spotifyGap}ms${_C.rst}`);
  m.calls = m.ok = m.fail = m.soft429 = m.hard429 = 0; // reset window (keep last429 timestamp)
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True while a 429 cooldown OR the hard-ban circuit breaker is in effect.
// Background jobs check this and skip a cycle entirely rather than queuing work
// that will just be paused/refused.
function _spotifyRateLimited() {
  const now = Date.now();
  return now < _spotifyPauseLowUntil || now < _spotifyOpenUntil;
}

// Two-tier priority queue. Interactive requests (queue/playlists/search/poll)
// go on the HIGH queue; bulk background work (library warm, history seed,
// reconcile) goes on the LOW queue. The drainer always empties HIGH before it
// touches LOW. A single min-gap AND a global rate-limit pause are enforced
// across both tiers, so one 429 stops the world instead of letting the rest of
// the queue keep hammering Spotify into a longer ban.
const _spotifyHigh = [];
const _spotifyLow = [];
let _spotifyDraining = false;

// Drop all queued background (low-priority) work — used when we hit a hard 429
// so we don't replay hundreds of already-rate-limited requests once the pause
// lifts. The bulk jobs are idempotent and re-run on their own timers.
function _flushLowQueue(reason) {
  if (!_spotifyLow.length) return;
  const n = _spotifyLow.length;
  while (_spotifyLow.length) {
    const job = _spotifyLow.shift();
    job.reject(Object.assign(new Error(reason || 'dropped (rate-limited)'), { status: 429, dropped: true }));
  }
  console.warn(`${_C.yel}[Spotify] ⏳ Dropped ${n} queued background request(s) — ${reason || 'rate-limited'}${_C.rst}`);
}

function _drainSpotify() {
  if (_spotifyDraining) return;
  _spotifyDraining = true;
  (async () => {
    try {
      while (_spotifyHigh.length || _spotifyLow.length) {
        const now = Date.now();
        // Pick the next runnable job, ALWAYS preferring the high (interactive)
        // tier. Each tier honours only its OWN circuit-breaker pause, so a
        // background rate-limit can't stall the player/queue/playlist requests.
        let job = null;
        if (_spotifyHigh.length && now >= _spotifyPauseHighUntil) {
          job = _spotifyHigh.shift();
        } else if (_spotifyLow.length && now >= _spotifyPauseLowUntil) {
          job = _spotifyLow.shift();
        }
        if (!job) {
          // Everything currently queued is paused — sleep until the soonest
          // applicable pause lifts (re-checked in ≤1 s slices so a fresh 429 that
          // extends a pause is honoured).
          const waits = [];
          if (_spotifyHigh.length) waits.push(_spotifyPauseHighUntil - now);
          if (_spotifyLow.length)  waits.push(_spotifyPauseLowUntil  - now);
          const soonest = Math.max(0, Math.min(...waits));
          await _sleep(Math.min(soonest || 200, 1000));
          continue;
        }
        const wait = Math.max(0, _spotifyLastTs + _spotifyGap - Date.now());
        if (wait > 0) await _sleep(wait);
        try {
          const data = await job.fn();
          job.resolve(data);
        } catch (err) {
          job.reject(err);
        } finally {
          _spotifyLastTs = Date.now();
        }
      }
    } finally {
      _spotifyDraining = false;
    }
  })();
}

// Serialize a unit of work behind the queue, enforcing the current min-gap.
// priority: 'high' (default, interactive) or 'low' (background bulk work).
function _spotifyThrottle(fn, priority = 'high') {
  return new Promise((resolve, reject) => {
    const job = { fn, resolve, reject };
    if (priority === 'low') _spotifyLow.push(job);
    else _spotifyHigh.push(job);
    _drainSpotify();
  });
}

// Throttled + backed-off Spotify request. On 429 it engages the GLOBAL pause
// (so every request waits, not just this one), widens the inter-request gap,
// and dumps background work on a hard ban. Background ('low') requests don't
// retry — they're best-effort and re-run on their own timers.
async function _spotifySend(method, urlStr, reqOpts, label, priority = 'high') {
  for (let attempt = 1; ; attempt++) {
    // Circuit breaker: during a hard ban we refuse locally and never touch the
    // network — probing is exactly what renews the ban. Checked again at execution
    // time inside the throttled job so a burst that slipped past here still fails
    // fast after the first re-opening 429.
    const openFor = _spotifyOpenUntil - Date.now();
    if (openFor > 0) {
      throw Object.assign(new Error(`Spotify circuit open (${Math.ceil(openFor / 1000)}s left)`), { status: 429, circuitOpen: true });
    }
    try {
      const data = await _spotifyThrottle(() => {
        const stillOpen = _spotifyOpenUntil - Date.now();
        if (stillOpen > 0) {
          throw Object.assign(new Error(`Spotify circuit open (${Math.ceil(stillOpen / 1000)}s left)`), { status: 429, circuitOpen: true });
        }
        return httpsRequest(method, urlStr, reqOpts);
      }, priority);
      if (_spotifyGap > SPOTIFY_GAP_MIN) {
        _spotifyGap = Math.max(SPOTIFY_GAP_MIN, Math.round(_spotifyGap * 0.85));
      }
      return data;
    } catch (err) {
      if (err.dropped || err.circuitOpen) throw err; // discarded / breaker open — fail fast, no retry
      const is429 = err.status === 429;
      const is5xx = err.status >= 500 && err.status < 600;
      const isTimeout = err.status === 0; // socket timeout/abort — worth one retry

      if (is429) {
        const ra = Number(err.headers?.['retry-after']);
        const raMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 + 250 : 5000;
        _spotifyGap = Math.min(SPOTIFY_GAP_MAX, Math.max(_spotifyGap * 2, 1000));

        _apiMetrics.last429 = Date.now();
        if (raMs > SPOTIFY_HARD_BAN_MS) {
          _apiMetrics.hard429++;
          // HARD BAN — open the global breaker for the FULL Retry-After. Nothing
          // touches Spotify until it lifts. Shed all queued background work and
          // fail-fast for everyone (no retry, no probing).
          _spotifyOpenUntil = Math.max(_spotifyOpenUntil, Date.now() + raMs);
          _spotifyPauseLowUntil = _spotifyPauseHighUntil = _spotifyOpenUntil;
          saveBreakerState(); // survive a restart mid-ban so we don't probe back into it
          _flushLowQueue(`hard 429 — circuit open ${Math.ceil(raMs / 1000)}s`);
          console.warn(`${_C.red}[Spotify] ✗ HARD 429 on ${label} (${priority}) — circuit OPEN for ${Math.ceil(raMs / 1000)}s; no requests until then (gap now ${_spotifyGap}ms)${_C.rst}`);
          throw err;
        }

        // SOFT limit — short and recoverable. Pause the affected tier(s) for the
        // full (short) Retry-After. Background always backs off; the interactive
        // tier only when a high request itself was refused.
        _spotifyPauseLowUntil = Math.max(_spotifyPauseLowUntil, Date.now() + raMs);
        if (priority === 'high') {
          _spotifyPauseHighUntil = Math.max(_spotifyPauseHighUntil, Date.now() + raMs);
        }
        _apiMetrics.soft429++;
        console.warn(`${_C.yel}[Spotify] ⏳ soft 429 on ${label} (${priority}) — pause ${raMs}ms (gap now ${_spotifyGap}ms)${_C.rst}`);
        // Background requests are best-effort — give up rather than retry.
        if (priority === 'low' || attempt > SPOTIFY_MAX_RETRIES) throw err;
        continue; // re-enqueue; the drainer will wait out the tier pause
      }

      if ((is5xx || isTimeout) && priority !== 'low' && attempt <= SPOTIFY_MAX_RETRIES) {
        await _sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

function _logApi(method, short, status, ms, outcome) {
  if (outcome === 'ok') {
    console.log(`${_C.grn}[Spotify] ✓ ${method} ${short} ${status} ${_C.dim}${ms}ms${_C.rst}`);
  } else if (outcome === 'skip') {
    console.log(`${_C.yel}[Spotify] ⏳ ${method} ${short} — skipped (circuit open)${_C.rst}`);
  } else {
    console.log(`${_C.red}[Spotify] ✗ ${method} ${short} ${status || 'ERR'} ${_C.dim}${ms}ms${_C.rst}`);
  }
}

async function api(method, endpoint, opts = {}) {
  const token = await getToken();

  let urlStr = SPOTIFY_API + endpoint;
  if (opts.params && Object.keys(opts.params).length > 0) {
    // Stringify all values — URLSearchParams spec requires strings; passing
    // numbers works in most environments but some Node builds behave oddly.
    const stringParams = {};
    for (const [k, v] of Object.entries(opts.params)) {
      stringParams[k] = String(v);
    }
    const qs = new URLSearchParams(stringParams).toString();
    urlStr += (urlStr.includes('?') ? '&' : '?') + qs;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}), // caller extras, e.g. If-None-Match for conditional GETs
  };

  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  // Quiet the two endpoints the poll hits every cycle on SUCCESS — they otherwise
  // bury every meaningful log (refill decisions, queue rebuilds, discovery) in
  // noise. Failures on these endpoints are ALWAYS logged so problems still surface.
  const _short = urlStr.replace(SPOTIFY_API, '');
  const _noisy = method === 'GET' && (_short === '/me/player' || _short.startsWith('/me/player/queue'));

  const _started = Date.now();
  try {
    const data = await _spotifySend(method, urlStr, { headers, body, raw: opts.raw }, _short, opts.priority || 'high');
    _apiMetrics.calls++; _apiMetrics.ok++;
    // In raw mode `data` is { status, headers, data }; surface the real status
    // (e.g. 304 = conditional cache hit) in the log instead of a blanket 200.
    const st = (opts.raw && data && typeof data.status === 'number') ? data.status : 200;
    if (!_noisy) _logApi(method, _short, st, Date.now() - _started, 'ok');
    return data;
  } catch (err) {
    if (err.dropped) throw err; // background work shed on a hard ban — already summarized
    if (err.circuitOpen) {
      if (!_noisy) _logApi(method, _short, 429, Date.now() - _started, 'skip');
    } else {
      _apiMetrics.calls++; _apiMetrics.fail++;
      _logApi(method, _short, err.status, Date.now() - _started, 'fail'); // always surface real failures
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function getAuthUrl(redirectUri) {
  const cfg = loadCfg();
  if (!cfg) throw new Error('Spotify not configured');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    show_dialog: 'true',
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const cfg = loadCfg();
  if (!cfg) throw new Error('Spotify not configured');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }).toString();

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const data = await httpsRequest(
    'POST',
    `https://${SPOTIFY_ACCOUNTS}/api/token`,
    {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  );

  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || '',
  };

  saveTokens(tokens);
  _userProfile = null; // reset cached profile
  return tokens;
}

async function refreshAccessToken() {
  const cfg = loadCfg();
  if (!cfg) throw new Error('Spotify not configured');

  const tokens = loadTokens();
  if (!tokens || !tokens.refreshToken) throw new Error('No refresh token available');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  }).toString();

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const _started = Date.now();
  let data;
  try {
    data = await httpsRequest(
      'POST',
      `https://${SPOTIFY_ACCOUNTS}/api/token`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    );
  } catch (err) {
    // A failed token refresh cascades into every request — always surface it loudly.
    _logApi('POST', '/api/token (refresh)', err.status, Date.now() - _started, 'fail');
    throw err;
  }
  _logApi('POST', '/api/token (refresh)', 200, Date.now() - _started, 'ok');

  const updated = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || tokens.scope || '', // preserve existing scope if refresh doesn't return one
  };

  saveTokens(updated);
  return updated.accessToken;
}

// Single-flight guard: when many queued requests cross the token-expiry boundary
// at once, share ONE refresh instead of firing a burst of identical POST /api/token
// calls (Spotify rate-limits the token endpoint too).
let _tokenRefreshInflight = null;

async function getToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated with Spotify');

  // Refresh if expiring within 30 seconds
  if (Date.now() >= tokens.expiresAt - 30000) {
    if (_tokenRefreshInflight) return _tokenRefreshInflight;
    _tokenRefreshInflight = refreshAccessToken().finally(() => { _tokenRefreshInflight = null; });
    return _tokenRefreshInflight;
  }

  return tokens.accessToken;
}

// ---------------------------------------------------------------------------
// Playback API wrappers
// ---------------------------------------------------------------------------

async function getPlaybackState() {
  return api('GET', '/me/player');
}

async function play(options = {}) {
  const { contextUri, uris, offsetUri, offsetPosition, positionMs, deviceId } = options;

  const body = {};
  if (contextUri) body.context_uri = contextUri;
  if (uris && uris.length > 0) body.uris = uris;

  if (offsetUri !== undefined) {
    body.offset = { uri: offsetUri };
  } else if (offsetPosition !== undefined) {
    body.offset = { position: offsetPosition };
  }

  if (positionMs !== undefined) body.position_ms = positionMs;

  const params = {};
  if (deviceId) params.device_id = deviceId;

  return api('PUT', '/me/player/play', {
    body: Object.keys(body).length > 0 ? body : undefined,
    params,
  });
}

async function pause() {
  return api('PUT', '/me/player/pause');
}

async function next() {
  return api('POST', '/me/player/next');
}

async function prev() {
  return api('POST', '/me/player/previous');
}

async function seek(positionMs) {
  return api('PUT', '/me/player/seek', { params: { position_ms: positionMs } });
}

async function setShuffle(state) {
  return api('PUT', '/me/player/shuffle', { params: { state: state ? 'true' : 'false' } });
}

async function setRepeat(state) {
  return api('PUT', '/me/player/repeat', { params: { state } });
}

async function setVolume(percent) {
  return api('PUT', '/me/player/volume', { params: { volume_percent: Math.round(percent) } });
}

async function transferPlayback(deviceId, play = true) {
  return api('PUT', '/me/player', { body: { device_ids: [deviceId], play } });
}

async function addToQueue(uri) {
  return api('POST', '/me/player/queue', { params: { uri } });
}

// Queue a track and remember it for the session so no automatic method queues the
// same song twice. Returns false if the track was unqueueable (no uri/id).
async function _queueTrack(t) {
  const uri = (t && t.uri) || (t && t.id ? `spotify:track:${t.id}` : null);
  if (!uri) return false;
  await addToQueue(uri);
  const id = (t && t.id) || (uri.startsWith('spotify:track:') ? uri.split(':').pop() : null);
  _markPlayed(id);
  return true;
}

// NOTE: the old queueOnTop() helper was removed. It faked "play next" by calling
// play({ uris: [...] }), which rebuilds the playback context and WIPES Spotify's
// queue — destroying the Smart Queue. Spotify's API has no insert-at-front or
// reorder endpoint, so manual search adds now use addToQueue() (append-only) and
// are mirrored into the in-memory window via _sqRegisterUserQueued().

// Drop any tracks already played or queued during this session.
function _excludePlayed(tracks) {
  return (tracks || []).filter(t => t && t.id && !_sessionTrackIds.has(t.id));
}

// Durable net engagement score for an artist (each hard skip −1, each engaged listen
// +1), clamped so taste can always recover. Persisted across sessions.
function _adjustArtistScore(artist, delta) {
  if (!artist) return;
  const key = artist.toLowerCase();
  const next = Math.max(ARTIST_TASTE_MIN, Math.min(ARTIST_TASTE_MAX, (_artistTaste.get(key) || 0) + delta));
  _artistTaste.set(key, next);
  _scheduleTasteSave();
}
function _artistAvoided(artist) {
  if (!artist) return false;
  // An explicit rating is a deliberate override: a rated artist is NEVER hard-avoided
  // here (even "Never" is a strong down-weight, not a block — see _artistRatingMult).
  if (_artistRating.has(artist.toLowerCase())) return false;
  return (_artistTaste.get(artist.toLowerCase()) || 0) <= ARTIST_DISLIKE_SCORE;
}
// Explicit user rating for an artist, or null if unrated. 2 Love · 1 Like · 0 Neutral
// · -1 Dislike · -2 Never. This is the source of truth that overrides the learned and
// play-count heuristics below.
function _artistRatingOf(artist) {
  if (!artist) return null;
  const r = _artistRating.get(artist.toLowerCase());
  return (typeof r === 'number') ? r : null;
}
// Selection-frequency multiplier from an explicit rating (1 = no change). Negative
// ratings strongly down-weight the artist without ever fully blocking them.
function _artistRatingMult(artist) {
  switch (_artistRatingOf(artist)) {
    case -2: return 0.18;  // Never  → strong down-weight (still appears occasionally)
    case -1: return 0.45;  // Dislike → noticeable down-weight
    default: return 1;     // Like/Love/Neutral/unrated → no penalty
  }
}
// Positive taste signal for an artist (0 = neutral/disliked) — used to bias selection.
function _artistBoost(artist) {
  if (!artist) return 0;
  const rated = _artistRatingOf(artist);
  if (rated != null) {
    // Explicit rating overrides the slow learned score entirely.
    if (rated >= 2) return ARTIST_TASTE_MAX;       // Love
    if (rated === 1) return Math.round(ARTIST_TASTE_MAX / 2); // Like
    return 0;                                      // Neutral / Dislike / Never
  }
  return Math.max(0, _artistTaste.get(artist.toLowerCase()) || 0);
}

// Favourites by play count — the SAME signal the profile page's "top artists"
// list is built from (computeProfile). The engagement-learned _artistTaste scores
// are honest but SLOW: an artist you genuinely love reads as neutral until enough
// finish/skip events accrue. Your play history already proves what you love on day
// one, so we fold it in to SUPPORT the "loved artist" / "because you love X" /
// "most-played" reasons. Cached (history grows slowly); recomputed on TTL.
const FAVORITES_TTL = 10 * 60 * 1000;
let _favoritesCache = null;
let _favoritesAt = 0;
function _favorites() {
  if (_favoritesCache && Date.now() - _favoritesAt < FAVORITES_TTL) return _favoritesCache;
  const artistCount = new Map();
  const trackCount = new Map();
  for (const e of combinedHistory()) {
    if (e.artist) { const k = e.artist.toLowerCase(); artistCount.set(k, (artistCount.get(k) || 0) + 1); }
    if (e.id) trackCount.set(e.id, (trackCount.get(e.id) || 0) + 1);
  }
  // "Favoured" = plays clear a floor AND rank in the upper band of your catalogue,
  // so a couple of plays in a thin history doesn't crown everyone. The floor is the
  // larger of an absolute minimum and the play count at the ~15th-ranked artist.
  const counts = [...artistCount.values()].sort((a, b) => b - a);
  const rankFloor = counts.length ? counts[Math.min(counts.length - 1, 14)] : 0;
  const artistFloor = Math.max(3, rankFloor);
  const lovedArtists = new Set();
  for (const [k, c] of artistCount) if (c >= artistFloor) lovedArtists.add(k);
  // Top tracks: songs you clearly return to (repeat-played) — your "most played".
  const topTracks = new Set();
  for (const [id, c] of trackCount) if (c >= 3) topTracks.add(id);
  _favoritesCache = { lovedArtists, topTracks };
  _favoritesAt = Date.now();
  return _favoritesCache;
}
// True when an artist is loved — either by learned engagement OR by being one of
// your most-played artists (the profile's top-artists signal).
function _isLovedArtist(artist) {
  if (!artist) return false;
  const k = artist.toLowerCase();
  // Explicit rating wins over BOTH the learned score and the play-count heuristic —
  // this is exactly the over-played-but-not-loved case the rating UI exists to fix.
  const rated = _artistRating.get(k);
  if (typeof rated === 'number') return rated >= 1; // Like/Love only
  if ((_artistTaste.get(k) || 0) > 0) return true;
  return _favorites().lovedArtists.has(k);
}
// True when a track is one of the user's most repeat-played songs.
function _isTopTrack(id) {
  return !!id && _favorites().topTracks.has(id);
}

// Recently-played artists with play counts, last-played time, a cover sample and the
// current explicit rating — feeds the profile panel's "rate your artists" tab. Built
// entirely from in-memory history (no Spotify calls). Sorted by play count desc.
function _artistRatingList(limit = 60) {
  const info = new Map(); // key → { name, count, lastTs, art }
  for (const e of combinedHistory()) {
    const name = e.artist;
    if (!name) continue;
    const key = name.toLowerCase();
    let rec = info.get(key);
    if (!rec) { rec = { name, count: 0, lastTs: 0, art: null }; info.set(key, rec); }
    rec.count++;
    const ts = e.ts || 0;
    if (ts >= rec.lastTs) { rec.lastTs = ts; if (e.art) rec.art = e.art; }
    if (!rec.art && e.art) rec.art = e.art;
  }
  // Include any rated artist even if it's aged out of history, so ratings stay editable.
  for (const [key, rating] of _artistRating) {
    if (!info.has(key)) info.set(key, { name: key, count: 0, lastTs: 0, art: null });
  }
  const out = [...info.entries()].map(([key, rec]) => ({
    artist: rec.name,
    key,
    count: rec.count,
    lastTs: rec.lastTs || null,
    art: rec.art || null,
    rating: _artistRating.has(key) ? _artistRating.get(key) : null,
    loved: _isLovedArtist(rec.name),
  }));
  // Rated artists first (so you can find/edit them), then by play count.
  out.sort((a, b) =>
    (b.rating != null) - (a.rating != null) ||
    b.count - a.count ||
    (b.lastTs || 0) - (a.lastTs || 0));
  return out.slice(0, limit);
}

// Apply an explicit rating (or clear it with null). Validates the level, persists,
// and invalidates the favourites cache so the loved-artist heuristic re-resolves.
function _setArtistRating(artist, rating) {
  if (!artist) return false;
  const key = artist.toLowerCase();
  if (rating == null) {
    _artistRating.delete(key);
  } else {
    const r = Math.round(Number(rating));
    if (!(r >= -2 && r <= 2)) return false;
    _artistRating.set(key, r);
  }
  _favoritesCache = null; // loved-artist set depends on ratings now
  _scheduleTasteSave();
  return true;
}

// Per-artist "sound" centroid (energy/valence/bpm) learned from real listening
// history, cached briefly since history grows slowly. This is the backbone of the
// "because you love X" anchoring (#1): it lets us measure how close a fresh pick
// sits to an artist you already love.
const ARTIST_CENTROID_TTL = 10 * 60 * 1000;
let _artistCentroidCache = null;
let _artistCentroidAt = 0;
function _artistCentroids() {
  if (_artistCentroidCache && Date.now() - _artistCentroidAt < ARTIST_CENTROID_TTL) return _artistCentroidCache;
  const groups = new Map();
  for (const e of _history) {
    if (!e.artist || e.energy == null) continue;
    const k = e.artist.toLowerCase();
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); }
    g.push(e);
  }
  const out = new Map();
  for (const [k, entries] of groups) {
    if (entries.length < 3) continue;           // need a few plays for a stable sound
    const c = _computeCentroid(entries);
    if (c) out.set(k, { centroid: c, name: entries[entries.length - 1].artist, count: entries.length });
  }
  _artistCentroidCache = out;
  _artistCentroidAt = Date.now();
  return out;
}
function _artistCentroid(artist) {
  if (!artist) return null;
  return _artistCentroids().get(artist.toLowerCase()) || null;
}
// "Because you love X" (#1): for a pick whose OWN artist isn't loved yet, find the
// loved artist whose representative sound sits closest to this track — that's the
// honest reason it earned a slot. Returns the loved artist's display name when the
// match is tight enough to feel meaningful, else null.
function _anchorLovedArtist(track) {
  if (!track || track.energy == null || track.valence == null) return null;
  if (_artistBoost(track.artist) > 0) return null;       // own artist already loved
  const self = (track.artist || '').toLowerCase();
  let best = null, bestD = 0.33;                          // must be reasonably close
  for (const [k, info] of _artistCentroids()) {
    if (k === self || !_isLovedArtist(k)) continue; // loved artists only (learned or most-played)
    const d = _clusterDist(info.centroid, track);
    if (d < bestD) { bestD = d; best = info.name; }
  }
  return best;
}

// Durable per-track dislike count. A hard skip bumps it; a full listen decays it.
function _bumpTrackDislike(id) {
  if (!id) return;
  _trackDislikes.set(id, (_trackDislikes.get(id) || 0) + 1);
  _skipSlot.set(id, _currentSlotKey()); // remember WHEN it didn't land (for "rescued")
  _scheduleTasteSave();
}
function _recoverTrackDislike(id) {
  if (!id || !_trackDislikes.has(id)) return;
  const n = (_trackDislikes.get(id) || 0) - 1;
  if (n <= 0) { _trackDislikes.delete(id); _skipSlot.delete(id); } else _trackDislikes.set(id, n);
  _scheduleTasteSave();
}
// A track is "rescued" when it was skipped before, in a DIFFERENT time-slot than
// now, yet survives the soft-ban (so the engine still trusts it) — i.e. it didn't
// fit then but fits this context. Used to surface a "rescued" pick reason.
function _isRescued(id) {
  if (!id || _trackSoftBanned(id)) return false;
  const prevSlot = _skipSlot.get(id);
  return !!prevSlot && prevSlot !== _currentSlotKey();
}
function _trackSoftBanned(id) {
  return !!id && (_trackDislikes.get(id) || 0) >= TRACK_SOFTBAN_COUNT;
}

// Drop tracks the user has repeatedly skipped, plus any artist whose durable score
// has fallen to a strong-dislike pattern (engaged listens since then recover it).
function _excludeDisliked(tracks) {
  if (!_trackDislikes.size && !_artistTaste.size) return tracks || [];
  return (tracks || []).filter(t =>
    t && !_trackSoftBanned(t.id) && !_artistAvoided(t.artist));
}

// Stable re-rank that drifts tracks by durably-boosted artists toward the front, so
// they're favoured when a candidate pool is truncated — without hard-overriding the
// existing order (equal-boost tracks keep their relative position).
function _applyTasteBias(tracks) {
  if (!_artistTaste.size || !tracks || tracks.length < 2) return tracks || [];
  return tracks
    .map((t, i) => ({ t, i, b: _artistBoost(t.artist) }))
    .sort((a, b) => (b.b - a.b) || (a.i - b.i))
    .map(x => x.t);
}

// Judge how the user felt about the track that just ended, from how much of it
// they heard. `prev` is the previous poll's serialized state (the outgoing track).
//   • finished / ≥80%      → engaged → +1 artist score, forgive past skips
//   • <15%                 → strong dislike → avoid THIS song, −1 artist score
//                            (artist only avoided once net hits a strong pattern)
//   • 15–50%               → didn't fit the vibe → neutral (no like, no penalty)
//   • 50–80%               → heard most of it → mild like
// Record how a song→song transition fared. delta > 0 = the landing track earned
// an engaged listen (the transition "survived"); delta < 0 = it got skipped.
function _recordTransition(fromId, toId, delta) {
  if (!fromId || !toId || fromId === toId) return;
  const key = TRANSITION_KEY(fromId, toId);
  const next = Math.max(-TRANSITION_CLAMP, Math.min(TRANSITION_CLAMP, (_transitions.get(key) || 0) + delta));
  if (next === 0) _transitions.delete(key);
  else _transitions.set(key, next);
  _scheduleTasteSave();
}

// Learned bias for placing track b right after track a: maps the clamped net
// score into roughly [-1, 1] so it can shift a flow score by ±TRANSITION_WEIGHT.
function _transitionBias(a, b) {
  if (!a || !b || !a.id || !b.id) return 0;
  const v = _transitions.get(TRANSITION_KEY(a.id, b.id));
  if (!v) return 0;
  return v / TRANSITION_CLAMP;
}

// Bonded pairs (#4): true when a→b is a durably-reinforced sequence — the learned
// transition score has climbed to most of the clamp from repeated engaged listens
// in this order. Threshold is high so we only ever surface a genuine habit.
const BOND_MIN = Math.max(2, Math.ceil(TRANSITION_CLAMP * 0.6));
function _bondStrong(a, b) {
  if (!a || !b || !a.id || !b.id || a.id === b.id) return false;
  return (_transitions.get(TRANSITION_KEY(a.id, b.id)) || 0) >= BOND_MIN;
}

// Explore vs. exploit momentum (#3): a short rolling log of recent engagement
// outcomes (+1 engaged listen, −1 strong skip). When you're consistently finishing
// tracks you're "locked in" → exploit (lean familiar, less jitter); when you're
// skipping you're "restless" → explore (inject more variety into the library pool).
const ENGAGE_LOG_MAX = 8;
let _engageLog = [];
function _recordEngagement(outcome) {
  _engageLog.push(outcome);
  if (_engageLog.length > ENGAGE_LOG_MAX) _engageLog.shift();
}
function _engagementMomentum() {
  const recent = _engageLog.slice(-6);
  if (recent.length < 4) return { mode: 'neutral', score: 0, n: recent.length };
  const score = recent.reduce((s, v) => s + v, 0);
  const mode = score >= 2 ? 'locked' : score <= -2 ? 'restless' : 'neutral';
  return { mode, score, n: recent.length };
}

// Most-recent play timestamp per track id, from real listening history. Backs the
// re-discovery feature (#2): how long it's been since you last heard a track.
function _lastPlayedById() {
  const m = new Map();
  for (const e of _history) {
    if (!e.id || e.ts == null) continue;
    const prev = m.get(e.id);
    if (prev == null || e.ts > prev) m.set(e.id, e.ts);
  }
  return m;
}

function _evaluateEngagement(prev) {
  if (!prev || !prev.track || !prev.track.id || !prev.isPlaying) return;
  const dur = prev.track.duration;
  const pos = prev.progress;
  if (!dur || dur <= 0 || pos == null) return;

  const frac     = pos / dur;
  const finished = frac >= FINISH_FRAC || (dur - pos) <= PROGRESS_DELTA_MAX;

  // The previous-to-this transition survived/failed based on how this track fared.
  const _prevId = _transitionPrevId;
  _transitionPrevId = prev.track.id;

  if (finished || frac >= _tSkipSoft()) {
    _adjustArtistScore(prev.track.artist, +1);   // engaged listen recovers the artist
    _recoverTrackDislike(prev.track.id);          // a full listen forgives a past skip
    _recordTransition(_prevId, prev.track.id, +1); // this sequencing worked — reinforce it
    _nudgeSlotBias(prev.track, +1);               // fit this slot → relax the slot's skip-nudge
    _recordEngagement(+1);                        // #3 momentum: you're locked in
    return;
  }
  if (frac < _tSkipStrong()) {
    _bumpTrackDislike(prev.track.id);            // repeated skips → durable soft-ban
    _adjustArtistScore(prev.track.artist, -1);
    _recordTransition(_prevId, prev.track.id, -1); // landing here got skipped — avoid the sequence
    _nudgeSlotBias(prev.track, -1);               // didn't fit THIS time-of-day → push the slot away
    _recordEngagement(-1);                        // #3 momentum: you're restless
    const banned  = _trackSoftBanned(prev.track.id);
    const avoided = _artistAvoided(prev.track.artist);
    console.log(`[Spotify] Engagement: strong dislike (${Math.round(frac * 100)}%) "${prev.track.title}"${banned ? ' — now soft-banned' : ''}${avoided ? ` — pattern detected, now avoiding ${prev.track.artist}` : ''}`);
    return;
  }
  // Between the two thresholds: just didn't fit the current vibe — note it, but don't penalize.
  console.log(`[Spotify] Engagement: vibe mismatch (${Math.round(frac * 100)}%) "${prev.track.title}"`);
}

// ---------------------------------------------------------------------------
// Library API wrappers
// ---------------------------------------------------------------------------

async function getPlaylists(limit = 50) {
  return api('GET', '/me/playlists', { params: { limit } });
}

// Conditional GET: send If-None-Match when we hold an ETag for this resource.
// Returns { status, etag, data }. On a 304 the body is null and the caller serves
// its own cache — saving the entire (often multi-page) re-download. Fully
// defensive: if Spotify doesn't return an ETag (etag stays null), the next call
// sends no If-None-Match and behaves exactly like an unconditional fetch, so this
// can only ever SAVE calls, never break anything.
async function _conditionalGet(endpoint, params, etag, priority = 'high') {
  const res = await api('GET', endpoint, {
    params,
    priority,
    raw: true,
    headers: etag ? { 'If-None-Match': etag } : undefined,
  });
  return {
    status: res?.status,
    etag: res?.headers?.etag || etag || null, // Node lowercases header names
    data: res?.data ?? null,
  };
}

// Local-first: the full playlist list is paginated (many calls), so cache it and
// serve from memory unless the TTL lapsed or the caller explicitly asks to refresh.
// An in-flight guard coalesces concurrent requests into one fetch. We also keep an
// ETag so a periodic refresh can be answered with a cheap 304 when nothing changed.
let _playlistsCache = { items: null, ts: 0, etag: null };
let _playlistsInflight = null;
const PLAYLISTS_TTL = 30 * 60 * 1000; // 30 min

async function getAllPlaylists(forceRefresh = false) {
  if (!forceRefresh && _playlistsCache.items && Date.now() - _playlistsCache.ts < PLAYLISTS_TTL) {
    return { items: _playlistsCache.items, cached: true };
  }
  if (_playlistsInflight) return _playlistsInflight;
  _playlistsInflight = (async () => {
    try {
      const limit = 50;
      // Conditional first page: an unchanged first page (most-recently-touched
      // playlists sit at the front) is a strong signal the list is unchanged.
      const cond = await _conditionalGet('/me/playlists', { limit, offset: 0 }, _playlistsCache.etag);
      if (cond.status === 304 && _playlistsCache.items) {
        _playlistsCache.ts = Date.now(); // unchanged — keep cache fresh, skip all pages
        console.log(`${_C.grn}[Spotify] ✓ playlists unchanged (304) — served ${_playlistsCache.items.length} from cache${_C.rst}`);
        return { items: _playlistsCache.items, cached: true };
      }
      const first = cond.data;
      if (!first) return { items: _playlistsCache.items || [] };
      const total = first.total || 0;
      let allItems = [].concat(first.items || []);
      while (allItems.length < total) {
        const page = await api('GET', '/me/playlists', { params: { limit, offset: allItems.length } });
        if (!page || !page.items || !page.items.length) break;
        allItems = allItems.concat(page.items);
      }
      _playlistsCache = { items: allItems, ts: Date.now(), etag: cond.etag };
      return { items: allItems };
    } finally {
      _playlistsInflight = null;
    }
  })();
  return _playlistsInflight;
}

// Mar-2026 migration: GET /playlists/{id}/tracks was REMOVED (403 for Dev-Mode
// apps). The live endpoint is GET /playlists/{id}/items and the per-entry field
// renamed track → item, so the fields filter uses item(...) and consumers read
// entry.item. Note: this endpoint only works for playlists the user OWNS or
// collaborates on — Spotify-owned/editorial playlists (Discover Weekly, Daily
// Mix, etc.) are no longer track-readable via the API and will 403/404.
async function getPlaylistTracks(playlistId, limit = 100) {
  return api('GET', `/playlists/${playlistId}/items`, {
    params: {
      limit,
      fields: 'items(item(id,uri,name,duration_ms,artists(id,name),album(name,images)))',
    },
  });
}

async function getAllPlaylistTracks(playlistId) {
  const limit = 100;
  const fields = 'total,items(item(id,uri,name,duration_ms,artists(id,name),album(name,images)))';
  const first = await api('GET', `/playlists/${playlistId}/items`, {
    params: { limit, offset: 0, fields },
  });
  if (!first) return [];
  const total = first.total || 0;
  let allItems = first.items || [];
  while (allItems.length < total) {
    const page = await api('GET', `/playlists/${playlistId}/items`, {
      params: { limit, offset: allItems.length, fields },
    });
    if (!page || !page.items || !page.items.length) break;
    allItems = allItems.concat(page.items);
  }
  return allItems;
}

// Local-first: liked songs paginate too (often hundreds of tracks = many calls),
// so cache and serve from memory unless the TTL lapsed or the caller forces a
// refresh. In-flight guard coalesces concurrent requests.
let _likedSongsCache = { items: null, ts: 0, etag: null };
let _likedSongsInflight = null;
const LIKED_SONGS_TTL = 30 * 60 * 1000; // 30 min

async function getAllLikedSongs(priority = 'high', forceRefresh = false) {
  if (!forceRefresh && _likedSongsCache.items && Date.now() - _likedSongsCache.ts < LIKED_SONGS_TTL) {
    return _likedSongsCache.items;
  }
  if (_likedSongsInflight) return _likedSongsInflight;
  _likedSongsInflight = (async () => {
    try {
      const limit = 50;
      // Conditional first page: new likes land at the FRONT (sorted by added_at
      // desc), so an unchanged first page means no new likes → serve the cache and
      // skip every other page.
      const cond = await _conditionalGet('/me/tracks', { limit, offset: 0 }, _likedSongsCache.etag, priority);
      if (cond.status === 304 && _likedSongsCache.items) {
        _likedSongsCache.ts = Date.now(); // unchanged — keep cache fresh
        console.log(`${_C.grn}[Spotify] ✓ liked songs unchanged (304) — served ${_likedSongsCache.items.length} from cache${_C.rst}`);
        return _likedSongsCache.items;
      }
      const first = cond.data;
      if (!first) return _likedSongsCache.items || [];
      const total = first.total || 0;
      let allItems = [].concat(first.items || []);
      while (allItems.length < total) {
        const page = await getLikedSongTracks(limit, allItems.length, priority);
        if (!page || !page.items || !page.items.length) break;
        allItems = allItems.concat(page.items);
      }
      _likedSongsCache = { items: allItems, ts: Date.now(), etag: cond.etag };
      return allItems;
    } finally {
      _likedSongsInflight = null;
    }
  })();
  return _likedSongsInflight;
}

// In-memory cache so we don't re-fetch features for the same track
const _audioFeaturesCache = new Map();
// Maps a Spotify track ID → ReccoBeats internal UUID (null = looked up, genuinely not found)
const _reccoIdCache = new Map();
// Tracks that returned no features anywhere → trackId: timestamp. TTL-bounded so we
// stop re-hitting Spotify (403) and spamming the log on every replay, while still
// retrying occasionally in case a transient failure was the cause.
const _audioFeaturesNegCache = new Map();
const AUDIO_FEATURES_NEG_TTL = 6 * 60 * 60 * 1000; // 6 hours
function _negCached(trackId) {
  const t = _audioFeaturesNegCache.get(trackId);
  if (t == null) return false;
  if (Date.now() - t > AUDIO_FEATURES_NEG_TTL) { _audioFeaturesNegCache.delete(trackId); return false; }
  return true;
}

// ── Persistent audio-features database ──────────────────────────────────────
// _audioFeaturesCache doubles as the in-memory DB; it's loaded from disk at
// startup and written through on every genuine fetch. This means features
// survive a restart, so we don't replay the heavily-throttled ReccoBeats
// lookups after every `pm2 restart`. Keyed by Spotify track ID → raw feature
// object (same shape getAudioFeatures returns: { tempo, energy 0-1, valence, … }).
let _featuresDBSaveTimer = null;
let _featuresDBDirty = false;

function loadFeaturesDB() {
  try {
    if (!fs.existsSync(TRACK_FEATURES_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(TRACK_FEATURES_FILE, 'utf8'));
    let n = 0;
    for (const [id, feat] of Object.entries(obj || {})) {
      if (feat && typeof feat === 'object') { _audioFeaturesCache.set(id, feat); n++; }
    }
    console.log(`[Spotify] Loaded ${n} cached track features from disk`);
  } catch (err) {
    console.error('[Spotify] loadFeaturesDB error:', err.message);
  }
}

function saveFeaturesDB() {
  _featuresDBDirty = false;
  try {
    fs.mkdirSync(path.dirname(TRACK_FEATURES_FILE), { recursive: true });
    const obj = {};
    for (const [id, feat] of _audioFeaturesCache) obj[id] = feat;
    fs.writeFileSync(TRACK_FEATURES_FILE, JSON.stringify(obj));
  } catch (err) {
    console.error('[Spotify] saveFeaturesDB error:', err.message);
  }
}

// Write a genuine feature object into the cache and schedule a debounced save.
// Debounced so a burst of new tracks (e.g. batch enrichment) collapses into one
// disk write instead of one per track.
function _cacheFeatures(trackId, feat) {
  if (!trackId || !feat) return;
  _audioFeaturesCache.set(trackId, feat);
  _featuresDBDirty = true;
  if (_featuresDBSaveTimer) return;
  _featuresDBSaveTimer = setTimeout(() => {
    _featuresDBSaveTimer = null;
    if (_featuresDBDirty) saveFeaturesDB();
  }, 3000);
}

// ReccoBeats throttle: all requests are serialized through one promise chain with a
// minimum gap that widens automatically on 429 and relaxes on success. Prevents the
// request storms that were triggering HTTP 429 during seeding.
let _reccoChain = Promise.resolve();
let _reccoGap = 350;
const RECCO_GAP_MIN = 350;
const RECCO_GAP_MAX = 4000;

function _reccoThrottle(fn) {
  const run = _reccoChain.then(async () => {
    await new Promise(r => setTimeout(r, _reccoGap));
    return fn();
  });
  _reccoChain = run.then(() => {}, () => {}); // keep the chain alive on success or failure
  return run;
}

// Serialized + backed-off GET against ReccoBeats. Throws on final failure so callers
// can distinguish a transient error (don't cache) from a genuine not-found (cache).
async function _reccoGet(url) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await _reccoThrottle(() =>
        httpsRequest('GET', url, { headers: { Accept: 'application/json' } })
      );
      if (_reccoGap > RECCO_GAP_MIN) _reccoGap = Math.max(RECCO_GAP_MIN, _reccoGap - 150);
      return data;
    } catch (err) {
      const transient = err.status === 429 || (err.status >= 500 && err.status < 600);
      if (transient && attempt < maxAttempts) {
        _reccoGap = Math.min(RECCO_GAP_MAX, _reccoGap + 500);
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

// Resolve a Spotify track ID to its ReccoBeats UUID via the batch lookup endpoint.
async function _reccoLookupId(trackId) {
  if (_reccoIdCache.has(trackId)) return _reccoIdCache.get(trackId);
  const data = await _reccoGet(`${RECCOBEATS_API}/track?ids=${trackId}`); // may throw (transient)
  const uuid = data && Array.isArray(data.content) && data.content[0] ? data.content[0].id : null;
  _reccoIdCache.set(trackId, uuid || null); // only reached on a successful 200 → genuine result
  return uuid || null;
}

// Fetch audio features from ReccoBeats and normalise to Spotify's field shape.
// Returns null on genuine not-found OR transient failure; transient failures are not
// cached, so the next track change retries them.
async function getReccoBeatsFeatures(trackId) {
  try {
    const uuid = await _reccoLookupId(trackId);
    if (!uuid) return null;
    const f = await _reccoGet(`${RECCOBEATS_API}/track/${uuid}/audio-features`);
    if (!f || f.tempo == null) return null;
    return {
      id: trackId,
      tempo: f.tempo,
      energy: f.energy,
      valence: f.valence,
      danceability: f.danceability,
      acousticness: f.acousticness,
      instrumentalness: f.instrumentalness,
      key: f.key,
      mode: f.mode,
      _source: 'reccobeats',
    };
  } catch (err) {
    console.warn(`${_C.red}[ReccoBeats] ✗ features unavailable for ${trackId} — ${err.message}${_C.rst}`);
    return null;
  }
}

// In-flight requests, keyed by trackId. Guarantees the fetch happens exactly once
// per track even when several callers (history path, first-load path, recommendation
// logic) ask for the same new song in the same tick — they all await the same promise,
// so the result is fetched AND cached before anyone reads it. Without this, concurrent
// callers each ran the full Spotify→ReccoBeats chain, raced on the throttle, and could
// act on data that hadn't been saved yet (the bug that only showed up on new songs).
const _audioFeaturesInflight = new Map();

async function getAudioFeatures(trackId) {
  if (!trackId) return null;
  if (_audioFeaturesCache.has(trackId)) return _audioFeaturesCache.get(trackId);
  // Recently failed everywhere — skip the wasted 403 + log spam until the TTL lapses.
  if (_negCached(trackId)) return null;
  // Already being fetched — share the one in-flight request instead of starting another.
  if (_audioFeaturesInflight.has(trackId)) return _audioFeaturesInflight.get(trackId);

  const fetchPromise = (async () => {
    // Spotify's /audio-features is permanently deprecated (Nov-2024) — it only ever
    // returns 403/404 now and every attempt burns rate-limit quota. Go straight to
    // ReccoBeats, never the Spotify host.
    const recco = await getReccoBeatsFeatures(trackId);
    if (recco) {
      console.log(`[Spotify] Audio features via ReccoBeats — energy=${recco.energy} valence=${recco.valence} tempo=${Math.round(recco.tempo)} id=${trackId}`);
      _cacheFeatures(trackId, recco);
      return recco;
    }
    console.warn('[Spotify] Audio features unavailable (Spotify + ReccoBeats) for', trackId);
    _audioFeaturesNegCache.set(trackId, Date.now());
    return null;
  })();

  _audioFeaturesInflight.set(trackId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    _audioFeaturesInflight.delete(trackId);
  }
}

async function getBatchAudioFeatures(trackIds, priority = 'high') {
  if (!trackIds || !trackIds.length) return [];
  const toFetch = trackIds.filter(id => !_audioFeaturesCache.has(id));
  if (toFetch.length) {
    // Spotify's batch /audio-features is permanently deprecated — never call the
    // Spotify host. Enrich via ReccoBeats only.
    // Sequential + capped so one-time seeding doesn't fire a request storm.
    // Skip tracks already known to have no features (TTL-bounded).
    const stillMissing = toFetch
      .filter(id => !_audioFeaturesCache.has(id) && !_negCached(id))
      .slice(0, 30);
    if (stillMissing.length) {
      let got = 0;
      for (const id of stillMissing) {
        const recco = await getReccoBeatsFeatures(id);
        if (recco) { _cacheFeatures(id, recco); got++; }
        else _audioFeaturesNegCache.set(id, Date.now());
      }
      console.log(`[Spotify] Batch features via ReccoBeats: ${got}/${stillMissing.length} enriched`);
    }
  }
  return trackIds.map(id => _audioFeaturesCache.get(id) || null);
}

// ⚠️ ENDPOINT-CHOICE NOTES (read this if liked songs / playlists ever break) ⚠️
// ───────────────────────────────────────────────────────────────────────────
// Spotify's Feb/Mar-2026 "Development Mode" API migration. CONFIRMED live (the
// Pi started returning red ✗ 403s on the old reads, exactly as this note warned):
//   • Liked songs READ → GET /me/tracks (max 50). NOT migrated — there is no
//     /me/library read endpoint, /me/tracks is still the live one.
//   • Playlist tracks READ → GET /playlists/{id}/ITEMS (was /tracks, now 403).
//     Per-entry field renamed track → item: fields use item(...), consumers read
//     entry.item (with `|| entry.track` fallback). ONLY works for playlists the
//     user owns/collaborates on — editorial/Spotify-owned playlists 403/404 now.
//   • Several tracks READ → GET /tracks/{id} per id. The batch GET /tracks?ids=
//     was REMOVED (403). resolveTrackIds is local-first + capped to avoid storms.
//   • WRITES → generic endpoints: PUT/DELETE /me/library, GET /me/library/contains.
//
// The centralized red logging in api() is the safety net: if any of these starts
// returning 403/404 again, you'll see a red ✗ line INSTANTLY. Check the live
// migration guide + each endpoint's reference page before changing paths.
// ───────────────────────────────────────────────────────────────────────────
async function getLikedSongTracks(limit = 50, offset = 0, priority = 'high') {
  // Reading saved tracks was NOT migrated — there is no /me/library read
  // endpoint. /me/tracks is the live, documented endpoint (max limit 50).
  return api('GET', '/me/tracks', { params: { limit: Math.min(limit, 50), offset }, priority });
}

async function getDevices() {
  return api('GET', '/me/player/devices');
}

async function search(query, types = 'track', limit = 10, offset = 0) {
  // Feb 2026: search limit reduced from max 50 to max 10
  const safeLimit = Math.min(limit, 10);
  const params = { q: query, type: types, limit: String(safeLimit) };
  if (offset > 0) params.offset = String(Math.min(offset, 950)); // Spotify caps offset at ~1000
  return api('GET', '/search', { params });
}

async function getQueue() {
  return api('GET', '/me/player/queue');
}

async function checkLiked(trackUris) {
  // Feb 2026: GET /me/tracks/contains → GET /me/library/contains
  // Now takes Spotify URIs (spotify:track:...) not bare IDs
  if (!trackUris || trackUris.length === 0) return [];
  return api('GET', '/me/library/contains', { params: { uris: trackUris.join(',') } });
}

async function likeTrack(trackUri) {
  // Feb 2026: PUT /me/tracks {ids:[...]} → PUT /me/library?uris=spotify:track:...
  const r = await api('PUT', '/me/library', { params: { uris: trackUri } });
  _likedSongsCache = { items: null, ts: 0 }; // liked set changed — drop the cache
  return r;
}

async function unlikeTrack(trackUri) {
  // Feb 2026: DELETE /me/tracks {ids:[...]} → DELETE /me/library?uris=spotify:track:...
  const r = await api('DELETE', '/me/library', { params: { uris: trackUri } });
  _likedSongsCache = { items: null, ts: 0 }; // liked set changed — drop the cache
  return r;
}

async function addTracksToPlaylist(playlistId, uris) {
  return api('POST', `/playlists/${playlistId}/tracks`, { body: { uris } });
}

async function createPlaylist(userId, name, description = '') {
  const r = await api('POST', `/users/${userId}/playlists`, {
    body: { name, description, public: false },
  });
  _playlistsCache = { items: null, ts: 0 }; // playlist set changed — drop the cache
  return r;
}

/**
 * Get tracks similar to the given seeds.
 *
 * Spotify's /recommendations and /artists/{id}/related-artists were both killed in
 * the Nov-2024 deprecation batch (they only 404 now and burn rate-limit quota), so
 * we never call them. Genuine discovery happens via /search-based helpers elsewhere;
 * this function's job is the cheap fallback: the user's own short-term top tracks.
 *
 * Returns an array of raw Spotify track objects (with .uri, .id, .name, .artists …).
 */
async function getSimilarTracks(seedTrackIds = [], seedArtistIds = [], limit = 5) {
  const dedupe = (tracks, excludeUris = new Set()) => {
    const seen = new Set(excludeUris);
    return tracks.filter(t => {
      if (!t?.uri || seen.has(t.uri)) return false;
      seen.add(t.uri);
      return true;
    });
  };

  const excludeUris = new Set(seedTrackIds.map(id => `spotify:track:${id}`));

  // User's own short-term top tracks (the only live source here).
  try {
    const top = await api('GET', '/me/top/tracks', { params: { time_range: 'short_term', limit: 50 } });
    const tracks = dedupe(top?.items || [], excludeUris).sort(() => Math.random() - 0.5);
    if (tracks.length > 0) {
      console.log(`[Spotify] getSimilarTracks: ${tracks.length} from user top-tracks fallback`);
      return tracks.slice(0, limit);
    }
  } catch (err) {
    console.warn('[Spotify] Top-tracks fallback failed:', err.message);
  }

  console.warn('[Spotify] getSimilarTracks: all tiers exhausted, returning empty');
  return [];
}

// ── Genuine discovery (new music, not the user's own catalogue) ───────────────
// /recommendations and /related-artists are dead, so getSimilarTracks falls back to
// the user's OWN top tracks — familiar, not new. These helpers use /search (still
// live) to surface songs the user hasn't played: deeper cuts from artists they like
// plus fresh tracks in their favourite genres.

// ── Genre buckets ─────────────────────────────────────────────────────────────
// Spotify tags genres on ARTISTS, hyper-granularly ("dance pop", "pop rap", …).
// We roll those micro-genres up into a handful of broad, predictable buckets for
// the Genres tab. `match` keywords are tested as substrings of an artist's raw
// genres (an artist/track can land in several buckets — that's fine, and lenient
// is good for thin genres). `seeds` are Spotify genre-search terms used to source
// fresh in-genre discovery. Order = display priority.
const GENRE_BUCKETS = [
  { key: 'hiphop',     name: 'Hip-Hop',     match: ['hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'grime'],                              seeds: ['hip-hop', 'rap'] },
  { key: 'pop',        name: 'Pop',         match: ['pop'],                                                                              seeds: ['pop'] },
  { key: 'rock',       name: 'Rock',        match: ['rock', 'punk', 'grunge', 'britpop'],                                                seeds: ['rock'] },
  { key: 'electronic', name: 'Electronic',  match: ['edm', 'electro', 'house', 'techno', 'dubstep', 'trance', 'dnb', 'drum and bass', 'dance', 'garage', 'bass music'], seeds: ['edm', 'dance'] },
  { key: 'rnb',        name: 'R&B / Soul',  match: ['r&b', 'rnb', 'soul', 'funk', 'motown'],                                             seeds: ['r-n-b', 'soul'] },
  { key: 'metal',      name: 'Metal',       match: ['metal', 'metalcore', 'hardcore', 'djent'],                                          seeds: ['metal'] },
  { key: 'indie',      name: 'Indie / Alt', match: ['indie', 'alternative', 'alt z', 'shoegaze', 'emo'],                                 seeds: ['indie', 'alt-rock'] },
  { key: 'country',    name: 'Country',     match: ['country', 'americana', 'bluegrass', 'folk'],                                        seeds: ['country'] },
  { key: 'jazz',       name: 'Jazz',        match: ['jazz', 'bebop', 'swing', 'bossa'],                                                  seeds: ['jazz'] },
  { key: 'classical',  name: 'Classical',   match: ['classical', 'orchestra', 'baroque', 'romantic era', 'opera'],                      seeds: ['classical'] },
];
const GENRE_BUCKET_BY_KEY = Object.fromEntries(GENRE_BUCKETS.map(b => [b.key, b]));

// Roll a list of raw Spotify genre strings up into our macro-bucket keys (a Set).
function _macroGenresOf(rawGenres) {
  const out = new Set();
  for (const raw of rawGenres || []) {
    const g = String(raw).toLowerCase();
    for (const b of GENRE_BUCKETS) if (b.match.some(m => g.includes(m))) out.add(b.key);
  }
  return out;
}

// A track's macro-genres = union over its artists' cached genres. Returns null
// when we have NO genre data for any of the track's artists (not yet backfilled),
// so callers can distinguish "unknown" from "known, matches nothing".
function _trackMacroGenres(track) {
  const out = new Set();
  let known = false;
  for (const id of (track && track.artistIds) || []) {
    const raw = _artistGenres.get(id);
    if (raw) { known = true; for (const k of _macroGenresOf(raw)) out.add(k); }
  }
  return known ? out : null;
}

// Does a track belong to the given macro-genre bucket? 'any'/empty = no filter.
function _trackMatchesGenre(track, bucketKey) {
  if (!bucketKey || bucketKey === 'any') return true;
  const macros = _trackMacroGenres(track);
  return macros ? macros.has(bucketKey) : false;
}

// Merge genres from any artist objects we happen to fetch (top artists, /artists
// backfill, …). Persists, since this is durable data.
function _recordArtistGenres(artists) {
  let added = 0;
  for (const a of artists || []) {
    if (a && a.id && Array.isArray(a.genres) && !_artistGenres.has(a.id)) {
      _artistGenres.set(a.id, a.genres);
      added++;
    }
  }
  if (added) _scheduleTasteSave();
  return added;
}

// Lazily backfill artist genres for everything in the library/history. Spotify
// returns 50 artists/call; genres never change so we cache permanently. Runs a few
// batches per pass behind the live-API cooldown + rate-limit guards, then reschedules
// itself until every known artist is covered — local-first, ban-recovery-friendly.
const GENRE_BACKFILL_BATCHES_PER_PASS = 2;   // ≤100 artists/pass
const GENRE_BACKFILL_PASS_DELAY = 60 * 1000;
async function backfillArtistGenres() {
  _genreBackfillTimer = null;
  try {
    // Collect distinct, still-unknown artist IDs across all known tracks.
    const missing = [];
    const seen = new Set();
    for (const e of combinedHistory()) {
      for (const id of e.artistIds || []) {
        if (id && !seen.has(id) && !_artistGenres.has(id)) { seen.add(id); missing.push(id); }
      }
    }
    if (!missing.length) {
      console.log('[Spotify] Genre backfill complete — all known artists covered');
      return;
    }
    if (_spotifyRateLimited()) {
      _genreBackfillTimer = setTimeout(backfillArtistGenres, GENRE_BACKFILL_PASS_DELAY * 3);
      return;
    }
    let fetched = 0;
    for (let b = 0; b < GENRE_BACKFILL_BATCHES_PER_PASS && b * 50 < missing.length; b++) {
      const ids = missing.slice(b * 50, b * 50 + 50);
      try {
        const res = await api('GET', '/artists', { params: { ids: ids.join(',') } });
        const arr = res?.artists || [];
        // Store every returned artist; also stamp empties so we don't re-request
        // artists Spotify has no genres for.
        for (const a of arr) if (a && a.id) _artistGenres.set(a.id, Array.isArray(a.genres) ? a.genres : []);
        fetched += arr.length;
      } catch (err) {
        console.error('[Spotify] Genre backfill batch failed:', err.message);
        break;
      }
    }
    if (fetched) { _scheduleTasteSave(); console.log(`[Spotify] Genre backfill — +${fetched} artists (${missing.length - fetched} remaining)`); }
    // More to go → schedule the next pass.
    if (missing.length > GENRE_BACKFILL_BATCHES_PER_PASS * 50) {
      _genreBackfillTimer = setTimeout(backfillArtistGenres, GENRE_BACKFILL_PASS_DELAY);
    }
  } catch (err) {
    console.error('[Spotify] backfillArtistGenres error:', err.message);
  }
}

let _topGenresCache = { genres: [], ts: 0 };
const TOP_GENRES_TTL = 6 * 60 * 60 * 1000;
async function _getTopGenres() {
  if (_topGenresCache.genres.length && Date.now() - _topGenresCache.ts < TOP_GENRES_TTL) {
    return _topGenresCache.genres;
  }
  try {
    const res = await api('GET', '/me/top/artists', { params: { time_range: 'medium_term', limit: 50 } });
    _recordArtistGenres(res?.items || []); // free genre data for your top artists
    const counts = {};
    for (const a of res?.items || []) for (const g of a.genres || []) counts[g] = (counts[g] || 0) + 1;
    const genres = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([g]) => g);
    _topGenresCache = { genres, ts: Date.now() };
    return genres;
  } catch {
    return _topGenresCache.genres;
  }
}

// Macro-genre coverage for the Genres tab chips: how many of your known tracks
// fall in each bucket. `ready` once we have genre data for a reasonable share of
// your library; `coverage` lets the UI show buckets sorted by how much you own.
function computeGenreProfile() {
  const counts = {};
  for (const b of GENRE_BUCKETS) counts[b.key] = 0;
  let known = 0, total = 0;
  const seen = new Set();
  for (const e of combinedHistory()) {
    if (!e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    total++;
    const macros = _trackMacroGenres(e);
    if (macros == null) continue;       // artist genres not backfilled yet
    known++;
    for (const k of macros) counts[k] = (counts[k] || 0) + 1;
  }
  const buckets = GENRE_BUCKETS
    .map(b => ({ key: b.key, name: b.name, count: counts[b.key] || 0 }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count);
  return {
    ready: known >= 10 && buckets.length > 0,
    buckets,
    known,
    total,
    pending: total - known,            // artists still awaiting genre backfill
  };
}

// All track IDs the user already knows (everything in their listening history).
// Used to keep "discovery" genuinely unfamiliar.
function _knownTrackIdSet() {
  const s = new Set();
  for (const e of combinedHistory()) if (e.id) s.add(e.id);
  return s;
}

// Max tracks any single artist may contribute to one discovery batch — keeps a
// batch from turning into "5 songs by the same guy in a row".
const DISCOVERY_MAX_PER_ARTIST = 2;

// ── Artist deep cuts via discography ─────────────────────────────────────────
// The old approach searched artist:"X" with a random offset, which only ever
// surfaces whatever Spotify's relevance ranking floats up — usually still the
// hits, and capped at offset ~950. Walking the artist's actual discography
// (/artists/{id}/albums → /albums/{id}/tracks) gives genuine deep cuts: album
// tracks, B-sides, and — via include_groups=appears_on — guest features you'd
// never reach from a track search.
const _artistIdCache = new Map();   // lowercase name → { id, ts }
const _artistAlbumCache = new Map(); // artistId → { albumIds, ts }
const ARTIST_CACHE_TTL = 24 * 60 * 60 * 1000; // discographies barely change — cache a day

async function _resolveArtistId(name) {
  const key = (name || '').toLowerCase().trim();
  if (!key) return null;
  const cached = _artistIdCache.get(key);
  if (cached && Date.now() - cached.ts < ARTIST_CACHE_TTL) return cached.id;
  let id = null;
  try {
    const res = await search(`artist:"${key.replace(/"/g, '')}"`, 'artist', 1);
    const items = res?.artists?.items || [];
    // Prefer an exact name match; fall back to the top hit.
    const exact = items.find(a => (a?.name || '').toLowerCase() === key);
    id = (exact || items[0])?.id || null;
  } catch { /* search miss */ }
  _artistIdCache.set(key, { id, ts: Date.now() });
  return id;
}

async function _getArtistAlbumIds(artistId) {
  if (!artistId) return [];
  const cached = _artistAlbumCache.get(artistId);
  if (cached && Date.now() - cached.ts < ARTIST_CACHE_TTL) return cached.albumIds;
  const albumIds = [];
  try {
    // include_groups: full albums + singles for deep cuts/B-sides, plus appears_on
    // for guest features. Compilations skipped — they're mostly the hits.
    let url = '/artists/' + artistId + '/albums';
    let params = { include_groups: 'album,single,appears_on', limit: 50 };
    for (let page = 0; page < 4; page++) { // up to 200 albums — plenty
      const data = await api('GET', url, { params });
      for (const al of (data?.items || [])) if (al?.id) albumIds.push(al.id);
      if (!data?.next) break;
      params = { ...params, offset: albumIds.length };
    }
  } catch { /* artist albums unavailable */ }
  _artistAlbumCache.set(artistId, { albumIds, ts: Date.now() });
  return albumIds;
}

// Pull genuine deep cuts for one artist by walking their discography. Returns
// serialized tracks (by this artist), excluding anything in excludeIds, capped
// per-album so one record doesn't dominate, shuffled so picks vary run to run.
async function getArtistDeepCuts(artistName, excludeIds = new Set(), limit = 6) {
  const primary = (artistName || '').split(',')[0].trim();
  const artistId = await _resolveArtistId(primary);
  if (!artistId) return [];
  const albumIds = await _getArtistAlbumIds(artistId);
  if (!albumIds.length) return [];

  const _shuffle = (a) => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
  const out  = [];
  const seen = new Set(excludeIds);
  const wantName = primary.toLowerCase();

  // Visit a random handful of albums; take a couple of tracks from each.
  for (const albumId of _shuffle(albumIds).slice(0, 8)) {
    if (out.length >= limit) break;
    let items = [];
    try {
      const data = await api('GET', `/albums/${albumId}/tracks`, { params: { limit: 50 } });
      items = data?.items || [];
    } catch { continue; }
    let takenFromAlbum = 0;
    for (const raw of _shuffle(items)) {
      if (out.length >= limit || takenFromAlbum >= 2) break;
      const t = serializeTrack(raw);
      if (!t || !t.id || seen.has(t.id)) continue;
      // appears_on albums contain other artists' tracks — keep only those the
      // seed artist is actually credited on (deep features), drop the rest.
      const credited = (raw.artists || []).some(a => (a?.name || '').toLowerCase() === wantName);
      if (!credited) continue;
      seen.add(t.id);
      out.push(t);
      takenFromAlbum++;
    }
  }
  return out.slice(0, limit);
}

// Find tracks the user almost certainly hasn't heard, via search.
//   seedArtistNames — artist names from what they're currently enjoying
//   excludeIds      — ids to skip (known history + session-played)
async function getDiscoveryTracks(seedArtistNames = [], excludeIds = new Set(), limit = 6) {
  const out  = [];
  const seen = new Set(excludeIds);
  const artistCount = new Map(); // primary artistId/name → how many already taken
  const _shuffle = (a) => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
  const _artistKey = (t) => (t.artistIds && t.artistIds[0]) || (t.artist || '').toLowerCase();

  // Add candidates, shuffled, respecting the per-artist cap so no single artist
  // dominates the batch.
  const pushNew = (rawTracks) => {
    for (const raw of _shuffle(rawTracks || [])) {
      const t = serializeTrack(raw);
      if (!t || !t.id || seen.has(t.id)) continue;
      const ak = _artistKey(t);
      if ((artistCount.get(ak) || 0) >= DISCOVERY_MAX_PER_ARTIST) continue;
      seen.add(t.id);
      artistCount.set(ak, (artistCount.get(ak) || 0) + 1);
      out.push(t);
    }
  };

  // 1) Genuine deep cuts from artists the user is into — walk their actual
  //    discography (albums → album tracks → guest features) instead of a hits
  //    search. Surfaces B-sides and features a relevance-ranked track search
  //    would never reach. pushNew already serializes, so feed it raw items.
  const artists = _shuffle([...new Set(seedArtistNames.filter(Boolean))]).slice(0, 3);
  for (const name of artists) {
    if (out.length >= limit) break;
    try {
      const cuts = await getArtistDeepCuts(name, seen, limit - out.length);
      // getArtistDeepCuts returns already-serialized tracks; merge respecting caps.
      for (const t of cuts) {
        if (out.length >= limit) break;
        if (!t || !t.id || seen.has(t.id)) continue;
        const ak = _artistKey(t);
        if ((artistCount.get(ak) || 0) >= DISCOVERY_MAX_PER_ARTIST) continue;
        seen.add(t.id);
        artistCount.set(ak, (artistCount.get(ak) || 0) + 1);
        out.push(t);
      }
    } catch { /* keep going */ }
  }

  // 2) Fresh, recent tracks in the user's favourite genres (surfaces NEW artists).
  //    Shuffle which genres get searched + a random offset so discovery doesn't
  //    keep landing on the same handful of songs.
  if (out.length < limit) {
    const genres = _shuffle(await _getTopGenres());
    const yr = new Date().getFullYear();
    for (const g of genres.slice(0, _tDiscoveryGenres())) {
      if (out.length >= limit) break;
      try {
        const offset = Math.floor(Math.random() * 40);
        const res = await search(`genre:"${g}" year:${yr - 2}-${yr}`, 'track', 10, offset);
        pushNew(res?.tracks?.items || []);
      } catch { /* keep going */ }
    }
  }

  return out.slice(0, limit);
}

// ── Borrowed collaborative filtering ─────────────────────────────────────────
// Our engine is N=1 — it only knows THIS user's history, so it can't do the
// cross-user "people like you also loved…" magic that drives Spotify's recs.
// But Spotify's own editorial/algorithmic playlists ("This Is {Artist}",
// "{Genre} Mix") ARE that CF output, distilled from hundreds of millions of
// listeners. They're readable for free via /search + playlist items, so we mine
// them to inject genuine cross-user intelligence into our discovery pool.
const CURATED_MAX_PER_ARTIST = 2;
const CURATED_PL_TTL = 6 * 60 * 60 * 1000; // cache resolved playlist IDs for 6h
const _curatedPlaylistCache = new Map();   // search query → { ids:[...], ts }

// Resolve a curated-playlist search to its best matching playlist IDs, favouring
// Spotify-owned (editorial/algorithmic) playlists — those are the CF ones.
async function _findCuratedPlaylists(query) {
  const cached = _curatedPlaylistCache.get(query);
  if (cached && Date.now() - cached.ts < CURATED_PL_TTL) return cached.ids;
  let ids = [];
  try {
    const res = await search(query, 'playlist', 5);
    const items = (res?.playlists?.items || []).filter(Boolean);
    const spotifyOwned = items.filter(p => p?.owner?.id === 'spotify');
    ids = (spotifyOwned.length ? spotifyOwned : items).map(p => p.id).filter(Boolean);
  } catch { /* search miss — cache the empty result so we don't retry hard */ }
  _curatedPlaylistCache.set(query, { ids, ts: Date.now() });
  return ids;
}

// Pull genuinely-new tracks out of Spotify's curated playlists for the given
// seed artists + genres. excludeIds keeps results unfamiliar (known + played).
async function getCuratedTracks(seedArtistNames = [], seedGenres = [], excludeIds = new Set(), limit = 6) {
  const out  = [];
  const seen = new Set(excludeIds);
  const artistCount = new Map();
  const _artistKey = (t) => (t.artistIds && t.artistIds[0]) || (t.artist || '').toLowerCase();
  const _shuffle = (a) => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);

  // Fetch one playlist's items and add new, artist-capped tracks (shuffled so a
  // popular playlist doesn't always surface the same top entries).
  const pullFrom = async (playlistIds) => {
    for (const pid of playlistIds) {
      if (out.length >= limit) break;
      let items = [];
      try {
        const data = await getPlaylistTracks(pid, 50);
        items = (data?.items || []).map(i => i.item || i.track).filter(Boolean);
      } catch { continue; }
      for (const raw of _shuffle(items)) {
        if (out.length >= limit) break;
        const t = serializeTrack(raw);
        if (!t || !t.id || seen.has(t.id)) continue;
        const ak = _artistKey(t);
        if ((artistCount.get(ak) || 0) >= CURATED_MAX_PER_ARTIST) continue;
        seen.add(t.id);
        artistCount.set(ak, (artistCount.get(ak) || 0) + 1);
        out.push(t);
      }
    }
  };

  // 1) "This Is {Artist}" — Spotify's official per-artist CF playlist. Use the
  //    PRIMARY artist (history names can be comma-joined collabs).
  const artists = _shuffle([...new Set(
    seedArtistNames.map(n => (n || '').split(',')[0].trim()).filter(Boolean)
  )]).slice(0, 2);
  for (const name of artists) {
    if (out.length >= limit) break;
    const ids = await _findCuratedPlaylists(`This Is ${name}`);
    await pullFrom(ids.slice(0, 1));
  }

  // 2) "{Genre} Mix" — Spotify's algorithmic genre playlists (surfaces new artists).
  if (out.length < limit) {
    const genres = _shuffle([...new Set(seedGenres.filter(Boolean))]).slice(0, 2);
    for (const g of genres) {
      if (out.length >= limit) break;
      const ids = await _findCuratedPlaylists(`${g} mix`);
      await pullFrom(ids.slice(0, 1));
    }
  }

  return out.slice(0, limit);
}

let _userProfileInflight = null;
async function getUserProfile() {
  if (_userProfile) return _userProfile;
  // Share a single in-flight /me request so a burst of callers (auth-status
  // checks, playlist/picker handlers) can't each fire their own — that was a
  // big contributor to the /me request storm.
  if (_userProfileInflight) return _userProfileInflight;
  _userProfileInflight = (async () => {
    const profile = await api('GET', '/me');
    _userProfile = profile;
    _userId = profile.id || null;
    return profile;
  })();
  try {
    return await _userProfileInflight;
  } finally {
    _userProfileInflight = null;
  }
}

// ---------------------------------------------------------------------------
// State serialization
// ---------------------------------------------------------------------------

function serializeTrack(item) {
  if (!item) return null;
  return {
    id: item.id,
    uri: item.uri,
    title: item.name,
    artist: item.artists ? item.artists.map((a) => a.name).join(', ') : '',
    artistIds: item.artists ? item.artists.map((a) => a.id) : [],
    album: item.album ? item.album.name : '',
    albumArt:
      item.album && item.album.images && item.album.images.length > 0
        ? item.album.images[0].url
        : null,
    duration: item.duration_ms,
  };
}

// Resolve a list of track IDs to { id, uri, title, artist } objects. Tracks the
// user has played are pulled straight from local history; any others are fetched
// from Spotify's /tracks endpoint (still live) in batches of 50. Original order
// is preserved.
// Cap on live per-track fetches when resolving a past session's track IDs (the
// batch endpoint is gone post-Mar-2026, so each miss is one request).
const RESOLVE_FETCH_MAX = 20;

async function resolveTrackIds(ids = []) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return [];
  const want = new Set(uniq);
  const map  = new Map();

  for (const e of combinedHistory()) {
    if (e.id && want.has(e.id) && !map.has(e.id)) {
      map.set(e.id, {
        id: e.id,
        uri: e.uri || `spotify:track:${e.id}`,
        title: e.title || '',
        artist: e.artist || '',
      });
    }
  }

  // Mar-2026 migration: the batch GET /tracks?ids= endpoint was REMOVED (403).
  // The only replacement is per-id GET /tracks/{id}. Since this resolver is already
  // local-first (history covers almost everything above), the misses are few — we
  // still CAP the live fetches and run them at LOW priority so a session view can
  // never trigger a request storm against the rate limiter.
  const missing = uniq.filter(id => !map.has(id)).slice(0, RESOLVE_FETCH_MAX);
  for (const id of missing) {
    try {
      const item = await api('GET', `/tracks/${id}`, { priority: 'low' });
      if (item && item.id) map.set(item.id, serializeTrack(item));
    } catch (err) {
      console.error('[Spotify] resolveTrackIds fetch failed:', err.message);
    }
  }

  return uniq.map(id => map.get(id)).filter(Boolean);
}

// Dominant vibe of a past session, derived from its tracks' audio features.
function sessionDominantVibe(session) {
  const ids = (session && session.trackIds) || [];
  if (!ids.length) return { vibeKey: null, vibeName: null };
  const byId = new Map(combinedHistory().map(e => [e.id, e]));
  const counts = {};
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    const k = getVibeKey(e);
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return { vibeKey: null, vibeName: null };
  return { vibeKey: top[0], vibeName: getVibeName(top[0]) };
}

function serializeDevice(d) {
  if (!d) return null;
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    volume: d.volume_percent,
    isActive: d.is_active,
  };
}

function serializeState(raw) {
  if (!raw) return null;
  return {
    isPlaying: raw.is_playing,
    progress: raw.progress_ms,
    track: serializeTrack(raw.item),
    device: serializeDevice(raw.device),
    shuffle: raw.shuffle_state,
    repeat: raw.repeat_state,
    context: raw.context
      ? { type: raw.context.type, uri: raw.context.uri }
      : null,
    liked: false,
  };
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

async function getAuthStatus() {
  const cfg = loadCfg();
  if (!cfg || !cfg.clientId || !cfg.clientSecret) {
    return { connected: false, configured: false };
  }

  const tokens = loadTokens();
  if (!tokens || !tokens.accessToken) {
    return { connected: false, configured: true };
  }

  // Check whether the stored token has all required scopes.
  // tokens.scope is only present for tokens obtained after this check was added;
  // if it is missing we assume the token is old and needs reauth.
  const grantedScopes = tokens.scope ? tokens.scope.split(' ') : [];
  const missingScopes = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));
  const needsReauth = missingScopes.length > 0;

  // Fast path: use the already-fetched profile (avoids an extra API hit,
  // and avoids a false "not connected" when the API is temporarily rate-limited).
  if (_userProfile) {
    return {
      connected: true,
      configured: true,
      displayName: _userProfile.display_name,
      userId: _userProfile.id,
      needsReauth,
      missingScopes,
    };
  }

  // Second fast path: if the poll loop is running, the token is valid — return
  // connected immediately rather than risking a rate-limited live API call.
  if (_polling) {
    return { connected: true, configured: true, needsReauth, missingScopes };
  }

  // Fallback: no cache and polling hasn't started yet — do a live check.
  try {
    const profile = await getUserProfile();
    return {
      connected: true,
      configured: true,
      displayName: profile.display_name,
      userId: profile.id,
      needsReauth,
      missingScopes,
    };
  } catch {
    return { connected: false, configured: true };
  }
}

function isConfigured() {
  const cfg = loadCfg();
  return !!(cfg && cfg.clientId && cfg.clientSecret);
}

function isAuthed() {
  const tokens = loadTokens();
  return !!(tokens && tokens.accessToken);
}

// ===========================================================================
// Smart Queue engine
// ===========================================================================
//
// One unified auto-queue engine that REPLACES the old "Autoplay" and "Smart
// Shuffle" features.
//
// IMPORTANT — why we don't rely on Spotify's native Autoplay: playback started
// through the Web API with a `uris` array does NOT trigger client Autoplay
// ("Up Next" never populates, no matter the method). Native Autoplay only
// continues from a context (album/artist/playlist); the desktop/mobile app
// attaches a hidden track-radio context the public API can't replicate. So
// instead of waiting for anchors that never come, WE source the discovery
// anchors ourselves:
//
//   1. We fetch Spotify's recommendation engine (getSimilarTracks) for raw
//      discovery anchors — UNbiased, the same fresh picks the app would pull.
//   2. We build a bounded "window": those anchors as a fixed-order spine, with
//      OUR slider-tuned picks (getSimilarTracks + context-bias / mood / vibe)
//      woven into the roughest gaps so the whole run flows. Our share is clamped
//      to a balanced 40–60% (0% when the toggle is OFF → pure anchors).
//   3. We ENQUEUE the whole upcoming window ourselves (addToQueue) so "Up Next"
//      populates immediately, exactly like the app does.
//   4. As the current track advances and few slots remain ahead, we EXTEND the
//      window (fetch a fresh batch bridging from the last slot) and enqueue it,
//      so playback never runs dry.
//   5. If the current track ever leaves the window (manual skip / new play —
//      both of which clear Spotify's queue), we rebuild a fresh window here.
//   6. No song we pick repeats within a session; the session's no-repeat memory
//      resets when the user starts a new seed (search / playlist / mood / vibe).
//
// Entry points (all set up a session, then `_sqTick` drives it from `poll`):
//   • search-play  → ON: weave our picks;  OFF: anchors-only (0% ours) so music
//                    keeps going (the API won't autoplay a bare track on its own)
//   • playlist end → only when the toggle is ON
//   • mood / vibe  → ALWAYS (Smart Queue is the engine for these regardless)
// ---------------------------------------------------------------------------

// Display helper: "Title — Artist", tolerant of both serialized (title/artist)
// and raw Spotify (name/artists[]) track shapes.
function _sqName(t) {
  if (!t) return '(unknown)';
  const title = t.title || t.name || '(unknown)';
  let artist = t.artist || '';
  if (!artist && Array.isArray(t.artists)) artist = t.artists.map(a => a?.name || a).filter(Boolean).join(', ');
  return artist ? `${title} — ${artist}` : title;
}

// Resolve audio features onto a track (from itself or history) and add the
// Camelot position so _trackFlowScore can rate transitions.
function _sqAnnotate(t) {
  if (!t) return t;
  const f = (t.energy != null) ? t : (_trackFeatures(t) || {});
  const key  = t.key  != null ? t.key  : f.key;
  const mode = t.mode != null ? t.mode : f.mode;
  return {
    ...t,
    bpm:    t.bpm    != null ? t.bpm    : f.bpm,
    energy: t.energy != null ? t.energy : f.energy,
    key, mode,
    _cam: _camelotPos(key, mode),
  };
}

// Flow score guarded against missing features (neutral 0.5 when unknown).
function _sqFlow(a, b) {
  if (!a || !b) return 0.5;
  return _trackFlowScore(a, b);
}

// How many of OUR songs to target for a window of `anchorCount` Spotify anchors.
// Baseline ~50%, nudged by the fade/smooth slider (smoother → more bridge songs),
// then hard-clamped into the 40–60% band.
function _sqTargetOurs(anchorCount) {
  if (_sq && !_sq.weave) return 0;                           // toggle OFF → pure Spotify anchors
  const lean  = (_tuning.fadeSmooth || 50) / 100;            // 0..1
  const ideal = Math.round(anchorCount * _lerp(0.8, 1.4, lean));
  const minU  = Math.ceil (anchorCount * SQ_RATIO_MIN / (1 - SQ_RATIO_MIN)); // ≈0.667·n
  const maxU  = Math.floor(anchorCount * SQ_RATIO_MAX / (1 - SQ_RATIO_MAX)); // =1.5·n
  return _clampNum(ideal, Math.max(1, minU), Math.max(1, maxU));
}

// Familiar candidates drawn from the user's own library/history (the low-freshness
// half of the search blend). Feature-bearing, ranked by durable artist taste so
// loved artists surface first, ties shuffled. Excludes played/disliked/no-repeat.
function _sqLibraryCandidates(count) {
  const seen = new Set();
  const pool = _excludeDisliked(combinedHistory().filter(t =>
    t && t.id && t.energy != null &&
    !_sq.noRepeat.has(t.id) && !_isRecentlyPlayed(t.id) &&
    !seen.has(t.id) && seen.add(t.id)));

  // Rank familiar picks by durable artist taste BLENDED with how well each track
  // matches the time-of-day the user is actually in right now (the learned context
  // centroid). The context term is the "how did it know?" factor — late-night picks
  // skew to your late-night sound, mornings skew bright — at ZERO API cost. Scores
  // are computed once per track (the random jitter must stay OUT of the comparator,
  // or the sort becomes inconsistent); the jitter keeps successive runs from being
  // identical. With no learned profile yet, ctx is neutral and this reduces to the
  // old artist-taste-first ordering, so nothing regresses on a cold start.
  const prof = _currentContextProfile();
  const centroid = (prof?.centroid && prof.centroid.energy != null) ? prof.centroid : null;
  const setCloser = _sqSetCloserActive();
  // Explore/exploit momentum (#3): when you're locked in, trust the ranking and add
  // almost no jitter (exploit your proven sound); when you're restless, widen the
  // jitter so the familiar pool reshuffles toward more variety (explore).
  const mode = _engagementMomentum().mode;
  const jitter = mode === 'restless' ? 0.30 : mode === 'locked' ? 0.05 : 0.12;
  let maxBoost = 0;
  for (const t of pool) { const b = _artistBoost(t.artist); if (b > maxBoost) maxBoost = b; }
  const ranked = pool.map(t => {
    const artist = maxBoost > 0 ? _artistBoost(t.artist) / maxBoost : 0;       // 0..1
    const ctx = centroid ? Math.max(0, 1 - _clusterDist(centroid, t)) : 0.5;   // 0..1 (neutral w/o profile)
    // Set-closer (#8): when winding down, fold in a "calmer is better" term so the
    // tail of the night eases off rather than spiking back up.
    const cool = setCloser ? (1 - (t.energy != null ? t.energy : 50) / 100) : 0;
    const base = setCloser
      ? artist * 0.40 + ctx * 0.35 + cool * 0.25 + Math.random() * jitter
      : artist * 0.55 + ctx * 0.45 + Math.random() * jitter;
    // Explicit "Dislike"/"Never" ratings strongly suppress how often the artist is
    // picked, without ever removing them from the pool entirely.
    const s = base * _artistRatingMult(t.artist);
    return { t, s };
  });
  ranked.sort((a, b) => b.s - a.s);
  const picks = ranked.slice(0, count).map(x => x.t);
  const taken = new Set(); // slot indices already given a "special" pick this build

  // Re-discovery (#2): surface one track you clearly enjoy but haven't heard in a
  // long while, that STILL fits the current sound — the queue's "haven't heard this
  // in N days" moment. Picks the oldest qualifying candidate. Cloned + tagged so the
  // flag never leaks onto shared history objects.
  if (centroid && picks.length >= 2) {
    const lastTs = _lastPlayedById();
    const now = Date.now();
    const inSlice = new Set(picks.map(p => p.id));
    let oldest = null, oldestAge = REDISCOVER_MIN_AGE_MS;
    for (const x of ranked) {
      const t = x.t;
      if (inSlice.has(t.id) || t.energy == null || t.valence == null) continue;
      const ts = lastTs.get(t.id);
      if (ts == null) continue;
      const age = now - ts;
      if (age <= oldestAge) continue;
      if (_clusterDist(centroid, t) > 0.25) continue; // must still fit the current vibe
      oldestAge = age; oldest = t;
    }
    if (oldest) {
      const idx = picks.length - 1;
      picks[idx] = { ...oldest, _rediscovery: true, _rediscoverDays: Math.round(oldestAge / 86400000) };
      taken.add(idx);
    }
  }

  // Anti-rut (#7): if this slot is stuck in a tight cluster, swap the weakest free
  // pick for the best "stretch" candidate — fresh-sounding (further from centroid)
  // yet still adjacent enough to be pleasant. Tagged so the UI can say "stretching
  // your sound". Cloned so the _stretch flag never leaks back onto shared history.
  if (centroid && picks.length && _slotInRut()) {
    const inSlice = new Set(picks.map(p => p.id));
    const stretch = ranked
      .map(x => ({ t: x.t, d: _clusterDist(centroid, x.t) }))
      .filter(x => !inSlice.has(x.t.id) && x.d >= 0.25 && x.d <= 0.55)[0]; // ranked order preserved
    let idx = picks.length - 1;
    while (idx >= 0 && taken.has(idx)) idx--;
    if (stretch && idx >= 0) picks[idx] = { ...stretch.t, _stretch: true };
  }
  return picks;
}

// Variety gate for the search/playlist path: prefer candidates whose audio features
// sit within a Variety-scaled radius of the SEED track's sound. Low variety → songs
// that sound like the seed; high → anything. In-radius picks come first; out-of-radius
// and unjudgeable tracks trail as filler so we never starve.
function _sqVarietyGate(tracks, seedId) {
  const seedFeat = seedId ? _findStoredFeatures(seedId) : null;
  if (!seedFeat || seedFeat.energy == null) return tracks;
  const radius = _lerp(0.15, 1.0, _tVariety());     // _clusterDist is normalised 0..~1
  const within = [], rest = [];
  for (const t of tracks) {
    const f = _trackFeatures(t);
    if (!f || f.energy == null) { rest.push(t); continue; }   // unknown → allow as filler
    (_clusterDist(seedFeat, f) <= radius ? within : rest).push(t);
  }
  return [...within, ...rest];
}

// Build a pool of OUR candidate tracks for the active session's source. Filtered
// against this session's no-repeat memory, disliked artists and the recent-play
// guard so nothing repeats too soon.
async function _sqBuildOurCandidates(count) {
  let tracks = [];
  try {
    if (_sq.source === 'mix' && _activeMixTarget) {
      tracks = await buildMixFromTarget(_activeMixTarget, count);
    } else if (_sq.source === 'mood' && _activeMoodKey) {
      tracks = await buildMoodPlaylist(_activeMoodKey, count);
    } else if (_sq.source === 'vibe' && _activeVibeKey) {
      tracks = await buildVibePlaylist(_activeVibeKey, count);
    } else if (_sq.source === 'rightnow') {
      const rn = computeRightNow();
      tracks = rn.ready ? [...rn.topTracks] : [];
    } else {
      // search / playlist / generic discovery. The sliders shape this everyday path:
      //   • Freshness  → split between NEW Spotify discovery and FAMILIAR library picks
      //   • Variety    → how many seed artists we branch from, then a feature-radius gate
      const seedId = _sq.lastSeedId || _lastState?.track?.id || null;
      const artistBreadth = 1 + Math.round(_tVariety() * 3);                 // 1–4 seed artists
      const seedArtists = (_lastState?.track?.artistIds || []).slice(0, artistBreadth);

      const fresh    = _tDiscoveryRatio();                                   // 0..0.9 = share NEW
      // Local-first: only spend an API call on NEW discovery when we're outside the
      // anchor cooldown and not rate-limited. Otherwise fold the discovery share back
      // into familiar library picks so the window still fills with zero API cost.
      const cooled    = Date.now() - _sqLastApiAnchorFetch > SQ_API_ANCHOR_COOLDOWN;
      const canApi    = cooled && !_spotifyRateLimited();
      const discCount = canApi ? Math.max(0, Math.round(count * fresh)) : 0;
      const libCount  = Math.max(0, count - discCount);

      let disc = [];
      if (discCount > 0) {
        const raw = await getSimilarTracks(seedId ? [seedId] : [], seedArtists, discCount + 4);
        if (raw?.length) _sqLastApiAnchorFetch = Date.now();
        disc = _applyContextBias(raw);
      }
      const lib = libCount > 0 ? _sqLibraryCandidates(libCount + 8) : [];

      tracks = _sqVarietyGate([...lib.slice(0, libCount + 4), ...disc.slice(0, discCount + 4)], seedId);
    }
  } catch (err) {
    console.error('[SmartQueue] Candidate build failed:', err.message);
  }
  let out = _excludeDisliked(tracks || []).filter(t =>
    t && t.id && !_sq.noRepeat.has(t.id) && !_isRecentlyPlayed(t.id));

  // Resilient top-up. The primary source (rightnow's top tracks, a mood/vibe
  // list, or the search blend) runs dry mid-session once its picks all land in
  // the no-repeat memory — which is exactly when window EXTENDS started coming
  // back "0 ours" and the queue drifted to pure Spotify anchors. Backfill from
  // the taste/context-ranked library so our songs keep getting woven in for as
  // long as ANY unplayed familiar track remains. _sqLibraryCandidates already
  // excludes no-repeat/recent/disliked, so this never resurfaces a just-played
  // track, and it's context-biased so the fills still suit the current sound.
  if (out.length < count) {
    const have = new Set(out.map(t => t.id));
    for (const t of _sqLibraryCandidates(count * 2)) {
      if (out.length >= count) break;
      if (t && t.id && !have.has(t.id)) { out.push(t); have.add(t.id); }
    }
  }
  return out;
}

// Build the raw Spotify DISCOVERY anchors for a window — the fresh picks the app
// would surface. Unlike OUR candidates these are NOT context-biased: we want
// Spotify's own recommendations here so the window discovers new music. Seeded
// off the last-known track/artists. Filtered against this session's no-repeat
// memory, disliked artists and the recent-play guard.
async function _sqBuildSpotifyAnchors(count) {
  const seedId = _sq?.lastSeedId || _lastState?.track?.id || null;
  // Local-first: fill the discovery spine from the warmed library/history (zero
  // API cost) before reaching for the live API.
  let tracks = _sqLibraryCandidates(count + 4);

  // Only top up from the API when local can't fill the window AND we're outside the
  // cooldown — and never while rate-limited. This keeps API-backed discovery rare
  // and well-spaced, which is the whole point of local-first.
  const needApi = tracks.length < count;
  const cooled  = Date.now() - _sqLastApiAnchorFetch > SQ_API_ANCHOR_COOLDOWN;
  if (needApi && cooled && !_spotifyRateLimited()) {
    try {
      const artistBreadth = 1 + Math.round(_tVariety() * 3);              // 1–4 seed artists
      const seedArtists = (_lastState?.track?.artistIds || []).slice(0, artistBreadth);
      const raw = await getSimilarTracks(seedId ? [seedId] : [], seedArtists, count + 4);
      if (raw?.length) {
        _sqLastApiAnchorFetch = Date.now();
        const have = new Set(tracks.map(t => t.id));
        tracks = [...tracks, ...raw.filter(t => t && t.id && !have.has(t.id))];
      }
    } catch (err) {
      console.error('[SmartQueue] Anchor API fetch failed:', err.message);
    }
  } else if (needApi) {
    console.log(`[SmartQueue] Anchors local-only (${tracks.length}/${count}) — ${_spotifyRateLimited() ? 'rate-limited' : 'API cooldown'}`);
  }

  const filtered = _excludeDisliked(tracks || []).filter(t =>
    t && t.id && !_sq.noRepeat.has(t.id) && !_isRecentlyPlayed(t.id));
  // Variety also gates the discovery spine: low variety keeps anchors close to the
  // seed's sound, high variety lets them roam.
  return _sqVarietyGate(filtered, seedId);
}

// Plan the interleaving: keep the Spotify anchors in fixed order and insert our
// picks into the roughest gaps (where consecutive anchors flow worst) so each of
// our songs does the most bridging work. Returns the upcoming slot list (AFTER
// the `currentAnn` left-edge), each { track, source:'ours'|'spotify' }.
function _sqPlanInterleave(currentAnn, anchors, ourPool, targetU) {
  const spine = [currentAnn, ...anchors];          // fixed order, never reordered
  const gaps = [];
  for (let i = 0; i < spine.length; i++) {
    const left = spine[i], right = spine[i + 1] || null;
    gaps.push({ left, right, rough: right ? (1 - _sqFlow(left, right)) : 0.5, picks: [] });
  }
  const order = [...gaps].sort((a, b) => b.rough - a.rough); // roughest first
  const pool = [...ourPool];
  let used = 0;
  for (let pass = 0; pass < 2 && used < targetU && pool.length; pass++) {
    for (const g of order) {
      if (used >= targetU || !pool.length) break;
      if (pass === 0 && g.picks.length >= 1) continue;            // pass 1: ≤1 per gap
      if (pass === 1 && (g.rough < 0.45 || g.picks.length >= 2)) continue; // pass 2: a 2nd only in rough gaps
      const left = g.picks.length ? g.picks[g.picks.length - 1] : g.left;
      let best = 0, bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        let s = _sqFlow(left, pool[i]);
        if (g.right) s += _sqFlow(pool[i], g.right);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      g.picks.push(pool.splice(best, 1)[0]);
      used++;
    }
  }
  // Stitch: gap i's picks come AFTER spine[i] and BEFORE spine[i+1].
  const slots = [];
  for (let i = 1; i < spine.length; i++) {
    for (const p of gaps[i - 1].picks) slots.push({ track: p, source: 'ours' });
    slots.push({ track: spine[i], source: 'spotify' });
  }
  for (const p of gaps[spine.length - 1].picks) slots.push({ track: p, source: 'ours' });
  return { slots, used };
}

// Short, human adjectives for the current time-of-day, used in pick reasons
// ("late-night match"). Mirrors _timeSlotFor's buckets.
const SLOT_ADJ = {
  latenight: 'late-night', earlyam: 'early-morning', morning: 'morning',
  midday: 'midday', afternoon: 'afternoon', evening: 'evening', night: 'night',
};

// Learned stop-time (#6): the hour you usually wind down. For each distinct local
// day in history, take the hour of that day's LAST play; the median of those is
// your typical stop hour. Late nights (0–5h) are unwrapped to 24–29 first so a few
// 1am finishes don't drag the median back to midday. Cached; null until enough data.
const STOP_HOUR_TTL = 30 * 60 * 1000;
let _stopHourCache;            // undefined = uncomputed; null = thin data; number = hour
let _stopHourAt = 0;
function _learnedStopHour() {
  if (_stopHourCache !== undefined && Date.now() - _stopHourAt < STOP_HOUR_TTL) return _stopHourCache;
  const lastByDay = new Map(); // dayKey → { ts, h }
  for (const e of _history) {
    if (e.ts == null || e.h == null) continue;
    const d = new Date(e.ts);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const prev = lastByDay.get(key);
    if (!prev || e.ts > prev.ts) lastByDay.set(key, { ts: e.ts, h: e.h });
  }
  const hours = [...lastByDay.values()].map(v => v.h);
  let result = null;
  if (hours.length >= 5) {
    const adj = hours.map(h => (h < 6 ? h + 24 : h)).sort((a, b) => a - b);
    result = adj[Math.floor(adj.length / 2)] % 24;
  }
  _stopHourCache = result;
  _stopHourAt = Date.now();
  return result;
}

// Set-closer (#8 + #6): approaching your learned wind-down hour (or, before we've
// learned one, simply late at night) AND your recent real plays are cooling down →
// ease the queue toward calmer tracks and label the tail "landing the set".
function _sqSetCloserActive() {
  const h = new Date().getHours();
  const stop = _learnedStopHour();
  let near;
  if (stop != null) {
    const diff = (stop - h + 24) % 24;            // hours until the learned stop hour
    near = diff <= 2 || (24 - diff) <= 1;         // ~2h before … up to 1h past
  } else {
    const slot = _timeSlotFor(h);
    near = (slot === 'night' || slot === 'latenight');
  }
  if (!near) return false;
  const recent = _history.filter(e => e.energy != null).slice(-6);
  if (recent.length < 4) return false;
  const mid = Math.floor(recent.length / 2);
  const avg = (a) => a.reduce((s, e) => s + e.energy, 0) / a.length;
  return avg(recent.slice(mid)) < avg(recent.slice(0, mid)) - 8; // meaningfully falling
}

// Anti-rut (#7): when THIS slot's recent history is tightly clustered around its
// centroid, the model risks looping one sound. Returns true so the candidate
// picker deliberately injects one adjacent-but-fresh "stretch" track.
function _slotInRut() {
  const prof = _computeContextProfiles()[_currentSlotKey()];
  if (!prof || !prof.centroid || prof.count < 12) return false;
  const slot = _timeSlotFor(new Date().getHours());
  const recent = _history.filter(e =>
    e.energy != null && e.valence != null && _timeSlotFor(e.h) === slot).slice(-12);
  if (recent.length < 8) return false;
  const spread = recent.reduce((s, e) => s + _clusterDist(prof.centroid, e), 0) / recent.length;
  return spread < 0.18; // very tight = rut
}

// Explain — in the user's language — WHY this song earned its slot, and flag a
// harmonically smooth transition from the previous slot. This is the "magic
// factor": it surfaces the harmonic mixing + context learning the engine already
// does. `left` is the annotated previous slot's track (or null for slot 0);
// `opts.setCloser` tags the wind-down tail.
function _sqReasonFor(track, source, left, opts = {}) {
  const reasons = [];
  let smoothMix = false;
  if (left && track) {
    const cam  = _camelotScore(left._cam, track._cam); // 0..1 (≥0.8 = same/adjacent/parallel key)
    const flow = _sqFlow(left, track);                 // 0..1 harmonic+bpm+energy smoothness
    if (cam >= 0.8 || flow >= 0.8) { smoothMix = true; reasons.push('smooth mix'); }
    else if (flow >= 0.68) reasons.push('bridges the gap');
    // Bonded pairs (#4): you reliably play these two back-to-back — the learned
    // transition score says this exact ordering keeps landing.
    if (_bondStrong(left, track)) reasons.push('you play these back-to-back');
  }
  if (source === 'ours') {
    // One of your most-played songs (profile top-tracks signal) — the strongest,
    // most honest "you love this" we can show, so it leads.
    if (_isTopTrack(track.id)) reasons.push('one of your most-played');
    const loved = _isLovedArtist(track.artist);          // learned love OR a top artist
    if (loved) reasons.push('loved artist');
    else {
      const anchor = _anchorLovedArtist(track);        // #1 because you love X
      if (anchor) reasons.push(`because you love ${anchor}`);
    }
    // Context fit drives both the "evening match" badge and discovery confidence.
    const prof = _currentContextProfile();
    let ctxFit = null;
    if (prof?.centroid && track.energy != null && track.valence != null) {
      ctxFit = _clusterDist(prof.centroid, track); // 0 = dead-on the learned sound
      if (ctxFit <= 0.35) reasons.push(`${SLOT_ADJ[_timeSlotFor(new Date().getHours())]} match`);
    }
    if (opts.setCloser)   reasons.push('landing the set');   // #8
    if (track._stretch)   reasons.push('stretching your sound'); // #7
    if (track._rediscovery) {                                // #2 re-discovery
      const d = track._rediscoverDays;
      reasons.push(d ? `haven't heard in ${d} days` : "haven't heard in a while");
    }
    if (_isRescued(track.id)) reasons.push('rescued');       // rescued badge
    if (!reasons.length) {
      // Discovery confidence (#6): a fresh pick is an honest "fresh discovery", but
      // when it lands right on your learned sound it's a confident "safe bet".
      reasons.push(ctxFit != null && ctxFit <= 0.45 ? 'safe bet · new sound' : 'fresh discovery');
    }
  } else if (!reasons.length) {
    reasons.push('on your station');
  }
  return { reason: [...new Set(reasons)].slice(0, 3).join(' · '), smoothMix };
}

// Turn a current track + raw anchor list into a fresh window (slot 0 = current).
function _sqAssembleWindow(currentTrack, slots) {
  const window = [{
    uri: currentTrack.uri, id: currentTrack.id, track: currentTrack,
    source: 'spotify', added: true, played: true,
    reason: '', smoothMix: false,
  }];
  // Set-closer tags only the LAST of our picks so the queue reads as winding down
  // toward a close rather than every slot shouting "landing the set".
  const setCloser = _sqSetCloserActive();
  let lastOursIdx = -1;
  for (let i = 0; i < slots.length; i++) if (slots[i].source === 'ours') lastOursIdx = i;
  let left = _sqAnnotate(currentTrack);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const uri = s.track.uri || (s.track.id ? `spotify:track:${s.track.id}` : null);
    if (!uri) continue;
    const ann = (s.track._cam !== undefined) ? s.track : _sqAnnotate(s.track);
    const { reason, smoothMix } = _sqReasonFor(ann, s.source, left, {
      setCloser: setCloser && i === lastOursIdx,
    });
    window.push({ uri, id: s.track.id, track: s.track, source: s.source, added: false, played: false, reason, smoothMix });
    if (s.source === 'ours' && s.track.id) _sq.noRepeat.add(s.track.id);
    left = ann;
  }
  return window;
}

// Durable per-track reason cache. The live Smart Queue window is trimmed as
// playback advances (_sqTrimWindow drops slots well behind the cursor) and gets
// rebuilt on divergence, so a reason that lives only in _sq.window disappears
// from the queue panel on the next refresh / page reload — even when the same
// track is still queued on Spotify. We mirror every annotated slot into this
// bounded LRU cache (keyed by uri AND id) so the queue can always be re-decorated
// with the explanation we already computed, regardless of window lifecycle.
const _SQ_REASON_CACHE_MAX = 400;
const _sqReasonCache = new Map();
function _sqCacheReason(slot) {
  if (!slot || (!slot.reason && !slot.smoothMix && slot.source !== 'ours')) return;
  const entry = { source: slot.source, reason: slot.reason || '', smoothMix: !!slot.smoothMix };
  for (const k of [slot.uri, slot.id]) {
    if (!k) continue;
    if (_sqReasonCache.has(k)) _sqReasonCache.delete(k); // bump LRU recency
    _sqReasonCache.set(k, entry);
  }
  while (_sqReasonCache.size > _SQ_REASON_CACHE_MAX) {
    _sqReasonCache.delete(_sqReasonCache.keys().next().value); // evict oldest
  }
}

// Build a uri/id → { source, reason, smoothMix } lookup over the live Smart
// Queue window, so emitQueue() can decorate the real Spotify queue with our
// per-pick explanations (the real /me/player/queue carries none of our metadata).
// Mirrors each annotated slot into the durable cache as a side effect.
function _sqWindowAnnotations() {
  const map = new Map();
  if (!_sq || !Array.isArray(_sq.window)) return map;
  for (const slot of _sq.window) {
    if (!slot.reason && !slot.smoothMix && slot.source !== 'ours') continue;
    const entry = { source: slot.source, reason: slot.reason || '', smoothMix: !!slot.smoothMix };
    if (slot.uri) map.set(slot.uri, entry);
    if (slot.id)  map.set(slot.id, entry);
    _sqCacheReason(slot);
  }
  return map;
}

// Resolve a queue item's annotation: prefer the live window, fall back to the
// durable cache so per-pick reasons survive window trims, rebuilds and refreshes.
function _sqAnnotationFor(ann, t) {
  if (!t) return null;
  return ann.get(t.uri) || ann.get(t.id)
      || _sqReasonCache.get(t.uri) || _sqReasonCache.get(t.id) || null;
}

// --- Album-art / duration cache --------------------------------------------
// We feed Spotify only ONE track at a time, so the panel is rendered from our
// in-memory window (the full upcoming plan + reasons) rather than the physical
// queue. But our window slots come from local history/library and carry no
// album art or duration. So we opportunistically remember those fields from the
// full track objects Spotify hands us for free in getQueue()/currently_playing
// (no extra API calls), keyed by id and uri, and look them up when rendering.
const _SQ_META_MAX = 500;
const _sqMetaCache = new Map(); // id|uri -> { art, duration }
function _sqRememberMeta(tracks) {
  if (!Array.isArray(tracks)) return;
  for (const t of tracks) {
    if (!t) continue;
    const art = (t.album && t.album.images && t.album.images.length) ? t.album.images[0].url : null;
    const duration = t.duration_ms || null;
    if (!art && !duration) continue;
    const entry = { art, duration };
    if (t.id)  _sqMetaCache.set(t.id, entry);
    if (t.uri) _sqMetaCache.set(t.uri, entry);
  }
  while (_sqMetaCache.size > _SQ_META_MAX) {
    _sqMetaCache.delete(_sqMetaCache.keys().next().value); // evict oldest
  }
}
function _sqMetaFor(t) {
  if (!t) return null;
  return (t.id && _sqMetaCache.get(t.id)) || (t.uri && _sqMetaCache.get(t.uri)) || null;
}
function _sqArtistStr(t) {
  if (!t) return '';
  if (t.artist) return t.artist;
  if (Array.isArray(t.artists)) return t.artists.map(a => a?.name || a).filter(Boolean).join(', ');
  return '';
}

// Build the queue-panel item list from our in-memory Smart Queue window — the
// full upcoming plan with every pick's "why" — rather than the physical Spotify
// queue (which, since we feed one song at a time, is just our single pending
// pick followed by Spotify autoplay filler). Already-played and dupe slots are
// excluded; album art / duration are resolved from the meta cache.
function _sqPanelItems() {
  if (!_sq || !Array.isArray(_sq.window)) return [];
  const out = [];
  for (let i = _sq.pos + 1; i < _sq.window.length && out.length < 30; i++) {
    const s = _sq.window[i];
    if (!s || s.played || s.dupe || !s.track) continue;
    const t = s.track;
    const meta = _sqMetaFor(t);
    const art = t.albumArt || t.art
              || ((t.album && t.album.images && t.album.images.length) ? t.album.images[0].url : null)
              || (meta && meta.art) || null;
    out.push({
      id: t.id,
      uri: s.uri || t.uri,
      title: t.title || t.name || '',
      artist: _sqArtistStr(t),
      albumArt: art,
      duration: t.duration_ms || (meta && meta.duration) || null,
      source: s.source,
      reason: s.reason || undefined,
      smoothMix: !!s.smoothMix,
    });
  }
  return out;
}

// A compact, holistic summary of the UPCOMING Smart Queue window for the queue
// card's header strip: a streak callout (#1), the harmonic key-journey (#2), an
// energy sparkline (#4) and the set-closer state (#8). Returns null when there's
// no active session so the strip stays hidden during plain playback.
function _sqInsightStrip() {
  if (!_sq || !Array.isArray(_sq.window)) return null;
  const upcoming = _sq.window.filter(s => !s.played);
  if (upcoming.length < 2) return null;

  // #4 — energy per upcoming slot (0..100; null where features are unknown).
  const energy = upcoming.map(s => {
    const e = s.track && s.track.energy;
    return (e != null) ? Math.round(e) : null;
  });

  // #2 — Camelot codes of consecutive slots, consecutive repeats collapsed.
  const keys = [];
  for (const s of upcoming) {
    const cam = (s.track && s.track._cam) || _camelotPos(s.track && s.track.key, s.track && s.track.mode);
    if (cam && cam.code) keys.push(cam.code);
  }
  const journey = keys.filter((c, i) => i === 0 || c !== keys[i - 1]).slice(0, 6);

  // #1 — pick the single most interesting streak/callout to show.
  let lovedRun = 0;
  for (const s of upcoming) {
    if (s.source === 'ours' && _isLovedArtist(s.track && s.track.artist)) lovedRun++;
    else break;
  }
  const oursCount   = upcoming.filter(s => s.source === 'ours').length;
  const smoothCount = upcoming.filter(s => s.smoothMix).length;
  const setCloser   = _sqSetCloserActive();

  const momentum = _engagementMomentum().mode; // #3

  let streak = '';
  if (lovedRun >= 2)               streak = `${lovedRun} loved-artist picks in a row`;
  else if (momentum === 'restless') streak = 'mixing it up — more variety ahead';
  else if (setCloser)              streak = 'easing down to close the set';
  else if (momentum === 'locked')  streak = "you're locked in — leaning into your sound";
  else if (smoothCount >= 3)       streak = `${smoothCount} smooth transitions ahead`;
  else if (oursCount >= 1)         streak = `${oursCount} of ${upcoming.length} hand-picked`;

  return { streak, journey, energy, smoothCount, setCloser, momentum };
}

// Pretty-print the whole window. OUR songs are wrapped in --dashes--; Spotify's
// are plain. ▶ marks the current slot; OURS+ means already added to the queue.
function _sqLogWindow(label) {
  if (!_sq) return;
  const lines = _sq.window.map((s, i) => {
    const cursor = i === _sq.pos ? '▶' : ' ';
    const name = _sqName(s.track);
    const body = s.source === 'ours' ? `--${name}--` : name;
    const tag  = s.userQueued ? 'USERQ ' : s.dupe ? 'DUPE ⊘' : (s.source === 'ours' ? (s.added ? 'OURS+ ' : 'OURS  ') : 'SPOTIFY');
    return `        ${cursor} ${String(i + 1).padStart(2)}. [${tag}] ${body}`;
  });
  console.log(`[SmartQueue] ${label} — session ${_sq.id} (${_sq.window.length} slots, source=${_sq.source}):\n${lines.join('\n')}`);
}

function _sqTrimNoRepeat() {
  const MAX = 300;
  if (!_sq || _sq.noRepeat.size <= MAX) return;
  const it = _sq.noRepeat.values();
  for (let i = 0, n = _sq.noRepeat.size - MAX; i < n; i++) _sq.noRepeat.delete(it.next().value);
}

// Start a session. The first poll tick builds the window immediately — there is
// no "arming" wait because we source the discovery anchors ourselves (the Web
// API never autoplays a bare track). `weave` controls whether OUR picks are
// woven in (search/playlist honour the toggle; mood/vibe/rightnow always weave).
function _sqStart(source, seedTrack, weave = true) {
  // Kill any existing session FIRST so a new start completely replaces the old
  // one. The id bump below is the kill switch: every async Smart Queue operation
  // captures its session id and bails (via _sqAlive) the moment it no longer
  // matches, so an in-flight build/enqueue from the previous session can never
  // resume and write its picks into this new one (the "two queues at once" bug).
  if (_sq) _sqStop('superseded by a new session');
  _sq = {
    id: ++_sqSessionSeq,
    source,
    weave,
    mode: 'active',
    window: [],
    pos: -1,
    noRepeat: new Set(),
    // Every track id that has physically entered Spotify's queue OR actually
    // played this session. We add the whole queue ourselves (one song at a time),
    // so a "late dupe" is simply a window slot whose id is already in here — we
    // flag it, log it, and never add it. No live-queue check needed.
    seen: new Set(),
    building: false,
    lastTickTrackId: null,
    lastSeedId: seedTrack?.id || null,
  };
  if (seedTrack?.id) { _sq.noRepeat.add(seedTrack.id); _sq.seen.add(seedTrack.id); }
  // Build the window right away rather than waiting for the next slow base tick.
  refreshNow('smart-queue start');
  console.log(`[SmartQueue] ★ Session ${_sq.id} started — source=${source}, weave=${weave}, seed="${_sqName(seedTrack)}". Building window on next tick…`);
}

function _sqStop(reason) {
  if (!_sq) return;
  console.log(`[SmartQueue] ■ Session ${_sq.id} stopped (${reason})`);
  _sq = null;
}

// True only while `sid` is STILL the live session. Every async Smart Queue step
// re-checks this after each await: if the session was stopped or replaced while
// a network call was in flight, the stale continuation aborts instead of mutating
// whatever session happens to be current now. This is what guarantees exactly one
// live Smart Queue at a time.
function _sqAlive(sid) {
  return !!_sq && _sq.id === sid;
}

// Clear the playback queue on a MANUAL change (new song / playlist / mood / vibe).
// The Spotify Web API has no "clear queue" endpoint, so the only reliable,
// non-disruptive mechanism is the fresh `play()` the caller issues right after:
//   • a `uris` play (search / mood / vibe / right-now seed) replaces the queue
//     with exactly that list — anything we previously queued is dropped;
//   • a `context_uri` play (playlist / album) starts a brand-new context.
// This helper handles everything ELSE that must reset in lockstep: it stops any
// running Smart Queue session and wipes our internal staged-track accounting and
// auto-queue counter, so no stale picks from the previous selection linger in
// our bookkeeping or get re-queued. Call it on EVERY manual change, BEFORE the
// new play().
function _sqClearQueue(reason) {
  // This fires on every MANUAL change (new song / playlist / mood / vibe) right
  // before the replacing play(), so it's the one place to flag that the track
  // about to be interrupted should be exempt from skip/dislike scoring.
  _suppressEngageUntil = Date.now() + _SUPPRESS_ENGAGE_MS;
  _sqStop(reason);
  _setStaged([]);
  _autoQueueCount = 0;
}

// Start playback from a single seed track. Playing with a fresh `uris` array
// replaces the current context AND clears Spotify's user queue, so this is also
// how a new session wipes the previous window's leftovers. We do NOT touch
// repeat/shuffle. The engine then builds + enqueues the upcoming window itself.
async function _sqPlaySeedContext(seedUri) {
  if (!seedUri) return;
  await play({ uris: [seedUri] });
  _setStaged([seedUri]);
  console.log(`[SmartQueue] Seeded "${seedUri}" — queue cleared; engine will populate Up Next`);
}

// Play a single seed track and hand off to Smart Queue. Clears the queue first
// (stops any prior session + wipes staged accounting) so a manual change never
// leaves the previous selection's picks lingering in Up Next.
async function _sqStartFromSeed(source, seedUri, seedTrack, weave = true) {
  if (!seedUri) return;
  _sqClearQueue(`new-${source}`);
  await _sqPlaySeedContext(seedUri);
  _sqStart(source, seedTrack || { uri: seedUri, id: seedUri.split(':').pop() }, weave);
}

// Strict one-at-a-time feed: keep EXACTLY ONE unplayed pick sitting in Spotify's
// user queue. We add the whole queue ourselves, so this is also where dupes die —
// any upcoming slot whose track already entered the queue or played this session
// (it's in _sq.seen) is flagged a "late dupe", logged, and skipped without ever
// being added. Walking forward, the first already-added slot ahead means the one
// pending pick is in place (nothing to do); otherwise we add the first clean slot
// and stop. Keeping only one song queued is what makes a mood/vibe switch trivial
// to clear and spreads our API calls out to ~one addToQueue per track.
// Returns 1 if a track was newly queued, else 0.
async function _sqEnqueueUpcoming() {
  if (!_sq || _sq.pos < 0) return 0;
  const sid = _sq.id;
  for (let i = _sq.pos + 1; i < _sq.window.length; i++) {
    const slot = _sq.window[i];
    if (!slot || !slot.uri) continue;

    // An already-added slot ahead is our single pending pick (not a dupe — we put
    // it there). If it hasn't played yet, the queue is fed: stop. If it already
    // played, keep walking to find the next one to feed.
    if (slot.added) {
      if (!slot.played) return 0;
      continue;
    }

    // Late dupe: this track already entered the queue or played this session.
    // Flag + log it once and skip — never add it, and ignore it in calculations.
    if (slot.id && _sq.seen.has(slot.id)) {
      if (!slot.dupe) {
        slot.dupe = true;
        console.log(`[SmartQueue] ⊘ Dupe skipped — "${_sqName(slot.track)}" already queued/played this session`);
      }
      continue;
    }

    // Clean, not yet added → add exactly this one and stop (strict one-at-a-time).
    try {
      await addToQueue(slot.uri);
      // Session was replaced/stopped while the add was in flight — don't write
      // this pick's bookkeeping into whatever session is current now.
      if (!_sqAlive(sid)) return 0;
      slot.added = true;
      _addStaged([slot.uri]);
      if (slot.id) { _sq.seen.add(slot.id); _sq.noRepeat.add(slot.id); }
      if (slot.source === 'ours' && slot.id) _markPlayed(slot.id);
      console.log(`[SmartQueue] ➕ Queued next pick — [${slot.source === 'ours' ? 'OURS' : 'SPOTIFY'}] "${_sqName(slot.track)}"`);
      _scheduleQueueRefresh(); // push the freshly-extended Up Next to the queue panel
      return 1;
    } catch (err) {
      console.error(`[SmartQueue] addToQueue failed for ${_sqName(slot.track)}:`, err.message);
      return 0; // retry on the next tick (one song of runway covers the gap)
    }
  }
  return 0;
}

// Count the feedable slots ahead of the cursor — non-dupe, not-yet-played, and
// not user-queued — so the extend trigger measures the engine's OWN upcoming
// songs, ignoring skipped dupes and the user's manual queue adds.
function _sqUpcomingCount() {
  if (!_sq) return 0;
  let n = 0;
  for (let i = _sq.pos + 1; i < _sq.window.length; i++) {
    const s = _sq.window[i];
    if (s && !s.dupe && !s.played && !s.userQueued) n++;
  }
  return n;
}

// Mirror a track the user manually queued (search bar → "Queue") into the live
// window so the panel shows it, WITHOUT letting the engine act on it. It is
// flagged userQueued + added (the user already physically appended it via the
// queue endpoint), so _sqEnqueueUpcoming never re-adds it, _sqUpcomingCount
// ignores it, and the interleave/dedupe math never considers it. Its id still
// enters seen/noRepeat so the engine never re-picks it as one of ITS songs.
// No-op when there's no active Smart Queue session (the panel then renders the
// physical queue, which already includes the add).
function _sqRegisterUserQueued(meta = {}) {
  if (!_sq || !Array.isArray(_sq.window)) return;
  const uri = meta.uri || (meta.id ? `spotify:track:${meta.id}` : null);
  if (!uri) return;
  const id = meta.id || (uri.startsWith('spotify:track:') ? uri.split(':').pop() : null);
  if (id) { _sq.seen.add(id); _sq.noRepeat.add(id); }
  const track = {
    id, uri,
    title: meta.title || '',
    artist: meta.artist || '',
    albumArt: meta.albumArt || '',
    duration: meta.duration || null,
  };
  const slot = {
    uri, id, track,
    source: 'manual',
    added: true,        // user already physically queued it — engine must not re-add
    played: false,
    userQueued: true,
    reason: 'Queued by you',
    smoothMix: false,
  };
  // Insert right after the deepest already-queued slot so the in-memory order
  // mirrors the physical queue (current → our pending pick → user's song). If the
  // user stacks several adds, each lands after the previous — same as Spotify.
  let insertAt = _sq.pos + 1;
  for (let i = _sq.pos + 1; i < _sq.window.length; i++) {
    if (_sq.window[i] && _sq.window[i].added) insertAt = i + 1;
  }
  _sq.window.splice(insertAt, 0, slot);
  console.log(`[SmartQueue] ★ User-queued "${_sqName(track)}" → slot ${insertAt + 1} (engine ignores it)`);
}

// Debounced queue-panel refresh. Smart Queue enqueues happen AFTER the post-track-
// change emitQueue() fires, so without this the panel lags a track behind whenever
// we add to Up Next. Coalesces bursts (build + extend in one tick) into one emit.
let _queueRefreshTimer = null;
function _scheduleQueueRefresh(delay = 1200) {
  if (_queueRefreshTimer) clearTimeout(_queueRefreshTimer);
  _queueRefreshTimer = setTimeout(() => { _queueRefreshTimer = null; emitQueue(); }, delay);
}

// Build a fresh window from the current track and enqueue the whole upcoming run.
// Anchors come from Spotify's recommendation engine (raw discovery); our picks
// are woven into the roughest gaps (skipped entirely when weave is off).
async function _sqBuildAndEnqueueWindow(state, reason) {
  if (!_sq || _sq.building) return;
  const sid = _sq.id;
  _sq.building = true;
  try {
    const cur = state.track;
    const anchorN = _sqAnchorCount(); // Lookahead-derived window depth
    const anchors = (await _sqBuildSpotifyAnchors(anchorN)).slice(0, anchorN).map(_sqAnnotate);
    if (!_sqAlive(sid)) return; // session replaced mid-build → abandon
    const targetU = _sqTargetOurs(anchors.length || 1);
    let pool = [];
    if (targetU > 0) {
      const anchorIds = new Set(anchors.map(a => a.id));
      pool = (await _sqBuildOurCandidates(targetU + 6))
        .filter(t => t && t.id && !anchorIds.has(t.id))   // dedupe ours vs anchors
        .map(_sqAnnotate);
      if (!_sqAlive(sid)) return; // session replaced mid-build → abandon
    }
    const { slots, used } = _sqPlanInterleave(_sqAnnotate(cur), anchors, pool, targetU);
    _sq.window = _sqAssembleWindow(cur, slots);
    _sq.pos = 0;
    _sq.mode = 'active';
    _sq.lastTickTrackId = cur.uri;
    if (cur.id) { _sq.noRepeat.add(cur.id); _sq.seen.add(cur.id); }
    _sqTrimNoRepeat();
    console.log(`[SmartQueue] ✔ Window built — reason=${reason}, ${anchors.length} anchors, target ${targetU} ours (placed ${used}).`);
    _sqLogWindow('Window');
  } catch (err) {
    console.error('[SmartQueue] Window build failed:', err.message);
  } finally {
    if (_sqAlive(sid)) _sq.building = false; // never clear a different session's flag
  }
  if (!_sqAlive(sid)) return;
  await _sqEnqueueUpcoming(); // populate Up Next immediately
}

// Extend the window when few slots remain ahead of the current track: fetch a
// fresh batch of anchors (+ our picks) that bridges from the last slot, append
// them, and enqueue — so playback never runs dry.
async function _sqExtendWindow(state) {
  if (!_sq || _sq.building) return;
  const sid = _sq.id;
  _sq.building = true;
  try {
    // Bridge from the last REAL slot (skip trailing dupes) so flow math isn't
    // anchored to a track we never actually queue.
    let last = null;
    for (let i = _sq.window.length - 1; i >= 0; i--) {
      if (_sq.window[i] && !_sq.window[i].dupe) { last = _sq.window[i]; break; }
    }
    const bridgeLeft = _sqAnnotate(last?.track || state.track);
    const anchorN = _sqAnchorCount(); // Lookahead-derived window depth
    const anchors = (await _sqBuildSpotifyAnchors(anchorN)).slice(0, anchorN).map(_sqAnnotate);
    if (!_sqAlive(sid)) return; // session replaced mid-extend → abandon
    if (!anchors.length) { console.log('[SmartQueue] Extend: no fresh anchors available'); return; }
    const targetU = _sqTargetOurs(anchors.length || 1);
    let pool = [];
    if (targetU > 0) {
      const anchorIds = new Set(anchors.map(a => a.id));
      pool = (await _sqBuildOurCandidates(targetU + 6))
        .filter(t => t && t.id && !anchorIds.has(t.id))
        .map(_sqAnnotate);
      if (!_sqAlive(sid)) return; // session replaced mid-extend → abandon
    }
    const { slots, used } = _sqPlanInterleave(bridgeLeft, anchors, pool, targetU);
    // Decorate each new slot with its "why-picked" reason just like
    // _sqAssembleWindow does, so the queue panel keeps explaining picks as the
    // window extends (otherwise extended slots arrive reason-less and the
    // annotations gradually disappear from Up Next).
    const setCloser = _sqSetCloserActive();
    let lastOursIdx = -1;
    for (let i = 0; i < slots.length; i++) if (slots[i].source === 'ours') lastOursIdx = i;
    let left = bridgeLeft;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const uri = s.track.uri || (s.track.id ? `spotify:track:${s.track.id}` : null);
      if (!uri) continue;
      const ann = (s.track._cam !== undefined) ? s.track : _sqAnnotate(s.track);
      const { reason, smoothMix } = _sqReasonFor(ann, s.source, left, {
        setCloser: setCloser && i === lastOursIdx,
      });
      _sq.window.push({ uri, id: s.track.id, track: s.track, source: s.source, added: false, played: false, reason, smoothMix });
      if (s.source === 'ours' && s.track.id) _sq.noRepeat.add(s.track.id);
      left = ann;
    }
    _sqTrimNoRepeat();
    console.log(`[SmartQueue] ⤢ Extended window — +${slots.length} slots (${anchors.length} anchors, ${used} ours).`);
    _sqLogWindow('Extended window');
  } catch (err) {
    console.error('[SmartQueue] Extend failed:', err.message);
  } finally {
    if (_sqAlive(sid)) _sq.building = false; // never clear a different session's flag
  }
  if (!_sqAlive(sid)) return;
  await _sqEnqueueUpcoming();
  _sqTrimWindow();
}

// Keep the in-memory window bounded by dropping already-played slots well behind
// the cursor (Spotify owns the real queue; we only need a little history).
function _sqTrimWindow() {
  const KEEP_BEHIND = 10;
  if (!_sq || _sq.pos <= KEEP_BEHIND) return;
  const drop = _sq.pos - KEEP_BEHIND;
  _sq.window.splice(0, drop);
  _sq.pos -= drop;
}

// The per-poll driver. Builds the first window, advances the cursor, keeps Up
// Next enqueued, and extends the window as it nears the end. If the current
// track ever leaves the window (manual skip / new play), rebuilds from here.
async function _sqTick(state) {
  if (!_sq || _sq.building) return;
  if (!state?.isPlaying || !state.track?.uri) return;
  const sid = _sq.id;
  const curUri = state.track.uri;

  // First tick (or after a full rebuild cleared it): build the window now.
  if (!_sq.window.length) { await _sqBuildAndEnqueueWindow(state, 'initial'); return; }

  let pos = _sq.window.findIndex(s => s.uri === curUri);
  if (pos === -1) {
    // Current track diverged from our window (manual skip, new play). Rebuild
    // from here — a fresh play already cleared Spotify's queue.
    console.log(`[SmartQueue] Current "${_sqName(state.track)}" not in window → rebuilding`);
    await _sqBuildAndEnqueueWindow(state, 'diverged');
    return;
  }
  const prevPos = _sq.pos;
  _sq.pos = pos;
  for (let i = 0; i <= pos; i++) _sq.window[i].played = true;
  // Whatever is actually playing has now been "seen" — even a native-autoplay
  // interloper that slipped into a gap — so it's never re-queued or re-suggested.
  if (state.track.id) { _sq.seen.add(state.track.id); _sq.noRepeat.add(state.track.id); }

  const firstSeen = _sq.lastTickTrackId !== curUri; // debounce heavy work to once/track
  _sq.lastTickTrackId = curUri;

  // Song switched to a new slot in our window — log the move + the full queue so
  // the engine's progress is visible in the console on every track change.
  if (firstSeen && pos !== prevPos) {
    const slot = _sq.window[pos];
    const tag  = slot?.source === 'ours' ? 'OURS' : 'SPOTIFY';
    console.log(`[SmartQueue] ▶ Now playing slot ${pos + 1}/${_sq.window.length} [${tag}] "${_sqName(state.track)}"`);
    _sqLogWindow('Queue');
  }

  // Top up the single pending pick the instant the track changes (skips dupes).
  await _sqEnqueueUpcoming();
  if (!_sqAlive(sid)) return; // session changed during the enqueue → stop here

  // Extend before we run dry — measured in real (non-dupe) upcoming slots.
  const remaining = _sqUpcomingCount();
  if (firstSeen && remaining <= _sqExtendAhead()) {
    console.log(`[SmartQueue] ${remaining} slot(s) remain → extending window`);
    await _sqExtendWindow(state);
  }
}

// Pick the single highest-confidence seed track for a mood/vibe to seed the
// session's first play + recommendation anchors. Returns a track object (or null).
async function _sqPickMoodVibeSeed(source, key) {
  let pool = [];
  try {
    if (source === 'mood') pool = await buildMoodPlaylist(key, 12);
    else if (source === 'vibe') pool = await buildVibePlaylist(key, 12);
  } catch (err) {
    console.error('[SmartQueue] Seed pick failed:', err.message);
  }
  pool = (pool || []).filter(t => t && (t.uri || t.id));
  return pool.length ? pool[0] : null; // builders return best-fit first
}

// ---------------------------------------------------------------------------
// Queue broadcast helper
// ---------------------------------------------------------------------------

// Fetch the current queue from Spotify and broadcast it to all connected clients.
// Called automatically on track changes and after manual skip/play commands.
async function emitQueue() {
  if (!_io) return;
  try {
    const data = await getQueue();
    const rawQueue = (data && Array.isArray(data.queue)) ? data.queue : [];
    // Warm the meta cache from the full track objects Spotify gives us for free
    // here, so window-rendered rows (which carry no art) can still show thumbnails
    // + durations for any track we've physically seen this session.
    _sqRememberMeta(rawQueue);
    if (data && data.currently_playing) _sqRememberMeta([data.currently_playing]);

    let items;
    if (_sq && Array.isArray(_sq.window) && _sq.window.length) {
      // Active Smart Queue session → render the full in-memory plan (with reasons),
      // NOT the 1-deep physical queue. Mirror reasons into the durable cache too.
      _sqWindowAnnotations();
      items = _sqPanelItems();
    } else {
      // No session → show the real Spotify queue. Spotify repeats the current
      // track in "Up Next" when there's no real queue/context, so collapse
      // consecutive duplicate URIs into a single row.
      const ann = _sqWindowAnnotations();
      const dedupQueue = [];
      for (const t of rawQueue) {
        const prev = dedupQueue[dedupQueue.length - 1];
        if (prev && prev.uri && t.uri && prev.uri === t.uri) continue;
        dedupQueue.push(t);
      }
      items = dedupQueue.slice(0, 30).map((t) => {
        const a = _sqAnnotationFor(ann, t);
        return {
          id: t.id,
          uri: t.uri,
          title: t.name,
          artist: t.artists ? t.artists.map((x) => x.name).join(', ') : '',
          albumArt:
            t.album && t.album.images && t.album.images.length > 0
              ? t.album.images[0].url
              : null,
          duration: t.duration_ms,
          // Smart Queue "why-picked" decoration (absent for non-SQ items).
          source: a ? a.source : undefined,
          reason: a ? a.reason : undefined,
          smoothMix: a ? a.smoothMix : undefined,
        };
      });
    }
    _io.emit('spotify:queue', { items, meta: _sqInsightStrip() });
  } catch (err) {
    console.error('[Spotify] Auto queue emit error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Audio features serialization
// ---------------------------------------------------------------------------

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function _serializeFeatures(f) {
  if (!f) return null;
  return {
    trackId: f.id,
    bpm: Math.round(f.tempo || 0),
    key: f.key != null && f.key >= 0 ? PITCH_CLASSES[f.key] : null,
    mode: f.mode === 1 ? 'Maj' : f.mode === 0 ? 'Min' : null,
    energy: f.energy != null ? Math.round(f.energy * 100) : null,
    danceability: f.danceability != null ? Math.round(f.danceability * 100) : null,
    valence: f.valence != null ? Math.round(f.valence * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Vibe engine
// ---------------------------------------------------------------------------

const VIBE_DEFAULTS = {
  hype:        'Hype',
  intense:     'Intense',
  drive:       'Drive',
  good_vibes:  'Good Vibes',
  flow:        'Flow',
  grind:       'Grind',
  chill:       'Chill',
  ease:        'Ease',
  melancholy:  'Melancholy',
  t_morning:   'Morning',
  t_midday:    'Midday',
  t_afternoon: 'Afternoon',
  t_evening:   'Evening',
  t_night:     'Night',
  t_latenight: 'Late Night',
};

function getVibeKey(e) {
  if (e.energy == null || e.valence == null) {
    // No audio features — only fall back to time-of-day for entries we logged ourselves.
    // Seeded entries (from Spotify API) must not use timestamp data for vibe assignment.
    if (e.h == null || e.seeded) return null;
    const h = e.h;
    if (h >= 6  && h < 10) return 't_morning';
    if (h >= 10 && h < 14) return 't_midday';
    if (h >= 14 && h < 18) return 't_afternoon';
    if (h >= 18 && h < 22) return 't_evening';
    if (h >= 22 || h < 2)  return 't_night';
    return 't_latenight';
  }
  const en = e.energy, va = e.valence;
  if (en >= 70 && va >= 60) return 'hype';
  if (en >= 70 && va < 40)  return 'intense';
  if (en >= 70)              return 'drive';
  if (en >= 40 && va >= 60) return 'good_vibes';
  if (en >= 40 && va < 40)  return 'grind';
  if (en >= 40)              return 'flow';
  if (va >= 60)              return 'chill';
  if (va < 40)               return 'melancholy';
  return 'ease';
}

function getVibeName(key) {
  return _vibeNames[key] || VIBE_DEFAULTS[key] || key;
}

// ---------------------------------------------------------------------------
// Camelot wheel — harmonic key compatibility
// ---------------------------------------------------------------------------

// Maps "PitchClass:Mode" → Camelot code (e.g. 'C:Maj' → '8B')
const CAMELOT = {
  'C:Maj':  '8B',  'A:Min':  '8A',
  'G:Maj':  '9B',  'E:Min':  '9A',
  'D:Maj':  '10B', 'B:Min':  '10A',
  'A:Maj':  '11B', 'F♯:Min': '11A',
  'E:Maj':  '12B', 'C♯:Min': '12A',
  'B:Maj':  '1B',  'G♯:Min': '1A',
  'F♯:Maj': '2B',  'D♯:Min': '2A',
  'C♯:Maj': '3B',  'A♯:Min': '3A',
  'G♯:Maj': '4B',  'F:Min':  '4A',
  'D♯:Maj': '5B',  'C:Min':  '5A',
  'A♯:Maj': '6B',  'G:Min':  '6A',
  'F:Maj':  '7B',  'D:Min':  '7A',
};

function _camelotPos(key, mode) {
  if (!key || !mode) return null;
  const code = CAMELOT[`${key}:${mode}`];
  if (!code) return null;
  return { num: parseInt(code.slice(0, -1), 10), letter: code.slice(-1), code };
}

function _camelotScore(posA, posB) {
  if (!posA || !posB) return 0.3;
  if (posA.code === posB.code) return 1.0;
  if (posA.num === posB.num) return 0.8;  // parallel major/minor
  const diff = Math.abs(posA.num - posB.num);
  const wrap = Math.min(diff, 12 - diff);
  if (wrap === 1) return 0.8;
  if (wrap === 2) return 0.4;
  return 0.0;
}

function _bpmScore(bpmA, bpmB) {
  if (!bpmA || !bpmB) return 0.5;
  const r = bpmA / bpmB;
  if (Math.abs(r - 1) < 0.06) return 1.0;
  if (Math.abs(r - 1) < 0.12) return 0.7;
  if (Math.abs(r * 2 - 1) < 0.06 || Math.abs(r / 2 - 1) < 0.06) return 0.5;
  return Math.max(0, 1 - Math.abs(1 - r));
}

function _energyScore(eA, eB) {
  if (eA == null || eB == null) return 0.5;
  return 1 - Math.abs(eA - eB) / 100;
}

function _trackFlowScore(a, b) {
  // Harmonic/BPM/energy smoothness, then nudged by what we've learned actually
  // survives in sequence (Feature 6). The transition term can only shift the
  // base score by ±TRANSITION_WEIGHT, so learning refines but never overrides
  // harmonic mixing.
  const base = _camelotScore(a._cam, b._cam) * 0.35 +
               _bpmScore(a.bpm, b.bpm)        * 0.35 +
               _energyScore(a.energy, b.energy) * 0.30;
  return base + _transitionBias(a, b) * TRANSITION_WEIGHT;
}

// Greedy nearest-neighbour ordering for harmonic, BPM-smooth, energy-smooth playlists.
// Input: array of history entries or Spotify track objects (must have .key, .mode, .bpm, .energy)
function flowOrder(tracks) {
  if (tracks.length <= 2) return tracks;
  const ann = tracks.map(t => ({ ...t, _cam: _camelotPos(t.key, t.mode) }));
  const remaining = [...ann];
  const startIdx = Math.floor(Math.random() * remaining.length);
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let best = 0, bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const s = _trackFlowScore(last, remaining[i]);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    ordered.push(remaining.splice(best, 1)[0]);
  }
  return ordered.map(({ _cam, ...t }) => t);
}

// Greedy reorder so consecutive tracks don't share a primary artist when it can
// be avoided. Preserves the incoming order as much as possible — it only defers
// a track when placing it next would clump it against the previous artist. This
// runs as the final pass (after flow ordering) so it nudges same-artist runs
// apart without otherwise disturbing the sequence.
function _spaceArtists(tracks) {
  if (!tracks || tracks.length <= 2) return tracks || [];
  const artistOf = (t) => (t.artistIds && t.artistIds[0]) || (t.artist || '').toLowerCase();
  const remaining = [...tracks];
  const out = [];
  let lastArtist = null;
  while (remaining.length) {
    let idx = remaining.findIndex((t) => artistOf(t) !== lastArtist);
    if (idx === -1) idx = 0; // every track left is the same artist — unavoidable
    const [picked] = remaining.splice(idx, 1);
    out.push(picked);
    lastArtist = artistOf(picked);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feelings & moods
//
// There is one mood profile per feeling. The feeling is the human-friendly answer
// to the "how are you feeling?" check-in; the mood is the playlist profile it drives.
// Each mood references its feeling (mood.feeling) and is filtered by that feeling's
// energy/valence range, so the two are always in sync.
// ---------------------------------------------------------------------------

const FEELING_DEFS = {
  sad:       { emoji: '😔', label: 'Sad',       energy: [0,  45],  valence: [0,  38] },
  chill:     { emoji: '🧘', label: 'Chill',     energy: [15, 58],  valence: [35, 72] },
  focused:   { emoji: '🎯', label: 'Focused',   energy: [28, 65],  valence: [22, 62] },
  happy:     { emoji: '😊', label: 'Happy',     energy: [32, 72],  valence: [55, 100] },
  energetic: { emoji: '⚡', label: 'Energetic', energy: [60, 100], valence: [22, 78] },
  hype:      { emoji: '🔥', label: 'Hype',      energy: [70, 100], valence: [55, 100] },
  angsty:    { emoji: '😤', label: 'Angsty',    energy: [55, 100], valence: [0,  42] },
};

const MOOD_STATES = [
  {
    key: 'in_my_feelings', name: 'In My Feelings', emoji: '🥀',
    desc: 'For when you\'re feeling sad', feeling: 'sad',
    contextSignals: { hours: [0,1,2,3,23] },
  },
  {
    key: 'cruise', name: 'Cruise', emoji: '🧘',
    desc: 'For when you\'re feeling chill', feeling: 'chill',
    contextSignals: { hours: [21,22,23] },
  },
  {
    key: 'lock_in', name: 'Lock In', emoji: '🎯',
    desc: 'For when you\'re feeling focused', feeling: 'focused',
    contextSignals: { hours: [9,10,11,12,13,14,15,16] },
  },
  {
    key: 'sunshine', name: 'Sunshine', emoji: '😊',
    desc: 'For when you\'re feeling happy', feeling: 'happy',
    contextSignals: { hours: [7,8,9,10] },
  },
  {
    key: 'charged_up', name: 'Charged Up', emoji: '⚡',
    desc: 'For when you\'re feeling energetic', feeling: 'energetic',
    contextSignals: { hours: [6,7,8,17,18,19] },
  },
  {
    key: 'full_send', name: 'Full Send', emoji: '🔥',
    desc: 'For when you\'re feeling hype', feeling: 'hype',
    contextSignals: { hours: [20,21,22,23], dow: [4,5,6] },
  },
  {
    key: 'going_hard', name: 'Going Hard', emoji: '😤',
    desc: 'For when you\'re feeling angsty', feeling: 'angsty',
    contextSignals: { hours: [17,18,19] },
  },
];

// The single mood profile that corresponds to a given feeling.
function moodForFeeling(feelingKey) {
  return MOOD_STATES.find(m => m.feeling === feelingKey) || null;
}

// ---------------------------------------------------------------------------
// Vibe gating
//
// Discovery candidates (curated playlists, genre search, artist deep cuts) are
// sourced by ARTIST or GENRE, never by audio profile — so a melancholy session
// seeded by a versatile artist could pull in that artist's upbeat hip-hop. These
// gates keep the discovery stream inside the chosen mood/vibe's actual sound.
//
// The Variety slider sets the TOLERANCE, not a quota. "Stay on taste" passes only
// tracks squarely inside the feeling's energy/valence window; sliding toward
// "Adventurous" widens that window so songs may stray a little further and still
// qualify. It never forces a percentage of off-vibe songs into the queue — it only
// relaxes how far a track may drift before it's rejected as contradictory.
// ---------------------------------------------------------------------------

// Energy/valence acceptance window for a feeling, widened by the Variety tolerance.
function _feelingBand(def) {
  const pad = _tMoodPad(); // moodFlow gates Variety's widening (lock tightens, flow widens)
  // Clamp to 0–100 and guard against a negative pad inverting a narrow band.
  const eMin = _clampNum(def.energy[0]  - pad, 0, 100), eMax = _clampNum(def.energy[1]  + pad, 0, 100);
  const vMin = _clampNum(def.valence[0] - pad, 0, 100), vMax = _clampNum(def.valence[1] + pad, 0, 100);
  return {
    eMin: Math.min(eMin, eMax), eMax: Math.max(eMin, eMax),
    vMin: Math.min(vMin, vMax), vMax: Math.max(vMin, vMax),
  };
}

// Resolve a track's audio features from the candidate itself or any cache.
function _trackFeatures(track) {
  if (track && track.energy != null) return track;
  return (track && track.id) ? _findStoredFeatures(track.id) : null;
}

// Verdict against a feeling band:
//   true  — features known and inside the band  (on-vibe, keep)
//   false — features known and outside the band  (off-vibe, reject)
//   null  — features unknown                      (can't judge yet)
function _bandVerdict(track, band) {
  const f = _trackFeatures(track);
  if (!f || f.energy == null || f.valence == null) return null;
  return f.energy  >= band.eMin && f.energy  <= band.eMax &&
         f.valence >= band.vMin && f.valence <= band.vMax;
}

// Verdict against a vibe cluster: inside a tolerance radius of its centroid.
function _centroidVerdict(track, centroid, maxDist) {
  const f = _trackFeatures(track);
  if (!f || f.energy == null || f.valence == null) return null;
  return _clusterDist(centroid, f) <= maxDist;
}

// Tolerance radius for a vibe cluster: the cluster's own spread (85th-percentile
// distance to the centroid) plus a Variety-scaled allowance.
function _vibeRadius(tracks, centroid) {
  const dists = (tracks || [])
    .map(t => _trackFeatures(t)).filter(Boolean)
    .map(f => _clusterDist(centroid, f)).sort((a, b) => a - b);
  const spread = dists.length ? dists[Math.floor(dists.length * 0.85)] : 0.18;
  return spread + _lerp(0.04, 0.30, _tVariety());
}

// Build the verdict fn for one vibe key (or null if the vibe has no data yet).
function _vibeGateFor(vibeKey) {
  const vibes = computeVibes();
  if (!vibes.ready) return null;
  const cluster = vibes.clusters.find(c => c.key === vibeKey);
  if (!cluster || !cluster.tracks || !cluster.tracks.length) return null;
  const centroid = _computeCentroid(cluster.tracks);
  if (!centroid) return null;
  const radius = _vibeRadius(cluster.tracks, centroid);
  return (t) => _centroidVerdict(t, centroid, radius);
}

// The verdict fn for whatever continuous target is running right now, or null when
// nothing is active. Used as the refill's final safety net.
function _activeVibeVerdict() {
  // A running mix is the primary continuous target now — gate to its energy×valence point.
  if (_activeMixTarget) {
    const centroid = { energy: _activeMixTarget.energy, valence: _activeMixTarget.valence, bpm: null };
    const radius = (_activeMixTarget.spread != null ? _activeMixTarget.spread : 0.15) + _lerp(0.04, 0.30, _tVariety());
    return (t) => _centroidVerdict(t, centroid, radius);
  }
  let feelingKey = null;
  if (_activeFeeling) feelingKey = _activeFeeling.key;
  else if (_activeMoodKey) { const m = MOOD_STATES.find(x => x.key === _activeMoodKey); feelingKey = m && m.feeling; }
  if (feelingKey && FEELING_DEFS[feelingKey]) {
    const band = _feelingBand(FEELING_DEFS[feelingKey]);
    return (t) => _bandVerdict(t, band);
  }
  if (_activeVibeKey) return _vibeGateFor(_activeVibeKey);
  return null;
}

// Warm features (bounded) for candidates we can't yet judge, then split into
// on-vibe and unknown buckets — dropping anything known to be off-vibe. On-vibe
// tracks come first; unknowns (genuinely new, unjudgeable) only fill the remainder
// so a thin pool never starves the queue, while proven-contradictory tracks are
// gone for good.
async function _gateDiscovery(tracks, verdict, limit) {
  const list = (tracks || []).filter(t => t && t.id);
  if (!list.length || !verdict) return list.slice(0, limit);

  const toWarm = [];
  for (const t of list) {
    if (t.energy != null) continue;
    if (_findStoredFeatures(t.id)) continue;
    toWarm.push(t.id);
  }
  if (toWarm.length) { try { await getBatchAudioFeatures(toWarm.slice(0, 24)); } catch { /* warm best-effort */ } }

  const onVibe = [], unknown = [];
  for (const t of list) {
    const v = verdict(t);
    if (v === true) onVibe.push(t);
    else if (v === null) unknown.push(t);
    // v === false → known off-vibe, dropped
  }
  const out = onVibe.slice(0, limit);
  // Unjudgeable (features-unknown) tracks are a gamble — they MIGHT be off-mood.
  // moodFlow gates how many we allow as filler: locked → few (stay pure, accept a
  // shorter batch), flow → fill freely so we never starve.
  let unknownBudget = Math.round((limit - out.length) * _lerp(0.2, 1, _tMoodFlow()));
  for (const t of unknown) {
    if (out.length >= limit || unknownBudget <= 0) break;
    out.push(t);
    unknownBudget--;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Playlist builders
// ---------------------------------------------------------------------------

// A human label for a mix target: its saved name (a named cluster) or the energy×
// valence quadrant's vibe name, so a freeform pad point still reads as e.g. "Hype".
function _mixTargetLabel(target) {
  if (!target) return 'Mix';
  // target.label is the MOOD portion only; genre (if any) is appended here so the
  // composed label never gets double-stamped when it's recomputed.
  const moodLabel = target.label || getVibeName(getVibeKey({ energy: target.energy, valence: target.valence }));
  const g = (target.genre && target.genre !== 'any') ? (GENRE_BUCKET_BY_KEY[target.genre]?.name || null) : null;
  return g ? `${moodLabel} · ${g}` : moodLabel;
}

// Compact running-mix descriptor for the client (footer / continuous badge).
function _activeMixState() {
  if (!_activeMixTarget) return null;
  return {
    label:   _mixTargetLabel(_activeMixTarget),
    energy:  Math.round(_activeMixTarget.energy),
    valence: Math.round(_activeMixTarget.valence),
    vibeKey: _activeMixTarget.vibeKey || null,
    genre:   _activeMixTarget.genre || null,
    auto:    !!_activeMixTarget.auto,
  };
}

// Auto-vibe steering. As the live listening cluster firms up (the same signal
// behind the Now Playing confidence bar), lock a Mix target onto its centroid so
// the smart queue leans into the detected vibe — WITHOUT rebuilding the queue.
// We only flip the existing session's source to 'mix' and point _activeMixTarget
// at the centroid; the already-queued slots play out untouched and only future
// window EXTENDS are steered. Re-steers when the vibe genuinely moves; never
// overrides an explicit user choice (mood / vibe / feeling / hand-picked mix).
const AUTO_VIBE_MIN_TRACKS = 5;   // cluster agreement before first auto-lock
const AUTO_VIBE_RESTEER     = 0.18; // centroid move (0–1) needed to re-point
function _maybeAutoSteerVibe() {
  if (!_sq) return;                                              // no queue to steer
  if (_activeMoodKey || _activeVibeKey || _activeFeeling) return; // user chose explicitly
  if (_activeMixTarget && !_activeMixTarget.auto) return;         // hand-picked mix wins
  // Only steer the everyday autoplay paths (search / playlist), or an already
  // auto-steered mix — never an explicit 'mood'/'vibe'/'mix'/'rightnow' session.
  const steerable = _sq.source === 'search' || _sq.source === 'playlist' ||
                    (_sq.source === 'mix' && _activeMixTarget && _activeMixTarget.auto);
  if (!steerable) return;
  if (!_currentCentroid || _currentCluster.length < AUTO_VIBE_MIN_TRACKS) return;

  const c = _currentCentroid;
  if (_activeMixTarget && _activeMixTarget.auto) {
    const moved = _clusterDist(
      { energy: _activeMixTarget.energy, valence: _activeMixTarget.valence, bpm: null },
      { energy: c.energy, valence: c.valence, bpm: null });
    if (moved < AUTO_VIBE_RESTEER) {
      // Same vibe — keep the centroid fresh but don't churn/emit.
      _activeMixTarget.energy = c.energy;
      _activeMixTarget.valence = c.valence;
      return;
    }
  }

  const target = {
    energy: c.energy, valence: c.valence, spread: 0.15,
    vibeKey: getVibeKey({ energy: c.energy, valence: c.valence }),
    auto: true,
  };
  target.label = _mixTargetLabel(target);
  const was = _activeMixTarget && _activeMixTarget.auto ? _activeMixTarget.label : null;
  _activeMixTarget = target;
  _sq.source = 'mix';   // steer future EXTENDS toward the vibe — no rebuild
  console.log(`[SmartQueue] ◎ Auto-vibe ${was ? `re-steered ${was} →` : 'locked'} "${target.label}" (energy=${Math.round(c.energy)} valence=${Math.round(c.valence)}) — steering existing queue`);
  if (_io) _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null, activeMix: _activeMixState() });
}

// ── Unified mix builder ───────────────────────────────────────────────────────
// The single engine behind the "mood map". A target is a point in energy×valence
// space (0–100 each) plus a tolerance `spread`; this pulls your library/history
// tracks within that radius, gates discovery to the same region, and runs the SAME
// taste-bias → flow → artist-spacing tail as the vibe/feeling builders. A curated
// mood is just a labelled point and a discovered vibe is just a point found in your
// history — both now resolve to this one builder.
async function buildMixFromTarget(target, limit = 20) {
  if (!target || target.energy == null || target.valence == null) return [];
  const centroid = { energy: target.energy, valence: target.valence, bpm: null };
  // Base spread (how wide a net around the point) widened by the Variety tuning,
  // mirroring _vibeRadius so the pad behaves like the discovered clusters.
  const radius = (target.spread != null ? target.spread : 0.15) + _lerp(0.04, 0.30, _tVariety());
  const verdict = (t) => _centroidVerdict(t, centroid, radius);

  // Optional genre filter: only keep tracks whose artist falls in the bucket.
  const genreKey = target.genre && target.genre !== 'any' ? target.genre : null;
  const seedGenres = genreKey ? (GENRE_BUCKET_BY_KEY[genreKey]?.seeds || null) : null;

  // Library/history tracks inside the target radius, not already heard this session.
  const seen = new Set();
  const pool = [];
  for (const e of combinedHistory()) {
    if (e.energy == null || e.valence == null) continue;
    if (seen.has(e.id)) continue;
    if (_sessionTrackIds.has(e.id)) continue;
    if (_clusterDist(centroid, e) > radius) continue;
    if (genreKey && !_trackMatchesGenre(e, genreKey)) continue;
    seen.add(e.id);
    pool.push(e);
  }

  let discoveryCount = Math.min(Math.ceil(limit * _tDiscoveryRatio()), 10);
  // Lean into discovery when the genre-filtered library is thin: if we own fewer
  // on-genre/on-target tracks than the batch needs, make up the deficit with fresh
  // in-genre finds (uncapped beyond the usual 10) so a sparse genre still fills.
  if (genreKey && pool.length < limit) {
    discoveryCount = Math.min(limit, Math.max(discoveryCount, limit - pool.length));
  }
  const baseCount = Math.max(1, limit - discoveryCount);

  // Shuffle within the on-target pool, then taste-bias so loved artists surface when
  // the pool is truncated (identical to the vibe/feeling builders).
  const base = _applyTasteBias([...pool].sort(() => Math.random() - 0.5)).slice(0, baseCount);

  const seedSource = base.length ? base : pool;
  const seedIds = [...seedSource].sort(() => Math.random() - 0.5).slice(0, 3).map(t => t.id).filter(Boolean);
  const seedArtists = seedSource.map(t => t.artist).filter(Boolean);
  const discovery = await _buildDiscovery(seedIds, seedArtists, discoveryCount, verdict, seedGenres);

  let all = _excludeDisliked(_excludePlayed([...base, ...discovery]));
  // A valid target with real nearby history should never come back empty.
  if (!all.length && pool.length) all = _excludeDisliked([...pool]);
  return _spaceArtists(_tFlowOn() ? flowOrder(all) : all);
}

async function buildVibePlaylist(vibeKey, limit = 25) {
  const vibes = computeVibes();
  if (!vibes.ready) return [];
  const cluster = vibes.clusters.find(c => c.key === vibeKey);
  if (!cluster) return [];

  // Skip anything already played/queued this session so the vibe never loops
  const pool = _excludePlayed([...cluster.tracks]);
  const discoveryCount = Math.min(Math.ceil(limit * _tDiscoveryRatio()), 10);
  const baseCount = Math.max(1, limit - discoveryCount);

  // Gate discovery to this vibe's sound: within a Variety-scaled radius of the
  // cluster centroid. Keeps genre/artist-sourced finds from straying off-vibe.
  const centroid = _computeCentroid(cluster.tracks);
  const vibeVerdict = centroid
    ? (t) => _centroidVerdict(t, centroid, _vibeRadius(cluster.tracks, centroid))
    : null;

  // Taste-bias the shuffle so durably-loved artists are favoured when the pool is
  // truncated, while keeping randomness among equally-scored tracks.
  const base = _applyTasteBias([...pool].sort(() => Math.random() - 0.5)).slice(0, baseCount);

  // Seed discovery from the FULL cluster, not just the unplayed `base`. Otherwise an
  // actively-playing vibe (all its tracks already in _sessionTrackIds) yields no seeds,
  // discovery comes back empty, and the vibe falsely reports "not enough data".
  const seedSource = base.length ? base : cluster.tracks;
  const seedIds = [...seedSource].sort(() => Math.random() - 0.5)
    .slice(0, 3).map(t => t.id).filter(Boolean);
  const seedArtists = seedSource.map(t => t.artist).filter(Boolean);
  const discovery = await _buildDiscovery(seedIds, seedArtists, discoveryCount, vibeVerdict);

  let all = _excludeDisliked(_excludePlayed([...base, ...discovery]));
  // Last resort: a vibe with real history should never come back empty. If session
  // exclusion stripped everything and discovery found nothing, replay the cluster.
  if (!all.length) all = _excludeDisliked([...cluster.tracks]);
  return _spaceArtists(_tFlowOn() ? flowOrder(all) : all);
}

async function buildMoodPlaylist(moodKey, limit = 25) {
  const mood = MOOD_STATES.find(m => m.key === moodKey);
  if (!mood) return [];

  // Each mood maps 1:1 to a feeling — build through the same feeling engine so the
  // Mood tab and the check-in produce consistent results. If a check-in confirmed
  // this same feeling, pass its session cluster so the result is centred on it.
  const sessionTracks = (_activeFeeling && _activeFeeling.key === mood.feeling)
    ? (_activeFeeling.clusterTracks || []) : [];
  return buildFeelingPlaylist(mood.feeling, sessionTracks, limit);
}

async function buildFeelingPlaylist(feelingKey, sessionTracks = [], limit = 20) {
  const def = FEELING_DEFS[feelingKey];
  if (!def) return [];

  // The feeling's energy/valence window, widened by the Variety tolerance. Used to
  // filter the library pool AND to gate artist/genre-sourced discovery so it can't
  // contradict the mood.
  const band = _feelingBand(def);
  const all = combinedHistory();

  // Tracks that match the feeling's audio-feature ranges, excluding session tracks already heard
  const sessionIds = new Set(sessionTracks.map(t => t.id).filter(Boolean));
  const seen = new Set(sessionIds);
  const pool = [];
  for (const e of all) {
    if (seen.has(e.id)) continue;
    if (_sessionTrackIds.has(e.id)) continue; // already played/queued this session
    if (e.energy == null) continue;
    if (e.energy  < band.eMin || e.energy  > band.eMax) continue;
    if (e.valence < band.vMin || e.valence > band.vMax) continue;
    seen.add(e.id);
    pool.push(e);
  }

  // Sort pool by closeness to session centroid
  const sessionCentroid = sessionTracks.length ? _computeCentroid(sessionTracks) : null;
  if (sessionCentroid) {
    pool.sort((a, b) => _clusterDist(sessionCentroid, a) - _clusterDist(sessionCentroid, b));
  } else {
    // No centroid to steer by — order by durable artist taste, breaking ties randomly,
    // so loved artists surface first while everything else stays shuffled.
    pool.sort((a, b) => (_artistBoost(b.artist) - _artistBoost(a.artist)) || (Math.random() - 0.5));
  }

  const discoveryCount = Math.min(Math.ceil(limit * _tDiscoveryRatio()), 10);
  const baseCount = Math.max(1, limit - discoveryCount);

  // Include a few recent session tracks (confirmed to match) that haven't been queued yet
  const sessionSample = _excludePlayed([...sessionTracks].sort(() => Math.random() - 0.5)).slice(0, 3);
  const base = pool.slice(0, baseCount);

  // Discovery flows from what the user is engaging with (session sample first), then
  // the best feeling-band matches.
  const seedIds = [...sessionSample, ...base].map(t => t.id).filter(Boolean).slice(0, 3);
  const seedArtists = [...sessionSample, ...base].map(t => t.artist).filter(Boolean);
  const discovery = await _buildDiscovery(seedIds, seedArtists, discoveryCount,
                                          (t) => _bandVerdict(t, band));

  // Final guard: nothing already played/queued, and nothing by a hard-skipped artist
  const combined = _excludeDisliked(_excludePlayed([...sessionSample, ...base, ...discovery]));
  return _spaceArtists(_tFlowOn() ? flowOrder(combined) : combined.sort(() => Math.random() - 0.5));
}

// Assemble a discovery set that prioritises genuinely NEW music. Spotify's own
// curated playlists (borrowed collaborative filtering) come first, then fresh
// search finds; anything the user already knows is only last-resort filler so
// the queue never starves.
// `verdict` (optional) gates every candidate against the active mood/vibe's audio
// profile — see _gateDiscovery. Off-vibe tracks are dropped so artist/genre-sourced
// discovery can't contradict the chosen sound.
async function _buildDiscovery(seedIds, seedArtists, count, verdict = null, seedGenres = null) {
  if (count <= 0) return [];
  const known = _knownTrackIdSet();
  const excludeIds = new Set([...known, ..._sessionTrackIds]);
  // When a genre filter is active, source fresh tracks FROM that genre (genre
  // search / "{Genre} Mix") rather than your overall top genres — so a sparse
  // genre still fills with genuinely in-genre discoveries.
  const topGenres = (seedGenres && seedGenres.length) ? seedGenres : await _getTopGenres();

  // Over-fetch each source so there's slack to gate against the vibe and still fill.
  const fetch = verdict ? (count * 2 + 4) : (count + 4);
  const [curated, similar, fresh] = await Promise.all([
    getCuratedTracks(seedArtists, topGenres, excludeIds, fetch).catch(() => []),
    getSimilarTracks(seedIds, [], fetch + 1).catch(() => []),
    getDiscoveryTracks(seedArtists, excludeIds, fetch).catch(() => []),
  ]);

  // Curated (Spotify CF) first — strongest cross-user signal — then fresh search
  // finds, then unfamiliar similar. Keep only genuinely new (unknown) tracks.
  const newCurated = _excludePlayed(curated).filter(t => t.id && !known.has(t.id));
  const newSimilar = _excludePlayed(similar).filter(t => t.id && !known.has(t.id));
  let pool = _excludeDisliked([...newCurated, ...fresh, ...newSimilar]);
  // De-dupe by id, preserving the priority order above.
  const seenIds = new Set();
  pool = pool.filter(t => t.id && !seenIds.has(t.id) && seenIds.add(t.id));

  // Gate the deduped pool against the vibe (drops off-vibe, prefers on-vibe), then
  // cap to count. Without a verdict this is just the slice as before.
  let discovery = await _gateDiscovery(pool, verdict, count);

  // Top up with known-but-unplayed similar so a batch is never short — gated too.
  if (discovery.length < count) {
    const have = new Set(discovery.map(t => t.id));
    const filler = _excludeDisliked(_excludePlayed(similar)).filter(t => !have.has(t.id));
    const gatedFiller = await _gateDiscovery(filler, verdict, count - discovery.length);
    discovery = [...discovery, ...gatedFiller].slice(0, count);
  }
  return discovery;
}

// ---------------------------------------------------------------------------
// Context detection & mood suggestion
// ---------------------------------------------------------------------------

// Map an hour-of-day to a named slot. Shared by detectCurrentContext and the
// per-context profile builder so the buckets always line up.
function _timeSlotFor(h) {
  if      (h >= 0  && h < 4)  return 'latenight';
  else if (h >= 4  && h < 8)  return 'earlyam';
  else if (h >= 8  && h < 11) return 'morning';
  else if (h >= 11 && h < 14) return 'midday';
  else if (h >= 14 && h < 18) return 'afternoon';
  else if (h >= 18 && h < 21) return 'evening';
  return 'night';
}

const SLOT_LABELS = {
  latenight: 'late nights', earlyam: 'early mornings', morning: 'mornings',
  midday: 'middays', afternoon: 'afternoons', evening: 'evenings', night: 'nights',
};

// ── Context-aware auto-profiles ──────────────────────────────────────────────
// The history is timestamped (hour + day-of-week), so we can learn what each
// time-of-day actually sounds like — "weekday mornings = chill", "Friday nights
// = hype" — and lean recommendations toward the current slot when nothing is
// explicitly chosen. Profiles are bucketed by (weekday|weekend)+slot, with a
// slot-only fallback for thin data, and cached briefly since history grows slowly.
const CONTEXT_PROFILE_TTL = 10 * 60 * 1000;
const CONTEXT_MIN_SAMPLES = 6; // need a few plays before a slot has a real signal
let _contextProfiles   = null;
let _contextProfilesAt = 0;

function _computeContextProfiles() {
  if (_contextProfiles && Date.now() - _contextProfilesAt < CONTEXT_PROFILE_TTL) return _contextProfiles;
  const buckets = new Map(); // key → { entries:[], artists:Map }
  const add = (key, e) => {
    let b = buckets.get(key);
    if (!b) { b = { entries: [], artists: new Map() }; buckets.set(key, b); }
    b.entries.push(e);
    if (e.artist) b.artists.set(e.artist, (b.artists.get(e.artist) || 0) + 1);
  };
  // Only real listening history carries trustworthy timestamps + features.
  for (const e of _history) {
    if (e.h == null || e.energy == null) continue;
    const weekend = (e.dow === 0 || e.dow === 6);
    const slot = _timeSlotFor(e.h);
    add(`${weekend ? 'weekend' : 'weekday'}:${slot}`, e); // composite (preferred)
    add(`slot:${slot}`, e);                                // slot-only fallback
  }
  const profiles = {};
  for (const [key, b] of buckets) {
    if (b.entries.length < CONTEXT_MIN_SAMPLES) continue;
    const centroid = _computeCentroid(b.entries);
    if (!centroid) continue;
    const topArtists = [...b.artists.entries()]
      .sort((a, c) => c[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
    profiles[key] = { centroid, count: b.entries.length, topArtists };
  }
  _contextProfiles = profiles;
  _contextProfilesAt = Date.now();
  return profiles;
}

// The composite context key for "right now" (weekday/weekend + time slot).
function _currentSlotKey() {
  const now = new Date();
  const weekend = (now.getDay() === 0 || now.getDay() === 6);
  return `${weekend ? 'weekend' : 'weekday'}:${_timeSlotFor(now.getHours())}`;
}

// Learn from skips that never reach the history centroid: a strong skip pushes the
// current slot's centroid AWAY from what didn't fit; an engaged listen relaxes the
// nudge back toward 0 (the history centroid already captures the positive case).
// Bounded + debounce-persisted, so it can only REFINE the learned sound, not hijack it.
function _nudgeSlotBias(track, dir) {
  if (!track) return;
  const f = (track.energy != null && track.valence != null) ? track : _trackFeatures(track);
  if (!f || f.energy == null || f.valence == null) return;
  const key  = _currentSlotKey();
  const c    = _computeContextProfiles()[key]?.centroid;
  const bias = _slotBias.get(key) || { dE: 0, dV: 0 };
  if (dir < 0) {
    const refE = c ? c.energy : 50, refV = c ? c.valence : 50;
    bias.dE += (f.energy  < refE ? +SLOT_BIAS_STEP : -SLOT_BIAS_STEP); // push centroid away from the skip
    bias.dV += (f.valence < refV ? +SLOT_BIAS_STEP : -SLOT_BIAS_STEP);
  } else {
    bias.dE *= 0.8; bias.dV *= 0.8; // fit → decay the nudge toward neutral
  }
  bias.dE = _clampNum(bias.dE, -SLOT_BIAS_MAX, SLOT_BIAS_MAX);
  bias.dV = _clampNum(bias.dV, -SLOT_BIAS_MAX, SLOT_BIAS_MAX);
  _slotBias.set(key, bias);
  _contextProfilesAt = 0; // invalidate the profile cache so the nudge applies immediately
  _scheduleTasteSave();
}

// Best profile for the current moment: composite (weekday/weekend + slot) first,
// then slot-only, else null when there isn't enough history yet. The learned
// per-slot skip-nudge is folded onto the centroid here so every consumer
// (_applyContextBias, _sqLibraryCandidates, _predictForNow) benefits automatically.
function _currentContextProfile() {
  const profiles = _computeContextProfiles();
  const now = new Date();
  const weekend = (now.getDay() === 0 || now.getDay() === 6);
  const slot = _timeSlotFor(now.getHours());
  const prof = profiles[`${weekend ? 'weekend' : 'weekday'}:${slot}`] || profiles[`slot:${slot}`] || null;
  if (!prof || !prof.centroid) return prof;
  const bias = _slotBias.get(`${weekend ? 'weekend' : 'weekday'}:${slot}`);
  if (!bias || (!bias.dE && !bias.dV)) return prof;
  return {
    ...prof,
    centroid: {
      ...prof.centroid,
      energy:  _clampNum(prof.centroid.energy  + bias.dE, 0, 100),
      valence: _clampNum(prof.centroid.valence + bias.dV, 0, 100),
    },
  };
}

// Stable re-rank that drifts tracks closest to the current slot's learned centroid
// toward the front (ties keep their order), so an unguided/autoplay pool leans into
// what this time-of-day usually sounds like — without hard-overriding the pool.
function _applyContextBias(tracks) {
  if (!tracks || tracks.length < 2) return tracks || [];
  const prof = _currentContextProfile();
  if (!prof || !prof.centroid) return tracks;
  const c = prof.centroid;
  return tracks
    .map((t, i) => ({ t, i, d: (t.energy != null && t.valence != null) ? _clusterDist(c, t) : 1 }))
    .sort((a, b) => (a.d - b.d) || (a.i - b.i))
    .map(x => x.t);
}

// What vibe are you going for right now? Merges the ground-truth feelings you've
// reported at this time-of-day (check-in labels) with what this slot usually SOUNDS
// like (audio-pattern centroid). Reported feelings win when we have them; the audio
// pattern is the fallback. Returns a playable mood so the UI can offer one-tap play.
function _predictForNow() {
  const now = new Date();
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  const slot = _timeSlotFor(now.getHours());
  const slotLabel = `${weekend ? 'Weekend' : 'Weekday'} ${SLOT_LABELS[slot] || slot}`;

  // 1) Reported feelings (ground truth) for this slot — composite match preferred.
  const composite = [], slotOnly = [];
  for (const e of _feelingLog) {
    if (!e.feeling || _timeSlotFor(e.h) !== slot) continue;
    slotOnly.push(e);
    if (((e.dow === 0 || e.dow === 6) === weekend)) composite.push(e);
  }
  const sample = composite.length >= 2 ? composite : slotOnly;
  let reportedFeeling = null;
  if (sample.length) {
    const counts = {};
    for (const e of sample) counts[e.feeling] = (counts[e.feeling] || 0) + 1;
    reportedFeeling = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // 2) Audio-pattern feeling for this slot (what it usually sounds like).
  const prof = _currentContextProfile();
  const patternFeeling = (prof && prof.centroid) ? _guessFeeling(prof.centroid) : null;

  const feeling = reportedFeeling || patternFeeling;
  if (!feeling) return null;
  const def  = FEELING_DEFS[feeling];
  const mood = moodForFeeling(feeling);

  // Personal, Portraits/time-machine-style line surfaced on the Now Playing panel
  // (this slot lives here, not in the Portraits grid). Mirrors buildTimeMachine's
  // clock so both read identically, e.g. "It's Sunday 11pm, your nights usually
  // feel angsty". "feel" when it's a reported feeling, "sound" when it's the
  // audio-pattern guess. The client appends " · <top artists>".
  const hr         = now.getHours();
  const hour12     = ((hr + 11) % 12) + 1;
  const ampm       = hr < 12 ? 'am' : 'pm';
  const weekdayName = now.toLocaleDateString([], { weekday: 'long' });
  const slotNoun   = SLOT_LABELS[slot] || slot;
  const feelWord   = (def?.label || feeling).toLowerCase();
  const personal   = `It's ${weekdayName} ${hour12}${ampm}, your ${slotNoun} usually ${reportedFeeling ? 'feel' : 'sound'} ${feelWord}`;

  return {
    label:        slotLabel,
    personal,
    feeling,
    feelingLabel: def?.label || feeling,
    emoji:        def?.emoji || '',
    moodKey:      mood?.key  || null,
    moodName:     mood?.name || null,
    moodEmoji:    mood?.emoji || '',
    source:       reportedFeeling ? 'reported' : 'pattern',
    samples:      reportedFeeling ? sample.length : (prof?.count || 0),
    energy:  prof?.centroid ? Math.round(prof.centroid.energy)  : (def ? Math.round((def.energy[0]  + def.energy[1])  / 2) : null),
    valence: prof?.centroid ? Math.round(prof.centroid.valence) : (def ? Math.round((def.valence[0] + def.valence[1]) / 2) : null),
    bpm:     prof?.centroid?.bpm ? Math.round(prof.centroid.bpm) : null,
    topArtists: prof?.topArtists || [],
    // Taste-drift for this exact slot — the same signal the Portraits grid shows,
    // surfaced here so the current slot's "personal" card lives in one place.
    drift:   _portraitDrift(weekend ? 'weekend' : 'weekday', slot),
  };
}

function detectCurrentContext() {
  const now  = new Date();
  const h    = now.getHours();
  const dow  = now.getDay();

  const timeSlot = _timeSlotFor(h);

  const isWeekend = dow === 0 || dow === 6;

  // Energy trend from recent history
  const recent = _history.slice(-5).filter(e => e.energy != null);
  const recentEnergy = recent.length
    ? Math.round(recent.reduce((s, e) => s + e.energy, 0) / recent.length)
    : null;

  // Score each mood by (a) time-of-day signal match and (b) how well the mood's
  // feeling energy band fits what you're actually listening to right now.
  // bestScore starts at 0, so a mood is only suggested when there's a real signal —
  // otherwise suggestedMoodKey stays null and the UI shows nothing (no false "sad").
  let suggestedMoodKey = null;
  let bestScore = 0;
  for (const mood of MOOD_STATES) {
    let score = 0;
    const cs = mood.contextSignals || {};
    if (cs.hours && cs.hours.includes(h))                  score += 3;
    if (cs.dow   && cs.dow.includes(dow))                  score += 2;
    if (cs.isWeekend != null && cs.isWeekend === isWeekend) score += 1;
    // Energy fit from recent listening (0–2 points) — turns this into a real
    // prediction rather than a fixed clock schedule.
    if (recentEnergy != null) {
      const def = FEELING_DEFS[mood.feeling];
      const eMid = (def.energy[0] + def.energy[1]) / 2;
      score += (1 - Math.abs(recentEnergy - eMid) / 100) * 2;
    }
    if (score > bestScore) { bestScore = score; suggestedMoodKey = mood.key; }
  }

  const suggestedMood = MOOD_STATES.find(m => m.key === suggestedMoodKey);

  // Learned prediction for this exact slot — the vibe you're usually going for now,
  // blending your reported feelings with the slot's audio pattern, and carrying a
  // playable mood so the UI can offer one-tap play. Also biases unguided recs.
  const contextProfile = _predictForNow();

  // The "It's Sunday 11pm — your nights usually lean angsty, often X" card that
  // used to live on the Portraits panel now lives on the Now Playing card. Carry
  // it (plus its replay seed) here so the UI can render it verbatim.
  const timeMachine = buildTimeMachine();

  return { hour: h, dow, timeSlot, isWeekend, recentEnergy, suggestedMoodKey,
           suggestedMoodName: suggestedMood?.name, suggestedMoodEmoji: suggestedMood?.emoji,
           contextProfile, timeMachine };
}

// ---------------------------------------------------------------------------
// Session cluster tracking — detects coherent audio-feature patterns
// ---------------------------------------------------------------------------

function _computeCentroid(tracks) {
  const ft = tracks.filter(t => t.energy != null);
  if (!ft.length) return null;
  const bpmTracks = ft.filter(t => t.bpm);
  return {
    energy:  ft.reduce((s, t) => s + t.energy,  0) / ft.length,
    valence: ft.reduce((s, t) => s + t.valence, 0) / ft.length,
    bpm: bpmTracks.length ? bpmTracks.reduce((s, t) => s + t.bpm, 0) / bpmTracks.length : null,
  };
}

function _clusterDist(c, t) {
  // Normalised Euclidean distance in energy/valence space (BPM secondary)
  const dE = (c.energy  - t.energy)  / 100;
  const dV = (c.valence - t.valence) / 100;
  const dB = (c.bpm && t.bpm) ? (c.bpm - t.bpm) / 200 : 0;
  return Math.sqrt(dE * dE * 0.5 + dV * dV * 0.4 + dB * dB * 0.1);
}

function _guessFeeling(centroid) {
  let best = 'chill', bestScore = -1;
  for (const [key, def] of Object.entries(FEELING_DEFS)) {
    const eMid = (def.energy[0]  + def.energy[1])  / 2;
    const vMid = (def.valence[0] + def.valence[1]) / 2;
    const eScore = 1 - Math.abs(centroid.energy  - eMid) / 100;
    const vScore = 1 - Math.abs(centroid.valence - vMid) / 100;
    const score  = eScore * 0.5 + vScore * 0.5;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return best;
}

// How many of the user's OWN songs the currently-active mood/vibe/feeling is
// drawing from — a cheap, synchronous count (no API calls) for the Now Playing
// card's "drawing from N songs" line. This is the candidate pool the engine
// picks from, NOT the listening-pattern cluster (that's clusterSize):
//   • feeling/mood → library+history tracks whose energy/valence fall in the band
//   • vibe         → the size of that vibe's detected cluster
// Returns null when nothing is active (or features aren't warm yet).
function _activePoolSize() {
  try {
    if (_activeMixTarget) {
      const centroid = { energy: _activeMixTarget.energy, valence: _activeMixTarget.valence, bpm: null };
      const radius = (_activeMixTarget.spread != null ? _activeMixTarget.spread : 0.15) + _lerp(0.04, 0.30, _tVariety());
      let n = 0;
      for (const e of combinedHistory()) {
        if (e.energy == null || e.valence == null) continue;
        if (_clusterDist(centroid, e) <= radius) n++;
      }
      return n;
    }
    if (_activeVibeKey) {
      const vibes = computeVibes();
      if (!vibes.ready) return null;
      const cluster = vibes.clusters.find(c => c.key === _activeVibeKey);
      return cluster ? cluster.tracks.length : null;
    }
    // Mood resolves 1:1 to a feeling; feeling is used directly.
    let feelingKey = _activeFeeling?.key || null;
    if (!feelingKey && _activeMoodKey) {
      feelingKey = MOOD_STATES.find(m => m.key === _activeMoodKey)?.feeling || null;
    }
    if (!feelingKey) return null;
    const def = FEELING_DEFS[feelingKey];
    if (!def) return null;
    const band = _feelingBand(def);
    let n = 0;
    for (const e of combinedHistory()) {
      if (e.energy == null) continue;
      if (e.energy  < band.eMin || e.energy  > band.eMax) continue;
      if (e.valence < band.vMin || e.valence > band.vMax) continue;
      n++;
    }
    return n;
  } catch {
    return null;
  }
}

function _emitIntelligenceState() {
  if (!_io) return;
  _io.emit('spotify:intelligence_state', {
    activeFeeling:  _activeFeeling ? { key: _activeFeeling.key, label: _activeFeeling.label, emoji: _activeFeeling.emoji } : null,
    activeMoodKey:  _activeMoodKey,
    activeMoodName: _activeMoodKey ? (MOOD_STATES.find(m => m.key === _activeMoodKey)?.name || null) : null,
    activeVibeKey:  _activeVibeKey,
    activeMix:      _activeMixState(),
    activePoolSize: _activePoolSize(),
    clusterSize:    _currentCluster.length,
    clusterCentroid: _currentCentroid,
    pendingCheckIn: _pendingCheckIn ? { guessedFeeling: _pendingCheckIn.guessedFeeling } : null,
    context:        detectCurrentContext(),
  });
}

function _triggerCheckIn() {
  const centroid = { ..._currentCentroid };
  const guessedFeeling = _guessFeeling(centroid);
  _pendingCheckIn = {
    fingerprint:     centroid,
    guessedFeeling,
    clusterSnapshot: [..._currentCluster],
    timestamp:       Date.now(),
  };
  _lastCheckInAt = _currentCluster.length;
  if (_io) {
    _io.emit('spotify:checkin', {
      guessedFeeling,
      guess: FEELING_DEFS[guessedFeeling],
      feelings: Object.entries(FEELING_DEFS).map(([key, def]) => ({ key, ...def })),
    });
  }
}

// Look up stored audio features for a track ID from history (most recent first).
// Returns the history entry with features, or null if not found.
function _findStoredFeatures(trackId) {
  let historyMatch = null;
  let historyMatchNoFeatures = null;
  for (let i = _history.length - 1; i >= 0; i--) {
    const e = _history[i];
    if (e.id === trackId) {
      if (e.energy != null) { historyMatch = e; break; }
      else if (!historyMatchNoFeatures) historyMatchNoFeatures = e;
    }
  }
  if (historyMatch) return historyMatch;

  let seededMatch = null;
  let seededMatchNoFeatures = null;
  for (const e of [..._seededHistory, ..._librarySeeds]) {
    if (e.id === trackId) {
      if (e.energy != null) { seededMatch = e; break; }
      else if (!seededMatchNoFeatures) seededMatchNoFeatures = e;
    }
  }
  if (seededMatch) return seededMatch;

  // Final fallback: the raw audio-features cache (track-features.json). Discovery
  // tracks fetched via ReccoBeats land here but aren't added to history/seeds, so
  // without this their cluster updates were silently skipped. Convert the raw 0-1
  // shape to the 0-100 entry shape the cluster/centroid math expects.
  const raw = _audioFeaturesCache.get(trackId);
  if (raw && (raw.energy != null || raw.valence != null)) {
    return {
      id: trackId,
      bpm:      Math.round(raw.tempo || 0),
      energy:   Math.round((raw.energy           || 0) * 100),
      valence:  Math.round((raw.valence          || 0) * 100),
      dance:    Math.round((raw.danceability     || 0) * 100),
      acoustic: Math.round((raw.acousticness     || 0) * 100),
      inst:     Math.round((raw.instrumentalness || 0) * 100),
      key:      raw.key != null && raw.key >= 0 ? PITCH_CLASSES[raw.key] : null,
      mode:     raw.mode === 1 ? 'Maj' : raw.mode === 0 ? 'Min' : null,
    };
  }

  // Log why we couldn't find it
  if (historyMatchNoFeatures) {
    console.log(`[Spotify] Features: found in history but energy=null for id=${trackId} — keys: ${Object.keys(historyMatchNoFeatures).join(',')}`);
  } else if (seededMatchNoFeatures) {
    console.log(`[Spotify] Features: found in seeded but energy=null for id=${trackId} — keys: ${Object.keys(seededMatchNoFeatures).join(',')}`);
  } else {
    console.log(`[Spotify] Features: id=${trackId} not found in history(${_history.length}) or seeded(${_seededHistory.length})`);
  }
  return null;
}

// Called after audio features are merged into a history entry.
// Tracks the running cluster and fires check-in when confident.
function _updateCluster(histEntry) {
  if (histEntry.energy == null || histEntry.valence == null) {
    console.log(`[Spotify] Cluster: skipping (no audio features) title="${histEntry.title}"`);
    return;
  }

  if (!_currentCentroid || _currentCluster.length === 0) {
    _currentCluster = [histEntry];
    _currentCentroid = _computeCentroid(_currentCluster);
    _driftBuffer = [];
    console.log(`[Spotify] Cluster: started — energy=${histEntry.energy} valence=${histEntry.valence}`);
    _emitIntelligenceState();
    return;
  }

  const dist = _clusterDist(_currentCentroid, histEntry);
  console.log(`[Spotify] Cluster: size=${_currentCluster.length} dist=${dist.toFixed(3)} energy=${histEntry.energy} valence=${histEntry.valence}`);

  if (dist < 0.22) {
    // Same cluster — absorb track, update centroid
    _currentCluster.push(histEntry);
    _currentCentroid = _computeCentroid(_currentCluster);
    _driftBuffer = [];

    // Steer the autoplay toward this firming-up vibe (no queue rebuild) before we
    // broadcast, so the same intelligence emit carries the freshly-locked mix.
    _maybeAutoSteerVibe();

    // Always emit so the UI counter updates in real time
    _emitIntelligenceState();

    // Check if active feeling's centroid has now drifted too far
    if (_activeFeeling) {
      const feelingDist = _clusterDist(_activeFeeling.centroid, _currentCentroid);
      if (feelingDist > _tDriftThreshold() && _currentCluster.length >= 4) {
        _activeFeeling = null;
        if (_io) _io.emit('spotify:feeling_expired');
      }
    }

    // Trigger check-in when cluster first hits 5 tracks, then every 15 more
    const sz = _currentCluster.length;
    if (_checkInAutoEnabled && !_pendingCheckIn && sz >= 5 &&
        (sz === 5 || (sz - _lastCheckInAt) >= 15)) {
      _triggerCheckIn();
    }
  } else {
    // Potential drift — buffer it
    _driftBuffer.push(histEntry);
    console.log(`[Spotify] Cluster: drift buffer=${_driftBuffer.length}`);

    if (_driftBuffer.length >= 3) {
      // Confirmed vibe shift — start fresh cluster from drift buffer
      _currentCluster  = [..._driftBuffer];
      _currentCentroid = _computeCentroid(_currentCluster);
      _driftBuffer     = [];
      _lastCheckInAt   = 0;
      console.log(`[Spotify] Cluster: vibe shift — new cluster started`);

      // Dismiss stale pending check-in
      if (_pendingCheckIn) {
        _pendingCheckIn = null;
        if (_io) _io.emit('spotify:checkin_dismiss', { reason: 'vibe_changed' });
      }
      // Re-steer once the new vibe has firmed up (this fresh cluster is only ~3
      // tracks, so the old auto-vibe keeps steering until it reaches confidence —
      // intentional stickiness so a brief detour doesn't yank the queue around).
      _maybeAutoSteerVibe();
      _emitIntelligenceState();
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

function computeProfile() {
  const all = combinedHistory();
  if (!all.length) return { ready: false, total: 0 };
  const artistCount = {};
  const hourCount   = new Array(24).fill(0);
  const featEntries = all.filter(e => e.energy != null);

  for (const e of all) {
    if (e.artist) artistCount[e.artist] = (artistCount[e.artist] || 0) + 1;
    if (e.h != null) hourCount[e.h]++;
  }
  const topArtists = Object.entries(artistCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const peakHour = hourCount.indexOf(Math.max(...hourCount));
  let avgFeatures = null;
  if (featEntries.length) {
    const s = { energy: 0, valence: 0, dance: 0, acoustic: 0, inst: 0, bpm: 0, bpmCount: 0 };
    for (const e of featEntries) {
      s.energy += e.energy; s.valence += e.valence;
      s.dance   += (e.dance   || 0);
      s.acoustic+= (e.acoustic|| 0);
      s.inst    += (e.inst    || 0);
      if (e.bpm) { s.bpm += e.bpm; s.bpmCount++; }
    }
    const n = featEntries.length;
    avgFeatures = {
      energy:   Math.round(s.energy   / n),
      valence:  Math.round(s.valence  / n),
      dance:    Math.round(s.dance    / n),
      acoustic: Math.round(s.acoustic / n),
      inst:     Math.round(s.inst     / n),
      bpm:      s.bpmCount ? Math.round(s.bpm / s.bpmCount) : null,
    };
  }
  // daysLogging only counts from first *real* logged entry (not seeded)
  const daysLogging = _history.length
    ? Math.max(1, Math.ceil((Date.now() - _history[0].ts) / 86400000))
    : 0;
  return {
    ready: true, total: all.length,
    ownTotal: _history.length,
    unique: new Set(all.map(e => e.id)).size,
    daysLogging, topArtists, peakHour, hourCount,
    avgFeatures, featCoverage: featEntries.length,
    signals: {
      // Distinct A→B transitions that net-survived (the next track wasn't skipped).
      flowLinks:     [..._transitions.values()].filter(v => v > 0).length,
      transitions:   _transitions.size,
      feelingLabels: _feelingLog.length,
    },
  };
}

function computePatterns() {
  // Only use entries that have real timestamps (our log + recently-played seeds)
  // Excludes top-tracks seeds which have no timestamp
  const timed = combinedHistory().filter(e => e.ts != null);
  // grid[block 0-5][dow 0-6]   block = Math.floor(hour/4)
  const grid = Array.from({ length: 6 }, () => new Array(7).fill(0));
  for (const e of timed) {
    if (e.h != null && e.dow != null)
      grid[Math.floor(e.h / 4)][e.dow]++;
  }
  const max = Math.max(1, ...grid.flat());
  return {
    grid, max, total: timed.length,
    blockNames: ['Late Night (0–4)', 'Early AM (4–8)', 'Morning (8–12)',
                 'Afternoon (12–16)', 'Evening (16–20)', 'Night (20–24)'],
    dayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  };
}

function computeVibes() {
  const MIN = 20;
  const all = combinedHistory();
  if (all.length < MIN) return { ready: false, needed: MIN, current: all.length };
  const clusters = {};
  for (const e of all) {
    const k = getVibeKey(e);
    if (!k) continue; // seeded entry with no audio features and no timestamp — skip
    if (!clusters[k]) clusters[k] = [];
    clusters[k].push(e);
  }
  const hasFeatures = all.some(e => e.energy != null);
  const result = Object.entries(clusters)
    .filter(([, arr]) => arr.length >= 3)
    .map(([key, arr]) => {
      const unique = [...new Map(arr.map(e => [e.id, e])).values()];
      const fe = arr.filter(e => e.energy != null);
      const avgE   = fe.length ? Math.round(fe.reduce((s,e)=>s+e.energy,  0)/fe.length) : null;
      const avgV   = fe.length ? Math.round(fe.reduce((s,e)=>s+e.valence, 0)/fe.length) : null;
      const bpmArr = fe.filter(e=>e.bpm);
      const avgBpm = bpmArr.length ? Math.round(bpmArr.reduce((s,e)=>s+e.bpm,0)/bpmArr.length) : null;
      return {
        key, name: getVibeName(key),
        plays: arr.length, count: unique.length,
        avgEnergy: avgE, avgValence: avgV, avgBpm,
        tracks: unique.slice(0, 50).map(e => ({ id: e.id, uri: e.uri, title: e.title, artist: e.artist })),
      };
    })
    .sort((a, b) => b.plays - a.plays);
  return { ready: true, hasFeatures, clusters: result };
}

function computeRightNow() {
  const now  = new Date();
  const h    = now.getHours();
  const dow  = now.getDay();
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const timeLabel = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;

  // Only use entries with real timestamps for time-pattern matching
  const timed = combinedHistory().filter(e => e.ts != null);
  const exact = timed.filter(e => Math.abs((e.h||0)-h) <= 1 && e.dow === dow);
  const block = Math.floor(h / 4);
  const broad = timed.filter(e => Math.floor((e.h||0)/4) === block);
  const set   = exact.length >= 5 ? exact : broad.length >= 5 ? broad : null;

  if (!set) return { ready: false, dayName: DAYS[dow], timeLabel };

  const vibeCounts = {};
  for (const e of set) { const k = getVibeKey(e); vibeCounts[k] = (vibeCounts[k]||0)+1; }
  const topKey = Object.entries(vibeCounts).sort((a,b)=>b[1]-a[1])[0][0];

  const trackCounts = {}; const trackMeta = {};
  for (const e of set) {
    trackCounts[e.id] = (trackCounts[e.id]||0)+1;
    if (!trackMeta[e.id]) trackMeta[e.id] = { id: e.id, uri: e.uri, title: e.title, artist: e.artist };
  }
  const topTracks = Object.entries(trackCounts)
    .sort((a,b)=>b[1]-a[1]).slice(0,25)
    .map(([id]) => trackMeta[id]);

  return {
    ready: true, dayName: DAYS[dow], timeLabel,
    sampleSize: set.length, broad: exact.length < 5,
    vibeKey: topKey, vibeName: getVibeName(topKey), topTracks,
  };
}

// The data behind the "mood map": a density grid of your listening across energy×
// valence space (so the pad can show WHERE your music lives), the named clusters as
// labelled anchor points, and a personal "right now" point (the centroid of what you
// tend to play at this hour). All in-memory, no API calls.
// genreFilter (a macro-genre bucket key) restricts the heat-cloud to that genre,
// so the Genres tab shows where *your rock/hip-hop/…* actually lives in the space.
// Readiness still reflects your overall history (the pad stays usable even when a
// genre is sparse — discovery fills it), and anchors are dropped under a filter.
function computeMixMap(genreFilter = null) {
  const BINS = 10;
  const grid = Array.from({ length: BINS }, () => new Array(BINS).fill(0));
  const genreKey = genreFilter && genreFilter !== 'any' ? genreFilter : null;
  let max = 0, total = 0, fullTotal = 0;
  const nowHour = new Date().getHours();
  const timed = []; // same-hour plays → the "right now" centroid
  for (const e of combinedHistory()) {
    if (e.energy == null || e.valence == null) continue;
    fullTotal++;
    if (e.ts != null && e.h != null && Math.abs(e.h - nowHour) <= 1) timed.push(e);
    if (genreKey && !_trackMatchesGenre(e, genreKey)) continue;
    const xi = Math.min(BINS - 1, Math.max(0, Math.floor((e.valence / 100) * BINS))); // valence → X
    const yi = Math.min(BINS - 1, Math.max(0, Math.floor((e.energy  / 100) * BINS))); // energy  → Y
    grid[yi][xi]++;
    if (grid[yi][xi] > max) max = grid[yi][xi];
    total++;
  }

  // Named quick-picks = the discovered clusters, placed at their centroid. Hidden
  // under a genre filter (clusters aren't genre-specific — the chips are the picks).
  const anchors = [];
  if (!genreKey) {
    const vibes = computeVibes();
    if (vibes.ready) {
      for (const c of vibes.clusters) {
        if (c.avgEnergy == null || c.avgValence == null) continue;
        anchors.push({
          key: c.key, name: c.name,
          energy: c.avgEnergy, valence: c.avgValence,
          plays: c.plays, count: c.count, avgBpm: c.avgBpm,
        });
      }
    }
  }

  // "Right now" — where you usually sit at this time of day.
  let nowPoint = null;
  if (timed.length >= 5) {
    const c = _computeCentroid(timed);
    if (c) nowPoint = {
      energy: Math.round(c.energy), valence: Math.round(c.valence),
      label: _mixTargetLabel({ energy: c.energy, valence: c.valence }),
    };
  }

  // Where the current listening sits right now — the live cluster centroid (the
  // vibe of what's playing). Used by the UI to default the selector puck onto the
  // current song/mix instead of starting blank.
  let currentPoint = null;
  if (_currentCentroid && _currentCentroid.energy != null && _currentCentroid.valence != null) {
    currentPoint = {
      energy:  Math.round(_currentCentroid.energy),
      valence: Math.round(_currentCentroid.valence),
      label:   _mixTargetLabel({ energy: _currentCentroid.energy, valence: _currentCentroid.valence }),
    };
  }

  return {
    ready: fullTotal >= 10, bins: BINS, grid, max, total, anchors, nowPoint, currentPoint,
    genre: genreKey || null,
  };
}

// Build the full insights payload from current in-memory state (no network).
// Each section is computed defensively so one failing analysis can't blank the
// entire panel — a bad vibe calc shouldn't wipe Profile/Patterns/etc.
function buildInsightsPayload() {
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.error('[Spotify] insights section failed:', e.message); return fallback; } };
  return {
    profile:  safe(computeProfile,  { ready: false, total: 0 }),
    patterns: safe(computePatterns, { ready: false }),
    vibes:    safe(computeVibes,    { ready: false }),
    rightNow: safe(computeRightNow, { ready: false }),
    total:    safe(() => combinedHistory().length, 0),
    ownTotal: _history.length,
    tuning:        { ..._tuning },
    activeMoodKey: _activeMoodKey,
    activeVibeKey: _activeVibeKey,
    activeMix:     _activeMixState(),
    mixMap:   safe(computeMixMap, { ready: false }),
    moods: MOOD_STATES.map(({ key, name, emoji, desc, feeling }) => ({ key, name, emoji, desc, feeling })),
    context: safe(detectCurrentContext, null),
  };
}

function buildStats() {
  const tracks = _sessionStats.tracksPlayed;

  // ── Top artists in this UI session ───────────────────────────────────────
  const artistCounts = {};
  tracks.forEach((t) => {
    if (t.artist) {
      t.artist.split(', ').forEach((a) => {
        if (a) artistCounts[a] = (artistCounts[a] || 0) + 1;
      });
    }
  });
  const topArtists = Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // ── Recent tracks (no duplicates) ─────────────────────────────────────────
  const seenIds = new Set();
  const recentTracks = [];
  for (let i = tracks.length - 1; i >= 0 && recentTracks.length < 5; i--) {
    const t = tracks[i];
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      recentTracks.push({ id: t.id, title: t.title, artist: t.artist });
    }
  }

  // ── Listened time (all sessions + active) ────────────────────────────────
  const now          = Date.now();
  const todayStart   = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs_ts   = todayStart.getTime();
  const weekMs_ts    = now - 7 * 24 * 60 * 60 * 1000;

  const activeMs     = _activeSession?.listenedMs || 0;
  const activeStart  = _activeSession?.startTime  || now;

  let totalMs = activeMs;
  let todayMs = activeStart >= todayMs_ts ? activeMs : 0;
  let weekMs  = activeStart >= weekMs_ts  ? activeMs : 0;

  for (const s of _sessions) {
    totalMs += s.listenedMs;
    if (s.startTime >= todayMs_ts) todayMs += s.listenedMs;
    if (s.startTime >= weekMs_ts)  weekMs  += s.listenedMs;
  }

  return {
    startTime:   _sessionStats.startTime,
    tracksCount: tracks.length,
    topArtists,
    recentTracks,
    // Listened-time breakdown
    listenedMs: activeMs,    // current active session
    todayMs,                 // today (midnight→now)
    weekMs,                  // rolling 7 days
    totalMs,                 // all time
  };
}

// ---------------------------------------------------------------------------
// Portraits + Time-machine  (magic-factor #9 and #5)
// ---------------------------------------------------------------------------

// #9 — Per-context taste portraits: "Your weekday late nights sound like…".
// Built purely from the learned context profiles (composite buckets), so it's a
// zero-API, shareable mirror of what each time-of-day actually sounds like.
// Taste-drift (#5): split a context bucket's plays into an older half and a recent
// half and compare their centroids. If the sound has shifted meaningfully, return a
// short human label ("trending mellower") so each portrait can show how your taste
// for that slot is moving — not just where it sits. Null when stable / thin data.
function _portraitDrift(scope, slot) {
  const entries = _history.filter(e =>
    e.h != null && e.energy != null && e.valence != null &&
    _timeSlotFor(e.h) === slot &&
    (((e.dow === 0 || e.dow === 6) ? 'weekend' : 'weekday') === scope));
  if (entries.length < 12) return null;            // _history is chronological → halves are older/recent
  const mid    = Math.floor(entries.length / 2);
  const older  = _computeCentroid(entries.slice(0, mid));
  const recent = _computeCentroid(entries.slice(mid));
  if (!older || !recent) return null;
  const dE = recent.energy  - older.energy;
  const dV = recent.valence - older.valence;
  const TH = 8;
  if (Math.abs(dE) < TH && Math.abs(dV) < TH) return null;
  if (Math.abs(dE) >= Math.abs(dV)) return dE > 0 ? 'trending higher-energy' : 'trending mellower';
  return dV > 0 ? 'trending brighter' : 'trending moodier';
}

function buildPortraits() {
  const profiles = _computeContextProfiles();
  // The current slot is shown — enriched and actionable — on the Now Playing
  // screen ("The vibe you're going for"), so omit it here to avoid duplicating
  // the same portrait in two places.
  const nowKey = _currentSlotKey();
  const out = [];
  for (const [key, p] of Object.entries(profiles)) {
    if (key.startsWith('slot:') || !p.centroid) continue; // composite buckets only
    if (key === nowKey) continue;                          // lives on Now Playing instead
    const [scope, slot] = key.split(':');
    const def = FEELING_DEFS[_guessFeeling(p.centroid)] || {};
    out.push({
      key,
      title: `${scope === 'weekend' ? 'Weekend' : 'Weekday'} ${SLOT_LABELS[slot] || slot}`,
      emoji: def.emoji || '🎧',
      feeling: def.label || '—',
      energy:  Math.round(p.centroid.energy),
      valence: Math.round(p.centroid.valence),
      bpm:     p.centroid.bpm != null ? Math.round(p.centroid.bpm) : null,
      count:   p.count,
      topArtists: (p.topArtists || []).slice(0, 3).map(a => a.name),
      drift:   _portraitDrift(scope, slot), // #5 taste-drift
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 6);
}

// #5 — Time-machine: "It's Friday 11pm — your late nights lean chill, often X."
// Plus a concrete seed track (most recent same-slot play) the user can replay,
// which routes through the Smart Queue engine like any other seed.
function buildTimeMachine() {
  const [scope, slot] = _currentSlotKey().split(':');
  const inSlot = (e) => e.h != null && e.energy != null && _timeSlotFor(e.h) === slot;
  const composite = _history.filter(e => inSlot(e) &&
    ((e.dow === 0 || e.dow === 6) ? 'weekend' : 'weekday') === scope);
  const pool = composite.length >= 5 ? composite : _history.filter(inSlot);
  if (pool.length < 5) return null;

  const recent   = pool.slice(-40);
  const centroid = _computeCentroid(recent);
  const def      = centroid ? (FEELING_DEFS[_guessFeeling(centroid)] || {}) : {};
  const counts   = new Map();
  for (const e of recent) if (e.artist) counts.set(e.artist, (counts.get(e.artist) || 0) + 1);
  const ranked    = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topArtist = ranked[0];
  const topArtists = ranked.slice(0, 10).map(e => e[0]); // marquee list of this slot's regulars
  const seedEntry = [...recent].reverse().find(e => e.id || e.uri);

  const now = new Date();
  const hr = now.getHours();
  const hour12 = ((hr + 11) % 12) + 1;
  const ampm = hr < 12 ? 'am' : 'pm';
  const slotLabel = SLOT_LABELS[slot] || slot;
  const feelWord  = def.label ? def.label.toLowerCase() : 'familiar';
  return {
    emoji: def.emoji || '🕰️',
    headline: `It's ${now.toLocaleDateString([], { weekday: 'long' })} ${hour12}${ampm}`,
    // Static descriptor line shown under the headline; the artists scroll below it.
    lean: `Your ${slotLabel} usually lean ${feelWord}, often:`,
    artists: topArtists,
    // Legacy single-line summary kept for any consumer that still reads `sub`.
    sub: `Your ${slotLabel} usually lean ${feelWord}${topArtist ? ` — often ${topArtist[0]}` : ''}`,
    sampleSize: recent.length,
    seed: seedEntry ? {
      uri: seedEntry.uri || (seedEntry.id ? `spotify:track:${seedEntry.id}` : null),
      id: seedEntry.id || null,
      title: seedEntry.title || '',
      artist: seedEntry.artist || '',
    } : null,
  };
}

// "Your day in music" (#7) — a zero-API recap of TODAY's listening: track count,
// the energy arc (did the day ramp up or wind down), the mood you opened and closed
// on, the day's most-played artist, and a standout discovery (a track heard for the
// first time ever today). Returns null until there's a meaningful amount logged.
function buildDayRecap() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const startMs  = dayStart.getTime();
  const today    = _history.filter(e => e.ts != null && e.ts >= startMs);
  if (today.length < 4) return null;

  const trackCount = new Set(today.map(e => e.id).filter(Boolean)).size;
  const artistCounts = new Map();
  for (const e of today) if (e.artist) artistCounts.set(e.artist, (artistCounts.get(e.artist) || 0) + 1);
  const topArtist = [...artistCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  // Energy arc + opening/closing mood from the day's first vs last third.
  const feat = today.filter(e => e.energy != null && e.valence != null);
  let arc = null, startMood = null, endMood = null;
  if (feat.length >= 4) {
    const third = Math.max(1, Math.floor(feat.length / 3));
    const avgE  = (a) => a.reduce((s, e) => s + e.energy, 0) / a.length;
    const head  = avgE(feat.slice(0, third));
    const tail  = avgE(feat.slice(-third));
    arc = tail > head + 8 ? 'ramped up' : tail < head - 8 ? 'wound down' : 'held steady';
    const hc = _computeCentroid(feat.slice(0, third));
    const tc = _computeCentroid(feat.slice(-third));
    startMood = hc ? (FEELING_DEFS[_guessFeeling(hc)] || {}).label || null : null;
    endMood   = tc ? (FEELING_DEFS[_guessFeeling(tc)] || {}).label || null : null;
  }

  // Standout discovery: a track whose earliest-ever play in history is today.
  const earliest = new Map();
  for (const e of _history) {
    if (!e.id || e.ts == null) continue;
    if (!earliest.has(e.id) || e.ts < earliest.get(e.id)) earliest.set(e.id, e.ts);
  }
  let discovery = null;
  for (const e of today) {
    if (e.id && earliest.get(e.id) >= startMs) { discovery = { title: e.title || '', artist: e.artist || '' }; break; }
  }

  return {
    trackCount,
    arc, startMood, endMood,
    topArtist: topArtist ? { name: topArtist[0], count: topArtist[1] } : null,
    discovery,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let _pollInFlight = false;

async function poll() {
  // Never let poll cycles overlap. A boundary poll can fire while a slow
  // (rate-limited) cycle is still draining; without this guard each tick stacks
  // another getPlaybackState + checkLiked + refill onto the queue, so the backlog
  // grows without bound and interactive requests never get a turn.
  if (_pollInFlight) return;
  _pollInFlight = true;
  try {
    const raw = await getPlaybackState();
    const state = serializeState(raw);

    if (state && state.track) {
      const trackChanged = _lastTrackId && _lastTrackId !== state.track.id;

      // ── Listen-time accumulation ─────────────────────────────────────────
      if (state.isPlaying && state.progress != null) {
        // Open a new session if none is active
        if (!_activeSession) openActiveSession();

        // Remember the current track so no auto-queue method repeats it this session
        if (state.track.id) _markPlayed(state.track.id);

        const sameTrack = state.track.id === _lastTrackId;
        if (sameTrack && _lastProgress != null) {
          const delta = state.progress - _lastProgress;
          // Only count forward movement within a reasonable range (rules out seeks)
          if (delta > 0 && delta < PROGRESS_DELTA_MAX) {
            _activeSession.listenedMs       += delta;
            _activeSession.lastActivityTime  = Date.now();
          }
        }
        // Always update lastProgress while playing (reset on track change below)
        _lastProgress = state.progress;
        if (_activeSession) _activeSession.lastActivityTime = Date.now();

        // Bump track count when a new track starts
        if (trackChanged || (!_lastTrackId && _activeSession.trackCount === 0)) {
          _activeSession.trackCount += 1;
          if (state.track.id && !_activeSession.trackIds.includes(state.track.id)) {
            _activeSession.trackIds.push(state.track.id);
          }
        }
      } else {
        // Not playing — reset progress cursor
        _lastProgress = null;
        // Check if the current session has gone quiet long enough to close
        if (_activeSession) {
          const gap = Date.now() - _activeSession.lastActivityTime;
          if (gap > SESSION_GAP_MS) closeActiveSession();
        }
      }

      // Reset progress cursor on track change to avoid a spurious delta
      if (trackChanged) {
        // The track now playing is consumed: drop it from our staged set so our
        // bookkeeping reflects one fewer fresh slot ahead.
        if (state.track?.uri) _stagedUris.delete(state.track.uri);
        // Record it in the recent-play window so it can't be re-staged for a while.
        _notePlayed(state.track?.id);
        // Judge engagement with the outgoing track (skip vs finish) before we move
        // on — UNLESS this track change was triggered by an app-initiated context
        // switch (mood/vibe/track change), in which case the outgoing track was
        // not rejected by the user and must not be penalised as a skip.
        const appInitiated = Date.now() < _suppressEngageUntil;
        _suppressEngageUntil = 0; // consume: only the first change after a switch is exempt
        if (appInitiated) {
          _transitionPrevId = null; // break the transition chain across the context switch
          console.log(`[Spotify] Engagement: skipped scoring "${_lastState?.track?.title}" — app-initiated context change`);
        } else {
          _evaluateEngagement(_lastState);
        }
        _lastProgress = null;
        _autoQueueCount = Math.max(0, _autoQueueCount - 1);
        // Broadcast fresh queue ~1.5 s after track change so Spotify's queue
        // endpoint has time to reflect the new state.
        setTimeout(emitQueue, 1500);
        // Record to session stats (deduplication) and persistent history
        if (state.track) {
          const last = _sessionStats.tracksPlayed[_sessionStats.tracksPlayed.length - 1];
          if (!last || last.id !== state.track.id) {
            _sessionStats.tracksPlayed.push({
              id: state.track.id, uri: state.track.uri,
              title: state.track.title, artist: state.track.artist,
              startTime: Date.now(), durationMs: state.track.duration,
            });
          }
          if (_io) _io.emit('spotify:stats', buildStats());

          // Build history entry — use stored features first, API only as last resort
          const histEntry = {
            ts: Date.now(),
            h:  new Date().getHours(),
            dow: new Date().getDay(),
            id: state.track.id, uri: state.track.uri,
            title: state.track.title, artist: state.track.artist,
            album: state.track.album || '',
            art: state.track.albumArt || '',
            dur: state.track.duration,
          };
          const _stored = _findStoredFeatures(state.track.id);
          if (_stored) {
            console.log(`[Spotify] Features: from history — energy=${_stored.energy} valence=${_stored.valence} title="${state.track.title}"`);
            histEntry.bpm      = _stored.bpm;
            histEntry.energy   = _stored.energy;
            histEntry.valence  = _stored.valence;
            histEntry.dance    = _stored.dance;
            histEntry.acoustic = _stored.acoustic;
            histEntry.inst     = _stored.inst;
            histEntry.key      = _stored.key;
            histEntry.mode     = _stored.mode;
            if (_io) _io.emit('spotify:audio_features', {
              bpm: histEntry.bpm, energy: histEntry.energy, valence: histEntry.valence,
              dance: histEntry.dance, acoustic: histEntry.acoustic, inst: histEntry.inst,
              key: histEntry.key, mode: histEntry.mode,
            });
            appendHistory(histEntry);
            _updateCluster(histEntry);
          } else {
            getAudioFeatures(state.track.id)
              .then((f) => {
                if (f) {
                  histEntry.bpm      = Math.round(f.tempo || 0);
                  histEntry.energy   = Math.round((f.energy   || 0) * 100);
                  histEntry.valence  = Math.round((f.valence  || 0) * 100);
                  histEntry.dance    = Math.round((f.danceability || 0) * 100);
                  histEntry.acoustic = Math.round((f.acousticness  || 0) * 100);
                  histEntry.inst     = Math.round((f.instrumentalness || 0) * 100);
                  histEntry.key      = f.key != null && f.key >= 0 ? PITCH_CLASSES[f.key] : null;
                  histEntry.mode     = f.mode === 1 ? 'Maj' : f.mode === 0 ? 'Min' : null;
                  if (_io) _io.emit('spotify:audio_features', _serializeFeatures(f));
                }
                appendHistory(histEntry);
                _updateCluster(histEntry);
              })
              .catch(() => { appendHistory(histEntry); });
          }
        }
      }

      // Check liked status for new track
      // Feb 2026: checkLiked now takes Spotify URIs (spotify:track:...) not bare IDs
      if (!_lastTrackId || _lastTrackId !== state.track.id) {
        try {
          const liked = await checkLiked([state.track.uri]);
          state.liked = Array.isArray(liked) ? liked[0] : false;
        } catch {
          state.liked = false;
        }

        if (trackChanged) {
          // Smart Queue — playlist-end entry. If the user was listening to a
          // playlist/album with the toggle ON and Spotify has now dropped the
          // context, start a Smart Queue session that weaves our picks into a
          // self-sourced discovery stream so the music keeps going.
          if (_smartQueueEnabled && !_sq) {
            const prevCtx = _lastState?.context?.type;
            const nowCtx  = state.context?.type;
            const wasListContext = prevCtx === 'playlist' || prevCtx === 'album';
            const ctxDropped = !nowCtx || nowCtx !== prevCtx;
            if (wasListContext && ctxDropped) {
              console.log('[SmartQueue] Playlist/album ended → starting Smart Queue (playlist entry)');
              _sqStart('playlist', state.track, true);
            }
          }
        }
        // Emit audio features on first track load too (not just track changes)
        if (!_lastTrackId) {
          const _storedFirst = _findStoredFeatures(state.track.id);
          if (_storedFirst && _io) {
            _io.emit('spotify:audio_features', {
              bpm: _storedFirst.bpm, energy: _storedFirst.energy, valence: _storedFirst.valence,
              dance: _storedFirst.dance, acoustic: _storedFirst.acoustic, inst: _storedFirst.inst,
              key: _storedFirst.key, mode: _storedFirst.mode,
            });
          } else {
            getAudioFeatures(state.track.id)
              .then((f) => { if (f && _io) _io.emit('spotify:audio_features', _serializeFeatures(f)); })
              .catch(() => {});
          }
        }
      } else if (_lastState) {
        state.liked = _lastState.liked;
      }

      _lastTrackId = state.track.id;

      // Smart Queue owns the queue while it's active — it drives all just-in-time
      // insertion, anomaly checks, and window recompute itself on every poll, so
      // the queue can never run dry (a missed track change is caught ≤5 s later).
      if (state.isPlaying && _sq) {
        await _sqTick(state).catch((err) =>
          console.error('[SmartQueue] tick error:', err.message)
        );
      }
    } else {
      // No track / no state — reset progress, check session gap
      _lastProgress = null;
      if (_activeSession) {
        const gap = Date.now() - _activeSession.lastActivityTime;
        if (gap > SESSION_GAP_MS) closeActiveSession();
      }
    }

    _lastState = state;

    // Periodically snapshot the live session + intelligence so a restart can
    // resume the same session instead of resetting it. clearLiveState() runs
    // inside saveLiveState when nothing is active.
    _liveSaveTick++;
    if (_liveSaveTick >= 4) { // 4 × 5 s = 20 s
      _liveSaveTick = 0;
      saveLiveState();
    }

    if (_io) {
      _io.emit('spotify:state', state);
      // Broadcast updated stats every ~30 s while playing so the time tiles stay fresh
      _statsBroadcastTick++;
      if (_statsBroadcastTick >= 6) { // 6 × 5 s = 30 s
        _statsBroadcastTick = 0;
        _io.emit('spotify:stats', buildStats());
      }
    }
  } catch (err) {
    // Do not crash — log only
    console.error('[Spotify] Poll error:', err.message);
  } finally {
    _pollInFlight = false;
  }
}

// ── Adaptive playback monitor ───────────────────────────────────────────────
// Self-scheduling poll loop. After each poll we derive the next delay from the
// fresh state: a slow base while a song plays through, one precise poll at the
// predicted song-end boundary, and a rare cadence when idle. UI actions call
// refreshNow() to poll immediately instead of waiting for the next tick.
function _nextPollDelay() {
  const s = _lastState;
  if (!s || !s.track || !s.isPlaying) return POLL_IDLE;
  const dur = s.track.duration;
  const prog = s.progress;
  if (dur != null && prog != null && dur > prog) {
    // _lastState was captured moments ago, so (dur - prog) ≈ time-from-now until
    // this track ends. If that lands inside the next base window, fire one precise
    // poll just past the boundary to catch the new track right away.
    const toEnd = dur - prog + POLL_END_MARGIN;
    if (toEnd < POLL_BASE) return Math.max(POLL_MIN, toEnd);
  }
  return POLL_BASE;
}

function _scheduleNextPoll() {
  if (!_polling) return;
  clearTimeout(_pollTimeout);
  _pollTimeout = setTimeout(_pollTick, _nextPollDelay());
}

async function _pollTick() {
  await poll();
  _scheduleNextPoll();
}

// Poll Spotify right now (debounced) — call on any UI action that changes
// playback (play/pause/skip/seek). The debounce coalesces command bursts and
// gives Spotify's state a moment to settle before we read it back.
function refreshNow(reason) {
  if (!_polling) return;
  clearTimeout(_pollTimeout);
  _pollTimeout = setTimeout(_pollTick, POLL_REFRESH_DEBOUNCE);
  if (reason) console.log(`[Spotify] immediate refresh (${reason})`);
}

function startPolling() {
  if (_polling) return;
  _polling = true;
  _pollTick(); // immediate first poll, then self-schedules adaptively

  // Background jobs are STAGGERED so they never storm Spotify alongside the first
  // interactive loads (player/queue/playlists). Each job also self-gates on
  // _spotifyRateLimited() so a ban pauses them. The seed is delayed (not fired
  // immediately) to give the live player a clean first read; its own in-flight
  // guard prevents overlap with the hourly refresh.
  if (_seedTimestamp === 0) {
    setTimeout(() => seedFromSpotify().catch(() => {}), SEED_START_DELAY);
  }
  // Reconcile away-listening, first run ~1 min after startup, then on its interval.
  if (!_reconcileTimer) {
    setTimeout(() => reconcileRecentlyPlayed().catch(() => {}), RECONCILE_START_DELAY);
    _reconcileTimer = setInterval(
      () => reconcileRecentlyPlayed().catch(() => {}),
      RECONCILE_INTERVAL
    );
  }
  // Warm audio features for the whole library — the heaviest job, last and latest,
  // then re-scans every few hours for newly-liked songs.
  if (!_featureWarmTimer) {
    setTimeout(() => warmFeatureLibrary().catch(() => {}), FEATURE_WARM_START_DELAY);
    _featureWarmTimer = setInterval(() => warmFeatureLibrary().catch(() => {}), FEATURE_WARM_INTERVAL);
  }
  // Backfill artist genres for the Genres tab — runs after seeding so history is
  // populated, then self-reschedules in small batches until every artist is covered.
  if (!_genreBackfillTimer) {
    _genreBackfillTimer = setTimeout(() => backfillArtistGenres().catch(() => {}), GENRE_BACKFILL_START_DELAY);
  }
}

function stopPolling() {
  _polling = false;
  if (_pollTimeout) {
    clearTimeout(_pollTimeout);
    _pollTimeout = null;
  }
  if (_reconcileTimer) {
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
  }
  if (_featureWarmTimer) {
    clearInterval(_featureWarmTimer);
    _featureWarmTimer = null;
  }
  if (_genreBackfillTimer) {
    clearTimeout(_genreBackfillTimer);
    _genreBackfillTimer = null;
  }
  // Close any active session so time isn't lost on graceful shutdown
  closeActiveSession();
  // Flush any pending features writes so nothing fetched right before shutdown is lost
  if (_featuresDBSaveTimer) { clearTimeout(_featuresDBSaveTimer); _featuresDBSaveTimer = null; }
  if (_featuresDBDirty) saveFeaturesDB();
  // Flush the taste profile too
  if (_tasteSaveTimer) { clearTimeout(_tasteSaveTimer); _tasteSaveTimer = null; }
  if (_tasteDirty) saveTasteProfile();
}

// ---------------------------------------------------------------------------
// Smart shuffle playlist play
// ---------------------------------------------------------------------------

// Play a playlist as a plain Spotify context. When the playlist drains and the
// Smart Queue toggle is ON, the poll loop's playlist-end detector arms a Smart
// Queue session that weaves our picks into Spotify's native autoplay stream.
async function playPlaylist(playlistUri /*, playlistId */) {
  // Manual playlist change → clear the queue (stop any Smart Queue session + wipe
  // staged accounting) so the previous selection's picks don't linger, then start
  // the fresh playlist context.
  _sqClearQueue('playlist-play');
  await play({ contextUri: playlistUri });
  await setShuffle(true);
  await setRepeat('off');
}

// ---------------------------------------------------------------------------
// Socket setup
// ---------------------------------------------------------------------------

function init(io) {
  _io = io;

  // Apply the configured display timezone FIRST so every Date local method runs
  // in the right zone for the rest of the process (vibes, slots, heatmap, etc.).
  try {
    const cfg = loadCfg();
    if (cfg && cfg.timeZone) {
      if (applyDisplayTZ(cfg.timeZone)) console.log(`[Spotify] Display timezone: ${_displayTZ}`);
      else console.warn(`[Spotify] Ignoring invalid configured timeZone "${cfg.timeZone}"`);
    }
  } catch (err) { console.error('[Spotify] timezone init error:', err.message); }

  loadHistory();
  loadSessions();
  loadVibeNames();
  loadUserPrefs();
  loadFeaturesDB();
  loadTasteProfile();
  loadFeelingLog();
  loadBreakerState(); // restore an in-progress hard ban so a restart stays quiet
  loadLiveState(); // after loadSessions so stale-session finalize can de-dupe

  // One health line per minute (idle minutes skipped). unref so it never keeps
  // the process alive on its own.
  if (!_healthTimer) {
    _healthTimer = setInterval(_logHealth, 60000);
    if (_healthTimer.unref) _healthTimer.unref();
  }

  // Start polling if already authed
  if (isAuthed()) {
    startPolling();
  }

  io.on('connection', async (socket) => {
    // Send auth status on connect
    try {
      const authStatus = await getAuthStatus();
      socket.emit('spotify:auth_status', authStatus);
    } catch (err) {
      console.error('[Spotify] Auth status error:', err.message);
      socket.emit('spotify:auth_status', { connected: false, configured: false });
    }

    // Send last known state if available
    if (_lastState) {
      socket.emit('spotify:state', _lastState);
    }

    // Send the Smart Queue toggle state so the Playback panel renders correctly
    socket.emit('spotify:smart_queue', { enabled: _smartQueueEnabled });

    // ----- spotify:cmd -----
    socket.on('spotify:cmd', async ({ action, ...args } = {}) => {
      try {
        switch (action) {
          case 'play':
            // Single track from search.
            if (args.uris?.length === 1 && !args.contextUri) {
              if (_smartQueueEnabled) {
                // Smart Queue ON → seed the track, then weave OUR picks into a
                // self-sourced Spotify-recommendation discovery stream.
                await _sqStartFromSeed('search', args.uris[0], null, true);
              } else {
                // Toggle OFF → still run an anchors-ONLY session (weave=false, 0%
                // ours) so the music keeps going. A bare uris-play won't autoplay
                // via the Web API, so we source pure Spotify recommendations and
                // enqueue them ourselves — but add nothing of our own.
                // (_sqStartFromSeed clears the queue first.)
                await _sqStartFromSeed('search', args.uris[0], null, false);
              }
            } else {
              // Manual multi-track / context play → clear the queue, then play.
              _sqClearQueue('multi-uri-play');
              await play(args);
            }
            setTimeout(emitQueue, 2000);
            break;

          case 'pause':
            await pause();
            break;

          case 'resume':
            await play({});
            break;

          case 'next':
            await next();
            _autoQueueCount = Math.max(0, _autoQueueCount - 1);
            setTimeout(emitQueue, 2000);
            break;

          case 'prev':
            await prev();
            setTimeout(emitQueue, 2000);
            break;

          case 'seek':
            await seek(args.positionMs);
            break;

          case 'shuffle':
            await setShuffle(args.state);
            break;

          case 'repeat':
            await setRepeat(args.state);
            break;

          case 'volume':
            await setVolume(args.percent);
            break;

          case 'transfer':
            await transferPlayback(args.deviceId, args.play ?? true);
            break;

          case 'queue_add': {
            // Manual add from search — APPEND to the end of the queue via the
            // queue endpoint. NON-destructive: no play()/context rebuild (that
            // method wipes Spotify's queue and breaks the Smart Queue). Because
            // the engine feeds one song at a time, the physical queue is nearly
            // empty, so "end of queue" is effectively right behind the next pick.
            await addToQueue(args.uri);
            const _qid = args.id || (args.uri && args.uri.startsWith('spotify:track:') ? args.uri.split(':').pop() : null);
            _markPlayed(_qid);
            _addStaged([args.uri]);
            // Mirror it into the in-memory window (marked userQueued) so the panel
            // shows it and the engine ignores it in all calculations.
            _sqRegisterUserQueued(args);
            setTimeout(emitQueue, 1500);
            break;
          }

          case 'like':
            // Feb 2026: now takes URI (spotify:track:...) not bare ID
            await likeTrack(args.trackUri);
            if (_lastState) {
              _lastState.liked = true;
              _io.emit('spotify:state', _lastState);
            }
            break;

          case 'unlike':
            await unlikeTrack(args.trackUri);
            if (_lastState) {
              _lastState.liked = false;
              _io.emit('spotify:state', _lastState);
            }
            break;

          case 'playlist_play':
            _autoQueueCount = 0;
            await playPlaylist(args.playlistUri, args.playlistId);
            setTimeout(emitQueue, 2000);
            break;

          default:
            console.warn('[Spotify] Unknown command action:', action);
            socket.emit('spotify:error', { message: `Unknown action: ${action}` });
            return;
        }

        // Refresh immediately (debounced) to pick up the change and re-anchor the
        // adaptive poll schedule around the new playback state.
        refreshNow(action);
      } catch (err) {
        const status = err.status ? ` (HTTP ${err.status})` : '';
        console.error(`[Spotify] Command error (${action})${status}:`, err.message);
        if (err.body) console.error(`[Spotify] Full Spotify error:`, JSON.stringify(err.body));
        if (err.status === 403) {
          const tokens = loadTokens();
          const storedScopes = tokens && tokens.scope ? tokens.scope : '(none saved)';
          console.error(`[Spotify] 403 on ${action} — stored token scopes: ${storedScopes}`);
        }
        socket.emit('spotify:error', { message: `${action} failed${status}: ${err.message}` });
        // Re-poll so any optimistically-toggled UI (shuffle, repeat) snaps back to real state
        refreshNow(`${action}-failed`);
      }
    });

    // ----- spotify:search -----
    socket.on('spotify:search', async ({ query, type = 'track' } = {}) => {
      const validTypes = ['track', 'artist', 'album', 'playlist'];
      const searchType = validTypes.includes(type) ? type : 'track';
      try {
        const results = await search(query, searchType, 10);
        let items = [];

        if (searchType === 'track') {
          items = (results?.tracks?.items || []).map((t) => ({
            type: 'track',
            id: t.id, uri: t.uri,
            title: t.name,
            artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
            album: t.album ? t.album.name : '',
            albumArt: t.album?.images?.[0]?.url || null,
            duration: t.duration_ms,
          }));
        } else if (searchType === 'artist') {
          items = (results?.artists?.items || []).map((a) => ({
            type: 'artist',
            id: a.id, uri: a.uri,
            name: a.name,
            genres: (a.genres || []).slice(0, 2).join(', '),
            image: a.images?.[0]?.url || null,
            followers: a.followers?.total || 0,
          }));
        } else if (searchType === 'album') {
          items = (results?.albums?.items || []).map((al) => ({
            type: 'album',
            id: al.id, uri: al.uri,
            name: al.name,
            artist: al.artists ? al.artists.map((a) => a.name).join(', ') : '',
            image: al.images?.[0]?.url || null,
            year: al.release_date ? al.release_date.slice(0, 4) : '',
            total: al.total_tracks || 0,
          }));
        } else if (searchType === 'playlist') {
          items = (results?.playlists?.items || []).filter(Boolean).map((p) => ({
            type: 'playlist',
            id: p.id, uri: p.uri,
            name: p.name,
            owner: p.owner?.display_name || '',
            image: p.images?.[0]?.url || null,
            total: p.tracks?.total || 0,
          }));
        }

        socket.emit('spotify:search_results', { type: searchType, items });
      } catch (err) {
        console.error('[Spotify] Search error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_artist_ratings -----
    // Recently-played artists + play counts + current rating, for the profile panel's
    // "rate your artists" tab. In-memory only (no Spotify API calls).
    socket.on('spotify:get_artist_ratings', () => {
      try {
        socket.emit('spotify:artist_ratings', { items: _artistRatingList() });
      } catch (err) {
        console.error('[Spotify] get_artist_ratings error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:set_artist_rating -----
    // { artist, rating }  rating ∈ {2 Love,1 Like,0 Neutral,-1 Dislike,-2 Never} or
    // null to clear. The explicit rating overrides the learned/play-count loved heuristic.
    socket.on('spotify:set_artist_rating', ({ artist, rating } = {}) => {
      try {
        const ok = _setArtistRating(artist, rating);
        if (ok) {
          console.log(`[Spotify] Artist rating: "${artist}" → ${rating == null ? 'cleared' : rating}`);
          _io.emit('spotify:artist_ratings', { items: _artistRatingList() });
        } else {
          socket.emit('spotify:error', { message: 'Invalid artist rating' });
        }
      } catch (err) {
        console.error('[Spotify] set_artist_rating error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_playlists -----
    // ownedOnly=true  → filter to playlists the user can modify (for the "add to playlist" picker)
    // ownedOnly=false → return all playlists (for the playlist browser card)
    socket.on('spotify:get_playlists', async ({ ownedOnly = false, refresh = false } = {}) => {
      try {
        if (!_userId) await getUserProfile();
        console.log(`[Spotify] get_playlists: userId=${_userId} ownedOnly=${ownedOnly} refresh=${refresh}`);

        const data = await getAllPlaylists(refresh);
        const playlists =
          data && data.items
            ? data.items
                .filter((p) => {
                  if (!ownedOnly) return true;
                  const owned = p.owner && p.owner.id === _userId;
                  const allowed = owned || p.collaborative === true;
                  if (!allowed) console.log(`[Spotify] Picker: excluding "${p.name}" (owner: ${p.owner && p.owner.id})`);
                  return allowed;
                })
                .map((p) => ({
                  id: p.id,
                  uri: p.uri,
                  name: p.name,
                  coverUrl:
                    p.images && p.images.length > 0 ? p.images[0].url : null,
                  total: p.tracks ? p.tracks.total : 0,
                  owner: p.owner ? p.owner.display_name : '',
                }))
            : [];
        socket.emit('spotify:playlists', { items: playlists });
      } catch (err) {
        console.error('[Spotify] Get playlists error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_playlist_tracks -----
    socket.on('spotify:get_playlist_tracks', async ({ playlistId } = {}) => {
      try {
        const allItems = await getAllPlaylistTracks(playlistId);
        const tracks = allItems
          // Feb 2026: response field renamed track → item; fall back for safety
          .map((entry) => entry.item || entry.track)
          .filter((t) => t && t.id)
          .map((t) => ({
            id: t.id,
            uri: t.uri,
            title: t.name,
            artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
            duration: t.duration_ms,
          }));
        socket.emit('spotify:playlist_tracks', { playlistId, tracks });
      } catch (err) {
        console.error('[Spotify] Get playlist tracks error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_liked_songs -----
    socket.on('spotify:get_liked_songs', async ({ refresh = false } = {}) => {
      try {
        const allItems = await getAllLikedSongs('high', refresh);
        const tracks = allItems
          // Feb 2026: response field renamed track → item; keep both for safety
          .map((entry) => entry.item || entry.track)
          .filter((t) => t && t.id)
          .map((t) => ({
            id: t.id,
            uri: t.uri,
            title: t.name,
            artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
            duration: t.duration_ms,
          }));
        socket.emit('spotify:liked_songs', { tracks });
      } catch (err) {
        console.error('[Spotify] Get liked songs error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_audio_features -----
    socket.on('spotify:get_audio_features', async ({ trackId } = {}) => {
      if (!trackId) return;
      try {
        const f = await getAudioFeatures(trackId);
        socket.emit('spotify:audio_features', _serializeFeatures(f));
      } catch (err) {
        console.error('[Spotify] Audio features error:', err.message);
        socket.emit('spotify:audio_features', null);
      }
    });

    // ----- spotify:get_batch_audio_features -----
    socket.on('spotify:get_batch_audio_features', async ({ trackIds } = {}) => {
      if (!trackIds || !trackIds.length) return;
      try {
        const features = await getBatchAudioFeatures(trackIds);
        socket.emit('spotify:batch_audio_features', {
          features: features.map((f) => _serializeFeatures(f)),
        });
      } catch (err) {
        console.error('[Spotify] Batch audio features error:', err.message);
        socket.emit('spotify:batch_audio_features', { features: [] });
      }
    });

    // ----- spotify:get_stats -----
    socket.on('spotify:get_stats', () => {
      socket.emit('spotify:stats', buildStats());
    });

    // ----- spotify:get_sessions -----
    socket.on('spotify:get_sessions', () => {
      const past = [..._sessions]
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, 100)
        .map(s => ({ ...s, ...sessionDominantVibe(s) }));
      socket.emit('spotify:sessions', { sessions: past });
    });

    // ----- spotify:get_session_tracks -----
    socket.on('spotify:get_session_tracks', async ({ id } = {}) => {
      const session = _sessions.find(s => s.id === id);
      if (!session) { socket.emit('spotify:session_tracks', { id, tracks: [] }); return; }
      try {
        const tracks = await resolveTrackIds(session.trackIds || []);
        socket.emit('spotify:session_tracks', { id, tracks });
      } catch (err) {
        console.error('[Spotify] get_session_tracks error:', err.message);
        socket.emit('spotify:session_tracks', { id, tracks: [], error: err.message });
      }
    });

    // ----- spotify:queue_session -----
    socket.on('spotify:queue_session', async ({ id } = {}) => {
      const session = _sessions.find(s => s.id === id);
      if (!session) { socket.emit('spotify:session_queued', { id, count: 0, error: 'Session not found' }); return; }
      try {
        const tracks = await resolveTrackIds(session.trackIds || []);
        let count = 0;
        for (const t of tracks) {
          if (await _queueTrack(t)) count++;
        }
        socket.emit('spotify:session_queued', { id, count });
      } catch (err) {
        console.error('[Spotify] queue_session error:', err.message);
        socket.emit('spotify:session_queued', { id, count: 0, error: err.message });
      }
    });

    // ----- spotify:reset_session -----
    socket.on('spotify:reset_session', () => {
      try {
        resetSessionState();
        _io.emit('spotify:stats', buildStats());
        _emitIntelligenceState();
        // Explicit success ack so the UI can confirm the refresh with a toast.
        _io.emit('spotify:session_reset', { ok: true, msg: 'Music intelligence refreshed' });
      } catch (err) {
        console.error('[Spotify] reset_session failed:', err.message);
        _io.emit('spotify:session_reset', { ok: false, msg: 'Reset failed — check server logs' });
      }
    });

    // ----- spotify:save_session_playlist -----
    socket.on('spotify:save_session_playlist', async ({ name, sessionId } = {}) => {
      try {
        if (!_userId) await getUserProfile();

        // A sessionId targets a past session; otherwise save the live UI session.
        let tracks;
        if (sessionId) {
          const session = _sessions.find(s => s.id === sessionId);
          tracks = session ? await resolveTrackIds(session.trackIds || []) : [];
        } else {
          tracks = _sessionStats.tracksPlayed;
        }
        if (!tracks.length) {
          socket.emit('spotify:session_playlist_saved', { error: 'No tracks in this session yet.' });
          return;
        }

        // Deduplicate URIs while preserving play order
        const seen = new Set();
        const uris = [];
        for (const t of tracks) {
          const uri = t.uri || (t.id ? `spotify:track:${t.id}` : null);
          if (uri && !seen.has(uri)) {
            seen.add(uri);
            uris.push(uri);
          }
        }

        const playlistName = name && name.trim()
          ? name.trim()
          : `Session · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

        const description = `${uris.length} track${uris.length !== 1 ? 's' : ''} · Saved from VoiceMeeter Control Panel`;

        const playlist = await createPlaylist(_userId, playlistName, description);

        // Add in batches of 100 (Spotify limit)
        for (let i = 0; i < uris.length; i += 100) {
          await addTracksToPlaylist(playlist.id, uris.slice(i, i + 100));
        }

        socket.emit('spotify:session_playlist_saved', {
          success: true,
          name: playlistName,
          playlistId: playlist.id,
          url: `https://open.spotify.com/playlist/${playlist.id}`,
          trackCount: uris.length,
        });
      } catch (err) {
        console.error('[Spotify] Save session playlist error:', err.message);
        socket.emit('spotify:session_playlist_saved', { error: err.message });
      }
    });

    // ----- spotify:get_insights -----
    socket.on('spotify:get_insights', () => {
      try {
        // Serve whatever we have RIGHT NOW so the panel restores instantly on a
        // page refresh — never block the response on a slow Spotify round-trip.
        socket.emit('spotify:insights', buildInsightsPayload());

        // If the seed cache is empty or stale (> 1 hour), refresh it in the
        // background and re-emit once it lands. The client has a persistent
        // 'spotify:insights' listener that picks up this second payload.
        if (Date.now() - _seedTimestamp > 3600000) {
          seedFromSpotify()
            .then(() => socket.emit('spotify:insights', buildInsightsPayload()))
            .catch((e) => console.error('[Spotify] background reseed failed:', e.message));
        }
      } catch (err) {
        console.error('[Spotify] get_insights error:', err.message);
        socket.emit('spotify:insights', { error: err.message });
      }
    });

    // ----- spotify:rename_vibe -----
    socket.on('spotify:rename_vibe', ({ key, name } = {}) => {
      if (!key || !name) return;
      _vibeNames[key] = name.trim();
      saveVibeNames();
      _io.emit('spotify:vibe_renamed', { key, name: name.trim() });
    });

    // ----- spotify:play_vibe -----
    socket.on('spotify:play_vibe', async ({ key } = {}) => {
      try {
        // Smart Queue is ALWAYS the engine for vibes: pick the single
        // highest-confidence seed, play it, then weave our picks into a
        // self-sourced Spotify-recommendation discovery stream.
        const seed = await _sqPickMoodVibeSeed('vibe', key);
        if (!seed || !(seed.uri || seed.id)) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Not enough data for this vibe' });
          return;
        }
        _activeVibeKey = key;
        _activeMoodKey = null;
        _activeMixTarget = null;
        _activeFeeling = null;
        const seedUri = seed.uri || `spotify:track:${seed.id}`;
        await _sqStartFromSeed('vibe', seedUri, seed);
        const label = getVibeName(key);
        socket.emit('spotify:insights_action', { ok: true, msg: `Smart Queue · "${label}" · weaving ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: key });
        _emitIntelligenceState(); // push the full state (incl. activePoolSize) so the pool count shows immediately
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:play_mood -----
    socket.on('spotify:play_mood', async ({ key } = {}) => {
      try {
        const mood = MOOD_STATES.find(m => m.key === key);
        if (!mood) return;
        // Smart Queue is ALWAYS the engine for moods: single highest-confidence
        // seed → play → weave our picks into a self-sourced discovery stream.
        const seed = await _sqPickMoodVibeSeed('mood', key);
        if (!seed || !(seed.uri || seed.id)) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Not enough history for this mood yet' });
          return;
        }
        _activeMoodKey = key;
        _activeVibeKey = null;
        _activeMixTarget = null;
        _activeFeeling = null;
        const seedUri = seed.uri || `spotify:track:${seed.id}`;
        await _sqStartFromSeed('mood', seedUri, seed);
        socket.emit('spotify:insights_action', { ok: true, msg: `Smart Queue · "${mood.name}" · weaving ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: key, activeVibeKey: null });
        _emitIntelligenceState(); // push the full state (incl. activePoolSize) so the pool count shows immediately
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:play_mix -----
    // The unified entry point: { energy, valence } is a point on the mood map (a
    // freeform pad pick OR a named cluster's centroid, optionally with label/vibeKey).
    // Builds the seed from that target, plays it, and weaves more on-target picks ∞.
    socket.on('spotify:play_mix', async ({ energy, valence, label, vibeKey, spread, genre } = {}) => {
      try {
        const e = _clampNum(Number(energy), 0, 100);
        const v = _clampNum(Number(valence), 0, 100);
        if (Number.isNaN(e) || Number.isNaN(v)) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Invalid spot on the map' });
          return;
        }
        const genreKey = (genre && genre !== 'any' && GENRE_BUCKET_BY_KEY[genre]) ? genre : null;
        const target = {
          energy: e, valence: v,
          spread:  (spread != null && !Number.isNaN(Number(spread))) ? _clampNum(Number(spread), 0.05, 0.4) : 0.15,
          label:   label || null,
          vibeKey: vibeKey || null,
          genre:   genreKey,
        };
        const seedPool = await buildMixFromTarget(target, 12);
        const seed = (seedPool || []).find(t => t && (t.uri || t.id));
        if (!seed) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'No songs near that spot yet — keep listening' });
          return;
        }
        _activeMixTarget = target;
        _activeMoodKey = null;
        _activeVibeKey = null;
        _activeFeeling = null;
        const seedUri = seed.uri || `spotify:track:${seed.id}`;
        await _sqStartFromSeed('mix', seedUri, seed);
        const lbl = _mixTargetLabel(target);
        socket.emit('spotify:insights_action', { ok: true, msg: `Smart Queue · "${lbl}" · weaving ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null, activeMix: _activeMixState() });
        _emitIntelligenceState();
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:get_mix_map -----  (Mixes/Genres tab: heat grid + anchors + points)
    // Optional { genre } filters the heat-cloud to a macro-genre (Genres tab). The
    // response echoes `genre` so the client routes it to the right pad.
    socket.on('spotify:get_mix_map', ({ genre } = {}) => {
      try {
        const genreKey = (genre && genre !== 'any' && GENRE_BUCKET_BY_KEY[genre]) ? genre : null;
        socket.emit('spotify:mix_map', { ...computeMixMap(genreKey), activeMix: _activeMixState() });
      } catch (err) {
        console.error('[Spotify] get_mix_map error:', err.message);
        socket.emit('spotify:mix_map', { ready: false, error: err.message });
      }
    });

    // ----- spotify:get_genre_profile -----  (Genres tab: macro-genre chips)
    socket.on('spotify:get_genre_profile', () => {
      try {
        socket.emit('spotify:genre_profile', computeGenreProfile());
      } catch (err) {
        console.error('[Spotify] get_genre_profile error:', err.message);
        socket.emit('spotify:genre_profile', { ready: false, buckets: [], error: err.message });
      }
    });

    // ----- spotify:stop_continuous -----
    socket.on('spotify:stop_continuous', () => {
      _sqStop('stop_continuous');
      _activeMoodKey = null;
      _activeVibeKey = null;
      _activeMixTarget = null;
      _activeFeeling = null;
      _pendingCheckIn = null;
      _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null, activeMix: null });
      _io.emit('spotify:feeling_expired');
      _emitIntelligenceState();
    });

    // ----- spotify:get_intelligence -----
    socket.on('spotify:get_intelligence', () => {
      socket.emit('spotify:intelligence_state', {
        activeFeeling:   _activeFeeling ? { key: _activeFeeling.key, label: _activeFeeling.label, emoji: _activeFeeling.emoji } : null,
        activeMoodKey:   _activeMoodKey,
        activeMoodName:  _activeMoodKey ? (MOOD_STATES.find(m => m.key === _activeMoodKey)?.name || null) : null,
        activeVibeKey:   _activeVibeKey,
        activeMix:       _activeMixState(),
        activePoolSize:  _activePoolSize(),
        clusterSize:     _currentCluster.length,
        clusterCentroid: _currentCentroid,
        pendingCheckIn:  _pendingCheckIn ? { guessedFeeling: _pendingCheckIn.guessedFeeling } : null,
        context:         detectCurrentContext(),
        checkInAuto:     _checkInAutoEnabled,
        feelings:        Object.entries(FEELING_DEFS).map(([key, def]) => ({ key, ...def })),
      });
    });

    // ----- spotify:get_portraits -----  (Portraits tab: #9 + #5)
    socket.on('spotify:get_portraits', () => {
      try {
        socket.emit('spotify:portraits', {
          timeMachine: buildTimeMachine(),
          portraits:   buildPortraits(),
          dayRecap:    buildDayRecap(),   // #7 your day in music
        });
      } catch (err) {
        console.error('[Spotify] get_portraits error:', err.message);
        socket.emit('spotify:portraits', { timeMachine: null, portraits: [], dayRecap: null });
      }
    });

    // ----- spotify:time_machine_play -----  seed the engine from a past same-slot play
    socket.on('spotify:time_machine_play', async () => {
      try {
        const tm = buildTimeMachine();
        const seed = tm && tm.seed;
        if (!seed || !seed.uri) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Not enough history for this time slot yet' });
          return;
        }
        _activeMoodKey = null; _activeVibeKey = null; _activeMixTarget = null; _activeFeeling = null;
        await _sqStartFromSeed('rightnow', seed.uri, {
          uri: seed.uri, id: seed.id, title: seed.title, artist: seed.artist,
        });
        socket.emit('spotify:insights_action', { ok: true, msg: `Time machine · ${seed.title || 'your past vibe'} 🕰️` });
        _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null });
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:checkin_response -----
    socket.on('spotify:checkin_response', async ({ feeling } = {}) => {
      if (!_pendingCheckIn || !FEELING_DEFS[feeling]) return;

      // Verify the current cluster still matches the check-in fingerprint
      if (_currentCentroid) {
        const drift = _clusterDist(_pendingCheckIn.fingerprint, _currentCentroid);
        if (drift > 0.30) {
          // Cluster has drifted — discard answer silently, generate fresh check-in
          _pendingCheckIn = null;
          socket.emit('spotify:checkin_stale');
          // If current cluster is already confident, trigger a new check-in
          if (_currentCluster.length >= 5) _triggerCheckIn();
          return;
        }
      }

      const def = FEELING_DEFS[feeling];

      // A check-in answer is a LABEL, not a command. The user is telling us "I've
      // been feeling like this while listening to these songs" — so we just record
      // the association (it trains the slot prediction) and leave whatever is
      // currently playing completely untouched. No new queue.
      _recordFeeling(feeling, _pendingCheckIn.fingerprint, _pendingCheckIn.clusterSnapshot);
      _pendingCheckIn = null;

      _emitIntelligenceState(); // refresh prediction with the new label
      socket.emit('spotify:insights_action', { ok: true, msg: `Got it · ${def.emoji} "${def.label}" — I'll remember this` });
    });

    // ----- spotify:dismiss_checkin -----
    socket.on('spotify:dismiss_checkin', () => {
      _pendingCheckIn = null;
      // Bump the threshold so we don't re-trigger until 15 more tracks
      _lastCheckInAt = _currentCluster.length;
    });

    // ----- spotify:set_checkin_auto -----
    socket.on('spotify:set_checkin_auto', ({ enabled } = {}) => {
      _checkInAutoEnabled = !!enabled;
      saveUserPrefs();
      _io.emit('spotify:checkin_auto', { enabled: _checkInAutoEnabled });
    });

    // ----- spotify:stop_feeling -----
    socket.on('spotify:stop_feeling', () => {
      _sqStop('stop_feeling');
      _activeFeeling = null;
      _activeMoodKey = null;
      _activeVibeKey = null;
      _pendingCheckIn = null;
      _io.emit('spotify:feeling_expired');
      _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null });
      _emitIntelligenceState();
    });

    // ----- spotify:get_tuning -----
    socket.on('spotify:get_tuning', () => {
      socket.emit('spotify:tuning', { tuning: { ..._tuning }, defaults: { ...TUNING_DEFAULTS } });
    });

    // ----- spotify:set_tuning -----
    socket.on('spotify:set_tuning', (patch = {}) => {
      _applyTuning(patch && patch.tuning ? patch.tuning : patch);
      saveUserPrefs();
      _io.emit('spotify:tuning', { tuning: { ..._tuning }, defaults: { ...TUNING_DEFAULTS } });
      console.log('[Spotify] Tuning updated:', JSON.stringify(_tuning));
    });

    // ----- spotify:get_moods -----
    socket.on('spotify:get_moods', () => {
      const context = detectCurrentContext();
      socket.emit('spotify:moods', {
        moods: MOOD_STATES.map(({ key, name, emoji, desc, feeling }) => ({ key, name, emoji, desc, feeling })),
        activeMoodKey: _activeMoodKey,
        activeVibeKey: _activeVibeKey,
        context,
      });
    });

    // ----- spotify:get_context -----
    socket.on('spotify:get_context', () => {
      socket.emit('spotify:context', detectCurrentContext());
    });

    // ----- spotify:play_now -----  (Right Now tab)
    socket.on('spotify:play_now', async () => {
      try {
        const rn = computeRightNow();
        if (!rn.ready) return;
        // Smart Queue engine: seed with the strongest right-now pick, then weave
        // more right-now picks into a self-sourced discovery stream.
        const seed = (rn.topTracks || []).find(t => t && (t.uri || t.id));
        if (!seed) return;
        _activeVibeKey = rn.vibeKey || null;
        _activeMoodKey = null;
        _activeMixTarget = null;
        _activeFeeling = null;
        const seedUri = seed.uri || `spotify:track:${seed.id}`;
        await _sqStartFromSeed('rightnow', seedUri, seed);
        socket.emit('spotify:insights_action', { ok: true, msg: `Smart Queue for right now · weaving ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: _activeVibeKey });
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:get_devices -----
    socket.on('spotify:get_devices', async () => {
      try {
        const data = await getDevices();
        const items =
          data && data.devices ? data.devices.map(serializeDevice) : [];
        socket.emit('spotify:devices', { devices: items });
      } catch (err) {
        console.error('[Spotify] Get devices error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_queue -----
    socket.on('spotify:get_queue', async () => {
      try {
        const data = await getQueue();
        const rawQueue = (data && Array.isArray(data.queue)) ? data.queue : [];
        _sqRememberMeta(rawQueue);
        if (data && data.currently_playing) _sqRememberMeta([data.currently_playing]);

        let items;
        if (_sq && Array.isArray(_sq.window) && _sq.window.length) {
          _sqWindowAnnotations();
          items = _sqPanelItems();
        } else {
          const ann = _sqWindowAnnotations();
          items = rawQueue.slice(0, 30).map((t) => {
            const a = _sqAnnotationFor(ann, t);
            return {
              id: t.id,
              uri: t.uri,
              title: t.name,
              artist: t.artists ? t.artists.map((x) => x.name).join(', ') : '',
              albumArt:
                t.album && t.album.images && t.album.images.length > 0
                  ? t.album.images[0].url
                  : null,
              duration: t.duration_ms,
              source: a ? a.source : undefined,
              reason: a ? a.reason : undefined,
              smoothMix: a ? a.smoothMix : undefined,
            };
          });
        }
        socket.emit('spotify:queue', { items, meta: _sqInsightStrip() });
      } catch (err) {
        console.error('[Spotify] Get queue error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:add_to_playlist -----
    socket.on('spotify:add_to_playlist', async ({ trackUri, playlistId } = {}) => {
      try {
        console.log(`[Spotify] add_to_playlist: playlistId=${playlistId} trackUri=${trackUri} userId=${_userId}`);
        await addTracksToPlaylist(playlistId, [trackUri]);
        socket.emit('spotify:toast', { message: 'Added to playlist ✓' });
      } catch (err) {
        const status = err.status ? ` (HTTP ${err.status})` : '';
        const tokens = loadTokens();
        const storedScopes = tokens && tokens.scope ? tokens.scope : '(none saved)';
        console.error(`[Spotify] Add to playlist error${status}:`, err.message);
        console.error(`[Spotify] Stored token scopes: ${storedScopes}`);
        console.error(`[Spotify] Full Spotify error:`, JSON.stringify(err.body));
        socket.emit('spotify:error', { message: `Add to playlist failed${status}: ${err.message}` });
      }
    });

    // ----- spotify:save_config -----
    socket.on('spotify:save_config', ({ clientId, clientSecret } = {}) => {
      try {
        // Merge so other settings (e.g. timeZone) survive a credentials save.
        const cur = loadCfg() || {};
        saveCfg({ ...cur, clientId, clientSecret });
        socket.emit('spotify:config_saved', { success: true });
      } catch (err) {
        console.error('[Spotify] Save config error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_timezone -----
    socket.on('spotify:get_timezone', () => {
      socket.emit('spotify:timezone', {
        timeZone: _displayTZ,
        hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      });
    });

    // ----- spotify:set_timezone -----
    // Authoritative override for the host clock. Persists the IANA zone, applies
    // it live, then repairs past log entries (recompute h/dow from each ts) so
    // historical vibes/slots/heatmap are corrected — not just shifted visually.
    socket.on('spotify:set_timezone', ({ timeZone, migrate = true } = {}) => {
      try {
        if (!applyDisplayTZ(timeZone)) {
          socket.emit('spotify:error', { message: `Invalid timezone "${timeZone}"` });
          return;
        }
        const cur = loadCfg() || {};
        saveCfg({ ...cur, timeZone });
        const summary = migrate ? migrateHistoryTimezone() : null;
        io.emit('spotify:timezone', {
          timeZone: _displayTZ,
          hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          migrated: summary,
        });
        // Invalidate the cached context prediction so corrected h/dow counts
        // immediately; the client re-requests insights on the 'timezone' event.
        _contextProfilesAt = 0;
      } catch (err) {
        console.error('[Spotify] Set timezone error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:disconnect -----
    socket.on('spotify:disconnect', () => {
      _sqStop('disconnect');
      stopPolling();
      deleteTokens();
      _lastState = null;
      _lastTrackId = null;
      _autoQueueCount = 0;
      _userProfile = null;
      _userId = null;
      io.emit('spotify:auth_status', { connected: false, configured: true });
      io.emit('spotify:state', null);
    });

    // ----- spotify:get_smart_queue -----
    socket.on('spotify:get_smart_queue', () => {
      socket.emit('spotify:smart_queue', { enabled: _smartQueueEnabled });
    });

    // ----- spotify:set_smart_queue -----
    // The single toggle that replaces the old Autoplay + Smart Shuffle controls.
    // ON  → weave our picks into Spotify autoplay for search & playlist-end too.
    // OFF → search/playlist fall back to plain Spotify autoplay; moods/vibes still
    //       use Smart Queue (they always do).
    socket.on('spotify:set_smart_queue', ({ enabled } = {}) => {
      _smartQueueEnabled = !!enabled;
      saveUserPrefs();
      console.log('[Spotify] Smart Queue set to:', _smartQueueEnabled);
      if (!_smartQueueEnabled && _sq && (_sq.source === 'search' || _sq.source === 'playlist')) {
        // Turning it off mid-search/playlist session → hand control back to Spotify.
        _sqStop('toggle-off');
      }
      _io.emit('spotify:smart_queue', { enabled: _smartQueueEnabled });
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  isConfigured,
  isAuthed,
  getAuthUrl,
  exchangeCode,
  getAuthStatus,
  getUserProfile,
  startPolling,
  stopPolling,
  loadCfg,
};
