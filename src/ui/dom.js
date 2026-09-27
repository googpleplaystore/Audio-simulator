// Tiny DOM toolkit: hyperscript element builder and helpers.

import { iconSvg } from './icons.js';

/**
 * h('div.card#main', {onClick, style:{...}, attrs}, ...children)
 * Props: class/className, style (object|string), dataset, on<Event>, html,
 * ref (fn), and any other key becomes an attribute (booleans toggle).
 */
export function h(tag, props, ...children) {
  let t = tag;
  let id = null;
  const classes = [];
  const m = tag.match(/^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i);
  if (m) {
    t = m[1] || 'div';
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') classes.push(part.slice(1));
      else id = part.slice(1);
    }
  }
  const el = t === 'svg' || t === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', t) : document.createElement(t);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') {
        const extra = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        if (extra) el.className = el.className ? `${el.className} ${extra}` : extra;
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else
          for (const [sk, sv] of Object.entries(v)) {
            if (sv == null) continue;
            if (sk.startsWith('--')) el.style.setProperty(sk, sv);
            else el.style[sk] = sv;
          }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'ref') v(el);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' && 'checked' in el) el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function icon(name, size = 20, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.style.display = 'inline-grid';
  span.innerHTML = iconSvg(name, size);
  return span;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Run fn when element is removed? We use explicit destroy() instead; helper for listeners. */
export function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Collect disposers and run them together. */
export class Disposer {
  constructor() {
    this.fns = [];
  }

  add(fn) {
    if (typeof fn === 'function') this.fns.push(fn);
    return fn;
  }

  run() {
    for (const fn of this.fns.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error('[dispose]', err);
      }
    }
  }
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn(...pendingArgs);
        }, remaining);
      }
    }
  };
}
