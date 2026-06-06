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
const POLL_INTERVAL = 5000;
const AUTOPLAY_MIN_QUEUE = 3;

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

// ── Background feature warming ────────────────────────────────────────────────
// An idle-time job that fetches audio features for the WHOLE saved library + top
// tracks (not just songs replayed live), so energy/valence mood & vibe matching
// can draw from the entire library instead of only recent history.
const FEATURE_WARM_START_DELAY = 2 * 60 * 1000;      // first run 2 min after startup
const FEATURE_WARM_INTERVAL    = 6 * 60 * 60 * 1000; // re-scan every 6h for newly-liked songs
const FEATURE_WARM_DELAY_MS    = 1200;               // gentle pause between each ReccoBeats fetch

const SESSION_PRUNE_DAYS       = 90;
// Unified queue cap: every auto-queue feature (mood, vibe, feeling, autoplay,
// smart shuffle) keeps at most this many tracks staged upcoming. We top the
// queue back up to this target whenever it drops below it.
const QUEUE_TARGET                = 5;  // max upcoming tracks staged at any time
const CONTINUOUS_REFILL_THRESHOLD = QUEUE_TARGET; // refill queue when fewer than this many tracks remain
const CHECKIN_SEED_COUNT          = 8;  // initial kickstart queue right after a check-in is answered

// ── Engagement / adaptive listening ──────────────────────────────────────────
// We infer how the user feels about a track from how much of it they hear before
// it changes. Skipping early = dislike; finishing = like. This nudges the
// continuous queue to "go with the flow" of what's actually landing.
// The strong/soft skip thresholds are derived from the "Skip sensitivity" tuning
// slider (see _tSkipStrong/_tSkipSoft) rather than fixed constants.
const FINISH_FRAC      = 0.80;  // heard ≥80% → engaged / liked
const ADAPTIVE_LIKES_MAX = 8;   // rolling window of recently-engaged tracks that steer refills
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
function _tBandPad()        { return Math.round(_lerp(0, 25, _tVariety())); }      // ± widen feature band
function _tDiscoveryGenres(){ return 2 + Math.round(_tVariety() * 3); }            // 2–5 genres searched
function _tFlowOn()         { return _tuning.fadeSmooth >= 50; }                   // harmonic flow ordering
function _tDriftThreshold() { return _lerp(0.45, 0.20, _tuning.moodFlow / 100); } // lock → flow
function _tFlowLikeCount()  { return Math.round((_tuning.moodFlow / 100) * ADAPTIVE_LIKES_MAX); }
function _tSkipStrong()     { return _lerp(0.08, 0.25, _tuning.skipSensitivity / 100); }
function _tSkipSoft()       { return _lerp(0.35, 0.60, _tuning.skipSensitivity / 100); }
function _tLookahead()      { return _clampNum(Math.round(_tuning.lookahead), 1, 10); }

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
const PROGRESS_DELTA_MAX  = POLL_INTERVAL * 2.5; // sanity cap on progress delta

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _io = null;
let _pollTimer = null;
let _featureWarmTimer = null;
let _lastState = null;
let _lastTrackId = null;
let _autoQueueCount = 0;
let _autoplayEnabled = false;
let _smartShuffleEnabled = false;
let _smartShuffleTrackCount = 0; // playlist tracks heard since last injected track
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
let _librarySeeds   = [];   // whole saved library + top tracks, feature-warmed in the
                            // background so mood/vibe matching draws from the full library
let _libraryWarmedAt = 0;   // when _librarySeeds was last (re)built
let _vibeNames      = {};   // { vibeKey: 'Custom Name' }
let _activeVibeKey  = null;  // currently running continuous vibe (null = stopped)
let _activeMoodKey  = null;  // currently running continuous mood (null = stopped)
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

// URIs WE deliberately staged into the playback context (playFresh / rebuildUpcoming /
// queueOnTop). Spotify's own Autoplay silently appends recommended tracks to the queue
// once our finite uris-context nears its end; those injected tracks aren't in here. The
// continuous engine counts only OUR upcoming tracks (ignoring autoplay) to decide when to
// refill, and rebuildUpcoming drops anything not in here — so autoplay can't masquerade as
// a full queue and starve the refill, and its picks get evicted on the next rebuild.
let _stagedUris = new Set();
let _refillFullLoggedAt = 0; // throttle for the "queue full" refill log
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
// _recentLikes:  rolling features of tracks the user actually engaged with
//                (finished / heard most of) — steers refills toward the flow.
//                Session-scoped: reset when a session opens/closes.
// _artistTaste:  lowercase artist → durable net score, PERSISTED across sessions.
//                Each hard skip −1, each engaged listen +1 (clamped). An artist is
//                avoided once the net hits ARTIST_DISLIKE_SCORE; later listens recover it.
// _trackDislikes: trackId → durable hard-skip count, PERSISTED across sessions. A track
//                is soft-banned once skipped TRACK_SOFTBAN_COUNT times; a full listen
//                decays the count back down (recovery).
let _recentLikes   = [];
let _artistTaste   = new Map();
let _trackDislikes = new Map();

// ── Transition learning (Feature 6) ───────────────────────────────────────────
// _transitions: "fromId>toId" → net score. A transition that survives (the next
// track gets an engaged listen) nudges the pair positive; a skip nudges it
// negative. flowOrder reads this so sequencing learns the user's actual taste in
// what-follows-what, not just harmonic mixing. PERSISTED across sessions.
let _transitions     = new Map();
let _transitionPrevId = null;    // id of the track that played immediately before the current one
const TRANSITION_KEY = (from, to) => `${from}>${to}`;
const TRANSITION_CLAMP = 5;      // bound each pair so one outlier can't dominate
const TRANSITION_WEIGHT = 0.20;  // how much a learned transition can shift a flow score

// ── Cluster & feeling detection ───────────────────────────────────────────────
let _currentCluster    = [];     // tracks in the current emerging cluster (with features)
let _currentCentroid   = null;   // { energy, valence, bpm } mean of _currentCluster
let _driftBuffer       = [];     // consecutive tracks that are "far" from _currentCentroid
let _pendingCheckIn    = null;   // { fingerprint, guessedFeeling, clusterSnapshot, timestamp }
let _activeFeeling     = null;   // { key, label, emoji, confirmedAt, centroid, clusterTracks }
let _lastCheckInAt     = 0;      // cluster size when last check-in was triggered
let _checkInAutoEnabled = true;  // user preference

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
    for (const [k, v] of Object.entries(obj.trackDislikes || {})) {
      if (typeof v === 'number') _trackDislikes.set(k, v);
    }
    for (const [k, v] of Object.entries(obj.transitions || {})) {
      if (typeof v === 'number') _transitions.set(k, v);
    }
    console.log(`[Spotify] Loaded taste profile — ${_artistTaste.size} artists, ${_trackDislikes.size} disliked tracks, ${_transitions.size} transitions`);
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
      trackDislikes: Object.fromEntries(_trackDislikes),
      transitions:   Object.fromEntries(_transitions),
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
      if (prefs.tuning && typeof prefs.tuning === 'object') {
        _applyTuning(prefs.tuning);
      }
    }
  } catch { }
}

