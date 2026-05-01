import { desktopAction, soundboardPlay, vmSet, vmMacro } from './socket.js';

// ── VM parameter catalogue ────────────────────────────────────────────────────
export const VM_STRIPS = Array.from({ length: 8 }, (_, i) => ({
  index: i,
  label:     i < 5 ? `In ${i + 1}`           : `Virt ${i - 4}`,
  fullLabel: i < 5 ? `Hardware In ${i + 1}`   : `Virtual In ${i - 4}`,
  isVirtual: i >= 5,
  params: {
    gain: `Strip[${i}].Gain`,
    mute: `Strip[${i}].Mute`, solo: `Strip[${i}].Solo`, mc: `Strip[${i}].MC`,
    a1: `Strip[${i}].A1`, a2: `Strip[${i}].A2`, a3: `Strip[${i}].A3`,
    a4: `Strip[${i}].A4`, a5: `Strip[${i}].A5`,
    b1: `Strip[${i}].B1`, b2: `Strip[${i}].B2`, b3: `Strip[${i}].B3`,
  },
}));

export const VM_BUSES = Array.from({ length: 8 }, (_, i) => ({
  index: i,
  label:     i < 5 ? `A${i + 1}`             : `B${i - 4}`,
  fullLabel: i < 5 ? `Bus A${i + 1}`          : `Virtual Bus B${i - 4}`,
  isVirtual: i >= 5,
  params: { gain: `Bus[${i}].Gain`, mute: `Bus[${i}].Mute` },
}));

export function buildParamOptions(gainsOnly = false) {
  const opts = [];
  if (gainsOnly) {
    VM_STRIPS.forEach(s => opts.push({ value: s.params.gain, label: `${s.fullLabel} — Gain` }));
    VM_BUSES.forEach(b  => opts.push({ value: b.params.gain,  label: `${b.fullLabel} — Gain` }));
    return opts;
  }
  VM_STRIPS.forEach(s => {
    opts.push({ value: s.params.gain, label: `${s.fullLabel} — Gain` });
    opts.push({ value: s.params.mute, label: `${s.fullLabel} — Mute` });
    opts.push({ value: s.params.solo, label: `${s.fullLabel} — Solo` });
    ['a1','a2','a3','a4','a5','b1','b2','b3'].forEach(k =>
      opts.push({ value: s.params[k], label: `${s.fullLabel} — ${k.toUpperCase()} Send` }));
  });
  VM_BUSES.forEach(b => {
    opts.push({ value: b.params.gain, label: `${b.fullLabel} — Gain` });
    opts.push({ value: b.params.mute, label: `${b.fullLabel} — Mute` });
  });
  return opts;
}

// ── Shared state refs ─────────────────────────────────────────────────────────
let _vmState = {};
let _desktopIcons = {};
let _soundboardDevice = null; // global default output device for soundboard buttons
export function setStateRef(stateObj, desktopIcons = {}, soundboardDevice = null) {
  _vmState = stateObj;
  _desktopIcons = desktopIcons;
  _soundboardDevice = soundboardDevice || null;
}

