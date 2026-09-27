// Real-time visualisers driven by AnalyserNodes: RTA spectrum (bars/curve
// with peak hold and source overlay), scrolling spectrogram, analog VU
// meters, vectorscope + phase-correlation meter, and an EBU R128 / ITU-R
// BS.1770 loudness meter. Each returns {el, destroy}.

import { h } from '../ui/dom.js';
import { fitCanvas, onFrame, isVisible, colormap, FONT, GRID, GRID_STRONG, LABEL } from './canvas.js';
import { clamp, logPos, percentile } from '../util/math.js';
import { formatHzShort } from '../util/format.js';
import { GEQ_FREQS } from '../dsp/curves.js';

function canvasBox(cls = '') {
  const c = h('canvas.viz');
  return { c, el: h('div.viz-box', { class: cls }, c) };
}

// ------------------------------------------------------------------ spectrum
export function spectrumAnalyzer(engine, { mode = 'bars', showSource = true, fMin = 20, fMax = 20000, dbMin = -90, dbMax = -10 } = {}) {
  const { c, el } = canvasBox('spectrum');
  const an = engine.taps.spectrum;
  const src = engine.taps.source;
  const bins = new Float32Array(an.frequencyBinCount);
  const sbins = new Float32Array(src.frequencyBinCount);
  const sr = engine.ctx.sampleRate;
  const nBands = GEQ_FREQS.length;
  const bandLevels = new Float32Array(nBands).fill(dbMin);
  const bandPeaks = new Float32Array(nBands).fill(dbMin);
  const peakHold = new Float32Array(nBands);
  const state = { mode, showSource };
  const bandDb = (arr, fc) => {
    const lo = fc / Math.pow(2, 1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    const i0 = Math.max(1, Math.floor((lo / sr) * 2 * arr.length));
    const i1 = Math.min(arr.length - 1, Math.ceil((hi / sr) * 2 * arr.length));
    let e = 0;
    for (let i = i0; i <= i1; i++) e += Math.pow(10, arr[i] / 10);
    return 10 * Math.log10(Math.max(e, 1e-12));
  };
  const draw = (t) => {
    if (!isVisible(c)) return;
    const { ctx, w, h: hh } = fitCanvas(c);
    const pad = { l: 34, r: 8, t: 8, b: 18 };
    const W = w - pad.l - pad.r;
    const H = hh - pad.t - pad.b;
    const X = (f) => pad.l + logPos(f, fMin, fMax) * W;
    const Y = (db) => pad.t + (1 - (clamp(db, dbMin, dbMax) - dbMin) / (dbMax - dbMin)) * H;
    ctx.clearRect(0, 0, w, hh);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = Math.round(X(f)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + H);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'center';
      ctx.fillText(formatHzShort(f), x, hh - 8);
    }
    for (let db = Math.ceil(dbMin / 10) * 10; db <= dbMax; db += 10) {
      const y = Math.round(Y(db)) + 0.5;
      ctx.strokeStyle = db % 20 === 0 ? GRID_STRONG : GRID;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + W, y);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(String(db), pad.l - 6, y);
    }
    an.getFloatFrequencyData(bins);
    if (state.showSource) src.getFloatFrequencyData(sbins);
    const grad = ctx.createLinearGradient(0, pad.t + H, 0, pad.t);
    grad.addColorStop(0, '#36e2cf');
    grad.addColorStop(0.6, '#8d7dff');
    grad.addColorStop(1, '#ff6b9a');
    if (state.mode === 'bars') {
      const bw = W / nBands;
      for (let i = 0; i < nBands; i++) {
        const v = bandDb(bins, GEQ_FREQS[i]);
        bandLevels[i] = v > bandLevels[i] ? v : bandLevels[i] - 0.9;
        if (bandLevels[i] > bandPeaks[i]) {
          bandPeaks[i] = bandLevels[i];
          peakHold[i] = t;
        } else if (t - peakHold[i] > 900) bandPeaks[i] -= 0.5;
        const x = pad.l + i * bw + 1.5;
        const y = Y(bandLevels[i]);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, bw - 3, pad.t + H - y);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, Y(bandPeaks[i]) - 1, bw - 3, 2);
        if (state.showSource) {
          const sv = bandDb(sbins, GEQ_FREQS[i]);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x, Y(sv) - 1, bw - 3, 2);
        }
      }
    } else {
      const drawCurve = (arr, stroke, fill) => {
        ctx.beginPath();
        let started = false;
        const n = arr.length;
        let lastX = -1;
        for (let i = 1; i < n; i++) {
          const f = (i * sr) / (2 * n);
          if (f < fMin || f > fMax) continue;
          const x = X(f);
          if (x - lastX < 1 && i < n - 1) continue;
          lastX = x;
          const y = Y(arr[i]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        if (fill) {
          ctx.lineTo(pad.l + W, pad.t + H);
          ctx.lineTo(pad.l, pad.t + H);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
        } else {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      };
      if (state.showSource) drawCurve(sbins, 'rgba(255,255,255,0.35)');
      const fillGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + H);
      fillGrad.addColorStop(0, 'rgba(141,125,255,0.55)');
      fillGrad.addColorStop(1, 'rgba(54,226,207,0.05)');
      drawCurve(bins, null, fillGrad);
      drawCurve(bins, '#b6acff');
    }
    if (state.showSource) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('— source   ▮ at listener', pad.l + 8, pad.t + 8);
    }
  };
  const off = onFrame(draw);
  return {
    el,
    set(o) {
      Object.assign(state, o);
    },
    destroy: off,
  };
}

