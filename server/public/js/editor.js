import { VM_STRIPS, VM_BUSES, buildParamOptions } from './controls.js';
import { vmMacro } from './socket.js';

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

let _state = null;
let _callbacks = {};
let _editingId = null;
let _selectedType = null;
let _selectedSize = { colSpan: 1, rowSpan: 2 };
let _pageEditIndex = null;
let _gridGesture = null;

const previewEl = document.getElementById('drop-preview');
const mainAreaEl = document.getElementById('main-area');

export function initEditor(state, callbacks) {
  _state = state;
  _callbacks = callbacks;

  populateParamDropdown('cfg-fader-param', buildParamOptions(true));
  populateParamDropdown('cfg-toggle-param', buildParamOptions(false));
  populateStripBusSources();
  buildSizePicker();

  document.querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => selectType(card.dataset.type));
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

  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-apply').addEventListener('click', applySettings);
  document.getElementById('settings-modal').addEventListener('click', event => {
    if (event.target === document.getElementById('settings-modal')) closeSettings();
  });
  document.getElementById('s-add-page').addEventListener('click', () => openPageNameModal(null));
  document.getElementById('s-export').addEventListener('click', exportLayout);
  document.getElementById('s-import').addEventListener('click', () => {
    document.getElementById('s-import-file').click();
  });
  document.getElementById('s-import-file').addEventListener('change', importLayout);
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
  const vmTypeNames = {
    1: 'VoiceMeeter',
    2: 'VoiceMeeter Banana',
    3: 'VoiceMeeter Potato',
  };

  document.getElementById('s-accent-color').value = settings.accentColor || '#6c63ff';
  document.getElementById('s-grid-cols').value = String(settings.gridColumns || 8);
  document.getElementById('s-status').textContent = bridge.connected ? 'Connected' : 'Disconnected';
  document.getElementById('s-vm-type').textContent = vmTypeNames[bridge.vmType] || '—';
  document.getElementById('s-vm-version').textContent = bridge.vmVersion || '—';

  renderPagesList();
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

  document.getElementById('cfg-vu-source').selectedIndex = 0;
  document.getElementById('cfg-strip-select').selectedIndex = 0;
  document.querySelectorAll('#cfg-strip-routing input').forEach(input => {
    input.checked = ['A1', 'A2', 'B1', 'B2'].includes(input.value);
  });
  document.getElementById('cfg-bus-select').selectedIndex = 0;

  updateSizePicker();
}

function selectType(type) {
  _selectedType = type;
  _selectedSize = sizeForType(type);
  highlightSelectedType(type);
  updateSizePicker();
  showConfigStep(false);
}

function highlightSelectedType(type) {
  document.querySelectorAll('.type-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.type === type);
  });
}

