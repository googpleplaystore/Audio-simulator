// Low-frequency room response via modal summation for a rectangular room.
//
//   p(r)/p_ff(1 m) = (4π c² / V) · Σ_n ψ_n(r) ψ_n(r0) / (Λ_n (ω_n² − ω² + 2jδ_n ω))
//
// ψ_n are the rigid-wall cosine eigenfunctions, Λ_n their mean-square value,
// and δ_n the modal damping constant derived from the absorption of the walls
// the mode's plane waves actually strike (direction-cosine weighted). The
// spatial/frequency average of |H|² reduces to 16π/A — the classic statistical
// reverberant-to-direct ratio — so this model and the reverb model agree.

import { roomModes, roomSpeedOfSound, volume, modalCrossover } from './room.js';
import { alphaAt } from './materials.js';
import { clamp, octaveGrid } from '../util/math.js';
import { fitFilters } from '../dsp/fit.js';

const LEAK_DAMPING = 2.5; // s⁻¹, energy leaking through doors/windows/flexing walls

/** Pre-compute the modal basis for a room. */
export function buildModalModel(room, fMax) {
  const c = roomSpeedOfSound(room);
  const V = volume(room);
  const { width: Lx, height: Ly, depth: Lz, materials } = room;
  const modes = roomModes(room, fMax, 3000);
  const n = modes.length;
  const nx = new Int32Array(n);
  const ny = new Int32Array(n);
  const nz = new Int32Array(n);
  const w2 = new Float64Array(n);
  const delta = new Float64Array(n);
  const invLambda = new Float64Array(n);
  let maxDelta = 0;
  for (let i = 0; i < n; i++) {
    const m = modes[i];
    nx[i] = m.nx;
    ny[i] = m.ny;
    nz[i] = m.nz;
    const w = 2 * Math.PI * m.f;
    w2[i] = w * w;
    invLambda[i] = (m.nx ? 2 : 1) * (m.ny ? 2 : 1) * (m.nz ? 2 : 1);
    if (m.f === 0) continue;
    const f = Math.max(m.f, 20);
    const k = w / c;
    const axes = [
      { n: m.nx, L: Lx, lo: materials.left, hi: materials.right },
      { n: m.ny, L: Ly, lo: materials.floor, hi: materials.ceiling },
      { n: m.nz, L: Lz, lo: materials.front, hi: materials.back },
    ];
    let d = 0;
    for (const ax of axes) {
      const a = -Math.log(Math.max(1e-4, (1 - alphaAt(ax.lo, f)) * (1 - alphaAt(ax.hi, f))));
      const ki = (ax.n * Math.PI) / ax.L;
      const cosine = Math.max(ki / k, 0.15);
      d += (c / 4) * (a / ax.L) * cosine;
    }
    delta[i] = d + LEAK_DAMPING;
    if (delta[i] > maxDelta) maxDelta = delta[i];
  }
  // The pressure (0,0,0) "mode" represents room pressurisation; real rooms leak.
  for (let i = 0; i < n; i++) if (modes[i].f === 0) delta[i] = Math.max(maxDelta * 2, 25);
  return { room, c, V, Lx, Ly, Lz, n, nx, ny, nz, w2, delta, invLambda, fMax, K: (4 * Math.PI * c * c) / V };
}

function psiAll(model, p, out = new Float64Array(model.n)) {
  const { n, nx, ny, nz, Lx, Ly, Lz } = model;
  const px = (Math.PI * p.x) / Lx;
  const py = (Math.PI * (p.y ?? 0)) / Ly;
  const pz = (Math.PI * p.z) / Lz;
  for (let i = 0; i < n; i++) out[i] = Math.cos(nx[i] * px) * Math.cos(ny[i] * py) * Math.cos(nz[i] * pz);
  return out;
}

/**
 * Complex transfer function from src to listener, relative to the free-field
 * pressure at 1 m. Returns {re, im} Float64Arrays over freqs.
 */
export function modalTransfer(model, src, lis, freqs) {
  const ps = psiAll(model, src);
  const pl = psiAll(model, lis);
  const { n, w2, delta, invLambda, K } = model;
  const coef = new Float64Array(n);
  for (let i = 0; i < n; i++) coef[i] = ps[i] * pl[i] * invLambda[i];
  const re = new Float64Array(freqs.length);
  const im = new Float64Array(freqs.length);
  for (let fi = 0; fi < freqs.length; fi++) {
    const w = 2 * Math.PI * freqs[fi];
    const ww = w * w;
    let sr = 0;
    let si = 0;
    for (let i = 0; i < n; i++) {
      const c = coef[i];
      if (c === 0) continue;
      const dr = w2[i] - ww;
      const di = 2 * delta[i] * w;
      const den = dr * dr + di * di;
      sr += (c * dr) / den;
      si -= (c * di) / den;
    }
    re[fi] = K * sr;
    im[fi] = K * si;
  }
  return { re, im };
}