// ------------------------------------------------------------------ spectrogram
export function spectrogram(engine, { fMin = 20, fMax = 20000, range = 90 } = {}) {
  const { c, el } = canvasBox('spectrogram');
  const an = engine.taps.spectrum;
  const bins = new Float32Array(an.frequencyBinCount);
  const lut = colormap();
  const sr = engine.ctx.sampleRate;
  let img = null;
  let rowMap = null;
  let lastH = 0;
  const pxPerFrame = 2;
  const draw = () => {
    if (!isVisible(c)) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const hh = Math.max(1, Math.round(c.clientHeight * dpr));
    const ctx = c.getContext('2d');
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
      ctx.fillStyle = '#04040c';
      ctx.fillRect(0, 0, w, hh);
    }
    if (hh !== lastH) {
      lastH = hh;
      img = ctx.createImageData(pxPerFrame, hh);
      rowMap = new Float32Array(hh);
      for (let y = 0; y < hh; y++) {
        const f = fMin * Math.pow(fMax / fMin, 1 - y / (hh - 1));
        rowMap[y] = (f / (sr / 2)) * bins.length;
      }
    }
    an.getFloatFrequencyData(bins);
    // Scroll left.
    ctx.drawImage(c, pxPerFrame, 0, w - pxPerFrame, hh, 0, 0, w - pxPerFrame, hh);
    const top = -12;
    const bottom = top - range;
    const data = img.data;
    for (let y = 0; y < hh; y++) {
      const pos = rowMap[y];
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      const a = bins[Math.min(bins.length - 1, i0)];
      const b = bins[Math.min(bins.length - 1, i0 + 1)];
      const db = a + (b - a) * fr;
      const v = clamp(Math.round(((db - bottom) / (top - bottom)) * 255), 0, 255);
      for (let x = 0; x < pxPerFrame; x++) {
        const o = (y * pxPerFrame + x) * 4;
        data[o] = lut[v * 3];
        data[o + 1] = lut[v * 3 + 1];
        data[o + 2] = lut[v * 3 + 2];
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, w - pxPerFrame, 0);
  };
  const axis = h('div.spec-axis', [20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20].map((f) => h('span', { style: { top: `${(1 - logPos(f, fMin, fMax)) * 100}%` } }, formatHzShort(f))));
  el.appendChild(axis);
  const off = onFrame(draw);
  return { el, destroy: off };
}

// ------------------------------------------------------------------ VU meters
/**
 * Classic VU meter (IEC 60268-17 ballistics: ~300 ms rise, critically
 * damped needle). 0 VU aligned to `reference` dBFS RMS (default −18).
 */
