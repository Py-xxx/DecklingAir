import {
  VM_STRIPS,
  VM_BUSES,
  buildParamOptions,
  resolveRect,
  minSizeForType,
  SNAP,
  LEGACY_COL_W,
  LEGACY_ROW_H,
  LEGACY_GAP,
} from './controls.js';
import { vmMacro, requestSoundboardDevices, socket } from './socket.js';
import { saveSpotifyConfig, disconnectSpotify, saveLastfmKey, getLastfmStatus, setSpotifyFeaturesEnabled, getSpotifyFeaturesEnabled } from './spotify-client.js';

// Convert the size-picker's colSpan/rowSpan choice into a pixel size,
// clamped up to the type's minimum footprint.
function pickerToPixelSize(type) {
  const colSpan = Math.max(1, _selectedSize.colSpan || 1);
  const rowSpan = Math.max(1, _selectedSize.rowSpan || 1);
  const min = minSizeForType(type);
  return {
    w: Math.max(min.w, colSpan * LEGACY_COL_W + (colSpan - 1) * LEGACY_GAP),
    h: Math.max(min.h, rowSpan * LEGACY_ROW_H + (rowSpan - 1) * LEGACY_GAP),
  };
}

const VM_ONLY_TYPES = new Set([
  'fader',
  'toggle',
  'button',
  'macro',
  'vu_meter',
  'strip_panel',
  'bus_panel',
]);

let _state = null;
let _callbacks = {};
let _editingId = null;
let _selectedType = null;
let _selectedSize = { colSpan: 1, rowSpan: 2 };
let _pageEditIndex = null;
let _gridGesture = null;
let _importParsed = null;
// Pending background change while the settings modal is open:
//   undefined = unchanged, null = cleared, string = new uploaded path.
let _pendingBg = undefined;

const previewEl = document.getElementById('drop-preview');
const mainAreaEl = document.getElementById('main-area');

/**
 * Called from app.js whenever the active bridge sends back a soundboard device list.
 * Repopulates the device dropdown while preserving the current selection.
 */
export function updateSoundboardDeviceList(devices) {
  // Update the per-button control editor dropdown
  _repopulateSoundboardSelect('cfg-soundboard-device', devices, 'Use global default (Settings → Soundboard)');
  // Also update the global settings dropdown if it's open
  _repopulateSoundboardSelect('s-soundboard-device', devices, 'System default');
}

function _repopulateSoundboardSelect(selectId, devices, defaultLabel) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = `<option value="">${defaultLabel}</option>`;
  (devices || []).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.name;
    opt.textContent = d.name;
    select.appendChild(opt);
  });
  if (currentValue) {
    select.value = currentValue;
    // Preserve saved value even if it's not in the refreshed list
    if (!select.value) {
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.textContent = currentValue;
      select.appendChild(opt);
      select.value = currentValue;
    }
  }
}

/**
 * Called from app.js when Spotify auth status changes so the settings
 * panel always shows the current state (even if it's already open).
 */
export function updateSpotifySettingsStatus(status) {
  const statusEl = document.getElementById('s-spotify-status');
  const statusTextEl = document.getElementById('s-spotify-status-text');
  const connectBtn = document.getElementById('s-spotify-connect');
  const disconnectBtn = document.getElementById('s-spotify-disconnect');
  const reauthBanner = document.getElementById('s-spotify-reauth-banner');

  if (!statusEl) return; // Settings panel not yet in DOM

  const connected = !!(status?.connected);
  statusEl.classList.toggle('spotify-status-connected', connected);
  statusTextEl.textContent = connected
    ? (status.displayName ? `Connected as ${status.displayName}` : 'Connected')
    : (status?.configured ? 'Configured — not connected' : 'Not connected');

  if (connectBtn)    connectBtn.style.display    = connected ? 'none'  : '';
  if (disconnectBtn) disconnectBtn.style.display = connected ? ''      : 'none';

  // Show reauth warning when connected but token is missing required scopes
  if (reauthBanner) {
    reauthBanner.style.display = (connected && status?.needsReauth) ? '' : 'none';
  }
}

export function initEditor(state, callbacks) {
  _state = state;
  _callbacks = callbacks;

  populateParamDropdown('cfg-fader-param', buildParamOptions(true));
  populateParamDropdown('cfg-toggle-param', buildParamOptions(false));
  populateStripBusSources();
  buildSizePicker();

  document.querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      selectType(card.dataset.type);
    });
  });

  // Add-Control category tabs (Voicemeeter / Spotify / Other)
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTypeTab(tab.dataset.tab));
  });

  document.getElementById('fab-add').addEventListener('click', () => openModal(null));
  document.getElementById('btn-edit').addEventListener('click', toggleEditMode);

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-save').addEventListener('click', saveControl);
  document.getElementById('modal-back').addEventListener('click', showTypeStep);
  document.getElementById('modal-backdrop').addEventListener('click', event => {
    if (event.target === document.getElementById('modal-backdrop')) closeModal();
  });

  document.getElementById('btn-add-macro-action').addEventListener('click', () => addMacroAction());
  document.getElementById('cfg-desktop-kind').addEventListener('change', updateDesktopActionFields);

  document.getElementById('cfg-soundboard-browse').addEventListener('click', () => _fbOpen());
  document.getElementById('cfg-soundboard-refresh').addEventListener('click', () => {
    requestSoundboardDevicesForEditor();
  });
  document.getElementById('s-soundboard-refresh').addEventListener('click', () => {
    requestSoundboardDevicesForEditor();
  });
  // Settings → pick the default soundboard browse folder
  document.getElementById('s-soundboard-default-dir-browse')?.addEventListener('click', () => {
    const input = document.getElementById('s-soundboard-default-dir');
    _fbOpen({
      mode: 'folder',
      startPath: input?.value.trim() || '',
      onPick: (path) => { if (input) input.value = path; },
    });
  });
  document.getElementById('cfg-soundboard-volume').addEventListener('input', () => {
    document.getElementById('cfg-soundboard-volume-display').textContent =
      document.getElementById('cfg-soundboard-volume').value + '%';
  });

  // Spotify settings handlers
  document.getElementById('s-spotify-connect').addEventListener('click', () => {
    const clientId = document.getElementById('s-spotify-client-id').value.trim();
    const clientSecret = document.getElementById('s-spotify-client-secret').value.trim();
    if (!clientId || !clientSecret) {
      window.alert('Please enter a Client ID and Client Secret first.');
      return;
    }
    saveSpotifyConfig(clientId, clientSecret);
    // Small delay so server can save config before we open the auth URL
    window.setTimeout(() => {
      window.open('/api/spotify/auth', 'spotify-auth', 'width=500,height=700,noopener');
    }, 250);
  });
  document.getElementById('s-spotify-disconnect').addEventListener('click', () => {
    if (!window.confirm('Disconnect Spotify? This will stop playback state updates.')) return;
    disconnectSpotify();
  });

  // Last.fm API key (Genres tab genre source)
  document.getElementById('s-lastfm-save')?.addEventListener('click', () => {
    const inp = document.getElementById('s-lastfm-key');
    const key = (inp?.value || '').trim();
    saveLastfmKey(key);
    const st = document.getElementById('s-lastfm-status');
    if (st) st.textContent = key ? 'Saved ✓ — building genre profile…' : 'Cleared';
    if (inp) inp.value = '';
  });

  // Master Spotify kill-switch — off ⇒ server stops ALL Spotify/ReccoBeats/Last.fm
  // traffic. Dim + disable the rest of the Spotify settings when off.
  const spotifyEnabledEl = document.getElementById('s-spotify-enabled');
  const _reflectSpotifyEnabled = (enabled) => {
    if (spotifyEnabledEl) spotifyEnabledEl.checked = !!enabled;
    const controls = document.getElementById('s-spotify-controls');
    if (controls) {
      controls.style.opacity = enabled ? '' : '0.45';
      controls.style.pointerEvents = enabled ? '' : 'none';
    }
  };
  spotifyEnabledEl?.addEventListener('change', () => {
    setSpotifyFeaturesEnabled(spotifyEnabledEl.checked);
    _reflectSpotifyEnabled(spotifyEnabledEl.checked);
  });
  socket.on('spotify:features_enabled', ({ enabled } = {}) => _reflectSpotifyEnabled(enabled));

  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-apply').addEventListener('click', applySettings);

  const bgInput = document.getElementById('s-bg-image');
  if (bgInput) bgInput.addEventListener('change', handleBackgroundUpload);
  const bgClear = document.getElementById('s-bg-clear');
  if (bgClear) bgClear.addEventListener('click', () => {
    _pendingBg = null;
    updateBgPreview(null);
  });
  document.getElementById('settings-modal').addEventListener('click', event => {
    if (event.target === document.getElementById('settings-modal')) closeSettings();
  });
  document.getElementById('s-add-page').addEventListener('click', () => openPageNameModal(null));
  document.getElementById('s-export').addEventListener('click', exportLayout);
  document.getElementById('s-import').addEventListener('click', () => {
    document.getElementById('s-import-file').click();
  });
  document.getElementById('s-import-file').addEventListener('change', openImportModal);

  document.getElementById('import-modal-close').addEventListener('click', closeImportModal);
  document.getElementById('import-modal-cancel').addEventListener('click', closeImportModal);
  document.getElementById('import-modal-apply').addEventListener('click', applyImport);
  document.getElementById('import-modal').addEventListener('click', event => {
    if (event.target === document.getElementById('import-modal')) closeImportModal();
  });

  document.getElementById('s-default-device').addEventListener('change', event => {
    _callbacks.setDefaultDevice?.(event.target.value || null);
  });
  document.getElementById('s-vm-restart').addEventListener('click', () => {
    vmMacro([{ param: 'Command.Restart', value: 1 }]);
  });

  document.getElementById('page-modal-close').addEventListener('click', closePageModal);
  document.getElementById('page-modal-cancel').addEventListener('click', closePageModal);
  document.getElementById('page-modal-save').addEventListener('click', savePageName);
  document.getElementById('page-modal').addEventListener('click', event => {
    if (event.target === document.getElementById('page-modal')) closePageModal();
  });
  document.getElementById('page-name-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') savePageName();
  });
}