/**
 * Low-frequency power output of a source position relative to a reference
 * position (default: centre of the floor). Captures boundary/corner loading as
 * predicted by the modal model, averaged over [f1, f2].
 */
export function modalBoundaryGainDb(model, src, ref, f1 = 25, f2 = 90) {
  const freqs = octaveGrid(f1, f2, 12);
  const ps = psiAll(model, src);
  const pr = psiAll(model, ref);
  const { n, w2, delta, invLambda } = model;
  let es = 0;
  let er = 0;
  for (let i = 0; i < n; i++) {
    let wsum = 0;
    for (let fi = 0; fi < freqs.length; fi++) {
      const w = 2 * Math.PI * freqs[fi];
      const dr = w2[i] - w * w;
      const di = 2 * delta[i] * w;
      wsum += 1 / (dr * dr + di * di);
    }
    // Spatially averaged pressure² for mode i is ψ(src)²·invΛ·|1/D|².
    es += ps[i] * ps[i] * invLambda[i] * wsum;
    er += pr[i] * pr[i] * invLambda[i] * wsum;
  }
  return 10 * Math.log10(Math.max(es, 1e-30) / Math.max(er, 1e-30));
}

/** 4th-order Linkwitz-Riley low-pass magnitude (for blending modal→statistical regions). */
function lr4LowMag(f, fc) {
  const x = (f / fc) ** 2;
  // |LP_bw2|² = 1/(1+x²) ; LR4 = square of BW2 magnitude
  return 1 / (1 + x * x);
}

/**
 * Magnitude target (dB) for the per-source "room filter" that is applied to the
 * direct path: below the modal crossover it equals the modal response relative
 * to the free field at the listener distance; above it blends to 0 dB (the
 * reverb convolver supplies the diffuse field there).
 */
export const HEAD_OFFSETS = [
  [0, 0, 0],
  [0.1, 0, 0],
  [-0.1, 0, 0],
  [0, 0, 0.1],
  [0, 0, -0.1],
];

/**
 * Energy-averaged modal transfer over a small head-sized region. A single
 * point in a room has arbitrarily deep modal nulls; two ears ~18 cm apart and
 * natural head movement make the perceived response considerably smoother.
 */
export function modalPowerAveraged(model, src, lis, freqs, offsets = HEAD_OFFSETS) {
  const pw = new Float64Array(freqs.length);
  for (const [ox, oy, oz] of offsets) {
    const p = { x: lis.x + ox, y: (lis.y ?? 1.15) + oy, z: lis.z + oz };
    const { re, im } = modalTransfer(model, src, p, freqs);
    for (let i = 0; i < freqs.length; i++) pw[i] += re[i] * re[i] + im[i] * im[i];
  }
  for (let i = 0; i < freqs.length; i++) pw[i] /= offsets.length;
  return pw;
}

export function roomFilterTarget(model, src, lis, freqs, crossover) {
  const pw = modalPowerAveraged(model, src, lis, freqs);
  const dx = src.x - lis.x;
  const dy = (src.y ?? 0) - (lis.y ?? 0);
  const dz = src.z - lis.z;
  const r = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.25);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const mag = Math.sqrt(pw[i]) * r;
    const wl = lr4LowMag(freqs[i], crossover);
    const lin = wl * mag + (1 - wl);
    out[i] = clamp(20 * Math.log10(Math.max(lin, 1e-4)), -22, 20);
  }
  return out;
}

/**
 * Physical modal Q at frequency f: ω/(2δ) of the least-damped mode within
 * ±⅓ octave (or the nearest mode). Fitted boosts may not ring longer.
 */
export function modalQ(model, f) {
  const { n, w2, delta } = model;
  let best = Infinity;
  let nearest = Infinity;
  let nearestD = 0;
  for (let i = 0; i < n; i++) {
    if (w2[i] <= 0) continue;
    const fn = Math.sqrt(w2[i]) / (2 * Math.PI);
    const dist = Math.abs(Math.log2(fn / f));
    if (dist <= 1 / 3 && delta[i] < best) best = delta[i];
    if (dist < nearest) {
      nearest = dist;
      nearestD = delta[i];
    }
  }
  const d = Number.isFinite(best) ? best : nearestD || 10;
  return (Math.PI * f) / d;
}