export function vuMeters(engine, { reference = -18 } = {}) {
  const wrap = h('div.vu-pair');
  const meters = ['L', 'R'].map((ch) => {
    const c = h('canvas.viz');
    const box = h('div.vu', c);
    wrap.appendChild(box);
    return { ch, c, an: ch === 'L' ? engine.taps.L : engine.taps.R, pos: -20, vel: 0, peakAt: 0 };
  });
  const buf = new Float32Array(engine.taps.L.fftSize);
  const state = { reference };
  const vuToAngle = (vu) => {
    // Non-linear VU scale: position proportional to voltage.
    const v = Math.pow(10, clamp(vu, -22, 5) / 20);
    const v0 = Math.pow(10, -20 / 20);
    const v1 = Math.pow(10, 3 / 20);
    const t = (v - v0) / (v1 - v0);
    return (-50 + t * 100) * (Math.PI / 180);
  };
  let last = performance.now();
  const draw = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const m of meters) {
      if (!isVisible(m.c)) continue;
      m.an.getFloatTimeDomainData(buf);
      let s = 0;
      let pk = 0;
      for (let i = 0; i < buf.length; i++) {
        s += buf[i] * buf[i];
        pk = Math.max(pk, Math.abs(buf[i]));
      }
      const rms = Math.sqrt(s / buf.length);
      const target = (rms > 1e-7 ? 20 * Math.log10(rms) : -80) - state.reference;
      if (pk > 0.89) m.peakAt = now;
      // Second-order needle: ω≈10.5 rad/s, ζ≈0.81 → ~300 ms to 99 %.
      const w0 = 10.5;
      const zeta = 0.81;
      const tv = clamp(target, -24, 6);
      const acc = w0 * w0 * (tv - m.pos) - 2 * zeta * w0 * m.vel;
      m.vel += acc * dt;
      m.pos += m.vel * dt;
      const { ctx, w, h: hh } = fitCanvas(m.c);
      ctx.clearRect(0, 0, w, hh);
      // Face
      const face = ctx.createLinearGradient(0, 0, 0, hh);
      face.addColorStop(0, '#f6ecd0');
      face.addColorStop(1, '#e2d2a8');
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(2, 2, w - 4, hh - 4, 10) : ctx.rect(2, 2, w - 4, hh - 4);
      ctx.fill();
      const cx = w / 2;
      const cy = hh * 1.05;
      const R = Math.min(w * 0.62, hh * 0.92);
      // Scale arcs
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2b2418';
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.82, -Math.PI / 2 + vuToAngle(-20), -Math.PI / 2 + vuToAngle(0));
      ctx.stroke();
      ctx.strokeStyle = '#c0282a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.8, -Math.PI / 2 + vuToAngle(0), -Math.PI / 2 + vuToAngle(3));
      ctx.stroke();
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const vu of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
        const a = -Math.PI / 2 + vuToAngle(vu);
        const r0 = R * 0.84;
        const r1 = R * (vu === 0 || vu % 5 === 0 || vu === -3 ? 0.93 : 0.89);
        ctx.strokeStyle = vu > 0 ? '#c0282a' : '#2b2418';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
        ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
        ctx.stroke();
        if ([-20, -10, -7, -5, -3, 0, 3].includes(vu)) {
          ctx.fillStyle = vu > 0 ? '#c0282a' : '#2b2418';
          ctx.fillText(vu > 0 ? `+${vu}` : String(vu), cx + R * 1.0 * Math.cos(a), cy + R * 1.0 * Math.sin(a));
        }
      }
      ctx.fillStyle = '#2b2418';
      ctx.font = '800 15px Georgia, serif';
      ctx.fillText('VU', cx, hh * 0.62);
      ctx.font = '700 9px Inter, sans-serif';
      ctx.fillText(m.ch, w - 16, hh - 14);
      // Needle
      const a = -Math.PI / 2 + vuToAngle(m.pos);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.15 * Math.cos(a), cy + R * 0.15 * Math.sin(a));
      ctx.lineTo(cx + R * 0.98 * Math.cos(a), cy + R * 0.98 * Math.sin(a));
      ctx.stroke();
      // Peak LED
      ctx.beginPath();
      ctx.arc(16, 16, 5, 0, Math.PI * 2);
      ctx.fillStyle = now - m.peakAt < 400 ? '#ff3040' : '#5a1a1a';
      ctx.fill();
      // Glass sheen
      const sheen = ctx.createLinearGradient(0, 0, 0, hh * 0.5);
      sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(4, 4, w - 8, hh * 0.45);
    }
  };
  const off = onFrame(draw);
  return { el: wrap, set: (o) => Object.assign(state, o), destroy: off };
}

