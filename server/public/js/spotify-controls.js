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
  getSessionTracks,
  queueSession,
  getSpotifyQueue,
  getSpotifyDevices,
  addToPlaylist,
  getSpotifyInsights,
  renameVibe,
  setSmartQueue,
  getSmartQueue,
  playMood,
  stopContinuous,
  playMix,
  getMixMap,
  getGenreProfile,
  getTuning,
  setTuning,
  getTimezone,
  setTimezone,
  respondToCheckIn,
  dismissCheckIn,
  getIntelligence,
  setCheckInAuto,
  stopFeeling,
} from './spotify-client.js';
import { socket } from './socket.js';

// ---------------------------------------------------------------------------
// Shared inline SVG icons (consistent line-icon set across the Spotify cards)
// ---------------------------------------------------------------------------

const _svg = (paths, size = 14) =>
  `<svg class="sp-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const SP_ICON = {
  // List with a plus — "add to playlist"
  playlistAdd: _svg('<path d="M3 6h12M3 12h9M3 18h7"/><path d="M18 14v6M15 17h6"/>'),
  // Circular refresh arrow — "reset"
  reset: _svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  // Filled play triangle — "queue all / play"
  play: _svg('<path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none"/>'),
  // Chevron — expand/collapse
  chevron: _svg('<path d="M6 9l6 6 6-6"/>', 13),
};

// ---------------------------------------------------------------------------
// Minimal local helpers (no import from controls.js to avoid circular deps)
// ---------------------------------------------------------------------------

// Legacy grid → pixel migration constants (must match controls.js).
const LEGACY_COL_W = 150;
const LEGACY_ROW_H = 80;
const LEGACY_GAP = 8;

function applyGridPlacement(card, ctrl) {
  let x = ctrl.x;
  let y = ctrl.y;
  let w = ctrl.w;
  let h = ctrl.h;

  if (!Number.isFinite(x) || !Number.isFinite(w)) {
    const col = Number.isFinite(ctrl.col) ? ctrl.col : 1;
    const row = Number.isFinite(ctrl.row) ? ctrl.row : 1;
    const colSpan = Number.isFinite(ctrl.colSpan) ? ctrl.colSpan : 1;
    const rowSpan = Number.isFinite(ctrl.rowSpan) ? ctrl.rowSpan : 2;
    x = (col - 1) * (LEGACY_COL_W + LEGACY_GAP);
    y = (row - 1) * (LEGACY_ROW_H + LEGACY_GAP);
    w = colSpan * LEGACY_COL_W + (colSpan - 1) * LEGACY_GAP;
    h = rowSpan * LEGACY_ROW_H + (rowSpan - 1) * LEGACY_GAP;
    ctrl.x = x; ctrl.y = y; ctrl.w = w; ctrl.h = h;
  }

  card.style.position = 'absolute';
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
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

// Set the text of a marquee clip (a container holding one inner <span>) and
// (re)measure it, exactly like the player does for long titles/artists. Creates
// the inner span if missing. Only re-applies the marquee when the text changes.
function _setMarqueeText(clipEl, text) {
  if (!clipEl) return;
  clipEl.classList.remove('sp-marquee-static'); // re-enable scrolling if it was static
  let span = clipEl.querySelector(':scope > span');
  if (!span) { span = document.createElement('span'); clipEl.appendChild(span); }
  const str = text == null ? '' : String(text);
  if (span.textContent !== str) {
    span.textContent = str;
    _applyMarquee(clipEl);
  }
}

// Set a clip element's text as STATIC — it wraps and never scrolls (the inverse of
// _setMarqueeText). Adds the .sp-marquee-static class so CSS lets it wrap, and
// cancels any marquee animation left over from a previous render of this element.
function _setStaticText(clipEl, text) {
  if (!clipEl) return;
  let span = clipEl.querySelector(':scope > span');
  if (!span) { span = document.createElement('span'); clipEl.appendChild(span); }
  clipEl.classList.add('sp-marquee-static');
  span.style.animation = 'none';
  span.style.transform = 'none';
  span.style.removeProperty('--sp-scroll-shift');
  span.textContent = text == null ? '' : String(text);
}

// Recently-played playlist IDs — tracked client-side for the "Recent" sort
let _recentPlaylistIds = [];

// Lightweight toast used within this module (e.g. autoplay toggle feedback)
function _spToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'sp-toast' + (isError ? ' sp-toast-error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('sp-toast-visible'));
  setTimeout(() => {
    t.classList.remove('sp-toast-visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 500);
  }, 2200);
}

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

      <!-- Smart Queue toggle -->
      <div class="sp-smart-row">
        <button class="sp-smart-btn sp-smartqueue-btn" aria-label="Smart Queue" title="Smart Queue — weaves your picks into Spotify's autoplay. On: also for search & playlist-end. Moods & vibes always use it.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z"/><polyline points="16 3 21 3 21 8"/><line x1="14" y1="10" x2="21" y2="3"/></svg>
          Smart Queue
        </button>
      </div>

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
  const smartQueueBtn   = card.querySelector('.sp-smartqueue-btn');

  // ── Smart Queue toggle (state is server-owned + persisted in user prefs) ──
  let _smartQueue = true; // optimistic; server confirms via 'spotify:smart_queue'

  function _renderSmartQueue() {
    smartQueueBtn.classList.toggle('active', _smartQueue);
  }
  _renderSmartQueue();

  // Server is the source of truth — ask for it on init and every reconnect.
  getSmartQueue();
  socket.on('connect', () => { getSmartQueue(); });
  socket.on('spotify:smart_queue', ({ enabled } = {}) => {
    _smartQueue = !!enabled;
    _renderSmartQueue();
  });

  smartQueueBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    _smartQueue = !_smartQueue;
    _renderSmartQueue();
    setSmartQueue(_smartQueue);
    _spToast(_smartQueue ? 'Smart Queue on' : 'Smart Queue off — search & playlists use Spotify autoplay');
  });

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

  // Audio-feature chips (BPM / key / energy / valence) are no longer shown in the
  // player. Features are still tracked server-side for the intelligence panel.

  // ---- _updateSpotify ----
  card._updateSpotify = function (state) {
    const hasTrack = !!(state && state.track);

    noPlayback.style.display = hasTrack ? 'none' : 'flex';
    playerEl.classList.toggle('sp-player--no-track', !hasTrack);

    if (!hasTrack) {
      _stopRaf();
      _liveState = null;
      _currentTrack = null;
      return;
    }

    const { track, isPlaying, progress, shuffle, repeat, liked } = state;

    // Was this same track already playing in the bar? (Captured BEFORE we
    // overwrite _currentTrack below.) Used to smooth out tiny backward jumps.
    const _wasSameTrack = !!(_currentTrack && _currentTrack.id === track.id);
    // The position the seek bar is currently showing (interpolated), so we can
    // detect when an incoming poll would yank it backward.
    const _prevDisplayed = _liveState
      ? (_liveState.isPlaying
          ? Math.min(_liveState.progress + (Date.now() - _liveState.ts), _liveState.duration || 0)
          : _liveState.progress)
      : null;

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

    // Anti-rewind smoothing. The server's progress is sampled slightly in the
    // past (network + request-queue latency), so stamping it with a fresh ts
    // makes the bar jump backward by the round-trip time on every poll. For the
    // SAME playing track, if the new position is only marginally behind what the
    // bar already shows, keep the displayed position instead of snapping back —
    // the tiny over-estimate self-corrects as real progress catches up. Real
    // backward seeks (large jumps) and track changes are always honored.
    const SEEK_BACK_TOLERANCE = 3000; // ms — below this a backward move is treated as latency jitter
    let _baseProgress = progress ?? 0;
    if (_wasSameTrack && isPlaying && _prevDisplayed != null) {
      const backJump = _prevDisplayed - _baseProgress;
      if (backJump > 0 && backJump < SEEK_BACK_TOLERANCE) {
        _baseProgress = _prevDisplayed;
      }
    }

    _liveState = {
      progress: _baseProgress,
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

  // Adapt the player layout to its panel so the four rows never clip:
  //   short → drop the Smart Queue row
  //   mini  → also hide the time read-out + tighten the seek row
  //   compact (narrow) → shrink album art + hide the secondary action buttons
  const _playerRo = new ResizeObserver(entries => {
    const { height, width } = entries[0].contentRect;
    card.classList.toggle('sp-player-short',   height < 150);
    card.classList.toggle('sp-player-mini',    height < 116);
    card.classList.toggle('sp-player-compact', width  < 230);
  });
  _playerRo.observe(card);

  // Clean up when card is removed from the DOM
  const _playerCleanupObs = new MutationObserver(() => {
    if (!document.contains(card)) {
      marqueeRo.disconnect();
      _playerRo.disconnect();
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
        <input class="sp-search-input" type="text" placeholder="Search…" autocomplete="off" spellcheck="false">
        <button class="sp-search-clear" aria-label="Clear search" style="display:none">${SVG.close()}</button>
      </div>
      <div class="sp-search-tabs">
        <button class="sp-stab active" data-type="track">Tracks</button>
        <button class="sp-stab" data-type="artist">Artists</button>
        <button class="sp-stab" data-type="album">Albums</button>
        <button class="sp-stab" data-type="playlist">Playlists</button>
      </div>
      <div class="sp-search-results"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const input    = card.querySelector('.sp-search-input');
  const clearBtn = card.querySelector('.sp-search-clear');
  const results  = card.querySelector('.sp-search-results');
  const tabs     = card.querySelectorAll('.sp-stab');

  let _debounce       = null;
  let _outsideHandler = null;
  let _lastQuery      = '';
  let _showingRecents = false;
  let _searchType     = 'track';

  tabs.forEach(tab => {
    tab.addEventListener('pointerup', () => {
      if (isEditMode()) return;
      _searchType = tab.dataset.type;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      if (_lastQuery) { spotifySearch(_lastQuery, _searchType); }
      else { _showRecentTracks(); }
    });
  });

  // ── Recent tracks (played/queued from search) ────────────────────────────
  const RECENT_KEY = 'sp-recent-tracks';
  const MAX_RECENT = 15;

  function _loadRecentTracks() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
  }
  function _saveRecentTracks(list) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  }
  function _addRecentTrack(track) {
    const list = _loadRecentTracks().filter(t => t.id !== track.id);
    list.unshift({ id: track.id, uri: track.uri, title: track.title,
                   artist: track.artist, albumArt: track.albumArt || '' });
    _saveRecentTracks(list);
  }

  // ── Row builder ──────────────────────────────────────────────────────────
  function _buildRow(track) {
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

    // Tap row → show actions. Use pointerdown+pointerup tracking so layout
    // shifts from showing the buttons don't cause a missed tap on touch.
    let _downOnRow = false;
    row.addEventListener('pointerdown', (e) => {
      if (isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = true;
    });
    row.addEventListener('pointerup', (e) => {
      if (!_downOnRow || isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = false;
      _selectRow(row);
    });
    row.addEventListener('pointercancel', () => { _downOnRow = false; });

    row.querySelector('.sp-row-action-play').addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      spotifyCmd('play', { uris: [track.uri] });
      _addRecentTrack(track);
      _deselectAll();
    });

    row.querySelector('.sp-row-action-queue').addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      spotifyCmd('queue_add', {
        uri: track.uri, id: track.id,
        title: track.title, artist: track.artist,
        albumArt: track.albumArt || '',
      });
      _addRecentTrack(track);
      _flashBtn(e.currentTarget);
      _deselectAll();
    });

    return row;
  }

  // ── Non-track row builders ────────────────────────────────────────────────
  function _buildArtistRow(a) {
    const row = document.createElement('div');
    row.className = 'sp-search-row sp-search-row--artist';
    row.innerHTML = `
      <div class="sp-search-row-main">
        ${a.image
          ? `<img src="${a.image}" class="sp-thumb sp-thumb--sm sp-thumb--round" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--round sp-thumb--placeholder"></div>`}
        <div class="sp-search-row-info">
          <div class="sp-search-row-title">${_esc(a.name)}</div>
          <div class="sp-search-row-artist">${_esc(a.genres || 'Artist')}</div>
        </div>
      </div>
      <div class="sp-search-row-actions" style="display:none">
        <button class="sp-row-action-btn sp-row-action-play" aria-label="Play artist">
          ${SVG.play()}<span>Play</span>
        </button>
      </div>
    `;
    let _downOnRow = false;
    row.addEventListener('pointerdown', (e) => {
      if (isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = true;
    });
    row.addEventListener('pointerup', (e) => {
      if (!_downOnRow || isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = false; _selectRow(row);
    });
    row.addEventListener('pointercancel', () => { _downOnRow = false; });
    row.querySelector('.sp-row-action-play').addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      spotifyCmd('play', { contextUri: a.uri });
      _deselectAll();
    });
    return row;
  }

  function _buildAlbumRow(al) {
    const row = document.createElement('div');
    row.className = 'sp-search-row sp-search-row--album';
    row.innerHTML = `
      <div class="sp-search-row-main">
        ${al.image
          ? `<img src="${al.image}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <div class="sp-search-row-info">
          <div class="sp-search-row-title">${_esc(al.name)}</div>
          <div class="sp-search-row-artist">${_esc(al.artist)}${al.year ? ` · ${al.year}` : ''}</div>
        </div>
      </div>
      <div class="sp-search-row-actions" style="display:none">
        <button class="sp-row-action-btn sp-row-action-play" aria-label="Play album">
          ${SVG.play()}<span>Play</span>
        </button>
        <button class="sp-row-action-btn sp-row-action-queue" aria-label="Queue album">
          ${SVG.queueAdd()}<span>Queue</span>
        </button>
      </div>
    `;
    let _downOnRow = false;
    row.addEventListener('pointerdown', (e) => {
      if (isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = true;
    });
    row.addEventListener('pointerup', (e) => {
      if (!_downOnRow || isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = false; _selectRow(row);
    });
    row.addEventListener('pointercancel', () => { _downOnRow = false; });
    row.querySelector('.sp-row-action-play').addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      spotifyCmd('play', { contextUri: al.uri });
      _deselectAll();
    });
    const queueBtn = row.querySelector('.sp-row-action-queue');
    if (queueBtn) queueBtn.addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      _spToast('Album queued after current track (Spotify limitation: albums queue as context)');
      spotifyCmd('play', { contextUri: al.uri });
      _flashBtn(e.currentTarget);
      _deselectAll();
    });
    return row;
  }

  function _buildPlaylistRow(p) {
    const row = document.createElement('div');
    row.className = 'sp-search-row sp-search-row--playlist';
    row.innerHTML = `
      <div class="sp-search-row-main">
        ${p.image
          ? `<img src="${p.image}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <div class="sp-search-row-info">
          <div class="sp-search-row-title">${_esc(p.name)}</div>
          <div class="sp-search-row-artist">${_esc(p.owner)}${p.total ? ` · ${p.total} tracks` : ''}</div>
        </div>
      </div>
      <div class="sp-search-row-actions" style="display:none">
        <button class="sp-row-action-btn sp-row-action-play" aria-label="Play playlist">
          ${SVG.play()}<span>Play</span>
        </button>
      </div>
    `;
    let _downOnRow = false;
    row.addEventListener('pointerdown', (e) => {
      if (isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = true;
    });
    row.addEventListener('pointerup', (e) => {
      if (!_downOnRow || isEditMode() || e.target.closest('.sp-row-action-btn')) return;
      _downOnRow = false; _selectRow(row);
    });
    row.addEventListener('pointercancel', () => { _downOnRow = false; });
    row.querySelector('.sp-row-action-play').addEventListener('pointerup', (e) => {
      if (isEditMode()) return;
      e.stopPropagation();
      spotifyCmd('play', { contextUri: p.uri });
      _deselectAll();
    });
    return row;
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function _renderRows(items, type) {
    _showingRecents = false;
    results.innerHTML = '';
    if (!items.length) {
      results.innerHTML = '<div class="sp-search-empty">No results</div>';
      return;
    }
    items.forEach(item => {
      if (type === 'artist')   results.appendChild(_buildArtistRow(item));
      else if (type === 'album')    results.appendChild(_buildAlbumRow(item));
      else if (type === 'playlist') results.appendChild(_buildPlaylistRow(item));
      else                          results.appendChild(_buildRow(item));
    });
  }

  function _renderTrackRows(tracks) { _renderRows(tracks, 'track'); }

  function _showRecentTracks() {
    _showingRecents = true;
    results.innerHTML = '';
    const list = _loadRecentTracks();
    if (!list.length) return;

    const header = document.createElement('div');
    header.className = 'sp-recent-header';
    header.innerHTML = `<span class="sp-recent-label">Recent</span>
      <button class="sp-recent-clear-all">Clear</button>`;
    header.querySelector('.sp-recent-clear-all').addEventListener('pointerup', (e) => {
      e.stopPropagation();
      localStorage.removeItem(RECENT_KEY);
      results.innerHTML = '';
    });
    results.appendChild(header);
    list.forEach(t => results.appendChild(_buildRow(t)));
  }

  // ── Selection ────────────────────────────────────────────────────────────
  function _deselectAll() {
    results.querySelectorAll('.sp-row-selected').forEach(r => {
      r.classList.remove('sp-row-selected');
      const a = r.querySelector('.sp-search-row-actions');
      if (a) a.style.display = 'none';
    });
    if (_outsideHandler) {
      document.removeEventListener('pointerup', _outsideHandler);
      _outsideHandler = null;
    }
  }

  function _selectRow(row) {
    _deselectAll();
    row.classList.add('sp-row-selected');
    const actions = row.querySelector('.sp-search-row-actions');
    if (actions) actions.style.display = 'flex';

    // Wait long enough (400ms) that the current touch gesture is fully
    // finished before we start listening for outside taps.
    _outsideHandler = (e) => {
      if (!card.contains(e.target)) _deselectAll();
    };
    setTimeout(() => document.addEventListener('pointerup', _outsideHandler), 400);
  }

  // ── Input bar ────────────────────────────────────────────────────────────
  function _updateClearBtn() {
    clearBtn.style.display = input.value.length > 0 ? 'flex' : 'none';
  }

  clearBtn.addEventListener('pointerup', () => {
    input.value = '';
    _lastQuery = '';
    _deselectAll();
    _updateClearBtn();
    _showRecentTracks();
    input.focus();
  });

  input.addEventListener('input', () => {
    if (isEditMode()) return;
    _updateClearBtn();
    clearTimeout(_debounce);
    const q = input.value.trim();
    if (!q) { _showRecentTracks(); return; }
    _debounce = setTimeout(() => { _lastQuery = q; spotifySearch(q, _searchType); }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (isEditMode()) { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      clearTimeout(_debounce);
      const q = input.value.trim();
      if (q) { _lastQuery = q; spotifySearch(q, _searchType); }
    }
    if (e.key === 'Escape') _deselectAll();
  });

  input.addEventListener('pointerdown', (e) => {
    if (isEditMode()) e.preventDefault();
  });

  // Show recent tracks immediately on card creation
  _showRecentTracks();

  card._updateSpotifySearch = function (data) {
    if (!input.value.trim()) return;
    _deselectAll();
    const type  = data?.type || 'track';
    const items = (data?.items || []).slice(0, 10);
    _renderRows(items, type);
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
          <div class="sp-playlist-cover-wrap">${SVG.likedSongsCover()}</div>
          <div class="sp-playlist-name">${_esc(pl.name)}</div>
        `;
      } else {
        item.innerHTML = `
          <div class="sp-playlist-cover-wrap">
            ${pl.coverUrl
              ? `<img src="${pl.coverUrl}" class="sp-playlist-cover" alt="">`
              : `<div class="sp-playlist-cover sp-thumb--placeholder"></div>`}
          </div>
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
        <span class="sp-queue-auto-pill" title="This queue is being managed automatically" hidden>
          <span class="sp-queue-auto-dot"></span><span class="sp-queue-auto-text">Auto</span>
        </span>
        <button class="sp-icon-btn sp-queue-refresh" aria-label="Refresh queue">${SVG.refresh()}</button>
      </div>
      <div class="sp-queue-strip" hidden>
        <div class="sp-queue-strip-streak"></div>
        <div class="sp-queue-strip-meta">
          <svg class="sp-queue-spark" width="64" height="16" viewBox="0 0 64 16" preserveAspectRatio="none" aria-hidden="true"></svg>
          <span class="sp-queue-journey" title="Harmonic key journey of the upcoming queue"></span>
        </div>
      </div>
      <div class="sp-queue-list"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const listEl     = card.querySelector('.sp-queue-list');
  const refreshBtn = card.querySelector('.sp-queue-refresh');
  const autoPill   = card.querySelector('.sp-queue-auto-pill');
  const stripEl    = card.querySelector('.sp-queue-strip');
  const streakEl   = card.querySelector('.sp-queue-strip-streak');
  const sparkEl    = card.querySelector('.sp-queue-spark');
  const journeyEl  = card.querySelector('.sp-queue-journey');

  // Render the header insight strip from the Smart Queue meta summary. Hidden
  // entirely when no session is active, so plain playback stays clean.
  function _renderStrip(meta) {
    if (!meta || (!meta.streak && !(meta.journey && meta.journey.length) && !(meta.energy && meta.energy.length))) {
      stripEl.hidden = true;
      return;
    }
    stripEl.hidden = false;
    stripEl.classList.toggle('is-closing', !!meta.setCloser);
    // #3 — explore/exploit momentum colouring (restless = explore, locked = exploit).
    stripEl.classList.toggle('is-restless', meta.momentum === 'restless');
    stripEl.classList.toggle('is-locked',   meta.momentum === 'locked');

    streakEl.textContent = meta.streak || '';
    streakEl.style.display = meta.streak ? '' : 'none';

    // #2 — key journey "8A → 9A → 10A"
    const j = (meta.journey || []).filter(Boolean);
    journeyEl.textContent = j.length ? j.join(' → ') : '';
    journeyEl.style.display = j.length ? '' : 'none';

    // #4 — energy sparkline: map non-null energies to a 0..16 polyline across 64px.
    const pts = (meta.energy || []);
    const valid = pts.filter(v => v != null);
    if (valid.length >= 2) {
      const n = pts.length;
      const coords = [];
      pts.forEach((v, i) => {
        if (v == null) return;
        const x = n > 1 ? (i / (n - 1)) * 62 + 1 : 32;
        const y = 15 - (Math.max(0, Math.min(100, v)) / 100) * 14; // 1..15, higher energy = higher
        coords.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      });
      sparkEl.innerHTML = `<polyline points="${coords.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      sparkEl.style.display = '';
    } else {
      sparkEl.innerHTML = '';
      sparkEl.style.display = 'none';
    }
  }

  // ---- "Auto" pill: reflects the continuous engine + flashes on refill ----
  let _autoActive = false;
  let _flashTimer = null;
  function _setAuto(active) {
    _autoActive = !!active;
    autoPill.hidden = !_autoActive;
    if (!_autoActive) autoPill.classList.remove('is-flash');
  }
  function _flashAuto() {
    if (!_autoActive) return;
    autoPill.classList.add('is-flash');
    clearTimeout(_flashTimer);
    _flashTimer = setTimeout(() => autoPill.classList.remove('is-flash'), 1100);
  }
  const _onContState = (d) => _setAuto(!!(d && (d.activeMoodKey || d.activeVibeKey || d.activeFeeling || d.activeMix)));
  const _onQueueManaged = (d) => { _setAuto(true); if (d && d.added > 0) _flashAuto(); };
  socket.on('spotify:continuous_state', _onContState);
  socket.on('spotify:queue_managed',    _onQueueManaged);

  function _render(data) {
    listEl.innerHTML = '';
    _renderStrip(data && data.meta);
    const items = (data && data.items) ? data.items : [];
    if (!items.length) {
      listEl.innerHTML = '<div class="sp-queue-empty">Queue empty</div>';
      return;
    }
    items.forEach((track) => {
      const row = document.createElement('div');
      row.className = 'sp-queue-row';
      if (track.source === 'ours') row.classList.add('sp-queue-row--ours');
      if (track.source === 'manual') row.classList.add('sp-queue-row--manual');
      if (track.smoothMix) row.classList.add('sp-queue-row--smooth');
      // "Why-picked" line: surfaces the engine's reasoning (loved artist · late-night
      // match · smooth mix · fresh discovery). Only Smart Queue picks carry a reason.
      // Wrap the reason in a marquee clip (clip div → one inner span) so long
      // "one of your most-played · loved artist · evening match" lines scroll
      // instead of clipping — exactly like the player's title/artist.
      const reasonHtml = track.reason
        ? `<div class="sp-queue-row-reason"><span>${track.smoothMix ? '<span class="sp-smooth-dot" title="Harmonically smooth transition">∿</span> ' : ''}${_esc(track.reason)}</span></div>`
        : '';
      row.innerHTML = `
        ${track.albumArt
          ? `<img src="${track.albumArt}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <div class="sp-queue-row-info">
          <div class="sp-queue-row-title">${_esc(track.title)}</div>
          <div class="sp-queue-row-artist">${_esc(track.artist)}</div>
          ${reasonHtml}
        </div>
        <div class="sp-queue-row-duration">${fmtMs(track.duration)}</div>
      `;
      listEl.appendChild(row);
      // Scroll long reason lines once they're laid out in the DOM.
      const reasonClip = row.querySelector('.sp-queue-row-reason');
      if (reasonClip) _applyMarquee(reasonClip);
    });
  }

  card._updateSpotifyQueue = _render;
  _queueCardUpdaters.add(_render);

  refreshBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    getSpotifyQueue().then(_render);
  });

  // Compact mode: hide art + duration when card is narrow
  let _reasonMarqueeTimer = null;
  const queueRo = new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    card.classList.toggle('sp-queue-compact', w < 160);
    // Re-measure reason marquees on width change, like the player does.
    clearTimeout(_reasonMarqueeTimer);
    _reasonMarqueeTimer = setTimeout(() => {
      listEl.querySelectorAll('.sp-queue-row-reason').forEach(_applyMarquee);
    }, 60);
  });
  queueRo.observe(card);

  const observer = new MutationObserver(() => {
    if (!document.contains(card)) {
      _queueCardUpdaters.delete(_render);
      socket.off('spotify:continuous_state', _onContState);
      socket.off('spotify:queue_managed',    _onQueueManaged);
      clearTimeout(_flashTimer);
      queueRo.disconnect();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  getSpotifyQueue().then(_render);

  // Sync the Auto pill with the current engine state on creation.
  socket.emit('spotify:get_intelligence');
  socket.once('spotify:intelligence_state', (d) => {
    _setAuto(!!(d && (d.activeMoodKey || d.activeVibeKey || d.activeFeeling || d.activeMix)));
  });

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
      </div>
      <div class="sp-stats-tabbar">
        <button class="sp-stats-tab active" data-tab="current">Current</button>
        <button class="sp-stats-tab" data-tab="history">History</button>
      </div>

      <!-- CURRENT -->
      <div class="sp-stats-panel" data-panel="current">
        <div class="sp-stats-grid">
          <div class="sp-stat-tile">
            <div class="sp-stat-value sp-stat-tracks">—</div>
            <div class="sp-stat-label">Tracks</div>
          </div>
          <div class="sp-stat-tile">
            <div class="sp-stat-value sp-stat-time">—</div>
            <div class="sp-stat-label">This Session</div>
          </div>
        </div>
        <div class="sp-stats-time-row">
          <div class="sp-time-tile">
            <div class="sp-time-value sp-stat-today">—</div>
            <div class="sp-time-label">Today</div>
          </div>
          <div class="sp-time-tile">
            <div class="sp-time-value sp-stat-week">—</div>
            <div class="sp-time-label">This Week</div>
          </div>
          <div class="sp-time-tile">
            <div class="sp-time-value sp-stat-total">—</div>
            <div class="sp-time-label">All Time</div>
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
          <button class="sp-save-session-btn">${SP_ICON.playlistAdd}<span>Save as Playlist</span></button>
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

      <!-- HISTORY -->
      <div class="sp-stats-panel" data-panel="history" style="display:none">
        <div class="sp-history-list"></div>
      </div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const sinceEl       = card.querySelector('.sp-stats-since');
  const tracksEl      = card.querySelector('.sp-stat-tracks');
  const timeEl        = card.querySelector('.sp-stat-time');
  const todayEl       = card.querySelector('.sp-stat-today');
  const weekEl        = card.querySelector('.sp-stat-week');
  const totalEl       = card.querySelector('.sp-stat-total');
  const artistsList   = card.querySelector('.sp-stats-artists-list');
  const recentList    = card.querySelector('.sp-stats-recent-list');
  const saveBtn       = card.querySelector('.sp-save-session-btn');
  const saveForm      = card.querySelector('.sp-save-session-form');
  const saveInput     = card.querySelector('.sp-save-session-input');
  const saveConfirm   = card.querySelector('.sp-save-session-confirm');
  const saveCancel    = card.querySelector('.sp-save-session-cancel');
  const saveFeedback  = card.querySelector('.sp-save-session-feedback');
  const statsTabBar   = card.querySelector('.sp-stats-tabbar');
  const statsPanels   = card.querySelectorAll('.sp-stats-panel');
  const historyList   = card.querySelector('.sp-history-list');

  // ── Listen-time display ─────────────────────────────────────────────────
  // The server tracks real listened time via progress_ms delta.
  // We store the last server-reported values and tick up locally while playing
  // for a smooth display between the 5s poll intervals.
  let _srvListenedMs = 0;   // server's listenedMs for current session
  let _srvTodayMs    = 0;
  let _srvWeekMs     = 0;
  let _srvTotalMs    = 0;
  let _srvUpdatedAt  = 0;   // wall-clock when we last got a server update
  let _isPlaying     = false;

  function _liveSessionMs() {
    if (!_isPlaying || !_srvUpdatedAt) return _srvListenedMs;
    return _srvListenedMs + Math.min(Date.now() - _srvUpdatedAt, 10000);
  }

  const _onStateForTimer = (state) => {
    _isPlaying = !!(state && state.isPlaying);
  };
  socket.on('spotify:state', _onStateForTimer);

  // Tick every second so the session counter moves smoothly
  const _timerInterval = setInterval(() => {
    if (_isPlaying) timeEl.textContent = fmtDuration(_liveSessionMs());
  }, 1000);

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
    sinceEl.textContent  = `since ${fmtTime(data.startTime)}`;
    tracksEl.textContent = data.tracksCount ?? 0;

    // Sync server-reported times and update display
    _srvListenedMs = data.listenedMs ?? 0;
    _srvTodayMs    = data.todayMs    ?? 0;
    _srvWeekMs     = data.weekMs     ?? 0;
    _srvTotalMs    = data.totalMs    ?? 0;
    _srvUpdatedAt  = Date.now();

    timeEl.textContent  = fmtDuration(_liveSessionMs());
    todayEl.textContent = fmtDuration(_srvTodayMs);
    weekEl.textContent  = fmtDuration(_srvWeekMs);
    totalEl.textContent = fmtDuration(_srvTotalMs);

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

  // ── Past Sessions (History tab) ─────────────────────────────────────────────
  let _historyLoaded   = false;
  const _trackCache    = new Map(); // sessionId → tracks[] (lazy, cached per expand)

  // Vibe → accent colour for the per-session badge.
  const VIBE_COLORS = {
    hype: '#ff5c5c', intense: '#e0612e', drive: '#f59e0b', good_vibes: '#fbbf24',
    grind: '#a16207', flow: '#10b981', chill: '#38bdf8', melancholy: '#6366f1', ease: '#22d3ee',
    t_morning: '#fcd34d', t_midday: '#fbbf24', t_afternoon: '#fb923c',
    t_evening: '#a78bfa', t_night: '#6366f1', t_latenight: '#4338ca',
  };
  const _vibeColor = (k) => VIBE_COLORS[k] || '#1DB954';

  function _fmtSessionDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (isToday)     return `Today ${time}`;
    if (isYesterday) return `Yesterday ${time}`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + time;
  }

  // Monday-anchored start of the week containing `ts` (local time, midnight).
  function _weekStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    const mondayOffset = (d.getDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0 …
    d.setDate(d.getDate() - mondayOffset);
    return d;
  }
  // "18 Jun - 24 Jun" range label for a week starting at `start`.
  function _fmtWeekLabel(start) {
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const opt = { day: 'numeric', month: 'short' };
    return `${start.toLocaleDateString('en-GB', opt)} – ${end.toLocaleDateString('en-GB', opt)}`;
  }

  function _sessionRowHtml(s, maxMs) {
    const sourceClass = s.source === 'away' ? 'sp-history-badge--away' : 'sp-history-badge--live';
    const sourceLabel = s.source === 'away' ? 'Away' : 'Live';
    const trackCount  = s.trackIds ? s.trackIds.length : (s.trackCount ?? 0);
    const sparkPct    = Math.round(((s.listenedMs || 0) / maxMs) * 100);
    const vibeChip    = s.vibeName
      ? `<span class="sp-history-vibe" style="--vibe:${_vibeColor(s.vibeKey)}">${_esc(s.vibeName)}</span>`
      : '';
    return `
      <div class="sp-history-row" data-id="${_esc(String(s.id))}">
        <button class="sp-history-head">
          <span class="sp-history-chevron">${SP_ICON.chevron}</span>
          <div class="sp-history-meta">
            <div class="sp-history-meta-top">
              <span class="sp-history-date">${_fmtSessionDate(s.startTime)}</span>
              <span class="sp-history-badge ${sourceClass}">${sourceLabel}</span>
              ${vibeChip}
            </div>
            <div class="sp-history-spark"><div class="sp-history-spark-fill" style="width:${sparkPct}%"></div></div>
          </div>
          <div class="sp-history-detail">
            <span class="sp-history-dur">${fmtDuration(s.listenedMs ?? 0)}</span>
            <span class="sp-history-tracks">${trackCount} track${trackCount !== 1 ? 's' : ''}</span>
          </div>
        </button>
        <div class="sp-history-body" style="display:none"></div>
      </div>`;
  }

  function _renderSessions(sessions) {
    historyList.innerHTML = '';
    if (!sessions || !sessions.length) {
      historyList.innerHTML = '<div class="sp-queue-empty">No past sessions yet</div>';
      return;
    }
    const sorted = [...sessions].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    const maxMs = Math.max(...sorted.map(s => s.listenedMs || 0), 1);

    // Group into Mon–Sun weeks; only the most recent week starts expanded.
    const groups = [];
    const byKey = new Map();
    for (const s of sorted) {
      const start = _weekStart(s.startTime || Date.now());
      const key = start.getTime();
      let g = byKey.get(key);
      if (!g) { g = { key, start, sessions: [] }; byKey.set(key, g); groups.push(g); }
      g.sessions.push(s);
    }

    groups.forEach((g, gi) => {
      const panel = document.createElement('div');
      panel.className = 'sp-history-week' + (gi === 0 ? ' expanded' : '');
      const totalMs = g.sessions.reduce((sum, s) => sum + (s.listenedMs || 0), 0);
      const rows = g.sessions.map(s => _sessionRowHtml(s, maxMs)).join('');
      panel.innerHTML = `
        <button class="sp-history-week-head">
          <span class="sp-history-chevron">${SP_ICON.chevron}</span>
          <span class="sp-history-week-label">${_fmtWeekLabel(g.start)}</span>
          <span class="sp-history-week-count">${g.sessions.length} · ${fmtDuration(totalMs)}</span>
        </button>
        <div class="sp-history-week-body">${rows}</div>
      `;
      historyList.appendChild(panel);
    });
  }

  async function _expandSession(row) {
    const id   = row.dataset.id;
    const body = row.querySelector('.sp-history-body');
    const open = row.classList.toggle('expanded');
    if (!open) { body.style.display = 'none'; return; }
    body.style.display = '';

    if (!_trackCache.has(id)) {
      body.innerHTML = '<div class="sp-queue-empty">Loading songs…</div>';
      const { tracks } = await getSessionTracks(id);
      _trackCache.set(id, tracks || []);
    }
    const tracks = _trackCache.get(id) || [];
    const list = tracks.length
      ? tracks.map(t => `
          <div class="sp-history-track">
            <span class="sp-history-track-title">${_esc(t.title || 'Unknown')}</span>
            <span class="sp-history-track-artist">${_esc(t.artist || '')}</span>
          </div>`).join('')
      : '<div class="sp-queue-empty">No songs recorded for this session</div>';
    body.innerHTML = `
      <div class="sp-history-tracklist">${list}</div>
      ${tracks.length ? `
        <div class="sp-history-actions">
          <button class="sp-history-act sp-history-queue">${SP_ICON.play}<span>Queue all</span></button>
          <button class="sp-history-act sp-history-save">${SP_ICON.playlistAdd}<span>Save as playlist</span></button>
        </div>
        <div class="sp-history-act-feedback" style="display:none"></div>` : ''}
    `;
  }

  function _historyActFeedback(row, msg, isError = false) {
    const el = row.querySelector('.sp-history-act-feedback');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sp-history-act-feedback' + (isError ? ' sp-save-error' : ' sp-save-success');
    el.style.display = '';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  historyList.addEventListener('pointerup', async (e) => {
    if (isEditMode()) return;
    const weekHead = e.target.closest('.sp-history-week-head');
    if (weekHead) { weekHead.parentElement.classList.toggle('expanded'); return; }

    const head = e.target.closest('.sp-history-head');
    if (head) { _expandSession(head.parentElement); return; }

    const row = e.target.closest('.sp-history-row');
    if (!row) return;

    const queueBtn = e.target.closest('.sp-history-queue');
    if (queueBtn) {
      queueBtn.disabled = true;
      const { count } = await queueSession(row.dataset.id);
      queueBtn.disabled = false;
      _historyActFeedback(row, count ? `✓ Queued ${count} track${count !== 1 ? 's' : ''}` : '✗ Nothing to queue', !count);
      return;
    }

    const saveBtn2 = e.target.closest('.sp-history-save');
    if (saveBtn2) {
      saveBtn2.disabled = true;
      const name = `Session · ${_fmtSessionDate(+row.dataset.id.replace(/^\D+/, '') || Date.now())}`;
      const result = await saveSessionAsPlaylist(name, row.dataset.id);
      saveBtn2.disabled = false;
      if (result && result.success) _historyActFeedback(row, `✓ Saved — ${result.trackCount} tracks`);
      else _historyActFeedback(row, `✗ ${result?.error || 'Failed'}`, true);
      return;
    }
  });

  function _loadHistory() {
    historyList.innerHTML = '<div class="sp-queue-empty">Loading…</div>';
    socket.once('spotify:sessions', ({ sessions }) => {
      _historyLoaded = true;
      _renderSessions(sessions);
    });
    socket.emit('spotify:get_sessions');
  }

  // Tab switching (Current / History)
  statsTabBar.addEventListener('pointerup', (e) => {
    if (isEditMode()) return;
    const btn = e.target.closest('.sp-stats-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    statsTabBar.querySelectorAll('.sp-stats-tab').forEach(t => t.classList.toggle('active', t === btn));
    statsPanels.forEach(p => { p.style.display = p.dataset.panel === tab ? '' : 'none'; });
    if (tab === 'history' && !_historyLoaded) _loadHistory();
  });

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
  _initCheckInNotification();
  const card = document.createElement('div');
  card.className = 'control-card spotify-insights-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-ins-wrap">
      <div class="sp-ins-tab-bar">
        <button class="sp-ins-tab active" data-tab="profile">Profile</button>
        <button class="sp-ins-tab" data-tab="artists">Artists</button>
        <button class="sp-ins-tab" data-tab="portraits">Portraits</button>
        <button class="sp-ins-tab" data-tab="mixes">Mixes</button>
        <button class="sp-ins-tab" data-tab="tuning">Tuning</button>
        <button class="sp-ins-tab" data-tab="data">Data</button>
      </div>
      <div class="sp-ins-content">

        <!-- PROFILE (now also carries the listening heatmap, compressed) -->
        <div class="sp-ins-panel" data-panel="profile">
          <div class="sp-ins-stats-row">
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-total">—</span><span class="sp-ins-stat-lbl">Plays</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-unique">—</span><span class="sp-ins-stat-lbl">Unique</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-days">—</span><span class="sp-ins-stat-lbl">Days</span></div>
            <div class="sp-ins-stat"><span class="sp-ins-stat-val sp-ins-peak">—</span><span class="sp-ins-stat-lbl">Peak hour</span></div>
          </div>
          <div class="sp-ins-profile-cols">
            <div class="sp-ins-profile-col">
              <div class="sp-ins-features-section" style="display:none">
                <div class="sp-ins-sub-title">Audio Profile <span class="sp-ins-feat-avg-bpm"></span></div>
                <div class="sp-ins-feat-bars"></div>
              </div>
              <div class="sp-ins-sub-title sp-ins-artists-title">Top Artists</div>
              <div class="sp-ins-artists-list"></div>
            </div>
            <div class="sp-ins-profile-col">
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
          </div>
          <div class="sp-ins-signals" style="display:none">
            <span class="sp-ins-signals-title">Learned signals</span>
            <span class="sp-ins-signal-chip sp-ins-signal-trans" title="Song-to-song transitions that survived vs got skipped — used to order your queue for smoother flow">
              <span class="sp-ins-signal-icon">⤳</span><span class="sp-ins-signal-val">0</span> flow links
            </span>
            <span class="sp-ins-signal-chip sp-ins-signal-feel" title="Times you told the app how a set of songs made you feel — ground truth for predicting your vibe">
              <span class="sp-ins-signal-icon">💬</span><span class="sp-ins-signal-val">0</span> feeling labels
            </span>
          </div>
        </div>

        <!-- ARTISTS — rate recently-played artists to override the over-played
             "loved" heuristic (a low rating strongly down-weights, never blocks). -->
        <div class="sp-ins-panel" data-panel="artists" style="display:none">
          <div class="sp-ins-rate-intro">Rate artists you've played recently. The smart queue over-promotes whatever you play a lot — a rating here overrides that. <b>Never</b> won't block an artist, just strongly down-weights them.</div>
          <div class="sp-ins-rate-list"></div>
          <div class="sp-ins-rate-empty" style="display:none">Keep listening — recently-played artists appear here once you have some history.</div>
        </div>

        <!-- PORTRAITS (#9 per-context taste portraits + #5 time-machine) -->
        <div class="sp-ins-panel" data-panel="portraits" style="display:none">
          <div class="sp-ins-tm" style="display:none">
            <span class="sp-ins-tm-emoji">🕰️</span>
            <div class="sp-ins-tm-info">
              <span class="sp-ins-tm-headline">—</span>
              <span class="sp-ins-tm-sub"></span>
            </div>
            <button class="sp-ins-tm-play" title="Play this time-of-day vibe">▶</button>
          </div>
          <!-- DAY RECAP (#7 your day in music) -->
          <div class="sp-ins-recap" style="display:none">
            <div class="sp-ins-recap-head">
              <span class="sp-ins-recap-emoji">📻</span>
              <span class="sp-ins-recap-title">Your day in music</span>
            </div>
            <div class="sp-ins-recap-body"></div>
          </div>
          <div class="sp-ins-portraits-title sp-ins-sub-title">Your sound, by time of day</div>
          <div class="sp-ins-portraits-grid"></div>
          <div class="sp-ins-portraits-empty" style="display:none">Keep listening — portraits appear once each part of your day has a few plays.</div>
        </div>

        <!-- MIXES — pick a genre (Hip-Hop, Rock, … or "Any") then drag the mood pad
             to an exact energy×mood point. The heat-cloud is your own listening,
             filtered to the chosen genre. Genre × mood, one builder. -->
        <div class="sp-ins-panel" data-panel="mixes" style="display:none">
          <div class="sp-ins-mixmap-intro">Pick a genre, then drag to the mood you want within it. The glow is where your music in that genre sits.</div>
          <div class="sp-ins-genre-chips"></div>
          <div class="sp-ins-genre-empty" style="display:none">
            <div class="sp-ins-empty-icon">🎚️</div>
            <div class="sp-ins-empty-msg">Building your genre profile…</div>
            <div class="sp-ins-empty-sub sp-ins-genre-progress"></div>
          </div>
          <div class="sp-ins-mixmap-wrap">
            <span class="sp-ins-mixmap-axis sp-ins-mixmap-axis-top">Intense</span>
            <span class="sp-ins-mixmap-axis sp-ins-mixmap-axis-bottom">Calm</span>
            <span class="sp-ins-mixmap-axis sp-ins-mixmap-axis-left">Dark</span>
            <span class="sp-ins-mixmap-axis sp-ins-mixmap-axis-right">Bright</span>
            <div class="sp-ins-mixmap-pad" tabindex="0" role="slider" aria-label="Genre mood map">
              <canvas class="sp-ins-mixmap-heat" width="220" height="220"></canvas>
              <div class="sp-ins-mixmap-anchors"></div>
              <div class="sp-ins-mixmap-puck" style="display:none"></div>
            </div>
          </div>
          <div class="sp-ins-mixmap-readout">
            <span class="sp-ins-mixmap-label">Pick a genre &amp; spot</span>
            <button class="sp-ins-mixmap-play" disabled>Play this</button>
          </div>
          <div class="sp-ins-mixmap-empty" style="display:none">
            <div class="sp-ins-empty-icon">✨</div>
            <div class="sp-ins-empty-msg">Keep listening to map your sound</div>
            <div class="sp-ins-empty-sub sp-ins-vibe-progress"></div>
          </div>
          <div class="sp-ins-mood-footer" style="display:none">
            <span class="sp-ins-mood-active-label"></span>
            <button class="sp-ins-stop-btn sp-ins-mood-stop-btn">Stop</button>
          </div>
        </div>

        <!-- TUNING -->
        <div class="sp-ins-panel" data-panel="tuning" style="display:none">
          <div class="sp-ins-tune-intro">Shape how every Spotify feature picks music — autoplay, smart shuffle, vibes, moods, routines &amp; check-ins.</div>
          <div class="sp-ins-tune-form">
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Fresh vs Familiar</span><span class="sp-ins-tune-val" data-for="freshness">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="freshness" min="0" max="100" value="45">
              <div class="sp-ins-tune-ends"><span>From my library</span><span>New discoveries</span></div>
            </div>
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Variety</span><span class="sp-ins-tune-val" data-for="variety">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="variety" min="0" max="100" value="50">
              <div class="sp-ins-tune-ends"><span>Stay on taste</span><span>Adventurous</span></div>
            </div>
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Fade smoothness</span><span class="sp-ins-tune-val" data-for="fadeSmooth">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="fadeSmooth" min="0" max="100" value="50">
              <div class="sp-ins-tune-ends"><span>Anything goes</span><span>Songs must blend</span></div>
            </div>
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Mood lock vs Flow</span><span class="sp-ins-tune-val" data-for="moodFlow">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="moodFlow" min="0" max="100" value="50">
              <div class="sp-ins-tune-ends"><span>Lock to mood</span><span>Go with the flow</span></div>
            </div>
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Skip sensitivity</span><span class="sp-ins-tune-val" data-for="skipSensitivity">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="skipSensitivity" min="0" max="100" value="50">
              <div class="sp-ins-tune-ends"><span>Forgiving</span><span>React fast</span></div>
            </div>
            <div class="sp-ins-tune-row">
              <div class="sp-ins-tune-head"><span class="sp-ins-tune-label">Queue lookahead</span><span class="sp-ins-tune-val" data-for="lookahead">—</span></div>
              <input type="range" class="sp-ins-tune-range" data-key="lookahead" min="1" max="10" value="5">
              <div class="sp-ins-tune-ends"><span>Adapt fast</span><span>Stage ahead</span></div>
            </div>
          </div>
          <div class="sp-ins-tz">
            <div class="sp-ins-tz-head">
              <span class="sp-ins-tune-label">Timezone override</span>
              <span class="sp-ins-tz-saved">Saved ✓</span>
            </div>
            <div class="sp-ins-tz-sub">Corrects hour-of-day &amp; weekday for vibes, slots &amp; the heatmap when the host clock is off. Applies to past data too.</div>
            <div class="sp-ins-tz-row">
              <select class="sp-ins-tz-select"></select>
              <button class="sp-ins-action-btn sp-ins-tz-apply">Apply</button>
            </div>
            <div class="sp-ins-tz-status"></div>
          </div>
          <div class="sp-ins-tune-footer">
            <span class="sp-ins-tune-saved">Saved ✓</span>
            <button class="sp-ins-action-btn sp-ins-tune-reset">Reset to defaults</button>
          </div>
        </div>

        <!-- DATA — read-only diagnostics: what the app knows about you. -->
        <div class="sp-ins-panel" data-panel="data" style="display:none">
          <div class="sp-ins-tune-intro">What the smart queue knows about you, and how it shapes your queue. Read-only.</div>
          <div class="sp-ins-data"></div>
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
    if (btn.dataset.tab === 'portraits') socket.emit('spotify:get_portraits');
    if (btn.dataset.tab === 'artists')   socket.emit('spotify:get_artist_ratings');
    if (btn.dataset.tab === 'mixes') {
      getGenreProfile();
      getMixMap(_selectedGenre === 'any' ? null : _selectedGenre);
    }
    if (btn.dataset.tab === 'data') socket.emit('spotify:get_data');
  });

  // ---- Portraits tab (#9) + time-machine (#5) ----
  const tmEl       = card.querySelector('.sp-ins-tm');
  const tmHeadline = card.querySelector('.sp-ins-tm-headline');
  const tmSub      = card.querySelector('.sp-ins-tm-sub');
  const tmEmoji    = card.querySelector('.sp-ins-tm-emoji');
  const tmPlay     = card.querySelector('.sp-ins-tm-play');
  const portraitsGrid  = card.querySelector('.sp-ins-portraits-grid');
  const portraitsEmpty = card.querySelector('.sp-ins-portraits-empty');
  const recapEl        = card.querySelector('.sp-ins-recap');
  const recapBody      = card.querySelector('.sp-ins-recap-body');

  tmPlay.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    socket.emit('spotify:time_machine_play');
  });

  function _renderPortraits(data) {
    // The current slot's "It's Sunday 11pm…" card now lives on the Now Playing
    // panel (the prediction sub-line), so it's no longer shown here to avoid
    // duplicating the same thing in two places.
    if (tmEl) tmEl.style.display = 'none';

    // #7 — Your day in music recap.
    const recap = data && data.dayRecap;
    if (recap && recapEl && recapBody) {
      const bits = [];
      bits.push(`<span class="sp-ins-recap-stat"><b>${recap.trackCount}</b> tracks</span>`);
      if (recap.arc) bits.push(`<span class="sp-ins-recap-stat">${_esc(recap.arc)}</span>`);
      if (recap.startMood && recap.endMood) {
        bits.push(recap.startMood === recap.endMood
          ? `<span class="sp-ins-recap-stat">stayed ${_esc(recap.startMood.toLowerCase())}</span>`
          : `<span class="sp-ins-recap-stat">${_esc(recap.startMood.toLowerCase())} → ${_esc(recap.endMood.toLowerCase())}</span>`);
      }
      if (recap.topArtist) bits.push(`<span class="sp-ins-recap-stat">most: ${_esc(recap.topArtist.name)}</span>`);
      if (recap.discovery && recap.discovery.title) {
        bits.push(`<span class="sp-ins-recap-stat sp-ins-recap-find">🔎 ${_esc(recap.discovery.title)}${recap.discovery.artist ? ` · ${_esc(recap.discovery.artist)}` : ''}</span>`);
      }
      recapBody.innerHTML = bits.join('');
      recapEl.style.display = '';
    } else if (recapEl) {
      recapEl.style.display = 'none';
    }

    const list = (data && data.portraits) ? data.portraits : [];
    portraitsGrid.innerHTML = '';
    portraitsEmpty.style.display = list.length ? 'none' : '';
    list.forEach((p) => {
      const cell = document.createElement('div');
      cell.className = 'sp-ins-portrait';
      const artists = (p.topArtists || []).slice(0, 2).join(', ');
      cell.innerHTML = `
        <div class="sp-ins-portrait-head">
          <span class="sp-ins-portrait-emoji">${p.emoji || '🎧'}</span>
          <span class="sp-ins-portrait-title">${_esc(p.title)}</span>
        </div>
        <div class="sp-ins-portrait-feel">${_esc(p.feeling)}${p.bpm ? ` · ${p.bpm} bpm` : ''}</div>
        <div class="sp-ins-portrait-bars">
          <span class="sp-ins-portrait-bar" title="Energy"><i style="width:${Math.max(0, Math.min(100, p.energy))}%"></i></span>
          <span class="sp-ins-portrait-bar sp-ins-portrait-bar--v" title="Positivity"><i style="width:${Math.max(0, Math.min(100, p.valence))}%"></i></span>
        </div>
        ${artists ? `<div class="sp-ins-portrait-artists">${_esc(artists)}</div>` : ''}
        ${p.drift ? `<div class="sp-ins-portrait-drift">↗ ${_esc(p.drift)}</div>` : ''}
        <div class="sp-ins-portrait-count">${p.count} plays</div>
      `;
      portraitsGrid.appendChild(cell);
    });
  }
  const _onPortraits = (data) => _renderPortraits(data);
  socket.on('spotify:portraits', _onPortraits);

  // ---- Artists tab (rate recently-played artists) ----
  const rateList  = card.querySelector('.sp-ins-rate-list');
  const rateEmpty = card.querySelector('.sp-ins-rate-empty');
  // value → { label, emoji }. Order shown low→high in the control.
  const RATE_LEVELS = [
    { v: -2, label: 'Never',   emoji: '🚫' },
    { v: -1, label: 'Dislike', emoji: '👎' },
    { v:  0, label: 'Neutral', emoji: '😐' },
    { v:  1, label: 'Like',    emoji: '👍' },
    { v:  2, label: 'Love',    emoji: '❤️' },
  ];
  function _rateAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  }
  function _renderArtistRatings(data) {
    const items = (data && data.items) ? data.items : [];
    rateList.innerHTML = '';
    rateEmpty.style.display = items.length ? 'none' : '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'sp-ins-rate-row';
      row.dataset.artist = it.artist;
      const meta = [];
      if (it.count) meta.push(`${it.count} play${it.count === 1 ? '' : 's'}`);
      if (it.lastTs) meta.push(_rateAgo(it.lastTs));
      const buttons = RATE_LEVELS.map(l =>
        `<button class="sp-ins-rate-btn${it.rating === l.v ? ' active' : ''}" data-val="${l.v}" title="${l.label}" aria-label="${l.label}">${l.emoji}</button>`
      ).join('');
      row.innerHTML = `
        <div class="sp-ins-rate-art">${it.art ? `<img src="${_esc(it.art)}" alt="">` : '<span class="sp-ins-rate-art-ph">♪</span>'}</div>
        <div class="sp-ins-rate-info">
          <span class="sp-ins-rate-name">${_esc(it.artist)}${it.loved ? ' <span class="sp-ins-rate-loved" title="Currently treated as a loved artist">★</span>' : ''}</span>
          <span class="sp-ins-rate-meta">${_esc(meta.join(' · '))}</span>
        </div>
        <div class="sp-ins-rate-ctrl">${buttons}</div>
      `;
      rateList.appendChild(row);
    });
  }
  rateList.addEventListener('click', (e) => {
    if (isEditMode()) return;
    const btn = e.target.closest('.sp-ins-rate-btn');
    if (!btn) return;
    const row = btn.closest('.sp-ins-rate-row');
    if (!row) return;
    const artist = row.dataset.artist;
    const val = Number(btn.dataset.val);
    // Re-clicking the active rating clears it (back to the learned heuristic).
    const rating = btn.classList.contains('active') ? null : val;
    socket.emit('spotify:set_artist_rating', { artist, rating });
  });
  const _onArtistRatings = (data) => _renderArtistRatings(data);
  socket.on('spotify:artist_ratings', _onArtistRatings);

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
    // Renamed clusters surface as Mixes quick-pick chips + pad anchors.
    card.querySelectorAll(`.sp-ins-mixmap-chip[data-key="${key}"] .sp-ins-mixmap-chip-name`).forEach(el => {
      el.textContent = name;
    });
    card.querySelectorAll(`.sp-ins-mixmap-anchor[data-key="${key}"] .sp-ins-mixmap-anchor-name`).forEach(el => {
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
    // daysLogging is only meaningful once we have our own logged data
    card.querySelector('.sp-ins-days').textContent   = p.daysLogging || '—';
    card.querySelector('.sp-ins-peak').textContent   = HOUR_LABELS[p.peakHour] || '—';

    // Show data source note if we're combining Spotify's data with our own
    const seededCount = p.total - (p.ownTotal || 0);
    let sourceNote = card.querySelector('.sp-ins-source-note');
    if (!sourceNote) {
      sourceNote = document.createElement('div');
      sourceNote.className = 'sp-ins-source-note';
      card.querySelector('.sp-ins-stats-row').after(sourceNote);
    }
    if (seededCount > 0) {
      sourceNote.textContent = `Includes ${seededCount} tracks from your Spotify history`;
      sourceNote.style.display = '';
    } else {
      sourceNote.style.display = 'none';
    }

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

    // Learned signals strip (transition flow + feeling labels)
    const sig = p.signals;
    const sigEl = card.querySelector('.sp-ins-signals');
    if (sigEl) {
      const links  = sig ? (sig.flowLinks || 0)     : 0;
      const labels = sig ? (sig.feelingLabels || 0)  : 0;
      if (links > 0 || labels > 0) {
        sigEl.querySelector('.sp-ins-signal-trans .sp-ins-signal-val').textContent = links;
        sigEl.querySelector('.sp-ins-signal-feel  .sp-ins-signal-val').textContent = labels;
        sigEl.querySelector('.sp-ins-signal-trans').style.display = links  > 0 ? '' : 'none';
        sigEl.querySelector('.sp-ins-signal-feel').style.display  = labels > 0 ? '' : 'none';
        sigEl.style.display = '';
      } else {
        sigEl.style.display = 'none';
      }
    }
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

  // ---- Reusable 2D mood pad ----
  // Encapsulates one energy×valence pad (heat-cloud, anchors, puck, drag + keyboard,
  // readout + Play) so both the Mixes and Genres tabs can have their own. `root`
  // scopes all queries to one panel. opts.onPlay(target) fires on Play/Enter/chip;
  // opts.clusterChips renders the renameable vibe-cluster quick-picks (Mixes only);
  // opts.context toggles the "right now feels like" hint line (Mixes only).
  function _createMoodPad(root, opts = {}) {
    const pad      = root.querySelector('.sp-ins-mixmap-pad');
    const heat     = root.querySelector('.sp-ins-mixmap-heat');
    const anchorsEl= root.querySelector('.sp-ins-mixmap-anchors');
    const puck     = root.querySelector('.sp-ins-mixmap-puck');
    const labelEl  = root.querySelector('.sp-ins-mixmap-label');
    const playBtn  = root.querySelector('.sp-ins-mixmap-play');
    const chips    = root.querySelector('.sp-ins-mixmap-chips');
    const chipsTitle = root.querySelector('.sp-ins-mixmap-chips-title');
    const emptyEl  = root.querySelector('.sp-ins-mixmap-empty');
    const introEl  = root.querySelector('.sp-ins-mixmap-intro');

    let selected = null;
    let userPicked = false; // once the user grabs the puck, stop auto-defaulting it

    const energyWord  = (e) => (e < 33 ? 'Calm' : e < 66 ? 'Steady' : 'Intense');
    const valenceWord = (v) => (v < 33 ? 'dark'  : v < 66 ? 'moody'  : 'bright');
    const spotName = (e, v) => `${energyWord(e)} & ${valenceWord(v)}`;
    // energy/valence (0-100) → pad position. Y is inverted: top = high energy.
    const place = (el, e, v) => { el.style.left = `${v}%`; el.style.top = `${100 - e}%`; };

    function select(energy, valence, label, vibeKey, isUser = true) {
      energy  = Math.max(0, Math.min(100, Math.round(energy)));
      valence = Math.max(0, Math.min(100, Math.round(valence)));
      selected = { energy, valence, label: label || spotName(energy, valence), vibeKey };
      puck.style.display = '';
      place(puck, energy, valence);
      labelEl.textContent = selected.label;
      playBtn.disabled = false;
      if (isUser) userPicked = true;
    }

    function playSelected() { if (selected && opts.onPlay) opts.onPlay({ ...selected }); }

    function pointToVal(ev) {
      const r = pad.getBoundingClientRect();
      const fx = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const fy = Math.max(0, Math.min(1, (ev.clientY - r.top)  / r.height));
      return { valence: fx * 100, energy: (1 - fy) * 100 };
    }

    let dragging = false;
    pad.addEventListener('pointerdown', (ev) => {
      if (isEditMode()) return;
      if (ev.target.closest('.sp-ins-mixmap-anchor')) return; // let anchor taps through
      dragging = true;
      pad.setPointerCapture?.(ev.pointerId);
      const { energy, valence } = pointToVal(ev);
      select(energy, valence);
    });
    pad.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const { energy, valence } = pointToVal(ev);
      select(energy, valence);
    });
    const endDrag = (ev) => { if (!dragging) return; dragging = false; pad.releasePointerCapture?.(ev.pointerId); };
    pad.addEventListener('pointerup', endDrag);
    pad.addEventListener('pointercancel', endDrag);
    // Keyboard nudge for accessibility.
    pad.addEventListener('keydown', (ev) => {
      if (!selected) select(50, 50);
      let { energy, valence } = selected;
      const step = ev.shiftKey ? 10 : 4;
      if (ev.key === 'ArrowUp')    energy  += step;
      else if (ev.key === 'ArrowDown')  energy  -= step;
      else if (ev.key === 'ArrowLeft')  valence -= step;
      else if (ev.key === 'ArrowRight') valence += step;
      else if (ev.key === 'Enter') { playSelected(); return; }
      else return;
      ev.preventDefault();
      select(energy, valence);
    });
    playBtn.addEventListener('pointerup', () => { if (!isEditMode()) playSelected(); });

    function render(mixMap, context, activeMix) {
      mixMap = mixMap || { ready: false };

      // Context hint line (Mixes only).
      if (opts.context) {
        const ctxEl = root.querySelector('.sp-ins-mood-context');
        if (ctxEl) {
          if (context?.suggestedMoodName) {
            ctxEl.innerHTML = `<span class="sp-ins-ctx-icon">${context.suggestedMoodEmoji || '💡'}</span> <span class="sp-ins-ctx-text">Right now feels like <strong>${_esc(context.suggestedMoodName)}</strong></span>`;
            ctxEl.style.display = '';
          } else {
            ctxEl.style.display = 'none';
          }
        }
      }

      if (!mixMap.ready) {
        emptyEl.style.display = '';
        if (introEl) introEl.style.display = 'none';
        const total = mixMap.total || 0;
        const prog = emptyEl.querySelector('.sp-ins-vibe-progress');
        if (prog) prog.textContent = `${total} / 10 tracks analysed`;
        heat.getContext('2d')?.clearRect(0, 0, heat.width, heat.height);
        anchorsEl.innerHTML = '';
        if (chips) chips.innerHTML = '';
        if (chipsTitle) chipsTitle.style.display = 'none';
        return;
      }
      emptyEl.style.display = 'none';
      if (introEl) introEl.style.display = '';

      // Heat-cloud — paint each bin as a soft radial blob so it reads as a cloud
      // rather than a blocky grid. Y is inverted (row 0 = lowest energy = bottom).
      const ctx = heat.getContext('2d');
      if (ctx) {
        const W = heat.width, H = heat.height;
        ctx.clearRect(0, 0, W, H);
        const bins = mixMap.bins || 10;
        const max  = mixMap.max || 1;
        const cw = W / bins, ch = H / bins;
        for (let yi = 0; yi < bins; yi++) {
          for (let xi = 0; xi < bins; xi++) {
            const v = (mixMap.grid[yi] && mixMap.grid[yi][xi]) || 0;
            if (!v) continue;
            const a = 0.08 + (v / max) * 0.62;
            const cx = (xi + 0.5) * cw;
            const cy = H - (yi + 0.5) * ch; // invert Y
            const rad = Math.max(cw, ch) * 0.9;
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(0, `rgba(29,185,84,${a.toFixed(3)})`);
            g.addColorStop(1, 'rgba(29,185,84,0)');
            ctx.fillStyle = g;
            ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
          }
        }
      }

      // Named anchors (discovered clusters) as dots on the pad.
      const anchors = mixMap.anchors || [];
      anchorsEl.innerHTML = '';
      anchors.forEach(a => {
        const dot = document.createElement('div');
        dot.className = 'sp-ins-mixmap-anchor';
        dot.dataset.key = a.key;
        place(dot, a.energy, a.valence);
        dot.innerHTML = `<span class="sp-ins-mixmap-anchor-dot"></span><span class="sp-ins-mixmap-anchor-name">${_esc(a.name)}</span>`;
        // Tapping a preset on the map only *snaps* the puck to it (and labels it) —
        // it never auto-plays, so a stray tap while sliding can't kick off a mix.
        dot.addEventListener('pointerup', (ev) => {
          ev.stopPropagation();
          if (isEditMode()) return;
          select(a.energy, a.valence, a.name, a.key);
        });
        anchorsEl.appendChild(dot);
      });

      // Default the selector onto where you already are — the active mix if one is
      // playing, otherwise the current song's vibe — unless the user has grabbed the
      // puck themselves. The selector IS the marker (no separate static dot).
      if (!userPicked) {
        let def = null;
        if (activeMix && activeMix.energy != null) {
          def = { energy: activeMix.energy, valence: activeMix.valence, label: activeMix.label, vibeKey: activeMix.vibeKey };
        } else if (mixMap.currentPoint && mixMap.currentPoint.energy != null) {
          def = mixMap.currentPoint;
        }
        if (def) select(def.energy, def.valence, def.label, def.vibeKey, false);
      }

      // Quick-pick chips = the same named clusters, renameable (Mixes only).
      if (opts.clusterChips && chips) {
        chips.innerHTML = '';
        if (chipsTitle) chipsTitle.style.display = anchors.length ? '' : 'none';
        anchors.forEach(a => {
          const chip = document.createElement('div');
          chip.className = 'sp-ins-mixmap-chip';
          chip.dataset.key = a.key;
          chip.innerHTML = `
            <button class="sp-ins-mixmap-chip-play" title="Play this mix">
              <span class="sp-ins-mixmap-chip-name">${_esc(a.name)}</span>
            </button>
            <button class="sp-ins-mixmap-chip-rename" title="Rename">✎</button>`;
          chip.querySelector('.sp-ins-mixmap-chip-play').addEventListener('pointerup', (ev) => {
            ev.stopPropagation();
            if (isEditMode()) return;
            select(a.energy, a.valence, a.name, a.key);
            playSelected();
          });
          chip.querySelector('.sp-ins-mixmap-chip-rename').addEventListener('pointerup', (ev) => {
            ev.stopPropagation();
            if (isEditMode()) return;
            const nameEl = chip.querySelector('.sp-ins-mixmap-chip-name');
            const current = nameEl.textContent;
            const input = document.createElement('input');
            input.className = 'sp-ins-mixmap-chip-input';
            input.value = current;
            nameEl.replaceWith(input);
            input.focus(); input.select();
            const commit = () => {
              const val = input.value.trim() || current;
              const span = document.createElement('span');
              span.className = 'sp-ins-mixmap-chip-name';
              span.textContent = val;
              input.replaceWith(span);
              if (val !== current) renameVibe(a.key, val);
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { input.value = current; commit(); }
            });
          });
          chips.appendChild(chip);
        });
      }
    }

    return { render, resetPick() { userPicked = false; } };
  }

  // ---- Mixes tab — genre × mood ----
  // (Internally still the "genre+mood" pad — it replaced the old genre-less Mixes tab.)
  // Genre chips choose the macro-bucket ("Any" = no genre filter, the old Mixes
  // behaviour); the pad picks the mood within it; the heat-cloud is filtered to the
  // selected genre. Play targets { …, genre }.
  const _genresPanel  = card.querySelector('.sp-ins-panel[data-panel="mixes"]');
  const _genreChipsEl = card.querySelector('.sp-ins-genre-chips');
  const _genreEmptyEl = card.querySelector('.sp-ins-genre-empty');
  let _selectedGenre = 'any';
  let _genreBuckets  = [];   // [{ key, name, count }]
  const _genreNameOf = (key) => key === 'any' ? null : (_genreBuckets.find(b => b.key === key)?.name || null);

  const _genresPad = _createMoodPad(_genresPanel, {
    context: false,
    clusterChips: false,
    onPlay: (t) => {
      const gname = _genreNameOf(_selectedGenre);
      const lbl = gname ? `${t.label} · ${gname}` : t.label;
      playMix({ ...t, genre: _selectedGenre === 'any' ? null : _selectedGenre });
      _showFeedback(`Building "${lbl}"…`);
      _spToast(`⏳ Loading "${lbl}" — building your queue…`);
    },
  });

  function _renderGenreChips(profile) {
    _genreBuckets = (profile && profile.buckets) || [];
    const ready = !!(profile && profile.ready);
    _genreEmptyEl.style.display = ready ? 'none' : '';
    if (!ready) {
      const prog = _genreEmptyEl.querySelector('.sp-ins-genre-progress');
      if (prog) prog.textContent = (profile && profile.pending)
        ? `Identifying genres for ${profile.pending} more artists…`
        : 'Keep listening to build your genre profile';
    }
    // If the previously-selected genre vanished (e.g. profile reset), fall back to Any.
    if (_selectedGenre !== 'any' && !_genreBuckets.some(b => b.key === _selectedGenre)) _selectedGenre = 'any';

    _genreChipsEl.innerHTML = '';
    const mk = (key, name) => {
      const chip = document.createElement('button');
      chip.className = 'sp-ins-genre-chip' + (key === _selectedGenre ? ' sp-ins-genre-chip--active' : '');
      chip.dataset.key = key;
      chip.textContent = name;
      chip.addEventListener('pointerup', () => { if (!isEditMode()) _selectGenre(key); });
      _genreChipsEl.appendChild(chip);
    };
    mk('any', 'Any');
    _genreBuckets.forEach(b => mk(b.key, b.name));
  }

  function _selectGenre(key) {
    _selectedGenre = key;
    _genreChipsEl.querySelectorAll('.sp-ins-genre-chip').forEach(c =>
      c.classList.toggle('sp-ins-genre-chip--active', c.dataset.key === key));
    _genresPad.resetPick();                  // re-default the puck within the new cloud
    getMixMap(key === 'any' ? null : key);   // refresh the genre-filtered heat
  }

  // ---- Tuning tab ----
  // Global sliders that shape every Spotify feature. Each change is debounced and
  // pushed to the server, which persists it and applies it to autoplay, smart
  // shuffle, vibes, moods, routines and check-ins.
  const tuneRanges = Array.from(card.querySelectorAll('.sp-ins-tune-range'));
  const tuneSaved  = card.querySelector('.sp-ins-tune-saved');
  const tuneReset  = card.querySelector('.sp-ins-tune-reset');
  let _tuneDefaults = { freshness: 45, variety: 50, fadeSmooth: 50, moodFlow: 50, skipSensitivity: 50, lookahead: 5 };
  let _tuneDebounce = null;
  let _tuneSavedTimer = null;

  function _fmtTune(key, val) {
    return key === 'lookahead' ? `${val} track${val == 1 ? '' : 's'}` : `${val}%`;
  }
  function _updateTuneLabels() {
    tuneRanges.forEach(r => {
      const out = card.querySelector(`.sp-ins-tune-val[data-for="${r.dataset.key}"]`);
      if (out) out.textContent = _fmtTune(r.dataset.key, +r.value);
    });
  }
  function _collectTuning() {
    const t = {};
    tuneRanges.forEach(r => { t[r.dataset.key] = +r.value; });
    return t;
  }
  function _flashTuneSaved() {
    if (!tuneSaved) return;
    tuneSaved.classList.add('show');
    clearTimeout(_tuneSavedTimer);
    _tuneSavedTimer = setTimeout(() => tuneSaved.classList.remove('show'), 1200);
  }
  function _pushTuning() {
    clearTimeout(_tuneDebounce);
    _tuneDebounce = setTimeout(() => { setTuning(_collectTuning()); _flashTuneSaved(); }, 250);
  }
  function _applyTuningState(tuning, defaults) {
    if (defaults) _tuneDefaults = { ..._tuneDefaults, ...defaults };
    if (tuning) {
      tuneRanges.forEach(r => { if (tuning[r.dataset.key] != null) r.value = tuning[r.dataset.key]; });
    }
    _updateTuneLabels();
  }
  tuneRanges.forEach(r => {
    r.addEventListener('input', () => { _updateTuneLabels(); _pushTuning(); });
  });
  tuneReset?.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    tuneRanges.forEach(r => { if (_tuneDefaults[r.dataset.key] != null) r.value = _tuneDefaults[r.dataset.key]; });
    _updateTuneLabels();
    setTuning(_collectTuning());
    _flashTuneSaved();
  });
  const _onTuning = ({ tuning, defaults } = {}) => _applyTuningState(tuning, defaults);
  socket.on('spotify:tuning', _onTuning);
  getTuning();
  _updateTuneLabels();

  // ---- Timezone override ----
  const tzSelect = card.querySelector('.sp-ins-tz-select');
  const tzApply  = card.querySelector('.sp-ins-tz-apply');
  const tzStatus = card.querySelector('.sp-ins-tz-status');
  const tzSaved  = card.querySelector('.sp-ins-tz-saved');
  // A compact, curated zone list plus whatever the host reports, so the common
  // cases are one click away without shipping the full IANA database.
  const TZ_COMMON = [
    'UTC',
    'Europe/London', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Paris',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Athens', 'Europe/Moscow',
    'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  ];
  function _fillTzOptions(active, host) {
    if (!tzSelect) return;
    const zones = new Set(TZ_COMMON);
    if (host) zones.add(host);
    if (active) zones.add(active);
    const cur = active || host || 'UTC';
    tzSelect.innerHTML = [...zones].sort().map(z =>
      `<option value="${_esc(z)}"${z === cur ? ' selected' : ''}>${_esc(z)}${z === host ? ' (host)' : ''}</option>`
    ).join('');
  }
  const _onTimezone = ({ timeZone, hostZone, migrated } = {}) => {
    _fillTzOptions(timeZone, hostZone);
    if (tzStatus) {
      if (migrated) {
        const h = migrated.history || {}, f = migrated.feelings || {};
        tzStatus.textContent = `Now ${timeZone || hostZone || 'UTC'} · fixed ${(h.migrated||0)+(f.migrated||0)} of ${(h.total||0)+(f.total||0)} past entries`;
        if (tzSaved) { tzSaved.classList.add('show'); setTimeout(() => tzSaved.classList.remove('show'), 2000); }
        getSpotifyInsights(); // refresh heatmap / portraits with corrected data
      } else {
        tzStatus.textContent = timeZone
          ? `Active: ${timeZone}`
          : `Using host clock${hostZone ? ` (${hostZone})` : ''} — no override set`;
      }
    }
  };
  socket.on('spotify:timezone', _onTimezone);
  tzApply?.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    const tz = tzSelect && tzSelect.value;
    if (tz) { if (tzStatus) tzStatus.textContent = 'Applying & repairing past data…'; setTimezone(tz, true); }
  });
  getTimezone();

  // ---- Shared continuous-play footer (Mixes tab) ----
  // The Mixes pad, plus legacy mood/vibe/feeling sources, all surface here as a
  // single "keeps going" line. activeMix carries the freeform pad label.
  // Both the Mixes and Genres panels carry a "keeps going" footer — update all.
  function _updateContinuousState({ activeMoodKey, activeVibeKey, activeMix } = {}) {
    const label = (activeMix && activeMix.label) || activeMoodKey || activeVibeKey;
    card.querySelectorAll('.sp-ins-mood-footer').forEach(footer => {
      const lbl = footer.querySelector('.sp-ins-mood-active-label');
      if (label) {
        if (lbl) lbl.textContent = `● ${label} · keeps going`;
        footer.style.display = '';
      } else {
        footer.style.display = 'none';
      }
    });
  }

  // Stop continuous (any panel's footer Stop button)
  card.querySelectorAll('.sp-ins-mood-stop-btn').forEach(btn => btn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    stopContinuous();
  }));

  // Continuous state updates from server
  const _onContinuousState = (data) => _updateContinuousState(data);
  socket.on('spotify:continuous_state', _onContinuousState);

  // Live mix-map refresh → the (only) Mixes pad.
  const _onMixMap = (data) => {
    if (!data) return;
    _genresPad.render(data, null, data.activeMix);
    _updateContinuousState({ activeMix: data.activeMix });
  };
  socket.on('spotify:mix_map', _onMixMap);

  // Genre profile → Mixes tab genre chips.
  const _onGenreProfile = (data) => _renderGenreChips(data);
  socket.on('spotify:genre_profile', _onGenreProfile);

  // ---- Data tab (read-only diagnostics) ----
  const _dataEl = card.querySelector('.sp-ins-data');
  const _RATE_LABEL = { '2': '❤️ Love', '1': '👍 Like', '-1': '👎 Dislike', '-2': '🚫 Never' };
  const _TUNE_INFO = {
    freshness:       ['Fresh vs Familiar', '% of each batch that is new discovery vs your library'],
    variety:         ['Variety', 'how far it wanders from your core taste'],
    fadeSmooth:      ['Fade smoothness', 'how closely consecutive tracks must blend (also drives genre-aware transitions)'],
    moodFlow:        ['Mood lock vs Flow', '0 = lock to the chosen mood, 100 = roam'],
    skipSensitivity: ['Skip sensitivity', 'how hard an early skip steers away from an artist'],
    lookahead:       ['Lookahead', 'tracks staged per refill'],
  };
  function _stat(num, lbl) {
    return `<div class="sp-data-stat"><span class="sp-data-num">${num}</span><span class="sp-data-lbl">${lbl}</span></div>`;
  }
  function _section(title, inner) {
    return `<div class="sp-data-section"><div class="sp-data-head">${title}</div>${inner}</div>`;
  }
  function _renderData(d) {
    if (!d || d.error) { _dataEl.innerHTML = `<div class="sp-ins-empty-msg">${d?.error ? _esc(d.error) : 'No data yet.'}</div>`; return; }
    const lib = d.library || {}, taste = d.taste || {}, g = d.genres || {}, t = d.tuning || {}, sq = d.smartQueue || {};
    let html = '';

    // Library
    html += _section('Library the engine draws from', `<div class="sp-data-grid">
      ${_stat(lib.total ?? 0, 'tracks known')}
      ${_stat(lib.withFeatures ?? 0, 'with audio features')}
      ${_stat(lib.own ?? 0, 'your logged plays')}
      ${_stat(lib.librarySeeds ?? 0, 'saved-library tracks')}
      ${_stat(lib.sessions ?? 0, 'past sessions')}
      ${_stat(lib.featuresCached ?? 0, 'features cached')}
    </div>`);

    // Taste
    const rc = taste.ratingCounts || {};
    let tasteInner = `<div class="sp-data-grid">
      ${_stat(taste.artistsLearned ?? 0, 'artists learned')}
      ${_stat(taste.lovedArtists ?? 0, 'loved artists')}
      ${_stat(taste.rated ?? 0, 'rated by you')}
      ${_stat(taste.dislikedTracks ?? 0, 'disliked tracks')}
      ${_stat(taste.transitions ?? 0, 'transitions learned')}
      ${_stat(taste.topTracks ?? 0, 'on-repeat tracks')}
    </div>`;
    if (rc.love || rc.like || rc.dislike || rc.never) {
      tasteInner += `<div class="sp-data-ratings">${[['❤️', rc.love], ['👍', rc.like], ['👎', rc.dislike], ['🚫', rc.never]]
        .filter(([, n]) => n).map(([e, n]) => `<span>${e} ${n}</span>`).join('')}</div>`;
    }
    if ((taste.topArtists || []).length) {
      tasteInner += `<div class="sp-data-sub">Top artists (by learned taste, then plays)</div><div class="sp-data-artists">`;
      for (const a of taste.topArtists) {
        const bits = [`${a.plays}×`];
        if (a.taste) bits.push(`taste ${a.taste > 0 ? '+' : ''}${a.taste}`);
        if (a.rating != null && _RATE_LABEL[String(a.rating)]) bits.push(_RATE_LABEL[String(a.rating)]);
        if (a.genres && a.genres.length) bits.push(a.genres.join('/'));
        tasteInner += `<div class="sp-data-artist"><span class="sp-data-artist-name${a.loved ? ' loved' : ''}">${_esc(a.name)}</span><span class="sp-data-artist-meta">${_esc(bits.join(' · '))}</span></div>`;
      }
      tasteInner += `</div>`;
    }
    html += _section('What it has learned about your taste', tasteInner);

    // Genres
    const pct = g.total ? Math.round((g.known / g.total) * 100) : 0;
    let genreInner = `<div class="sp-data-cover"><div class="sp-data-cover-bar"><i style="width:${pct}%"></i></div>
      <span class="sp-data-cover-lbl">${g.known ?? 0}/${g.total ?? 0} artists genre-tagged (${pct}%)${g.pending ? ` · ${g.pending} pending` : ''}</span></div>`;
    if ((g.buckets || []).length) {
      genreInner += `<div class="sp-data-buckets">${g.buckets.map(b =>
        `<span class="sp-data-bucket">${_esc(b.name)} <b>${b.count}</b></span>`).join('')}</div>`;
    }
    if (!d.lastfm) genreInner += `<div class="sp-data-warn">⚠ No Last.fm key set — genres can't be resolved.</div>`;
    html += _section('Genre knowledge', genreInner);

    // Right now
    let nowInner = '';
    if (d.vibe) {
      nowInner += `<div class="sp-data-grid">
        ${_stat(d.vibe.energy, 'energy')}
        ${_stat(d.vibe.valence, 'positivity')}
        ${_stat(d.vibe.bpm ?? '—', 'bpm')}
        ${_stat(d.vibe.clusterSize, 'songs in vibe')}
      </div>`;
      if (d.vibe.genre) nowInner += `<div class="sp-data-line">Current vibe genre: <b>${_esc(d.vibe.genre)}</b></div>`;
    } else {
      nowInner += `<div class="sp-data-line sp-data-dim">No vibe detected yet — keep listening.</div>`;
    }
    if (d.context && (d.context.suggestedMood || d.context.slot)) {
      nowInner += `<div class="sp-data-line">Time-of-day guess: <b>${_esc(`${d.context.suggestedEmoji || ''} ${d.context.suggestedMood || d.context.slot}`.trim())}</b></div>`;
    }
    html += _section('Right now', nowInner);

    // Smart queue
    const sqLines = [
      `Smart Queue: <b>${sq.enabled ? 'on' : 'off'}</b>${sq.running ? ' · running' : ' · idle'}`,
      sq.source ? `Source: <b>${_esc(sq.source)}</b>` : null,
      sq.activeLabel ? `Active selection: <b>${_esc(sq.activeLabel)}</b>${sq.activeGenre ? ` (${_esc(sq.activeGenre)})` : ''}` : 'Active selection: <b>none</b>',
      sq.poolSize != null ? `Drawing from <b>${sq.poolSize}</b> of your songs` : null,
      sq.windowSize ? `Queue window: <b>${sq.windowSize}</b> slots` : null,
      d.genreFlow ? `Genre-aware transitions: weight <b>${d.genreFlow.weight}</b>` : null,
    ].filter(Boolean);
    html += _section('Smart queue state', sqLines.map(l => `<div class="sp-data-line">${l}</div>`).join(''));

    // Tuning
    const tuneInner = Object.keys(_TUNE_INFO).map(k => {
      const [name, desc] = _TUNE_INFO[k];
      const val = t[k] != null ? (k === 'lookahead' ? t[k] : `${t[k]}%`) : '—';
      return `<div class="sp-data-tune"><span class="sp-data-tune-name">${name}</span><span class="sp-data-tune-val">${val}</span><span class="sp-data-tune-desc">${desc}</span></div>`;
    }).join('');
    html += _section('Tuning (your dials)', tuneInner);

    _dataEl.innerHTML = html;
  }
  const _onData = (d) => _renderData(d);
  socket.on('spotify:data', _onData);

  // ---- Main data load ----
  function _loadAll(data) {
    if (!data) return;
    _renderProfile(data.profile  || {});
    _renderPatterns(data.patterns || { grid: [], max: 1, blockNames: [], dayNames: [], total: 0 });
    // Tuning sliders
    if (data.tuning) _applyTuningState(data.tuning);
    // Shared continuous footer
    _updateContinuousState({ activeMoodKey: data.activeMoodKey, activeVibeKey: data.activeVibeKey, activeMix: data.activeMix });
  }

  // Collapse the Profile two-column layout when the widget gets narrow.
  const _insRo = new ResizeObserver(entries => {
    card.classList.toggle('sp-ins-narrow', entries[0].contentRect.width < 360);
  });
  _insRo.observe(card);

  // Cleanup
  const _cleanObs = new MutationObserver(() => {
    if (!document.contains(card)) {
      socket.off('spotify:insights_action', _onAction);
      socket.off('spotify:vibe_renamed',    _onVibeRenamed);
      socket.off('spotify:tuning',          _onTuning);
      socket.off('spotify:timezone',        _onTimezone);
      socket.off('spotify:continuous_state', _onContinuousState);
      socket.off('spotify:mix_map',         _onMixMap);
      socket.off('spotify:genre_profile',   _onGenreProfile);
      socket.off('spotify:data',            _onData);
      socket.off('spotify:insights',        _onInsights);
      socket.off('spotify:portraits',       _onPortraits);
      socket.off('spotify:artist_ratings',  _onArtistRatings);
      _insRo.disconnect();
      _cleanObs.disconnect();
    }
  });
  _cleanObs.observe(document.body, { childList: true, subtree: true });

  // Persistent listener so a background reseed (second emit from the server)
  // refreshes the panel without a manual reload. Guards against blank payloads.
  const _onInsights = (data) => { if (data && !data.error) _loadAll(data); };
  socket.on('spotify:insights', _onInsights);

  getSpotifyInsights().then(_loadAll);

  return card;
}

// ---------------------------------------------------------------------------
// Global check-in notification (fixed, lives in body)
// ---------------------------------------------------------------------------

let _checkInEl = null;
let _checkInDismissTimeout = null;

function _initCheckInNotification() {
  if (_checkInEl) return; // already initialised

  _checkInEl = document.createElement('div');
  _checkInEl.className = 'sp-checkin-toast';
  _checkInEl.style.display = 'none';
  _checkInEl.innerHTML = `
    <div class="sp-checkin-header">
      <span class="sp-checkin-title">How are you feeling?</span>
      <button class="sp-checkin-dismiss" title="Dismiss">✕</button>
    </div>
    <div class="sp-checkin-guess">
      <span class="sp-checkin-guess-emoji"></span>
      <span class="sp-checkin-guess-label"></span>
      <span class="sp-checkin-guess-sub">· We think</span>
    </div>
    <div class="sp-checkin-feelings"></div>
    <div class="sp-checkin-changed" style="display:none">Vibe changed · updating…</div>
  `;
  document.body.appendChild(_checkInEl);

  _checkInEl.querySelector('.sp-checkin-dismiss').addEventListener('pointerup', () => {
    dismissCheckIn();
    _hideCheckIn();
  });

  // Server says check-in is stale / vibe changed
  socket.on('spotify:checkin_dismiss', () => {
    const changedEl = _checkInEl.querySelector('.sp-checkin-changed');
    changedEl.style.display = '';
    clearTimeout(_checkInDismissTimeout);
    _checkInDismissTimeout = setTimeout(() => _hideCheckIn(), 2500);
  });

  socket.on('spotify:checkin_stale', () => {
    _hideCheckIn();
  });

  // New check-in prompt from server
  socket.on('spotify:checkin', ({ guessedFeeling, guess, feelings }) => {
    clearTimeout(_checkInDismissTimeout);
    const changedEl = _checkInEl.querySelector('.sp-checkin-changed');
    changedEl.style.display = 'none';

    // Set guess
    _checkInEl.querySelector('.sp-checkin-guess-emoji').textContent = guess?.emoji || '';
    _checkInEl.querySelector('.sp-checkin-guess-label').textContent = guess?.label || '';

    // Build feeling buttons
    const feelingsEl = _checkInEl.querySelector('.sp-checkin-feelings');
    feelingsEl.innerHTML = '';
    feelings.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'sp-checkin-feeling-btn' + (f.key === guessedFeeling ? ' sp-checkin-feeling-btn--guess' : '');
      btn.dataset.key = f.key;
      btn.innerHTML = `<span class="sp-ck-emoji">${f.emoji}</span><span class="sp-ck-label">${f.label}</span>`;
      btn.addEventListener('pointerup', () => {
        respondToCheckIn(f.key);
        _hideCheckIn();
      });
      feelingsEl.appendChild(btn);
    });

    _showCheckIn();
  });
}

