/**
 * spotify-controls.js
 * Browser ES module — Spotify control cards for the VoiceMeeter control panel.
 * Renders: spotify_player, spotify_search, spotify_playlists, spotify_queue
 */

import {
  spotifyCmd,
  spotifySearch,
  getSpotifyPlaylists,
  getSpotifyPlaylistTracks,
  getSpotifyLikedSongs,
  getSpotifyAudioFeatures,
  getSpotifyBatchAudioFeatures,
  getSpotifyStats,
  resetSpotifySession,
  saveSessionAsPlaylist,
  getSpotifyQueue,
  getSpotifyDevices,
  addToPlaylist,
  getSpotifyInsights,
  renameVibe,
  playVibe,
  playNow,
  playFilter,
  getFilterCount,
} from './spotify-client.js';
import { socket } from './socket.js';

// ---------------------------------------------------------------------------
// Minimal local helpers (no import from controls.js to avoid circular deps)
// ---------------------------------------------------------------------------

function applyGridPlacement(card, ctrl) {
  if (ctrl.col)     card.style.gridColumnStart = ctrl.col;
  if (ctrl.colSpan) card.style.gridColumnEnd   = `span ${ctrl.colSpan}`;
  if (ctrl.row)     card.style.gridRowStart    = ctrl.row;
  if (ctrl.rowSpan) card.style.gridRowEnd      = `span ${ctrl.rowSpan}`;
}

function isEditMode() {
  return document.body.classList.contains('edit-mode');
}

function dragHandle() {
  const el = document.createElement('div');
  el.className = 'drag-handle';
  el.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="3" y="4"  width="12" height="2" rx="1" fill="currentColor"/>
    <rect x="3" y="8"  width="12" height="2" rx="1" fill="currentColor"/>
    <rect x="3" y="12" width="12" height="2" rx="1" fill="currentColor"/>
  </svg>`;
  return el;
}

function resizeHandle() {
  const el = document.createElement('div');
  el.className = 'resize-handle';
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M13 1L1 13M8 13H13V8" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return el;
}

function editOverlay(id) {
  const el = document.createElement('div');
  el.className = 'edit-overlay';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-overlay-btn';
  editBtn.dataset.action = 'edit';
  editBtn.dataset.ctrlId = id;
  editBtn.textContent = '✎ Edit';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'edit-overlay-btn danger';
  delBtn.dataset.action = 'delete';
  delBtn.dataset.ctrlId = id;
  delBtn.textContent = '✕ Delete';

  el.appendChild(editBtn);
  el.appendChild(delBtn);
  return el;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

const SVG = {
  heart: (filled) => filled
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="var(--accent)"
          xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
         <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5
                  2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09
                  C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5
                  c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
       </svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"
          stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
         <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06
                  a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78
                  1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
       </svg>`,

  plus: () => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`,

  speaker: () => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  </svg>`,

  prev: () => `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
  </svg>`,

  next: () => `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 18l8.5-6L6 6v12zm8.5-6v6h2V6h-2v6z"/>
  </svg>`,

  play: () => `<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 5v14l11-7z"/>
  </svg>`,

  pause: () => `<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
  </svg>`,

  shuffle: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polyline points="16 3 21 3 21 8"/>
    <line x1="4" y1="20" x2="21" y2="3"/>
    <polyline points="21 16 21 21 16 21"/>
    <line x1="15" y1="15" x2="21" y2="21"/>
  </svg>`,

  repeatContext: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>`,

  repeatTrack: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    <text x="10" y="13.5" font-size="7" fill="currentColor" stroke="none"
          font-weight="bold" text-anchor="middle">1</text>
  </svg>`,

  search: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`,

  refresh: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>`,

  spotifyLogo: () => `<svg width="40" height="40" viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#1DB954"/>
    <path d="M17.9 10.9C14.7 9 9.35 8.8 6.3 9.75c-.5.15-1-.15-1.15-.6
             -.15-.5.15-1 .6-1.15 3.55-1.05 9.4-.85 13.1 1.35.45.25.6.85.35
             1.3-.25.35-.85.5-1.3.25zm-.1 2.8c-.25.35-.7.5-1.05.25-2.7-1.65
             -6.8-2.15-9.95-1.15-.4.1-.85-.1-.95-.5-.1-.4.1-.85.5-.95
             3.65-1.1 8.15-.55 11.25 1.35.3.15.45.65.2 1zm-1.2 2.75c-.2.3
             -.55.4-.85.2-2.35-1.45-5.3-1.75-8.8-.95-.35.1-.65-.15-.75-.45
             -.1-.35.15-.65.45-.75 3.8-.85 7.1-.5 9.7 1.1.35.15.4.55.25.85z"
          fill="white"/>
  </svg>`,

  devicePhone: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
    <line x1="12" y1="18" x2="12.01" y2="18"/>
  </svg>`,

  deviceComputer: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
    <line x1="8" y1="21" x2="16" y2="21"/>
    <line x1="12" y1="17" x2="12" y2="21"/>
  </svg>`,

  deviceSpeaker: () => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="2" width="16" height="20" rx="2"/>
    <circle cx="12" cy="14" r="4"/>
    <line x1="12" y1="6" x2="12.01" y2="6"/>
  </svg>`,

  playSmall: () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 5v14l11-7z"/>
  </svg>`,

  queueAdd: () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`,

  close: () => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`,

  arrowLeft: () => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
      stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <line x1="19" y1="12" x2="5" y2="12"/>
    <polyline points="12 19 5 12 12 5"/>
  </svg>`,

  likedSongsCover: () => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"
      class="sp-playlist-cover sp-liked-songs-cover" aria-hidden="true">
    <defs>
      <linearGradient id="lsg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#450af5"/>
        <stop offset="100%" stop-color="#c4efd9"/>
      </linearGradient>
    </defs>
    <rect width="100" height="100" fill="url(#lsg)"/>
    <path d="M50 70 L22 44 C16 37 16 27 24 21 C31 15 41 18 50 27
             C59 18 69 15 76 21 C84 27 84 37 78 44 Z"
          fill="white" opacity="0.9"/>
  </svg>`,
};

// ---------------------------------------------------------------------------
// Confirmation dialog helper
// ---------------------------------------------------------------------------

function _showConfirm(message, onConfirm) {
  // Remove any existing confirm
  document.querySelector('.sp-confirm-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'sp-confirm-overlay';
  overlay.innerHTML = `
    <div class="sp-confirm-box">
      <p class="sp-confirm-msg"></p>
      <div class="sp-confirm-btns">
        <button class="sp-confirm-cancel">Cancel</button>
        <button class="sp-confirm-ok">Remove</button>
      </div>
    </div>
  `;
  overlay.querySelector('.sp-confirm-msg').textContent = message;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  overlay.querySelector('.sp-confirm-cancel').addEventListener('pointerup', close);
  overlay.querySelector('.sp-confirm-ok').addEventListener('pointerup', () => {
    close();
    onConfirm();
  });
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
}

// ---------------------------------------------------------------------------
// Popover singleton — Playlist picker
// ---------------------------------------------------------------------------

let _playlists = [];
let _playlistPopover = null;
let _playlistDocHandler = null;
let _playlistKeyHandler = null;

function showPlaylistPicker(anchorEl, trackUri) {
  closePlaylistPicker();

  const pop = document.createElement('div');
  pop.className = 'sp-popover sp-playlist-popover';
  pop.innerHTML = `
    <div class="sp-popover-header">
      <span>Add to Playlist</span>
      <button class="sp-popover-close" aria-label="Close">${SVG.close()}</button>
    </div>
    <div class="sp-popover-list"></div>
  `;
  document.body.appendChild(pop);
  _playlistPopover = pop;

  pop.querySelector('.sp-popover-close').addEventListener('pointerup', closePlaylistPicker);

  const listEl = pop.querySelector('.sp-popover-list');

  function renderList(items) {
    listEl.innerHTML = '';
    if (!items || !items.length) {
      listEl.innerHTML = '<div class="sp-popover-empty">No playlists found</div>';
      return;
    }
    items.forEach((pl) => {
      const row = document.createElement('div');
      row.className = 'sp-popover-row';
      row.innerHTML = `
        ${pl.coverUrl
          ? `<img src="${pl.coverUrl}" width="32" height="32" class="sp-thumb sp-thumb--sm" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <span class="sp-popover-row-name">${_esc(pl.name)}</span>
      `;
      row.addEventListener('pointerup', async () => {
        await addToPlaylist(trackUri, pl.id);
        closePlaylistPicker();
      });
      listEl.appendChild(row);
    });
  }

  // Always fetch fresh, owned-only list so the picker never shows followed playlists
  listEl.innerHTML = '<div class="sp-popover-empty">Loading…</div>';
  getSpotifyPlaylists({ ownedOnly: true }).then((data) => {
    renderList(data && data.items ? data.items : []);
  });

  _positionPopover(pop, anchorEl);

  _playlistDocHandler = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closePlaylistPicker();
  };
  _playlistKeyHandler = (e) => { if (e.key === 'Escape') closePlaylistPicker(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', _playlistDocHandler);
    document.addEventListener('keydown', _playlistKeyHandler);
  }, 0);
}

