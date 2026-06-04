'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPOTIFY_API = 'https://api.spotify.com/v1';
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

const CONFIG_FILE     = path.join(__dirname, 'data', 'spotify-config.json');
const TOKENS_FILE     = path.join(__dirname, 'data', 'spotify-tokens.json');
const HISTORY_FILE    = path.join(__dirname, 'data', 'listening-history.ndjson');
const SESSIONS_FILE   = path.join(__dirname, 'data', 'sessions.ndjson');
const VIBE_NAMES_FILE = path.join(__dirname, 'data', 'vibe-names.json');

const SESSION_GAP_MS      = 10 * 60 * 1000;  // 10 min silence → close session
const SESSION_MIN_MS      = 15 * 1000;        // ignore sessions shorter than 15s
const RECONCILE_INTERVAL  = 30 * 60 * 1000;  // reconcile away-plays every 30 min
const PROGRESS_DELTA_MAX  = POLL_INTERVAL * 2.5; // sanity cap on progress delta

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _io = null;
let _pollTimer = null;
let _lastState = null;
let _lastTrackId = null;
let _autoQueueCount = 0;
let _autoplayEnabled = false;
let _smartShuffleEnabled = false;
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

let _history        = [];   // all-time log entries, loaded from file on start
let _seededHistory  = [];   // in-memory only: entries seeded from Spotify API
let _seedTimestamp  = 0;    // when _seededHistory was last populated
let _vibeNames      = {};   // { vibeKey: 'Custom Name' }

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
    console.log(`[Spotify] Loaded ${_history.length} history entries`);
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

function openActiveSession() {
  _activeSession = {
    id:               `session_${Date.now()}`,
    startTime:        Date.now(),
    lastActivityTime: Date.now(),
    listenedMs:       0,
    trackCount:       0,
  };
}

