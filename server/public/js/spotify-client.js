/**
 * spotify-client.js
 * Client-side socket wrappers for the Spotify integration.
 * Imported by spotify-controls.js and app.js.
 */

import { socket } from './socket.js';

// ---------------------------------------------------------------------------
// Playback commands
// ---------------------------------------------------------------------------

/**
 * Send a playback command.
 * @param {string} action  - e.g. 'play', 'pause', 'next', 'seek', 'shuffle', …
 * @param {object} [args]  - Additional arguments for the command.
 */
export function spotifyCmd(action, args = {}) {
  socket.emit('spotify:cmd', { action, ...args });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Trigger a server-side search. Results arrive via 'spotify:search_results'.
 * @param {string} query
 */
export function spotifySearch(query, type = 'track') {
  socket.emit('spotify:search', { query, type });
}

// ---------------------------------------------------------------------------
// Data requests (return Promises via one-time listeners)
// ---------------------------------------------------------------------------

/**
 * Emit a request and resolve with the first matching reply. Resolves with
 * `fallback` only if nothing arrives within the timeout, so a widget can never
 * hang forever on a Promise that resolves only on the happy path.
 *
 * NOTE: We deliberately do NOT listen for the global 'spotify:error' event.
 * The server emits that event without a correlation id, so it is shared by all
 * concurrent requests. Coupling to it meant a single failed/rate-limited
 * request (e.g. the queue when no device is active) would resolve EVERY other
 * in-flight request (playlists, liked songs, devices…) with their empty
 * fallback — blanking unrelated widgets all at once. Each request now waits
 * only for its own reply event, falling back after the timeout if it never
 * comes.
 * @param {string} emitEvent    event to emit
 * @param {object} payload      payload to send
 * @param {string} replyEvent   event carrying the successful reply
 * @param {*}      fallback     value to resolve with on timeout
 * @param {number} [timeoutMs=12000]
 */
function _request(emitEvent, payload, replyEvent, fallback, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off(replyEvent, onReply);
      resolve(val);
    };
    const onReply = (data) => finish(data);
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    socket.once(replyEvent, onReply);
    socket.emit(emitEvent, payload);
  });
}

/**
 * Request playlist list. Resolves with { items } when server responds.
 * @param {object} [opts]
 * @param {boolean} [opts.ownedOnly=false]  true = only return playlists the user can modify
 */
export function getSpotifyPlaylists(opts = {}) {
  return _request('spotify:get_playlists', opts, 'spotify:playlists', { items: [] });
}

/**
 * Request tracks for a specific playlist. Resolves with { playlistId, tracks }.
 * @param {string} playlistId
 */
export function getSpotifyPlaylistTracks(playlistId) {
  return _request('spotify:get_playlist_tracks', { playlistId }, 'spotify:playlist_tracks', { playlistId, tracks: [] });
}

/**
 * Request liked songs. Resolves with { tracks } when server responds.
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 */
export function getSpotifyLikedSongs(opts = {}) {
  return _request('spotify:get_liked_songs', opts, 'spotify:liked_songs', { tracks: [] });
}

/**
 * Request audio features for one track. Resolves with serialized features object.
 * @param {string} trackId
 */
export function getSpotifyAudioFeatures(trackId) {
  return new Promise((resolve) => {
    socket.once('spotify:audio_features', resolve);
    socket.emit('spotify:get_audio_features', { trackId });
  });
}

/**
 * Request audio features for multiple tracks. Resolves with { features: [...] }.
 * @param {string[]} trackIds
 */
export function getSpotifyBatchAudioFeatures(trackIds) {
  return new Promise((resolve) => {
    socket.once('spotify:batch_audio_features', resolve);
    socket.emit('spotify:get_batch_audio_features', { trackIds });
  });
}

/**
 * Request listening session stats. Resolves with stats object.
 */
export function getSpotifyStats() {
  return new Promise((resolve) => {
    socket.once('spotify:stats', resolve);
    socket.emit('spotify:get_stats');
  });
}

