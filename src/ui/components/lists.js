// Virtualised lists, lazy artwork elements and pointer-driven sortable lists.

import { h, icon } from '../dom.js';

// ---------------------------------------------------------------- artwork
let io = null;
const pendingArt = new WeakMap();

function observer() {
  if (!io && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const fn = pendingArt.get(e.target);
          io.unobserve(e.target);
          pendingArt.delete(e.target);
          if (fn) fn();
        }
      },
      { rootMargin: '300px' },
    );
  }
  return io;
}

/**
 * Artwork element with lazy loading and a gradient fallback.
 * @param {import('../../library/artwork.js').ArtCache} art
 */
export function artEl(art, artId, { size = 'thumb', className = '', fallback = 'music', lazy = true, seed = '' } = {}) {
  const hue = [...(seed || artId || 'x')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const el = h('div.art', { class: className, style: { background: `linear-gradient(135deg, hsl(${hue} 35% 26%), hsl(${(hue + 60) % 360} 30% 14%))` } }, h('div.art-fallback', icon(fallback, 22)));
  if (!artId || !art) return el;
  const load = () => {
    art.url(artId, size).then((url) => {
      if (!url) return;
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      img.onload = () => img.classList.add('loaded');
      img.src = url;
      el.appendChild(img);
    });
  };
  const ob = lazy ? observer() : null;
  if (ob) {
    pendingArt.set(el, load);
    ob.observe(el);
  } else load();
  return el;
}

// ---------------------------------------------------------------- virtual list
export class VirtualList {
  /**
   * @param {object} o
   * @param {HTMLElement} o.scroller scrolling ancestor
   * @param {number} o.rowHeight
   * @param {number} o.count
   * @param {(i:number)=>HTMLElement} o.render
   * @param {number} [o.overscan]
   */
  constructor(o) {
    this.scroller = o.scroller;
    this.rowHeight = o.rowHeight;
    this.count = o.count;
    this.renderRow = o.render;
    this.overscan = o.overscan ?? 10;
    this.rows = new Map();
    this.el = h('div', { style: { position: 'relative', height: `${this.count * this.rowHeight}px` } });
    this.onScroll = () => this.update();
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.update());
    this.ro.observe(this.scroller);
    this.raf = requestAnimationFrame(() => this.update());
  }

  update() {
    if (!this.el.isConnected) return;
    const sr = this.scroller.getBoundingClientRect();
    const er = this.el.getBoundingClientRect();
    const offset = sr.top - er.top;
    const first = Math.max(0, Math.floor(offset / this.rowHeight) - this.overscan);
    const last = Math.min(this.count - 1, Math.ceil((offset + sr.height) / this.rowHeight) + this.overscan);
    for (const [i, row] of this.rows) {
      if (i < first || i > last) {
        row.remove();
        this.rows.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const row = this.renderRow(i);
      row.style.top = `${i * this.rowHeight}px`;
      row.dataset.index = String(i);
      this.el.appendChild(row);
      this.rows.set(i, row);
    }
  }

  setCount(n) {
    this.count = n;
    this.el.style.height = `${n * this.rowHeight}px`;
    this.refresh();
  }

  /** Re-render all visible rows. */
  refresh() {
    for (const row of this.rows.values()) row.remove();
    this.rows.clear();
    this.update();
  }

  scrollToIndex(i) {
    const er = this.el.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    const y = er.top - sr.top + this.scroller.scrollTop + i * this.rowHeight - sr.height / 3;
    this.scroller.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    this.rows.clear();
  }
}

// ---------------------------------------------------------------- sortable
/**
 * Pointer-based drag-and-drop reordering across one or more list containers.
 * Items must carry data-index; containers data-section.
 * onMove(fromSection, fromIndex, toSection, toIndex)
 */
export function makeSortable(containers, { itemSelector = '.q-item', handleSelector = '.grip', onMove, scroller = null }) {
  const cleanups = [];
  for (const container of containers) {
    const down = (e) => {
      const handle = e.target.closest(handleSelector);
      if (!handle || !container.contains(handle) || e.button !== 0) return;
      const item = handle.closest(itemSelector);
      if (!item) return;
      e.preventDefault();
      startDrag(e, item, container);
    };
    container.addEventListener('pointerdown', down);
    cleanups.push(() => container.removeEventListener('pointerdown', down));
  }

  function startDrag(e, item, fromContainer) {
    const rect = item.getBoundingClientRect();
    const fromSection = fromContainer.dataset.section;
    const fromIndex = Number(item.dataset.index);
    const offsetY = e.clientY - rect.top;
    const placeholder = h('div.q-placeholder', { style: { height: `${rect.height}px` } });
    item.after(placeholder);
    item.classList.add('dragging');
    Object.assign(item.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, pointerEvents: 'none' });
    let autoScroll = 0;
    let raf = 0;
    const tickScroll = () => {
      if (scroller && autoScroll) scroller.scrollTop += autoScroll;
      raf = requestAnimationFrame(tickScroll);
    };
    raf = requestAnimationFrame(tickScroll);
    const move = (ev) => {
      item.style.top = `${ev.clientY - offsetY}px`;
      // Find target container + position.
      let target = null;
      for (const c of containers) {
        const r = c.getBoundingClientRect();
        if (ev.clientY >= r.top - 20 && ev.clientY <= r.bottom + 20 && ev.clientX >= r.left && ev.clientX <= r.right) target = c;
      }
      if (target) {
        const siblings = [...target.querySelectorAll(itemSelector)].filter((x) => x !== item);
        let placed = false;
        for (const s of siblings) {
          const r = s.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            s.before(placeholder);
            placed = true;
            break;
          }
        }
        if (!placed) {
          if (siblings.length) siblings[siblings.length - 1].after(placeholder);
          else target.appendChild(placeholder);
        }
      }
      if (scroller) {
        const sr = scroller.getBoundingClientRect();
        autoScroll = ev.clientY < sr.top + 40 ? -8 : ev.clientY > sr.bottom - 40 ? 8 : 0;
      }
    };
    const up = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const toContainer = placeholder.parentElement;
      const toSection = toContainer?.dataset.section ?? fromSection;
      const before = toContainer ? [...toContainer.children].filter((x) => x === placeholder || (x.matches(itemSelector) && x !== item)) : [];
      let toIndex = before.indexOf(placeholder);
      if (toIndex < 0) toIndex = fromIndex;
      item.classList.remove('dragging');
      item.removeAttribute('style');
      placeholder.remove();
      if (toSection !== fromSection || toIndex !== fromIndex) onMove(fromSection, fromIndex, toSection, toIndex);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return () => cleanups.forEach((fn) => fn());
}
