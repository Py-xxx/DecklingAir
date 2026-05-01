import { initSocket, requestDesktopIcon, requestState, saveLayout, requestSoundboardDevices } from './socket.js';
import { renderControl, setStateRef } from './controls.js';
import {
  initEditor,
  initGridEvents,
  openPageNameModal,
  openSettings,
  updateSoundboardDeviceList,
} from './editor.js';

const DEFAULT_DEVICE_LAYOUT = {
  name: 'Primary Device',
  platform: 'unknown',
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

const DEFAULT_LAYOUT_STORE = {
  version: '2.0',
  globalSettings: {},
  deviceOrder: ['default'],
  devices: {
    default: DEFAULT_DEVICE_LAYOUT,
  },
};

const DEFAULT_SIZES = {
  fader: [1, 4],
  toggle: [1, 1],
  button: [2, 1],
  macro: [2, 1],
  desktop_action: [2, 1],
  soundboard: [2, 1],
  vu_meter: [1, 3],
  strip_panel: [1, 4],
  bus_panel: [1, 3],
  label: [2, 1],
};

const state = {
  layoutStore: normalizeLayoutStore(DEFAULT_LAYOUT_STORE),
  layout: normalizeDeviceLayout(DEFAULT_DEVICE_LAYOUT),
  devices: {},
  vmState: {},
  desktopIcons: {},
  levels: [],
  bridge: createDeviceRuntime('default'),
  ui: {
    activeDeviceId: null,
    currentPage: 0,
    currentPageByDevice: {},
    editMode: false,
  },
};

const cardRegistry = new Map();

const gridEl = document.getElementById('control-grid');
const gridOverlayEl = document.getElementById('grid-overlay');
const deviceTabsEl = document.getElementById('device-tabs');
const pageTabsEl = document.getElementById('page-tabs');
const emptyStateEl = document.getElementById('empty-state');
const statusBadgeEl = document.getElementById('bridge-status');
const statusTextEl = document.getElementById('status-text');
const btnSettingsEl = document.getElementById('btn-settings');

syncActiveContext();
setStateRef(state.vmState, state.desktopIcons, state.layoutStore.globalSettings?.soundboardDevice || null);

initEditor(state, {
  commitLayout({ persist = true, rerender = true } = {}) {
    normalizeActiveLayout();
    clampCurrentPage();
    if (persist) persistLayout();
    if (rerender) renderCurrentPage();
  },
  replaceLayout(nextLayout) {
    const deviceId = ensureActiveDeviceId();
    if (!deviceId) return;
    const existing = state.layoutStore.devices[deviceId];
    state.layoutStore.devices[deviceId] = normalizeDeviceLayout(nextLayout, {
      name: existing?.name || prettifyDeviceId(deviceId),
      platform: existing?.platform || 'unknown',
    });
    syncActiveContext();
    applySettings();
    persistLayout();
    renderCurrentPage();
  },
  hideDevice,
  unhideDevice,
  deleteDevice,
  renameDevice,
  setDefaultDevice,
  mergeLayoutStore,
  replaceLayoutStore,
  importIntoDevice,
  openPageSettings() {
    openSettings();
  },
});

initGridEvents(gridEl);
btnSettingsEl.addEventListener('click', () => openSettings());

initSocket({
  getActiveDeviceId: () => state.ui.activeDeviceId,
  onConnect() {},
  onDisconnect() {
    setBridgeStatus({ ...state.bridge, connected: false });
  },
  onDevicesData(devices) {
    applyDevicesSnapshot(devices);
    syncActiveContext();
    renderHeaderState();
  },
  onVmState(deviceId, vmState) {
    const runtime = ensureDeviceRuntime(deviceId);
    runtime.vmState = vmState && typeof vmState === 'object' ? vmState : {};

    if (deviceId === state.ui.activeDeviceId) {
      syncActiveContext();
      refreshAllCards();
    }
  },
  onVmUpdate(deviceId, param, value) {
    const runtime = ensureDeviceRuntime(deviceId);
    runtime.vmState[param] = value;

    if (deviceId === state.ui.activeDeviceId) {
      state.vmState[param] = value;
      cardRegistry.forEach(card => card._updateState?.(param, value));
    }
  },
  onLevels(deviceId, levels) {
    const runtime = ensureDeviceRuntime(deviceId);
    runtime.levels = Array.isArray(levels) ? levels : [];

    if (deviceId === state.ui.activeDeviceId) {
      state.levels = runtime.levels;
      cardRegistry.forEach(card => card._updateLevels?.(state.levels));
    }
  },
  onBridgeError(deviceId, msg) {
    if (!msg) return;
    if (!deviceId || deviceId === state.ui.activeDeviceId) {
      console.warn('Bridge error:', msg);
    } else {
      console.warn(`Bridge error (${deviceId}):`, msg);
    }
  },
  onSoundboardDevices({ deviceId, devices }) {
    if (!deviceId) return;
    const runtime = ensureDeviceRuntime(deviceId);
    runtime.soundboardDevices = Array.isArray(devices) ? devices : [];
    if (deviceId === state.ui.activeDeviceId) {
      updateSoundboardDeviceList(runtime.soundboardDevices);
    }
  },
  onDesktopIcon({ deviceId, target, icon }) {
    if (!deviceId || !target || typeof icon !== 'string') return;
    const runtime = ensureDeviceRuntime(deviceId);
    runtime.desktopIcons[target] = icon;

    if (deviceId === state.ui.activeDeviceId && currentPageHasDesktopTarget(target)) {
      renderCurrentPage();
    }
  },
  onLayout(layoutStore) {
    state.layoutStore = normalizeLayoutStore(layoutStore);
    ensureRuntimeEntriesForLayouts();
    syncActiveContext();
    applySettings();
    requestDesktopIconsForLayout();
    renderCurrentPage();
  },
});

applySettings();
renderCurrentPage();

function createDeviceRuntime(deviceId, patch = {}) {
  return {
    deviceId,
    connected: false,
    deviceName: patch.deviceName || null,
    platform: patch.platform || 'unknown',
    vmType: patch.vmType ?? null,
    vmVersion: patch.vmVersion ?? null,
    capabilities: patch.capabilities || {},
    vmState: patch.vmState || {},
    levels: patch.levels || [],
    desktopIcons: patch.desktopIcons || {},
    soundboardDevices: patch.soundboardDevices || [],
  };
}

function ensureDeviceRuntime(deviceId, patch = {}) {
  if (!deviceId) return createDeviceRuntime('unknown');
  if (!state.devices[deviceId]) {
    state.devices[deviceId] = createDeviceRuntime(deviceId, patch);
  }

  const runtime = state.devices[deviceId];
  if (patch.deviceName) runtime.deviceName = patch.deviceName;
  if (patch.platform) runtime.platform = patch.platform;
  if (patch.vmType !== undefined) runtime.vmType = patch.vmType;
  if (patch.vmVersion !== undefined) runtime.vmVersion = patch.vmVersion;
  if (patch.capabilities) runtime.capabilities = patch.capabilities;
  return runtime;
}

function ensureRuntimeEntriesForLayouts() {
  Object.keys(state.layoutStore.devices || {}).forEach(deviceId => {
    const stored = state.layoutStore.devices[deviceId];
    ensureDeviceRuntime(deviceId, {
      deviceName: stored?.name || null,
      platform: stored?.platform || 'unknown',
    });
  });
}

function applyDevicesSnapshot(devices) {
  ensureRuntimeEntriesForLayouts();

  (Array.isArray(devices) ? devices : []).forEach(device => {
    const deviceId = device?.deviceId;
    if (!deviceId) return;

    ensureDeviceRuntime(deviceId, {
      deviceName: device.deviceName || state.layoutStore.devices[deviceId]?.name || prettifyDeviceId(deviceId),
      platform: device.platform || state.layoutStore.devices[deviceId]?.platform || 'unknown',
      vmType: device.vmType ?? null,
      vmVersion: device.vmVersion ?? null,
      capabilities: device.capabilities || {},
    }).connected = !!device.connected;

    ensureDeviceLayout(deviceId, {
      name: device.deviceName || prettifyDeviceId(deviceId),
      platform: device.platform || 'unknown',
    });
  });
}

function normalizeLayoutStore(layoutStore) {
  if (layoutStore && typeof layoutStore === 'object' && Array.isArray(layoutStore.pages)) {
    return {
      version: '2.0',
      deviceOrder: ['default'],
      devices: {
        default: normalizeDeviceLayout(layoutStore, { name: 'Primary Device', platform: 'unknown' }),
      },
    };
  }

  const raw = layoutStore && typeof layoutStore === 'object' ? layoutStore : {};
  const rawDevices = raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
  const devices = {};
  const deviceOrder = [];

  Object.entries(rawDevices).forEach(([deviceId, deviceLayout]) => {
    if (!deviceId) return;
    devices[deviceId] = normalizeDeviceLayout(deviceLayout, {
      name: deviceLayout?.name || prettifyDeviceId(deviceId),
      platform: deviceLayout?.platform || 'unknown',
    });
    deviceOrder.push(deviceId);
  });

  (Array.isArray(raw.deviceOrder) ? raw.deviceOrder : []).forEach(deviceId => {
    if (devices[deviceId] && !deviceOrder.includes(deviceId)) {
      deviceOrder.push(deviceId);
    }
  });

  if (!deviceOrder.length) {
    deviceOrder.push('default');
    devices.default = normalizeDeviceLayout(DEFAULT_DEVICE_LAYOUT);
  }

  return {
    version: raw.version || '2.0',
    globalSettings: raw.globalSettings && typeof raw.globalSettings === 'object'
      ? { ...raw.globalSettings }
      : {},
    deviceOrder,
    devices,
  };
}

function normalizeDeviceLayout(layout, fallback = {}) {
  const input = layout && typeof layout === 'object' ? layout : {};
  const settings = {
    ...DEFAULT_DEVICE_LAYOUT.settings,
    ...(input.settings || {}),
  };

  const pages = Array.isArray(input.pages) && input.pages.length
    ? input.pages.map((page, pageIndex) => normalizePage(page, pageIndex, settings.gridColumns))
    : DEFAULT_DEVICE_LAYOUT.pages.map((page, pageIndex) => normalizePage(page, pageIndex, settings.gridColumns));

  return {
    name: input.name || fallback.name || 'Device',
    platform: input.platform || fallback.platform || 'unknown',
    hidden: !!input.hidden,
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

function ensureDeviceLayout(deviceId, patch = {}) {
  if (!state.layoutStore.devices[deviceId]) {
    state.layoutStore.devices[deviceId] = normalizeDeviceLayout(null, {
      name: patch.name || prettifyDeviceId(deviceId),
      platform: patch.platform || 'unknown',
    });
  }

  if (!state.layoutStore.deviceOrder.includes(deviceId)) {
    state.layoutStore.deviceOrder.push(deviceId);
  }

  if (patch.name) state.layoutStore.devices[deviceId].name = patch.name;
  if (patch.platform) state.layoutStore.devices[deviceId].platform = patch.platform;

  return state.layoutStore.devices[deviceId];
}

function getKnownDeviceIds() {
  const ids = [];
  (state.layoutStore.deviceOrder || []).forEach(deviceId => {
    if (state.layoutStore.devices[deviceId] && !ids.includes(deviceId)) ids.push(deviceId);
  });
  Object.keys(state.layoutStore.devices || {}).forEach(deviceId => {
    if (!ids.includes(deviceId)) ids.push(deviceId);
  });
  Object.keys(state.devices || {}).forEach(deviceId => {
    if (!ids.includes(deviceId)) ids.push(deviceId);
  });
  return ids;
}

function isDeviceHidden(deviceId) {
  return !!state.layoutStore.devices[deviceId]?.hidden;
}

function ensureActiveDeviceId() {
  const allIds = getKnownDeviceIds();
  // Visible devices only (hidden ones are not selectable as active)
  const deviceIds = allIds.filter(id => !isDeviceHidden(id));

  if (!deviceIds.length) {
    state.ui.activeDeviceId = null;
    return null;
  }

  // If current selection is still visible, keep it
  if (state.ui.activeDeviceId && deviceIds.includes(state.ui.activeDeviceId)) {
    return state.ui.activeDeviceId;
  }

  // Current device became hidden — clear it so we pick a new one
  state.ui.activeDeviceId = null;

  // Prefer user-selected default device (if visible)
  const preferredId = state.layoutStore.globalSettings?.defaultDeviceId;
  if (preferredId && deviceIds.includes(preferredId)) {
    state.ui.activeDeviceId = preferredId;
    return preferredId;
  }

  const firstConnected = deviceIds.find(id => state.devices[id]?.connected);
  state.ui.activeDeviceId = firstConnected || deviceIds[0];
  return state.ui.activeDeviceId;
}

function syncActiveContext() {
  const activeDeviceId = ensureActiveDeviceId();
  if (!activeDeviceId) {
    state.layout = normalizeDeviceLayout(DEFAULT_DEVICE_LAYOUT);
    state.vmState = {};
    state.desktopIcons = {};
    state.levels = [];
    state.bridge = createDeviceRuntime('none');
    setStateRef(state.vmState, state.desktopIcons, state.layoutStore.globalSettings?.soundboardDevice || null);
    return;
  }

  const runtime = ensureDeviceRuntime(activeDeviceId, {
    deviceName: state.layoutStore.devices[activeDeviceId]?.name || prettifyDeviceId(activeDeviceId),
    platform: state.layoutStore.devices[activeDeviceId]?.platform || 'unknown',
  });
  const deviceLayout = ensureDeviceLayout(activeDeviceId, {
    name: runtime.deviceName || prettifyDeviceId(activeDeviceId),
    platform: runtime.platform || 'unknown',
  });

  state.layout = deviceLayout;
  state.vmState = runtime.vmState;
  state.desktopIcons = runtime.desktopIcons;
  state.levels = runtime.levels;
  state.bridge = runtime;
  state.ui.currentPage = state.ui.currentPageByDevice[activeDeviceId] || 0;

  clampCurrentPage();
  setStateRef(state.vmState, state.desktopIcons, state.layoutStore.globalSettings?.soundboardDevice || null);
}

function normalizeActiveLayout() {
  const deviceId = ensureActiveDeviceId();
  if (!deviceId) return;

  const existing = state.layoutStore.devices[deviceId];
  state.layoutStore.devices[deviceId] = normalizeDeviceLayout(state.layout, {
    name: existing?.name || state.bridge.deviceName || prettifyDeviceId(deviceId),
    platform: existing?.platform || state.bridge.platform || 'unknown',
  });
  state.layout = state.layoutStore.devices[deviceId];
  setStateRef(state.vmState, state.desktopIcons, state.layoutStore.globalSettings?.soundboardDevice || null);
}

function switchDevice(deviceId) {
  if (!deviceId || deviceId === state.ui.activeDeviceId) return;

  if (state.ui.activeDeviceId) {
    state.ui.currentPageByDevice[state.ui.activeDeviceId] = state.ui.currentPage;
  }

  state.ui.activeDeviceId = deviceId;
  syncActiveContext();
  applySettings();
  requestDesktopIconsForLayout();
  requestState(deviceId);
  renderCurrentPage();
}

function hideDevice(deviceId) {
  const device = state.layoutStore.devices[deviceId];
  if (!device) return;
  device.hidden = true;
  // If this was the active device, switch away
  if (deviceId === state.ui.activeDeviceId) {
    state.ui.activeDeviceId = null;
    syncActiveContext();
  }
  persistLayout();
  renderCurrentPage();
}

function unhideDevice(deviceId) {
  const device = state.layoutStore.devices[deviceId];
  if (!device) return;
  device.hidden = false;
  persistLayout();
  renderHeaderState();
}

function deleteDevice(deviceId) {
  if (!deviceId || !state.layoutStore.devices[deviceId]) return;
  const wasActive = deviceId === state.ui.activeDeviceId;
  delete state.layoutStore.devices[deviceId];
  state.layoutStore.deviceOrder = state.layoutStore.deviceOrder.filter(id => id !== deviceId);
  delete state.devices[deviceId];
  if (state.layoutStore.globalSettings?.defaultDeviceId === deviceId) {
    state.layoutStore.globalSettings.defaultDeviceId = null;
  }
  if (wasActive) {
    state.ui.activeDeviceId = null;
    syncActiveContext();
  }
  persistLayout();
  renderCurrentPage();
}

function renameDevice(deviceId, name) {
  const trimmed = (name || '').trim();
  if (!deviceId || !trimmed) return;
  if (state.layoutStore.devices[deviceId]) {
    state.layoutStore.devices[deviceId].name = trimmed;
  }
  if (state.devices[deviceId]) {
    state.devices[deviceId].deviceName = trimmed;
  }
  persistLayout();
  renderHeaderState();
}

function setDefaultDevice(deviceId) {
  if (!state.layoutStore.globalSettings) state.layoutStore.globalSettings = {};
  state.layoutStore.globalSettings.defaultDeviceId = deviceId || null;
  persistLayout();
}

function mergeLayoutStore(imported) {
  const normalized = normalizeLayoutStore(imported);
  Object.entries(normalized.devices || {}).forEach(([deviceId, deviceLayout]) => {
    state.layoutStore.devices[deviceId] = deviceLayout;
    if (!state.layoutStore.deviceOrder.includes(deviceId)) {
      state.layoutStore.deviceOrder.push(deviceId);
    }
  });
  ensureRuntimeEntriesForLayouts();
  syncActiveContext();
  applySettings();
  requestDesktopIconsForLayout();
  persistLayout();
  renderCurrentPage();
}

function replaceLayoutStore(imported) {
  const normalized = normalizeLayoutStore(imported);
  // Preserve globalSettings (user prefs shouldn't be wiped by import)
  normalized.globalSettings = {
    ...(normalized.globalSettings || {}),
    ...state.layoutStore.globalSettings,
  };
  state.layoutStore = normalized;
  state.devices = {};
  state.ui.activeDeviceId = null;
  ensureRuntimeEntriesForLayouts();
  syncActiveContext();
  applySettings();
  requestDesktopIconsForLayout();
  persistLayout();
  renderCurrentPage();
}

function importIntoDevice(deviceId, singleDeviceLayout, overrideName) {
  const existingName = state.layoutStore.devices[deviceId]?.name
    || overrideName
    || prettifyDeviceId(deviceId);
  const existingPlatform = state.layoutStore.devices[deviceId]?.platform || 'unknown';
  const deviceLayout = normalizeDeviceLayout(singleDeviceLayout, {
    name: existingName,
    platform: existingPlatform,
  });
  if (overrideName) deviceLayout.name = overrideName;
  state.layoutStore.devices[deviceId] = deviceLayout;
  if (!state.layoutStore.deviceOrder.includes(deviceId)) {
    state.layoutStore.deviceOrder.push(deviceId);
  }
  ensureRuntimeEntriesForLayouts();
  syncActiveContext();
  applySettings();
  requestDesktopIconsForLayout();
  persistLayout();
  renderCurrentPage();
}

function renderHeaderState() {
  renderDeviceTabs();
  setBridgeStatus(state.bridge);
}

function renderCurrentPage() {
  clampCurrentPage();
  applySettings();
  renderHeaderState();
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

function renderDeviceTabs() {
  deviceTabsEl.innerHTML = '';

  getKnownDeviceIds().forEach(deviceId => {
    if (isDeviceHidden(deviceId)) return; // hidden devices don't appear in the tab bar
    const runtime = ensureDeviceRuntime(deviceId);
    const deviceLayout = state.layoutStore.devices[deviceId];
    const platform = runtime.platform && runtime.platform !== 'unknown'
      ? runtime.platform
      : deviceLayout?.platform || 'unknown';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `device-tab${deviceId === state.ui.activeDeviceId ? ' active' : ''}${runtime.connected ? '' : ' offline'}`;
    tab.title = `${runtime.deviceName || deviceLayout?.name || prettifyDeviceId(deviceId)}${runtime.connected ? '' : ' (offline)'}`;

    const dot = document.createElement('span');
    dot.className = 'device-tab-dot';

    const textWrap = document.createElement('span');
    textWrap.className = 'device-tab-text';

    const name = document.createElement('span');
    name.className = 'device-tab-name';
    name.textContent = runtime.deviceName || deviceLayout?.name || prettifyDeviceId(deviceId);

    const meta = document.createElement('span');
    meta.className = 'device-tab-meta';
    meta.textContent = platformLabel(platform);

    textWrap.appendChild(name);
    textWrap.appendChild(meta);
    tab.appendChild(dot);
    tab.appendChild(textWrap);
    tab.addEventListener('click', () => switchDevice(deviceId));
    deviceTabsEl.appendChild(tab);
  });
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
      state.ui.currentPageByDevice[state.ui.activeDeviceId] = index;
      renderCurrentPage();
    });
    tab.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        state.ui.currentPage = index;
        state.ui.currentPageByDevice[state.ui.activeDeviceId] = index;
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

function requestDesktopIconsForLayout() {
  const canResolveIcons = !!state.bridge.capabilities?.desktopIcons;
  if (!canResolveIcons) return;

  const targets = new Set();
  (state.layout.pages || []).forEach(page => {
    (page.controls || []).forEach(control => {
      if (control.type !== 'desktop_action') return;
      const target = control.config?.target?.trim();
      const action = control.config?.action;
      if (action !== 'launch' || !target) return;
      if (state.desktopIcons[target]) return;
      targets.add(target);
    });
  });

  targets.forEach(target => requestDesktopIcon(target));
}

function currentPageHasDesktopTarget(target) {
  return (getCurrentPage()?.controls || []).some(control =>
    control.type === 'desktop_action' && control.config?.target === target
  );
}

function renderGridOverlay(rows) {
  const cols = state.layout.settings.gridColumns || DEFAULT_DEVICE_LAYOUT.settings.gridColumns;
  gridOverlayEl.innerHTML = '';

  for (let i = 0; i < cols * rows; i += 1) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    gridOverlayEl.appendChild(cell);
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
  if (!state.ui.activeDeviceId) {
    statusTextEl.textContent = 'No Device';
    return;
  }

  if (!online) {
    statusTextEl.textContent = 'Offline';
    return;
  }

  statusTextEl.textContent = state.bridge.capabilities?.voiceMeeter
    ? vmNames[state.bridge.vmType] || 'Connected'
    : state.bridge.deviceName || platformLabel(state.bridge.platform);
}

function persistLayout() {
  normalizeActiveLayout();
  saveLayout(state.layoutStore);
}

function getCurrentPage() {
  clampCurrentPage();
  return state.layout.pages[state.ui.currentPage];
}

function clampCurrentPage() {
  const maxIndex = Math.max(0, state.layout.pages.length - 1);
  state.ui.currentPage = clampInt(state.ui.currentPage, 0, maxIndex);
  if (state.ui.activeDeviceId) {
    state.ui.currentPageByDevice[state.ui.activeDeviceId] = state.ui.currentPage;
  }
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

function applySettings() {
  const settings = state.layout.settings || DEFAULT_DEVICE_LAYOUT.settings;
  const accent = settings.accentColor || DEFAULT_DEVICE_LAYOUT.settings.accentColor;
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

function platformLabel(platform) {
  const labels = {
    darwin: 'macOS',
    macos: 'macOS',
    win32: 'Windows',
    windows: 'Windows',
    linux: 'Linux',
    unknown: 'Unknown',
  };
  return labels[String(platform || 'unknown').toLowerCase()] || prettifyDeviceId(platform || 'unknown');
}

function prettifyDeviceId(deviceId) {
  return String(deviceId || 'device')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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
