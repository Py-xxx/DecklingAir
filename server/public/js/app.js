// Main application entry point
import { initSocket, saveLayout } from './socket.js';
import { renderControl, setStateRef } from './controls.js';
import { initEditor, initGridEvents, openModal, openSettings } from './editor.js';

// ── Application State ─────────────────────────────────────────────────────────
const state = {
  layout: null,
  vmState: {},
  levels: [],
  bridge: { connected: false, vmType: null, vmVersion: null },
  ui: { currentPage: 0, editMode: false },
};

// Card registry: id → DOM element
const cardRegistry = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const gridEl      = document.getElementById('control-grid');
const pageTabs    = document.getElementById('page-tabs');
const statusBadge = document.getElementById('bridge-status');
const statusText  = document.getElementById('status-text');
const emptyState  = document.getElementById('empty-state');
const btnSettings = document.getElementById('btn-settings');

// ── Init ──────────────────────────────────────────────────────────────────────
setStateRef(state.vmState, state.levels);

initSocket({
  onConnect() {
    console.log('Socket connected');
  },
  onDisconnect() {
    setBridgeStatus({ connected: false });
  },
  onVmState(vmState) {
    Object.assign(state.vmState, vmState);
    updateAllCards();
  },
  onVmUpdate(param, value) {
    state.vmState[param] = value;
    cardRegistry.forEach(card => card._updateState?.(param, value));
  },
  onLevels(levels) {
    state.levels = levels;
    cardRegistry.forEach(card => card._updateLevels?.(levels));
  },
  onBridgeStatus(info) {
    setBridgeStatus(info);
  },
  onBridgeError(msg) {
    console.warn('Bridge error:', msg);
  },
  onLayout(layout) {
    state.layout = layout;
    applySettings();
    renderCurrentPage();
  },
});

initEditor(state, {
  onSave() {
    persistLayout();
    renderCurrentPage();
  },
  onDelete(id) {
    cardRegistry.delete(id);
  },
});

initGridEvents(gridEl);
btnSettings.addEventListener('click', openSettings);

// ── Settings application ──────────────────────────────────────────────────────
function applySettings() {
  const s = state.layout?.settings || {};
  if (s.accentColor) document.documentElement.style.setProperty('--accent', s.accentColor);
  const cols = s.gridColumns || 8;
  gridEl.style.setProperty('--grid-cols', cols);
}

// ── Page rendering ────────────────────────────────────────────────────────────
function renderCurrentPage() {
  if (!state.layout) return;
  renderPageTabs();

  const page = state.layout.pages?.[state.ui.currentPage];
  gridEl.innerHTML = '';
  cardRegistry.clear();

  if (!page || page.controls.length === 0) {
    emptyState.style.display = state.ui.editMode ? 'flex' : 'flex';
    return;
  }
  emptyState.style.display = 'none';

  const cols = state.layout.settings?.gridColumns || 8;
  gridEl.style.setProperty('--grid-cols', cols);

  page.controls.forEach(ctrl => {
    const card = renderControl(ctrl, state.vmState);
    if (card) {
      card.draggable = state.ui.editMode;
      gridEl.appendChild(card);
      cardRegistry.set(ctrl.id, card);
    }
  });
}

function renderPageTabs() {
  pageTabs.innerHTML = '';
  (state.layout?.pages || []).forEach((page, i) => {
    const tab = document.createElement('button');
    tab.className = 'page-tab' + (i === state.ui.currentPage ? ' active' : '');
    tab.textContent = page.name;

    const del = document.createElement('span');
    del.className = 'page-tab-del';
    del.innerHTML = '×';
    del.title = 'Delete page';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.layout.pages.length <= 1) return;
      if (!confirm(`Delete page "${page.name}"?`)) return;
      state.layout.pages.splice(i, 1);
      if (state.ui.currentPage >= state.layout.pages.length) state.ui.currentPage = 0;
      persistLayout();
      renderCurrentPage();
    });

    tab.appendChild(del);
    tab.addEventListener('click', () => {
      state.ui.currentPage = i;
      renderCurrentPage();
    });
    pageTabs.appendChild(tab);
  });
}

function updateAllCards() {
  cardRegistry.forEach((card) => {
    if (card._updateState) {
      Object.entries(state.vmState).forEach(([p, v]) => card._updateState(p, v));
    }
  });
}

// ── Bridge status display ─────────────────────────────────────────────────────
function setBridgeStatus(info) {
  Object.assign(state.bridge, info);
  const online = info.connected;
  statusBadge.className = `status-badge ${online ? 'status-online' : 'status-offline'}`;
  const vmNames = { 1: 'VoiceMeeter', 2: 'Banana', 3: 'Potato' };
  statusText.textContent = online
    ? `${vmNames[info.vmType] || 'Connected'}`
    : 'Offline';
}

// ── Layout persistence ────────────────────────────────────────────────────────
function persistLayout() {
  saveLayout(state.layout);
}

// ── VU meter animation loop ───────────────────────────────────────────────────
// Cards register their own update callbacks; levels arrive via socket at ~20fps.
// No extra RAF loop needed — socket events drive the updates directly.