export function toggleEditMode() {
  _state.ui.editMode = !_state.ui.editMode;
  document.body.classList.toggle('edit-mode', _state.ui.editMode);
  document.getElementById('btn-edit').classList.toggle('active', _state.ui.editMode);
  document.getElementById('fab-add').style.display = _state.ui.editMode ? 'flex' : 'none';
  _callbacks.commitLayout?.({ persist: false, rerender: true });
}

export function initGridEvents(gridEl) {
  gridEl.addEventListener('click', event => {
    const editButton = event.target.closest('[data-action="edit"]');
    const deleteButton = event.target.closest('[data-action="delete"]');

    if (editButton) {
      event.stopPropagation();
      openModal(editButton.dataset.ctrlId);
      return;
    }

    if (deleteButton) {
      event.stopPropagation();
      deleteControl(deleteButton.dataset.ctrlId);
    }
  });

  gridEl.addEventListener('pointerdown', event => {
    const dragHandle = event.target.closest('.drag-handle');
    const resizeHandle = event.target.closest('.resize-handle');
    if (!_state.ui.editMode || (!dragHandle && !resizeHandle)) return;

    const card = event.target.closest('.control-card');
    if (!card) return;

    startGridGesture({
      mode: resizeHandle ? 'resize' : 'move',
      event,
      gridEl,
      card,
    });
  });
}

export function openModal(controlId) {
  _editingId = controlId;
  resetModal();
  updateTypeAvailability();

  if (controlId) {
    const control = findControl(controlId);
    if (!control) return;

    _selectedType = control.type;
    _selectedSize = {
      colSpan: control.colSpan || 1,
      rowSpan: control.rowSpan || 1,
    };

    highlightSelectedType(control.type);
    updateSizePicker();
    populateModal(control);
    showConfigStep(true);
    document.getElementById('modal-title').textContent = 'Edit Control';
  } else {
    document.getElementById('modal-title').textContent = 'Add Control';
    showTypeStep();
  }

  document.getElementById('modal-backdrop').style.display = 'flex';
}

export function openSettings() {
  const settings = _state.layout.settings || {};
  const bridge = _state.bridge || {};
  const hasVoiceMeeter = !!bridge.capabilities?.voiceMeeter;
  const restartButton = document.getElementById('s-vm-restart');

  document.getElementById('s-accent-color').value = settings.accentColor || '#6c63ff';
  setIfPresent('s-primary-color', settings.primaryColor || '#090910');
  setIfPresent('s-secondary-color', settings.secondaryColor || '#181828');
  setIfPresent('s-panel-opacity', String(Number.isFinite(settings.panelOpacity) ? settings.panelOpacity : 1));
  const fitEl = document.getElementById('s-fit-screen');
  if (fitEl) fitEl.checked = !!settings.fitToScreen;
  updateBgPreview(settings.backgroundImage || null);
  _pendingBg = undefined;
  restartButton.disabled = !hasVoiceMeeter;
  restartButton.textContent = hasVoiceMeeter ? 'Restart Audio Engine' : 'No Mixer Available';

  // Soundboard global device
  const globalDevice = _state.layoutStore?.globalSettings?.soundboardDevice || '';
  const sbSelect = document.getElementById('s-soundboard-device');
  if (sbSelect) {
    sbSelect.innerHTML = '<option value="">System default</option>';
    if (globalDevice) {
      const opt = document.createElement('option');
      opt.value = globalDevice;
      opt.textContent = globalDevice;
      sbSelect.appendChild(opt);
      sbSelect.value = globalDevice;
    }
  }
  // Default browse folder
  const defaultDirEl = document.getElementById('s-soundboard-default-dir');
  if (defaultDirEl) defaultDirEl.value = _state.layoutStore?.globalSettings?.soundboardDefaultDir || '';

  // Request fresh device list from bridge (populates dropdown when response arrives)
  requestSoundboardDevicesForEditor();

  renderDeviceManagementList();
  renderDefaultDeviceDropdown();
  renderPagesList();
  updateSpotifySettingsStatus(_state.spotifyAuthStatus || null);
  // Reflect the master features switch (server is the source of truth).
  getSpotifyFeaturesEnabled();
  // Reflect whether a Last.fm key is already saved (don't echo the secret back).
  getLastfmStatus().then(({ hasKey }) => {
    const st = document.getElementById('s-lastfm-status');
    const inp = document.getElementById('s-lastfm-key');
    if (st) st.textContent = hasKey ? '✓ Key saved' : '';
    if (inp) inp.placeholder = hasKey ? '•••••••• saved — enter to replace' : 'Last.fm API key';
  }).catch(() => {});
  document.getElementById('settings-modal').style.display = 'flex';
}

export function openPageNameModal(index) {
  _pageEditIndex = index;
  const isEdit = Number.isInteger(index);
  document.getElementById('page-modal-title').textContent = isEdit ? 'Rename Page' : 'Add Page';
  document.getElementById('page-name-input').value = isEdit ? _state.layout.pages[index]?.name || '' : '';
  document.getElementById('page-modal').style.display = 'flex';
  window.setTimeout(() => document.getElementById('page-name-input').focus(), 20);
}

function resetModal() {
  _selectedType = null;
  _selectedSize = { colSpan: 1, rowSpan: 2 };

  document.querySelectorAll('.type-card').forEach(card => card.classList.remove('selected'));
  document.querySelectorAll('.cfg-section').forEach(section => {
    section.style.display = 'none';
  });

  document.getElementById('cfg-label').value = '';
  document.getElementById('cfg-fader-param').selectedIndex = 0;
  document.getElementById('cfg-fader-min').value = '-60';
  document.getElementById('cfg-fader-max').value = '12';
  document.getElementById('cfg-fader-step').value = '0.1';
  document.getElementById('cfg-fader-vu').checked = true;

  document.getElementById('cfg-toggle-param').selectedIndex = 0;
  document.getElementById('cfg-toggle-color').value = '#6c63ff';
  document.getElementById('cfg-toggle-momentary').checked = false;

  document.getElementById('cfg-macro-color').value = '#ff9800';
  document.getElementById('cfg-macro-momentary').checked = false;
  document.getElementById('macro-actions-list').innerHTML = '';

  document.getElementById('cfg-desktop-kind').value = 'launch';
  document.getElementById('cfg-desktop-color').value = '#3aa6ff';
  document.getElementById('cfg-desktop-target').value = '';
  document.getElementById('cfg-desktop-args').value = '';
  updateDesktopActionFields();

  document.getElementById('cfg-soundboard-file').value = '';
  document.getElementById('cfg-soundboard-device').innerHTML = '<option value="">Use global default (Settings → Soundboard)</option>';
  document.getElementById('cfg-soundboard-volume').value = '100';
  document.getElementById('cfg-soundboard-volume-display').textContent = '100%';
  document.getElementById('cfg-soundboard-color').value = '#22c55e';

  document.getElementById('cfg-vu-source').selectedIndex = 0;
  document.getElementById('cfg-strip-select').selectedIndex = 0;
  document.querySelectorAll('#cfg-strip-routing input').forEach(input => {
    input.checked = ['A1', 'A2', 'B1', 'B2'].includes(input.value);
  });
  document.getElementById('cfg-bus-select').selectedIndex = 0;

  updateSizePicker();
}

