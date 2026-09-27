// Measurement plots: a linear XY plot (impulse, step, ETC, decay curves), a
// pseudo-3D cumulative-spectral-decay waterfall and grouped octave bars.
// All of them redraw on resize and release their ResizeObserver once their
// canvas has been removed from the document.

import { fitCanvas, colormap, FONT, GRID, GRID_STRONG, LABEL } from './canvas.js';
import { clamp, logPos } from '../util/math.js';
import { formatHzShort } from '../util/format.js';

class BasePlot {
  constructor(canvas, label = 'Measurement graph') {
    this.canvas = canvas;
    if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'img');
    if (!canvas.hasAttribute('aria-label')) canvas.setAttribute('aria-label', label);
    this.destroyed = false;
    this.wasConnected = false;
    this.ro = new ResizeObserver(() => {
      if (canvas.isConnected) {
        this.wasConnected = true;
        this.draw();
      } else if (this.wasConnected) this.destroy();
    });
    this.ro.observe(canvas);
  }

  draw() {
    if (this.destroyed || !this.canvas.isConnected) return;
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    this.render(ctx, w, h);
  }

  destroy() {
    this.destroyed = true;
    this.ro.disconnect();
  }
}

function niceStep(range, target = 6) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function legend(ctx, items, x, y) {
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = x;
  for (const c of items) {
    ctx.fillStyle = c.color;
    ctx.fillRect(lx, y - 1.5, 14, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(c.label, lx + 19, y);
    lx += ctx.measureText(c.label).width + 40;
  }
}

/**
 * Linear x/y plot. Curves: {x0, dx, y: ArrayLike, color, width, label, fill}.
 */
export class XYPlot extends BasePlot {
  constructor(canvas, o = {}) {
    super(canvas, o.label || 'Time-domain graph');
    this.xMin = o.xMin ?? 0;
    this.xMax = o.xMax ?? 100;
    this.yMin = o.yMin ?? -1;
    this.yMax = o.yMax ?? 1;
    this.xUnit = o.xUnit ?? 'ms';
    this.yUnit = o.yUnit ?? '';
    this.curves = [];
    this.markers = [];
    this.pad = { l: 44, r: 12, t: 14, b: 22 };
  }

  set(o) {
    Object.assign(this, o);
    this.draw();
  }

  render(ctx, w, h) {
    const { l, r, t, b } = this.pad;
    const X = (x) => l + ((x - this.xMin) / (this.xMax - this.xMin)) * (w - l - r);
    const Y = (y) => t + (1 - (y - this.yMin) / (this.yMax - this.yMin)) * (h - t - b);
    ctx.font = FONT;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    const xs = niceStep(this.xMax - this.xMin, Math.max(3, Math.floor(w / 90)));
    for (let x = Math.ceil(this.xMin / xs) * xs; x <= this.xMax + 1e-9; x += xs) {
      const px = Math.round(X(x)) + 0.5;
      ctx.strokeStyle = Math.abs(x) < 1e-9 ? GRID_STRONG : GRID;
      ctx.beginPath();
      ctx.moveTo(px, t);
      ctx.lineTo(px, h - b);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'center';
      ctx.fillText(`${+x.toFixed(3)}${this.xUnit}`, px, h - b / 2);
    }
    const ys = niceStep(this.yMax - this.yMin, Math.max(3, Math.floor(h / 45)));
    for (let y = Math.ceil(this.yMin / ys) * ys; y <= this.yMax + 1e-9; y += ys) {
      const py = Math.round(Y(y)) + 0.5;
      ctx.strokeStyle = Math.abs(y) < 1e-9 ? 'rgba(255,255,255,0.22)' : GRID;
      ctx.beginPath();
      ctx.moveTo(l, py);
      ctx.lineTo(w - r, py);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(`${+y.toFixed(3)}${this.yUnit}`, l - 6, py);
    }
    for (const m of this.markers) {
      const px = X(m.x);
      ctx.strokeStyle = m.color || 'rgba(255,255,255,0.4)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, t);
      ctx.lineTo(px, h - b);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.color || LABEL;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, px + 4, h - b - 10);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(l, t, w - l - r, h - t - b);
    ctx.clip();
    const pxW = w - l - r;
    for (const c of this.curves) {
      if (!c || !c.y) continue;
      const n = c.y.length;
      const i0 = clamp(Math.floor((this.xMin - c.x0) / c.dx), 0, n - 1);
      const i1 = clamp(Math.ceil((this.xMax - c.x0) / c.dx), 0, n - 1);
      const per = Math.max(1, Math.floor((i1 - i0) / (pxW * 2)));
      ctx.beginPath();
      let first = true;
      // Min/max decimation keeps peaks visible at any zoom.
      for (let i = i0; i <= i1; i += per) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = i; j < Math.min(i + per, n); j++) {
          const v = c.y[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const px = X(c.x0 + i * c.dx);
        const yl = Y(clamp(lo, this.yMin - 10 * (this.yMax - this.yMin), this.yMax + 10 * (this.yMax - this.yMin)));
        const yh = Y(clamp(hi, this.yMin - 10 * (this.yMax - this.yMin), this.yMax + 10 * (this.yMax - this.yMin)));
        if (first) {
          ctx.moveTo(px, yh);
          first = false;
        } else ctx.lineTo(px, yh);
        if (per > 1) ctx.lineTo(px, yl);
      }
      if (c.fill) {
        ctx.save();
        ctx.lineTo(X(c.x0 + i1 * c.dx), Y(c.fillTo ?? this.yMin));
        ctx.lineTo(X(c.x0 + i0 * c.dx), Y(c.fillTo ?? this.yMin));
        ctx.closePath();
        ctx.fillStyle = c.fill;
        ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = c.color || '#fff';
      ctx.lineWidth = c.width || 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
    const items = this.curves.filter((c) => c && c.label);
    if (items.length) legend(ctx, items, l + 10, t + 10);
  }
}

/**
 * Cumulative spectral decay: slices drawn back to front, each shifted up and
 * right, coloured from hot (t = 0) to cold.
 */
export class WaterfallPlot extends BasePlot {
  constructor(canvas, o = {}) {
    super(canvas, o.label || 'Waterfall (cumulative spectral decay) graph');
    this.range = o.range ?? 45; // dB shown below the peak
    this.data = null;
    this.lut = colormap();
    this.pad = { l: 44, r: 56, t: 12, b: 22 };
  }

  setData(data) {
    this.data = data;
    this.draw();
  }

  render(ctx, w, h) {
    const d = this.data;
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    if (!d || !d.slices.length) {
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'center';
      ctx.fillText('No measurement', w / 2, h / 2);
      return;
    }
    const { l, r, t, b } = this.pad;
    const nS = d.slices.length;
    // Oblique depth large enough (≈ 60 % of the dB range) that decaying
    // ridges rise above the slices in front of them.
    const depthX = Math.min(160, (w - l - r) * 0.2);
    const depthY = (h - t - b) * 0.48;
    const pw = w - l - r - depthX;
    const ph = h - t - b - depthY;
    const fMin = d.freqs[0];
    const fMax = d.freqs[d.freqs.length - 1];
    const X = (f, s) => l + logPos(f, fMin, fMax) * pw + (s / Math.max(1, nS - 1)) * depthX;
    const Y = (db, s) => t + depthY + (1 - clamp((db + this.range) / this.range, 0, 1.05)) * ph - (s / Math.max(1, nS - 1)) * depthY;
    // Axes (front slice)
    ctx.lineWidth = 1;
    for (let db = 0; db >= -this.range; db -= 10) {
      const y = Math.round(Y(db, 0)) + 0.5;
      ctx.strokeStyle = db === 0 ? GRID_STRONG : GRID;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(l + pw, y);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(`${db}`, l - 6, y);
    }
    for (const f of [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < fMin || f > fMax) continue;
      const x = Math.round(X(f, 0)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(x, t + depthY);
      ctx.lineTo(x, h - b);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'center';
      ctx.fillText(formatHzShort(f), x, h - b / 2);
    }
    // Slices back to front
    for (let s = nS - 1; s >= 0; s--) {
      const db = d.slices[s];
      const u = 1 - s / Math.max(1, nS - 1);
      const k = Math.round(40 + u * 200) * 3;
      const col = `rgb(${this.lut[k]},${this.lut[k + 1]},${this.lut[k + 2]})`;
      ctx.beginPath();
      ctx.moveTo(X(fMin, s), Y(-this.range, s));
      for (let i = 0; i < d.freqs.length; i++) ctx.lineTo(X(d.freqs[i], s), Y(db[i], s));
      ctx.lineTo(X(fMax, s), Y(-this.range, s));
      ctx.closePath();
      ctx.fillStyle = `rgba(10,10,16,${s === 0 ? 0.55 : 0.9})`;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = s === 0 ? 2 : 1.1;
      ctx.stroke();
    }
    // Time labels along the depth axis
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'left';
    for (const s of [0, Math.floor((nS - 1) / 2), nS - 1]) ctx.fillText(`${Math.round(d.times[s])} ms`, X(fMax, s) + 4, Y(-this.range, s));
  }
}

/** Grouped vertical bars per octave band. groups: [{label, color, values:[]}] */
export class BarsPlot extends BasePlot {
  constructor(canvas, o = {}) {
    super(canvas, o.label || 'Reverberation time per octave band');
    this.labels = o.labels ?? [];
    this.unit = o.unit ?? '';
    this.groups = [];
    this.yMax = o.yMax ?? null;
    this.pad = { l: 44, r: 12, t: 26, b: 22 };
  }

  setData(groups, labels = this.labels) {
    this.groups = groups;
    this.labels = labels;
    this.draw();
  }

  render(ctx, w, h) {
    const { l, r, t, b } = this.pad;
    const all = this.groups.flatMap((g) => g.values).filter(Number.isFinite);
    const yMax = this.yMax ?? Math.max(0.1, ...all) * 1.15;
    const Y = (v) => t + (1 - v / yMax) * (h - t - b);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const step = niceStep(yMax, 5);
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? GRID_STRONG : GRID;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(w - r, y);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(`${+v.toFixed(2)}${this.unit}`, l - 6, y);
    }
    const nB = this.labels.length;
    const bw = (w - l - r) / Math.max(1, nB);
    const nG = Math.max(1, this.groups.length);
    const barW = Math.max(3, Math.min(26, (bw * 0.7) / nG));
    for (let i = 0; i < nB; i++) {
      const cx = l + bw * (i + 0.5);
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'center';
      ctx.fillText(this.labels[i], cx, h - b / 2);
      this.groups.forEach((g, j) => {
        const v = g.values[i];
        if (!Number.isFinite(v)) return;
        const x = cx - (nG * barW) / 2 + j * barW;
        const y = Y(clamp(v, 0, yMax));
        ctx.fillStyle = g.color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x + 1, y, barW - 2, h - b - y);
        ctx.globalAlpha = 1;
        if (nG === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fillText(`${v.toFixed(2)}`, x + barW / 2, y - 8);
        }
      });
    }
    if (this.groups.length > 1) legend(ctx, this.groups.map((g) => ({ label: g.label, color: g.color })), l + 10, 10);
  }
}
