import { vmSet, vmMacro } from './socket.js';

// ── Voicemeeter parameter catalogue ──────────────────────────────────────────

export const VM_STRIPS = Array.from({ length: 8 }, (_, i) => ({
  index: i,
  label: i < 5 ? `In ${i + 1}` : `Virt ${i - 4}`,
  fullLabel: i < 5 ? `Hardware In ${i + 1}` : `Virtual In ${i - 4}`,
  isVirtual: i >= 5,
  params: {
    gain: `Strip[${i}].Gain`,
    mute: `Strip[${i}].Mute`,
    solo: `Strip[${i}].Solo`,
    mc:   `Strip[${i}].MC`,
    a1: `Strip[${i}].A1`, a2: `Strip[${i}].A2`, a3: `Strip[${i}].A3`,
    a4: `Strip[${i}].A4`, a5: `Strip[${i}].A5`,
    b1: `Strip[${i}].B1`, b2: `Strip[${i}].B2`, b3: `Strip[${i}].B3`,
  }
}));

export const VM_BUSES = Array.from({ length: 8 }, (_, i) => ({
  index: i,
  label: i < 5 ? `A${i + 1}` : `B${i - 4}`,
  fullLabel: i < 5 ? `Bus A${i + 1}` : `Virtual Bus B${i - 4}`,
  isVirtual: i >= 5,
  params: {
    gain: `Bus[${i}].Gain`,
    mute: `Bus[${i}].Mute`,
  }
}));

export function buildParamOptions(includeGain = true) {
  const opts = [];
  if (includeGain) {
    VM_STRIPS.forEach(s => opts.push({ value: s.params.gain, label: `${s.fullLabel} — Gain` }));
    VM_BUSES.forEach(b => opts.push({ value: b.params.gain, label: `${b.fullLabel} — Gain` }));
  }
  VM_STRIPS.forEach(s => {
    opts.push({ value: s.params.mute, label: `${s.fullLabel} — Mute` });
    opts.push({ value: s.params.solo, label: `${s.fullLabel} — Solo` });
    ['a1','a2','a3','a4','a5','b1','b2','b3'].forEach(k =>
      opts.push({ value: s.params[k], label: `${s.fullLabel} — ${k.toUpperCase()} Send` }));
  });
  VM_BUSES.forEach(b => opts.push({ value: b.params.mute, label: `${b.fullLabel} — Mute` }));
  return opts;
}