/**
 * Save the current session's tracks as a new private Spotify playlist.
 * Resolves with { success, name, playlistId, url, trackCount } or { error }.
 * @param {string} [name]  Optional playlist name; auto-generated if omitted.
 */
/**
 * Reset the current session stats (clears all tracked tracks and resets the clock).
 */
export function resetSpotifySession() {
  socket.emit('spotify:reset_session');
}

/**
 * Request full insights data (profile, patterns, vibes, rightNow).
 */
export function getSpotifyInsights() {
  return new Promise((resolve) => {
    socket.once('spotify:insights', resolve);
    socket.emit('spotify:get_insights');
  });
}

/** Rename a vibe cluster. */
export function renameVibe(key, name) {
  socket.emit('spotify:rename_vibe', { key, name });
}

/** Queue all tracks in a vibe cluster (shuffled). */
export function playVibe(key) {
  socket.emit('spotify:play_vibe', { key });
}

/** Queue tracks matching the Right Now suggestion. */
export function playNow() {
  socket.emit('spotify:play_now');
}

/** Queue a mood playlist and enable continuous mode. */
export function playMood(key) {
  socket.emit('spotify:play_mood', { key });
}

/** Stop continuous vibe/mood playback. */
export function stopContinuous() {
  socket.emit('spotify:stop_continuous');
}

/**
 * Play a unified mix targeting an exact point in the energy×valence space.
 * @param {{energy:number, valence:number, label?:string, vibeKey?:string, spread?:number}} target
 */
export function playMix(target) {
  socket.emit('spotify:play_mix', target);
}

/** Request the 2D mood map (server replies with spotify:mix_map). Optional macro-genre filters the heat-cloud. */
export function getMixMap(genre) {
  socket.emit('spotify:get_mix_map', genre ? { genre } : {});
}

/** Request the macro-genre profile for the Genres tab (server replies with spotify:genre_profile). */
export function getGenreProfile() {
  socket.emit('spotify:get_genre_profile');
}

/** Request the current global tuning profile (server replies with spotify:tuning). */
export function getTuning() {
  socket.emit('spotify:get_tuning');
}

/** Update the global tuning profile. Accepts a partial { key: value } patch. */
export function setTuning(tuning) {
  socket.emit('spotify:set_tuning', { tuning });
}

/** Ask the server for the active display timezone (and the detected host zone). */
export function getTimezone() {
  socket.emit('spotify:get_timezone');
}

/**
 * Override the display timezone (authoritative IANA name, e.g. "Europe/Amsterdam").
 * By default also repairs past log entries so historical analytics are corrected.
 */
export function setTimezone(timeZone, migrate = true) {
  socket.emit('spotify:set_timezone', { timeZone, migrate });
}

/**
 * Save a session as a playlist.
 * @param {string} [name]        Optional playlist name.
 * @param {string} [sessionId]   Optional past-session id; omit to save the live session.
 */
export function saveSessionAsPlaylist(name, sessionId) {
  return new Promise((resolve) => {
    socket.once('spotify:session_playlist_saved', resolve);
    socket.emit('spotify:save_session_playlist', { name, sessionId });
  });
}

/**
 * Resolve the tracks of a past session. Resolves with { id, tracks }.
 * @param {string} id  Session id.
 */
export function getSessionTracks(id) {
  return new Promise((resolve) => {
    const handler = (data) => {
      if (data && data.id === id) {
        socket.off('spotify:session_tracks', handler);
        resolve(data);
      }
    };
    socket.on('spotify:session_tracks', handler);
    socket.emit('spotify:get_session_tracks', { id });
  });
}

/**
 * Queue all tracks of a past session. Resolves with { id, count }.
 * @param {string} id  Session id.
 */
export function queueSession(id) {
  return new Promise((resolve) => {
    const handler = (data) => {
      if (data && data.id === id) {
        socket.off('spotify:session_queued', handler);
        resolve(data);
      }
    };
    socket.on('spotify:session_queued', handler);
    socket.emit('spotify:queue_session', { id });
  });
}