function _showCheckIn() {
  if (!_checkInEl) return;
  _checkInEl.style.display = '';
  // Small delay then add visible class for CSS transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _checkInEl.classList.add('sp-checkin-toast--visible');
    });
  });
}

function _hideCheckIn() {
  if (!_checkInEl) return;
  _checkInEl.classList.remove('sp-checkin-toast--visible');
  clearTimeout(_checkInDismissTimeout);
  _checkInDismissTimeout = setTimeout(() => {
    if (_checkInEl) _checkInEl.style.display = 'none';
  }, 350); // match CSS transition
}

// ---------------------------------------------------------------------------
// Intelligence card
// ---------------------------------------------------------------------------

export function renderSpotifyIntelligence(ctrl) {
  _initCheckInNotification();

  const card = document.createElement('div');
  card.className = 'control-card spotify-intelligence-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-intel-wrap">
      <div class="sp-intel-header">
        <span class="sp-intel-title">Now Playing</span>
        <label class="sp-intel-auto-toggle" title="Auto check-ins — get prompted when a pattern is detected">
          <span class="sp-intel-auto-label">Auto</span>
          <input type="checkbox" class="sp-intel-auto-check" checked>
          <span class="sp-intel-switch"></span>
        </label>
      </div>

      <div class="sp-intel-active">
        <div class="sp-intel-feeling-row" style="display:none">
          <span class="sp-intel-feeling-emoji"></span>
          <div class="sp-intel-feeling-info">
            <span class="sp-intel-feeling-label"></span>
            <span class="sp-intel-feeling-sub">Feeling · keeps going</span>
          </div>
          <button class="sp-intel-stop-btn" title="Stop">■</button>
        </div>
        <div class="sp-intel-vibe-row" style="display:none">
          <span class="sp-intel-vibe-icon">✦</span>
          <div class="sp-intel-vibe-info">
            <span class="sp-intel-vibe-label"></span>
            <span class="sp-intel-vibe-sub">keeps going ∞</span>
          </div>
          <button class="sp-intel-stop-btn sp-intel-vibe-stop-btn" title="Stop">■</button>
        </div>
        <div class="sp-intel-idle" style="display:none">
          <span class="sp-intel-idle-text">Nothing active</span>
        </div>
      </div>

      <div class="sp-intel-divider"></div>

      <div class="sp-intel-context">
        <div class="sp-intel-context-label">The vibe you're going for <span class="sp-intel-context-hint">· learned from your patterns</span></div>
        <div class="sp-intel-predict" style="display:none">
          <span class="sp-intel-predict-emoji"></span>
          <div class="sp-intel-predict-info">
            <div class="sp-intel-predict-name"><span>—</span></div>
            <div class="sp-intel-predict-sub"><span></span></div>
            <div class="sp-intel-predict-artists" style="display:none"><span></span></div>
            <div class="sp-intel-predict-bars" style="display:none">
              <span class="sp-intel-predict-bar" title="Energy"><i class="sp-intel-predict-bar-e"></i></span>
              <span class="sp-intel-predict-bar sp-intel-predict-bar--v" title="Positivity"><i class="sp-intel-predict-bar-v"></i></span>
            </div>
            <span class="sp-intel-predict-drift" style="display:none"></span>
          </div>
          <button class="sp-intel-predict-play" title="Play this vibe">▶</button>
        </div>
        <div class="sp-intel-context-value" style="display:none">—</div>
      </div>

      <div class="sp-intel-cluster">
        <div class="sp-intel-cluster-label">Listening pattern</div>
        <div class="sp-intel-cluster-bar-wrap">
          <div class="sp-intel-cluster-bar"></div>
        </div>
        <span class="sp-intel-cluster-size">0 tracks</span>
      </div>

      <div class="sp-intel-divider"></div>

      <div class="sp-intel-checkin-row">
        <button class="sp-intel-checkin-btn">
          <svg class="sp-intel-checkin-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="9" cy="10" r="0.8" fill="currentColor" stroke="none"/>
            <circle cx="15" cy="10" r="0.8" fill="currentColor" stroke="none"/>
            <path d="M8.5 15.5c1 1.5 2.5 2 3.5 2s2.5-.5 3.5-2"/>
            <path d="M19 3l1.5-1.5M19 3l-1.5-1.5M19 3v-2" style="opacity:0.5"/>
          </svg>
          How am I feeling?
        </button>
        <button class="sp-intel-reset-btn" title="Reset session — start a fresh listening session">
          ${SP_ICON.reset}
        </button>
      </div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const feelingRow   = card.querySelector('.sp-intel-feeling-row');
  const vibeRow      = card.querySelector('.sp-intel-vibe-row');
  const idleEl       = card.querySelector('.sp-intel-idle');
  const feelingEmoji = card.querySelector('.sp-intel-feeling-emoji');
  const feelingLabel = card.querySelector('.sp-intel-feeling-label');
  const feelingSub   = card.querySelector('.sp-intel-feeling-sub');
  const vibeLabelEl  = card.querySelector('.sp-intel-vibe-label');
  const vibeSub      = card.querySelector('.sp-intel-vibe-sub');
  const contextVal   = card.querySelector('.sp-intel-context-value');
  const predictEl    = card.querySelector('.sp-intel-predict');
  const predictEmoji = card.querySelector('.sp-intel-predict-emoji');
  const predictName  = card.querySelector('.sp-intel-predict-name');
  const predictSub   = card.querySelector('.sp-intel-predict-sub');
  const predictArtists = card.querySelector('.sp-intel-predict-artists');
  const predictBars  = card.querySelector('.sp-intel-predict-bars');
  const predictBarE  = card.querySelector('.sp-intel-predict-bar-e');
  const predictBarV  = card.querySelector('.sp-intel-predict-bar-v');
  const predictDrift = card.querySelector('.sp-intel-predict-drift');
  const predictPlay  = card.querySelector('.sp-intel-predict-play');
  const contextLabel = card.querySelector('.sp-intel-context-label');
  let   _predictMoodKey = null;
  let   _predictTimeMachine = false; // true when the predict card is showing the time-machine
  const clusterBar   = card.querySelector('.sp-intel-cluster-bar');
  const clusterSize  = card.querySelector('.sp-intel-cluster-size');
  const autoCheck    = card.querySelector('.sp-intel-auto-check');
  const checkinBtn   = card.querySelector('.sp-intel-checkin-btn');
  const resetBtn     = card.querySelector('.sp-intel-reset-btn');

  let _currentClusterSizeCache = 0;
  // Cached separately from clusterSize: a continuous_state event carries the active
  // keys but NOT the pool size, so without a cache the "drawing from N songs" line
  // would flicker blank until the next full intelligence_state arrives.
  let _currentPoolSizeCache = null;

  function _renderState(data) {
    if (!data) return;

    // Active state
    const { activeFeeling, activeMoodKey, activeVibeKey, clusterSize: cs, clusterCentroid, context } = data;

    if (cs != null) _currentClusterSizeCache = cs;
    if (data.activePoolSize !== undefined) _currentPoolSizeCache = data.activePoolSize;

    // "Drawing from N of your songs" — how big the active pool the engine picks from is.
    const _ps = _currentPoolSizeCache;
    const _poolText = (_ps != null && _ps > 0) ? `drawing from ${_ps} of your songs` : null;

    const activeMix = data.activeMix;
    if (activeFeeling) {
      feelingEmoji.textContent = activeFeeling.emoji;
      feelingLabel.textContent = activeFeeling.label;
      if (feelingSub) feelingSub.textContent = _poolText ? `Feeling · ${_poolText}` : 'Feeling · keeps going';
      feelingRow.style.display = '';
      vibeRow.style.display    = 'none';
      idleEl.style.display     = 'none';
    } else if (activeMix && activeMix.label) {
      // Unified mood-map mix the user picked from the Mixes/Genres pad.
      vibeLabelEl.textContent  = activeMix.label;
      if (vibeSub) vibeSub.textContent = _poolText ? `mix · ${_poolText} · keeps going ∞` : `mix · keeps going ∞`;
      vibeRow.style.display    = '';
      feelingRow.style.display = 'none';
      idleEl.style.display     = 'none';
    } else if (activeMoodKey || activeVibeKey) {
      vibeLabelEl.textContent  = data.activeMoodName || activeMoodKey || activeVibeKey;
      if (vibeSub) vibeSub.textContent = _poolText ? `${_poolText} · keeps going ∞` : 'keeps going ∞';
      vibeRow.style.display    = '';
      feelingRow.style.display = 'none';
      idleEl.style.display     = 'none';
    } else {
      feelingRow.style.display = 'none';
      vibeRow.style.display    = 'none';
      idleEl.style.display     = '';
    }

    // The current slot's "It's Sunday 11pm — your nights usually lean angsty,
    // often X" time-machine card — exactly what used to be on the Portraits panel,
    // now shown here verbatim. The ▶ replays a real past same-slot track (the
    // time-machine seed). Both the headline and sub scroll (marquee) when they
    // overflow, so it fits every Now Playing card size. Falls back to the lighter
    // mood guess only when there isn't enough history for a time-machine yet.
    const tm = context?.timeMachine;
    const cp = context?.contextProfile;
    if (tm && tm.headline) {
      _predictTimeMachine = true;
      _predictMoodKey = null;
      if (contextLabel) contextLabel.style.display = 'none'; // the headline is self-describing
      predictEmoji.textContent = tm.emoji || '🕰️';
      _setMarqueeText(predictName, tm.headline);
      // Static descriptor under the headline ("Your nights usually lean X, often:")
      // — wraps instead of scrolling (no marquee), unlike the other render branches.
      _setStaticText(predictSub, tm.lean || tm.sub || '');
      // Marquee of this time-slot's regular artists, scrolling beneath the descriptor.
      const tmArtists = (tm.artists && tm.artists.length) ? tm.artists.join('   ·   ') : '';
      if (predictArtists) {
        if (tmArtists) {
          _setMarqueeText(predictArtists, tmArtists);
          predictArtists.style.display = '';
        } else {
          predictArtists.style.display = 'none';
        }
      }
      predictBars.style.display = 'none';
      predictDrift.style.display = 'none';
      predictPlay.style.display = (tm.seed && tm.seed.uri) ? '' : 'none';
      predictEl.style.display = '';
      contextVal.style.display = 'none';
    } else if (cp && cp.feelingLabel) {
      _predictTimeMachine = false;
      _predictMoodKey = cp.moodKey || null;
      if (predictArtists) predictArtists.style.display = 'none';
      if (contextLabel) contextLabel.style.display = '';
      predictEmoji.textContent = cp.emoji || cp.moodEmoji || '🎧';
      _setMarqueeText(predictName, cp.moodName || cp.feelingLabel);
      const artists = (cp.topArtists || []).slice(0, 2).map(a => a.name).join(', ');
      // Personal, Portraits-style line from the server (timezone-aware clock),
      // e.g. "It's 7pm, your nights usually feel angsty · Sleep Token, …".
      const basis = cp.personal
        || (cp.source === 'reported'
              ? `${cp.label} · you usually feel ${cp.feelingLabel.toLowerCase()}`
              : `${cp.label} · usually sounds ${cp.feelingLabel.toLowerCase()}`);
      _setMarqueeText(predictSub, artists ? `${basis} · ${artists}` : basis);
      // Portraits-style energy / positivity bars + taste-drift for this slot.
      if (cp.energy != null && cp.valence != null) {
        predictBarE.style.width = Math.max(0, Math.min(100, cp.energy)) + '%';
        predictBarV.style.width = Math.max(0, Math.min(100, cp.valence)) + '%';
        predictBars.style.display = '';
      } else {
        predictBars.style.display = 'none';
      }
      if (cp.drift) {
        predictDrift.textContent = `↗ ${cp.drift}`;
        predictDrift.style.display = '';
      } else {
        predictDrift.style.display = 'none';
      }
      predictPlay.style.display = _predictMoodKey ? '' : 'none';
      predictEl.style.display = '';
      contextVal.style.display = 'none';
    } else if (context?.suggestedMoodName) {
      _predictTimeMachine = false;
      _predictMoodKey = context.suggestedMoodKey || null;
      if (predictArtists) predictArtists.style.display = 'none';
      if (contextLabel) contextLabel.style.display = '';
      predictEmoji.textContent = context.suggestedMoodEmoji || '🎧';
      _setMarqueeText(predictName, context.suggestedMoodName);
      _setMarqueeText(predictSub, 'a guess from your time-of-day patterns');
      predictBars.style.display = 'none';
      predictDrift.style.display = 'none';
      predictPlay.style.display = _predictMoodKey ? '' : 'none';
      predictEl.style.display = '';
      contextVal.style.display = 'none';
    } else {
      _predictTimeMachine = false;
      _predictMoodKey = null;
      if (predictArtists) predictArtists.style.display = 'none';
      if (contextLabel) contextLabel.style.display = '';
      predictEl.style.display = 'none';
      contextVal.style.display = '';
      contextVal.textContent = 'Not sure yet — keep listening';
    }

    // Cluster bar (confidence indicator, max display = 20 tracks)
    const pct = Math.min(100, ((_currentClusterSizeCache || 0) / 20) * 100);
    clusterBar.style.width = pct + '%';
    clusterSize.textContent = `${_currentClusterSizeCache || 0} track${_currentClusterSizeCache !== 1 ? 's' : ''} detected`;

    // Auto check-in toggle
    if (data.checkInAuto != null) autoCheck.checked = data.checkInAuto;
  }

  // Stop buttons
  card.querySelectorAll('.sp-intel-stop-btn').forEach(btn => {
    btn.addEventListener('pointerup', () => {
      if (isEditMode()) return;
      stopFeeling();
    });
  });

  // Predicted-vibe play — the ONLY place a prediction starts playback, and only on
  // an explicit tap. Answering a check-in never plays; this button does.
  predictPlay.addEventListener('pointerup', (e) => {
    if (isEditMode()) return;
    e.stopPropagation();
    // Time-machine mode: replay a real past same-slot track (the seed), exactly
    // like the old Portraits card's ▶ did.
    if (_predictTimeMachine) {
      socket.emit('spotify:time_machine_play');
      _spToast('⏳ Replaying your time-of-day vibe — building your queue…');
      return;
    }
    if (!_predictMoodKey) return;
    playMood(_predictMoodKey);
    _spToast(`⏳ Loading ${predictName.textContent} — building your queue…`);
  });

  // Check-in button — manually trigger the popup
  checkinBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    // If there's a pending check-in already, just show it
    if (_checkInEl && _checkInEl.style.display !== 'none') return;
    // Otherwise ask server to get current context and show generic feeling picker
    socket.emit('spotify:get_intelligence');
    socket.once('spotify:intelligence_state', (data) => {
      if (data.pendingCheckIn) {
        // Server already has a pending one — the checkin event will have been sent
        return;
      }
      // Manually show feeling picker with no guess
      if (_checkInEl) {
        _checkInEl.querySelector('.sp-checkin-guess-emoji').textContent = '💭';
        _checkInEl.querySelector('.sp-checkin-guess-label').textContent = 'You tell us';
        _checkInEl.querySelector('.sp-checkin-changed').style.display = 'none';
        const feelingsEl = _checkInEl.querySelector('.sp-checkin-feelings');
        feelingsEl.innerHTML = '';
        (data.feelings || []).forEach(f => {
          const btn = document.createElement('button');
          btn.className = 'sp-checkin-feeling-btn';
          btn.dataset.key = f.key;
          btn.innerHTML = `<span class="sp-ck-emoji">${f.emoji}</span><span class="sp-ck-label">${f.label}</span>`;
          btn.addEventListener('pointerup', () => {
            respondToCheckIn(f.key);
            _hideCheckIn();
          });
          feelingsEl.appendChild(btn);
        });
        _showCheckIn();
      }
    });
  });

  // Reset session button — two-tap confirm to avoid accidental wipes
  let _resetArmed = false;
  let _resetTimer = null;
  if (resetBtn) {
    resetBtn.addEventListener('pointerup', () => {
      if (isEditMode()) return;
      if (!_resetArmed) {
        _resetArmed = true;
        resetBtn.classList.add('armed');
        resetBtn.title = 'Tap again to reset the session';
        // Touch devices never show the title tooltip, so without this the first
        // tap looks like a no-op. The toast tells the user to confirm.
        _spToast('Tap again to reset the session');
        clearTimeout(_resetTimer);
        _resetTimer = setTimeout(() => {
          _resetArmed = false;
          resetBtn.classList.remove('armed');
          resetBtn.title = 'Reset session — start a fresh listening session';
        }, 3000);
        return;
      }
      clearTimeout(_resetTimer);
      _resetArmed = false;
      resetBtn.classList.remove('armed');
      resetBtn.title = 'Reset session — start a fresh listening session';
      resetSpotifySession();
    });
  }

  // Auto check-in toggle
  autoCheck.addEventListener('change', () => {
    setCheckInAuto(autoCheck.checked);
  });

  // Socket listeners
  const _onIntelState = (data) => {
    _currentClusterSizeCache = data.clusterSize || 0;
    _renderState(data);
  };
  const _onFeelingExp = () => _renderState({ activeFeeling: null, activeMoodKey: null, activeVibeKey: null, clusterSize: _currentClusterSizeCache, context: null });
  const _onContState  = (data) => {
    _renderState({ ...data, clusterSize: _currentClusterSizeCache });
  };
  const _onCheckinAuto = ({ enabled }) => { autoCheck.checked = enabled; };
  const _onSessionReset = (data = {}) => _spToast(data.msg || 'Music intelligence refreshed', data.ok === false);

  socket.on('spotify:intelligence_state', _onIntelState);
  socket.on('spotify:feeling_expired',    _onFeelingExp);
  socket.on('spotify:continuous_state',   _onContState);
  socket.on('spotify:checkin_auto',       _onCheckinAuto);
  socket.on('spotify:session_reset',      _onSessionReset);

  // Adapt the layout to the card's footprint so nothing clips on small grids
  // (e.g. a 3×2 cell). `compact` tightens spacing + drops the listening-pattern
  // bar; `tiny` collapses the prediction sub-line and check-in label too.
  let _predictMarqueeTimer = null;
  const _intelRo = new ResizeObserver(entries => {
    const { height, width } = entries[0].contentRect;
    // Progressive collapse so the card always fits its panel instead of clipping:
    //   compact → drop the listening-pattern bar
    //   tiny    → drop the prediction/feeling sub-lines
    //   micro   → drop the whole "vibe you're going for" context block + dividers,
    //             leaving just the active state + check-in row (the essentials).
    card.classList.toggle('sp-intel-compact', height < 260);
    card.classList.toggle('sp-intel-tiny',    height < 210);
    card.classList.toggle('sp-intel-micro',   height < 165);
    card.classList.toggle('sp-intel-narrow',  width  < 210);
    // Re-measure the prediction marquees when the card width changes, just like
    // the player re-measures its title/artist on resize.
    clearTimeout(_predictMarqueeTimer);
    _predictMarqueeTimer = setTimeout(() => {
      _applyMarquee(predictName);
      // predictSub is static (wrapping) in time-machine mode — don't marquee it then.
      if (!predictSub.classList.contains('sp-marquee-static')) _applyMarquee(predictSub);
      if (predictArtists) _applyMarquee(predictArtists);
    }, 60);
  });
  _intelRo.observe(card);

  // Cleanup
  const _cleanObs = new MutationObserver(() => {
    if (!document.contains(card)) {
      socket.off('spotify:intelligence_state', _onIntelState);
      socket.off('spotify:feeling_expired',    _onFeelingExp);
      socket.off('spotify:continuous_state',   _onContState);
      socket.off('spotify:checkin_auto',       _onCheckinAuto);
      socket.off('spotify:session_reset',      _onSessionReset);
      _intelRo.disconnect();
      _cleanObs.disconnect();
    }
  });
  _cleanObs.observe(document.body, { childList: true, subtree: true });

  getIntelligence().then(_renderState);

  return card;
}

// ---------------------------------------------------------------------------
// Dispatch export
// ---------------------------------------------------------------------------

export function renderSpotifyControl(ctrl) {
  switch (ctrl.type) {
    case 'spotify_player':       return renderSpotifyPlayer(ctrl);
    case 'spotify_search':       return renderSpotifySearch(ctrl);
    case 'spotify_playlists':    return renderSpotifyPlaylists(ctrl);
    case 'spotify_queue':        return renderSpotifyQueue(ctrl);
    case 'spotify_stats':        return renderSpotifyStats(ctrl);
    case 'spotify_insights':     return renderSpotifyInsights(ctrl);
    case 'spotify_intelligence': return renderSpotifyIntelligence(ctrl);
    default:
      console.warn('[spotify-controls] Unknown control type:', ctrl.type);
      return null;
  }
}