// ------------------------------------------------------------------ vectorscope
export function vectorscope(engine) {
  const { c, el } = canvasBox('vectorscope');
  const corr = h('div.corr-meter', h('div.corr-track', h('i.corr-needle')), h('div.corr-labels', h('span', '−1'), h('span', '0'), h('span', '+1')));
  const readout = h('div.corr-readout.mono', '+1.00');
  el.append(corr, readout);
  const needle = corr.querySelector('.corr-needle');
  const L = new Float32Array(engine.taps.L.fftSize);
  const R = new Float32Array(engine.taps.R.fftSize);
  let corrSmoothed = 1;
  const draw = () => {
    if (!isVisible(c)) return;
    const { ctx, w, h: hh } = fitCanvas(c);
    engine.taps.L.getFloatTimeDomainData(L);
    engine.taps.R.getFloatTimeDomainData(R);
    // Persistence (phosphor fade)
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(4,4,12,0.28)';
    ctx.fillRect(0, 0, w, hh);
    const cx = w / 2;
    const cy = hh / 2;
    const s = Math.min(w, hh) * 0.46;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx, cy + s);
    ctx.moveTo(cx - s, cy);
    ctx.lineTo(cx + s, cy);
    ctx.moveTo(cx - s * 0.707, cy - s * 0.707);
    ctx.lineTo(cx + s * 0.707, cy + s * 0.707);
    ctx.moveTo(cx + s * 0.707, cy - s * 0.707);
    ctx.lineTo(cx - s * 0.707, cy + s * 0.707);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.fillText('M', cx, cy - s - 2);
    ctx.fillText('L', cx - s * 0.74, cy - s * 0.74);
    ctx.fillText('R', cx + s * 0.74, cy - s * 0.74);
    // Auto-gain so quiet material is visible.
    let mx = 0;
    let sl = 0;
    let sr2 = 0;
    let slr = 0;
    for (let i = 0; i < L.length; i++) {
      mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
      sl += L[i] * L[i];
      sr2 += R[i] * R[i];
      slr += L[i] * R[i];
    }
    const gain = mx > 1e-4 ? Math.min(6, 0.9 / mx) : 1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(80,255,210,0.55)';
    for (let i = 0; i < L.length; i += 1) {
      const x = cx + ((R[i] - L[i]) * 0.7071) * s * gain;
      const y = cy - ((L[i] + R[i]) * 0.7071) * s * gain;
      ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.globalCompositeOperation = 'source-over';
    const den = Math.sqrt(sl * sr2);
    const r = den > 1e-9 ? slr / den : corrSmoothed;
    corrSmoothed = corrSmoothed * 0.85 + r * 0.15;
    needle.style.left = `${((corrSmoothed + 1) / 2) * 100}%`;
    needle.style.background = corrSmoothed < 0 ? '#ff5470' : corrSmoothed < 0.3 ? '#ffb547' : '#3ee69b';
    readout.textContent = `${corrSmoothed >= 0 ? '+' : ''}${corrSmoothed.toFixed(2)}`;
  };
  const off = onFrame(draw);
  return { el, destroy: off };
}

// ------------------------------------------------------------------ loudness
/**
 * EBU R128 loudness: momentary (400 ms), short-term (3 s), integrated
 * (gated, since reset) and loudness range, from K-weighted analyser taps.
 */
