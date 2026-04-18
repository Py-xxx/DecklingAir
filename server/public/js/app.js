import { initSocket, saveLayout } from './socket.js';
import { renderControl, setStateRef } from './controls.js';
import {
  initEditor,
  initGridEvents,
  openPageNameModal,
  openSettings,
} from './editor.js';

const DEFAULT_LAYOUT = {
  version: '1.1',
  pages: [
    {
      id: 'page_main',
      name: 'Main',
      controls: [],
    },
  ],
  settings: {
    accentColor: '#6c63ff',
    gridColumns: 8,
  },
};

const DEFAULT_SIZES = {
  fader: [1, 4],
  toggle: [1, 1],
  button: [2, 1],
  macro: [2, 1],
  desktop_action: [2, 1],
  vu_meter: [1, 3],
  strip_panel: [1, 4],
  bus_panel: [1, 3],
  label: [2, 1],
};

const state = {
  layout: normalizeLayout(DEFAULT_LAYOUT),
  vmState: {},
  levels: [],
  bridge: { connected: false, vmType: null, vmVersion: null },
  ui: { currentPage: 0, editMode: false },
};

const cardRegistry = new Map();

const gridEl = document.getElementById('control-grid');
const gridOverlayEl = document.getElementById('grid-overlay');
const pageTabsEl = document.getElementById('page-tabs');
const emptyStateEl = document.getElementById('empty-state');
const statusBadgeEl = document.getElementById('bridge-status');
const statusTextEl = document.getElementById('status-text');
const btnSettingsEl = document.getElementById('btn-settings');

setStateRef(state.vmState);

initEditor(state, {
  commitLayout({ persist = true, rerender = true } = {}) {
    state.layout = normalizeLayout(state.layout);
    clampCurrentPage();
    if (persist) persistLayout();
    if (rerender) renderCurrentPage();
  },
  replaceLayout(nextLayout) {
    state.layout = normalizeLayout(nextLayout);
    clampCurrentPage();
    persistLayout();
    renderCurrentPage();
  },
  openPageSettings() {
    openSettings();
  },
});

initGridEvents(gridEl);
btnSettingsEl.addEventListener('click', () => openSettings());

initSocket({
  onConnect() {},
  onDisconnect() {
    setBridgeStatus({ connected: false, vmType: null, vmVersion: null });
  },
  onVmState(vmState) {
    Object.assign(state.vmState, vmState);
    refreshAllCards();
  },
  onVmUpdate(param, value) {
    state.vmState[param] = value;
    cardRegistry.forEach(card => card._updateState?.(param, value));
  },
  onLevels(levels) {
    state.levels = Array.isArray(levels) ? levels : [];
    cardRegistry.forEach(card => card._updateLevels?.(state.levels));
  },
  onBridgeStatus(info) {
    setBridgeStatus(info);
  },
  onBridgeError(msg) {
    console.warn('Bridge error:', msg);
  },
  onLayout(layout) {
    state.layout = normalizeLayout(layout);
    clampCurrentPage();
    applySettings();
    renderCurrentPage();
  },
});

applySettings();
renderCurrentPage();

function normalizeLayout(layout) {
  const input = layout && typeof layout === 'object' ? layout : {};
  const settings = {
    ...DEFAULT_LAYOUT.settings,
    ...(input.settings || {}),
  };

  const pages = Array.isArray(input.pages) && input.pages.length
    ? input.pages.map((page, pageIndex) => normalizePage(page, pageIndex, settings.gridColumns))
    : DEFAULT_LAYOUT.pages.map((page, pageIndex) => normalizePage(page, pageIndex, settings.gridColumns));

  return {
    version: input.version || DEFAULT_LAYOUT.version,
    settings,
    pages,
  };
}

