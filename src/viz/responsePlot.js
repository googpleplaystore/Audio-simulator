// Frequency-response plot: log-frequency x axis, dB y axis, multiple curves,
// optional fills, and draggable handles (for the parametric EQ).

import { fitCanvas, FONT, GRID, GRID_STRONG, LABEL } from './canvas.js';
import { clamp, logPos, logFreq } from '../util/math.js';
import { formatHzShort } from '../util/format.js';

export class ResponsePlot {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [o]
   */
  constructor(canvas, o = {}) {
    this.canvas = canvas;
    this.fMin = o.fMin ?? 20;
    this.fMax = o.fMax ?? 20000;
    this.dbMin = o.dbMin ?? -18;
    this.dbMax = o.dbMax ?? 18;
    this.dbStep = o.dbStep ?? 6;
    this.curves = [];
    this.handles = [];
    this.bands = []; // shaded frequency regions {f1, f2, color}
    this.markers = []; // vertical lines {f, color, label}
    this.onHandle = null; // (index, {frequency, gain, Q}, final)
    this.onHandleSelect = null;
    this.selected = -1;
    this.pad = { l: 38, r: 12, t: 12, b: 22 };
    this._bind();
    // Redraw on resize; once the canvas has been attached and is then removed
    // from the document, release the observer so closed views never leak.
    this.wasConnected = false;
    this.destroyed = false;
    this.ro = new ResizeObserver(() => {
      if (canvas.isConnected) {
        this.wasConnected = true;
        this.draw();
      } else if (this.wasConnected) this.destroy();
    });
    this.ro.observe(canvas);
  }

  x(f, w) {
    return this.pad.l + logPos(f, this.fMin, this.fMax) * (w - this.pad.l - this.pad.r);
  }

  y(db, h) {
    return this.pad.t + (1 - (db - this.dbMin) / (this.dbMax - this.dbMin)) * (h - this.pad.t - this.pad.b);
  }

  fAt(px, w) {
    return logFreq(clamp((px - this.pad.l) / (w - this.pad.l - this.pad.r), 0, 1), this.fMin, this.fMax);
  }

  dbAt(py, h) {
    return this.dbMin + (1 - (py - this.pad.t) / (h - this.pad.t - this.pad.b)) * (this.dbMax - this.dbMin);
  }

  /** curves: [{freqs, db, color, width, fill, dash, label}] */
  setCurves(curves) {
    this.curves = curves;
    this.draw();
  }

  setHandles(handles, selected = this.selected) {
    this.handles = handles;
    this.selected = selected;
    this.draw();
  }

  setRange(dbMin, dbMax, step = this.dbStep) {
    this.dbMin = dbMin;
    this.dbMax = dbMax;
    this.dbStep = step;
    this.draw();
  }