function closePlaylistPicker() {
  if (_playlistPopover) {
    _playlistPopover.remove();
    _playlistPopover = null;
  }
  if (_playlistDocHandler) document.removeEventListener('pointerdown', _playlistDocHandler);
  if (_playlistKeyHandler) document.removeEventListener('keydown', _playlistKeyHandler);
  _playlistDocHandler = null;
  _playlistKeyHandler = null;
}

// ---------------------------------------------------------------------------
// Popover singleton — Device picker
// ---------------------------------------------------------------------------

let _devicePopover = null;
let _deviceDocHandler = null;
let _deviceKeyHandler = null;

function showDevicePicker(anchorEl) {
  closeDevicePicker();

  const pop = document.createElement('div');
  pop.className = 'sp-popover sp-device-popover';
  pop.innerHTML = `
    <div class="sp-popover-header">
      <span>Select Device</span>
      <button class="sp-popover-close" aria-label="Close">${SVG.close()}</button>
    </div>
    <div class="sp-popover-list"><div class="sp-popover-empty">Loading…</div></div>
  `;
  document.body.appendChild(pop);
  _devicePopover = pop;

  pop.querySelector('.sp-popover-close').addEventListener('pointerup', closeDevicePicker);

  const listEl = pop.querySelector('.sp-popover-list');

  getSpotifyDevices().then((data) => {
    listEl.innerHTML = '';
    const devices = (data && data.devices) ? data.devices : [];
    if (!devices.length) {
      listEl.innerHTML = '<div class="sp-popover-empty">No devices found</div>';
      return;
    }
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'sp-popover-row' + (d.isActive ? ' sp-popover-row--active' : '');
      const icon = _deviceIcon(d.type);
      row.innerHTML = `
        <span class="sp-device-icon">${icon}</span>
        <span class="sp-popover-row-name">${_esc(d.name)}</span>
        ${d.isActive ? '<span class="sp-device-active-dot"></span>' : ''}
      `;
      row.addEventListener('pointerup', async () => {
        await spotifyCmd('transfer', { deviceId: d.id });
        closeDevicePicker();
      });
      listEl.appendChild(row);
    });
  });

  _positionPopover(pop, anchorEl);

  _deviceDocHandler = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closeDevicePicker();
  };
  _deviceKeyHandler = (e) => { if (e.key === 'Escape') closeDevicePicker(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', _deviceDocHandler);
    document.addEventListener('keydown', _deviceKeyHandler);
  }, 0);
}

function closeDevicePicker() {
  if (_devicePopover) {
    _devicePopover.remove();
    _devicePopover = null;
  }
  if (_deviceDocHandler) document.removeEventListener('pointerdown', _deviceDocHandler);
  if (_deviceKeyHandler) document.removeEventListener('keydown', _deviceKeyHandler);
  _deviceDocHandler = null;
  _deviceKeyHandler = null;
}

// ---------------------------------------------------------------------------
// Popover position helper
// ---------------------------------------------------------------------------

function _positionPopover(pop, anchor) {
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    const popH = pop.offsetHeight || 280;
    const popW = pop.offsetWidth  || 220;
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;

    let top, left;

    if (rect.bottom + popH + 8 < vpH) {
      top = rect.bottom + 8 + window.scrollY;
    } else {
      top = rect.top - popH - 8 + window.scrollY;
    }

    left = rect.left + window.scrollX;
    if (left + popW > vpW - 8) left = vpW - popW - 8;
    if (left < 8) left = 8;

    pop.style.top  = `${top}px`;
    pop.style.left = `${left}px`;
  });
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function _esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _deviceIcon(type) {
  if (!type) return SVG.deviceComputer();
  const t = type.toLowerCase();
  if (t.includes('phone') || t.includes('smartphone')) return SVG.devicePhone();
  if (t.includes('speaker')) return SVG.deviceSpeaker();
  return SVG.deviceComputer();
}

function _flashBtn(btn, color = '#1DB954') {
  const prev = btn.style.color;
  btn.style.color = color;
  setTimeout(() => { btn.style.color = prev; }, 800);
}

// Marquee scroll.
// containerEl = clip div (overflow:hidden, stays fixed).
// Inner <span> (inline-block) gets the translateX animation so it scrolls
// inside the clip boundary.
// We measure span.offsetWidth vs containerEl.offsetWidth — the most reliable
// approach for inline-block children; scrollWidth is unreliable here.
function _applyMarquee(containerEl) {
  const span = containerEl.querySelector(':scope > span');
  if (!span) return;
  // Hard-cancel any running animation so layout is settled before we measure
  span.style.animation = 'none';
  span.style.transform = 'translateX(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const overflow = span.offsetWidth - containerEl.offsetWidth;
    if (overflow > 6) {
      const secs = Math.max(3, overflow / 40);
      span.style.setProperty('--sp-scroll-shift', `-${overflow}px`);
      span.style.animation =
        `sp-marquee-scroll ${secs}s ease-in-out 1.2s infinite alternate`;
    } else {
      span.style.animation = '';
      span.style.removeProperty('--sp-scroll-shift');
    }
  }));
}

// Recently-played playlist IDs — tracked client-side for the "Recent" sort
let _recentPlaylistIds = [];

// ---------------------------------------------------------------------------
// 1. Spotify Player Card
// ---------------------------------------------------------------------------