// Sensible starting footprint (in picker cells) for the size picker per type.
const PICKER_DEFAULT_CELLS = {
  fader: [1, 4], toggle: [1, 1], button: [2, 1], macro: [2, 1],
  desktop_action: [2, 1], soundboard: [2, 1], vu_meter: [1, 3],
  strip_panel: [1, 4], bus_panel: [1, 3], label: [2, 1],
  spotify_player: [3, 2], spotify_search: [3, 3], spotify_playlists: [3, 4],
  spotify_queue: [2, 3], spotify_stats: [2, 4], spotify_insights: [4, 5],
  spotify_intelligence: [2, 3],
};

function pickerCellsForType(type) {
  const [colSpan, rowSpan] = PICKER_DEFAULT_CELLS[type] || [2, 2];
  return { colSpan, rowSpan };
}

function selectType(type) {
  _selectedType = type;
  _selectedSize = pickerCellsForType(type);
  highlightSelectedType(type);
  updateSizePicker();
  showConfigStep(false);
}

function highlightSelectedType(type) {
  document.querySelectorAll('.type-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.type === type);
  });
}

function switchTypeTab(tab) {
  document.querySelectorAll('.type-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.type-tab-panel').forEach(panel => {
    panel.style.display = panel.dataset.panel === tab ? '' : 'none';
  });
}

function showTypeStep() {
  updateTypeAvailability();
  document.getElementById('step-type').style.display = 'block';
  document.getElementById('step-config').style.display = 'none';
  document.getElementById('modal-back').style.display = 'none';
  document.getElementById('modal-save').style.display = 'none';
}

function showConfigStep(isEdit) {
  document.getElementById('step-type').style.display = 'none';
  document.getElementById('step-config').style.display = 'flex';
  document.getElementById('modal-back').style.display = isEdit ? 'none' : 'inline-flex';
  document.getElementById('modal-save').style.display = 'inline-flex';
  showConfigSection(_selectedType);
}

function showConfigSection(type) {
  document.querySelectorAll('.cfg-section').forEach(section => {
    section.style.display = 'none';
  });

  const sectionMap = {
    fader: 'cfg-fader',
    toggle: 'cfg-toggle',
    button: 'cfg-toggle',
    macro: 'cfg-macro',
    desktop_action: 'cfg-desktop-action',
    soundboard: 'cfg-soundboard',
    vu_meter: 'cfg-vu',
    strip_panel: 'cfg-strip-panel',
    bus_panel: 'cfg-bus-panel',
    spotify_player:    'cfg-spotify-player',
    spotify_search:    'cfg-spotify-search',
    spotify_playlists: 'cfg-spotify-playlists',
    spotify_queue:     'cfg-spotify-queue',
    spotify_stats:        'cfg-spotify-stats',
    spotify_insights:     'cfg-spotify-insights',
    spotify_intelligence: 'cfg-spotify-intelligence',
  };

  const sectionId = sectionMap[type];
  if (sectionId) document.getElementById(sectionId).style.display = 'flex';
  document.getElementById('size-picker-group').style.display = 'block';

  if (type === 'soundboard') {
    requestSoundboardDevicesForEditor();
  }
}

function populateModal(control) {
  const config = control.config || {};
  document.getElementById('cfg-label').value = config.label || config.text || '';

  if (control.type === 'fader') {
    setSelectValue('cfg-fader-param', config.parameter);
    document.getElementById('cfg-fader-min').value = String(config.min ?? -60);
    document.getElementById('cfg-fader-max').value = String(config.max ?? 12);
    document.getElementById('cfg-fader-step').value = String(config.step ?? 0.1);
    document.getElementById('cfg-fader-vu').checked = config.showVu !== false;
  }

  if (control.type === 'toggle' || control.type === 'button') {
    setSelectValue('cfg-toggle-param', config.parameter);
    document.getElementById('cfg-toggle-color').value = config.activeColor || '#6c63ff';
    document.getElementById('cfg-toggle-momentary').checked = !!config.momentary;
  }

  if (control.type === 'macro') {
    document.getElementById('cfg-macro-color').value = config.activeColor || '#ff9800';
    document.getElementById('cfg-macro-momentary').checked = !!config.momentary;
    (config.actions || []).forEach(action => addMacroAction(action));
  }

  if (control.type === 'vu_meter') {
    const sourceValue = config.stripIndex !== undefined
      ? `strip-${config.stripIndex}`
      : `bus-${config.busIndex ?? 0}`;
    setSelectValue('cfg-vu-source', sourceValue);
  }

  if (control.type === 'strip_panel') {
    document.getElementById('cfg-strip-select').value = String(config.stripIndex ?? 0);
    const selected = config.routingButtons || ['A1', 'A2', 'B1', 'B2'];
    document.querySelectorAll('#cfg-strip-routing input').forEach(input => {
      input.checked = selected.includes(input.value);
    });
  }

  if (control.type === 'bus_panel') {
    document.getElementById('cfg-bus-select').value = String(config.busIndex ?? 0);
  }

  if (control.type === 'soundboard') {
    const vol = Math.round((config.volume ?? 1.0) * 100);
    document.getElementById('cfg-soundboard-file').value = config.file || '';
    document.getElementById('cfg-soundboard-volume').value = String(vol);
    document.getElementById('cfg-soundboard-volume-display').textContent = vol + '%';
    document.getElementById('cfg-soundboard-color').value = config.color || '#22c55e';
    // Pre-populate saved device so it isn't lost while the async list loads
    const sel = document.getElementById('cfg-soundboard-device');
    sel.innerHTML = '<option value="">Use global default (Settings → Soundboard)</option>';
    if (config.device) {
      const opt = document.createElement('option');
      opt.value = config.device;
      opt.textContent = config.device;
      sel.appendChild(opt);
      sel.value = config.device;
    }
  }

  if (control.type === 'desktop_action') {
    document.getElementById('cfg-desktop-kind').value = config.action || 'launch';
    document.getElementById('cfg-desktop-color').value = config.activeColor || '#3aa6ff';
    document.getElementById('cfg-desktop-target').value = config.target || '';
    document.getElementById('cfg-desktop-args').value = config.args || '';
    updateDesktopActionFields();
  }

  if (control.type === 'spotify_playlists') {
    const colsEl = document.getElementById('cfg-spotify-pl-cols');
    if (colsEl) colsEl.value = String(config.columns || 3);
    const specialEl = document.getElementById('cfg-spotify-pl-special');
    if (specialEl) specialEl.checked = !!config.showSpecialPlaylists;
  }
}

function saveControl() {
  const type = _editingId ? findControl(_editingId)?.type : _selectedType;
  if (!type) {
    window.alert('Choose a control type first.');
    return;
  }

  const config = buildControlConfig(type);
  if (!config) return;

  const page = currentPage();
  if (!page) return;

  const size = pickerToPixelSize(type);

  if (_editingId) {
    const control = findControl(_editingId);
    if (!control) return;

    // Keep the existing position; only the config changes on edit. Size is
    // adjusted freely via the resize handle, not the picker, so leave w/h.
    control.config = config;
  } else {
    const slot = findNextOpenSlot(page.controls, size);
    page.controls.push({
      id: genId(),
      type,
      x: slot.x,
      y: slot.y,
      w: size.w,
      h: size.h,
      config,
    });
  }

  closeModal();
  _callbacks.commitLayout?.();
}

