// Greedy parametric-EQ fitting. Given a target magnitude curve (dB) on a
// frequency grid, find a small set of peaking (and optional shelf) filters whose
// cascade approximates it. Used both to *emulate* rooms (fit modal responses)
// and to *correct* them (fit the inverse of a predicted in-room response).

import { coefficients, evalCoefficients } from './biquad.js';
import { clamp } from '../util/math.js';

function specDbOnGrid(spec, freqs, sampleRate, out) {
  const c = coefficients(spec, sampleRate);
  for (let i = 0; i < freqs.length; i++) {
    const [re, im] = evalCoefficients(c, freqs[i], sampleRate);
    out[i] = 10 * Math.log10(re * re + im * im + 1e-300);
  }
  return out;
}

function weightedError(residual, cand, weights, lo, hi) {
  let e = 0;
  for (let i = lo; i <= hi; i++) {
    const d = residual[i] - cand[i];
    e += d * d * weights[i];
  }
  return e;
}

/**
 * @param {Float64Array|number[]} freqs ascending frequency grid (Hz)
 * @param {Float64Array|number[]} targetDb desired cascade magnitude in dB at each freq
 * @param {object} opts
 * @returns {{filters: object[], residualDb: Float64Array, rmsErrorDb: number}}
 */
export function fitFilters(freqs, targetDb, opts = {}) {
  const {
    sampleRate = 48000,
    maxFilters = 8,
    fMin = freqs[0],
    fMax = freqs[freqs.length - 1],
    maxBoost = 12,
    maxCut = 18,
    qMin = 0.7,
    qMax = 16,
    tolerance = 0.6,
    shelf = false, // fit a low-shelf first to capture broadband offset
    shelfFreq = null,
    weights = null,
    poleQMax = null, // (f) => max pole Q of a boost (limits ringing, e.g. to physical modal damping)
  } = opts;
  // A peaking boost of gain G has poles with Q·A (A = 10^(G/40)); cap it.
  const limitQ = (spec) => {
    if (!poleQMax || spec.type !== 'peaking' || !(spec.gain > 0)) return spec;
    const qCap = Math.max(qMin, poleQMax(spec.frequency) / Math.pow(10, spec.gain / 40));
    return spec.Q > qCap ? { ...spec, Q: qCap } : spec;
  };
  const n = freqs.length;
  let lo = 0;
  while (lo < n - 1 && freqs[lo] < fMin) lo++;
  let hi = n - 1;
  while (hi > 0 && freqs[hi] > fMax) hi--;
  const residual = Float64Array.from(targetDb);
  const w = weights ? Float64Array.from(weights) : new Float64Array(n).fill(1);
  const cand = new Float64Array(n);
  const filters = [];
  // Running cascade response: maxBoost/maxCut limit the *cascade*, not just
  // each filter, so overlapping boosts can never stack beyond the limit.
  const total = new Float64Array(n);
  const withinLimits = (c) => {
    for (let i = 0; i < n; i++) {
      const v = total[i] + c[i];
      if (v > maxBoost + 0.01 || v < -maxCut - 0.01) return false;
    }
    return true;
  };

  if (shelf && hi > lo) {
    // Broadband offset below shelfFreq captured by a low shelf.
    const sf = shelfFreq || Math.sqrt(freqs[lo] * freqs[hi]);
    let sum = 0;
    let cnt = 0;
    for (let i = lo; i <= hi; i++) {
      if (freqs[i] <= sf * 0.7) {
        sum += residual[i];
        cnt++;
      }
    }
    const g = cnt ? clamp(sum / cnt, -maxCut, maxBoost) : 0;
    if (Math.abs(g) > 0.5) {
      // Refine shelf frequency.
      let best = null;
      for (const fm of [0.7, 0.85, 1, 1.2, 1.45]) {
        const spec = { type: 'lowshelf', frequency: sf * fm, gain: g };
        specDbOnGrid(spec, freqs, sampleRate, cand);
        const e = weightedError(residual, cand, w, lo, hi);
        if (!best || e < best.e) best = { e, spec };
      }
      specDbOnGrid(best.spec, freqs, sampleRate, cand);
      for (let i = 0; i < n; i++) {
        residual[i] -= cand[i];
        total[i] += cand[i];
      }
      filters.push(best.spec);
    }
  }

  // Skipped points (no headroom, no improvement) cost attempts, not filters.
  for (let attempt = 0; filters.length < maxFilters && attempt < maxFilters * 8; attempt++) {
    // Largest weighted deviation.
    let idx = -1;
    let maxAbs = 0;
    for (let i = lo; i <= hi; i++) {
      const v = Math.abs(residual[i]) * Math.sqrt(w[i]);
      if (v > maxAbs) {
        maxAbs = v;
        idx = i;
      }
    }
    if (idx < 0 || maxAbs < tolerance) break;
    const peak = residual[idx];
    let gain = clamp(peak, -maxCut - total[idx], maxBoost - total[idx]);
    if (Math.abs(gain) < tolerance * 0.5) {
      // No headroom left here: stop chasing this point.
      w[idx] *= 0.25;
      continue;
    }
    // Estimate bandwidth from half-gain crossings.
    const half = peak / 2;
    let l = idx;
    while (l > lo && Math.sign(residual[l] - half) === Math.sign(peak) && Math.abs(residual[l]) > Math.abs(half)) l--;
    let r = idx;
    while (r < hi && Math.sign(residual[r] - half) === Math.sign(peak) && Math.abs(residual[r]) > Math.abs(half)) r++;
    const f0 = freqs[idx];
    const bw = Math.max(freqs[r] - freqs[l], f0 * 0.05);
    let q = clamp(f0 / bw, qMin, qMax);

    // Local refinement: coordinate search over frequency, Q and gain.
    let best = { spec: null, e: Infinity };
    const tryCand = (raw) => {
      const spec = limitQ(raw);
      specDbOnGrid(spec, freqs, sampleRate, cand);
      if (!withinLimits(cand)) return;
      const e = weightedError(residual, cand, w, lo, hi);
      if (e < best.e) best = { spec, e };
    };
    // Start from the estimate, backing the gain off until the cascade fits.
    for (let g = gain, tries = 0; tries < 12 && !best.spec; tries++, g *= 0.8) tryCand({ type: 'peaking', frequency: f0, Q: q, gain: g });
    if (!best.spec) {
      w[idx] *= 0.25;
      continue;
    }
    for (let pass = 0; pass < 3; pass++) {
      const s = best.spec;
      const scale = 1 / (pass + 1);
      for (const fm of [Math.pow(2, -scale / 6), Math.pow(2, scale / 6)]) {
        tryCand({ ...s, frequency: clamp(s.frequency * fm, freqs[lo], freqs[hi]) });
      }
      const s2 = best.spec;
      for (const qm of [1 - 0.35 * scale, 1 + 0.5 * scale]) {
        tryCand({ ...s2, Q: clamp(s2.Q * qm, qMin, qMax) });
      }
      const s3 = best.spec;
      for (const gm of [0.8, 1.15]) {
        tryCand({ ...s3, gain: clamp(s3.gain * gm, -maxCut, maxBoost) });
      }
    }
    // Accept only if it helps.
    const before = weightedError(residual, new Float64Array(n), w, lo, hi);
    if (best.e >= before * 0.995) {
      // Mark region as handled to avoid retrying the same point forever.
      w[idx] *= 0.25;
      continue;
    }
    specDbOnGrid(best.spec, freqs, sampleRate, cand);
    for (let i = 0; i < n; i++) {
      residual[i] -= cand[i];
      total[i] += cand[i];
    }
    q = best.spec.Q;
    gain = best.spec.gain;
    filters.push({ type: 'peaking', frequency: best.spec.frequency, Q: q, gain });
  }

  let sq = 0;
  let cnt = 0;
  for (let i = lo; i <= hi; i++) {
    sq += residual[i] * residual[i];
    cnt++;
  }
  return { filters, residualDb: residual, rmsErrorDb: cnt ? Math.sqrt(sq / cnt) : 0 };
}