/**
 * Fit a compact biquad bank emulating the modal room response for one
 * source→listener pair.
 */
export function fitRoomFilters(model, src, lis, opts = {}) {
  const crossover = opts.crossover ?? modalCrossover(model.room);
  const fTop = Math.min(crossover * 1.8, 600);
  const freqs = octaveGrid(15, fTop, 32);
  const target = roomFilterTarget(model, src, lis, freqs, crossover);
  const res = fitFilters(freqs, target, {
    sampleRate: opts.sampleRate ?? 48000,
    maxFilters: opts.maxFilters ?? 10,
    fMin: 15,
    fMax: fTop,
    maxBoost: 20,
    maxCut: 22,
    qMin: 0.8,
    qMax: 24,
    tolerance: 0.75,
    shelf: true,
    shelfFreq: crossover * 0.8,
    poleQMax: (f) => modalQ(model, f),
  });
  return { filters: res.filters, freqs, target, rmsErrorDb: res.rmsErrorDb, crossover };
}

/**
 * Bass response heat map over the listening plane.
 * sources: [{pos:{x,y,z}, gain:(f)=>[re,im]}] electrical/driver response per source.
 * Returns {cols, rows, data: Float32Array (dB, mean power over freqs)}.
 */
export function bassHeatmap(model, sources, opts = {}) {
  const { cols = 48, rows = 36, height = 1.15, freqs = octaveGrid(25, 120, 6) } = opts;
  const { n, nx, ny, nz, Lx, Ly, Lz, w2, delta, invLambda, K } = model;
  const nf = freqs.length;
  // C[f][mode] complex = Σ_s g_s(f) ψ_n(src) invΛ / D_n(f)
  const Cr = new Float64Array(nf * n);
  const Ci = new Float64Array(nf * n);
  for (const s of sources) {
    const ps = psiAll(model, s.pos);
    for (let fi = 0; fi < nf; fi++) {
      const w = 2 * Math.PI * freqs[fi];
      const [gr, gi] = s.gain(freqs[fi]);
      for (let i = 0; i < n; i++) {
        if (ps[i] === 0) continue;
        const dr = w2[i] - w * w;
        const di = 2 * delta[i] * w;
        const den = dr * dr + di * di;
        // (ψ invΛ) / D  = ψ invΛ (dr - j di)/den
        const ar = (ps[i] * invLambda[i] * dr) / den;
        const ai = (-ps[i] * invLambda[i] * di) / den;
        Cr[fi * n + i] += gr * ar - gi * ai;
        Ci[fi * n + i] += gr * ai + gi * ar;
      }
    }
  }
  const cosY = new Float64Array(n);
  for (let i = 0; i < n; i++) cosY[i] = Math.cos((ny[i] * Math.PI * height) / Ly);
  // Per-axis cosine tables.
  const maxNx = Math.max(0, ...nx);
  const maxNz = Math.max(0, ...nz);
  const tx = new Float64Array((maxNx + 1) * cols);
  const tz = new Float64Array((maxNz + 1) * rows);
  for (let k = 0; k <= maxNx; k++) for (let c = 0; c < cols; c++) tx[k * cols + c] = Math.cos((k * Math.PI * ((c + 0.5) / cols) * Lx) / Lx);
  for (let k = 0; k <= maxNz; k++) for (let r = 0; r < rows; r++) tz[k * rows + r] = Math.cos((k * Math.PI * ((r + 0.5) / rows) * Lz) / Lz);
  const data = new Float32Array(cols * rows);
  const std = new Float32Array(cols * rows); // unevenness: std-dev of the dB response over freqs
  const psi = new Float64Array(n);
  const db = new Float64Array(nf);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let i = 0; i < n; i++) psi[i] = tx[nx[i] * cols + c] * cosY[i] * tz[nz[i] * rows + r];
      let pw = 0;
      let mean = 0;
      for (let fi = 0; fi < nf; fi++) {
        let sr = 0;
        let si = 0;
        const base = fi * n;
        for (let i = 0; i < n; i++) {
          sr += Cr[base + i] * psi[i];
          si += Ci[base + i] * psi[i];
        }
        const p = K * K * (sr * sr + si * si);
        pw += p;
        db[fi] = 10 * Math.log10(p + 1e-20);
        mean += db[fi];
      }
      mean /= nf;
      let v = 0;
      for (let fi = 0; fi < nf; fi++) v += (db[fi] - mean) ** 2;
      data[r * cols + c] = 10 * Math.log10(pw / nf + 1e-20);
      std[r * cols + c] = Math.sqrt(v / nf);
    }
  }
  return { cols, rows, data, std, freqs: Array.from(freqs) };
}