function saveUserPrefs() {
  try {
    fs.mkdirSync(path.dirname(USER_PREFS_FILE), { recursive: true });
    fs.writeFileSync(USER_PREFS_FILE, JSON.stringify({ checkInAuto: _checkInAutoEnabled, tuning: _tuning }, null, 2));
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
  // Fresh session → fresh no-repeat memory and short-term flow signal.
  // (Artist taste + track dislikes are durable now — they live in the taste profile.)
  _sessionTrackIds  = new Set();
  _recentLikes      = [];
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
  _recentLikes      = [];
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
      recentLikes:      _recentLikes,
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
      _recentLikes      = snap.recentLikes      || [];
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
  _recentLikes      = [];
  _stagedUris       = new Set();
  _recentPlayIds    = [];     // fresh session = no recent-repeat history to guard against
  _transitionPrevId = null;   // new session = no prior track to chain a transition from
  // Durable taste (artist scores + track dislikes) intentionally survives a reset —
  // it's a long-term profile, not session state.
  // Stop any running continuous engine — otherwise it keeps refilling from the old
  // context and the reset looks like it did nothing.
  const hadFeeling = !!_activeFeeling;
  const hadEngine  = !!(_activeMoodKey || _activeVibeKey || _activeFeeling);
  _activeMoodKey  = null;
  _activeVibeKey  = null;
  _activeFeeling  = null;
  _autoQueueCount = 0;
  if (hadFeeling && _io) _io.emit('spotify:feeling_expired');
  if (hadEngine && _io) {
    _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null });
  }
  _sessionStats = { startTime: Date.now(), tracksPlayed: [] };
  clearLiveState();
  console.log('[Spotify] Session manually reset — fresh session started');
}

// ── Away-listening reconciliation ─────────────────────────────────────────────

