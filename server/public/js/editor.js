// Editor — add/configure/reorder controls + settings panel
import { VM_STRIPS, VM_BUSES, buildParamOptions } from './controls.js';

let _state = null;   // shared app state ref
let _callbacks = {}; // { onSave, onDelete }

export function initEditor(state, callbacks) {
  _state = state;
  _callbacks = callbacks;

  // Populate param dropdowns
  populateParamDropdown('cfg-fader-param', buildParamOptions(true).filter(o => o.value.includes('Gain')));
  populateParamDropdown('cfg-toggle-param', buildParamOptions(false));

  // Populate strip/bus selectors
  const stripSel = document.getElementById('cfg-strip-select');
  VM_STRIPS.forEach(s => {
    const o = document.createElement('option');
    o.value = s.index; o.textContent = s.fullLabel;
    stripSel.appendChild(o);
  });
  const busSel = document.getElementById('cfg-bus-select');
  VM_BUSES.forEach(b => {
    const o = document.createElement('option');
    o.value = b.index; o.textContent = b.fullLabel;
    busSel.appendChild(o);
  });
  const vuSrc = document.getElementById('cfg-vu-source');
  VM_STRIPS.forEach(s => {
    const o = document.createElement('option');
    o.value = `strip-${s.index}`; o.textContent = `Strip: ${s.fullLabel}`;
    vuSrc.appendChild(o);
  });
  VM_BUSES.forEach(b => {
    const o = document.createElement('option');
    o.value = `bus-${b.index}`; o.textContent = `Bus: ${b.fullLabel}`;
    vuSrc.appendChild(o);
  });

  // Type card selection
  document.querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.type-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      showConfigSection(card.dataset.type);
      setDefaultSizes(card.dataset.type);
    });
  });

  // Modal close/cancel
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-backdrop')) closeModal();
  });
  document.getElementById('modal-save').addEventListener('click', saveControl);

  // Macro actions
  document.getElementById('btn-add-macro-action').addEventListener('click', addMacroAction);

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-modal')) closeSettings();
  });
  document.getElementById('settings-apply').addEventListener('click', applySettings);
  document.getElementById('s-add-page').addEventListener('click', () => openPageNameModal(null));
  document.getElementById('s-vm-restart').addEventListener('click', () => {
    import('./socket.js').then(({ vmMacro }) => vmMacro([{ param: 'Command.Restart', value: 1 }]));
  });

  // Export / Import
  document.getElementById('s-export').addEventListener('click', exportLayout);
  document.getElementById('s-import').addEventListener('click', () => document.getElementById('s-import-file').click());
  document.getElementById('s-import-file').addEventListener('change', importLayout);

  // FAB / empty state add
  document.getElementById('fab-add').addEventListener('click', () => openModal(null));
  document.getElementById('empty-add-btn')?.addEventListener('click', () => openModal(null));

  // Page name modal
  document.getElementById('page-modal-close').addEventListener('click', closePageModal);
  document.getElementById('page-modal-cancel').addEventListener('click', closePageModal);
  document.getElementById('page-modal-save').addEventListener('click', savePageName);
  document.getElementById('btn-add-page').addEventListener('click', () => openPageNameModal(null));

  // Edit mode button
  document.getElementById('btn-edit').addEventListener('click', toggleEditMode);
}

// ── Edit Mode ─────────────────────────────────────────────────────────────────
export function toggleEditMode() {
  _state.ui.editMode = !_state.ui.editMode;
  document.body.classList.toggle('edit-mode', _state.ui.editMode);
  const btn = document.getElementById('btn-edit');
  btn.classList.toggle('active', _state.ui.editMode);
  document.getElementById('fab-add').style.display = _state.ui.editMode ? 'flex' : 'none';
  document.getElementById('btn-add-page').style.display = _state.ui.editMode ? 'flex' : 'none';
}