// ── State reference (set from app.js) ────────────────────────────────────────
let _vmState = {};
let _levels = [];
export function setStateRef(stateObj, levelsArr) {
  _vmState = stateObj;
  _levels = levelsArr;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function formatDb(v) {
  if (v === undefined || v === null) return '—';
  const n = parseFloat(v);
  if (n <= -60) return '-∞';
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ── VU meter helpers ──────────────────────────────────────────────────────────
const NUM_SEGS = 24;
const SEG_GREEN  = 18;  // 0–17: green
const SEG_YELLOW = 22;  // 18–21: yellow
// 22–23: red

function buildVuChannel(containerId) {
  const ch = document.createElement('div');
  ch.className = 'vu-channel';
  ch.id = containerId;
  for (let i = 0; i < NUM_SEGS; i++) {
    const seg = document.createElement('div');
    seg.className = `vu-seg inactive ${i >= SEG_RED ? 'seg-red' : i >= SEG_YELLOW ? 'seg-yellow' : 'seg-green'}`;
    ch.appendChild(seg);
  }
  return ch;
}
const SEG_RED = 22;

function updateVuChannel(container, linearLevel) {
  if (!container) return;
  const db = linearLevel > 0 ? 20 * Math.log10(linearLevel) : -Infinity;
  // Map -60..+6 dB to 0..1
  const norm = clamp((db + 60) / 66, 0, 1);
  const lit = Math.round(norm * NUM_SEGS);
  const segs = container.children;
  for (let i = 0; i < NUM_SEGS; i++) {
    segs[i].classList.toggle('inactive', i >= lit);
  }
}

// ── Control renderers ─────────────────────────────────────────────────────────

/**
 * Fader control
 * cfg: { label, parameter, min, max, step, showVu }
 */
export function renderFader(ctrl, vmState) {
  const cfg = ctrl.config;
  const param = cfg.parameter;
  const min = cfg.min ?? -60;
  const max = cfg.max ?? 12;
  const step = cfg.step ?? 0.1;
  const currentVal = vmState[param] ?? 0;

  const card = document.createElement('div');
  card.className = 'control-card fader-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 1}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 4}`;
  card.dataset.id = ctrl.id;

  const label = document.createElement('div');
  label.className = 'fader-label';
  label.textContent = cfg.label || 'Fader';

  const value = document.createElement('div');
  value.className = 'fader-value';
  value.textContent = formatDb(currentVal) + ' dB';

  const wrapper = document.createElement('div');
  wrapper.className = 'fader-wrapper';

  const track = document.createElement('div');
  track.className = 'fader-track';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'fader-input';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = currentVal;

  // VU meter channel (shown beside fader)
  let vuL = null, vuR = null;
  if (cfg.showVu !== false) {
    vuL = document.createElement('div');
    vuL.className = 'fader-vu';
    vuL.id = `vu-${ctrl.id}-L`;
    for (let i = 0; i < NUM_SEGS; i++) {
      const s = document.createElement('div');
      s.className = `vu-seg inactive ${i >= SEG_RED ? 'seg-red' : i >= SEG_YELLOW ? 'seg-yellow' : 'seg-green'}`;
      vuL.appendChild(s);
    }
    wrapper.appendChild(vuL);
  }

  wrapper.appendChild(track);
  wrapper.appendChild(input);

  // dB marks
  const marks = document.createElement('div');
  marks.className = 'fader-marks';
  ['+12', '0', '-12', '-24', '-48', '-60'].forEach(m => {
    const mk = document.createElement('div');
    mk.className = 'fader-mark';
    mk.textContent = m;
    marks.appendChild(mk);
  });
  wrapper.appendChild(marks);

  let sending = false;
  function onInput() {
    const v = parseFloat(input.value);
    value.textContent = formatDb(v) + ' dB';
    vmSet(param, v);
    sending = true;
    setTimeout(() => { sending = false; }, 100);
  }

  input.addEventListener('input', onInput);
  input.addEventListener('change', onInput);

  card.appendChild(label);
  card.appendChild(wrapper);
  card.appendChild(value);
  card.appendChild(buildEditOverlay(ctrl));

  // Expose update function
  card._updateState = (p, v) => {
    if (p === param && !sending) {
      input.value = v;
      value.textContent = formatDb(v) + ' dB';
    }
  };
  card._updateLevels = (levels) => {
    if (!vuL) return;
    // Determine channel indices for this strip's pre-fader levels
    // Type 2 = post-mute, starts at strip*2 for hardware, virtual different
    const cfg2 = ctrl.config;
    // We'll use the vu source if explicitly set, otherwise try to parse from param
    const match = param.match(/Strip\[(\d+)\]/);
    if (match) {
      const si = parseInt(match[1]);
      const lIdx = si * 2;
      const rIdx = lIdx + 1;
      updateVuChannel(vuL, levels[lIdx] ?? 0);
    }
  };

  return card;
}

/**
 * Toggle button
 * cfg: { label, parameter, activeColor, momentary }
 */
export function renderToggle(ctrl, vmState) {
  const cfg = ctrl.config;
  const param = cfg.parameter;
  const color = cfg.activeColor || '#6c63ff';
  const currentVal = !!(vmState[param] ?? 0);

  const card = document.createElement('div');
  card.className = 'control-card toggle-card' + (currentVal ? ' active' : '');
  card.style.gridColumn = `span ${ctrl.colSpan || 1}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 1}`;
  card.dataset.id = ctrl.id;
  if (currentVal) card.style.background = hexDim(color, 0.2);
  if (currentVal) card.style.borderColor = hexDim(color, 0.4);

  const labelEl = document.createElement('div');
  labelEl.className = 'toggle-label';
  labelEl.textContent = cfg.label || 'Toggle';

  const stateEl = document.createElement('div');
  stateEl.className = 'toggle-state';
  stateEl.textContent = currentVal ? 'ON' : 'OFF';

  card.appendChild(labelEl);
  card.appendChild(stateEl);
  card.appendChild(buildEditOverlay(ctrl));

  function setActive(v) {
    card.classList.toggle('active', v);
    stateEl.textContent = v ? 'ON' : 'OFF';
    card.style.background = v ? hexDim(color, 0.18) : '';
    card.style.borderColor = v ? hexDim(color, 0.4) : '';
  }

  let pressing = false;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.edit-overlay')) return;
    pressing = true;
    if (cfg.momentary) {
      setActive(true);
      vmSet(param, 1);
    }
  });
  window.addEventListener('pointerup', () => {
    if (!pressing) return;
    pressing = false;
    if (cfg.momentary) {
      setActive(false);
      vmSet(param, 0);
    }
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('.edit-overlay')) return;
    if (cfg.momentary) return;
    const newVal = card.classList.contains('active') ? 0 : 1;
    setActive(!!newVal);
    vmSet(param, newVal);
  });

  card._updateState = (p, v) => {
    if (p === param) setActive(!!v);
  };

  return card;
}