async function reconcileRecentlyPlayed() {
  if (!isAuthed()) return;
  try {
    const rp = await api('GET', '/me/player/recently-played', { params: { limit: 50 } });
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
  if (!isAuthed()) return;
  try {
    console.log('[Spotify] Seeding history from Spotify API…');
    const seeds = [];

    // 1. Recently played — has real played_at timestamps
    try {
      const rp = await api('GET', '/me/player/recently-played', { params: { limit: 50 } });
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
        const tt = await api('GET', '/me/top/tracks', { params: { time_range: range, limit: 50 } });
        let added = 0;
        for (const t of (tt?.items || [])) {
          if (!t?.id || ownIds.has(t.id) || seededTopIds.has(t.id)) continue;
          seededTopIds.add(t.id);
          seeds.push({
            id: t.id, uri: t.uri,
            title: t.name,
            artist: t.artists?.map(a => a.name).join(', ') || '',
            album: t.album?.name || '',
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
        const features = await getBatchAudioFeatures(batch);
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
  }
}

// Build a feature-bearing seed entry (no timestamp) from a raw Spotify track object.
function _libSeedFromTrack(t, source) {
  return {
    id: t.id, uri: t.uri,
    title: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '',
    album: t.album?.name || '',
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
  if (_featureWarmRunning || !isAuthed()) return;
  _featureWarmRunning = true;
  try {
    // 1. Gather library + top-track metadata (deduped by id)
    const byId = new Map();
    try {
      const liked = await getAllLikedSongs();
      for (const entry of liked) {
        const t = entry.item || entry.track;
        if (t?.id && !byId.has(t.id)) byId.set(t.id, _libSeedFromTrack(t, 'liked_library'));
      }
    } catch (e) {
      console.warn('[Spotify] Feature warm: liked-library fetch failed:', e.message);
    }
    for (const range of ['short_term', 'medium_term', 'long_term']) {
      try {
        const tt = await api('GET', '/me/top/tracks', { params: { time_range: range, limit: 50 } });
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
      if (!isAuthed() || !_pollTimer) break; // auth lost / shutting down — stop cleanly
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

        // 204 No Content
        if (res.statusCode === 204) {
          return resolve(null);
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
          return reject(err);
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);

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
  };

  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  // Quiet the two endpoints the 5 s poll hits every cycle — they otherwise bury
  // every meaningful log (refill decisions, queue rebuilds, discovery) in noise.
  const _short = urlStr.replace(SPOTIFY_API, '');
  const _noisy = method === 'GET' && (_short === '/me/player' || _short.startsWith('/me/player/queue'));
  if (!_noisy) console.log(`[Spotify] ${method} ${_short}`);

  return httpsRequest(method, urlStr, { headers, body });
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

  const updated = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope || tokens.scope || '', // preserve existing scope if refresh doesn't return one
  };

  saveTokens(updated);
  return updated.accessToken;
}

async function getToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated with Spotify');

  // Refresh if expiring within 30 seconds
  if (Date.now() >= tokens.expiresAt - 30000) {
    return refreshAccessToken();
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

// Clear whatever is currently queued and start fresh playback with `tracks`.
// Spotify has no clear-queue endpoint, so starting a new uris context is the
// reliable way to discard the old (now-irrelevant) queue. Used when switching
// vibe / mood / "right now" — the previous queue no longer applies.
async function playFresh(tracks) {
  let list = (tracks || []).filter(t => t && (t.uri || t.id));
  if (!list.length) return 0;
  // Stage the first track to play now + up to QUEUE_TARGET upcoming, so the
  // queue never starts out longer than the cap. Refill tops it up later.
  list = list.slice(0, QUEUE_TARGET + 1);
  const uris = list.map(t => t.uri || `spotify:track:${t.id}`);
  await play({ uris });
  // This uris-context is now the authoritative queue; forget any previous staging
  // (and any Spotify-autoplay tracks that may have been appended to the old context).
  _setStaged(uris);
  for (const t of list) {
    const id = t.id || (t.uri && t.uri.startsWith('spotify:track:') ? t.uri.split(':').pop() : null);
    _markPlayed(id);
  }
  return list.length;
}

// Put a track at the TOP of the queue (i.e. play it next, right after the
// current song). Spotify's /queue endpoint only appends to the end and there's
// no reorder API, so we rebuild the upcoming queue with the new track first and
// re-issue playback — resuming the current track at its current position.
async function queueOnTop(uri) {
  if (!uri) return false;
  let currentUri = null, progressMs = 0, upcoming = [];
  try {
    const st = await getPlaybackState();
    currentUri = st?.item?.uri || null;
    progressMs = st?.progress_ms || 0;
  } catch { /* no active playback */ }
  try {
    const q = await getQueue();
    upcoming = (q?.queue || []).map(t => t && t.uri).filter(Boolean);
  } catch { /* queue unavailable */ }

  // Avoid duplicating the track if it's already somewhere downstream
  upcoming = upcoming.filter(u => u !== uri && u !== currentUri);

  if (currentUri) {
    // Keep the current song playing where it is, slot the new track in next.
    await play({ uris: [currentUri, uri, ...upcoming], positionMs: progressMs });
    _setStaged([currentUri, uri, ...upcoming]);
  } else {
    // Nothing playing — just start with the new track at the front.
    await play({ uris: [uri, ...upcoming] });
    _setStaged([uri, ...upcoming]);
  }
  const id = uri.startsWith('spotify:track:') ? uri.split(':').pop() : null;
  _markPlayed(id);
  return true;
}

// Top the upcoming queue up to QUEUE_TARGET WITHOUT polluting Spotify's
// user-added queue. Spotify's "Next in queue" (anything added via addToQueue)
// can't be cleared through the API, so switching vibe/mood via play({uris})
// leaves stale songs behind. To avoid that entirely we never addToQueue for
// auto-features — instead we rebuild the playback context: keep the current
// track playing (re-seeking to its position) and stage the existing upcoming
// tracks plus enough fresh ones to reach the cap. The brief re-buffer this
// causes lands on a track change, so it's barely noticeable.
// Returns the number of NEW tracks staged (0 if nothing needed adding).
async function rebuildUpcoming(freshTracks) {
  let currentUri = null, progressMs = 0;
  try {
    const st = await getPlaybackState();
    currentUri = st?.item?.uri || null;
    progressMs = st?.progress_ms || 0;
  } catch { /* no active playback */ }

  // Existing upcoming = context tracks we previously staged (no user-queue,
  // since we never addToQueue any more).
  let upcoming = [];
  try {
    const q = await getQueue();
    upcoming = (q?.queue || []).map(t => t && t.uri).filter(Boolean);
  } catch { /* queue unavailable */ }
  // Keep ONLY the upcoming tracks WE staged. Spotify Autoplay appends its own
  // recommendations to our finite uris-context; if we preserved them they'd
  // perpetuate (and crowd out the vibe). Dropping them here means the rebuilt
  // context replaces autoplay's tail with our tracks.
  // Keep only DISTINCT staged tracks. `_stagedUris` already excludes anything
  // consumed (a track is dropped from it the moment it becomes current — see
  // poll), so this preserves just the genuinely-upcoming staged tracks while
  // collapsing the duplicates Spotify's looped look-ahead introduces.
  {
    const kept = [], seen = new Set();
    for (const u of upcoming) {
      if (!u || !_stagedUris.has(u) || seen.has(u)) continue;
      seen.add(u);
      kept.push(u);
    }
    upcoming = kept;
  }
  // Only keep as many existing upcoming as the cap allows.
  upcoming = upcoming.slice(0, QUEUE_TARGET);

  const need = QUEUE_TARGET - upcoming.length;
  if (need <= 0) return 0; // already full — nothing to do, no rebuild/blip

  const have = new Set([currentUri, ...upcoming].filter(Boolean));
  const freshUris = [];
  const freshByUri = new Map();
  for (const t of (freshTracks || [])) {
    const u = t.uri || (t.id ? `spotify:track:${t.id}` : null);
    if (!u || have.has(u)) continue;
    // Hard recent-repeat guard: never re-stage a song we played in the last
    // RECENT_PLAY_GUARD tracks, even if a narrow vibe pool's never-starve fallback
    // handed us already-played songs. Better to stage fewer than to repeat soon.
    const id = u.startsWith('spotify:track:') ? u.split(':').pop() : null;
    if (_isRecentlyPlayed(id)) continue;
    freshUris.push(u); freshByUri.set(u, t); have.add(u);
    if (freshUris.length >= need) break;
  }
  if (!freshUris.length) return 0; // nothing new to add — skip the rebuild/blip

  // Combine the staged upcoming we kept with the fresh tracks, then — this is what
  // keeps the queue ADAPTIVE — re-flow-order the whole upcoming run anchored to the
  // track playing right now. A freshly found song that fits better (harmonically,
  // BPM/energy-wise, or by a learned transition) than an already-staged one slots
  // AHEAD of it instead of always landing at the tail. We only get here when we're
  // adding (a play() rebuild is happening regardless), so the reorder is free.
  const combined = [...upcoming, ...freshUris]; // ≤ QUEUE_TARGET
  let nextUris = combined;
  if (_tFlowOn() && combined.length > 1) {
    const annotate = (u) => {
      const id = u.startsWith('spotify:track:') ? u.split(':').pop() : null;
      const t = freshByUri.get(u);
      const f = (t && t.energy != null) ? t : (id ? _findStoredFeatures(id) : null);
      return { uri: u, id, bpm: f?.bpm, energy: f?.energy, _cam: f ? _camelotPos(f.key, f.mode) : null };
    };
    const seed = currentUri ? annotate(currentUri) : null;
    const remaining = combined.map(annotate);
    const ordered = [];
    let last = seed;
    while (remaining.length) {
      let best = 0, bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const s = last ? _trackFlowScore(last, remaining[i]) : 0;
        if (s > bestScore) { bestScore = s; best = i; }
      }
      ordered.push(remaining.splice(best, 1)[0]);
      last = ordered[ordered.length - 1];
    }
    nextUris = ordered.map(o => o.uri);
  }
  if (currentUri) await play({ uris: [currentUri, ...nextUris], positionMs: progressMs });
  else            await play({ uris: nextUris });

  // This rebuilt context is now authoritative: current + the tracks we just staged.
  _setStaged([currentUri, ...nextUris]);
  for (const u of nextUris) {
    const id = u.startsWith('spotify:track:') ? u.split(':').pop() : null;
    _markPlayed(id);
  }
  return freshUris.length;
}

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
  return (_artistTaste.get(artist.toLowerCase()) || 0) <= ARTIST_DISLIKE_SCORE;
}
// Positive taste signal for an artist (0 = neutral/disliked) — used to bias selection.
function _artistBoost(artist) {
  if (!artist) return 0;
  return Math.max(0, _artistTaste.get(artist.toLowerCase()) || 0);
}

// Durable per-track dislike count. A hard skip bumps it; a full listen decays it.
function _bumpTrackDislike(id) {
  if (!id) return;
  _trackDislikes.set(id, (_trackDislikes.get(id) || 0) + 1);
  _scheduleTasteSave();
}
function _recoverTrackDislike(id) {
  if (!id || !_trackDislikes.has(id)) return;
  const n = (_trackDislikes.get(id) || 0) - 1;
  if (n <= 0) _trackDislikes.delete(id); else _trackDislikes.set(id, n);
  _scheduleTasteSave();
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

// Remember a track the user engaged with so the next refills lean toward it.
function _pushRecentLike(t) {
  if (!t || t.energy == null) return;
  _recentLikes = _recentLikes.filter(x => x.id !== t.id);
  _recentLikes.push(t);
  if (_recentLikes.length > ADAPTIVE_LIKES_MAX) _recentLikes.shift();
}

// Judge how the user felt about the track that just ended, from how much of it
// they heard. `prev` is the previous poll's serialized state (the outgoing track).
//   • finished / ≥80%      → engaged → feed _recentLikes, +1 artist score
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

function _evaluateEngagement(prev) {
  if (!prev || !prev.track || !prev.track.id || !prev.isPlaying) return;
  const dur = prev.track.duration;
  const pos = prev.progress;
  if (!dur || dur <= 0 || pos == null) return;

  const frac     = pos / dur;
  const finished = frac >= FINISH_FRAC || (dur - pos) <= PROGRESS_DELTA_MAX;
  const feat     = _findStoredFeatures(prev.track.id);
  const likeRec  = feat ? {
    id: prev.track.id, artist: prev.track.artist,
    energy: feat.energy, valence: feat.valence, bpm: feat.bpm,
  } : null;

  // The previous-to-this transition survived/failed based on how this track fared.
  const _prevId = _transitionPrevId;
  _transitionPrevId = prev.track.id;

  if (finished || frac >= _tSkipSoft()) {
    if (likeRec) _pushRecentLike(likeRec);
    _adjustArtistScore(prev.track.artist, +1);   // engaged listen recovers the artist
    _recoverTrackDislike(prev.track.id);          // a full listen forgives a past skip
    _recordTransition(_prevId, prev.track.id, +1); // this sequencing worked — reinforce it
    return;
  }
  if (frac < _tSkipStrong()) {
    _bumpTrackDislike(prev.track.id);            // repeated skips → durable soft-ban
    _adjustArtistScore(prev.track.artist, -1);
    _recordTransition(_prevId, prev.track.id, -1); // landing here got skipped — avoid the sequence
    const banned  = _trackSoftBanned(prev.track.id);
    const avoided = _artistAvoided(prev.track.artist);
    console.log(`[Spotify] Engagement: strong dislike (${Math.round(frac * 100)}%) "${prev.track.title}"${banned ? ' — now soft-banned' : ''}${avoided ? ` — pattern detected, now avoiding ${prev.track.artist}` : ''}`);
    return;
  }
  // Between the two thresholds: just didn't fit the current vibe — note it, but don't penalize.
  console.log(`[Spotify] Engagement: vibe mismatch (${Math.round(frac * 100)}%) "${prev.track.title}"`);
}

/**
 * Play a single search track with continuation tracks bundled in the same
 * play() call as a mini-playlist, so Spotify has full context and keeps
 * playing when the track ends — no queue manipulation needed.
 */
async function playWithContinuation(uri) {
  const trackId = uri.split(':').pop();
  let continuationUris = [];

  // getSimilarTracks already has a multi-tier fallback; just unwrap URIs.
  // Skip anything already played/queued this session so continuation doesn't repeat.
  try {
    const similar = await getSimilarTracks([trackId], [], QUEUE_TARGET + 10);
    // Prefer tracks not yet played this session; but if /recommendations is dead
    // and the top-tracks fallback is all already-played, replay rather than stop
    // dead — a queue that keeps going beats silence.
    let pool = _excludePlayed(similar);
    if (!pool.length) pool = similar;
    // Cap to QUEUE_TARGET upcoming so a search-play doesn't stage a huge queue.
    continuationUris = pool.map(t => t.uri).filter(u => u && u !== uri).slice(0, QUEUE_TARGET);
    if (continuationUris.length) console.log(`[Spotify] Continuation: ${continuationUris.length} similar tracks`);
  } catch (e) {
    console.warn('[Spotify] Continuation tracks unavailable:', e.message);
  }

  // Play selected track first; if we have continuation tracks bundle them in
  // the same call so Spotify treats it as a playlist context
  if (continuationUris.length) {
    await play({ uris: [uri, ...continuationUris] });
    _setStaged([uri, ...continuationUris]);
  } else {
    console.warn('[Spotify] No continuation tracks found — playing single track');
    await play({ uris: [uri] });
    _setStaged([uri]);
  }
}

// ---------------------------------------------------------------------------
// Library API wrappers
// ---------------------------------------------------------------------------

async function getPlaylists(limit = 50) {
  return api('GET', '/me/playlists', { params: { limit } });
}

async function getAllPlaylists() {
  const limit = 50;
  let offset = 0;
  let allItems = [];
  const first = await api('GET', '/me/playlists', { params: { limit, offset: 0 } });
  if (!first) return { items: [] };
  const total = first.total || 0;
  allItems = allItems.concat(first.items || []);
  while (allItems.length < total) {
    offset = allItems.length;
    const page = await api('GET', '/me/playlists', { params: { limit, offset } });
    if (!page || !page.items || !page.items.length) break;
    allItems = allItems.concat(page.items);
  }
  return { items: allItems };
}

async function getPlaylistTracks(playlistId, limit = 100) {
  // Feb 2026: /tracks → /items; response field track → item
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
      params: { limit, offset: allItems.length, fields: 'items(item(id,uri,name,duration_ms,artists(id,name),album(name,images)))' },
    });
    if (!page || !page.items || !page.items.length) break;
    allItems = allItems.concat(page.items);
  }
  return allItems;
}

async function getAllLikedSongs() {
  const limit = 50;
  let offset = 0;
  let allItems = [];
  // First page also gives total
  const first = await getLikedSongTracks(limit, 0);
  if (!first) return [];
  const total = first.total || 0;
  allItems = allItems.concat(first.items || []);
  while (allItems.length < total) {
    offset = allItems.length;
    const page = await getLikedSongTracks(limit, offset);
    if (!page || !page.items || !page.items.length) break;
    allItems = allItems.concat(page.items);
  }
  return allItems;
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
    console.warn('[Spotify] ReccoBeats unavailable for', trackId, '-', err.message);
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
    // Tier 1: Spotify's own endpoint (deprecated — 403s for most apps, kept for the few it works on)
    try {
      const data = await api('GET', `/audio-features/${trackId}`);
      if (data && data.tempo != null) {
        _cacheFeatures(trackId, data);
        return data;
      }
    } catch {
      // expected for deprecated endpoint — fall through to ReccoBeats
    }
    // Tier 2: ReccoBeats fallback
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

async function getBatchAudioFeatures(trackIds) {
  if (!trackIds || !trackIds.length) return [];
  const toFetch = trackIds.filter(id => !_audioFeaturesCache.has(id));
  if (toFetch.length) {
    // Tier 1: Spotify batch (deprecated — usually 403s)
    try {
      const ids = toFetch.slice(0, 100).join(',');
      const data = await api('GET', '/audio-features', { params: { ids } });
      const features = (data && data.audio_features) ? data.audio_features : [];
      features.forEach(f => { if (f && f.id) _cacheFeatures(f.id, f); });
    } catch {
      // expected — fall through to ReccoBeats
    }
    // Tier 2: ReccoBeats fallback for whatever's still missing.
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

async function getLikedSongTracks(limit = 50, offset = 0) {
  // Feb 2026: /me/tracks → /me/library/items?type=track
  // Fall back to the old endpoint if the new one returns an unexpected structure
  try {
    const data = await api('GET', '/me/library/items', { params: { type: 'track', limit, offset } });
    if (data && data.items) return data;
  } catch {
    // new endpoint failed — try legacy
  }
  return api('GET', '/me/tracks', { params: { limit, offset } });
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
  return api('PUT', '/me/library', { params: { uris: trackUri } });
}

async function unlikeTrack(trackUri) {
  // Feb 2026: DELETE /me/tracks {ids:[...]} → DELETE /me/library?uris=spotify:track:...
  return api('DELETE', '/me/library', { params: { uris: trackUri } });
}

async function addTracksToPlaylist(playlistId, uris) {
  // Feb 2026: POST /playlists/{id}/tracks → POST /playlists/{id}/items
  return api('POST', `/playlists/${playlistId}/items`, { body: { uris } });
}

async function createPlaylist(userId, name, description = '') {
  return api('POST', `/users/${userId}/playlists`, {
    body: { name, description, public: false },
  });
}

async function getRecommendations({ seedTracks = [], seedArtists = [], limit = 5 } = {}) {
  const params = { limit };
  if (seedTracks.length > 0) params.seed_tracks = seedTracks.slice(0, 5).join(',');
  if (seedArtists.length > 0) params.seed_artists = seedArtists.slice(0, 5).join(',');
  return api('GET', '/recommendations', { params });
}

/**
 * Get tracks similar to the given seeds.
 * Two-tier fallback because /recommendations is deprecated and 404s for many apps:
 *   1. /recommendations  (still works for some; fastest)
 *   2. user's own short-term top tracks shuffled  (last resort)
 *
 * (A related-artists tier used to sit between these, but /artists/{id}/related-artists
 *  was deprecated in the same Nov-2024 batch as /recommendations, so it only burned
 *  API calls that 404'd. Removed.)
 *
 * Returns an array of raw Spotify track objects (with .uri, .id, .name, .artists …).
 */
let _recommendationsDeadLogged = false;
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

  // ── Tier 1: /recommendations ────────────────────────────────────────────────
  try {
    const recs = await getRecommendations({ seedTracks: seedTrackIds, seedArtists: seedArtistIds, limit });
    const tracks = dedupe(recs?.tracks || [], excludeUris);
    if (tracks.length > 0) {
      console.log(`[Spotify] getSimilarTracks: ${tracks.length} from /recommendations`);
      return tracks.slice(0, limit);
    }
  } catch (err) {
    // /recommendations is deprecated and 404s for most apps — log once, then stay quiet
    if (!_recommendationsDeadLogged) {
      console.warn('[Spotify] /recommendations unavailable, falling back to top-tracks:', err.message);
      _recommendationsDeadLogged = true;
    }
  }

  // ── Tier 2: user's own short-term top tracks ────────────────────────────────
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

let _topGenresCache = { genres: [], ts: 0 };
const TOP_GENRES_TTL = 6 * 60 * 60 * 1000;
async function _getTopGenres() {
  if (_topGenresCache.genres.length && Date.now() - _topGenresCache.ts < TOP_GENRES_TTL) {
    return _topGenresCache.genres;
  }
  try {
    const res = await api('GET', '/me/top/artists', { params: { time_range: 'medium_term', limit: 50 } });
    const counts = {};
    for (const a of res?.items || []) for (const g of a.genres || []) counts[g] = (counts[g] || 0) + 1;
    const genres = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([g]) => g);
    _topGenresCache = { genres, ts: Date.now() };
    return genres;
  } catch {
    return _topGenresCache.genres;
  }
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
        items = (data?.items || []).map(i => i.item).filter(Boolean);
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

async function getUserProfile() {
  if (_userProfile) return _userProfile;
  _userProfile = await api('GET', '/me');
  _userId = _userProfile.id || null;
  return _userProfile;
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

  const missing = uniq.filter(id => !map.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const data = await api('GET', '/tracks', { params: { ids: chunk.join(',') } });
      for (const item of (data?.tracks || [])) {
        if (item && item.id) map.set(item.id, serializeTrack(item));
      }
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

// ---------------------------------------------------------------------------
// Autoplay / recommendations
// ---------------------------------------------------------------------------

async function maybeQueueRecommendations(state) {
  if (!_autoplayEnabled) return;
  if (!state || !state.track) return;
  // Don't double up with a mood/vibe/feeling refill — that path owns the queue.
  if (_activeMoodKey || _activeVibeKey || _activeFeeling) return;

  // Only top the queue up to the shared cap (never overshoot QUEUE_TARGET).
  let queueLength = 0;
  try {
    const queueData = await getQueue();
    queueLength = queueData?.queue?.length || 0;
  } catch { /* queue unavailable — assume empty */ }
  const gap = QUEUE_TARGET - queueLength;
  if (gap <= 0) return;

  const seedTracks  = [state.track.id].filter(Boolean);
  const seedArtists = (state.track.artistIds || []).slice(0, 2);

  try {
    const raw = await getSimilarTracks(seedTracks, seedArtists, gap + 8);
    // Prefer unplayed, but never starve: if all candidates were already played
    // this session (top-tracks fallback exhausted), replay rather than let the
    // queue run dry and playback stop.
    let tracks = _excludePlayed(raw);
    if (!tracks.length) tracks = raw;
    // Nothing is explicitly chosen here, so lean into the current time-of-day's
    // learned profile: drift candidates that match this slot's typical energy/valence
    // to the front before staging.
    tracks = _applyContextBias(tracks);
    // Stage via context rebuild (no addToQueue) so the queue stays clearable.
    const added = await rebuildUpcoming(tracks);
    _autoQueueCount += added;
  } catch (err) {
    console.error('[Spotify] Autoplay fetch failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Smart shuffle — injects a discovery track every N playlist tracks
// ---------------------------------------------------------------------------

// Every 3 playlist tracks heard, inject one similar track that isn't in the playlist.
// Only fires while playing inside a playlist context.
const SMART_SHUFFLE_INJECT_EVERY = 3;

async function maybeSmartShuffle(state) {
  if (!_smartShuffleEnabled) return;
  if (!state?.track) return;
  // Only inject when actually inside a playlist (not an album, artist, or free-play context)
  const contextIsPlaylist = state.context?.type === 'playlist' || state.context?.uri?.includes(':playlist:');
  if (!contextIsPlaylist) return;

  _smartShuffleTrackCount++;
  if (_smartShuffleTrackCount % SMART_SHUFFLE_INJECT_EVERY !== 0) return;

  const seedTracks  = [state.track.id].filter(Boolean);
  const seedArtists = (state.track.artistIds || []).slice(0, 2);

  try {
    const tracks = _excludePlayed(await getSimilarTracks(seedTracks, seedArtists, 6));
    for (const track of tracks.slice(0, 1)) {
      try {
        await _queueTrack(track);
        _autoQueueCount++;
        console.log(`[Spotify] Smart shuffle injected: ${track.name}`);
      } catch (err) {
        console.error('[Spotify] Smart shuffle inject error:', err.message);
      }
    }
  } catch (err) {
    console.error('[Spotify] Smart shuffle fetch failed:', err.message);
  }
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
    const items =
      data && data.queue
        ? data.queue.slice(0, 30).map((t) => ({
            id: t.id,
            uri: t.uri,
            title: t.name,
            artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
            albumArt:
              t.album && t.album.images && t.album.images.length > 0
                ? t.album.images[0].url
                : null,
            duration: t.duration_ms,
          }))
        : [];
    _io.emit('spotify:queue', { items });
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
// Playlist builders
// ---------------------------------------------------------------------------

async function buildVibePlaylist(vibeKey, limit = 25) {
  const vibes = computeVibes();
  if (!vibes.ready) return [];
  const cluster = vibes.clusters.find(c => c.key === vibeKey);
  if (!cluster) return [];

  // Skip anything already played/queued this session so the vibe never loops
  const pool = _excludePlayed([...cluster.tracks]);
  const discoveryCount = Math.min(Math.ceil(limit * _tDiscoveryRatio()), 10);
  const baseCount = Math.max(1, limit - discoveryCount);

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
  const discovery = await _buildDiscovery(seedIds, seedArtists, discoveryCount);

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

  // Widen the feeling's feature band by the Variety slider so a higher setting
  // pulls in tracks further from the core energy/valence window.
  const pad = _tBandPad();
  const eMin = def.energy[0]  - pad, eMax = def.energy[1]  + pad;
  const vMin = def.valence[0] - pad, vMax = def.valence[1] + pad;
  const all = combinedHistory();

  // Tracks that match the feeling's audio-feature ranges, excluding session tracks already heard
  const sessionIds = new Set(sessionTracks.map(t => t.id).filter(Boolean));
  const seen = new Set(sessionIds);
  const pool = [];
  for (const e of all) {
    if (seen.has(e.id)) continue;
    if (_sessionTrackIds.has(e.id)) continue; // already played/queued this session
    if (e.energy == null) continue;
    if (e.energy < eMin || e.energy > eMax) continue;
    if (e.valence < vMin || e.valence > vMax) continue;
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
  const discovery = await _buildDiscovery(seedIds, seedArtists, discoveryCount);

  // Final guard: nothing already played/queued, and nothing by a hard-skipped artist
  const combined = _excludeDisliked(_excludePlayed([...sessionSample, ...base, ...discovery]));
  return _spaceArtists(_tFlowOn() ? flowOrder(combined) : combined.sort(() => Math.random() - 0.5));
}

// Assemble a discovery set that prioritises genuinely NEW music. Spotify's own
// curated playlists (borrowed collaborative filtering) come first, then fresh
// search finds; anything the user already knows is only last-resort filler so
// the queue never starves.
async function _buildDiscovery(seedIds, seedArtists, count) {
  if (count <= 0) return [];
  const known = _knownTrackIdSet();
  const excludeIds = new Set([...known, ..._sessionTrackIds]);
  const topGenres = await _getTopGenres();

  const [curated, similar, fresh] = await Promise.all([
    getCuratedTracks(seedArtists, topGenres, excludeIds, count + 4).catch(() => []),
    getSimilarTracks(seedIds, [], count + 5).catch(() => []),
    getDiscoveryTracks(seedArtists, excludeIds, count + 4).catch(() => []),
  ]);

  // Curated (Spotify CF) first — strongest cross-user signal — then fresh search
  // finds, then unfamiliar similar. Keep only genuinely new (unknown) tracks.
  const newCurated = _excludePlayed(curated).filter(t => t.id && !known.has(t.id));
  const newSimilar = _excludePlayed(similar).filter(t => t.id && !known.has(t.id));
  let discovery = _excludeDisliked([...newCurated, ...fresh, ...newSimilar]);
  // De-dupe by id, preserving the priority order above.
  const seenIds = new Set();
  discovery = discovery.filter(t => t.id && !seenIds.has(t.id) && seenIds.add(t.id)).slice(0, count);

  // Top up with known-but-unplayed similar so a batch is never short.
  if (discovery.length < count) {
    const have = new Set(discovery.map(t => t.id));
    const filler = _excludeDisliked(_excludePlayed(similar)).filter(t => !have.has(t.id));
    discovery = [...discovery, ...filler].slice(0, count);
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

// Best profile for the current moment: composite (weekday/weekend + slot) first,
// then slot-only, else null when there isn't enough history yet.
function _currentContextProfile() {
  const profiles = _computeContextProfiles();
  const now = new Date();
  const weekend = (now.getDay() === 0 || now.getDay() === 6);
  const slot = _timeSlotFor(now.getHours());
  return profiles[`${weekend ? 'weekend' : 'weekday'}:${slot}`] || profiles[`slot:${slot}`] || null;
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
  return {
    label:        slotLabel,
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

  return { hour: h, dow, timeSlot, isWeekend, recentEnergy, suggestedMoodKey,
           suggestedMoodName: suggestedMood?.name, suggestedMoodEmoji: suggestedMood?.emoji,
           contextProfile };
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

function _emitIntelligenceState() {
  if (!_io) return;
  _io.emit('spotify:intelligence_state', {
    activeFeeling:  _activeFeeling ? { key: _activeFeeling.key, label: _activeFeeling.label, emoji: _activeFeeling.emoji } : null,
    activeMoodKey:  _activeMoodKey,
    activeMoodName: _activeMoodKey ? (MOOD_STATES.find(m => m.key === _activeMoodKey)?.name || null) : null,
    activeVibeKey:  _activeVibeKey,
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
      _emitIntelligenceState();
    }
  }
}

// ---------------------------------------------------------------------------
// Continuous queue refill — called on every track change when a mood/vibe is active
// ---------------------------------------------------------------------------

async function maybeRefillContinuousQueue(state) {
  if (!_activeMoodKey && !_activeVibeKey && !_activeFeeling) return;
  const label = _activeFeeling?.label || _activeMoodKey || _activeVibeKey;
  try {
    const queueData = await getQueue();
    const rawLen = queueData?.queue?.length || 0;
    // Count only the tracks WE staged. Spotify Autoplay quietly appends its own
    // recommendations to our finite uris-context, so the raw queue length can stay
    // ≥ QUEUE_TARGET forever and would permanently short-circuit the refill (the
    // user then hears autoplay's picks, not the vibe, and the cluster — fed by our
    // feature-bearing tracks — appears frozen). Gating on OUR upcoming count fixes both.
    // Count DISTINCT staged tracks still in the look-ahead. Spotify loops our
    // finite uris-context, so the same staged URI shows up many times (raw=17 for
    // 6 staged); counting occurrences pinned `ours` above QUEUE_TARGET forever and
    // the refill never fired. `_stagedUris` only ever holds not-yet-played upcoming
    // (each track is removed the moment it becomes the current track — see poll),
    // so a distinct count here is the true number of fresh slots ahead, draining
    // toward 0 as songs play.
    const _seenUris = new Set();
    for (const t of (queueData?.queue || [])) {
      const uri = t?.uri;
      if (uri && _stagedUris.has(uri)) _seenUris.add(uri);
    }
    const ours = _seenUris.size;
    if (ours >= QUEUE_TARGET) {
      // Already full of our tracks — nothing to do. Log occasionally (≤ every 30 s) so
      // a "stuck full" state is visible without spamming.
      const now = Date.now();
      if (now - _refillFullLoggedAt > 30000) {
        _refillFullLoggedAt = now;
        console.log(`[Spotify] Refill: queue full — ${ours}/${QUEUE_TARGET} ours (raw=${rawLen}, staged=${_stagedUris.size}) (${label})`);
      }
      return;
    }

    const need = QUEUE_TARGET - ours;
    console.log(`[Spotify] Refill: ${ours}/${QUEUE_TARGET} ours in queue (raw=${rawLen}, staged=${_stagedUris.size}) — need ${need} more (${label})`);

    // Over-fetch so disliked/already-played drops still leave enough to reach the cap.
    const refillCount = need + 3;

    // 1) Primary source: the active vibe / mood / feeling pool.
    let tracks;
    if (_activeFeeling) {
      // Feeling is the baseline, but go with the flow: blend in the tracks the user is
      // actually engaging with right now. The Mood-lock↔Flow slider controls how many
      // recent likes get mixed in (0 = stay locked to the feeling, more = follow the vibe).
      const flowLikes = _recentLikes.slice(-_tFlowLikeCount());
      const adaptive = [...flowLikes, ...(_activeFeeling.clusterTracks || [])];
      tracks = await buildFeelingPlaylist(_activeFeeling.key, adaptive, refillCount);
    } else if (_activeMoodKey) {
      tracks = await buildMoodPlaylist(_activeMoodKey, refillCount);
    } else {
      tracks = await buildVibePlaylist(_activeVibeKey, refillCount);
    }
    tracks = tracks || [];

    // 2) Prefer genuinely fresh (unplayed, undisliked) tracks.
    let fresh = _excludeDisliked(_excludePlayed(tracks));

    // 3) If the vibe pool can't supply enough NEW tracks — a small or already-exhausted
    //    cluster will keep returning the same played songs — pull from similar / the
    //    user's top tracks so the queue still reaches the cap with new material. (The old
    //    code only did this when the builder returned *empty*; an exhausted cluster
    //    returns played replays instead, so we never got here and the queue starved.)
    if (fresh.length < need) {
      const seed = state?.track?.id ? [state.track.id] : [];
      const more = await getSimilarTracks(seed, [], need + 8).catch(() => []);
      const moreFresh = _excludeDisliked(_excludePlayed(more));
      const seen = new Set(fresh.map(t => t && t.id).filter(Boolean));
      for (const t of moreFresh) {
        if (t && t.id && !seen.has(t.id)) { fresh.push(t); seen.add(t.id); }
      }
    }

    // 4) Never starve: if everything's been played, relax step by step so the music
    //    keeps going (allow replays, then anything playable) rather than stopping dead.
    if (!fresh.length) fresh = _excludeDisliked(tracks);
    if (!fresh.length) fresh = tracks;

    // Stage via context rebuild (no addToQueue) so the queue stays clearable.
    const added = await rebuildUpcoming(fresh);
    if (added > 0) {
      console.log(`[Spotify] Continuous refill +${added} tracks (${label}) → queue now full`);
      // Let the Queue widget flash its "Auto" pill to show it just topped up.
      try { _io.emit('spotify:queue_managed', { active: true, added, label }); } catch {}
    } else {
      console.log(`[Spotify] Refill: nothing new to stage — pool exhausted for ${label} (had ${fresh.length} candidates, all already queued/played)`);
    }
  } catch (err) {
    console.error('[Spotify] Continuous refill error:', err.message);
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
// Polling
// ---------------------------------------------------------------------------

async function poll() {
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
        // The track now playing is consumed: drop it from our staged set so the
        // refill gate sees one fewer fresh slot ahead. Without this, Spotify's
        // looped look-ahead keeps the played track "upcoming" and the queue never
        // drains below QUEUE_TARGET, so the refill never fires.
        if (state.track?.uri) _stagedUris.delete(state.track.uri);
        // Record it in the recent-play window so it can't be re-staged for a while.
        _notePlayed(state.track?.id);
        // Judge engagement with the outgoing track (skip vs finish) before we move on
        _evaluateEngagement(_lastState);
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
          maybeQueueRecommendations(state).catch((err) =>
            console.error('[Spotify] Autoplay error:', err.message)
          );
          maybeSmartShuffle(state).catch((err) =>
            console.error('[Spotify] Smart shuffle error:', err.message)
          );
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

      // Keep the continuous queue topped up on EVERY poll (not just on track
      // changes) so the queue can never run dry — if a change is missed or the
      // context drains, the next poll (≤5 s) refills it. The function's own
      // "ours >= QUEUE_TARGET" gate makes this a cheap no-op when already full,
      // so there's no extra re-buffering versus the per-track-change call.
      if (state.isPlaying && (_activeMoodKey || _activeVibeKey || _activeFeeling)) {
        maybeRefillContinuousQueue(state).catch((err) =>
          console.error('[Spotify] Continuous refill error:', err.message)
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
  }
}

function startPolling() {
  if (_pollTimer) return;
  poll(); // immediate first poll
  _pollTimer = setInterval(poll, POLL_INTERVAL);
  // Seed history from Spotify in the background (non-blocking)
  if (_seedTimestamp === 0) seedFromSpotify().catch(() => {});
  // Warm audio features for the whole library in the background (idle-time job).
  // Delayed so it yields to the initial seed + the first live plays, then re-scans
  // periodically for newly-liked songs.
  if (!_featureWarmTimer) {
    setTimeout(() => warmFeatureLibrary().catch(() => {}), FEATURE_WARM_START_DELAY);
    _featureWarmTimer = setInterval(() => warmFeatureLibrary().catch(() => {}), FEATURE_WARM_INTERVAL);
  }
  // Reconcile away-listening every 30 minutes
  if (!_reconcileTimer) {
    // First reconcile shortly after startup, then on the regular interval
    setTimeout(() => reconcileRecentlyPlayed().catch(() => {}), 60 * 1000);
    _reconcileTimer = setInterval(
      () => reconcileRecentlyPlayed().catch(() => {}),
      RECONCILE_INTERVAL
    );
  }
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_reconcileTimer) {
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
  }
  if (_featureWarmTimer) {
    clearInterval(_featureWarmTimer);
    _featureWarmTimer = null;
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

async function playPlaylistWithSmartShuffle(playlistUri, playlistId) {
  await play({ contextUri: playlistUri });
  await setShuffle(true);
  await setRepeat('off');

  if (_smartShuffleEnabled && playlistId) {
    try {
      const tracksData = await getPlaylistTracks(playlistId, 50);
      const items = (tracksData && tracksData.items) ? tracksData.items : [];
      const tracks = items.map((i) => i.item || i.track).filter(Boolean);

      const shuffled   = [...tracks].sort(() => Math.random() - 0.5);
      const seedTracks = shuffled.slice(0, 3).map((t) => t.id).filter(Boolean);
      const artistIds  = [];
      for (const t of shuffled.slice(0, 3)) {
        for (const a of (t.artists || [])) {
          if (a.id && !artistIds.includes(a.id)) artistIds.push(a.id);
        }
      }
      const seedArtists = artistIds.slice(0, 2);

      const similar = _excludePlayed(await getSimilarTracks(seedTracks, seedArtists, 8)).slice(0, 5);
      for (const track of similar) {
        try { await _queueTrack(track); } catch { /* ignore */ }
      }
      _autoQueueCount      = similar.length;
      _smartShuffleTrackCount = 0;
    } catch (err) {
      console.error('[Spotify] Smart shuffle (playlist start) error:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Socket setup
// ---------------------------------------------------------------------------

function init(io) {
  _io = io;

  loadHistory();
  loadSessions();
  loadVibeNames();
  loadUserPrefs();
  loadFeaturesDB();
  loadTasteProfile();
  loadFeelingLog();
  loadLiveState(); // after loadSessions so stale-session finalize can de-dupe

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

    // ----- spotify:cmd -----
    socket.on('spotify:cmd', async ({ action, ...args } = {}) => {
      try {
        switch (action) {
          case 'play':
            // Single track from search — bundle continuation tracks so playback
            // doesn't stop (no queue manipulation, one clean play() call)
            if (args.uris?.length === 1 && !args.contextUri) {
              await playWithContinuation(args.uris[0]);
            } else {
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

          case 'queue_add':
            // Manual add from search — put it at the TOP (play next), not buried
            // behind auto-queued tracks. _sessionTrackIds is updated inside.
            await queueOnTop(args.uri);
            setTimeout(emitQueue, 1500);
            break;

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
            await playPlaylistWithSmartShuffle(args.playlistUri, args.playlistId);
            setTimeout(emitQueue, 2000);
            break;

          default:
            console.warn('[Spotify] Unknown command action:', action);
            socket.emit('spotify:error', { message: `Unknown action: ${action}` });
            return;
        }

        // Delayed poll to pick up changes
        setTimeout(() => poll(), 800);
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
        setTimeout(() => poll(), 300);
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

    // ----- spotify:get_playlists -----
    // ownedOnly=true  → filter to playlists the user can modify (for the "add to playlist" picker)
    // ownedOnly=false → return all playlists (for the playlist browser card)
    socket.on('spotify:get_playlists', async ({ ownedOnly = false } = {}) => {
      try {
        if (!_userId) await getUserProfile();
        console.log(`[Spotify] get_playlists: userId=${_userId} ownedOnly=${ownedOnly}`);

        const data = await getAllPlaylists();
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
    socket.on('spotify:get_liked_songs', async () => {
      try {
        const allItems = await getAllLikedSongs();
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
        const tracks = await buildVibePlaylist(key, QUEUE_TARGET + 3);
        if (!tracks.length) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Not enough data for this vibe' });
          return;
        }
        _activeVibeKey = key;
        _activeMoodKey = null;
        _activeFeeling = null;
        // Old queue no longer applies — clear it and start the vibe fresh.
        const queued = await playFresh(tracks);
        const label = getVibeName(key);
        socket.emit('spotify:insights_action', { ok: true, msg: `Playing ${queued} tracks · "${label}" · keeps going ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: key });
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
        const tracks = await buildMoodPlaylist(key, QUEUE_TARGET + 3);
        if (!tracks.length) {
          socket.emit('spotify:insights_action', { ok: false, msg: 'Not enough history for this mood yet' });
          return;
        }
        _activeMoodKey = key;
        _activeVibeKey = null;
        _activeFeeling = null;
        // Old queue no longer applies — clear it and start the mood fresh.
        const queued = await playFresh(tracks);
        socket.emit('spotify:insights_action', { ok: true, msg: `Playing ${queued} tracks · "${mood.name}" · keeps going ∞` });
        _io.emit('spotify:continuous_state', { activeMoodKey: key, activeVibeKey: null });
        setTimeout(emitQueue, 1500);
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:stop_continuous -----
    socket.on('spotify:stop_continuous', () => {
      _activeMoodKey = null;
      _activeVibeKey = null;
      _activeFeeling = null;
      _pendingCheckIn = null;
      _io.emit('spotify:continuous_state', { activeMoodKey: null, activeVibeKey: null });
      _io.emit('spotify:feeling_expired');
      _emitIntelligenceState();
    });

    // ----- spotify:get_intelligence -----
    socket.on('spotify:get_intelligence', () => {
      socket.emit('spotify:intelligence_state', {
        activeFeeling:   _activeFeeling ? { key: _activeFeeling.key, label: _activeFeeling.label, emoji: _activeFeeling.emoji } : null,
        activeMoodKey:   _activeMoodKey,
        activeVibeKey:   _activeVibeKey,
        clusterSize:     _currentCluster.length,
        clusterCentroid: _currentCentroid,
        pendingCheckIn:  _pendingCheckIn ? { guessedFeeling: _pendingCheckIn.guessedFeeling } : null,
        context:         detectCurrentContext(),
        checkInAuto:     _checkInAutoEnabled,
        feelings:        Object.entries(FEELING_DEFS).map(([key, def]) => ({ key, ...def })),
      });
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
      // currently playing completely untouched. No new queue, no playFresh.
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
        // Use the vibe key from right-now to enable continuous mode
        _activeVibeKey = rn.vibeKey || null;
        _activeMoodKey = null;
        _activeFeeling = null;
        let pool = _excludePlayed([...rn.topTracks]).sort(() => Math.random() - 0.5).slice(0, QUEUE_TARGET + 3);
        if (_tFlowOn()) pool = flowOrder(pool);
        // Old queue no longer applies — clear it and start "right now" fresh.
        const queued = await playFresh(pool);
        socket.emit('spotify:insights_action', { ok: true, msg: `Playing ${queued} tracks for right now · keeps going ∞` });
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
        const items =
          data && data.queue
            ? data.queue.slice(0, 30).map((t) => ({
                id: t.id,
                uri: t.uri,
                title: t.name,
                artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
                albumArt:
                  t.album && t.album.images && t.album.images.length > 0
                    ? t.album.images[0].url
                    : null,
                duration: t.duration_ms,
              }))
            : [];
        socket.emit('spotify:queue', { items });
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
        saveCfg({ clientId, clientSecret });
        socket.emit('spotify:config_saved', { success: true });
      } catch (err) {
        console.error('[Spotify] Save config error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:disconnect -----
    socket.on('spotify:disconnect', () => {
      stopPolling();
      deleteTokens();
      _lastState = null;
      _lastTrackId = null;
      _autoQueueCount = 0;
      _smartShuffleTrackCount = 0;
      _userProfile = null;
      _userId = null;
      io.emit('spotify:auth_status', { connected: false, configured: true });
      io.emit('spotify:state', null);
    });

    // ----- spotify:set_autoplay -----
    socket.on('spotify:set_autoplay', ({ enabled } = {}) => {
      _autoplayEnabled = !!enabled;
      console.log('[Spotify] Autoplay set to:', _autoplayEnabled);
    });

    // ----- spotify:set_smart_shuffle -----
    socket.on('spotify:set_smart_shuffle', ({ enabled } = {}) => {
      _smartShuffleEnabled = !!enabled;
      console.log('[Spotify] Smart shuffle set to:', _smartShuffleEnabled);
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