function buildControlConfig(type) {
  const label = document.getElementById('cfg-label').value.trim();

  if (type === 'fader') {
    return {
      label: label || 'Fader',
      parameter: document.getElementById('cfg-fader-param').value,
      min: Number.parseFloat(document.getElementById('cfg-fader-min').value || '-60'),
      max: Number.parseFloat(document.getElementById('cfg-fader-max').value || '12'),
      step: Math.max(0.01, Number.parseFloat(document.getElementById('cfg-fader-step').value || '0.1')),
      showVu: document.getElementById('cfg-fader-vu').checked,
    };
  }

  if (type === 'toggle' || type === 'button') {
    return {
      label: label || (type === 'button' ? 'Button' : 'Toggle'),
      parameter: document.getElementById('cfg-toggle-param').value,
      activeColor: document.getElementById('cfg-toggle-color').value,
      momentary: document.getElementById('cfg-toggle-momentary').checked,
    };
  }

  if (type === 'macro') {
    const actions = [...document.querySelectorAll('.macro-action-row')].map(row => ({
      param: row.querySelector('.macro-param').value,
      value: Number.parseFloat(row.querySelector('.macro-value').value || '0'),
    })).filter(action => action.param);

    return {
      label: label || 'Macro',
      activeColor: document.getElementById('cfg-macro-color').value,
      momentary: document.getElementById('cfg-macro-momentary').checked,
      actions,
    };
  }

  if (type === 'desktop_action') {
    const action = document.getElementById('cfg-desktop-kind').value;
    const target = document.getElementById('cfg-desktop-target').value.trim();
    const args = document.getElementById('cfg-desktop-args').value.trim();

    if (requiresDesktopTarget(action) && !target) {
      window.alert('This desktop action needs a target.');
      return null;
    }

    return {
      label: label || defaultDesktopActionLabel(action),
      action,
      target,
      args,
      activeColor: document.getElementById('cfg-desktop-color').value,
    };
  }

  if (type === 'soundboard') {
    const file = document.getElementById('cfg-soundboard-file').value.trim();
    if (!file) {
      window.alert('Please enter a file path for the sound.');
      return null;
    }
    const rawVol = Number.parseInt(document.getElementById('cfg-soundboard-volume').value, 10) || 100;
    return {
      label: label || 'Sound',
      file,
      device: document.getElementById('cfg-soundboard-device').value || null,
      volume: Math.max(0, Math.min(2, rawVol / 100)),
      color: document.getElementById('cfg-soundboard-color').value,
    };
  }

  if (type === 'vu_meter') {
    const [kind, indexValue] = document.getElementById('cfg-vu-source').value.split('-');
    const index = Number.parseInt(indexValue, 10) || 0;

    return {
      label: label || 'Level',
      ...(kind === 'strip' ? { stripIndex: index } : { busIndex: index }),
    };
  }

  if (type === 'strip_panel') {
    const stripIndex = Number.parseInt(document.getElementById('cfg-strip-select').value, 10) || 0;
    const routingButtons = [...document.querySelectorAll('#cfg-strip-routing input:checked')].map(input => input.value);
    return {
      label: label || VM_STRIPS[stripIndex].fullLabel,
      stripIndex,
      routingButtons,
    };
  }

  if (type === 'bus_panel') {
    const busIndex = Number.parseInt(document.getElementById('cfg-bus-select').value, 10) || 0;
    return {
      label: label || VM_BUSES[busIndex].fullLabel,
      busIndex,
    };
  }

  if (type === 'label') {
    return {
      text: label || 'Label',
    };
  }

  if (type === 'spotify_player') return { label: label || 'Player' };
  if (type === 'spotify_search') return { label: label || 'Search' };
  if (type === 'spotify_queue')  return { label: label || 'Queue' };
  if (type === 'spotify_stats')  return { label: label || 'Session Stats' };
  if (type === 'spotify_insights')     return { label: label || 'Listening Insights' };
  if (type === 'spotify_intelligence') return { label: label || 'Now Playing' };
  if (type === 'spotify_playlists') {
    const columns = Number.parseInt(document.getElementById('cfg-spotify-pl-cols')?.value, 10) || 3;
    const showSpecialPlaylists = document.getElementById('cfg-spotify-pl-special')?.checked ?? false;
    return { label: label || 'Playlists', columns, showSpecialPlaylists };
  }

  return null;
}

function addMacroAction(preset = {}) {
  const list = document.getElementById('macro-actions-list');
  const row = document.createElement('div');
  row.className = 'macro-action-row';

  const paramSelect = document.createElement('select');
  paramSelect.className = 'form-select macro-param';
  buildParamOptions(false).forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    paramSelect.appendChild(option);
  });
  if (preset.param) paramSelect.value = preset.param;

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.className = 'form-input macro-value';
  valueInput.step = '0.1';
  valueInput.value = String(preset.value ?? 1);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'macro-action-del';
  removeButton.textContent = '×';
  removeButton.addEventListener('click', () => row.remove());

  row.appendChild(paramSelect);
  row.appendChild(valueInput);
  row.appendChild(removeButton);
  list.appendChild(row);
}

function updateDesktopActionFields() {
  const action = document.getElementById('cfg-desktop-kind').value;
  const targetGroup = document.getElementById('cfg-desktop-target-group');
  const argsGroup = document.getElementById('cfg-desktop-args-group');
  const targetLabel = document.getElementById('cfg-desktop-target-label');
  const targetInput = document.getElementById('cfg-desktop-target');
  const help = document.getElementById('cfg-desktop-help');

  const hasTarget = requiresDesktopTarget(action);
  const usesArgs = action === 'launch';

  targetGroup.style.display = hasTarget ? 'flex' : 'none';
  argsGroup.style.display = usesArgs ? 'flex' : 'none';

  const config = desktopActionUiMeta(action);
  targetLabel.textContent = config.label;
  targetInput.placeholder = config.placeholder;
  help.textContent = config.help;
}

function requestSoundboardDevicesForEditor() {
  const deviceId = _state?.ui?.activeDeviceId;
  if (!deviceId) return;
  requestSoundboardDevices(deviceId);
}

// ---------------------------------------------------------------------------
// Soundboard file browser
// ---------------------------------------------------------------------------
const _fb = {
  modal:    null,
  list:     null,
  pathEl:   null,
  upBtn:    null,
  selectBtn:null,
  parent:   null,    // null = at root level, string = parent path
  current:  null,    // current directory path (null at the drive/root list)
  mode:     'file',  // 'file' = pick a sound file, 'folder' = pick a directory
  onPick:   null,    // folder-mode callback(path)
  pending:  false,
};

/**
 * Open the soundboard browser.
 * @param {object} [opts]
 * @param {'file'|'folder'} [opts.mode='file']  file = choose a sound; folder = choose a directory
 * @param {string} [opts.startPath]             directory to open at (defaults to the saved default folder in file mode)
 * @param {function(string):void} [opts.onPick] folder-mode selection callback
 */
function _fbOpen(opts = {}) {
  if (!_fb.modal) {
    _fb.modal     = document.getElementById('filebrowser-modal');
    _fb.list      = document.getElementById('filebrowser-list');
    _fb.pathEl    = document.getElementById('filebrowser-path');
    _fb.upBtn     = document.getElementById('filebrowser-up');
    _fb.selectBtn = document.getElementById('filebrowser-select-folder');
    document.getElementById('filebrowser-close').addEventListener('click',  _fbClose);
    document.getElementById('filebrowser-cancel').addEventListener('click', _fbClose);
    _fb.modal.addEventListener('click', e => { if (e.target === _fb.modal) _fbClose(); });
    _fb.upBtn.addEventListener('click', () => {
      if (_fb.parent != null) _fbNavigate(_fb.parent);
      else _fbShowRoots();
    });
    _fb.selectBtn?.addEventListener('click', () => {
      if (_fb.mode === 'folder' && _fb.current && typeof _fb.onPick === 'function') {
        _fb.onPick(_fb.current);
      }
      _fbClose();
    });
    // Listen for results from server
    socket.on('soundboard:browse_roots_result', _fbHandleRoots);
    socket.on('soundboard:browse_result',       _fbHandleDir);
  }

  _fb.mode   = opts.mode === 'folder' ? 'folder' : 'file';
  _fb.onPick = typeof opts.onPick === 'function' ? opts.onPick : null;

  // Folder mode is launched from inside the Settings modal, so it must stack
  // above it (both modals share z-index:500 and Settings comes later in the DOM).
  _fb.modal.style.zIndex = _fb.mode === 'folder' ? '600' : '';
  if (_fb.selectBtn) _fb.selectBtn.style.display = _fb.mode === 'folder' ? '' : 'none';

  // Title reflects intent.
  const titleEl = _fb.modal.querySelector('.modal-header h2');
  if (titleEl) titleEl.textContent = _fb.mode === 'folder' ? 'Choose Default Folder' : 'Browse Sound Files';

  _fb.modal.style.display = '';

  // Determine where to start. File mode honours the saved default folder unless
  // an explicit startPath was given.
  const fallbackStart = _fb.mode === 'file'
    ? (_state.layoutStore?.globalSettings?.soundboardDefaultDir || '')
    : '';
  const start = (opts.startPath || fallbackStart || '').trim();
  if (start) _fbNavigate(start);
  else _fbShowRoots();
}