/**
 * Macro button — fires multiple param changes at once
 * cfg: { label, activeColor, momentary, actions: [{ param, value, offValue? }] }
 */
export function renderMacro(ctrl, vmState) {
  const cfg = ctrl.config;
  const color = cfg.activeColor || '#ff9800';

  const card = document.createElement('div');
  card.className = 'control-card macro-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 2}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 1}`;
  card.style.background = hexDim(color, 0.2);
  card.style.borderColor = hexDim(color, 0.4);
  card.dataset.id = ctrl.id;

  const labelEl = document.createElement('div');
  labelEl.className = 'macro-label';
  labelEl.textContent = cfg.label || 'Macro';
  card.appendChild(labelEl);
  card.appendChild(buildEditOverlay(ctrl));

  let active = false;

  function fire(on) {
    const actions = cfg.actions || [];
    if (actions.length === 0) return;
    const params = actions.map(a => ({
      param: a.param,
      value: on ? a.value : (a.offValue ?? (a.value === 0 ? 1 : 0))
    }));
    vmMacro(params);
    active = on;
  }

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.edit-overlay')) return;
    fire(true);
    if (cfg.momentary) card.style.filter = 'brightness(1.3)';
  });
  card.addEventListener('pointerup', () => {
    if (cfg.momentary) { fire(false); card.style.filter = ''; }
  });

  card._updateState = () => {};
  return card;
}

/**
 * Strip panel — fader + mute + bus routing buttons
 * cfg: { label, stripIndex, routingButtons: ['A1','B1',...] }
 */
export function renderStripPanel(ctrl, vmState) {
  const cfg = ctrl.config;
  const si = cfg.stripIndex ?? 0;
  const strip = VM_STRIPS[si];
  const routingKeys = cfg.routingButtons || ['A1', 'A2', 'B1', 'B2'];

  const card = document.createElement('div');
  card.className = 'control-card strip-panel-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 1}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 4}`;
  card.dataset.id = ctrl.id;

  const nameEl = document.createElement('div');
  nameEl.className = 'strip-panel-name';
  nameEl.textContent = cfg.label || strip.fullLabel;

  // Mini fader
  const faderWrapper = document.createElement('div');
  faderWrapper.className = 'strip-panel-fader';

  const fInput = document.createElement('input');
  fInput.type = 'range';
  fInput.className = 'fader-input';
  fInput.min = -60; fInput.max = 12; fInput.step = 0.1;
  fInput.value = vmState[strip.params.gain] ?? 0;
  fInput.style.width = '100%';
  fInput.style.height = '100%';

  faderWrapper.appendChild(fInput);

  const gainVal = document.createElement('div');
  gainVal.className = 'fader-value';
  gainVal.style.fontSize = '11px';
  gainVal.textContent = formatDb(vmState[strip.params.gain] ?? 0) + ' dB';

  fInput.addEventListener('input', () => {
    const v = parseFloat(fInput.value);
    gainVal.textContent = formatDb(v) + ' dB';
    vmSet(strip.params.gain, v);
  });

  // Mute
  const muteBtn = document.createElement('button');
  muteBtn.className = 'strip-panel-mute' + (vmState[strip.params.mute] ? ' muted' : '');
  muteBtn.textContent = vmState[strip.params.mute] ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    const isMuted = muteBtn.classList.contains('muted');
    vmSet(strip.params.mute, isMuted ? 0 : 1);
  });

  // Routing buttons
  const routingEl = document.createElement('div');
  routingEl.className = 'strip-routing';
  const routingBtns = {};
  routingKeys.forEach(key => {
    const paramKey = key.toLowerCase();
    const btn = document.createElement('button');
    btn.className = 'routing-btn' + (vmState[strip.params[paramKey]] ? ' active' : '');
    btn.textContent = key;
    btn.dataset.bus = key;
    btn.addEventListener('click', () => {
      const isActive = btn.classList.contains('active');
      vmSet(strip.params[paramKey], isActive ? 0 : 1);
    });
    routingEl.appendChild(btn);
    routingBtns[paramKey] = btn;
  });

  card.appendChild(nameEl);
  card.appendChild(faderWrapper);
  card.appendChild(gainVal);
  card.appendChild(muteBtn);
  card.appendChild(routingEl);
  card.appendChild(buildEditOverlay(ctrl));

  card._updateState = (p, v) => {
    if (p === strip.params.gain) {
      fInput.value = v;
      gainVal.textContent = formatDb(v) + ' dB';
    } else if (p === strip.params.mute) {
      muteBtn.classList.toggle('muted', !!v);
      muteBtn.textContent = v ? 'MUTED' : 'MUTE';
    } else {
      Object.entries(routingBtns).forEach(([k, btn]) => {
        if (p === strip.params[k]) btn.classList.toggle('active', !!v);
      });
    }
  };

  return card;
}