function showTypeStep() {
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
    vu_meter: 'cfg-vu',
    strip_panel: 'cfg-strip-panel',
    bus_panel: 'cfg-bus-panel',
  };

  const sectionId = sectionMap[type];
  if (sectionId) document.getElementById(sectionId).style.display = 'flex';
  document.getElementById('size-picker-group').style.display = 'block';
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

  if (control.type === 'desktop_action') {
    document.getElementById('cfg-desktop-kind').value = config.action || 'launch';
    document.getElementById('cfg-desktop-color').value = config.activeColor || '#3aa6ff';
    document.getElementById('cfg-desktop-target').value = config.target || '';
    document.getElementById('cfg-desktop-args').value = config.args || '';
    updateDesktopActionFields();
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

  const size = {
    colSpan: _selectedSize.colSpan,
    rowSpan: _selectedSize.rowSpan,
  };

  if (_editingId) {
    const control = findControl(_editingId);
    if (!control) return;

    const resolved = resolvePlacement(
      page.controls,
      {
        col: control.col,
        row: control.row,
        colSpan: size.colSpan,
        rowSpan: size.rowSpan,
      },
      control.id,
      currentGridColumns(),
    );

    control.col = resolved.col;
    control.row = resolved.row;
    control.colSpan = resolved.colSpan;
    control.rowSpan = resolved.rowSpan;
    control.config = config;
  } else {
    const placement = findNextOpenSlot(page.controls, size, currentGridColumns());
    page.controls.push({
      id: genId(),
      type,
      col: placement.col,
      row: placement.row,
      colSpan: size.colSpan,
      rowSpan: size.rowSpan,
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
    lock: 'Lock PC',
    sleep: 'Sleep PC',
    key_combo: 'Shortcut',
  };
  return labels[action] || 'Shortcut';
}

function desktopActionUiMeta(action) {
  const meta = {
    launch: {
      label: 'Path',
      placeholder: 'C:\\Program Files\\App\\app.exe or .lnk',
      help: 'Launch an app, folder, file, or shortcut on the Windows PC.',
    },
    open_url: {
      label: 'URL',
      placeholder: 'https://example.com',
      help: 'Open a website in the default browser on the Windows PC.',
    },
    key_combo: {
      label: 'Key Combo',
      placeholder: 'ctrl+alt+m',
      help: 'Send a keyboard shortcut like ctrl+shift+esc or win+d.',
    },
    screenshot: {
      label: 'Target',
      placeholder: '',
      help: 'Save a full-screen screenshot in the Windows Pictures\\VM Control Screenshots folder.',
    },
    media_play_pause: {
      label: 'Target',
      placeholder: '',
      help: 'Toggle media playback on the Windows PC.',
    },
    media_next: {
      label: 'Target',
      placeholder: '',
      help: 'Skip to the next media track.',
    },
    media_previous: {
      label: 'Target',
      placeholder: '',
      help: 'Go to the previous media track.',
    },
    volume_up: {
      label: 'Target',
      placeholder: '',
      help: 'Raise the system volume with one press per tap.',
    },
    volume_down: {
      label: 'Target',
      placeholder: '',
      help: 'Lower the system volume with one press per tap.',
    },
    volume_mute: {
      label: 'Target',
      placeholder: '',
      help: 'Toggle the system mute state.',
    },
    lock: {
      label: 'Target',
      placeholder: '',
      help: 'Lock the Windows workstation immediately.',
    },
    sleep: {
      label: 'Target',
      placeholder: '',
      help: 'Put the Windows PC to sleep.',
    },
  };

  return meta[action] || meta.launch;
}

function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  _editingId = null;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function applySettings() {
  const accentColor = document.getElementById('s-accent-color').value;
  const gridColumns = clampInt(document.getElementById('s-grid-cols').value, 4, 12);

  _state.layout.settings = {
    ...(_state.layout.settings || {}),
    accentColor,
    gridColumns,
  };

  _state.layout.pages.forEach(page => {
    page.controls.forEach(control => {
      control.colSpan = Math.min(control.colSpan || 1, gridColumns);
      control.col = Math.min(control.col || 1, gridColumns - control.colSpan + 1);
    });
  });

  closeSettings();
  _callbacks.commitLayout?.();
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

function importLayout(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = loadEvent => {
    try {
      const imported = JSON.parse(loadEvent.target.result);
      _callbacks.replaceLayout?.(imported);
      closeSettings();
    } catch {
      window.alert('Invalid layout JSON.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function buildSizePicker() {
  const picker = document.getElementById('size-picker');
  picker.innerHTML = '';
  const cols = Math.min(currentGridColumns(), 6);
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
  const cols = Math.min(currentGridColumns(), 6);
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

function startGridGesture({ mode, event, gridEl, card }) {
  const control = findControl(card.dataset.id);
  if (!control) return;

  const metrics = getGridMetrics(gridEl);
  const original = {
    col: control.col,
    row: control.row,
    colSpan: control.colSpan,
    rowSpan: control.rowSpan,
  };

  _gridGesture = {
    mode,
    gridEl,
    card,
    controlId: control.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    original,
    lastValid: original,
    metrics,
  };

  card.classList.add('is-dragging');
  showDropPreview(original, false);
  window.addEventListener('pointermove', onGridGestureMove);
  window.addEventListener('pointerup', endGridGesture);
  window.addEventListener('pointercancel', endGridGesture);
  event.preventDefault();
}

function onGridGestureMove(event) {
  if (!_gridGesture) return;

  const { mode, controlId, original, metrics } = _gridGesture;
  const page = currentPage();
  if (!page) return;

  const deltaCols = Math.round((event.clientX - _gridGesture.startX) / metrics.stepX);
  const deltaRows = Math.round((event.clientY - _gridGesture.startY) / metrics.stepY);

  if (mode === 'move') {
    const candidate = clampPlacement({
      col: original.col + deltaCols,
      row: original.row + deltaRows,
      colSpan: original.colSpan,
      rowSpan: original.rowSpan,
    }, metrics.cols);

    const resolved = resolvePlacement(page.controls, candidate, controlId, metrics.cols);
    _gridGesture.lastValid = resolved;
    showDropPreview(resolved, false);
    return;
  }

  const candidate = clampPlacement({
    col: original.col,
    row: original.row,
    colSpan: original.colSpan + deltaCols,
    rowSpan: original.rowSpan + deltaRows,
  }, metrics.cols);

  const blocked = collides(page.controls, candidate, controlId);
  if (!blocked) {
    _gridGesture.lastValid = candidate;
  }
  showDropPreview(blocked ? candidate : _gridGesture.lastValid, blocked);
}

function endGridGesture() {
  if (!_gridGesture) return;

  const { card, controlId, lastValid, original } = _gridGesture;
  card.classList.remove('is-dragging');

  const control = findControl(controlId);
  if (control && hasPlacementChanged(original, lastValid)) {
    control.col = lastValid.col;
    control.row = lastValid.row;
    control.colSpan = lastValid.colSpan;
    control.rowSpan = lastValid.rowSpan;
    _callbacks.commitLayout?.();
  } else {
    _callbacks.commitLayout?.({ persist: false, rerender: true });
  }

  hideDropPreview();
  window.removeEventListener('pointermove', onGridGestureMove);
  window.removeEventListener('pointerup', endGridGesture);
  window.removeEventListener('pointercancel', endGridGesture);
  _gridGesture = null;
}

function showDropPreview(placement, invalid) {
  const metrics = getGridMetrics(_gridGesture?.gridEl || document.getElementById('control-grid'));
  const rect = placementToPixels(metrics, placement);

  previewEl.style.display = 'block';
  previewEl.style.left = `${rect.left}px`;
  previewEl.style.top = `${rect.top}px`;
  previewEl.style.width = `${rect.width}px`;
  previewEl.style.height = `${rect.height}px`;
  previewEl.classList.toggle('invalid', !!invalid);
}

function hideDropPreview() {
  previewEl.style.display = 'none';
  previewEl.classList.remove('invalid');
}

function placementToPixels(metrics, placement) {
  return {
    left: metrics.gridOffsetLeft + (placement.col - 1) * metrics.stepX,
    top: metrics.gridOffsetTop + (placement.row - 1) * metrics.stepY,
    width: metrics.cellWidth * placement.colSpan + metrics.gap * (placement.colSpan - 1),
    height: metrics.rowHeight * placement.rowSpan + metrics.gap * (placement.rowSpan - 1),
  };
}

function getGridMetrics(gridEl) {
  const gridRect = gridEl.getBoundingClientRect();
  const mainRect = mainAreaEl.getBoundingClientRect();
  const styles = window.getComputedStyle(gridEl);
  const cols = currentGridColumns();
  const gap = Number.parseFloat(styles.columnGap || styles.gap || '8') || 8;
  const rowHeight = Number.parseFloat(styles.gridAutoRows || '80') || 80;
  const cellWidth = (gridRect.width - gap * (cols - 1)) / cols;

  return {
    cols,
    gap,
    rowHeight,
    cellWidth,
    stepX: cellWidth + gap,
    stepY: rowHeight + gap,
    gridOffsetLeft: gridRect.left - mainRect.left + mainAreaEl.scrollLeft,
    gridOffsetTop: gridRect.top - mainRect.top + mainAreaEl.scrollTop,
  };
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

function currentGridColumns() {
  return clampInt(_state.layout?.settings?.gridColumns ?? 8, 4, 12);
}

function findControl(id) {
  for (const page of _state.layout.pages || []) {
    const control = page.controls.find(item => item.id === id);
    if (control) return control;
  }
  return null;
}

function sizeForType(type) {
  const [colSpan, rowSpan] = DEFAULT_SIZES[type] || [1, 2];
  return { colSpan, rowSpan };
}

function clampPlacement(placement, cols) {
  const colSpan = clampInt(placement.colSpan, 1, cols);
  return {
    col: clampInt(placement.col, 1, cols - colSpan + 1),
    row: Math.max(1, clampInt(placement.row, 1, 999)),
    colSpan,
    rowSpan: Math.max(1, clampInt(placement.rowSpan, 1, 20)),
  };
}

function resolvePlacement(controls, candidate, ignoreId, cols) {
  const clamped = clampPlacement(candidate, cols);
  if (!collides(controls, clamped, ignoreId)) return clamped;

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let row = 1; row <= 120; row += 1) {
    for (let col = 1; col <= cols - clamped.colSpan + 1; col += 1) {
      const next = {
        col,
        row,
        colSpan: clamped.colSpan,
        rowSpan: clamped.rowSpan,
      };
      if (collides(controls, next, ignoreId)) continue;

      const score = Math.abs(next.row - clamped.row) * 10 + Math.abs(next.col - clamped.col);
      if (score < bestScore) {
        best = next;
        bestScore = score;
      }
    }
  }

  return best || clamped;
}

function findNextOpenSlot(controls, size, cols) {
  for (let row = 1; row <= 120; row += 1) {
    for (let col = 1; col <= cols - size.colSpan + 1; col += 1) {
      const candidate = {
        col,
        row,
        colSpan: size.colSpan,
        rowSpan: size.rowSpan,
      };
      if (!collides(controls, candidate)) return candidate;
    }
  }

  return {
    col: 1,
    row: 1,
    colSpan: size.colSpan,
    rowSpan: size.rowSpan,
  };
}

function collides(controls, candidate, ignoreId = null) {
  return controls.some(control => {
    if (ignoreId && control.id === ignoreId) return false;
    return rectsOverlap(control, candidate);
  });
}

function rectsOverlap(a, b) {
  const aRight = a.col + a.colSpan - 1;
  const aBottom = a.row + a.rowSpan - 1;
  const bRight = b.col + b.colSpan - 1;
  const bBottom = b.row + b.rowSpan - 1;

  return !(aRight < b.col || bRight < a.col || aBottom < b.row || bBottom < a.row);
}

function hasPlacementChanged(a, b) {
  return a.col !== b.col || a.row !== b.row || a.colSpan !== b.colSpan || a.rowSpan !== b.rowSpan;
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
