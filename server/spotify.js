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
  'user-read-recently-played',
  'user-top-read',
].join(' ');

// Scopes that must be present in the stored token; if any are missing the user
// needs to disconnect and reconnect to get a fresh authorisation.
const REQUIRED_SCOPES = [
  'user-library-modify',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-private',
];

const CONFIG_FILE = path.join(__dirname, 'data', 'spotify-config.json');
const TOKENS_FILE = path.join(__dirname, 'data', 'spotify-tokens.json');

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

// ---------------------------------------------------------------------------
// Library API wrappers
// ---------------------------------------------------------------------------

async function getPlaylists(limit = 50) {
  return api('GET', '/me/playlists', { params: { limit } });
}

async function getPlaylistTracks(playlistId, limit = 50) {
  return api('GET', `/playlists/${playlistId}/tracks`, {
    params: {
      limit,
      fields: 'items(track(id,uri,name,duration_ms,artists(id,name),album(name,images)))',
    },
  });
}

async function getDevices() {
  return api('GET', '/me/player/devices');
}

async function search(query, types = 'track', limit = 20) {
  return api('GET', '/search', { params: { q: query, type: types, limit: String(limit) } });
}

async function getQueue() {
  return api('GET', '/me/player/queue');
}

async function checkLiked(trackIds) {
  if (!trackIds || trackIds.length === 0) return [];
  return api('GET', '/me/tracks/contains', { params: { ids: trackIds.join(',') } });
}

async function likeTrack(trackId) {
  return api('PUT', '/me/tracks', { body: { ids: [trackId] } });
}

async function unlikeTrack(trackId) {
  return api('DELETE', '/me/tracks', { body: { ids: [trackId] } });
}

async function addTracksToPlaylist(playlistId, uris) {
  return api('POST', `/playlists/${playlistId}/tracks`, { body: { uris } });
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
// Polling
// ---------------------------------------------------------------------------

async function poll() {
  try {
    const raw = await getPlaybackState();
    const state = serializeState(raw);

    if (state && state.track) {
      const trackChanged = _lastTrackId && _lastTrackId !== state.track.id;

      if (trackChanged) {
        _autoQueueCount = Math.max(0, _autoQueueCount - 1);
        // Broadcast fresh queue ~1.5 s after track change so Spotify's queue
        // endpoint has time to reflect the new state.
        setTimeout(emitQueue, 1500);
      }

      // Check liked status for new track
      if (!_lastTrackId || _lastTrackId !== state.track.id) {
        try {
          const liked = await checkLiked([state.track.id]);
          state.liked = Array.isArray(liked) ? liked[0] : false;
        } catch {
          state.liked = false;
        }

        if (trackChanged) {
          maybeQueueRecommendations(state).catch((err) =>
            console.error('[Spotify] Autoplay error:', err.message)
          );
        }
      } else if (_lastState) {
        state.liked = _lastState.liked;
      }

      _lastTrackId = state.track.id;
    }

    _lastState = state;

    if (_io) {
      _io.emit('spotify:state', state);
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
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
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
      const tracks = items.map((i) => i.track).filter(Boolean);

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
            await play(args);
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
            await likeTrack(args.trackId);
            if (_lastState) {
              _lastState.liked = true;
              _io.emit('spotify:state', _lastState);
            }
            break;

          case 'unlike':
            await unlikeTrack(args.trackId);
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
        const results = await search(query, 'track', 20);
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
                .filter((item) => item.track && item.track.id)
                .map((item) => ({
                  id: item.track.id,
                  uri: item.track.uri,
                  title: item.track.name,
                  artist: item.track.artists
                    ? item.track.artists.map((a) => a.name).join(', ')
                    : '',
                  duration: item.track.duration_ms,
                }))
            : [];
        socket.emit('spotify:playlist_tracks', { playlistId, tracks });
      } catch (err) {
        console.error('[Spotify] Get playlist tracks error:', err.message);
        socket.emit('spotify:error', { message: err.message });
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