function renderSpotifyPlayer(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card spotify-player-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-player">
      <!-- Top row -->
      <div class="sp-player-top">
        <div class="sp-album-art-wrap">
          <img class="sp-album-art" src="" alt="Album art" width="48" height="48">
          <div class="sp-no-art">${SVG.spotifyLogo()}</div>
        </div>
        <div class="sp-track-info">
          <div class="sp-track-title"><span></span></div>
          <div class="sp-track-artist"><span></span></div>
        </div>
        <div class="sp-action-btns">
          <button class="sp-icon-btn sp-heart-btn" aria-label="Like">${SVG.heart(false)}</button>
          <button class="sp-icon-btn sp-add-btn"   aria-label="Add to playlist">${SVG.plus()}</button>
          <button class="sp-icon-btn sp-device-btn" aria-label="Select device">${SVG.speaker()}</button>
        </div>
      </div>

      <!-- Seek row -->
      <div class="sp-seek-row">
        <div class="sp-seek-bar" role="slider" aria-label="Seek" tabindex="0">
          <div class="sp-seek-track">
            <div class="sp-seek-fill"></div>
            <div class="sp-seek-thumb"></div>
          </div>
        </div>
        <div class="sp-time">0:00 / 0:00</div>
      </div>

      <!-- Controls row -->
      <div class="sp-controls-row">
        <button class="sp-toggle-btn sp-shuffle-btn" aria-label="Shuffle">${SVG.shuffle()}</button>
        <div class="sp-main-controls">
          <button class="sp-ctrl-btn sp-prev-btn"  aria-label="Previous">${SVG.prev()}</button>
          <button class="sp-ctrl-btn sp-play-btn"  aria-label="Play/Pause">${SVG.play()}</button>
          <button class="sp-ctrl-btn sp-next-btn"  aria-label="Next">${SVG.next()}</button>
        </div>
        <button class="sp-toggle-btn sp-repeat-btn"  aria-label="Repeat">${SVG.repeatContext()}</button>
      </div>

      <!-- Audio features row -->
      <div class="sp-audio-features" style="display:none"></div>

      <!-- No-playback overlay -->
      <div class="sp-no-playback">
        ${SVG.spotifyLogo()}
        <span>No playback</span>
      </div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  // ---- Element refs ----
  const albumArt    = card.querySelector('.sp-album-art');
  const noArt       = card.querySelector('.sp-no-art');
  const trackInfoEl = card.querySelector('.sp-track-info');
  const titleEl     = card.querySelector('.sp-track-title');
  const artistEl    = card.querySelector('.sp-track-artist');
  const heartBtn    = card.querySelector('.sp-heart-btn');
  const addBtn      = card.querySelector('.sp-add-btn');
  const deviceBtn   = card.querySelector('.sp-device-btn');
  const seekBar     = card.querySelector('.sp-seek-bar');
  const seekFill    = card.querySelector('.sp-seek-fill');
  const seekThumb   = card.querySelector('.sp-seek-thumb');
  const timeEl      = card.querySelector('.sp-time');
  const prevBtn     = card.querySelector('.sp-prev-btn');
  const playBtn     = card.querySelector('.sp-play-btn');
  const nextBtn     = card.querySelector('.sp-next-btn');
  const shuffleBtn  = card.querySelector('.sp-shuffle-btn');
  const repeatBtn   = card.querySelector('.sp-repeat-btn');
  const noPlayback      = card.querySelector('.sp-no-playback');
  const playerEl        = card.querySelector('.sp-player');
  const audioFeaturesEl = card.querySelector('.sp-audio-features');

  // ---- Live state for RAF ----
  let _rafId      = null;
  let _liveState  = null;
  let _currentTrack = null;
  let _liked      = false;
  let _repeat     = 'off';
  let _shuffle    = false;
  let _seekDragging = false;
  let _seekPreview  = 0;

  // ---- RAF loop ----
  function _rafLoop() {
    if (!_liveState) return;
    const { progress, duration, isPlaying, ts } = _liveState;
    const live = isPlaying
      ? Math.min(progress + (Date.now() - ts), duration || 0)
      : progress;

    const pct = duration > 0 ? (live / duration) * 100 : 0;
    if (!_seekDragging) {
      seekFill.style.width  = `${pct}%`;
      seekThumb.style.left  = `${pct}%`;
      timeEl.textContent    = `${fmtMs(live)} / ${fmtMs(duration)}`;
    }

    if (isPlaying) {
      _rafId = requestAnimationFrame(_rafLoop);
    } else {
      _rafId = null;
    }
  }

  function _startRaf() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(_rafLoop);
  }

  function _stopRaf() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  }

  // ---- Seek interaction ----
  seekBar.style.touchAction = 'none';

  function _seekPctFromEvent(e) {
    const rect = seekBar.querySelector('.sp-seek-track').getBoundingClientRect();
    const x = (e.clientX ?? (e.touches && e.touches[0].clientX)) - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }

  seekBar.addEventListener('pointerdown', (e) => {
    if (isEditMode()) return;
    e.preventDefault();
    _seekDragging = true;
    seekBar.setPointerCapture(e.pointerId);
    const pct = _seekPctFromEvent(e);
    _seekPreview = pct;
    seekFill.style.width = `${pct * 100}%`;
    seekThumb.style.left = `${pct * 100}%`;
    const dur = _liveState ? _liveState.duration : 0;
    timeEl.textContent = `${fmtMs(pct * dur)} / ${fmtMs(dur)}`;
  });

  seekBar.addEventListener('pointermove', (e) => {
    if (!_seekDragging) return;
    e.preventDefault();
    const pct = _seekPctFromEvent(e);
    _seekPreview = pct;
    seekFill.style.width = `${pct * 100}%`;
    seekThumb.style.left = `${pct * 100}%`;
    const dur = _liveState ? _liveState.duration : 0;
    timeEl.textContent = `${fmtMs(pct * dur)} / ${fmtMs(dur)}`;
  });

  seekBar.addEventListener('pointerup', (e) => {
    if (!_seekDragging) return;
    _seekDragging = false;
    const dur = _liveState ? _liveState.duration : 0;
    const positionMs = Math.round(_seekPreview * dur);
    spotifyCmd('seek', { positionMs });
    if (_liveState) {
      _liveState.progress = positionMs;
      _liveState.ts = Date.now();
    }
    if (_liveState && _liveState.isPlaying) _startRaf();
    else _rafLoop();
  });

  // ---- Control buttons ----
  prevBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    spotifyCmd('prev');
  });

  nextBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    spotifyCmd('next');
  });

  playBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    const playing = _liveState ? _liveState.isPlaying : false;
    spotifyCmd(playing ? 'pause' : 'resume');
  });

  function _setHeartState(liked) {
    _liked = liked;
    heartBtn.innerHTML = SVG.heart(_liked);
    heartBtn.classList.toggle('liked', _liked);
    heartBtn.setAttribute('aria-label', _liked ? 'Unlike' : 'Like');
  }

  heartBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    if (!_currentTrack) return;

    if (_liked) {
      // Confirm before removing from likes
      _showConfirm(
        `Remove "${_currentTrack.title}" from your liked songs?`,
        () => {
          _setHeartState(false);
          // Feb 2026: API now needs the full Spotify URI (spotify:track:...) not the bare ID
          spotifyCmd('unlike', { trackUri: _currentTrack.uri });
        }
      );
    } else {
      _setHeartState(true);
      spotifyCmd('like', { trackUri: _currentTrack.uri });
    }
  });

  addBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    if (!_currentTrack) return;
    showPlaylistPicker(addBtn, _currentTrack.uri);
  });

  deviceBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    showDevicePicker(deviceBtn);
  });

  shuffleBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    _shuffle = !_shuffle;
    shuffleBtn.classList.toggle('active', _shuffle);
    spotifyCmd('shuffle', { state: _shuffle });
  });

  const _repeatCycle = ['off', 'context', 'track'];
  repeatBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    const idx = _repeatCycle.indexOf(_repeat);
    _repeat = _repeatCycle[(idx + 1) % _repeatCycle.length];
    _applyRepeat();
    spotifyCmd('repeat', { state: _repeat });
  });

  function _applyRepeat() {
    repeatBtn.classList.toggle('active', _repeat !== 'off');
    repeatBtn.innerHTML = _repeat === 'track' ? SVG.repeatTrack() : SVG.repeatContext();
  }

  // ---- _showFeatures ----
  function _showFeatures(f) {
    audioFeaturesEl.innerHTML = '';
    if (!f || (!f.bpm && !f.key)) { audioFeaturesEl.style.display = 'none'; return; }
    audioFeaturesEl.style.display = 'flex';
    const chips = [];
    if (f.bpm)   chips.push(`<span class="sp-feat-chip sp-feat-bpm">♩ ${f.bpm} BPM</span>`);
    if (f.key && f.mode) chips.push(`<span class="sp-feat-chip sp-feat-key">${f.key} ${f.mode}</span>`);
    if (f.energy != null) chips.push(`<span class="sp-feat-chip sp-feat-energy">⚡ ${f.energy}%</span>`);
    if (f.valence != null) chips.push(`<span class="sp-feat-chip sp-feat-valence">${f.valence >= 60 ? '😄' : f.valence >= 35 ? '😐' : '😔'} ${f.valence}%</span>`);
    audioFeaturesEl.innerHTML = chips.join('');
  }

  // ---- _updateSpotify ----
  card._updateSpotify = function (state) {
    const hasTrack = !!(state && state.track);

    noPlayback.style.display = hasTrack ? 'none' : 'flex';
    playerEl.classList.toggle('sp-player--no-track', !hasTrack);

    if (!hasTrack) {
      _stopRaf();
      _liveState = null;
      _currentTrack = null;
      audioFeaturesEl.style.display = 'none';
      return;
    }

    const { track, isPlaying, progress, shuffle, repeat, liked } = state;

    // When track changes (or first load): clear stale features and request fresh ones
    if (!_currentTrack || _currentTrack.id !== track.id) {
      _showFeatures(null);
      // Request features; the persistent socket.on listener below will handle the response
      socket.emit('spotify:get_audio_features', { trackId: track.id });
    }

    _currentTrack = track;
    _liked   = !!liked;
    _repeat  = repeat || 'off';
    _shuffle = !!shuffle;

    if (track.albumArt) {
      albumArt.src = track.albumArt;
      albumArt.style.display = 'block';
      noArt.style.display = 'none';
    } else {
      albumArt.style.display = 'none';
      noArt.style.display = 'flex';
    }

    const titleSpan  = titleEl.querySelector('span');
    const artistSpan = artistEl.querySelector('span');
    if (titleSpan.textContent !== (track.title || '')) {
      titleSpan.textContent = track.title || '';
      _applyMarquee(titleEl);
    }
    if (artistSpan.textContent !== (track.artist || '')) {
      artistSpan.textContent = track.artist || '';
      _applyMarquee(artistEl);
    }

    _setHeartState(_liked);
    _applyRepeat();
    shuffleBtn.classList.toggle('active', _shuffle);

    playBtn.innerHTML = isPlaying ? SVG.pause() : SVG.play();

    _liveState = {
      progress: progress ?? 0,
      duration: track.duration ?? 0,
      isPlaying,
      ts: Date.now(),
    };

    if (isPlaying) {
      _startRaf();
    } else {
      _stopRaf();
      _rafLoop();
    }
  };

  // Re-measure marquee whenever the info container changes width (card resize).
  // Debounce slightly so we don't spam rAFs during a drag-resize.
  let _marqueeResizeTimer = null;
  const marqueeRo = new ResizeObserver(() => {
    clearTimeout(_marqueeResizeTimer);
    _marqueeResizeTimer = setTimeout(() => {
      _applyMarquee(titleEl);
      _applyMarquee(artistEl);
    }, 60);
  });
  marqueeRo.observe(trackInfoEl);

  // Audio features socket listener
  const _onFeatures = (f) => {
    if (f && _currentTrack && f.trackId === _currentTrack.id) _showFeatures(f);
  };
  socket.on('spotify:audio_features', _onFeatures);

  // Clean up when card is removed from the DOM
  const _playerCleanupObs = new MutationObserver(() => {
    if (!document.contains(card)) {
      marqueeRo.disconnect();
      socket.off('spotify:audio_features', _onFeatures);
      _playerCleanupObs.disconnect();
    }
  });
  _playerCleanupObs.observe(document.body, { childList: true, subtree: true });

  return card;
}