function closeActiveSession() {
  if (!_activeSession) return;
  const session = _activeSession;
  _activeSession = null;
  _lastProgress  = null;

  if (session.listenedMs < SESSION_MIN_MS) return; // too short to bother saving

  const record = {
    id:          session.id,
    startTime:   session.startTime,
    endTime:     Date.now(),
    listenedMs:  session.listenedMs,
    trackCount:  session.trackCount,
    source:      'live',
  };
  _sessions.push(record);
  appendSession(record);
  console.log(`[Spotify] Session closed — ${Math.round(record.listenedMs / 60000)} min listened, ${record.trackCount} tracks`);
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
        cur = { startTime: play.ts, lastTs: play.ts, listenedMs: 0, trackCount: 0 };
      }
      cur.lastTs     = play.ts;
      cur.listenedMs += Math.round(play.durMs * 0.85); // ~85%: Spotify logs at 30s+ completion
      cur.trackCount += 1;
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
  for (const e of _seededHistory) {
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

    _seededHistory = seeds;
    _seedTimestamp = Date.now();
    console.log(`[Spotify] Seed complete — ${_seededHistory.length} total seeded entries`);
  } catch (err) {
    console.error('[Spotify] seedFromSpotify error:', err.message);
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

  console.log(`[Spotify] ${method} ${urlStr.replace(SPOTIFY_API, '')}`);

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

/**
 * Play a single search track with continuation tracks bundled in the same
 * play() call as a mini-playlist, so Spotify has full context and keeps
 * playing when the track ends — no queue manipulation needed.
 */
async function playWithContinuation(uri) {
  const trackId = uri.split(':').pop();
  let continuationUris = [];

  // 1. Try recommendations
  try {
    const recs = await getRecommendations({ seedTracks: [trackId], limit: 24 });
    continuationUris = (recs?.tracks || []).map(t => t.uri).filter(u => u !== uri);
    if (continuationUris.length) console.log(`[Spotify] Continuation: ${continuationUris.length} recommendations`);
  } catch (e) {
    console.warn('[Spotify] Recommendations unavailable:', e.message);
  }

  // 2. Fall back to artist top tracks
  if (!continuationUris.length) {
    try {
      const track  = await api('GET', `/tracks/${trackId}`);
      const artist = track?.artists?.[0]?.id;
      if (artist) {
        const res = await api('GET', `/artists/${artist}/top-tracks`);
        continuationUris = (res?.tracks || []).map(t => t.uri).filter(u => u !== uri).slice(0, 19);
        if (continuationUris.length) console.log(`[Spotify] Continuation: ${continuationUris.length} artist top tracks`);
      }
    } catch (e) {
      console.warn('[Spotify] Artist top tracks unavailable:', e.message);
    }
  }

  // Play selected track first; if we have continuation tracks bundle them in
  // the same call so Spotify treats it as a playlist context
  if (continuationUris.length) {
    await play({ uris: [uri, ...continuationUris] });
  } else {
    console.warn('[Spotify] No continuation tracks found — playing single track');
    await play({ uris: [uri] });
  }
}

// ---------------------------------------------------------------------------
// Library API wrappers
// ---------------------------------------------------------------------------

async function getPlaylists(limit = 50) {
  return api('GET', '/me/playlists', { params: { limit } });
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

// In-memory cache so we don't re-fetch features for the same track
const _audioFeaturesCache = new Map();

async function getAudioFeatures(trackId) {
  if (_audioFeaturesCache.has(trackId)) return _audioFeaturesCache.get(trackId);
  try {
    const data = await api('GET', `/audio-features/${trackId}`);
    if (data && data.tempo != null) {
      _audioFeaturesCache.set(trackId, data);
      return data;
    }
    console.warn('[Spotify] Audio features: unexpected response for', trackId, data);
    return null;
  } catch (err) {
    console.warn('[Spotify] Audio features unavailable for', trackId, '-', err.message);
    return null;
  }
}

async function getBatchAudioFeatures(trackIds) {
  if (!trackIds || !trackIds.length) return [];
  const toFetch = trackIds.filter(id => !_audioFeaturesCache.has(id));
  if (toFetch.length) {
    try {
      const ids = toFetch.slice(0, 100).join(',');
      const data = await api('GET', '/audio-features', { params: { ids } });
      const features = (data && data.audio_features) ? data.audio_features : [];
      features.forEach(f => { if (f && f.id) _audioFeaturesCache.set(f.id, f); });
    } catch (err) {
      console.error('[Spotify] Batch audio features error:', err.message);
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

async function search(query, types = 'track', limit = 10) {
  // Feb 2026: search limit reduced from max 50 to max 10
  const safeLimit = Math.min(limit, 10);
  return api('GET', '/search', { params: { q: query, type: types, limit: String(safeLimit) } });
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
  if (_autoQueueCount >= AUTOPLAY_MIN_QUEUE) return;
  if (!state || !state.track) return;

  try {
    const seedTracks = [state.track.id].filter(Boolean);
    const seedArtists = (state.track.artistIds || []).slice(0, 2);

    const recs = await getRecommendations({ seedTracks, seedArtists, limit: 5 });
    const tracks = (recs && recs.tracks) ? recs.tracks : [];

    for (const track of tracks) {
      try {
        await addToQueue(track.uri);
        _autoQueueCount++;
      } catch (err) {
        console.error('[Spotify] Failed to queue recommendation:', err.message);
      }
    }
  } catch (err) {
    console.error('[Spotify] Failed to fetch recommendations:', err.message);
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

function computeFilter({ minEnergy=0, maxEnergy=100, minValence=0, maxValence=100, minBpm=0, maxBpm=300 } = {}) {
  const unique = new Map();
  for (const e of combinedHistory()) {
    if (unique.has(e.id)) continue;
    if (e.energy != null) {
      if (e.energy < minEnergy || e.energy > maxEnergy) continue;
      if (e.valence < minValence || e.valence > maxValence) continue;
      if (e.bpm && (e.bpm < minBpm || e.bpm > maxBpm)) continue;
    }
    unique.set(e.id, { id: e.id, uri: e.uri, title: e.title, artist: e.artist,
                       energy: e.energy, valence: e.valence, bpm: e.bpm });
  }
  return { tracks: [...unique.values()], total: unique.size };
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

          // Build history entry — features fetched and merged then appended
          const histEntry = {
            ts: Date.now(),
            h:  new Date().getHours(),
            dow: new Date().getDay(),
            id: state.track.id, uri: state.track.uri,
            title: state.track.title, artist: state.track.artist,
            album: state.track.album || '',
            dur: state.track.duration,
          };
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
            })
            .catch(() => { appendHistory(histEntry); });
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
        }
        // Emit audio features on first track load too (not just track changes)
        if (!_lastTrackId) {
          getAudioFeatures(state.track.id)
            .then((f) => { if (f && _io) _io.emit('spotify:audio_features', _serializeFeatures(f)); })
            .catch(() => {});
        }
      } else if (_lastState) {
        state.liked = _lastState.liked;
      }

      _lastTrackId = state.track.id;
    } else {
      // No track / no state — reset progress, check session gap
      _lastProgress = null;
      if (_activeSession) {
        const gap = Date.now() - _activeSession.lastActivityTime;
        if (gap > SESSION_GAP_MS) closeActiveSession();
      }
    }

    _lastState = state;

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
  // Close any active session so time isn't lost on graceful shutdown
  closeActiveSession();
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
      // Feb 2026: response field renamed track → item
      const tracks = items.map((i) => i.item || i.track).filter(Boolean);

      // Pick 3 random tracks as seeds
      const shuffled = tracks.sort(() => Math.random() - 0.5);
      const seedTracks = shuffled.slice(0, 3).map((t) => t.id).filter(Boolean);

      // Pick 2 random artist seeds from those tracks
      const artistIds = [];
      for (const t of shuffled.slice(0, 3)) {
        if (t.artists) {
          for (const a of t.artists) {
            if (a.id && !artistIds.includes(a.id)) artistIds.push(a.id);
          }
        }
      }
      const seedArtists = artistIds.slice(0, 2);

      const recs = await getRecommendations({ seedTracks, seedArtists, limit: 5 });
      const recTracks = (recs && recs.tracks) ? recs.tracks : [];

      for (const track of recTracks) {
        try {
          await addToQueue(track.uri);
        } catch (err) {
          console.error('[Spotify] Smart shuffle queue error:', err.message);
        }
      }

      _autoQueueCount = recTracks.length;
    } catch (err) {
      console.error('[Spotify] Smart shuffle error:', err.message);
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
            await addToQueue(args.uri);
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
    socket.on('spotify:search', async ({ query } = {}) => {
      try {
        const results = await search(query, 'track', 10);
        const tracks =
          results && results.tracks && results.tracks.items
            ? results.tracks.items.map((t) => ({
                id: t.id,
                uri: t.uri,
                title: t.name,
                artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
                album: t.album ? t.album.name : '',
                albumArt:
                  t.album && t.album.images && t.album.images.length > 0
                    ? t.album.images[0].url
                    : null,
                duration: t.duration_ms,
              }))
            : [];
        socket.emit('spotify:search_results', { items: tracks });
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

        const data = await getPlaylists(50);
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
        const data = await getPlaylistTracks(playlistId, 100);
        const tracks =
          data && data.items
            ? data.items
                // Feb 2026: response field renamed track → item; fall back for safety
                .map((entry) => entry.item || entry.track)
                .filter((t) => t && t.id)
                .map((t) => ({
                  id: t.id,
                  uri: t.uri,
                  title: t.name,
                  artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
                  duration: t.duration_ms,
                }))
            : [];
        socket.emit('spotify:playlist_tracks', { playlistId, tracks });
      } catch (err) {
        console.error('[Spotify] Get playlist tracks error:', err.message);
        socket.emit('spotify:error', { message: err.message });
      }
    });

    // ----- spotify:get_liked_songs -----
    socket.on('spotify:get_liked_songs', async ({ limit = 50, offset = 0 } = {}) => {
      try {
        const data = await getLikedSongTracks(limit, offset);
        const tracks =
          data && data.items
            ? data.items
                // Feb 2026: response field renamed track → item; keep both for safety
                .map((entry) => entry.item || entry.track)
                .filter((t) => t && t.id)
                .map((t) => ({
                  id: t.id,
                  uri: t.uri,
                  title: t.name,
                  artist: t.artists ? t.artists.map((a) => a.name).join(', ') : '',
                  duration: t.duration_ms,
                }))
            : [];
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

    // ----- spotify:reset_session -----
    socket.on('spotify:reset_session', () => {
      _sessionStats = { startTime: Date.now(), tracksPlayed: [] };
      _io.emit('spotify:stats', buildStats());
    });

    // ----- spotify:save_session_playlist -----
    socket.on('spotify:save_session_playlist', async ({ name } = {}) => {
      try {
        if (!_userId) await getUserProfile();

        const tracks = _sessionStats.tracksPlayed;
        if (!tracks.length) {
          socket.emit('spotify:session_playlist_saved', { error: 'No tracks in this session yet.' });
          return;
        }

        // Deduplicate URIs while preserving play order
        const seen = new Set();
        const uris = [];
        for (const t of tracks) {
          if (t.uri && !seen.has(t.uri)) {
            seen.add(t.uri);
            uris.push(t.uri);
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
    socket.on('spotify:get_insights', async () => {
      // Re-seed from Spotify if never seeded or stale (> 1 hour)
      if (Date.now() - _seedTimestamp > 3600000) {
        await seedFromSpotify();
      }
      socket.emit('spotify:insights', {
        profile:  computeProfile(),
        patterns: computePatterns(),
        vibes:    computeVibes(),
        rightNow: computeRightNow(),
        total:    combinedHistory().length,
        ownTotal: _history.length,
      });
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
        const vibes = computeVibes();
        if (!vibes.ready) return;
        const cluster = vibes.clusters.find(c => c.key === key);
        if (!cluster) return;
        const tracks = [...cluster.tracks].sort(() => Math.random() - 0.5).slice(0, 25);
        let queued = 0;
        for (const t of tracks) {
          try { await addToQueue(t.uri); queued++; await new Promise(r => setTimeout(r, 120)); }
          catch { /* skip unplayable */ }
        }
        socket.emit('spotify:insights_action', { ok: true, msg: `Queued ${queued} tracks from "${cluster.name}"` });
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:play_now -----  (Right Now tab)
    socket.on('spotify:play_now', async () => {
      try {
        const rn = computeRightNow();
        if (!rn.ready) return;
        const tracks = [...rn.topTracks].sort(() => Math.random() - 0.5).slice(0, 25);
        let queued = 0;
        for (const t of tracks) {
          try { await addToQueue(t.uri); queued++; await new Promise(r => setTimeout(r, 120)); }
          catch { /* skip */ }
        }
        socket.emit('spotify:insights_action', { ok: true, msg: `Queued ${queued} tracks for right now` });
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:play_filter -----
    socket.on('spotify:play_filter', async (params = {}) => {
      try {
        const { tracks } = computeFilter(params);
        const shuffled = [...tracks].sort(() => Math.random() - 0.5).slice(0, 25);
        let queued = 0;
        for (const t of shuffled) {
          try { await addToQueue(t.uri); queued++; await new Promise(r => setTimeout(r, 120)); }
          catch { /* skip */ }
        }
        socket.emit('spotify:insights_action', { ok: true, msg: `Queued ${queued} filtered tracks` });
      } catch (err) {
        socket.emit('spotify:insights_action', { ok: false, msg: err.message });
      }
    });

    // ----- spotify:get_filter_count -----
    socket.on('spotify:get_filter_count', (params = {}) => {
      const { total } = computeFilter(params);
      socket.emit('spotify:filter_count', { total });
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
