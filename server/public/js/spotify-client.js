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
export function spotifySearch(query) {
  socket.emit('spotify:search', { query });
}

// ---------------------------------------------------------------------------
// Data requests (return Promises via one-time listeners)
// ---------------------------------------------------------------------------

/**
 * Request playlist list. Resolves with { items } when server responds.
 */
export function getSpotifyPlaylists() {
  return new Promise((resolve) => {
    socket.once('spotify:playlists', resolve);
    socket.emit('spotify:get_playlists');
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