function normalizePage(page, pageIndex, gridColumns) {
  const rawPage = page && typeof page === 'object' ? page : {};
  const controls = Array.isArray(rawPage.controls) ? rawPage.controls : [];
  const normalizedControls = [];

  controls.forEach((control, controlIndex) => {
    normalizedControls.push(normalizeControl(control, controlIndex, normalizedControls, gridColumns));
  });

  return {
    id: rawPage.id || `page_${pageIndex + 1}`,
    name: rawPage.name || `Page ${pageIndex + 1}`,
    controls: normalizedControls,
  };
}

function normalizeControl(control, controlIndex, existingControls, gridColumns) {
  const rawControl = control && typeof control === 'object' ? control : {};
  const type = rawControl.type || 'fader';
  const [defaultColSpan, defaultRowSpan] = DEFAULT_SIZES[type] || [1, 2];
  const colSpan = clampInt(rawControl.colSpan ?? defaultColSpan, 1, gridColumns);
  const rowSpan = clampInt(rawControl.rowSpan ?? defaultRowSpan, 1, 12);

  let col = clampInt(rawControl.col ?? 1, 1, gridColumns - colSpan + 1);
  let row = clampInt(rawControl.row ?? 1, 1, 999);

  if (!rawControl.col || !rawControl.row || collides(existingControls, { col, row, colSpan, rowSpan })) {
    const placement = findNextOpenSlot(existingControls, { colSpan, rowSpan }, gridColumns);
    col = placement.col;
    row = placement.row;
  }

  return {
    id: rawControl.id || `ctrl_${controlIndex + 1}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    col,
    row,
    colSpan,
    rowSpan,
    config: { ...(rawControl.config || {}) },
  };
}

function applySettings() {
  const settings = state.layout.settings || DEFAULT_LAYOUT.settings;
  const accent = settings.accentColor || DEFAULT_LAYOUT.settings.accentColor;
  const cols = clampInt(settings.gridColumns, 4, 12);

  state.layout.settings.accentColor = accent;
  state.layout.settings.gridColumns = cols;

  setAccentColor(accent);
  document.documentElement.style.setProperty('--grid-cols', String(cols));
  gridEl.style.setProperty('--grid-cols', String(cols));
  gridOverlayEl.style.setProperty('--grid-cols', String(cols));
}

function setAccentColor(hex) {
  const rgb = hexToRgb(hex) || { r: 108, g: 99, b: 255 };
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`);
}

function renderCurrentPage() {
  clampCurrentPage();
  applySettings();
  renderPageTabs();

  const page = getCurrentPage();
  const controls = page?.controls || [];

  gridEl.innerHTML = '';
  cardRegistry.clear();

  const rows = getGridRowCount(page);
  renderGridOverlay(rows);

  emptyStateEl.style.display = controls.length ? 'none' : 'flex';

  controls.forEach(control => {
    const card = renderControl(control, state.vmState);
    if (!card) return;
    gridEl.appendChild(card);
    cardRegistry.set(control.id, card);
    if (state.levels.length) card._updateLevels?.(state.levels);
  });
}

function renderGridOverlay(rows) {
  const cols = state.layout.settings.gridColumns || DEFAULT_LAYOUT.settings.gridColumns;
  gridOverlayEl.innerHTML = '';

  for (let i = 0; i < cols * rows; i += 1) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    gridOverlayEl.appendChild(cell);
  }
}

