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
 * Request playlist list. Resolves with { items } when server responds.
 * @param {object} [opts]
 * @param {boolean} [opts.ownedOnly=false]  true = only return playlists the user can modify
 */
export function getSpotifyPlaylists(opts = {}) {
  return new Promise((resolve) => {
    socket.once('spotify:playlists', resolve);
    socket.emit('spotify:get_playlists', opts);
  });
}

/**
 * Request tracks for a specific playlist. Resolves with { playlistId, tracks }.
 * @param {string} playlistId
 */
export function getSpotifyPlaylistTracks(playlistId) {
  return new Promise((resolve) => {
    socket.once('spotify:playlist_tracks', resolve);
    socket.emit('spotify:get_playlist_tracks', { playlistId });
  });
}

/**
 * Request liked songs. Resolves with { tracks } when server responds.
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 */
export function getSpotifyLikedSongs(opts = {}) {
  return new Promise((resolve) => {
    socket.once('spotify:liked_songs', resolve);
    socket.emit('spotify:get_liked_songs', opts);
  });
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

/** Request the current global tuning profile (server replies with spotify:tuning). */
export function getTuning() {
  socket.emit('spotify:get_tuning');
}

/** Update the global tuning profile. Accepts a partial { key: value } patch. */
export function setTuning(tuning) {
  socket.emit('spotify:set_tuning', { tuning });
}

export function saveSessionAsPlaylist(name) {
  return new Promise((resolve) => {
    socket.once('spotify:session_playlist_saved', resolve);
    socket.emit('spotify:save_session_playlist', { name });
  });
}

/**
 * Request playback queue. Resolves with { items } when server responds.
 */
export function getSpotifyQueue() {
  return new Promise((resolve) => {
    socket.once('spotify:queue', resolve);
    socket.emit('spotify:get_queue');
  });
}

/**
 * Request available Spotify devices. Resolves with { devices } when server responds.
 */
export function getSpotifyDevices() {
  return new Promise((resolve) => {
    socket.once('spotify:devices', resolve);
    socket.emit('spotify:get_devices');
  });
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

/**
 * Disconnect (revoke tokens on server).
 */
export function disconnectSpotify() {
  socket.emit('spotify:disconnect');
}

/**
 * Enable/disable auto-play recommendations.
 * @param {boolean} enabled
 */
export function setSpotifyAutoplay(enabled) {
  socket.emit('spotify:set_autoplay', { enabled });
}

/**
 * Enable/disable smart shuffle (recommendation pre-mixing).
 * @param {boolean} enabled
 */
export function setSpotifySmartShuffle(enabled) {
  socket.emit('spotify:set_smart_shuffle', { enabled });
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