/**
 * Fractional-octave smoothing of a dB curve (power-average in each window).
 * @param {number} fraction e.g. 6 for 1/6 octave
 */
export function smoothOctave(freqs, db, fraction = 6) {
  const n = freqs.length;
  const out = new Float64Array(n);
  const halfWin = Math.pow(2, 1 / (2 * fraction));
  let l = 0;
  let r = 0;
  let acc = 0;
  const pw = new Float64Array(n);
  for (let i = 0; i < n; i++) pw[i] = Math.pow(10, db[i] / 10);
  for (let i = 0; i < n; i++) {
    const fl = freqs[i] / halfWin;
    const fh = freqs[i] * halfWin;
    while (r < n && freqs[r] <= fh) acc += pw[r++];
    while (l < r && freqs[l] < fl) acc -= pw[l++];
    const cnt = r - l;
    out[i] = cnt > 0 ? 10 * Math.log10(Math.max(acc / cnt, 1e-30)) : db[i];
  }
  return out;
}

/** Variable ("psychoacoustic") smoothing: 1/12 oct below 200 Hz, widening to 1/3 oct at high frequencies. */
export function smoothVariable(freqs, db) {
  const a = smoothOctave(freqs, db, 12);
  const b = smoothOctave(freqs, db, 3);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const t = clamp(Math.log2(freqs[i] / 200) / Math.log2(4000 / 200), 0, 1);
    out[i] = a[i] * (1 - t) + b[i] * t;
  }
  return out;
}