/**
 * Bus panel — gain fader + mute
 * cfg: { label, busIndex }
 */
export function renderBusPanel(ctrl, vmState) {
  const cfg = ctrl.config;
  const bi = cfg.busIndex ?? 0;
  const bus = VM_BUSES[bi];

  const card = document.createElement('div');
  card.className = 'control-card bus-panel-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 1}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 3}`;
  card.dataset.id = ctrl.id;

  const nameEl = document.createElement('div');
  nameEl.className = 'bus-panel-name';
  nameEl.textContent = cfg.label || bus.fullLabel;

  const typeEl = document.createElement('div');
  typeEl.className = 'bus-panel-type';
  typeEl.textContent = bus.isVirtual ? 'Virtual Bus' : 'Hardware Bus';

  const faderWrapper = document.createElement('div');
  faderWrapper.className = 'strip-panel-fader';

  const fInput = document.createElement('input');
  fInput.type = 'range';
  fInput.className = 'fader-input';
  fInput.min = -60; fInput.max = 12; fInput.step = 0.1;
  fInput.value = vmState[bus.params.gain] ?? 0;
  fInput.style.width = '100%'; fInput.style.height = '100%';
  faderWrapper.appendChild(fInput);

  const gainVal = document.createElement('div');
  gainVal.className = 'fader-value';
  gainVal.style.fontSize = '11px';
  gainVal.textContent = formatDb(vmState[bus.params.gain] ?? 0) + ' dB';

  fInput.addEventListener('input', () => {
    const v = parseFloat(fInput.value);
    gainVal.textContent = formatDb(v) + ' dB';
    vmSet(bus.params.gain, v);
  });

  const muteBtn = document.createElement('button');
  muteBtn.className = 'strip-panel-mute' + (vmState[bus.params.mute] ? ' muted' : '');
  muteBtn.textContent = vmState[bus.params.mute] ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    vmSet(bus.params.mute, muteBtn.classList.contains('muted') ? 0 : 1);
  });

  card.appendChild(nameEl);
  card.appendChild(typeEl);
  card.appendChild(faderWrapper);
  card.appendChild(gainVal);
  card.appendChild(muteBtn);
  card.appendChild(buildEditOverlay(ctrl));

  card._updateState = (p, v) => {
    if (p === bus.params.gain) { fInput.value = v; gainVal.textContent = formatDb(v) + ' dB'; }
    else if (p === bus.params.mute) { muteBtn.classList.toggle('muted', !!v); muteBtn.textContent = v ? 'MUTED' : 'MUTE'; }
  };

  return card;
}

/**
 * VU Meter
 * cfg: { label, stripIndex (or busIndex), showBoth }
 */