function isEditMode() {
  return document.body.classList.contains('edit-mode');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtDb(v) {
  if (v === undefined || v === null) return '—';
  const n = parseFloat(v);
  if (n <= -60) return '-∞';
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

// ── VU meter helpers ──────────────────────────────────────────────────────────
const NUM_SEGS = 24;
const SEG_YELLOW = 18;
const SEG_RED    = 22;

function buildVuColumn(id) {
  const col = document.createElement('div');
  col.className = 'vu-ch';
  if (id) col.id = id;
  for (let i = 0; i < NUM_SEGS; i++) {
    const s = document.createElement('div');
    s.className = 'vu-seg';
    col.appendChild(s);
  }
  return col;
}

export function updateVuColumn(col, linear) {
  if (!col) return;
  const db   = linear > 0 ? 20 * Math.log10(linear) : -Infinity;
  const norm = Math.min(1, Math.max(0, (db + 60) / 66));
  const lit  = Math.round(norm * NUM_SEGS);
  const segs = col.children;
  for (let i = 0; i < NUM_SEGS; i++) {
    const s = segs[i];
    if (i < lit) {
      s.className = `vu-seg ${i >= SEG_RED ? 'lit-r' : i >= SEG_YELLOW ? 'lit-y' : 'lit-g'}`;
    } else {
      s.className = 'vu-seg';
    }
  }
}

// ── Custom fader widget ───────────────────────────────────────────────────────
// Returns a div.fader-widget that exposes .setValue(v) and .setLevels(l, r).
export function createFaderWidget({ min = -60, max = 12, step = 0.1, value = 0, showVu = true, onChange }) {
  const widget = document.createElement('div');
  widget.className = 'fader-widget';
  widget.style.touchAction = 'none';

  // VU column (left)
  let vuCol = null;
  if (showVu) {
    vuCol = document.createElement('div');
    vuCol.className = 'fw-vu';
    for (let i = 0; i < NUM_SEGS; i++) {
      const s = document.createElement('div');
      s.className = 'fw-vu-seg';
      vuCol.appendChild(s);
    }
    widget.appendChild(vuCol);
  }

  // Track wrapper
  const trackWrap = document.createElement('div');
  trackWrap.className = 'fw-track-wrap';

  const track = document.createElement('div');
  track.className = 'fw-track';

  const fill  = document.createElement('div'); fill.className  = 'fw-fill';
  const unity = document.createElement('div'); unity.className = 'fw-unity';
  const thumb = document.createElement('div'); thumb.className = 'fw-thumb';

  track.appendChild(fill);
  track.appendChild(unity);
  track.appendChild(thumb);
  trackWrap.appendChild(track);
  widget.appendChild(trackWrap);

  // dB marks
  const marks = document.createElement('div');
  marks.className = 'fw-marks';
  ['+12', '0', '-12', '-24', '-48', '-∞'].forEach(m => {
    const mk = document.createElement('div');
    mk.className = 'fw-mark';
    mk.textContent = m;
    marks.appendChild(mk);
  });
  widget.appendChild(marks);

  // Unity position: (0 - min)/(max - min) = 60/72 ≈ 83.33%
  const unityPct = ((0 - min) / (max - min)) * 100;
  unity.style.bottom = unityPct.toFixed(2) + '%';

  let current = parseFloat(value);
  let dragging = false;

  function norm(v) { return Math.max(0, Math.min(1, (v - min) / (max - min))); }
  function fromNorm(n) {
    const raw = min + n * (max - min);
    return Math.round(raw / step) * step;
  }

  function updateDisplay(v) {
    const pct = norm(v) * 100;
    fill.style.height  = pct.toFixed(2) + '%';
    thumb.style.bottom = `calc(${pct.toFixed(2)}% - 8px)`;
  }
  updateDisplay(current);

  function posFromEvent(e) {
    const rect = track.getBoundingClientRect();
    const n = 1 - (e.clientY - rect.top) / rect.height;
    return fromNorm(Math.max(0, Math.min(1, n)));
  }

  trackWrap.addEventListener('pointerdown', e => {
    if (isEditMode()) return;
    dragging = true;
    trackWrap.setPointerCapture(e.pointerId);
    e.preventDefault();
    const v = posFromEvent(e);
    current = v;
    updateDisplay(v);
    onChange?.(v);
  });
  trackWrap.addEventListener('pointermove', e => {
    if (!dragging) return;
    const v = posFromEvent(e);
    if (v !== current) { current = v; updateDisplay(v); onChange?.(v); }
  });
  trackWrap.addEventListener('pointerup',     () => { dragging = false; });
  trackWrap.addEventListener('pointercancel', () => { dragging = false; });
  // Double-tap / double-click to reset to 0 dB
  let lastTap = 0;
  trackWrap.addEventListener('pointerdown', e => {
    if (isEditMode()) return;
    const now = Date.now();
    if (now - lastTap < 300) { current = 0; updateDisplay(0); onChange?.(0); }
    lastTap = now;
  });

  widget.setValue = v => { current = parseFloat(v); updateDisplay(current); };

  function paintVu(linear) {
    if (!vuCol) return;
    const db   = linear > 0 ? 20 * Math.log10(linear) : -Infinity;
    const norm2 = Math.min(1, Math.max(0, (db + 60) / 66));
    const lit   = Math.round(norm2 * NUM_SEGS);
    const segs  = vuCol.children;
    for (let i = 0; i < NUM_SEGS; i++) {
      const s = segs[i];
      if (i < lit) {
        s.className = `fw-vu-seg ${i >= SEG_RED ? 'lit-r' : i >= SEG_YELLOW ? 'lit-y' : 'lit-g'}`;
      } else {
        s.className = 'fw-vu-seg';
      }
    }
  }

  // Use the hotter of L/R so a strip doesn't appear dead when only one side has signal.
  widget.setLevels = (left, right = left) => {
    paintVu(Math.max(left ?? 0, right ?? 0));
  };

  widget.setLevel = (linear) => {
    paintVu(linear);
  };

  return widget;
}

// ── Edit overlay ──────────────────────────────────────────────────────────────
function editOverlay(ctrlId) {
  const ov = document.createElement('div');
  ov.className = 'edit-overlay';

  const editBtn = document.createElement('button');
  editBtn.className = 'edit-overlay-btn';
  editBtn.dataset.action = 'edit';
  editBtn.dataset.ctrlId = ctrlId;
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg> Edit`;

  const delBtn = document.createElement('button');
  delBtn.className = 'edit-overlay-btn danger';
  delBtn.dataset.action = 'delete';
  delBtn.dataset.ctrlId = ctrlId;
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
  </svg> Delete`;

  ov.appendChild(editBtn);
  ov.appendChild(delBtn);
  return ov;
}

function dragHandle() {
  const h = document.createElement('div');
  h.className = 'drag-handle';
  h.title = 'Drag to move';
  h.innerHTML = `<svg width="16" height="8" viewBox="0 0 16 8" fill="currentColor">
    <rect x="0" y="0" width="16" height="1.5" rx="1"/><rect x="0" y="3.25" width="16" height="1.5" rx="1"/>
    <rect x="0" y="6.5" width="16" height="1.5" rx="1"/>
  </svg>`;
  return h;
}

function resizeHandle() {
  const h = document.createElement('div');
  h.className = 'resize-handle';
  h.title = 'Drag to resize';
  h.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M9 1L1 9M5 9h4V5"/>
  </svg>`;
  return h;
}

function applyGridPlacement(card, ctrl) {
  if (ctrl.col)     card.style.gridColumnStart = ctrl.col;
  if (ctrl.colSpan) card.style.gridColumnEnd   = `span ${ctrl.colSpan}`;
  if (ctrl.row)     card.style.gridRowStart    = ctrl.row;
  if (ctrl.rowSpan) card.style.gridRowEnd      = `span ${ctrl.rowSpan}`;
}

// ── Fader control ─────────────────────────────────────────────────────────────
export function renderFader(ctrl, vmState) {
  const cfg   = ctrl.config || {};
  const param = cfg.parameter || 'Strip[0].Gain';
  const min   = cfg.min  ?? -60;
  const max   = cfg.max  ?? 12;
  const step  = cfg.step ?? 0.1;

  const card = document.createElement('div');
  card.className = 'control-card fader-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const labelEl = document.createElement('div');
  labelEl.className = 'fader-label';
  labelEl.textContent = cfg.label || 'Fader';

  const dbEl = document.createElement('div');
  dbEl.className = 'fader-db';
  dbEl.textContent = fmtDb(vmState[param] ?? 0) + ' dB';

  const widget = createFaderWidget({
    min, max, step,
    value:  vmState[param] ?? 0,
    showVu: cfg.showVu !== false,
    onChange(v) {
      dbEl.textContent = fmtDb(v) + ' dB';
      vmSet(param, parseFloat(v.toFixed(2)));
    },
  });

  card.appendChild(dragHandle());
  card.appendChild(labelEl);
  card.appendChild(widget);
  card.appendChild(dbEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card._updateState = (p, v) => {
    if (p === param) { widget.setValue(v); dbEl.textContent = fmtDb(v) + ' dB'; }
  };
  card._updateLevels = (levels) => {
    const m = param.match(/Strip\[(\d+)\]/);
    if (m) {
      const base = parseInt(m[1], 10) * 2;
      widget.setLevels(levels[base] ?? 0, levels[base + 1] ?? levels[base] ?? 0);
    }
  };
  return card;
}

// ── Toggle / Button ───────────────────────────────────────────────────────────
export function renderToggle(ctrl, vmState) {
  const cfg   = ctrl.config || {};
  const param = cfg.parameter || 'Strip[0].Mute';
  const color = cfg.activeColor || '#6c63ff';

  const card = document.createElement('div');
  card.className = 'control-card toggle-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const labelEl = document.createElement('div');
  labelEl.className = 'toggle-label';
  labelEl.textContent = cfg.label || 'Toggle';

  const stateEl = document.createElement('div');
  stateEl.className = 'toggle-state-text';

  card.appendChild(dragHandle());
  card.appendChild(labelEl);
  card.appendChild(stateEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  const dimColor = `rgba(${r},${g},${b},0.18)`;
  const hiColor  = `rgba(${r},${g},${b},0.35)`;

  function setActive(active) {
    card.classList.toggle('active', active);
    stateEl.textContent = active ? 'ON' : 'OFF';
    if (active) {
      card.style.background   = dimColor;
      card.style.borderColor  = hiColor;
      card.style.boxShadow    = `0 0 20px rgba(${r},${g},${b},0.2)`;
    } else {
      card.style.background   = '';
      card.style.borderColor  = '';
      card.style.boxShadow    = '';
    }
  }
  setActive(!!(vmState[param] ?? 0));

  let pressing = false;
  card.addEventListener('pointerdown', e => {
    if (isEditMode()) return;
    if (e.target.closest('.edit-overlay, .drag-handle, .resize-handle')) return;
    pressing = true;
    if (cfg.momentary) { setActive(true); vmSet(param, 1); }
  });
  window.addEventListener('pointerup', () => {
    if (!pressing) return;
    pressing = false;
    if (cfg.momentary) { setActive(false); vmSet(param, 0); }
  });
  card.addEventListener('click', e => {
    if (isEditMode()) return;
    if (e.target.closest('.edit-overlay, .drag-handle, .resize-handle')) return;
    if (cfg.momentary) return;
    const newVal = card.classList.contains('active') ? 0 : 1;
    setActive(!!newVal);
    vmSet(param, newVal);
  });

  card._updateState = (p, v) => { if (p === param) setActive(!!v); };
  return card;
}

// ── Macro button ──────────────────────────────────────────────────────────────
export function renderMacro(ctrl, vmState) {
  const cfg   = ctrl.config || {};
  const color = cfg.activeColor || '#ff9800';

  const card = document.createElement('div');
  card.className = 'control-card macro-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
  card.style.background  = `rgba(${r},${g},${b},0.18)`;
  card.style.borderColor = `rgba(${r},${g},${b},0.35)`;

  const labelEl = document.createElement('div');
  labelEl.className = 'macro-label';
  labelEl.textContent = cfg.label || 'Macro';

  card.appendChild(dragHandle());
  card.appendChild(labelEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card.addEventListener('pointerdown', e => {
    if (isEditMode()) return;
    if (e.target.closest('.edit-overlay, .drag-handle, .resize-handle')) return;
    const actions = cfg.actions || [];
    if (actions.length) vmMacro(actions.map(a => ({ param: a.param, value: a.value })));
    if (cfg.momentary) card.style.filter = 'brightness(1.4)';
  });
  card.addEventListener('pointerup', () => {
    if (isEditMode()) return;
    if (cfg.momentary) {
      card.style.filter = '';
      const off = (cfg.actions || []).map(a => ({ param: a.param, value: a.offValue ?? (a.value === 0 ? 1 : 0) }));
      if (off.length) vmMacro(off);
    }
  });

  card._updateState = () => {};
  return card;
}

// ── Desktop shortcut button ──────────────────────────────────────────────────
export function renderDesktopAction(ctrl) {
  const cfg = ctrl.config || {};
  const color = cfg.activeColor || '#3aa6ff';
  const action = cfg.action || 'launch';

  const card = document.createElement('div');
  card.className = 'control-card desktop-action-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  card.style.background = `rgba(${r},${g},${b},0.18)`;
  card.style.borderColor = `rgba(${r},${g},${b},0.35)`;
  card.style.boxShadow = `0 0 18px rgba(${r},${g},${b},0.14)`;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'desktop-action-icon';
  const iconImg = desktopActionIcon(action, cfg.target);
  if (iconImg) iconWrap.appendChild(iconImg);

  const labelEl = document.createElement('div');
  labelEl.className = 'desktop-action-label';
  labelEl.textContent = cfg.label || desktopActionTitle(action);

  card.appendChild(dragHandle());
  card.appendChild(iconWrap);
  card.appendChild(labelEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card.addEventListener('click', e => {
    if (isEditMode()) return;
    if (e.target.closest('.edit-overlay, .drag-handle, .resize-handle')) return;
    desktopAction({
      action,
      target: cfg.target || '',
      args: cfg.args || '',
      label: cfg.label || desktopActionTitle(action),
    });
  });

  card._updateState = () => {};
  return card;
}

// ── Strip Panel ───────────────────────────────────────────────────────────────
export function renderStripPanel(ctrl, vmState) {
  const cfg   = ctrl.config || {};
  const si    = cfg.stripIndex ?? 0;
  const strip = VM_STRIPS[si];
  const keys  = cfg.routingButtons || ['A1','A2','B1','B2'];

  const card = document.createElement('div');
  card.className = 'control-card strip-panel-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const nameEl = document.createElement('div');
  nameEl.className = 'strip-name';
  nameEl.textContent = cfg.label || strip.fullLabel;

  const faderArea = document.createElement('div');
  faderArea.className = 'strip-fader-area';

  const widget = createFaderWidget({
    min: -60, max: 12, step: 0.1,
    value:  vmState[strip.params.gain] ?? 0,
    showVu: true,
    onChange: v => vmSet(strip.params.gain, parseFloat(v.toFixed(2))),
  });
  widget.style.height = '100%';
  faderArea.appendChild(widget);

  const muteBtn = document.createElement('button');
  muteBtn.className = 'strip-mute-btn' + (vmState[strip.params.mute] ? ' muted' : '');
  muteBtn.textContent = vmState[strip.params.mute] ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    if (isEditMode()) return;
    vmSet(strip.params.mute, muteBtn.classList.contains('muted') ? 0 : 1);
  });

  const routingEl = document.createElement('div');
  routingEl.className = 'strip-routing';
  const routingBtns = {};
  keys.forEach(key => {
    const k = key.toLowerCase();
    const btn = document.createElement('button');
    btn.className = 'routing-btn' + (vmState[strip.params[k]] ? ' active' : '');
    btn.textContent = key;
    btn.dataset.key = k;
    btn.addEventListener('click', () => {
      if (isEditMode()) return;
      vmSet(strip.params[k], btn.classList.contains('active') ? 0 : 1);
    });
    routingEl.appendChild(btn);
    routingBtns[k] = btn;
  });

  card.appendChild(dragHandle());
  card.appendChild(nameEl);
  card.appendChild(faderArea);
  card.appendChild(muteBtn);
  card.appendChild(routingEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card._updateState = (p, v) => {
    if (p === strip.params.gain) { widget.setValue(v); }
    else if (p === strip.params.mute) { muteBtn.classList.toggle('muted', !!v); muteBtn.textContent = v ? 'MUTED' : 'MUTE'; }
    else { Object.entries(routingBtns).forEach(([k, btn]) => { if (p === strip.params[k]) btn.classList.toggle('active', !!v); }); }
  };
  card._updateLevels = (levels) => {
    const base = si * 2;
    widget.setLevels(levels[base] ?? 0, levels[base + 1] ?? levels[base] ?? 0);
  };
  return card;
}

// ── Bus Panel ─────────────────────────────────────────────────────────────────
export function renderBusPanel(ctrl, vmState) {
  const cfg = ctrl.config || {};
  const bi  = cfg.busIndex ?? 0;
  const bus = VM_BUSES[bi];

  const card = document.createElement('div');
  card.className = 'control-card bus-panel-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const nameEl = document.createElement('div');
  nameEl.className = 'bus-name';
  nameEl.textContent = cfg.label || bus.fullLabel;

  const typeEl = document.createElement('div');
  typeEl.className = 'bus-type';
  typeEl.textContent = bus.isVirtual ? 'Virtual Bus' : 'Hardware Bus';

  const faderArea = document.createElement('div');
  faderArea.className = 'bus-fader-area';

  const widget = createFaderWidget({
    min: -60, max: 12, step: 0.1,
    value: vmState[bus.params.gain] ?? 0,
    showVu: false,
    onChange: v => vmSet(bus.params.gain, parseFloat(v.toFixed(2))),
  });
  widget.style.height = '100%';
  faderArea.appendChild(widget);

  const muteBtn = document.createElement('button');
  muteBtn.className = 'strip-mute-btn' + (vmState[bus.params.mute] ? ' muted' : '');
  muteBtn.textContent = vmState[bus.params.mute] ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    if (isEditMode()) return;
    vmSet(bus.params.mute, muteBtn.classList.contains('muted') ? 0 : 1);
  });

  card.appendChild(dragHandle());
  card.appendChild(nameEl);
  card.appendChild(typeEl);
  card.appendChild(faderArea);
  card.appendChild(muteBtn);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card._updateState = (p, v) => {
    if (p === bus.params.gain) widget.setValue(v);
    else if (p === bus.params.mute) { muteBtn.classList.toggle('muted', !!v); muteBtn.textContent = v ? 'MUTED' : 'MUTE'; }
  };
  card._updateLevels = (levels) => widget.setLevel(levels[16 + bi * 8] ?? 0);
  return card;
}

// ── VU Meter ──────────────────────────────────────────────────────────────────
export function renderVuMeter(ctrl) {
  const cfg = ctrl.config || {};

  const card = document.createElement('div');
  card.className = 'control-card vu-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const labelEl = document.createElement('div');
  labelEl.className = 'vu-label';
  labelEl.textContent = cfg.label || 'Level';

  const metersEl = document.createElement('div');
  metersEl.className = 'vu-meters';

  const chL = buildVuColumn();
  const chR = buildVuColumn();
  metersEl.appendChild(chL);
  metersEl.appendChild(chR);

  const dbEl = document.createElement('div');
  dbEl.className = 'vu-db';
  dbEl.textContent = '-∞';

  card.appendChild(dragHandle());
  card.appendChild(labelEl);
  card.appendChild(metersEl);
  card.appendChild(dbEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card._updateState = () => {};
  card._updateLevels = (levels) => {
    const isBus  = cfg.busIndex !== undefined;
    const idx    = isBus ? cfg.busIndex ?? 0 : cfg.stripIndex ?? 0;
    const lIdx   = isBus ? 16 + idx * 8 : idx * 2;
    const lv = levels[lIdx] ?? 0;
    const rv = levels[lIdx + 1] ?? lv;
    updateVuColumn(chL, lv);
    updateVuColumn(chR, rv);
    const db = lv > 0 ? 20 * Math.log10(lv) : -Infinity;
    dbEl.textContent = isFinite(db) ? fmtDb(db) + ' dB' : '-∞';
  };
  return card;
}

// ── Label ─────────────────────────────────────────────────────────────────────
export function renderLabel(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card label-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const textEl = document.createElement('div');
  textEl.className = 'label-text';
  textEl.textContent = ctrl.config?.text || 'Label';

  card.appendChild(dragHandle());
  card.appendChild(textEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card._updateState = () => {};
  return card;
}

// ── Soundboard button ─────────────────────────────────────────────────────────
export function renderSoundboard(ctrl) {
  const cfg   = ctrl.config || {};
  const color = cfg.color || '#22c55e';

  const card = document.createElement('div');
  card.className = 'control-card soundboard-card';
  card.dataset.id = ctrl.id;
  applyGridPlacement(card, ctrl);

  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  card.style.background  = `rgba(${r},${g},${b},0.15)`;
  card.style.borderColor = `rgba(${r},${g},${b},0.3)`;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'soundboard-icon';
  iconWrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
      stroke-linecap="round" stroke-linejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" opacity=".85"/>
  </svg>`;

  const labelEl = document.createElement('div');
  labelEl.className = 'soundboard-label';
  labelEl.textContent = cfg.label || 'Sound';

  card.appendChild(dragHandle());
  card.appendChild(iconWrap);
  card.appendChild(labelEl);
  card.appendChild(editOverlay(ctrl.id));
  card.appendChild(resizeHandle());

  card.addEventListener('pointerdown', e => {
    if (isEditMode()) return;
    if (e.target.closest('.edit-overlay, .drag-handle, .resize-handle')) return;
    soundboardPlay(cfg.file, cfg.device || _soundboardDevice || null, cfg.volume ?? 1.0);
    card.classList.add('playing');
  });
  card.addEventListener('pointerup',     () => window.setTimeout(() => card.classList.remove('playing'), 260));
  card.addEventListener('pointercancel', () => card.classList.remove('playing'));

  card._updateState = () => {};
  return card;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
export function renderControl(ctrl, vmState) {
  switch (ctrl.type) {
    case 'fader':       return renderFader(ctrl, vmState);
    case 'toggle':
    case 'button':      return renderToggle(ctrl, vmState);
    case 'macro':       return renderMacro(ctrl, vmState);
    case 'desktop_action': return renderDesktopAction(ctrl);
    case 'soundboard':     return renderSoundboard(ctrl);
    case 'strip_panel': return renderStripPanel(ctrl, vmState);
    case 'bus_panel':   return renderBusPanel(ctrl, vmState);
    case 'vu_meter':    return renderVuMeter(ctrl, vmState);
    case 'label':       return renderLabel(ctrl);
    default: {
      const d = document.createElement('div');
      d.className = 'control-card'; d.style.padding = '12px';
      d.textContent = `Unknown type: ${ctrl.type}`;
      d.dataset.id = ctrl.id;
      applyGridPlacement(d, ctrl);
      return d;
    }
  }
}

function desktopActionTitle(action) {
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

function desktopActionIcon(action, target) {
  if (action === 'launch' && target && _desktopIcons[target]) {
    const img = document.createElement('img');
    img.className = 'desktop-action-app-icon';
    img.src = _desktopIcons[target];
    img.alt = '';
    return img;
  }

  const fallback = document.createElement('div');
  fallback.className = 'desktop-action-glyph';
  fallback.innerHTML = desktopActionSvg(action);
  return fallback;
}

function desktopActionSvg(action) {
  const icons = {
    launch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M8.5 19.5h7"/><path d="M12 16.5v3"/></svg>`,
    open_url: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4a12 12 0 0 1 0 16"/><path d="M12 4a12 12 0 0 0 0 16"/></svg>`,
    screenshot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l1.5-2h5L16 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2z"/><circle cx="12" cy="12" r="3.5"/></svg>`,
    media_play_pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h3v14H6zM15 5h3v14h-3z"/></svg>`,
    media_next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 6.5v11l8-5.5-8-5.5zM14 6.5v11l8-5.5-8-5.5z"/></svg>`,
    media_previous: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.5v11l-8-5.5 8-5.5zM10 6.5v11L2 12l8-5.5z"/></svg>`,
    volume_up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h4l5 4V6L8 10H4z"/><path d="M17 9a4 4 0 0 1 0 6"/><path d="M19.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>`,
    volume_down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h4l5 4V6L8 10H4z"/><path d="M18 9.5a4 4 0 0 1 0 5"/></svg>`,
    volume_mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h4l5 4V6L8 10H4z"/><path d="M17 9l5 6"/><path d="M22 9l-5 6"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1"/></svg>`,
    sleep: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14.5A6.5 6.5 0 1 1 9.5 6 5.5 5.5 0 0 0 18 14.5z"/></svg>`,
    key_combo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7 11.5h2M11 11.5h2M15 11.5h2"/><path d="M6 15h12"/></svg>`,
  };

  return icons[action] || icons.launch;
}