// ── Grid event delegation ─────────────────────────────────────────────────────
export function initGridEvents(gridEl) {
  gridEl.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-action="edit"]');
    const delBtn  = e.target.closest('[data-action="delete"]');
    if (editBtn) { e.stopPropagation(); openModal(editBtn.dataset.ctrlId); }
    if (delBtn)  { e.stopPropagation(); deleteControl(delBtn.dataset.ctrlId); }
  });

  // Drag to reorder
  let dragSrc = null;
  gridEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.control-card');
    if (!card || !_state.ui.editMode) return;
    dragSrc = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  gridEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.control-card');
    if (card && card.dataset.id !== dragSrc) {
      document.querySelectorAll('.control-card.drag-over').forEach(c => c.classList.remove('drag-over'));
      card.classList.add('drag-over');
    }
  });
  gridEl.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.control-card');
    if (card) card.classList.remove('drag-over');
  });
  gridEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('.control-card');
    if (!target || !dragSrc || target.dataset.id === dragSrc) return;
    reorderControl(dragSrc, target.dataset.id);
    document.querySelectorAll('.control-card.drag-over').forEach(c => c.classList.remove('drag-over'));
  });
  gridEl.addEventListener('dragend', () => {
    document.querySelectorAll('.control-card.dragging').forEach(c => c.classList.remove('dragging'));
    dragSrc = null;
  });

  // Make cards draggable when in edit mode
  const obs = new MutationObserver(() => {
    gridEl.querySelectorAll('.control-card').forEach(c => {
      c.draggable = _state.ui.editMode;
    });
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function reorderControl(srcId, targetId) {
  const page = currentPage();
  if (!page) return;
  const controls = page.controls;
  const srcIdx = controls.findIndex(c => c.id === srcId);
  const tgtIdx = controls.findIndex(c => c.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0) return;
  const [item] = controls.splice(srcIdx, 1);
  controls.splice(tgtIdx, 0, item);
  _callbacks.onSave?.();
}

function deleteControl(id) {
  const page = currentPage();
  if (!page) return;
  page.controls = page.controls.filter(c => c.id !== id);
  _callbacks.onDelete?.(id);
  _callbacks.onSave?.();
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────
let _editingId = null;

export function openModal(ctrlId) {
  _editingId = ctrlId;
  const isEdit = !!ctrlId;

  document.getElementById('modal-title').textContent = isEdit ? 'Edit Control' : 'Add Control';
  resetModal();

  if (isEdit) {
    const ctrl = findControl(ctrlId);
    if (!ctrl) return;
    populateModal(ctrl);
    document.getElementById('step-type').style.display = 'none';
    document.getElementById('step-config').style.display = 'flex';
  } else {
    document.getElementById('step-type').style.display = 'flex';
    document.getElementById('step-config').style.display = 'none';
  }

  document.getElementById('modal-backdrop').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-backdrop').style.display = 'none';
  _editingId = null;
}

function resetModal() {
  document.querySelectorAll('.type-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.cfg-section').forEach(s => s.style.display = 'none');
  document.getElementById('cfg-label').value = '';
  document.getElementById('cfg-col-span').value = '1';
  document.getElementById('cfg-row-span').value = '4';
  document.getElementById('macro-actions-list').innerHTML = '';
}

function showConfigSection(type) {
  document.querySelectorAll('.cfg-section').forEach(s => s.style.display = 'none');
  document.getElementById('step-type').style.display = 'none';
  document.getElementById('step-config').style.display = 'flex';

  const map = {
    fader: 'cfg-fader',
    toggle: 'cfg-toggle',
    button: 'cfg-toggle',
    macro: 'cfg-macro',
    vu_meter: 'cfg-vu',
    strip_panel: 'cfg-strip-panel',
    bus_panel: 'cfg-bus-panel',
  };
  const sectionId = map[type];
  if (sectionId) document.getElementById(sectionId).style.display = 'flex';
}

function setDefaultSizes(type) {
  const defaults = {
    fader: [1, 4],
    toggle: [1, 1],
    button: [2, 1],
    macro: [2, 1],
    vu_meter: [1, 3],
    strip_panel: [1, 4],
    bus_panel: [1, 3],
    label: [2, 1],
  };
  const [cols, rows] = defaults[type] || [1, 2];
  document.getElementById('cfg-col-span').value = cols;
  document.getElementById('cfg-row-span').value = rows;
}

function populateModal(ctrl) {
  showConfigSection(ctrl.type);
  const cfg = ctrl.config || {};
  document.getElementById('cfg-label').value = cfg.label || cfg.text || '';
  document.getElementById('cfg-col-span').value = ctrl.colSpan || 1;
  document.getElementById('cfg-row-span').value = ctrl.rowSpan || 2;

  if (ctrl.type === 'fader') {
    setSelectValue('cfg-fader-param', cfg.parameter);
    document.getElementById('cfg-fader-min').value = cfg.min ?? -60;
    document.getElementById('cfg-fader-max').value = cfg.max ?? 12;
    document.getElementById('cfg-fader-step').value = cfg.step ?? 0.1;
    document.getElementById('cfg-fader-vu').checked = cfg.showVu !== false;
  } else if (ctrl.type === 'toggle' || ctrl.type === 'button') {
    setSelectValue('cfg-toggle-param', cfg.parameter);
    document.getElementById('cfg-toggle-color').value = cfg.activeColor || '#6c63ff';
    document.getElementById('cfg-toggle-momentary').checked = !!cfg.momentary;
  } else if (ctrl.type === 'macro') {
    document.getElementById('cfg-macro-color').value = cfg.activeColor || '#ff9800';
    document.getElementById('cfg-macro-momentary').checked = !!cfg.momentary;
    (cfg.actions || []).forEach(a => addMacroAction(a));
  } else if (ctrl.type === 'vu_meter') {
    const src = cfg.stripIndex !== undefined ? `strip-${cfg.stripIndex}` : `bus-${cfg.busIndex ?? 0}`;
    setSelectValue('cfg-vu-source', src);
  } else if (ctrl.type === 'strip_panel') {
    document.getElementById('cfg-strip-select').value = cfg.stripIndex ?? 0;
    const checks = document.querySelectorAll('#cfg-strip-routing input');
    checks.forEach(c => { c.checked = (cfg.routingButtons || ['A1','A2','B1','B2']).includes(c.value); });
  } else if (ctrl.type === 'bus_panel') {
    document.getElementById('cfg-bus-select').value = cfg.busIndex ?? 0;
  }
}

function saveControl() {
  const type = _editingId ? findControl(_editingId)?.type : document.querySelector('.type-card.selected')?.dataset.type;
  if (!type && !_editingId) { alert('Please select a control type'); return; }

  const label = document.getElementById('cfg-label').value.trim();
  const colSpan = parseInt(document.getElementById('cfg-col-span').value);
  const rowSpan = parseInt(document.getElementById('cfg-row-span').value);

  let config = {};
  const resolvedType = _editingId ? findControl(_editingId)?.type : type;

  if (resolvedType === 'fader') {
    config = {
      label: label || 'Fader',
      parameter: document.getElementById('cfg-fader-param').value,
      min: parseFloat(document.getElementById('cfg-fader-min').value),
      max: parseFloat(document.getElementById('cfg-fader-max').value),
      step: parseFloat(document.getElementById('cfg-fader-step').value),
      showVu: document.getElementById('cfg-fader-vu').checked,
    };
  } else if (resolvedType === 'toggle' || resolvedType === 'button') {
    config = {
      label: label || 'Button',
      parameter: document.getElementById('cfg-toggle-param').value,
      activeColor: document.getElementById('cfg-toggle-color').value,
      momentary: document.getElementById('cfg-toggle-momentary').checked,
    };
  } else if (resolvedType === 'macro') {
    const actionRows = document.querySelectorAll('.macro-action-row');
    const actions = [];
    actionRows.forEach(row => {
      const p = row.querySelector('.macro-param').value;
      const v = parseFloat(row.querySelector('.macro-value').value);
      if (p) actions.push({ param: p, value: v });
    });
    config = {
      label: label || 'Macro',
      activeColor: document.getElementById('cfg-macro-color').value,
      momentary: document.getElementById('cfg-macro-momentary').checked,
      actions,
    };
  } else if (resolvedType === 'vu_meter') {
    const src = document.getElementById('cfg-vu-source').value;
    const [kind, idx] = src.split('-');
    config = {
      label: label || 'Level',
      ...(kind === 'strip' ? { stripIndex: parseInt(idx) } : { busIndex: parseInt(idx) })
    };
  } else if (resolvedType === 'strip_panel') {
    const si = parseInt(document.getElementById('cfg-strip-select').value);
    const routingButtons = [...document.querySelectorAll('#cfg-strip-routing input:checked')].map(c => c.value);
    config = { label: label || VM_STRIPS[si].fullLabel, stripIndex: si, routingButtons };
  } else if (resolvedType === 'bus_panel') {
    const bi = parseInt(document.getElementById('cfg-bus-select').value);
    config = { label: label || VM_BUSES[bi].fullLabel, busIndex: bi };
  } else if (resolvedType === 'label') {
    config = { text: label || 'Label' };
  }

  if (_editingId) {
    const ctrl = findControl(_editingId);
    if (ctrl) { ctrl.config = config; ctrl.colSpan = colSpan; ctrl.rowSpan = rowSpan; }
  } else {
    const page = currentPage();
    if (page) {
      page.controls.push({ id: genId(), type: resolvedType, colSpan, rowSpan, config });
    }
  }

  closeModal();
  _callbacks.onSave?.();
}

function addMacroAction(preset = {}) {
  const list = document.getElementById('macro-actions-list');
  const row = document.createElement('div');
  row.className = 'macro-action-row';

  const pSel = document.createElement('select');
  pSel.className = 'form-select macro-param';
  buildParamOptions(true).forEach(({ value, label }) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    pSel.appendChild(o);
  });
  if (preset.param) setSelectValue2(pSel, preset.param);

  const vInput = document.createElement('input');
  vInput.type = 'number'; vInput.className = 'form-input macro-value';
  vInput.step = '0.1'; vInput.value = preset.value ?? 1;
  vInput.style.maxWidth = '80px';

  const del = document.createElement('button');
  del.className = 'macro-action-del'; del.textContent = '×';
  del.addEventListener('click', () => row.remove());

  row.appendChild(pSel);
  row.appendChild(vInput);
  row.appendChild(del);
  list.appendChild(row);
}

// ── Settings Modal ────────────────────────────────────────────────────────────
export function openSettings() {
  const settings = _state.layout?.settings || {};
  document.getElementById('s-accent-color').value = settings.accentColor || '#6c63ff';
  document.getElementById('s-grid-cols').value = settings.gridColumns || 8;

  // Bridge info
  const info = _state.bridge || {};
  const vmTypeNames = { 1: 'VoiceMeeter', 2: 'VoiceMeeter Banana', 3: 'VoiceMeeter Potato' };
  document.getElementById('s-status').textContent = info.connected ? '🟢 Connected' : '🔴 Disconnected';
  document.getElementById('s-vm-type').textContent = vmTypeNames[info.vmType] || '—';
  document.getElementById('s-vm-version').textContent = info.vmVersion || '—';

  // Pages list
  renderPagesList();
  document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function applySettings() {
  const accentColor = document.getElementById('s-accent-color').value;
  const gridColumns = parseInt(document.getElementById('s-grid-cols').value);

  if (!_state.layout.settings) _state.layout.settings = {};
  _state.layout.settings.accentColor = accentColor;
  _state.layout.settings.gridColumns = gridColumns;

  document.documentElement.style.setProperty('--accent', accentColor);
  document.querySelector('.control-grid')?.style.setProperty('--grid-cols', gridColumns);

  _callbacks.onSave?.();
  closeSettings();
}

function renderPagesList() {
  const listEl = document.getElementById('pages-list');
  listEl.innerHTML = '';
  (_state.layout?.pages || []).forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'page-item';

    const input = document.createElement('input');
    input.type = 'text'; input.value = page.name;
    input.addEventListener('change', () => { page.name = input.value; _callbacks.onSave?.(); });

    const del = document.createElement('button');
    del.className = 'page-item-del'; del.textContent = '×';
    del.addEventListener('click', () => {
      if (_state.layout.pages.length <= 1) { alert('Cannot delete the last page.'); return; }
      _state.layout.pages.splice(i, 1);
      if (_state.ui.currentPage >= _state.layout.pages.length) _state.ui.currentPage = 0;
      renderPagesList();
      _callbacks.onSave?.();
    });

    item.appendChild(input);
    item.appendChild(del);
    listEl.appendChild(item);
  });
}

// ── Page modal ─────────────────────────────────────────────────────────────────
let _pageEditIndex = null;
export function openPageNameModal(index) {
  _pageEditIndex = index;
  const isEdit = index !== null;
  document.getElementById('page-modal-title').textContent = isEdit ? 'Rename Page' : 'Add Page';
  document.getElementById('page-name-input').value = isEdit ? _state.layout.pages[index]?.name || '' : '';
  document.getElementById('page-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('page-name-input').focus(), 50);
}
function closePageModal() { document.getElementById('page-modal').style.display = 'none'; }
function savePageName() {
  const name = document.getElementById('page-name-input').value.trim() || 'Page';
  if (_pageEditIndex !== null) {
    _state.layout.pages[_pageEditIndex].name = name;
  } else {
    _state.layout.pages.push({ id: genId(), name, grid: { columns: 8 }, controls: [] });
  }
  closePageModal();
  _callbacks.onSave?.();
}

// ── Export / Import ───────────────────────────────────────────────────────────
function exportLayout() {
  const json = JSON.stringify(_state.layout, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = 'vm-layout.json'; a.click();
  URL.revokeObjectURL(url);
}

function importLayout(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      Object.assign(_state.layout, imported);
      _callbacks.onSave?.();
      closeSettings();
    } catch { alert('Invalid layout file'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function currentPage() {
  return _state.layout?.pages?.[_state.ui.currentPage];
}
function findControl(id) {
  for (const page of _state.layout?.pages || []) {
    const c = page.controls.find(c => c.id === id);
    if (c) return c;
  }
  return null;
}
function genId() { return 'ctrl_' + Math.random().toString(36).slice(2, 9); }
function populateParamDropdown(id, opts) {
  const sel = document.getElementById(id);
  opts.forEach(({ value, label }) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  });
}
function setSelectValue(id, val) { const el = document.getElementById(id); if (el && val) el.value = val; }
function setSelectValue2(el, val) { if (el && val) el.value = val; }