function renderPageTabs() {
  pageTabsEl.innerHTML = '';

  state.layout.pages.forEach((page, index) => {
    const tab = document.createElement('div');
    tab.className = `page-tab${index === state.ui.currentPage ? ' active' : ''}`;
    tab.title = page.name;
    tab.tabIndex = 0;
    tab.setAttribute('role', 'button');

    const label = document.createElement('span');
    label.textContent = page.name;
    tab.appendChild(label);

    if (state.ui.editMode) {
      const actions = document.createElement('span');
      actions.className = 'page-tab-actions';

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'page-tab-icon';
      rename.title = `Rename ${page.name}`;
      rename.textContent = '✎';
      rename.addEventListener('click', event => {
        event.stopPropagation();
        openPageNameModal(index);
      });

      actions.appendChild(rename);

      if (state.layout.pages.length > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'page-tab-icon danger';
        remove.title = `Delete ${page.name}`;
        remove.textContent = '×';
        remove.addEventListener('click', event => {
          event.stopPropagation();
          if (!window.confirm(`Delete page "${page.name}"?`)) return;
          state.layout.pages.splice(index, 1);
          clampCurrentPage();
          persistLayout();
          renderCurrentPage();
        });
        actions.appendChild(remove);
      }

      tab.appendChild(actions);
      tab.addEventListener('dblclick', event => {
        event.preventDefault();
        openPageNameModal(index);
      });
    }

    tab.addEventListener('click', () => {
      state.ui.currentPage = index;
      renderCurrentPage();
    });
    tab.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        state.ui.currentPage = index;
        renderCurrentPage();
      }
    });

    pageTabsEl.appendChild(tab);
  });

  if (state.ui.editMode) {
    const addTab = document.createElement('button');
    addTab.type = 'button';
    addTab.className = 'page-tab page-tab-add';
    addTab.title = 'Add page';
    addTab.innerHTML = '<span>+</span><span>Page</span>';
    addTab.addEventListener('click', () => openPageNameModal(null));
    pageTabsEl.appendChild(addTab);
  }
}

function refreshAllCards() {
  cardRegistry.forEach(card => {
    Object.entries(state.vmState).forEach(([param, value]) => {
      card._updateState?.(param, value);
    });
    if (state.levels.length) card._updateLevels?.(state.levels);
  });
}

function setBridgeStatus(info) {
  Object.assign(state.bridge, info || {});

  const online = !!state.bridge.connected;
  const vmNames = {
    1: 'VoiceMeeter',
    2: 'Banana',
    3: 'Potato',
  };

  statusBadgeEl.className = `status-badge ${online ? 'status-online' : 'status-offline'}`;
  statusTextEl.textContent = online
    ? vmNames[state.bridge.vmType] || 'Connected'
    : 'Offline';
}

function persistLayout() {
  state.layout = normalizeLayout(state.layout);
  saveLayout(state.layout);
}

function getCurrentPage() {
  clampCurrentPage();
  return state.layout.pages[state.ui.currentPage];
}

function clampCurrentPage() {
  const maxIndex = Math.max(0, state.layout.pages.length - 1);
  state.ui.currentPage = clampInt(state.ui.currentPage, 0, maxIndex);
}

function getGridRowCount(page) {
  const controls = page?.controls || [];
  const tallest = controls.reduce((max, control) => {
    const bottom = (control.row || 1) + (control.rowSpan || 1) - 1;
    return Math.max(max, bottom);
  }, 0);

  return Math.max(6, tallest + 1);
}

function findNextOpenSlot(existingControls, size, gridColumns) {
  const maxRows = 120;

  for (let row = 1; row <= maxRows; row += 1) {
    for (let col = 1; col <= gridColumns - size.colSpan + 1; col += 1) {
      const candidate = {
        col,
        row,
        colSpan: size.colSpan,
        rowSpan: size.rowSpan,
      };

      if (!collides(existingControls, candidate)) {
        return candidate;
      }
    }
  }

  return { col: 1, row: 1, colSpan: size.colSpan, rowSpan: size.rowSpan };
}

function collides(controls, candidate, ignoreId = null) {
  return controls.some(control => {
    if (ignoreId && control.id === ignoreId) return false;
    return rectsOverlap(control, candidate);
  });
}

function rectsOverlap(a, b) {
  const aLeft = a.col;
  const aRight = a.col + a.colSpan - 1;
  const aTop = a.row;
  const aBottom = a.row + a.rowSpan - 1;

  const bLeft = b.col;
  const bRight = b.col + b.colSpan - 1;
  const bTop = b.row;
  const bBottom = b.row + b.rowSpan - 1;

  return !(aRight < bLeft || bRight < aLeft || aBottom < bTop || bBottom < aTop);
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!match) return null;

  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  };
}