/**
 * Request playback queue. Resolves with { items } when server responds.
 */
export function getSpotifyQueue() {
  return _request('spotify:get_queue', undefined, 'spotify:queue', { items: [] });
}

/**
 * Request available Spotify devices. Resolves with { devices } when server responds.
 */
export function getSpotifyDevices() {
  return _request('spotify:get_devices', undefined, 'spotify:devices', { devices: [] });
}

// ---------------------------------------------------------------------------
// Playlist management
// ---------------------------------------------------------------------------

/**
 * Add a track to a playlist.
 * @param {string} trackUri
 * @param {string} playlistId
 */
export function addToPlaylist(trackUri, playlistId) {
  socket.emit('spotify:add_to_playlist', { trackUri, playlistId });
}

/**
 * Add/remove a track to the "DecklingAir Favorites" playlist.
 * @param {string} trackUri
 * @param {boolean} add  true = add, false = remove
 */
export function toggleFavorite(trackUri, add) {
  socket.emit('spotify:toggle_favorite', { trackUri, add });
}

/** Request the current favorite track-id set (also re-syncs from Spotify). */
export function getFavorites() {
  socket.emit('spotify:get_favorites');
}

// ---------------------------------------------------------------------------
// Config / auth
// ---------------------------------------------------------------------------

/**
 * Save Spotify API credentials.
 * @param {string} clientId
 * @param {string} clientSecret
 */
export function saveSpotifyConfig(clientId, clientSecret) {
  socket.emit('spotify:save_config', { clientId, clientSecret });
}

/** Save (or clear, if empty) the Last.fm API key used for the Genres tab. */
export function saveLastfmKey(key) {
  socket.emit('spotify:set_lastfm_key', { key });
}

/** Resolve whether a Last.fm key is configured. → { hasKey } */
export function getLastfmStatus() {
  return new Promise((resolve) => {
    socket.once('spotify:lastfm_status', resolve);
    socket.emit('spotify:get_lastfm_status');
  });
}

/**
 * Disconnect (revoke tokens on server).
 */
export function disconnectSpotify() {
  socket.emit('spotify:disconnect');
}

/**
 * Enable/disable the Smart Queue engine (weaves our picks into Spotify autoplay
 * for search & playlist-end; moods/vibes always use it regardless).
 * @param {boolean} enabled
 */
export function setSmartQueue(enabled) {
  socket.emit('spotify:set_smart_queue', { enabled });
}

/** Ask the server for the current Smart Queue toggle state. */
export function getSmartQueue() {
  socket.emit('spotify:get_smart_queue');
}

/**
 * Master kill-switch for ALL Spotify features. When false the server makes zero
 * outbound calls to Spotify/ReccoBeats/Last.fm (polling + every background job is
 * torn down).
 * @param {boolean} enabled
 */
export function setSpotifyFeaturesEnabled(enabled) {
  socket.emit('spotify:set_features_enabled', { enabled });
}

/** Ask the server for the current master features-enabled state. */
export function getSpotifyFeaturesEnabled() {
  socket.emit('spotify:get_features_enabled');
}

/** Respond to a feeling check-in prompt. */
export function respondToCheckIn(feeling) {
  socket.emit('spotify:checkin_response', { feeling });
}

/** Dismiss the current check-in without answering. */
export function dismissCheckIn() {
  socket.emit('spotify:dismiss_checkin');
}

/** Fetch full intelligence state. */
export function getIntelligence() {
  return new Promise((resolve) => {
    socket.once('spotify:intelligence_state', resolve);
    socket.emit('spotify:get_intelligence');
  });
}

/** Toggle automatic check-in prompts. */
export function setCheckInAuto(enabled) {
  socket.emit('spotify:set_checkin_auto', { enabled });
}

/** Stop all active feeling/mood/vibe playback. */
export function stopFeeling() {
  socket.emit('spotify:stop_feeling');
}