  draw() {
    if (this.destroyed) return;
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    // Shaded bands
    for (const b of this.bands) {
      ctx.fillStyle = b.color;
      const x1 = this.x(Math.max(b.f1, this.fMin), w);
      const x2 = this.x(Math.min(b.f2, this.fMax), w);
      ctx.fillRect(x1, this.pad.t, x2 - x1, h - this.pad.t - this.pad.b);
    }
    // Grid
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const decades = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];
    const labeled = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
    for (const f of decades) {
      if (f < this.fMin || f > this.fMax) continue;
      const x = Math.round(this.x(f, w)) + 0.5;
      ctx.strokeStyle = labeled.has(f) ? GRID_STRONG : GRID;
      ctx.beginPath();
      ctx.moveTo(x, this.pad.t);
      ctx.lineTo(x, h - this.pad.b);
      ctx.stroke();
      if (labeled.has(f)) {
        ctx.fillStyle = LABEL;
        ctx.textAlign = 'center';
        ctx.fillText(formatHzShort(f), x, h - this.pad.b / 2);
      }
    }
    for (let db = Math.ceil(this.dbMin / this.dbStep) * this.dbStep; db <= this.dbMax; db += this.dbStep) {
      const y = Math.round(this.y(db, h)) + 0.5;
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : GRID;
      ctx.beginPath();
      ctx.moveTo(this.pad.l, y);
      ctx.lineTo(w - this.pad.r, y);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, this.pad.l - 6, y);
    }
    // Markers
    for (const m of this.markers) {
      const x = this.x(m.f, w);
      ctx.strokeStyle = m.color || 'rgba(255,255,255,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, this.pad.t);
      ctx.lineTo(x, h - this.pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.color || LABEL;
        ctx.textAlign = 'left';
        // Bottom-anchored so labels never collide with the legend row.
        ctx.fillText(m.label, x + 4, h - this.pad.b - 10);
      }
    }
    // Curves
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.pad.l, this.pad.t, w - this.pad.l - this.pad.r, h - this.pad.t - this.pad.b);
    ctx.clip();
    for (const c of this.curves) {
      if (!c || !c.freqs || !c.db) continue;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < c.freqs.length; i++) {
        const f = c.freqs[i];
        if (f < this.fMin * 0.9 || f > this.fMax * 1.1) continue;
        if (!Number.isFinite(c.db[i])) {
          started = false; // NaN breaks the line (e.g. phase wraps)
          continue;
        }
        const x = this.x(f, w);
        const y = this.y(clamp(c.db[i], this.dbMin - 40, this.dbMax + 40), h);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      if (c.fill) {
        const y0 = this.y(c.fillTo ?? 0, h);
        ctx.save();
        ctx.lineTo(this.x(Math.min(this.fMax, c.freqs[c.freqs.length - 1]), w), y0);
        ctx.lineTo(this.x(Math.max(this.fMin, c.freqs[0]), w), y0);
        ctx.closePath();
        ctx.fillStyle = c.fill;
        ctx.fill();
        ctx.restore();
        // Redraw stroke path
        ctx.beginPath();
        started = false;
        for (let i = 0; i < c.freqs.length; i++) {
          const f = c.freqs[i];
          if (f < this.fMin * 0.9 || f > this.fMax * 1.1) continue;
          const x = this.x(f, w);
          const y = this.y(clamp(c.db[i], this.dbMin - 40, this.dbMax + 40), h);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = c.color || '#fff';
      ctx.lineWidth = c.width || 2;
      ctx.setLineDash(c.dash || []);
      ctx.lineJoin = 'round';
      if (c.glow) {
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 10;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
    }
    ctx.restore();
    // Handles
    this.handles.forEach((hd, i) => {
      const x = this.x(hd.frequency, w);
      const y = this.y(clamp(hd.gain ?? 0, this.dbMin, this.dbMax), h);
      const sel = i === this.selected;
      ctx.beginPath();
      ctx.arc(x, y, sel ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = hd.enabled === false ? 'rgba(120,120,140,0.6)' : hd.color || '#8d7dff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.stroke();
      ctx.fillStyle = '#0a0a10';
      ctx.font = '800 9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, y + 0.5);
    });
    // Legend
    const legend = this.curves.filter((c) => c && c.label);
    if (legend.length) {
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      let lx = this.pad.l + 10;
      const ly = this.pad.t + 12;
      for (const c of legend) {
        ctx.fillStyle = c.color;
        ctx.fillRect(lx, ly - 1.5, 14, 3);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(c.label, lx + 19, ly);
        lx += ctx.measureText(c.label).width + 40;
      }
    }
  }

  _bind() {
    const c = this.canvas;
    let drag = -1;
    const pick = (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let best = -1;
      let bd = 16 * 16;
      this.handles.forEach((hd, i) => {
        const dx = this.x(hd.frequency, r.width) - px;
        const dy = this.y(clamp(hd.gain ?? 0, this.dbMin, this.dbMax), r.height) - py;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return { best, px, py, w: r.width, h: r.height };
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.handles.length) return;
      const p = pick(e);
      if (p.best < 0) return;
      e.preventDefault();
      drag = p.best;
      this.selected = drag;
      this.onHandleSelect?.(drag);
      c.setPointerCapture(e.pointerId);
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (drag < 0) {
        if (this.handles.length) c.style.cursor = pick(e).best >= 0 ? 'grab' : 'default';
        return;
      }
      const r = c.getBoundingClientRect();
      const f = clamp(this.fAt(e.clientX - r.left, r.width), 20, 20000);
      const g = clamp(this.dbAt(e.clientY - r.top, r.height), this.dbMin, this.dbMax);
      const hd = this.handles[drag];
      const next = { frequency: Math.round(f * 10) / 10, gain: hd.fixedGain ? hd.gain : Math.round(g * 10) / 10 };
      this.onHandle?.(drag, next, false);
    });
    const end = () => {
      if (drag < 0) return;
      const hd = this.handles[drag];
      this.onHandle?.(drag, { frequency: hd.frequency, gain: hd.gain }, true);
      drag = -1;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.selected < 0 || !this.handles[this.selected]) return;
        const p = pick(e);
        if (p.best !== this.selected) return;
        e.preventDefault();
        const hd = this.handles[this.selected];
        const q = clamp((hd.Q ?? 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 30);
        this.onHandle?.(this.selected, { Q: Math.round(q * 100) / 100 }, true);
      },
      { passive: false },
    );
  }

  destroy() {
    this.destroyed = true;
    this.ro.disconnect();
  }
}