export function loudnessMeter(engine) {
  const kL = engine.taps.kL;
  const kR = engine.taps.kR;
  const n = kL.fftSize;
  const bl = new Float32Array(n);
  const br = new Float32Array(n);
  const blockN = Math.round(0.4 * engine.ctx.sampleRate);
  const blocks = []; // mean-square energies of 400 ms blocks (100 ms hop)
  const shortTerm = [];
  const mEl = h('div.lufs-value.mono', '—');
  const sEl = h('div.lufs-value.mono', '—');
  const iEl = h('div.lufs-value.mono', '—');
  const lraEl = h('div.lufs-value.mono', '—');
  const tpEl = h('div.lufs-value.mono', '—');
  const hist = h('canvas.viz');
  const reset = h('button.btn.small.ghost', 'Reset');
  const el = h(
    'div.lufs',
    h('div.lufs-grid',
      h('div.lufs-cell', mEl, h('div.stat-label', 'Momentary')),
      h('div.lufs-cell', sEl, h('div.stat-label', 'Short-term')),
      h('div.lufs-cell.big', iEl, h('div.stat-label', 'Integrated')),
      h('div.lufs-cell', lraEl, h('div.stat-label', 'LRA')),
      h('div.lufs-cell', tpEl, h('div.stat-label', 'Sample peak')),
    ),
    h('div.lufs-hist', hist),
    h('div.split', h('span.dim', { style: { fontSize: '11.5px' } }, 'ITU-R BS.1770-4 K-weighting · EBU R128 gating · target −14 LUFS (streaming)'), h('div.grow'), reset),
  );
  let peak = 0;
  const history = [];
  reset.addEventListener('click', () => {
    blocks.length = 0;
    shortTerm.length = 0;
    history.length = 0;
    peak = 0;
  });
  const lufs = (ms) => (ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
  const fmt = (v) => (Number.isFinite(v) && v > -70 ? v.toFixed(1) : '—');
  const timer = setInterval(() => {
    if (engine.ctx.state !== 'running') return;
    kL.getFloatTimeDomainData(bl);
    kR.getFloatTimeDomainData(br);
    let s = 0;
    for (let i = n - blockN; i < n; i++) s += bl[i] * bl[i] + br[i] * br[i];
    const ms = s / blockN;
    blocks.push(ms);
    if (blocks.length > 36000) blocks.shift();
    const M = lufs(ms);
    const last30 = blocks.slice(-30);
    const S = lufs(last30.reduce((a, b) => a + b, 0) / Math.max(1, last30.length));
    if (Number.isFinite(S)) {
      shortTerm.push(S);
      if (shortTerm.length > 36000) shortTerm.shift();
    }
    // Integrated: absolute gate −70 LUFS, relative gate −10 LU.
    const abs = blocks.filter((b) => lufs(b) > -70);
    let I = -Infinity;
    if (abs.length) {
      const g1 = lufs(abs.reduce((a, b) => a + b, 0) / abs.length);
      const rel = abs.filter((b) => lufs(b) > g1 - 10);
      if (rel.length) I = lufs(rel.reduce((a, b) => a + b, 0) / rel.length);
    }
    // LRA from short-term distribution (10th–95th percentile, gated).
    let LRA = NaN;
    const st = shortTerm.filter((v) => v > -70);
    if (st.length > 10) {
      const lin = st.map((v) => Math.pow(10, v / 10));
      const g = 10 * Math.log10(lin.reduce((a, b) => a + b, 0) / lin.length) - 20;
      const sorted = st.filter((v) => v > g).sort((a, b) => a - b);
      if (sorted.length > 2) LRA = percentile(sorted, 0.95) - percentile(sorted, 0.1);
    }
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(bl[i]), Math.abs(br[i]));
    mEl.textContent = fmt(M);
    sEl.textContent = fmt(S);
    iEl.textContent = fmt(I);
    lraEl.textContent = Number.isFinite(LRA) ? LRA.toFixed(1) : '—';
    tpEl.textContent = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '—';
    history.push(Number.isFinite(S) ? S : -70);
    if (history.length > 600) history.shift();
    if (isVisible(hist)) {
      const { ctx, w, h: hh } = fitCanvas(hist);
      ctx.clearRect(0, 0, w, hh);
      const Y = (v) => hh - ((clamp(v, -50, 0) + 50) / 50) * hh;
      ctx.strokeStyle = GRID;
      for (const v of [-10, -20, -30, -40]) {
        ctx.beginPath();
        ctx.moveTo(0, Y(v));
        ctx.lineTo(w, Y(v));
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,181,71,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, Y(-14));
      ctx.lineTo(w, Y(-14));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      history.forEach((v, i) => {
        const x = w - (history.length - 1 - i) * (w / 600);
        if (i === 0) ctx.moveTo(x, Y(v));
        else ctx.lineTo(x, Y(v));
      });
      ctx.strokeStyle = '#8d7dff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, 100);
  return { el, destroy: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ sub-bass monitor
export function bassMonitor(app) {
  const { c, el } = canvasBox('bass-monitor');
  const tap = app.engine.taps.lfe;
  const buf = new Float32Array(tap.fftSize);
  const history = new Float32Array(240);
  let pulse = 0;
  const offPulse = app.haptics.on('pulse', (p) => (pulse = Math.max(pulse, p.strength)));
  const draw = () => {
    if (!isVisible(c)) return;
    const { ctx, w, h: hh } = fitCanvas(c);
    tap.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    const lvl = Math.min(1, Math.sqrt(s / buf.length) * 6);
    history.copyWithin(0, 1);
    history[history.length - 1] = lvl;
    ctx.clearRect(0, 0, w, hh);
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * w;
      const y = hh - history[i] * hh * 0.9;
      if (!i) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, hh);
    ctx.lineTo(0, hh);
    const g = ctx.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, 'rgba(255,107,154,0.8)');
    g.addColorStop(1, 'rgba(141,125,255,0.1)');
    ctx.fillStyle = g;
    ctx.fill();
    pulse *= 0.9;
    if (pulse > 0.02) {
      ctx.beginPath();
      ctx.arc(w - 26, 26, 8 + pulse * 14, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,107,154,${0.25 + pulse * 0.6})`;
      ctx.fill();
    }
    ctx.fillStyle = LABEL;
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.fillText('LFE / subwoofer bus envelope → haptics', 10, 14);
  };
  const off = onFrame(draw);
  return { el, destroy: () => { off(); offPulse(); } };
}
