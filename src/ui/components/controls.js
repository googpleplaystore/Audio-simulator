// Interactive controls: slider (horizontal/vertical, linear/log), rotary
// knob, toggle, segmented control and select — all keyboard accessible,
// pointer/touch friendly, with double-click-to-reset.

import { h } from '../dom.js';
import { clamp } from '../../util/math.js';

/**
 * @param {object} o
 * @param {number} o.min
 * @param {number} o.max
 * @param {number} o.value
 * @param {number} [o.step]
 * @param {boolean} [o.log] logarithmic mapping
 * @param {boolean} [o.vertical]
 * @param {boolean} [o.bipolar] fill from the centre (0) value
 * @param {number} [o.reset] value for double-click reset
 * @param {(v:number, final:boolean)=>void} o.onInput
 * @param {(v:number)=>string} [o.format] aria-valuetext
 * @param {string} [o.label]
 */
export function slider(o) {
  const { min, max, step = 0, log = false, vertical = false, bipolar = false } = o;
  let value = o.value;
  const toT = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromT = (t) => {
    let v = log ? min * Math.pow(max / min, t) : min + (max - min) * t;
    if (step) v = Math.round(v / step) * step;
    return clamp(v, min, max);
  };
  const fill = h('div.fill');
  const thumb = h('div.thumb');
  const track = h('div.track', fill, thumb);
  const el = h('div.slider', {
    class: [vertical ? 'vertical' : '', bipolar ? 'bipolar' : '', o.className || ''],
    role: 'slider',
    tabindex: 0,
    'aria-label': o.label || '',
    'aria-orientation': vertical ? 'vertical' : 'horizontal',
    'aria-valuemin': min,
    'aria-valuemax': max,
  }, track);
  const render = () => {
    const t = clamp(toT(value), 0, 1);
    const zero = bipolar ? clamp(toT(0), 0, 1) : 0;
    const a = Math.min(t, zero);
    const b = Math.max(t, zero);
    if (vertical) {
      fill.style.bottom = `${a * 100}%`;
      fill.style.height = `${(b - a) * 100}%`;
      thumb.style.bottom = `${t * 100}%`;
    } else {
      fill.style.left = `${a * 100}%`;
      fill.style.width = `${(b - a) * 100}%`;
      thumb.style.left = `${t * 100}%`;
    }
    el.setAttribute('aria-valuenow', String(value));
    if (o.format) el.setAttribute('aria-valuetext', o.format(value));
  };
  const setFromEvent = (e, final) => {
    const r = track.getBoundingClientRect();
    const t = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    const v = fromT(clamp(t, 0, 1));
    if (v !== value || final) {
      value = v;
      render();
      o.onInput(v, final);
    }
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    el.focus({ preventScroll: true });
    setFromEvent(e, false);
    const move = (ev) => setFromEvent(ev, false);
    const up = (ev) => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setFromEvent(ev, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => {
    if (o.reset == null) return;
    value = o.reset;
    render();
    o.onInput(value, true);
  });
  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    const inc = step || (log ? 0 : (max - min) / 100);
    let v = value;
    const nudge = (dir) => {
      if (log) v = fromT(clamp(toT(value) + dir * 0.01 * big, 0, 1));
      else v = clamp(value + dir * inc * big, min, max);
    };
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nudge(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nudge(-1);
    else if (e.key === 'Home') v = min;
    else if (e.key === 'End') v = max;
    else return;
    e.preventDefault();
    e.stopPropagation();
    value = v;
    render();
    o.onInput(v, true);
  });
  el.addEventListener(
    'wheel',
    (e) => {
      if (!o.wheel) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      value = log ? fromT(clamp(toT(value) + dir * 0.01, 0, 1)) : clamp(value + dir * (step || (max - min) / 100), min, max);
      render();
      o.onInput(value, true);
    },
    { passive: false },
  );
  render();
  el.setValue = (v) => {
    if (el.classList.contains('dragging')) return;
    value = v;
    render();
  };
  return el;
}

/** Labeled slider row: label · slider · value readout. */
export function sliderRow(label, o) {
  const val = h('span.value');
  const upd = (v) => (val.textContent = o.format ? o.format(v) : String(v));
  const s = slider({
    ...o,
    label,
    onInput: (v, final) => {
      upd(v);
      o.onInput(v, final);
    },
  });
  upd(o.value);
  const row = h('div.slider-row', h('span.label', label), s, val);
  row.setValue = (v) => {
    s.setValue(v);
    upd(v);
  };
  row.slider = s;
  return row;
}

/**
 * Rotary knob: vertical drag / wheel / arrow keys. 270° sweep.
 */