function _fbClose() {
  if (_fb.modal) { _fb.modal.style.display = 'none'; _fb.modal.style.zIndex = ''; }
}

function _fbUpdateSelectState() {
  if (_fb.selectBtn) _fb.selectBtn.disabled = !(_fb.mode === 'folder' && _fb.current);
}

function _fbSetLoading(msg = 'Loading…') {
  _fb.list.innerHTML = `<div class="filebrowser-loading">${msg}</div>`;
  _fb.upBtn.disabled = true;
}

function _fbShowRoots() {
  const deviceId = _state?.ui?.activeDeviceId;
  if (!deviceId) {
    _fb.list.innerHTML = '<div class="filebrowser-loading filebrowser-error">No bridge connected.</div>';
    return;
  }
  _fbSetLoading('Loading drives…');
  _fb.pathEl.textContent = 'This PC';
  _fb.parent = null;
  _fb.current = null;
  _fb.upBtn.disabled = true;
  _fbUpdateSelectState();
  socket.emit('soundboard:browse_roots', { deviceId });
}

function _fbNavigate(path) {
  const deviceId = _state?.ui?.activeDeviceId;
  if (!deviceId) return;
  _fbSetLoading('Loading…');
  socket.emit('soundboard:browse', { deviceId, path });
}

function _fbHandleRoots({ roots }) {
  _fb.pathEl.textContent = 'This PC';
  _fb.parent = null;
  _fb.current = null;
  _fb.upBtn.disabled = true;
  _fbUpdateSelectState();
  _fb.list.innerHTML = '';
  if (!roots || !roots.length) {
    _fb.list.innerHTML = '<div class="filebrowser-loading filebrowser-error">No drives found.</div>';
    return;
  }
  roots.forEach(root => {
    const row = _fbMakeDirRow(root.replace(/\\$/, ''), root);
    _fb.list.appendChild(row);
  });
}

function _fbHandleDir({ path, parent, entries, error }) {
  if (error) {
    // Don't strand the user on a bad/inaccessible path (e.g. a saved default
    // folder that no longer exists) — let Up fall back to the drive list.
    _fb.parent = null;
    _fb.current = null;
    _fb.upBtn.disabled = false;
    _fbUpdateSelectState();
    _fb.list.innerHTML = `<div class="filebrowser-loading filebrowser-error">⚠ ${error}</div>`;
    return;
  }
  _fb.pathEl.textContent = path || '—';
  _fb.parent = parent;   // null when at drive root
  _fb.current = path || null;
  _fb.upBtn.disabled = false;
  _fbUpdateSelectState();
  _fb.list.innerHTML = '';
  // In folder-pick mode, only directories are navigable; files are noise.
  const visible = _fb.mode === 'folder'
    ? (entries || []).filter(e => e.isDir)
    : (entries || []);
  if (!visible.length) {
    _fb.list.innerHTML = `<div class="filebrowser-loading">${_fb.mode === 'folder' ? 'No subfolders here' : 'Empty folder'}</div>`;
    return;
  }
  visible.forEach(({ name, isDir, ext }) => {
    const fullPath = path.replace(/[/\\]$/, '') + '\\' + name;
    const row = isDir
      ? _fbMakeDirRow(name, fullPath)
      : _fbMakeFileRow(name, fullPath, ext);
    _fb.list.appendChild(row);
  });
}

function _fbMakeDirRow(label, fullPath) {
  const row = document.createElement('div');
  row.className = 'filebrowser-row filebrowser-dir';
  row.innerHTML = `<span class="fb-icon">📁</span><span class="fb-name">${_fbEsc(label)}</span>`;
  row.addEventListener('click', () => _fbNavigate(fullPath));
  return row;
}

function _fbMakeFileRow(name, fullPath, ext) {
  const row = document.createElement('div');
  row.className = 'filebrowser-row filebrowser-file';
  const icon = ext === '.mp3' ? '🎵' : ext === '.wav' ? '🔊' : '🎶';
  row.innerHTML = `<span class="fb-icon">${icon}</span><span class="fb-name">${_fbEsc(name)}</span><span class="fb-ext">${ext}</span>`;
  row.addEventListener('click', () => {
    document.getElementById('cfg-soundboard-file').value = fullPath;
    _fbClose();
  });
  return row;
}

function _fbEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function requiresDesktopTarget(action) {
  return ['launch', 'open_url', 'key_combo'].includes(action);
}

function defaultDesktopActionLabel(action) {
  const labels = {
    launch: 'Launch',
    open_url: 'Open URL',
    screenshot: 'Screenshot',
    media_play_pause: 'Play / Pause',
    media_next: 'Next Track',
    media_previous: 'Previous Track',
    volume_up: 'Volume Up',
    volume_down: 'Volume Down',
    volume_mute: 'Mute',
    lock: 'Lock Device',
    sleep: 'Sleep Device',
    key_combo: 'Shortcut',
  };
  return labels[action] || 'Shortcut';
}

function desktopActionUiMeta(action) {
  const isMac = currentPlatform() === 'macos';
  const platformLabel = currentPlatformLabel();
  const meta = {
    launch: {
      label: isMac ? 'Path or App Bundle' : 'Path',
      placeholder: isMac ? '/Applications/Safari.app' : 'C:\\Program Files\\App\\app.exe or .lnk',
      help: `Launch an app, folder, file, or shortcut on the selected ${platformLabel} device.`,
    },
    open_url: {
      label: 'URL',
      placeholder: 'https://example.com',
      help: `Open a website in the default browser on the selected ${platformLabel} device.`,
    },
    key_combo: {
      label: 'Key Combo',
      placeholder: isMac ? 'cmd+shift+4' : 'ctrl+alt+m',
      help: isMac
        ? 'Send a keyboard shortcut like cmd+space or cmd+shift+4.'
        : 'Send a keyboard shortcut like ctrl+shift+esc or win+d.',
    },
    screenshot: {
      label: 'Target',
      placeholder: '',
      help: `Save a full-screen screenshot on the selected ${platformLabel} device.`,
    },
    media_play_pause: {
      label: 'Target',
      placeholder: '',
      help: `Toggle media playback on the selected ${platformLabel} device.`,
    },
    media_next: {
      label: 'Target',
      placeholder: '',
      help: `Skip to the next media track on the selected ${platformLabel} device.`,
    },
    media_previous: {
      label: 'Target',
      placeholder: '',
      help: `Go to the previous media track on the selected ${platformLabel} device.`,
    },
    volume_up: {
      label: 'Target',
      placeholder: '',
      help: `Raise the system volume on the selected ${platformLabel} device.`,
    },
    volume_down: {
      label: 'Target',
      placeholder: '',
      help: `Lower the system volume on the selected ${platformLabel} device.`,
    },
    volume_mute: {
      label: 'Target',
      placeholder: '',
      help: `Toggle the system mute state on the selected ${platformLabel} device.`,
    },
    lock: {
      label: 'Target',
      placeholder: '',
      help: `Lock the selected ${platformLabel} device immediately.`,
    },
    sleep: {
      label: 'Target',
      placeholder: '',
      help: `Put the selected ${platformLabel} device to sleep.`,
    },
  };

  return meta[action] || meta.launch;
}

function updateTypeAvailability() {
  const supportsVm = !!_state.bridge?.capabilities?.voiceMeeter;
  document.querySelectorAll('.type-card').forEach(card => {
    const disabled = VM_ONLY_TYPES.has(card.dataset.type) && !supportsVm;
    card.classList.toggle('disabled', disabled);
    card.title = disabled ? 'This control type is only available on devices with VoiceMeeter.' : '';
  });
}

function currentPlatform() {
  const platform = String(_state.bridge?.platform || _state.layout?.platform || 'unknown').toLowerCase();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}

function currentPlatformLabel() {
  const labels = {
    macos: 'macOS',
    windows: 'Windows',
    linux: 'Linux',
    unknown: 'Unknown',
  };
  return labels[currentPlatform()] || 'Unknown';
}