export function renderVuMeter(ctrl, vmState) {
  const cfg = ctrl.config;

  const card = document.createElement('div');
  card.className = 'control-card vu-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 1}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 3}`;
  card.dataset.id = ctrl.id;

  const labelEl = document.createElement('div');
  labelEl.className = 'vu-label';
  labelEl.textContent = cfg.label || 'Level';

  const metersEl = document.createElement('div');
  metersEl.className = 'vu-meters';

  const chL = buildVuChannel(`vu-${ctrl.id}-L`);
  const chR = buildVuChannel(`vu-${ctrl.id}-R`);
  metersEl.appendChild(chL);
  metersEl.appendChild(chR);

  const dbVal = document.createElement('div');
  dbVal.className = 'vu-db-value';
  dbVal.textContent = '-∞ dB';

  card.appendChild(labelEl);
  card.appendChild(metersEl);
  card.appendChild(dbVal);
  card.appendChild(buildEditOverlay(ctrl));

  card._updateState = () => {};
  card._updateLevels = (levels) => {
    const si = cfg.stripIndex ?? cfg.busIndex ?? 0;
    const isBus = cfg.busIndex !== undefined;
    let lIdx, rIdx;
    if (!isBus) {
      lIdx = si * 2;
      rIdx = lIdx + 1;
    } else {
      // Bus levels start at offset 16 (8 strips × 2ch) with 8ch per bus
      lIdx = 16 + si * 8;
      rIdx = lIdx + 1;
    }
    const lv = levels[lIdx] ?? 0;
    const rv = levels[rIdx] ?? lv;
    updateVuChannel(chL, lv);
    updateVuChannel(chR, rv);
    const dbL = lv > 0 ? 20 * Math.log10(lv) : -Infinity;
    dbVal.textContent = isFinite(dbL) ? formatDb(dbL) + ' dB' : '-∞ dB';
  };

  return card;
}

/**
 * Label
 * cfg: { text }
 */
export function renderLabel(ctrl) {
  const card = document.createElement('div');
  card.className = 'control-card label-card';
  card.style.gridColumn = `span ${ctrl.colSpan || 2}`;
  card.style.gridRow    = `span ${ctrl.rowSpan || 1}`;
  card.dataset.id = ctrl.id;

  const textEl = document.createElement('div');
  textEl.className = 'label-text';
  textEl.textContent = ctrl.config?.text || 'Label';

  card.appendChild(textEl);
  card.appendChild(buildEditOverlay(ctrl));
  card._updateState = () => {};
  return card;
}

// ── Edit overlay (appended inside every control card) ─────────────────────────
function buildEditOverlay(ctrl) {
  const ov = document.createElement('div');
  ov.className = 'edit-overlay';

  const editBtn = document.createElement('button');
  editBtn.className = 'edit-overlay-btn';
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit`;
  editBtn.dataset.action = 'edit';
  editBtn.dataset.ctrlId = ctrl.id;

  const delBtn = document.createElement('button');
  delBtn.className = 'edit-overlay-btn danger';
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg> Delete`;
  delBtn.dataset.action = 'delete';
  delBtn.dataset.ctrlId = ctrl.id;

  ov.appendChild(editBtn);
  ov.appendChild(delBtn);
  return ov;
}

// ── Dispatch render by type ───────────────────────────────────────────────────
export function renderControl(ctrl, vmState) {
  switch (ctrl.type) {
    case 'fader':       return renderFader(ctrl, vmState);
    case 'toggle':      return renderToggle(ctrl, vmState);
    case 'button':      return renderToggle(ctrl, vmState);
    case 'macro':       return renderMacro(ctrl, vmState);
    case 'strip_panel': return renderStripPanel(ctrl, vmState);
    case 'bus_panel':   return renderBusPanel(ctrl, vmState);
    case 'vu_meter':    return renderVuMeter(ctrl, vmState);
    case 'label':       return renderLabel(ctrl);
    default: {
      const d = document.createElement('div');
      d.className = 'control-card';
      d.style.gridColumn = `span ${ctrl.colSpan || 1}`;
      d.dataset.id = ctrl.id;
      d.textContent = `Unknown: ${ctrl.type}`;
      return d;
    }
  }
}

// ── Color utility ─────────────────────────────────────────────────────────────
function hexDim(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