export function knob(o) {
  const { min, max, step = 0, log = false, size = 64, label = '', bipolar = false } = o;
  let value = o.value;
  const toT = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromT = (t) => {
    let v = log ? min * Math.pow(max / min, t) : min + (max - min) * t;
    if (step) v = Math.round(v / step) * step;
    return clamp(v, min, max);
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 100 100');
  const arc = (a0, a1, r) => {
    const p = (a) => [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };
  const A0 = (135 * Math.PI) / 180;
  const A1 = (405 * Math.PI) / 180;
  const bg = document.createElementNS(ns, 'path');
  bg.setAttribute('d', arc(A0, A1, 42));
  bg.setAttribute('stroke', 'rgba(255,255,255,0.1)');
  bg.setAttribute('stroke-width', '7');
  bg.setAttribute('fill', 'none');
  bg.setAttribute('stroke-linecap', 'round');
  const fg = document.createElementNS(ns, 'path');
  fg.setAttribute('stroke', 'url(#kgrad)');
  fg.setAttribute('stroke-width', '7');
  fg.setAttribute('fill', 'none');
  fg.setAttribute('stroke-linecap', 'round');
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = '<linearGradient id="kgrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8d7dff"/><stop offset="1" stop-color="#36e2cf"/></linearGradient><radialGradient id="kcap" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="#3b3b4c"/><stop offset="1" stop-color="#16161e"/></radialGradient>';
  const cap = document.createElementNS(ns, 'circle');
  cap.setAttribute('cx', '50');
  cap.setAttribute('cy', '50');
  cap.setAttribute('r', '31');
  cap.setAttribute('fill', 'url(#kcap)');
  cap.setAttribute('stroke', 'rgba(255,255,255,0.12)');
  const ind = document.createElementNS(ns, 'line');
  ind.setAttribute('stroke', '#fff');
  ind.setAttribute('stroke-width', '4');
  ind.setAttribute('stroke-linecap', 'round');
  svg.append(defs, bg, fg, cap, ind);
  const valEl = h('span.knob-value');
  const el = h('div.knob', { tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max }, svg, h('span.knob-label', label), valEl);
  const render = () => {
    const t = clamp(toT(value), 0, 1);
    const a = A0 + (A1 - A0) * t;
    const z = bipolar ? A0 + (A1 - A0) * clamp(toT(0), 0, 1) : A0;
    if (Math.abs(a - z) < 1e-3) fg.setAttribute('d', '');
    else fg.setAttribute('d', a > z ? arc(z, a, 42) : arc(a, z, 42));
    ind.setAttribute('x1', String(50 + 14 * Math.cos(a)));
    ind.setAttribute('y1', String(50 + 14 * Math.sin(a)));
    ind.setAttribute('x2', String(50 + 26 * Math.cos(a)));
    ind.setAttribute('y2', String(50 + 26 * Math.sin(a)));
    valEl.textContent = o.format ? o.format(value) : String(value);
    el.setAttribute('aria-valuenow', String(value));
  };
  const set = (v, final) => {
    const nv = clamp(v, min, max);
    if (nv === value && !final) return;
    value = nv;
    render();
    o.onInput(value, final);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    const startY = e.clientY;
    const startT = toT(value);
    const move = (ev) => set(fromT(clamp(startT + (startY - ev.clientY) / (ev.shiftKey ? 600 : 180), 0, 1)), false);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      o.onInput(value, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => {
    if (o.reset != null) set(o.reset, true);
  });
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      set(fromT(clamp(toT(value) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02), 0, 1)), true);
    },
    { passive: false },
  );
  el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    set(fromT(clamp(toT(value) + d * (e.shiftKey ? 0.05 : 0.01), 0, 1)), true);
  });
  render();
  el.setValue = (v) => {
    value = v;
    render();
  };
  return el;
}

export function toggle(label, checked, onChange, tip = null) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label.toggle', tip ? { 'data-tip': tip } : null, input, h('span', label));
  el.setValue = (v) => (input.checked = !!v);
  return el;
}

/** options: [{value, label}] */
export function segmented(options, value, onChange, { label = '' } = {}) {
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((opt) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-tip': opt.tip || null }, opt.label);
    b.addEventListener('click', () => {
      set(opt.value);
      onChange(opt.value);
    });
    el.appendChild(b);
    return { b, v: opt.value };
  });
  const set = (v) => {
    for (const { b, v: bv } of buttons) {
      const on = String(bv) === String(v);
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };
  set(value);
  el.setValue = set;
  return el;
}

/** options: [{value,label}] or [{group, options:[...]}] */
export function select(options, value, onChange, attrs = {}) {
  const el = h('select.select', attrs);
  const add = (parent, opt) => parent.appendChild(h('option', { value: opt.value }, opt.label));
  for (const opt of options) {
    if (opt.group) {
      const g = h('optgroup', { label: opt.group });
      for (const o of opt.options) add(g, o);
      el.appendChild(g);
    } else add(el, opt);
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  el.setValue = (v) => (el.value = v);
  return el;
}

/** Numeric input with units that commits on Enter/blur. */
export function numberInput(value, { min = -Infinity, max = Infinity, step = 0.1, digits = 2, onChange, width = null }) {
  const el = h('input.input.num', { type: 'number', step, min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, value: value.toFixed(digits), style: width ? { width } : null });
  const commit = () => {
    const v = clamp(Number(el.value), min, max);
    if (Number.isFinite(v)) {
      el.value = v.toFixed(digits);
      onChange(v);
    }
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      el.blur();
    }
    e.stopPropagation();
  });
  el.setValue = (v) => {
    if (document.activeElement !== el) el.value = v.toFixed(digits);
  };
  return el;
}