function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  _editingId = null;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;
const EYE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;
const STAR_SVG = (filled) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
</svg>`;

function renderDeviceManagementList() {
  const listEl = document.getElementById('s-devices-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const store = _state.layoutStore || {};
  const allIds = [...(store.deviceOrder || []).filter(id => store.devices?.[id])];
  Object.keys(store.devices || {}).forEach(id => { if (!allIds.includes(id)) allIds.push(id); });

  const visibleIds = allIds.filter(id => !store.devices[id]?.hidden);
  const hiddenIds  = allIds.filter(id =>  store.devices[id]?.hidden);
  const defaultId  = store.globalSettings?.defaultDeviceId || null;

  if (!allIds.length) {
    const empty = document.createElement('p');
    empty.className = 'settings-empty';
    empty.textContent = 'No devices configured.';
    listEl.appendChild(empty);
    return;
  }

  const buildRow = (deviceId, isHidden) => {
    const device  = store.devices[deviceId] || {};
    const runtime = _state.devices?.[deviceId] || {};
    const isDefault = deviceId === defaultId;
    const isActive  = deviceId === _state.ui?.activeDeviceId;

    const item = document.createElement('div');
    item.className = [
      'device-item',
      isActive  ? 'device-item-active' : '',
      isHidden  ? 'device-item-hidden' : '',
    ].filter(Boolean).join(' ');

    // Status dot
    const dot = document.createElement('span');
    dot.className = `device-item-dot ${runtime.connected ? 'connected' : 'offline'}`;
    dot.title = runtime.connected ? 'Connected' : 'Offline';

    // Info column
    const info = document.createElement('div');
    info.className = 'device-item-info';

    const nameInput = document.createElement('input');
    nameInput.className = 'device-item-name';
    nameInput.value = runtime.deviceName || device.name || prettifyId(deviceId);
    nameInput.title = 'Click to rename';
    nameInput.disabled = isHidden;
    nameInput.addEventListener('change', () => {
      _callbacks.renameDevice?.(deviceId, nameInput.value.trim() || prettifyId(deviceId));
    });

    const metaEl = document.createElement('span');
    metaEl.className = 'device-item-meta';
    const plat = devicePlatformLabel(runtime.platform || device.platform || 'unknown');
    const vmTypeNames = { 1: 'VoiceMeeter', 2: 'Banana', 3: 'Potato' };
    const vmStr = runtime.connected && runtime.capabilities?.voiceMeeter
      ? ` · ${vmTypeNames[runtime.vmType] || 'VM'}` : '';
    metaEl.textContent = `${plat}${vmStr} · ${runtime.connected ? 'Connected' : 'Offline'}`;

    info.appendChild(nameInput);
    info.appendChild(metaEl);

    // Star / default button (only for visible devices)
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = `device-item-star${isDefault ? ' active' : ''}`;
    starBtn.title = isDefault ? 'Startup default (click to clear)' : 'Set as startup default';
    starBtn.innerHTML = STAR_SVG(isDefault);
    starBtn.style.visibility = isHidden ? 'hidden' : '';
    starBtn.addEventListener('click', () => {
      _callbacks.setDefaultDevice?.(isDefault ? null : deviceId);
      renderDeviceManagementList();
      renderDefaultDeviceDropdown();
    });

    // Hide / show button
    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = 'device-item-eye';
    if (isHidden) {
      eyeBtn.innerHTML = EYE_SVG;
      eyeBtn.title = 'Show device';
      eyeBtn.addEventListener('click', () => {
        _callbacks.unhideDevice?.(deviceId);
        renderDeviceManagementList();
        renderDefaultDeviceDropdown();
      });
    } else {
      eyeBtn.innerHTML = EYE_OFF_SVG;
      eyeBtn.title = 'Hide device (keeps layout, stops it appearing in the tab bar)';
      eyeBtn.addEventListener('click', () => {
        _callbacks.hideDevice?.(deviceId);
        renderDeviceManagementList();
        renderDefaultDeviceDropdown();
      });
    }

    // Delete button (only for offline devices, or as a power-user action)
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'device-item-del';
    delBtn.title = runtime.connected
      ? 'Cannot delete a connected device — hide it instead'
      : `Permanently delete "${device.name || deviceId}" and its layout`;
    delBtn.innerHTML = '&times;';
    delBtn.disabled = !!runtime.connected;
    delBtn.addEventListener('click', () => {
      const name = runtime.deviceName || device.name || deviceId;
      if (!window.confirm(`Permanently delete "${name}" and all its pages and controls?\n\nThis cannot be undone. If the bridge reconnects it will reappear — hide the device instead to prevent that.`)) return;
      _callbacks.deleteDevice?.(deviceId);
      renderDeviceManagementList();
      renderDefaultDeviceDropdown();
    });

    item.appendChild(dot);
    item.appendChild(info);
    item.appendChild(starBtn);
    item.appendChild(eyeBtn);
    item.appendChild(delBtn);
    return item;
  };

  visibleIds.forEach(id => listEl.appendChild(buildRow(id, false)));

  if (hiddenIds.length) {
    const sep = document.createElement('p');
    sep.className = 'settings-section-sub';
    sep.textContent = 'Hidden';
    listEl.appendChild(sep);
    hiddenIds.forEach(id => listEl.appendChild(buildRow(id, true)));
  }
}

function renderDefaultDeviceDropdown() {
  const select = document.getElementById('s-default-device');
  if (!select) return;
  const store = _state.layoutStore || {};
  const defaultId = store.globalSettings?.defaultDeviceId || '';
  const deviceIds = (store.deviceOrder || []).filter(id => store.devices?.[id]);
  Object.keys(store.devices || {}).forEach(id => {
    if (!deviceIds.includes(id)) deviceIds.push(id);
  });

  select.innerHTML = '<option value="">Auto — first connected device</option>';
  deviceIds.forEach(deviceId => {
    const device = store.devices[deviceId] || {};
    const runtime = _state.devices?.[deviceId] || {};
    const opt = document.createElement('option');
    opt.value = deviceId;
    opt.textContent = runtime.deviceName || device.name || prettifyId(deviceId);
    select.appendChild(opt);
  });
  select.value = defaultId;
}

function prettifyId(deviceId) {
  return String(deviceId || 'device')
    .split(/[-_]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function devicePlatformLabel(platform) {
  const map = {
    darwin: 'macOS', macos: 'macOS',
    win32: 'Windows', windows: 'Windows',
    linux: 'Linux',
  };
  return map[String(platform || '').toLowerCase()] || 'Unknown';
}

function applySettings() {
  const accentColor = document.getElementById('s-accent-color').value;
  const primaryColor = document.getElementById('s-primary-color')?.value || '#090910';
  const secondaryColor = document.getElementById('s-secondary-color')?.value || '#181828';
  const panelOpacity = clampFloat(document.getElementById('s-panel-opacity')?.value, 0.2, 1, 1);
  const fitToScreen = !!document.getElementById('s-fit-screen')?.checked;
  const soundboardDevice = document.getElementById('s-soundboard-device')?.value || null;
  const soundboardDefaultDir = document.getElementById('s-soundboard-default-dir')?.value.trim() || null;

  // Save global soundboard preferences
  if (!_state.layoutStore.globalSettings) _state.layoutStore.globalSettings = {};
  _state.layoutStore.globalSettings.soundboardDevice = soundboardDevice || null;
  _state.layoutStore.globalSettings.soundboardDefaultDir = soundboardDefaultDir;

  const next = {
    ...(_state.layout.settings || {}),
    accentColor,
    primaryColor,
    secondaryColor,
    panelOpacity,
    fitToScreen,
  };
  if (_pendingBg !== undefined) {
    next.backgroundImage = _pendingBg;
    _pendingBg = undefined;
  }
  _state.layout.settings = next;

  closeSettings();
  _callbacks.commitLayout?.();
}

function clampFloat(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function setIfPresent(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function updateBgPreview(path) {
  const preview = document.getElementById('s-bg-preview');
  const clearBtn = document.getElementById('s-bg-clear');
  if (preview) {
    preview.style.backgroundImage = path ? `url("${path}")` : 'none';
    preview.classList.toggle('has-image', !!path);
  }
  if (clearBtn) clearBtn.style.display = path ? '' : 'none';
}

async function handleBackgroundUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    window.alert('Please choose an image file.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    window.alert('Background image must be under 8 MB.');
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const res = await fetch('/api/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, name: file.name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.path) throw new Error('No path returned');
    _pendingBg = data.path;
    updateBgPreview(data.path);
  } catch (err) {
    console.error('[editor] background upload failed', err);
    window.alert('Background upload failed. Please try again.');
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderPagesList() {
  const listEl = document.getElementById('pages-list');
  listEl.innerHTML = '';

  _state.layout.pages.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'page-item';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn-secondary btn-sm';
    openButton.textContent = index === _state.ui.currentPage ? 'Current' : 'Open';
    openButton.addEventListener('click', () => {
      _state.ui.currentPage = index;
      _callbacks.commitLayout?.({ persist: false, rerender: true });
      renderPagesList();
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = page.name;
    input.addEventListener('change', () => {
      page.name = input.value.trim() || `Page ${index + 1}`;
      _callbacks.commitLayout?.();
      renderPagesList();
    });

    item.appendChild(openButton);
    item.appendChild(input);

    if (_state.layout.pages.length > 1) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'page-item-del';
      deleteButton.textContent = '×';
      deleteButton.title = `Delete ${page.name}`;
      deleteButton.addEventListener('click', () => {
        if (!window.confirm(`Delete page "${page.name}"?`)) return;
        _state.layout.pages.splice(index, 1);
        _state.ui.currentPage = Math.min(_state.ui.currentPage, _state.layout.pages.length - 1);
        _callbacks.commitLayout?.();
        renderPagesList();
      });
      item.appendChild(deleteButton);
    }

    listEl.appendChild(item);
  });
}

function closePageModal() {
  document.getElementById('page-modal').style.display = 'none';
  _pageEditIndex = null;
}

function savePageName() {
  const name = document.getElementById('page-name-input').value.trim() || 'Page';

  if (Number.isInteger(_pageEditIndex)) {
    _state.layout.pages[_pageEditIndex].name = name;
  } else {
    _state.layout.pages.push({
      id: genId('page'),
      name,
      controls: [],
    });
    _state.ui.currentPage = _state.layout.pages.length - 1;
  }

  closePageModal();
  _callbacks.commitLayout?.();
}

function exportLayout() {
  const json = JSON.stringify(_state.layout, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vm-layout.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function openImportModal(event) {
  const file = event?.target?.files?.[0];
  if (event?.target) event.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = loadEvent => {
    try {
      _importParsed = JSON.parse(loadEvent.target.result);
    } catch {
      window.alert('Invalid JSON file — could not parse.');
      return;
    }
    renderImportModal(_importParsed);
    document.getElementById('import-modal').style.display = 'flex';
  };
  reader.readAsText(file);
}

function renderImportModal(data) {
  const { type, label, summary } = detectImportFormat(data);

  const badgeEl = document.getElementById('import-detect-badge');
  badgeEl.textContent = label;
  badgeEl.className = `import-detect-badge import-badge-${type}`;

  document.getElementById('import-summary').innerHTML = summary;

  const optionsEl = document.getElementById('import-options');
  optionsEl.innerHTML = '';

  if (type === 'v2') {
    optionsEl.innerHTML = `
      <label class="import-option">
        <input type="radio" name="import-mode" value="merge" checked>
        <div class="import-option-body">
          <strong>Merge</strong>
          <span>Add / update devices from the file; keep any devices not in the file.</span>
        </div>
      </label>
      <label class="import-option">
        <input type="radio" name="import-mode" value="replace">
        <div class="import-option-body">
          <strong>Replace all</strong>
          <span>Remove all current devices and import fresh. <em>Cannot be undone.</em></span>
        </div>
      </label>`;
  } else if (type === 'legacy') {
    const store = _state.layoutStore || {};
    const deviceIds = (store.deviceOrder || []).filter(id => store.devices?.[id]);
    Object.keys(store.devices || {}).forEach(id => { if (!deviceIds.includes(id)) deviceIds.push(id); });
    const deviceOpts = deviceIds.map(id => {
      const d = store.devices[id] || {};
      const r = _state.devices?.[id] || {};
      const name = r.deviceName || d.name || prettifyId(id);
      return `<option value="${id}">${name}</option>`;
    }).join('');
    const activeId = _state.ui?.activeDeviceId || '';

    optionsEl.innerHTML = `
      <label class="import-option">
        <input type="radio" name="import-mode" value="active" checked>
        <div class="import-option-body">
          <strong>Replace active device layout</strong>
          <span>Overwrites the currently selected device's pages and controls.</span>
        </div>
      </label>
      <label class="import-option">
        <input type="radio" name="import-mode" value="specific">
        <div class="import-option-body">
          <strong>Replace a specific device</strong>
          <select id="import-target-device" class="form-select" style="margin-top:6px">${deviceOpts}</select>
        </div>
      </label>
      <label class="import-option">
        <input type="radio" name="import-mode" value="new">
        <div class="import-option-body">
          <strong>Import as a new device</strong>
          <input id="import-new-device-name" type="text" class="form-input" placeholder="Device name" style="margin-top:6px" value="Imported Device">
        </div>
      </label>`;

    // Pre-select current device in "specific" dropdown
    window.setTimeout(() => {
      const sel = document.getElementById('import-target-device');
      if (sel && activeId) sel.value = activeId;
    }, 0);
  } else {
    optionsEl.innerHTML = `<p class="cfg-note" style="color:var(--danger)">
      Unable to recognise this file format. Make sure it was exported from VM Control.
    </p>`;
    document.getElementById('import-modal-apply').disabled = true;
  }
}

function applyImport() {
  if (!_importParsed) { closeImportModal(); return; }
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value;
  const { type } = detectImportFormat(_importParsed);

  if (type === 'v2') {
    if (mode === 'replace') {
      _callbacks.replaceLayoutStore?.(_importParsed);
    } else {
      _callbacks.mergeLayoutStore?.(_importParsed);
    }
  } else if (type === 'legacy') {
    if (mode === 'active') {
      _callbacks.replaceLayout?.(_importParsed);
    } else if (mode === 'specific') {
      const deviceId = document.getElementById('import-target-device')?.value;
      if (deviceId) _callbacks.importIntoDevice?.(deviceId, _importParsed);
    } else if (mode === 'new') {
      const rawName = (document.getElementById('import-new-device-name')?.value || '').trim() || 'Imported Device';
      const deviceId = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported';
      _callbacks.importIntoDevice?.(deviceId, _importParsed, rawName);
    }
  }

  closeImportModal();
  closeSettings();
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
  document.getElementById('import-modal-apply').disabled = false;
  _importParsed = null;
}

function detectImportFormat(data) {
  if (!data || typeof data !== 'object') {
    return { type: 'unknown', label: 'Unknown format', summary: '' };
  }

  if (Array.isArray(data.pages)) {
    const pages = data.pages.length;
    const controls = data.pages.reduce((n, p) => n + (p.controls?.length || 0), 0);
    return {
      type: 'legacy',
      label: 'Legacy single-device layout',
      summary: `<p>Detected an older single-device export — <strong>${pages} page${pages !== 1 ? 's' : ''}</strong>, <strong>${controls} control${controls !== 1 ? 's' : ''}</strong>. Choose where to import it:</p>`,
    };
  }

  if (data.devices && typeof data.devices === 'object') {
    const deviceCount = Object.keys(data.devices).length;
    const pageCount = Object.values(data.devices).reduce((n, d) => n + (d.pages?.length || 0), 0);
    const ctrlCount = Object.values(data.devices).reduce(
      (n, d) => n + (d.pages || []).reduce((m, p) => m + (p.controls?.length || 0), 0), 0);
    return {
      type: 'v2',
      label: 'v2.0 multi-device layout',
      summary: `<p>Detected a v2.0 multi-device export — <strong>${deviceCount} device${deviceCount !== 1 ? 's' : ''}</strong>, <strong>${pageCount} page${pageCount !== 1 ? 's' : ''}</strong>, <strong>${ctrlCount} control${ctrlCount !== 1 ? 's' : ''}</strong>.</p>`,
    };
  }

  return { type: 'unknown', label: 'Unrecognised format', summary: '' };
}

function buildSizePicker() {
  const picker = document.getElementById('size-picker');
  picker.innerHTML = '';
  const cols = 6;
  const rows = 4;
  picker.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'size-cell';
      cell.dataset.colspan = String(col);
      cell.dataset.rowspan = String(row);
      cell.addEventListener('mouseenter', () => paintSizePicker(col, row, false));
      cell.addEventListener('focus', () => paintSizePicker(col, row, false));
      cell.addEventListener('click', () => {
        _selectedSize = { colSpan: col, rowSpan: row };
        updateSizePicker();
      });
      picker.appendChild(cell);
    }
  }

  picker.addEventListener('mouseleave', () => updateSizePicker());
}

function updateSizePicker() {
  const cols = 6;
  const picker = document.getElementById('size-picker');
  picker.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  paintSizePicker(_selectedSize.colSpan, _selectedSize.rowSpan, true);
  document.getElementById('size-display').textContent = `${_selectedSize.colSpan} × ${_selectedSize.rowSpan}`;
}

function paintSizePicker(colSpan, rowSpan, committed) {
  document.querySelectorAll('.size-cell').forEach(cell => {
    const cellCol = Number.parseInt(cell.dataset.colspan, 10);
    const cellRow = Number.parseInt(cell.dataset.rowspan, 10);
    const inside = cellCol <= colSpan && cellRow <= rowSpan;
    cell.classList.toggle('preview', inside);
    cell.classList.toggle('selected', committed && inside);
  });
  document.getElementById('size-display').textContent = `${colSpan} × ${rowSpan}`;
}

function populateStripBusSources() {
  const stripSelect = document.getElementById('cfg-strip-select');
  const busSelect = document.getElementById('cfg-bus-select');
  const vuSource = document.getElementById('cfg-vu-source');

  VM_STRIPS.forEach(strip => {
    const stripOption = document.createElement('option');
    stripOption.value = String(strip.index);
    stripOption.textContent = strip.fullLabel;
    stripSelect.appendChild(stripOption);

    const vuOption = document.createElement('option');
    vuOption.value = `strip-${strip.index}`;
    vuOption.textContent = `Strip: ${strip.fullLabel}`;
    vuSource.appendChild(vuOption);
  });

  VM_BUSES.forEach(bus => {
    const busOption = document.createElement('option');
    busOption.value = String(bus.index);
    busOption.textContent = bus.fullLabel;
    busSelect.appendChild(busOption);

    const vuOption = document.createElement('option');
    vuOption.value = `bus-${bus.index}`;
    vuOption.textContent = `Bus: ${bus.fullLabel}`;
    vuSource.appendChild(vuOption);
  });
}

function populateParamDropdown(id, options) {
  const select = document.getElementById(id);
  select.innerHTML = '';
  options.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}

const ALIGN_THRESHOLD = 6; // px tolerance for snapping to another panel's edges

function canvasScale(gridEl) {
  const v = parseFloat(getComputedStyle(gridEl).getPropertyValue('--canvas-scale'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function startGridGesture({ mode, event, gridEl, card }) {
  const control = findControl(card.dataset.id);
  if (!control) return;

  const original = resolveRect(control);

  _gridGesture = {
    mode,
    gridEl,
    card,
    controlId: control.id,
    type: control.type,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scale: canvasScale(gridEl),
    original,
    lastValid: { ...original },
  };

  card.classList.add('is-dragging');
  showDropPreview(original, false);

  // Capture the pointer on the grid container (which is stable across
  // re-renders) so move/up/cancel are reliably delivered even if the dragged
  // card's DOM is replaced mid-gesture — the cause of "finger keeps dragging".
  try { gridEl.setPointerCapture?.(event.pointerId); } catch { /* non-fatal */ }

  window.addEventListener('pointermove', onGridGestureMove);
  window.addEventListener('pointerup', endGridGesture);
  window.addEventListener('pointercancel', endGridGesture);
  window.addEventListener('lostpointercapture', endGridGesture);
  event.preventDefault();
}

function snap(value, disabled) {
  return disabled ? Math.round(value) : Math.round(value / SNAP) * SNAP;
}

function onGridGestureMove(event) {
  if (!_gridGesture) return;

  const { mode, controlId, type, original, scale } = _gridGesture;
  const page = currentPage();
  if (!page) return;

  const noSnap = event.altKey;
  const dx = (event.clientX - _gridGesture.startX) / scale;
  const dy = (event.clientY - _gridGesture.startY) / scale;

  const others = page.controls.filter(c => c.id !== controlId).map(resolveRect);

  let candidate;
  if (mode === 'move') {
    candidate = {
      x: Math.max(0, snap(original.x + dx, noSnap)),
      y: Math.max(0, snap(original.y + dy, noSnap)),
      w: original.w,
      h: original.h,
    };
    if (!noSnap) applyAlignSnap(candidate, others);
  } else {
    const min = minSizeForType(type);
    candidate = {
      x: original.x,
      y: original.y,
      w: Math.max(min.w, snap(original.w + dx, noSnap)),
      h: Math.max(min.h, snap(original.h + dy, noSnap)),
    };
  }

  const blocked = collides(page.controls, candidate, controlId);
  if (!blocked) _gridGesture.lastValid = candidate;
  showDropPreview(blocked ? candidate : _gridGesture.lastValid, blocked);
}

// Nudge a moving rect so its edges/centres line up with nearby panels.
function applyAlignSnap(rect, others) {
  const xCandidates = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
  const yCandidates = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];

  let bestX = null;
  let bestY = null;

  others.forEach(o => {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
    const oys = [o.y, o.y + o.h / 2, o.y + o.h];
    xCandidates.forEach((cx, i) => {
      oxs.forEach(ox => {
        const d = Math.abs(cx - ox);
        if (d <= ALIGN_THRESHOLD && (!bestX || d < bestX.d)) {
          bestX = { d, delta: ox - cx };
        }
      });
    });
    yCandidates.forEach((cy) => {
      oys.forEach(oy => {
        const d = Math.abs(cy - oy);
        if (d <= ALIGN_THRESHOLD && (!bestY || d < bestY.d)) {
          bestY = { d, delta: oy - cy };
        }
      });
    });
  });

  if (bestX) rect.x = Math.max(0, rect.x + bestX.delta);
  if (bestY) rect.y = Math.max(0, rect.y + bestY.delta);
}

function endGridGesture() {
  if (!_gridGesture) return;

  // Snapshot what we need, then fully tear the gesture down BEFORE committing.
  // Committing re-renders the layout and could throw; if teardown ran after the
  // commit, an error would strand the gesture (card keeps following the cursor
  // and edit mode becomes impossible to exit). Cleanup-first avoids that.
  const { card, controlId, lastValid, original, gridEl, pointerId } = _gridGesture;
  _gridGesture = null;

  card.classList.remove('is-dragging');
  hideDropPreview();
  window.removeEventListener('pointermove', onGridGestureMove);
  window.removeEventListener('pointerup', endGridGesture);
  window.removeEventListener('pointercancel', endGridGesture);
  window.removeEventListener('lostpointercapture', endGridGesture);
  try {
    if (pointerId != null && gridEl.hasPointerCapture?.(pointerId)) {
      gridEl.releasePointerCapture(pointerId);
    }
  } catch { /* capture may already be gone */ }

  const control = findControl(controlId);
  const changed = control && hasRectChanged(original, lastValid);
  if (control && changed) {
    control.x = lastValid.x;
    control.y = lastValid.y;
    control.w = lastValid.w;
    control.h = lastValid.h;
  }

  try {
    _callbacks.commitLayout?.(changed ? undefined : { persist: false, rerender: true });
  } catch (err) {
    console.error('[editor] commit after gesture failed', err);
  }
}

function showDropPreview(rect, invalid) {
  const gridEl = _gridGesture?.gridEl || document.getElementById('control-grid');
  if (previewEl.parentElement !== gridEl) gridEl.appendChild(previewEl);

  previewEl.style.display = 'block';
  previewEl.style.left = `${rect.x}px`;
  previewEl.style.top = `${rect.y}px`;
  previewEl.style.width = `${rect.w}px`;
  previewEl.style.height = `${rect.h}px`;
  previewEl.classList.toggle('invalid', !!invalid);
}

function hideDropPreview() {
  previewEl.style.display = 'none';
  previewEl.classList.remove('invalid');
}

function deleteControl(id) {
  const page = currentPage();
  if (!page) return;
  page.controls = page.controls.filter(control => control.id !== id);
  _callbacks.commitLayout?.();
}

function currentPage() {
  return _state.layout?.pages?.[_state.ui.currentPage] || null;
}

function findControl(id) {
  for (const page of _state.layout.pages || []) {
    const control = page.controls.find(item => item.id === id);
    if (control) return control;
  }
  return null;
}

function findNextOpenSlot(controls, size) {
  const step = Math.max(SNAP, 24);
  const maxW = _state.layout?.settings?.canvasWidth || 1280;
  for (let y = 0; y <= 4000; y += step) {
    for (let x = 0; x + size.w <= Math.max(maxW, size.w); x += step) {
      const candidate = { x, y, w: size.w, h: size.h };
      if (!collides(controls, candidate)) return candidate;
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

function hasRectChanged(a, b) {
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
}

function setSelectValue(id, value) {
  if (!value) return;
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function genId(prefix = 'ctrl') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