// ---------------------------------------------------------------------------
// 2. Spotify Search Card
// ---------------------------------------------------------------------------

function renderSpotifySearch(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card spotify-search-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-search-wrap">
      <div class="sp-search-input-row">
        <span class="sp-search-icon">${SVG.search()}</span>
        <input class="sp-search-input" type="text" placeholder="Search songs…" autocomplete="off" spellcheck="false">
        <button class="sp-search-clear" aria-label="Clear search" style="display:none">${SVG.close()}</button>
      </div>
      <div class="sp-search-results"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const input      = card.querySelector('.sp-search-input');
  const clearBtn   = card.querySelector('.sp-search-clear');
  const results    = card.querySelector('.sp-search-results');

  let _debounce = null;
  let _outsideHandler = null;

  function _deselectAll() {
    results.querySelectorAll('.sp-row-selected').forEach(r => {
      r.classList.remove('sp-row-selected');
      const actions = r.querySelector('.sp-search-row-actions');
      if (actions) actions.style.display = 'none';
    });
    if (_outsideHandler) {
      document.removeEventListener('pointerdown', _outsideHandler);
      _outsideHandler = null;
    }
  }

  function _selectRow(row) {
    _deselectAll();
    row.classList.add('sp-row-selected');
    const actions = row.querySelector('.sp-search-row-actions');
    if (actions) actions.style.display = 'flex';
    _outsideHandler = (e) => {
      if (!card.contains(e.target)) _deselectAll();
    };
    setTimeout(() => document.addEventListener('pointerdown', _outsideHandler), 0);
  }

  function _updateClearBtn() {
    clearBtn.style.display = input.value.length > 0 ? 'flex' : 'none';
  }

  clearBtn.addEventListener('pointerup', () => {
    input.value = '';
    results.innerHTML = '';
    _deselectAll();
    _updateClearBtn();
    input.focus();
  });

  input.addEventListener('input', () => {
    if (isEditMode()) return;
    _updateClearBtn();
    clearTimeout(_debounce);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    _debounce = setTimeout(() => { spotifySearch(q); }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (isEditMode()) { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      clearTimeout(_debounce);
      const q = input.value.trim();
      if (q) spotifySearch(q);
    }
    if (e.key === 'Escape') _deselectAll();
  });

  input.addEventListener('pointerdown', (e) => {
    if (isEditMode()) e.preventDefault();
  });

  card._updateSpotifySearch = function (data) {
    _deselectAll();
    results.innerHTML = '';
    const items = (data && data.items) ? data.items.slice(0, 5) : [];
    if (!items.length) {
      results.innerHTML = '<div class="sp-search-empty">No results</div>';
      return;
    }
    items.forEach((track) => {
      const row = document.createElement('div');
      row.className = 'sp-search-row';
      row.innerHTML = `
        <div class="sp-search-row-main">
          ${track.albumArt
            ? `<img src="${track.albumArt}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
            : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
          <div class="sp-search-row-info">
            <div class="sp-search-row-title">${_esc(track.title)}</div>
            <div class="sp-search-row-artist">${_esc(track.artist)}</div>
          </div>
        </div>
        <div class="sp-search-row-actions" style="display:none">
          <button class="sp-row-action-btn sp-row-action-play" aria-label="Play now">
            ${SVG.play()}<span>Play</span>
          </button>
          <button class="sp-row-action-btn sp-row-action-queue" aria-label="Add to queue">
            ${SVG.queueAdd()}<span>Queue</span>
          </button>
        </div>
      `;

      // Row click → select (not play)
      row.addEventListener('pointerup', (e) => {
        if (isEditMode()) return;
        if (e.target.closest('.sp-row-action-btn')) return; // handled below
        _selectRow(row);
      });

      row.querySelector('.sp-row-action-play').addEventListener('pointerup', (e) => {
        if (isEditMode()) return;
        e.stopPropagation();
        spotifyCmd('play', { uris: [track.uri] });
        _deselectAll();
      });

      row.querySelector('.sp-row-action-queue').addEventListener('pointerup', (e) => {
        if (isEditMode()) return;
        e.stopPropagation();
        spotifyCmd('queue_add', { uri: track.uri });
        _flashBtn(e.currentTarget);
        _deselectAll();
      });

      results.appendChild(row);
    });
  };

  return card;
}

// ---------------------------------------------------------------------------
// 3. Spotify Playlists Card
// ---------------------------------------------------------------------------

let _playlistCardUpdaters = new Set();

export function updateSpotifyPlaylists(data) {
  _playlistCardUpdaters.forEach((fn) => fn(data));
}

// Synthetic Liked Songs "playlist" object — not a real Spotify playlist
const LIKED_SONGS_PLAYLIST = {
  id: '__liked_songs__',
  uri: 'spotify:collection:tracks',
  name: 'Liked Songs',
  isLikedSongs: true,
  coverUrl: null,
};

function renderSpotifyPlaylists(ctrl) {
  const cfg = ctrl.config || ctrl.cfg || {};
  const columns = cfg.columns || 3;
  const showSpecialPlaylists = !!cfg.showSpecialPlaylists;

  // Restore persisted sort mode
  const _savedSort = localStorage.getItem('sp-playlists-sort') || 'added';

  const card = document.createElement('div');
  card.className = 'control-card spotify-playlists-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-playlists-wrap">

      <!-- Grid view -->
      <div class="sp-pl-grid-view">
        <div class="sp-section-header">
          <span class="sp-section-title">Playlists</span>
          <div class="sp-sort-bar">
            <button class="sp-sort-btn${_savedSort === 'added'  ? ' active' : ''}" data-sort="added">Added</button>
            <button class="sp-sort-btn${_savedSort === 'name'   ? ' active' : ''}" data-sort="name">A–Z</button>
            <button class="sp-sort-btn${_savedSort === 'recent' ? ' active' : ''}" data-sort="recent">Recent</button>
          </div>
        </div>
        <div class="sp-playlists-grid" style="--sp-pl-cols: ${columns}"></div>
      </div>

      <!-- Detail view (hidden until a playlist is clicked) -->
      <div class="sp-pl-detail-view" style="display:none">
        <div class="sp-pl-detail-header">
          <button class="sp-pl-back-btn" aria-label="Back to playlists">${SVG.arrowLeft()}</button>
          <span class="sp-pl-detail-name"></span>
          <button class="sp-pl-detail-play-btn" aria-label="Play playlist">${SVG.play()}</button>
        </div>
        <div class="sp-pl-detail-tracks"></div>
      </div>

    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  // ---- Element refs ----
  const gridView      = card.querySelector('.sp-pl-grid-view');
  const detailView    = card.querySelector('.sp-pl-detail-view');
  const grid          = card.querySelector('.sp-playlists-grid');
  const sortBar       = card.querySelector('.sp-sort-bar');
  const backBtn       = card.querySelector('.sp-pl-back-btn');
  const detailName    = card.querySelector('.sp-pl-detail-name');
  const detailPlayBtn = card.querySelector('.sp-pl-detail-play-btn');
  const detailTracks  = card.querySelector('.sp-pl-detail-tracks');

  let _allItems = [];
  let _sortMode = _savedSort;
  let _selectedPlaylist = null;
  let _currentDetailTracks = [];
  let _trackFeatures = {}; // trackId → features object
  let _bpmFilter = 'all';

  // ---- Grid: build display list (special playlists prepended, then sorted regular ones) ----
  function _sorted() {
    const items = [..._allItems];
    if (_sortMode === 'name') {
      items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (_sortMode === 'recent') {
      items.sort((a, b) => {
        const ai = _recentPlaylistIds.indexOf(a.id);
        const bi = _recentPlaylistIds.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
    // Prepend special playlists (Liked Songs) — always at top regardless of sort
    return showSpecialPlaylists ? [LIKED_SONGS_PLAYLIST, ...items] : items;
  }

  // ---- Grid: render ----
  function _renderGrid() {
    grid.innerHTML = '';
    const items = _sorted();
    if (!items.length) {
      grid.innerHTML = '<div class="sp-playlists-empty">No playlists</div>';
      return;
    }
    items.forEach((pl) => {
      const item = document.createElement('div');
      item.className = 'sp-playlist-item';
      if (pl.isLikedSongs) {
        item.innerHTML = `
          ${SVG.likedSongsCover()}
          <div class="sp-playlist-name">${_esc(pl.name)}</div>
        `;
      } else {
        item.innerHTML = `
          ${pl.coverUrl
            ? `<img src="${pl.coverUrl}" class="sp-playlist-cover" alt="">`
            : `<div class="sp-playlist-cover sp-thumb--placeholder"></div>`}
          <div class="sp-playlist-name">${_esc(pl.name)}</div>
        `;
      }
      item.addEventListener('pointerdown', () => {
        if (isEditMode()) return;
        item.classList.add('sp-playlist-item--pressed');
      });
      item.addEventListener('pointerup', () => {
        item.classList.remove('sp-playlist-item--pressed');
        if (isEditMode()) return;
        if (!pl.isLikedSongs) {
          _recentPlaylistIds = [pl.id, ..._recentPlaylistIds.filter(x => x !== pl.id)].slice(0, 100);
        }
        _openDetail(pl);
      });
      item.addEventListener('pointercancel', () => item.classList.remove('sp-playlist-item--pressed'));
      grid.appendChild(item);
    });
  }

  // ---- BPM filter helpers ----
  function _getBpmLabel(bpm) {
    if (!bpm) return 'other';
    if (bpm < 90)  return 'slow';
    if (bpm < 130) return 'mid';
    return 'fast';
  }

  function _renderDetailHeader() {
    // Only show filter row if we have some audio features loaded
    const hasFeatures = Object.keys(_trackFeatures).length > 0;
    let filterEl = detailView.querySelector('.sp-pl-bpm-filter');
    if (!hasFeatures) { if (filterEl) filterEl.remove(); return; }
    if (!filterEl) {
      filterEl = document.createElement('div');
      filterEl.className = 'sp-pl-bpm-filter';
      // Insert between header and track list
      detailTracks.parentNode.insertBefore(filterEl, detailTracks);
    }
    const filters = [
      { key: 'all', label: 'All' },
      { key: 'slow', label: '🐢 Slow (<90)' },
      { key: 'mid',  label: '🚶 Mid (90–130)' },
      { key: 'fast', label: '🔥 Fast (>130)' },
    ];
    filterEl.innerHTML = filters.map(f =>
      `<button class="sp-bpm-btn${_bpmFilter === f.key ? ' active' : ''}" data-bpm="${f.key}">${f.label}</button>`
    ).join('');
    filterEl.querySelectorAll('.sp-bpm-btn').forEach(btn => {
      btn.addEventListener('pointerup', () => {
        _bpmFilter = btn.dataset.bpm;
        _renderDetailHeader();
        _renderTracksFiltered();
      });
    });
  }

  function _renderTracksFiltered() {
    if (_bpmFilter === 'all') {
      _renderTracks(_currentDetailTracks);
      return;
    }
    const filtered = _currentDetailTracks.filter(t => {
      const f = _trackFeatures[t.id];
      return f ? _getBpmLabel(f.bpm) === _bpmFilter : false;
    });
    _renderTracks(filtered);
  }

  // ---- Detail: open ----
  function _openDetail(playlist) {
    _selectedPlaylist = playlist;
    _trackFeatures = {};
    _bpmFilter = 'all';
    detailName.textContent = playlist.name;
    detailTracks.innerHTML = '<div class="sp-loading">Loading tracks…</div>';
    gridView.style.display = 'none';
    detailView.style.removeProperty('display');

    const loadPromise = playlist.isLikedSongs
      ? getSpotifyLikedSongs({ limit: 50 }).then((data) => data.tracks || [])
      : getSpotifyPlaylistTracks(playlist.id).then((data) => data.tracks || []);

    loadPromise
      .then((tracks) => {
        _currentDetailTracks = tracks;
        _renderDetailHeader();
        _renderTracks(tracks);
        // Fetch audio features in background
        const ids = tracks.map(t => t.id).filter(Boolean);
        if (ids.length) {
          getSpotifyBatchAudioFeatures(ids).then((data) => {
            const features = (data && data.features) ? data.features : [];
            features.forEach((f) => { if (f && f.trackId) _trackFeatures[f.trackId] = f; });
            _renderDetailHeader(); // re-render filter bar now that features are loaded
            _renderTracksFiltered();
          }).catch(() => {});
        }
      })
      .catch(() => {
        detailTracks.innerHTML = '<div class="sp-queue-empty">Could not load tracks</div>';
      });
  }

  // ---- Detail: close ----
  function _closeDetail() {
    _selectedPlaylist = null;
    _currentDetailTracks = [];
    _trackFeatures = {};
    _bpmFilter = 'all';
    detailView.querySelector('.sp-pl-bpm-filter')?.remove();
    detailView.style.display = 'none';
    gridView.style.removeProperty('display');
  }

  // ---- Detail: render track list ----
  function _renderTracks(tracks) {
    detailTracks.innerHTML = '';
    if (!tracks.length) {
      detailTracks.innerHTML = '<div class="sp-queue-empty">No tracks</div>';
      return;
    }
    tracks.forEach((track, i) => {
      const row = document.createElement('div');
      row.className = 'sp-pl-track-row';
      row.innerHTML = `
        <span class="sp-pl-track-num">${i + 1}</span>
        <div class="sp-pl-track-info">
          <div class="sp-pl-track-title">${_esc(track.title)}</div>
          <div class="sp-pl-track-artist">${_esc(track.artist)}</div>
        </div>
        <span class="sp-pl-track-dur">${fmtMs(track.duration)}</span>
      `;
      row.addEventListener('pointerup', () => {
        if (isEditMode()) return;
        // Play the playlist/collection starting from this specific track
        spotifyCmd('play', { contextUri: _selectedPlaylist.uri, offsetUri: track.uri });
      });
      detailTracks.appendChild(row);
    });
  }

  // ---- Event listeners ----
  backBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    _closeDetail();
  });

  detailPlayBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    if (!_selectedPlaylist) return;
    spotifyCmd('play', { contextUri: _selectedPlaylist.uri });
  });

  sortBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sp-sort-btn');
    if (!btn) return;
    _sortMode = btn.dataset.sort;
    localStorage.setItem('sp-playlists-sort', _sortMode);
    sortBar.querySelectorAll('.sp-sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    _renderGrid();
  });

  // ---- Data ----
  function _render(data) {
    _allItems = (data && data.items) ? data.items : [];
    if (!_selectedPlaylist) _renderGrid();
  }

  card._updateSpotifyPlaylists = _render;
  _playlistCardUpdaters.add(_render);

  const observer = new MutationObserver(() => {
    if (!document.contains(card)) {
      _playlistCardUpdaters.delete(_render);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Fetch all playlists (unfiltered) for the browser; share with the picker cache
  getSpotifyPlaylists().then((data) => {
    if (data && data.items) {
      _playlists = data.items;
      _render(data);
    }
  });

  return card;
}

// ---------------------------------------------------------------------------
// 4. Spotify Queue Card
// ---------------------------------------------------------------------------

let _queueCardUpdaters = new Set();

export function updateSpotifyQueue(data) {
  _queueCardUpdaters.forEach((fn) => fn(data));
}

function renderSpotifyQueue(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card spotify-queue-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-queue-wrap">
      <div class="sp-section-header">
        <span class="sp-section-title">Up Next</span>
        <button class="sp-icon-btn sp-queue-refresh" aria-label="Refresh queue">${SVG.refresh()}</button>
      </div>
      <div class="sp-queue-list"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const listEl     = card.querySelector('.sp-queue-list');
  const refreshBtn = card.querySelector('.sp-queue-refresh');

  function _render(data) {
    listEl.innerHTML = '';
    const items = (data && data.items) ? data.items : [];
    if (!items.length) {
      listEl.innerHTML = '<div class="sp-queue-empty">Queue empty</div>';
      return;
    }
    items.forEach((track) => {
      const row = document.createElement('div');
      row.className = 'sp-queue-row';
      row.innerHTML = `
        ${track.albumArt
          ? `<img src="${track.albumArt}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <div class="sp-queue-row-info">
          <div class="sp-queue-row-title">${_esc(track.title)}</div>
          <div class="sp-queue-row-artist">${_esc(track.artist)}</div>
        </div>
        <div class="sp-queue-row-duration">${fmtMs(track.duration)}</div>
      `;
      listEl.appendChild(row);
    });
  }

  card._updateSpotifyQueue = _render;
  _queueCardUpdaters.add(_render);

  refreshBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    getSpotifyQueue().then(_render);
  });

  // Compact mode: hide art + duration when card is narrow
  const queueRo = new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    card.classList.toggle('sp-queue-compact', w < 160);
  });
  queueRo.observe(card);

  const observer = new MutationObserver(() => {
    if (!document.contains(card)) {
      _queueCardUpdaters.delete(_render);
      queueRo.disconnect();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  getSpotifyQueue().then(_render);

  return card;
}

// ---------------------------------------------------------------------------
// 5. Spotify Stats Card
// ---------------------------------------------------------------------------

let _statsCardUpdaters = new Set();

export function updateSpotifyStats(data) {
  _statsCardUpdaters.forEach((fn) => fn(data));
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderSpotifyStats(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card spotify-stats-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  // Default playlist name: "Session · 3 Jun 2026"
  const _defaultName = () =>
    `Session · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  card.innerHTML = `
    <div class="sp-stats-wrap">
      <div class="sp-section-header">
        <span class="sp-section-title">Session</span>
        <span class="sp-stats-since"></span>
        <button class="sp-stats-reset-btn" aria-label="Reset session" title="Reset session">↺</button>
      </div>
      <div class="sp-stats-grid">
        <div class="sp-stat-tile">
          <div class="sp-stat-value sp-stat-tracks">—</div>
          <div class="sp-stat-label">Tracks</div>
        </div>
        <div class="sp-stat-tile">
          <div class="sp-stat-value sp-stat-time">—</div>
          <div class="sp-stat-label">Listened</div>
        </div>
      </div>
      <div class="sp-stats-artists">
        <div class="sp-stats-artists-title">Top Artists</div>
        <div class="sp-stats-artists-list"></div>
      </div>
      <div class="sp-stats-recent">
        <div class="sp-stats-recent-title">Recently Played</div>
        <div class="sp-stats-recent-list"></div>
      </div>
      <!-- Save as playlist -->
      <div class="sp-save-session">
        <button class="sp-save-session-btn">💾 Save as Playlist</button>
        <div class="sp-save-session-form" style="display:none">
          <input class="sp-save-session-input" type="text" placeholder="Playlist name…" maxlength="100">
          <div class="sp-save-session-actions">
            <button class="sp-save-session-confirm">Save</button>
            <button class="sp-save-session-cancel">Cancel</button>
          </div>
        </div>
        <div class="sp-save-session-feedback" style="display:none"></div>
      </div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const resetBtn      = card.querySelector('.sp-stats-reset-btn');
  const sinceEl       = card.querySelector('.sp-stats-since');
  const tracksEl      = card.querySelector('.sp-stat-tracks');
  const timeEl        = card.querySelector('.sp-stat-time');
  const artistsList   = card.querySelector('.sp-stats-artists-list');
  const recentList    = card.querySelector('.sp-stats-recent-list');
  const saveBtn       = card.querySelector('.sp-save-session-btn');
  const saveForm      = card.querySelector('.sp-save-session-form');
  const saveInput     = card.querySelector('.sp-save-session-input');
  const saveConfirm   = card.querySelector('.sp-save-session-confirm');
  const saveCancel    = card.querySelector('.sp-save-session-cancel');
  const saveFeedback  = card.querySelector('.sp-save-session-feedback');

  // ---- Actual play-time timer (counts only while Spotify is playing) ----
  let _listenedMs = 0;   // accumulated ms while playing
  let _playStart  = null; // Date.now() when playback last started, null when paused

  function _getLiveMs() {
    return _listenedMs + (_playStart !== null ? Date.now() - _playStart : 0);
  }

  const _onStateForTimer = (state) => {
    const playing = !!(state && state.isPlaying);
    if (playing && _playStart === null) {
      _playStart = Date.now();
    } else if (!playing && _playStart !== null) {
      _listenedMs += Date.now() - _playStart;
      _playStart = null;
    }
    // Always keep the tile up to date immediately on state change
    timeEl.textContent = fmtDuration(_getLiveMs());
  };
  socket.on('spotify:state', _onStateForTimer);

  // Tick every second so the displayed time advances while playing
  const _timerInterval = setInterval(() => {
    if (_playStart !== null) timeEl.textContent = fmtDuration(_getLiveMs());
  }, 1000);

  resetBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    // Reset client-side timer too
    _listenedMs = 0;
    _playStart = null;
    timeEl.textContent = fmtDuration(0);
    resetSpotifySession();
  });

  function _showSaveForm() {
    saveBtn.style.display = 'none';
    saveFeedback.style.display = 'none';
    saveInput.value = _defaultName();
    saveForm.style.display = 'flex';
    saveInput.focus();
    saveInput.select();
  }

  function _hideSaveForm() {
    saveForm.style.display = 'none';
    saveBtn.style.display = '';
  }

  function _showFeedback(msg, isError = false) {
    saveFeedback.textContent = msg;
    saveFeedback.className = 'sp-save-session-feedback' + (isError ? ' sp-save-error' : ' sp-save-success');
    saveFeedback.style.display = '';
    // Auto-hide after 4 s
    clearTimeout(saveFeedback._timer);
    saveFeedback._timer = setTimeout(() => {
      saveFeedback.style.display = 'none';
      saveBtn.style.display = '';
    }, 4000);
  }

  saveBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    _showSaveForm();
  });

  saveCancel.addEventListener('pointerup', () => _hideSaveForm());

  saveInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveConfirm.click();
    if (e.key === 'Escape') _hideSaveForm();
  });

  saveConfirm.addEventListener('pointerup', async () => {
    if (isEditMode()) return;
    const name = saveInput.value.trim() || _defaultName();
    saveConfirm.disabled = true;
    saveConfirm.textContent = 'Saving…';
    saveForm.style.display = 'none';
    saveFeedback.style.display = 'none';

    const result = await saveSessionAsPlaylist(name);
    saveConfirm.disabled = false;
    saveConfirm.textContent = 'Save';

    if (result && result.success) {
      _showFeedback(`✓ "${result.name}" saved — ${result.trackCount} tracks`);
    } else {
      _showFeedback(`✗ ${result?.error || 'Unknown error'}`, true);
    }
  });

  function _render(data) {
    if (!data) return;
    sinceEl.textContent = `since ${fmtTime(data.startTime)}`;
    tracksEl.textContent = data.tracksCount ?? 0;
    // timeEl is owned by the play-timer above — don't overwrite it here

    artistsList.innerHTML = '';
    const artists = (data.topArtists || []).slice(0, 5);
    const maxCount = artists.length ? artists[0].count : 1;
    artists.forEach(({ name, count }) => {
      const row = document.createElement('div');
      row.className = 'sp-artist-row';
      const pct = Math.round((count / maxCount) * 100);
      row.innerHTML = `
        <div class="sp-artist-bar-wrap">
          <div class="sp-artist-bar" style="width:${pct}%"></div>
        </div>
        <span class="sp-artist-name">${_esc(name)}</span>
        <span class="sp-artist-count">${count}</span>
      `;
      artistsList.appendChild(row);
    });
    if (!artists.length) artistsList.innerHTML = '<div class="sp-queue-empty">No data yet</div>';

    recentList.innerHTML = '';
    (data.recentTracks || []).forEach(({ title, artist }) => {
      const row = document.createElement('div');
      row.className = 'sp-recent-row';
      row.innerHTML = `
        <div class="sp-recent-title">${_esc(title)}</div>
        <div class="sp-recent-artist">${_esc(artist)}</div>
      `;
      recentList.appendChild(row);
    });
    if (!data.recentTracks || !data.recentTracks.length) recentList.innerHTML = '<div class="sp-queue-empty">No data yet</div>';
  }

  _statsCardUpdaters.add(_render);

  const observer = new MutationObserver(() => {
    if (!document.contains(card)) {
      _statsCardUpdaters.delete(_render);
      socket.off('spotify:state', _onStateForTimer);
      clearInterval(_timerInterval);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  getSpotifyStats().then(_render);

  return card;
}

// ---------------------------------------------------------------------------
// 6. Spotify Insights Card
// ---------------------------------------------------------------------------

export function renderSpotifyInsights(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card spotify-insights-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-ins-wrap">
      <div class="sp-ins-tab-bar">
        <button class="sp-ins-tab active" data-tab="profile">Profile</button>
        <button class="sp-ins-tab" data-tab="patterns">Patterns</button>
        <button class="sp-ins-tab" data-tab="vibes">Vibes</button>
        <button class="sp-ins-tab" data-tab="rightnow">Right Now</button>
        <button class="sp-ins-tab" data-tab="filter">Filter</button>
      </div>
      <div class="sp-ins-content">

        <!-- PROFILE -->
        <div class="sp-ins-panel" data-panel="profile">
          <div class="sp-ins-stats-row">
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-total">—</span><span class="sp-ins-stat-lbl">Plays</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-unique">—</span><span class="sp-ins-stat-lbl">Unique</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-days">—</span><span class="sp-ins-stat-lbl">Days</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-peak">—</span><span class="sp-ins-stat-lbl">Peak hour</span></div>
          </div>
          <div class="sp-ins-features-section" style="display:none">
            <div class="sp-ins-sub-title">Audio Profile <span class="sp-ins-feat-avg-bpm"></span></div>
            <div class="sp-ins-feat-bars"></div>
          </div>
          <div class="sp-ins-sub-title sp-ins-artists-title">Top Artists</div>
          <div class="sp-ins-artists-list"></div>
        </div>

        <!-- PATTERNS -->
        <div class="sp-ins-panel" data-panel="patterns" style="display:none">
          <div class="sp-ins-sub-title">When you listen most</div>
          <div class="sp-ins-heatmap-wrap">
            <div class="sp-ins-heatmap"></div>
          </div>
          <div class="sp-ins-heatmap-legend">
            <span>Less</span>
            <span class="sp-ins-legend-boxes"></span>
            <span>More</span>
          </div>
        </div>

        <!-- VIBES -->
        <div class="sp-ins-panel" data-panel="vibes" style="display:none">
          <div class="sp-ins-vibes-empty" style="display:none">
            <div class="sp-ins-empty-icon">✨</div>
            <div class="sp-ins-empty-msg">Keep listening to build your vibe profile</div>
            <div class="sp-ins-empty-sub sp-ins-vibe-progress"></div>
          </div>
          <div class="sp-ins-vibes-list"></div>
        </div>

        <!-- RIGHT NOW -->
        <div class="sp-ins-panel" data-panel="rightnow" style="display:none">
          <div class="sp-ins-rn-empty" style="display:none">
            <div class="sp-ins-empty-icon">▶</div>
            <div class="sp-ins-empty-msg">Keep listening to enable Right Now</div>
            <div class="sp-ins-empty-sub">Not enough data for your current time yet</div>
          </div>
          <div class="sp-ins-rn-content" style="display:none">
            <div class="sp-ins-rn-time"></div>
            <div class="sp-ins-rn-vibe-label">You usually listen to</div>
            <div class="sp-ins-rn-vibe-name"></div>
            <div class="sp-ins-rn-sample"></div>
            <button class="sp-ins-action-btn sp-ins-rn-play-btn">▶ Queue this vibe</button>
          </div>
        </div>

        <!-- FILTER -->
        <div class="sp-ins-panel" data-panel="filter" style="display:none">
          <div class="sp-ins-filter-form">
            <div class="sp-ins-filter-row">
              <label class="sp-ins-filter-label">Energy <span class="sp-ins-energy-val">0–100%</span></label>
              <div class="sp-ins-range-wrap">
                <input type="range" class="sp-ins-range" id="ins-energy-min" min="0" max="100" value="0">
                <input type="range" class="sp-ins-range" id="ins-energy-max" min="0" max="100" value="100">
              </div>
            </div>
            <div class="sp-ins-filter-row">
              <label class="sp-ins-filter-label">Mood <span class="sp-ins-mood-val">Sad → Happy (0–100%)</span></label>
              <div class="sp-ins-range-wrap">
                <input type="range" class="sp-ins-range" id="ins-mood-min" min="0" max="100" value="0">
                <input type="range" class="sp-ins-range" id="ins-mood-max" min="0" max="100" value="100">
              </div>
            </div>
            <div class="sp-ins-filter-row">
              <label class="sp-ins-filter-label">BPM</label>
              <div class="sp-ins-bpm-row">
                <input type="number" class="sp-ins-bpm-input" id="ins-bpm-min" min="0" max="300" value="0" placeholder="Min">
                <span class="sp-ins-bpm-sep">–</span>
                <input type="number" class="sp-ins-bpm-input" id="ins-bpm-max" min="0" max="300" value="300" placeholder="Max">
              </div>
            </div>
            <div class="sp-ins-filter-footer">
              <span class="sp-ins-filter-count">— tracks match</span>
              <button class="sp-ins-action-btn sp-ins-filter-play-btn" disabled>Queue tracks</button>
            </div>
          </div>
        </div>

      </div>
      <div class="sp-ins-action-feedback" style="display:none"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  // ---- Tab switching ----
  const tabBar     = card.querySelector('.sp-ins-tab-bar');
  const panels     = card.querySelectorAll('.sp-ins-panel');
  const feedback   = card.querySelector('.sp-ins-action-feedback');

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sp-ins-tab');
    if (!btn) return;
    tabBar.querySelectorAll('.sp-ins-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    panels.forEach(p => p.style.display = p.dataset.panel === btn.dataset.tab ? '' : 'none');
  });

  // ---- Feedback helper ----
  function _showFeedback(msg, ok = true) {
    feedback.textContent = msg;
    feedback.className = 'sp-ins-action-feedback ' + (ok ? 'sp-ins-fb-ok' : 'sp-ins-fb-err');
    feedback.style.display = '';
    clearTimeout(feedback._t);
    feedback._t = setTimeout(() => { feedback.style.display = 'none'; }, 4000);
  }

  // ---- Listen for action results ----
  const _onAction = (data) => _showFeedback(data.msg, data.ok);
  const _onVibeRenamed = ({ key, name }) => {
    card.querySelectorAll(`.sp-ins-vibe-row[data-key="${key}"] .sp-ins-vibe-name-text`).forEach(el => {
      el.textContent = name;
    });
  };
  socket.on('spotify:insights_action', _onAction);
  socket.on('spotify:vibe_renamed', _onVibeRenamed);

  // ---- Render helpers ----
  const HOUR_LABELS = ['12am','1am','2am','3am','4am','5am','6am','7am','8am','9am','10am','11am',
                       '12pm','1pm','2pm','3pm','4pm','5pm','6pm','7pm','8pm','9pm','10pm','11pm'];

  function _renderProfile(p) {
    if (!p.ready) return;
    card.querySelector('.sp-ins-total').textContent  = p.total;
    card.querySelector('.sp-ins-unique').textContent = p.unique;
    card.querySelector('.sp-ins-days').textContent   = p.daysLogging;
    card.querySelector('.sp-ins-peak').textContent   = HOUR_LABELS[p.peakHour] || '—';

    if (p.avgFeatures) {
      const sec = card.querySelector('.sp-ins-features-section');
      sec.style.display = '';
      if (p.avgFeatures.bpm) card.querySelector('.sp-ins-feat-avg-bpm').textContent = `· avg ${p.avgFeatures.bpm} BPM`;
      const barsEl = card.querySelector('.sp-ins-feat-bars');
      barsEl.innerHTML = '';
      const feats = [
        { label: 'Energy',      val: p.avgFeatures.energy   },
        { label: 'Mood',        val: p.avgFeatures.valence  },
        { label: 'Danceability',val: p.avgFeatures.dance    },
        { label: 'Acoustic',    val: p.avgFeatures.acoustic },
        { label: 'Instrumental',val: p.avgFeatures.inst     },
      ];
      feats.forEach(({ label, val }) => {
        const row = document.createElement('div');
        row.className = 'sp-ins-feat-row';
        row.innerHTML = `
          <span class="sp-ins-feat-lbl">${label}</span>
          <div class="sp-ins-feat-bar-wrap"><div class="sp-ins-feat-bar" style="width:${val}%"></div></div>
          <span class="sp-ins-feat-num">${val}%</span>
        `;
        barsEl.appendChild(row);
      });
    }

    const artistsList = card.querySelector('.sp-ins-artists-list');
    artistsList.innerHTML = '';
    const maxC = p.topArtists.length ? p.topArtists[0].count : 1;
    p.topArtists.forEach(({ name, count }) => {
      const row = document.createElement('div');
      row.className = 'sp-ins-artist-row';
      const pct = Math.round((count / maxC) * 100);
      row.innerHTML = `
        <span class="sp-ins-artist-name">${_esc(name)}</span>
        <div class="sp-ins-artist-bar-wrap"><div class="sp-ins-artist-bar" style="width:${pct}%"></div></div>
        <span class="sp-ins-artist-count">${count}</span>
      `;
      artistsList.appendChild(row);
    });
  }

  function _renderPatterns(p) {
    const heatmap = card.querySelector('.sp-ins-heatmap');
    heatmap.innerHTML = '';
    // Header row: day names
    const header = document.createElement('div');
    header.className = 'sp-ins-hm-header';
    header.innerHTML = `<div class="sp-ins-hm-row-label"></div>` +
      p.dayNames.map(d => `<div class="sp-ins-hm-day">${d}</div>`).join('');
    heatmap.appendChild(header);
    // Data rows
    p.blockNames.forEach((blockName, bi) => {
      const row = document.createElement('div');
      row.className = 'sp-ins-hm-row';
      const shortLabel = blockName.split(' ')[0]; // first word only
      let html = `<div class="sp-ins-hm-row-label">${shortLabel}</div>`;
      p.dayNames.forEach((_, di) => {
        const count = p.grid[bi][di];
        const intensity = Math.round((count / p.max) * 100);
        const alpha = count === 0 ? 0.05 : 0.1 + (intensity / 100) * 0.85;
        html += `<div class="sp-ins-hm-cell" title="${p.blockNames[bi]} · ${p.dayNames[di]}: ${count} plays"
                      style="background:rgba(29,185,84,${alpha.toFixed(2)})"></div>`;
      });
      row.innerHTML = html;
      heatmap.appendChild(row);
    });
    // Legend
    const legend = card.querySelector('.sp-ins-legend-boxes');
    legend.innerHTML = [0.05, 0.2, 0.4, 0.65, 0.9].map(a =>
      `<span class="sp-ins-legend-box" style="background:rgba(29,185,84,${a})"></span>`
    ).join('');
  }

  function _renderVibes(v) {
    const emptyEl = card.querySelector('.sp-ins-vibes-empty');
    const listEl  = card.querySelector('.sp-ins-vibes-list');
    if (!v.ready) {
      emptyEl.style.display = '';
      listEl.style.display  = 'none';
      card.querySelector('.sp-ins-vibe-progress').textContent =
        `${v.current} / ${v.needed} plays logged`;
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display  = '';
    listEl.innerHTML = '';
    v.clusters.forEach(cl => {
      const row = document.createElement('div');
      row.className = 'sp-ins-vibe-row';
      row.dataset.key = cl.key;
      const chips = [];
      if (cl.avgEnergy  != null) chips.push(`<span class="sp-feat-chip sp-feat-energy">⚡ ${cl.avgEnergy}%</span>`);
      if (cl.avgValence != null) chips.push(`<span class="sp-feat-chip sp-feat-valence">${cl.avgValence >= 60 ? '😄' : cl.avgValence >= 35 ? '😐' : '😔'} ${cl.avgValence}%</span>`);
      if (cl.avgBpm     != null) chips.push(`<span class="sp-feat-chip sp-feat-bpm">♩ ${cl.avgBpm}</span>`);
      row.innerHTML = `
        <div class="sp-ins-vibe-top">
          <span class="sp-ins-vibe-name-wrap">
            <span class="sp-ins-vibe-name-text">${_esc(cl.name)}</span>
            <button class="sp-ins-vibe-rename-btn" title="Rename">✎</button>
          </span>
          <span class="sp-ins-vibe-meta">${cl.plays} plays · ${cl.count} tracks</span>
          <button class="sp-ins-action-btn sp-ins-vibe-queue-btn">Queue</button>
        </div>
        <div class="sp-ins-vibe-chips">${chips.join('')}</div>
      `;
      // Rename
      row.querySelector('.sp-ins-vibe-rename-btn').addEventListener('pointerup', () => {
        if (isEditMode()) return;
        const nameEl = row.querySelector('.sp-ins-vibe-name-text');
        const current = nameEl.textContent;
        const input = document.createElement('input');
        input.className = 'sp-ins-vibe-rename-input';
        input.value = current;
        nameEl.replaceWith(input);
        input.focus(); input.select();
        const commit = () => {
          const val = input.value.trim() || current;
          const newText = document.createElement('span');
          newText.className = 'sp-ins-vibe-name-text';
          newText.textContent = val;
          input.replaceWith(newText);
          if (val !== current) renameVibe(cl.key, val);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { input.value = current; commit(); }
        });
      });
      // Queue
      row.querySelector('.sp-ins-vibe-queue-btn').addEventListener('pointerup', () => {
        if (isEditMode()) return;
        playVibe(cl.key);
        _showFeedback(`Queuing "${cl.name}"…`);
      });
      listEl.appendChild(row);
    });
  }

  function _renderRightNow(rn) {
    const emptyEl   = card.querySelector('.sp-ins-rn-empty');
    const contentEl = card.querySelector('.sp-ins-rn-content');
    if (!rn.ready) {
      emptyEl.style.display   = '';
      contentEl.style.display = 'none';
      return;
    }
    emptyEl.style.display   = 'none';
    contentEl.style.display = '';
    card.querySelector('.sp-ins-rn-time').textContent =
      `${rn.dayName} · ${rn.timeLabel}`;
    card.querySelector('.sp-ins-rn-vibe-name').textContent = rn.vibeName;
    card.querySelector('.sp-ins-rn-sample').textContent =
      `Based on ${rn.sampleSize} plays${rn.broad ? ' (similar time)' : ' at this time'}`;
  }

  card.querySelector('.sp-ins-rn-play-btn').addEventListener('pointerup', () => {
    if (isEditMode()) return;
    playNow();
    _showFeedback('Queuing your Right Now vibe…');
  });

  // ---- Filter tab ----
  const energyMin  = card.querySelector('#ins-energy-min');
  const energyMax  = card.querySelector('#ins-energy-max');
  const moodMin    = card.querySelector('#ins-mood-min');
  const moodMax    = card.querySelector('#ins-mood-max');
  const bpmMin     = card.querySelector('#ins-bpm-min');
  const bpmMax     = card.querySelector('#ins-bpm-max');
  const countEl    = card.querySelector('.sp-ins-filter-count');
  const filterBtn  = card.querySelector('.sp-ins-filter-play-btn');
  const energyVal  = card.querySelector('.sp-ins-energy-val');
  const moodVal    = card.querySelector('.sp-ins-mood-val');

  let _filterDebounce = null;
  function _getFilterParams() {
    return {
      minEnergy: Math.min(+energyMin.value, +energyMax.value),
      maxEnergy: Math.max(+energyMin.value, +energyMax.value),
      minValence: Math.min(+moodMin.value, +moodMax.value),
      maxValence: Math.max(+moodMin.value, +moodMax.value),
      minBpm: Math.min(+bpmMin.value || 0, +bpmMax.value || 300),
      maxBpm: Math.max(+bpmMin.value || 0, +bpmMax.value || 300),
    };
  }
  function _updateFilterLabels() {
    const eMin = Math.min(+energyMin.value, +energyMax.value);
    const eMax = Math.max(+energyMin.value, +energyMax.value);
    const mMin = Math.min(+moodMin.value,   +moodMax.value);
    const mMax = Math.max(+moodMin.value,   +moodMax.value);
    energyVal.textContent = eMin === 0 && eMax === 100 ? 'any' : `${eMin}–${eMax}%`;
    moodVal.textContent   = mMin === 0 && mMax === 100 ? 'any' : `${mMin}–${mMax}%`;
  }
  function _requestFilterCount() {
    clearTimeout(_filterDebounce);
    _filterDebounce = setTimeout(() => {
      getFilterCount(_getFilterParams());
    }, 300);
  }
  [energyMin, energyMax, moodMin, moodMax, bpmMin, bpmMax].forEach(el => {
    el.addEventListener('input', () => { _updateFilterLabels(); _requestFilterCount(); });
  });

  const _onFilterCount = ({ total }) => {
    countEl.textContent = `${total} track${total !== 1 ? 's' : ''} match`;
    filterBtn.disabled = total === 0;
  };
  socket.on('spotify:filter_count', _onFilterCount);

  filterBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    playFilter(_getFilterParams());
    _showFeedback('Queuing filtered tracks…');
  });

  // ---- Main data load ----
  function _loadAll(data) {
    if (!data) return;
    _renderProfile(data.profile  || {});
    _renderPatterns(data.patterns || { grid: [], max: 1, blockNames: [], dayNames: [], total: 0 });
    _renderVibes(data.vibes      || { ready: false, needed: 20, current: 0 });
    _renderRightNow(data.rightNow|| {});
    // Init filter count
    _requestFilterCount();
  }

  // Cleanup
  const _cleanObs = new MutationObserver(() => {
    if (!document.contains(card)) {
      socket.off('spotify:insights_action', _onAction);
      socket.off('spotify:vibe_renamed',    _onVibeRenamed);
      socket.off('spotify:filter_count',    _onFilterCount);
      _cleanObs.disconnect();
    }
  });
  _cleanObs.observe(document.body, { childList: true, subtree: true });

  getSpotifyInsights().then(_loadAll);

  return card;
}

// ---------------------------------------------------------------------------
// Dispatch export
// ---------------------------------------------------------------------------

export function renderSpotifyControl(ctrl) {
  switch (ctrl.type) {
    case 'spotify_player':    return renderSpotifyPlayer(ctrl);
    case 'spotify_search':    return renderSpotifySearch(ctrl);
    case 'spotify_playlists': return renderSpotifyPlaylists(ctrl);
    case 'spotify_queue':     return renderSpotifyQueue(ctrl);
    case 'spotify_stats':     return renderSpotifyStats(ctrl);
    case 'spotify_insights':  return renderSpotifyInsights(ctrl);
    default:
      console.warn('[spotify-controls] Unknown control type:', ctrl.type);
      return null;
  }
}
