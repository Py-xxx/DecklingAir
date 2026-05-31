/**
 * spotify-controls.js
 * Browser ES module — Spotify control cards for the VoiceMeeter control panel.
 * Renders: spotify_player, spotify_search, spotify_playlists, spotify_queue
 */

import {
  spotifyCmd,
  spotifySearch,
  getSpotifyPlaylists,
  getSpotifyQueue,
  getSpotifyDevices,
  addToPlaylist,
} from './spotify-client.js';

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

  prev: () => `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
  </svg>`,

  next: () => `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 18l8.5-6L6 6v12zm8.5-6v6h2V6h-2v6z"/>
  </svg>`,

  play: () => `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 5v14l11-7z"/>
  </svg>`,

  pause: () => `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"
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
};

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

  if (_playlists.length) {
    renderList(_playlists);
  } else {
    listEl.innerHTML = '<div class="sp-popover-empty">Loading…</div>';
    getSpotifyPlaylists().then((data) => {
      if (data && data.items) {
        _playlists = data.items;
        renderList(_playlists);
      }
    });
  }

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

// Marquee scroll for overflowing text elements.
// Call after setting textContent so the browser has rendered the new width.
function _applyMarquee(el) {
  el.style.animation = 'none';
  el.style.setProperty('--sp-scroll-shift', '0px');
  // Two rAFs ensure the browser has laid out the new text before measuring
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 6) {
      const secs = Math.max(4, overflow / 38); // ~38 px/s feels natural
      el.style.setProperty('--sp-scroll-shift', `-${overflow}px`);
      el.style.animation = `sp-marquee-scroll ${secs}s ease-in-out 1.2s infinite alternate`;
    } else {
      el.style.animation = '';
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
          <div class="sp-track-title">No playback</div>
          <div class="sp-track-artist"></div>
        </div>
        <button class="sp-icon-btn sp-heart-btn" aria-label="Like">${SVG.heart(false)}</button>
        <button class="sp-icon-btn sp-add-btn"   aria-label="Add to playlist">${SVG.plus()}</button>
        <button class="sp-icon-btn sp-device-btn" aria-label="Select device">${SVG.speaker()}</button>
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
  const noPlayback  = card.querySelector('.sp-no-playback');
  const playerEl    = card.querySelector('.sp-player');

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

  heartBtn.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    if (!_currentTrack) return;
    const cmd = _liked ? 'unlike' : 'like';
    _liked = !_liked;
    heartBtn.innerHTML = SVG.heart(_liked);
    spotifyCmd(cmd, { trackId: _currentTrack.id });
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

    if (titleEl.textContent !== (track.title || '')) {
      titleEl.textContent = track.title || '';
      _applyMarquee(titleEl);
    }
    if (artistEl.textContent !== (track.artist || '')) {
      artistEl.textContent = track.artist || '';
      _applyMarquee(artistEl);
    }

    heartBtn.innerHTML = SVG.heart(_liked);
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
      </div>
      <div class="sp-search-results"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const input    = card.querySelector('.sp-search-input');
  const results  = card.querySelector('.sp-search-results');

  let _debounce = null;

  input.addEventListener('input', () => {
    if (isEditMode()) return;
    clearTimeout(_debounce);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    _debounce = setTimeout(() => {
      spotifySearch(q);
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (isEditMode()) { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      clearTimeout(_debounce);
      const q = input.value.trim();
      if (q) spotifySearch(q);
    }
  });

  input.addEventListener('pointerdown', (e) => {
    if (isEditMode()) e.preventDefault();
  });

  card._updateSpotifySearch = function (data) {
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
        ${track.albumArt
          ? `<img src="${track.albumArt}" class="sp-thumb sp-thumb--sm" width="32" height="32" alt="">`
          : `<div class="sp-thumb sp-thumb--sm sp-thumb--placeholder"></div>`}
        <div class="sp-search-row-info">
          <div class="sp-search-row-title">${_esc(track.title)}</div>
          <div class="sp-search-row-artist">${_esc(track.artist)}</div>
        </div>
        <button class="sp-row-btn sp-row-play-btn"  aria-label="Play now">${SVG.playSmall()}</button>
        <button class="sp-row-btn sp-row-queue-btn" aria-label="Add to queue">${SVG.queueAdd()}</button>
      `;

      row.querySelector('.sp-row-play-btn').addEventListener('pointerup', (e) => {
        if (isEditMode()) return;
        e.stopPropagation();
        spotifyCmd('play', { uris: [track.uri] });
      });

      row.querySelector('.sp-row-queue-btn').addEventListener('pointerup', (e) => {
        if (isEditMode()) return;
        e.stopPropagation();
        spotifyCmd('queue_add', { uri: track.uri });
        _flashBtn(e.currentTarget);
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

function renderSpotifyPlaylists(ctrl) {
  const cfg = ctrl.config || ctrl.cfg || {};
  const columns = cfg.columns || 3;

  const card = document.createElement('div');
  card.className = 'control-card spotify-playlists-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  card.innerHTML = `
    <div class="sp-playlists-wrap">
      <div class="sp-section-header">
        <span class="sp-section-title">Playlists</span>
        <div class="sp-sort-bar">
          <button class="sp-sort-btn active" data-sort="added">Added</button>
          <button class="sp-sort-btn" data-sort="name">A–Z</button>
          <button class="sp-sort-btn" data-sort="recent">Recent</button>
        </div>
      </div>
      <div class="sp-playlists-grid" style="--sp-pl-cols: ${columns}"></div>
    </div>
  `;

  card.appendChild(dragHandle());
  card.appendChild(resizeHandle());
  card.appendChild(editOverlay(ctrl.id));

  const grid    = card.querySelector('.sp-playlists-grid');
  const sortBar = card.querySelector('.sp-sort-bar');

  let _allItems = [];
  let _sortMode = 'added';

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
    // 'added' keeps original API order
    return items;
  }

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
      item.innerHTML = `
        ${pl.coverUrl
          ? `<img src="${pl.coverUrl}" class="sp-playlist-cover" alt="">`
          : `<div class="sp-playlist-cover sp-thumb--placeholder"></div>`}
        <div class="sp-playlist-name">${_esc(pl.name)}</div>
      `;
      item.addEventListener('pointerdown', () => {
        if (isEditMode()) return;
        item.classList.add('sp-playlist-item--pressed');
      });
      item.addEventListener('pointerup', () => {
        item.classList.remove('sp-playlist-item--pressed');
        if (isEditMode()) return;
        _recentPlaylistIds = [pl.id, ..._recentPlaylistIds.filter(x => x !== pl.id)].slice(0, 100);
        spotifyCmd('playlist_play', { playlistUri: pl.uri, playlistId: pl.id });
      });
      item.addEventListener('pointercancel', () => {
        item.classList.remove('sp-playlist-item--pressed');
      });
      grid.appendChild(item);
    });
  }

  // Sort bar clicks
  sortBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sp-sort-btn');
    if (!btn) return;
    _sortMode = btn.dataset.sort;
    sortBar.querySelectorAll('.sp-sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    _renderGrid();
  });

  function _render(data) {
    _allItems = (data && data.items) ? data.items : [];
    _renderGrid();
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
// Dispatch export
// ---------------------------------------------------------------------------

export function renderSpotifyControl(ctrl) {
  switch (ctrl.type) {
    case 'spotify_player':    return renderSpotifyPlayer(ctrl);
    case 'spotify_search':    return renderSpotifySearch(ctrl);
    case 'spotify_playlists': return renderSpotifyPlaylists(ctrl);
    case 'spotify_queue':     return renderSpotifyQueue(ctrl);
    default:
      console.warn('[spotify-controls] Unknown control type:', ctrl.type);
      return null;
  }
}
