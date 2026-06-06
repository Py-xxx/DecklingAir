import { initSocket, requestDesktopIcon, requestState, saveLayout, requestSoundboardDevices } from './socket.js';
import { renderControl, setStateRef, resolveRect, defaultSizeForType, minSizeForType, SNAP } from './controls.js';
import {
  initEditor,
  initGridEvents,
  openPageNameModal,
  openSettings,
  updateSoundboardDeviceList,
  updateSpotifySettingsStatus,
} from './editor.js';
import { updateSpotifyPlaylists, updateSpotifyQueue, updateSpotifyStats } from './spotify-controls.js';

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
    primaryColor: '#090910',
    secondaryColor: '#181828',
    panelOpacity: 1,
    fitToScreen: false,
    backgroundImage: null,
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

const state = {
  layoutStore: normalizeLayoutStore(DEFAULT_LAYOUT_STORE),
  layout: normalizeDeviceLayout(DEFAULT_DEVICE_LAYOUT),
  devices: {},
  vmState: {},
  desktopIcons: {},
  levels: [],
  bridge: createDeviceRuntime('default'),
  spotifyState: null,
  spotifyAuthStatus: null,
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

// Keep the fit-to-screen canvas scaled to the viewport on resize.
window.addEventListener('resize', () => {
  if (state.layout?.settings?.fitToScreen) applyFitScale();
});

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
  onSpotifyState(spotifyState) {
    state.spotifyState = spotifyState;
    cardRegistry.forEach(card => card._updateSpotify?.(spotifyState));
  },
  onSpotifyAuthStatus(status) {
    state.spotifyAuthStatus = status;
    updateSpotifySettingsStatus(status);
  },
  onSpotifySearchResults(data) {
    cardRegistry.forEach(card => card._updateSpotifySearch?.(data));
  },
  onSpotifyPlaylists(data) {
    updateSpotifyPlaylists(data);
  },
  onSpotifyQueue(data) {
    updateSpotifyQueue(data);
  },
  onSpotifyStats(data) {
    updateSpotifyStats(data);
  },
  onSpotifyToast(msg) {
    showSpotifyToast(typeof msg === 'string' ? msg : (msg?.message || ''));
  },
  onSpotifyError(err) {
    const message = typeof err === 'string' ? err : (err?.message || 'Spotify error');
    showSpotifyToast(message, true);
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

  // Resolve a pixel rect: prefer explicit x/y/w/h, else migrate legacy grid
  // coords, else fall back to the type default size.
  let rect;
  if (Number.isFinite(rawControl.x) && Number.isFinite(rawControl.w)) {
    rect = resolveRect(rawControl);
  } else if (Number.isFinite(rawControl.col) || Number.isFinite(rawControl.row)) {
    rect = resolveRect(rawControl);
  } else {
    rect = { x: NaN, y: NaN, ...defaultSizeForType(type) };
  }

  const min = minSizeForType(type);
  let w = Math.max(min.w, Math.round(rect.w));
  let h = Math.max(min.h, Math.round(rect.h));
  let x = Number.isFinite(rect.x) ? Math.max(0, Math.round(rect.x)) : NaN;
  let y = Number.isFinite(rect.y) ? Math.max(0, Math.round(rect.y)) : NaN;

  if (!Number.isFinite(x) || !Number.isFinite(y) || collides(existingControls, { x, y, w, h })) {
    const slot = findNextOpenSlot(existingControls, { w, h });
    x = slot.x;
    y = slot.y;
  }

  return {
    id: rawControl.id || `ctrl_${controlIndex + 1}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    x,
    y,
    w,
    h,
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

  emptyStateEl.style.display = controls.length ? 'none' : 'flex';

  controls.forEach(control => {
    const card = renderControl(control, state.vmState);
    if (!card) return;
    gridEl.appendChild(card);
    cardRegistry.set(control.id, card);
    if (state.levels.length) card._updateLevels?.(state.levels);
    if (state.spotifyState) card._updateSpotify?.(state.spotifyState);
  });

  updateCanvasMetrics();
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

const CANVAS_BASE_W = 1280;
const CANVAS_BASE_H = 720;
const CANVAS_MARGIN = 40;

/**
 * Size the design canvas to wrap its content and, when fit-to-screen is on,
 * scale the whole canvas to fill the viewport (the "slide" model).
 */
function updateCanvasMetrics() {
  const page = getCurrentPage();
  const controls = page?.controls || [];

  let maxRight = 0;
  let maxBottom = 0;
  controls.forEach(control => {
    const rect = resolveRect(control);
    maxRight = Math.max(maxRight, rect.x + rect.w);
    maxBottom = Math.max(maxBottom, rect.y + rect.h);
  });

  const settings = state.layout.settings || {};
  const baseW = settings.canvasWidth || CANVAS_BASE_W;
  const baseH = settings.canvasHeight || CANVAS_BASE_H;
  const fit = !!settings.fitToScreen;

  const canvasW = fit ? Math.max(baseW, maxRight) : Math.max(baseW, maxRight + CANVAS_MARGIN);
  const canvasH = fit ? Math.max(baseH, maxBottom) : Math.max(baseH, maxBottom + CANVAS_MARGIN);

  gridEl.style.setProperty('--canvas-w', `${canvasW}px`);
  gridEl.style.setProperty('--canvas-h', `${canvasH}px`);

  document.body.classList.toggle('fit-screen', fit);
  applyFitScale(canvasW, canvasH);
}

function applyFitScale(canvasW, canvasH) {
  const fit = !!state.layout.settings?.fitToScreen;
  if (!fit) {
    gridEl.style.setProperty('--canvas-scale', '1');
    return;
  }
  const main = document.getElementById('main-area');
  if (!main) return;
  const w = canvasW || parseFloat(gridEl.style.getPropertyValue('--canvas-w')) || CANVAS_BASE_W;
  const h = canvasH || parseFloat(gridEl.style.getPropertyValue('--canvas-h')) || CANVAS_BASE_H;
  const scale = Math.min(main.clientWidth / w, main.clientHeight / h) || 1;
  gridEl.style.setProperty('--canvas-scale', String(scale));
}

function refreshAllCards() {
  cardRegistry.forEach(card => {
    Object.entries(state.vmState).forEach(([param, value]) => {
      card._updateState?.(param, value);
    });
    if (state.levels.length) card._updateLevels?.(state.levels);
  });
}

function showSpotifyToast(message, isError = false) {
  if (!message) return;
  const toast = document.createElement('div');
  toast.className = `sp-toast${isError ? ' sp-toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  // Trigger enter animation
  requestAnimationFrame(() => toast.classList.add('sp-toast-visible'));
  window.setTimeout(() => {
    toast.classList.remove('sp-toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal in case transition doesn't fire
    window.setTimeout(() => toast.remove(), 500);
  }, 2500);
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

function findNextOpenSlot(existingControls, size) {
  const stepX = Math.max(SNAP, 40);
  const stepY = Math.max(SNAP, 40);
  const maxW = (state.layout.settings?.canvasWidth || CANVAS_BASE_W);

  for (let y = 0; y <= 4000; y += stepY) {
    for (let x = 0; x + size.w <= Math.max(maxW, size.w) ; x += stepX) {
      const candidate = { x, y, w: size.w, h: size.h };
      if (!collides(existingControls, candidate)) {
        return candidate;
      }
    }
  }

  return { x: 0, y: 0, w: size.w, h: size.h };
}

function collides(controls, candidate, ignoreId = null) {
  return controls.some(control => {
    if (ignoreId && control.id === ignoreId) return false;
    return rectsOverlap(resolveRect(control), candidate);
  });
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

const DEFAULT_PRIMARY = '#090910';
const DEFAULT_SECONDARY = '#181828';

function applySettings() {
  const settings = state.layout.settings || DEFAULT_DEVICE_LAYOUT.settings;
  const accent = settings.accentColor || DEFAULT_DEVICE_LAYOUT.settings.accentColor;

  state.layout.settings.accentColor = accent;

  setAccentColor(accent);
  setPrimaryColor(settings.primaryColor || DEFAULT_PRIMARY);
  setSecondaryColor(settings.secondaryColor || DEFAULT_SECONDARY);
  setPanelOpacity(settings.panelOpacity);
  setBackgroundImage(settings.backgroundImage);
}

function setAccentColor(hex) {
  const rgb = hexToRgb(hex) || { r: 108, g: 99, b: 255 };
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`);
}

// Primary colour drives the page background plus two derived shades.
function setPrimaryColor(hex) {
  const rgb = hexToRgb(hex) || { r: 9, g: 9, b: 16 };
  document.documentElement.style.setProperty('--bg', hex);
  document.documentElement.style.setProperty('--bg-2', shade(rgb, 1.5));
  document.documentElement.style.setProperty('--bg-3', shade(rgb, 2.4));
  document.documentElement.style.setProperty('--text', isLight(rgb) ? '#15151c' : '#e8e8f0');
}

// Secondary colour drives panel/surface backgrounds.
function setSecondaryColor(hex) {
  const rgb = hexToRgb(hex) || { r: 24, g: 24, b: 40 };
  document.documentElement.style.setProperty('--surface-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  document.documentElement.style.setProperty('--surface-solid', hex);
}

function setPanelOpacity(value) {
  const op = Number.isFinite(value) ? Math.min(1, Math.max(0.2, value)) : 1;
  document.documentElement.style.setProperty('--panel-opacity', String(op));
}

function setBackgroundImage(path) {
  const url = path ? `url("${path}")` : 'none';
  document.documentElement.style.setProperty('--bg-image', url);
  document.body.classList.toggle('has-bg-image', !!path);
}

// Lighten an rgb toward white by a small factor (>=1 lightens).
function shade(rgb, factor) {
  const mix = (c) => Math.round(Math.min(255, c + (255 - c) * 0.05 * factor));
  return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
}

function isLight(rgb) {
  // Perceived luminance.
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) > 150;
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
