// Virtual acoustic measurements ("REW in the browser").
//
// An exponential sine sweep (Farina) is rendered through the complete
// offline simulation to a virtual omni microphone at the listening position.
// Regularised spectral division turns the recording into the linear impulse
// response plus, at negative times, one impulse response per harmonic, from
// which we derive: SPL and phase, group delay, impulse and step response,
// energy-time curve, Schroeder decay with EDT/T20/T30 and clarity per octave,
// cumulative spectral decay (waterfall) and harmonic distortion.
//
// Everything except `runSweepMeasurement` is pure and runs in Node.

import { fft } from '../dsp/fft.js';
import { smoothOctave, smoothVariable } from '../dsp/fit.js';
import { bandLimit } from '../acoustics/ir.js';
import { coefficients, evalCoefficients, butterworth } from '../dsp/biquad.js';
import { BANDS } from '../acoustics/materials.js';
import { clamp, octaveGrid, nextPow2 } from '../util/math.js';

export const REF_SPL = 100; // mic output 1.0 ≙ 100 dB SPL (see plan.js)
export const HARMONICS = [2, 3, 4, 5];

// ------------------------------------------------------------------ sweep

/**
 * Exponential sine sweep with raised-cosine fades.
 * @returns {{signal: Float32Array, sampleRate:number, f1:number, f2:number, L:number, amplitude:number}}
 */
export function makeSweep({ sampleRate, f1 = 10, f2 = 22000, seconds = 2.7, levelDb = -12 }) {
  f2 = Math.min(f2, sampleRate * 0.46);
  const n = Math.round(seconds * sampleRate);
  const T = n / sampleRate;
  const L = T / Math.log(f2 / f1);
  const amplitude = Math.pow(10, levelDb / 20);
  const signal = new Float32Array(n);
  const fadeIn = Math.min(n / 4, Math.round((2 / f1) * sampleRate)); // two cycles of f1
  const fadeOut = Math.min(n / 8, Math.round(0.005 * sampleRate));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let w = 1;
    if (i < fadeIn) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    else if (i > n - fadeOut) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / fadeOut);
    signal[i] = amplitude * w * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  return { signal, sampleRate, f1, f2, L, amplitude };
}

// ------------------------------------------------------------ deconvolution

/**
 * Deconvolve a recording by the sweep. Returns the full circular response
 * (length nFft): the linear IR at t ≥ 0, harmonic IRs wrapped to the end.
 */
/**
 * The measurement band's low edge is a causal (minimum-phase) 2nd-order
 * Butterworth high-pass at a fifth of the sweep start: unlike a zero-phase
 * band limit it cannot pre-ring, so the IR window never truncates it. Its
 * (tiny) effect is divided out of the reported response.
 */
function measurementHighpass(sweep) {
  return butterworth('highpass', 2, sweep.f1 / 5).map((sp) => coefficients(sp, sweep.sampleRate));
}

function cascadeComplex(coeffs, f, fs) {
  let re = 1;
  let im = 0;
  for (const c of coeffs) {
    const [a, b] = evalCoefficients(c, f, fs);
    const r = re * a - im * b;
    im = re * b + im * a;
    re = r;
  }
  return [re, im];
}

export function deconvolve(sweep, recording) {
  const n = nextPow2(Math.max(sweep.signal.length, recording.length) + 1);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  xr.set(sweep.signal);
  yr.set(recording.subarray(0, Math.min(recording.length, n)));
  fft(xr, xi);
  fft(yr, yi);
  let maxP = 0;
  for (let k = 0; k <= n / 2; k++) maxP = Math.max(maxP, xr[k] * xr[k] + xi[k] * xi[k]);
  const fs = sweep.sampleRate;
  const hi = sweep.f2 / 1.02;
  const hp = measurementHighpass(sweep);
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * fs) / n;
    // Tiny regularisation up to the sweep's top frequency, rising steeply
    // above it (a short, zero-phase transition that fits in the pre-window).
    const oct = f > hi ? Math.log2(f / hi) : 0;
    const reg = Math.min(1, 1e-10 * Math.pow(10, Math.min(oct * 40, 10)));
    const p = xr[k] * xr[k] + xi[k] * xi[k] + reg * maxP;
    let re = (yr[k] * xr[k] + yi[k] * xi[k]) / p;
    let im = (yi[k] * xr[k] - yr[k] * xi[k]) / p;
    const [br, bi] = cascadeComplex(hp, Math.max(f, 1e-6), fs);
    const r2 = re * br - im * bi;
    im = re * bi + im * br;
    re = r2;
    yr[k] = re;
    yi[k] = im;
    if (k > 0 && k < n / 2) {
      yr[n - k] = re;
      yi[n - k] = -im;
    }
  }
  fft(yr, yi, true);
  return Float32Array.from(yr);
}

/**
 * Split a deconvolved response into the linear IR (from `preMs` before its
 * peak) and the harmonic IRs aligned the same way.
 */
export function splitResponse(full, sweep, { preMs = 10, maxSeconds = 2.5 } = {}) {
  const fs = sweep.sampleRate;
  const n = full.length;
  const lnK = (k) => sweep.L * Math.log(k) * fs; // samples before the linear IR
  const pre = Math.round((preMs / 1000) * fs);
  // Distortion products of every order occupy negative times down to −T, so
  // the linear IR may use [0, n − T − pre).
  const linEnd = Math.max(1, Math.floor(n - sweep.signal.length - pre));
  let peak = 0;
  let pi = 0;
  for (let i = 0; i < Math.min(linEnd, Math.round(0.5 * fs)); i++) {
    const a = Math.abs(full[i]);
    if (a > peak) {
      peak = a;
      pi = i;
    }
  }
  // The pre-window may wrap to the end of the buffer when the delay is tiny.
  const start = pi - pre;
  const len = Math.max(1, Math.min(linEnd - start, Math.round(maxSeconds * fs)));
  const ir = new Float32Array(len);
  for (let i = 0; i < len; i++) ir[i] = full[(((start + i) % n) + n) % n];
  const harmonics = HARMONICS.map((k) => {
    // Harmonic k sits at −L·ln k; its tail must end before the pre-window of
    // harmonic k−1 (the linear IR for k = 2).
    const spacing = lnK(k) - lnK(k - 1);
    const hLen = Math.max(8, Math.floor(Math.min(spacing - 2 * pre, 0.25 * fs)));
    const out = new Float32Array(hLen + pre);
    const s0 = start - Math.round(lnK(k));
    for (let i = 0; i < out.length; i++) out[i] = full[(((s0 + i) % n) + n) % n];
    return { k, ir: out };
  });
  return { ir, delaySamples: start, peakIndex: pi - start, harmonics, sampleRate: fs, sweepF1: sweep.f1 };
}

// ------------------------------------------------------------ analysis

function spectrum(signal, n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(signal.length > n ? signal.subarray(0, n) : signal);
  fft(re, im);
  return { re, im, n };
}

/** Tukey-style window: half-Hann rise over `left` samples, flat, half-Hann fall over `right`. */
function applyWindow(sig, left, right) {
  const out = Float64Array.from(sig);
  const n = out.length;
  for (let i = 0; i < Math.min(left, n); i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / left);
  for (let i = 0; i < Math.min(right, n); i++) out[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / right);
  return out;
}

/** Sample a complex spectrum at arbitrary frequencies (linear interp of re/im). */
function sampleSpectrum(sp, fs, freqs) {
  const { re, im, n } = sp;
  const mag = new Float64Array(freqs.length);
  const cre = new Float64Array(freqs.length);
  const cim = new Float64Array(freqs.length);
  for (let j = 0; j < freqs.length; j++) {
    const b = (freqs[j] * n) / fs;
    const k = Math.min(n / 2 - 1, Math.floor(b));
    const t = b - k;
    cre[j] = re[k] * (1 - t) + re[k + 1] * t;
    cim[j] = im[k] * (1 - t) + im[k + 1] * t;
    mag[j] = Math.hypot(cre[j], cim[j]);
  }
  return { mag, re: cre, im: cim };
}

export function measurementFreqs(sampleRate, fMin = 10, fMax = 20000) {
  return octaveGrid(fMin, Math.min(fMax, sampleRate * 0.45), 48);
}

/**
 * Frequency response of a (windowed) IR.
 * @returns {{freqs, spl, phase, groupDelayMs}}
 */
export function frequencyResponse(m, { windowMs = 500, leftMs = 2, smoothing = 0, levelRms = 1 } = {}) {
  const fs = m.sampleRate;
  const len = Math.min(m.ir.length, Math.round((windowMs / 1000) * fs) + m.peakIndex);
  const seg = applyWindow(m.ir.subarray(0, len), Math.max(1, Math.min(m.peakIndex, Math.round((leftMs / 1000) * fs))), Math.round(len * 0.15));
  const n = nextPow2(Math.max(len, fs / 2));
  const sp = spectrum(seg, n);
  const freqs = measurementFreqs(fs);
  const s = sampleSpectrum(sp, fs, freqs);
  if (m.sweepF1) {
    const hp = measurementHighpass({ f1: m.sweepF1, sampleRate: fs });
    for (let i = 0; i < freqs.length; i++) {
      const [br, bi] = cascadeComplex(hp, freqs[i], fs);
      const d = br * br + bi * bi;
      const re = (s.re[i] * br + s.im[i] * bi) / d;
      const im = (s.im[i] * br - s.re[i] * bi) / d;
      s.re[i] = re;
      s.im[i] = im;
      s.mag[i] = Math.hypot(re, im);
    }
  }
  let spl = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) spl[i] = REF_SPL + 20 * Math.log10(Math.max(s.mag[i] * levelRms, 1e-12));
  if (smoothing === 'var') spl = smoothVariable(freqs, spl);
  else if (smoothing > 0) spl = smoothOctave(freqs, spl, smoothing);
  // Phase relative to the IR peak (removes the bulk delay).
  const tp = m.peakIndex / fs;
  const phase = new Float64Array(freqs.length);
  const unwrapped = new Float64Array(freqs.length);
  let prev = 0;
  let offset = 0;
  for (let i = 0; i < freqs.length; i++) {
    const w = 2 * Math.PI * freqs[i];
    let ph = Math.atan2(s.im[i], s.re[i]) + w * tp;
    ph = Math.atan2(Math.sin(ph), Math.cos(ph));
    if (i > 0) {
      let d = ph - prev;
      while (d > Math.PI) {
        offset -= 2 * Math.PI;
        d -= 2 * Math.PI;
      }
      while (d < -Math.PI) {
        offset += 2 * Math.PI;
        d += 2 * Math.PI;
      }
    }
    prev = ph;
    unwrapped[i] = ph + offset;
    phase[i] = (ph * 180) / Math.PI;
  }
  const groupDelayMs = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(freqs.length - 1, i + 1);
    const dw = 2 * Math.PI * (freqs[b] - freqs[a]);
    groupDelayMs[i] = dw > 0 ? (-(unwrapped[b] - unwrapped[a]) / dw) * 1000 : 0;
  }
  return { freqs, spl, phase, groupDelayMs: smoothLinear(freqs, groupDelayMs, 6) };
}

/** Fractional-octave moving average of a linear quantity. */
function smoothLinear(freqs, values, fraction) {
  const half = Math.pow(2, 1 / (2 * fraction));
  const out = new Float64Array(freqs.length);
  let l = 0;
  let r = 0;
  let acc = 0;
  for (let i = 0; i < freqs.length; i++) {
    while (r < freqs.length && freqs[r] <= freqs[i] * half) acc += values[r++];
    while (l < r && freqs[l] < freqs[i] / half) acc -= values[l++];
    out[i] = r > l ? acc / (r - l) : values[i];
  }
  return out;
}

/** Step response (running sum of the IR), normalised to its final value. */
export function stepResponse(m, maxMs = 60) {
  const n = Math.min(m.ir.length, Math.round((maxMs / 1000) * m.sampleRate) + m.peakIndex);
  const out = new Float32Array(n);
  let acc = 0;
  let peak = 1e-12;
  for (let i = 0; i < n; i++) {
    acc += m.ir[i];
    out[i] = acc;
    peak = Math.max(peak, Math.abs(acc));
  }
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

/** Energy-time curve: |analytic signal|² in dB re. the peak. */
export function energyTimeCurve(m, maxMs = 400) {
  const len = Math.min(m.ir.length, Math.round((maxMs / 1000) * m.sampleRate) + m.peakIndex);
  const n = nextPow2(len * 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(m.ir.subarray(0, len));
  fft(re, im);
  // Hilbert: zero negative frequencies, double positive.
  for (let k = 1; k < n / 2; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = n / 2 + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft(re, im, true);
  const out = new Float32Array(len);
  let peak = 1e-30;
  for (let i = 0; i < len; i++) {
    const e = re[i] * re[i] + im[i] * im[i];
    out[i] = e;
    peak = Math.max(peak, e);
  }
  for (let i = 0; i < len; i++) out[i] = 10 * Math.log10(out[i] / peak + 1e-15);
  return out;
}

function schroeder(sig, start) {
  const n = sig.length - start;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = sig.length - 1; i >= start; i--) {
    acc += sig[i] * sig[i];
    edc[i - start] = acc;
  }
  const total = edc[0] || 1e-30;
  for (let i = 0; i < n; i++) edc[i] = 10 * Math.log10(edc[i] / total + 1e-30);
  return edc;
}

/** Least-squares decay slope between two EDC levels → reverberation time (s). */
function decayTime(edc, fs, from, to) {
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < edc.length; i++) {
    if (i0 < 0 && edc[i] <= from) i0 = i;
    if (edc[i] <= to) {
      i1 = i;
      break;
    }
  }
  if (i0 < 0 || i1 <= i0 + 2) return NaN;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const cnt = i1 - i0 + 1;
  for (let i = i0; i <= i1; i++) {
    const x = i / fs;
    sx += x;
    sy += edc[i];
    sxx += x * x;
    sxy += x * edc[i];
  }
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
  return slope < 0 ? -60 / slope : NaN;
}

function clarity(sig, start, fs, ms) {
  const split = start + Math.round((ms / 1000) * fs);
  let early = 0;
  let late = 0;
  for (let i = start; i < sig.length; i++) {
    if (i < split) early += sig[i] * sig[i];
    else late += sig[i] * sig[i];
  }
  return 10 * Math.log10((early + 1e-30) / (late + 1e-30));
}

/**
 * Room acoustics per octave band (ISO 3382 style): EDT, T20, T30, C50, C80,
 * plus the broadband EDC for plotting.
 */
export function decayAnalysis(m) {
  const fs = m.sampleRate;
  const start = Math.max(0, m.peakIndex - Math.round(0.001 * fs));
  const bands = BANDS.map((f, b) => {
    const sig = bandLimit(m.ir, b, fs);
    // The band filter delays energy slightly; integrate from its own peak.
    let pk = start;
    let pv = 0;
    for (let i = start; i < Math.min(sig.length, start + Math.round(0.05 * fs)); i++) {
      if (Math.abs(sig[i]) > pv) {
        pv = Math.abs(sig[i]);
        pk = i;
      }
    }
    const edc = schroeder(sig, Math.max(0, pk - Math.round(0.001 * fs)));
    return {
      f,
      edt: decayTime(edc, fs, -0.01, -10),
      t20: decayTime(edc, fs, -5, -25),
      t30: decayTime(edc, fs, -5, -35),
      c50: clarity(sig, start, fs, 50),
      c80: clarity(sig, start, fs, 80),
    };
  });
  const edc = schroeder(m.ir, start);
  const step = Math.max(1, Math.floor(fs / 2000));
  const edcDs = new Float32Array(Math.ceil(edc.length / step));
  for (let i = 0; i < edcDs.length; i++) edcDs[i] = edc[i * step];
  const mid = bands.filter((b) => b.f === 500 || b.f === 1000);
  const avg = (key) => {
    const v = mid.map((b) => b[key]).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  return {
    bands,
    edc: edcDs,
    edcRate: fs / step,
    edt: avg('edt'),
    t20: avg('t20'),
    t30: avg('t30'),
    c50: clarity(m.ir, start, fs, 50),
    c80: clarity(m.ir, start, fs, 80),
  };
}

/**
 * Cumulative spectral decay (waterfall).
 * @returns {{freqs: Float64Array, times: number[], slices: Float64Array[]}} dB re. the first slice's peak
 */
export function waterfall(m, { fMin = 15, fMax = 500, slices = 32, stepMs = 12, windowMs = 250, riseMs = 1 } = {}) {
  const fs = m.sampleRate;
  const freqs = octaveGrid(fMin, fMax, 24);
  const wLen = Math.round((windowMs / 1000) * fs);
  const n = nextPow2(wLen * 2);
  const rise = Math.max(1, Math.round((riseMs / 1000) * fs));
  const out = [];
  const times = [];
  let ref = 1e-30;
  for (let s = 0; s < slices; s++) {
    const t0 = m.peakIndex - rise + Math.round((s * stepMs * fs) / 1000);
    if (t0 < 0 || t0 >= m.ir.length) break;
    const seg = new Float64Array(Math.min(wLen, m.ir.length - t0));
    for (let i = 0; i < seg.length; i++) seg[i] = m.ir[t0 + i];
    const w = applyWindow(seg, rise, Math.round(seg.length * 0.5));
    const sp = spectrum(w, n);
    const mag = sampleSpectrum(sp, fs, freqs).mag;
    const db = new Float64Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) {
      db[i] = 20 * Math.log10(mag[i] + 1e-12);
      if (s === 0) ref = Math.max(ref, db[i]);
    }
    out.push(db);
    times.push(s * stepMs);
  }
  for (const db of out) for (let i = 0; i < db.length; i++) db[i] -= ref;
  return { freqs, times, slices: out };
}

/**
 * Harmonic distortion from the harmonic IRs: level of each harmonic and the
 * THD relative to the fundamental, as a function of the fundamental frequency.
 */
export function distortion(m, { levelRms = 1, fMin = 20, fMax = 10000 } = {}) {
  const fs = m.sampleRate;
  const freqs = octaveGrid(fMin, Math.min(fMax, fs * 0.45), 24);
  const fund = frequencyResponse(m, { windowMs: 250, smoothing: 12, levelRms });
  const fundAt = (f) => {
    // interpolate the fundamental SPL on its log grid
    const g = fund.freqs;
    let i = 1;
    while (i < g.length - 1 && g[i] < f) i++;
    const t = clamp(Math.log(f / g[i - 1]) / Math.log(g[i] / g[i - 1]), 0, 1);
    return fund.spl[i - 1] * (1 - t) + fund.spl[i] * t;
  };
  const harmonics = m.harmonics.map(({ k, ir }) => {
    const n = nextPow2(Math.max(ir.length, fs / 4));
    const rise = Math.max(1, Math.min(m.peakIndex, Math.round(0.002 * fs)));
    const sp = spectrum(applyWindow(ir, rise, Math.round(ir.length * 0.2)), n);
    const kf = freqs.map((f) => Math.min(f * k, fs * 0.49));
    const mag = sampleSpectrum(sp, fs, kf).mag;
    let spl = new Float64Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) spl[i] = f0ok(freqs[i] * k, fs) ? REF_SPL + 20 * Math.log10(mag[i] * levelRms + 1e-12) : NaN;
    spl = smoothOctave(freqs, spl.map((v) => (Number.isFinite(v) ? v : -100)), 6);
    return { k, spl };
  });
  const fundSpl = freqs.map(fundAt);
  const thdPct = new Float64Array(freqs.length);
  const thdDb = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    let p = 0;
    for (const hm of harmonics) if (f0ok(freqs[i] * hm.k, fs)) p += Math.pow(10, (hm.spl[i] - fundSpl[i]) / 10);
    thdPct[i] = 100 * Math.sqrt(p);
    thdDb[i] = 10 * Math.log10(p + 1e-20);
  }
  return { freqs, fundamental: fundSpl, harmonics, thdPct, thdDb };
}

function f0ok(f, fs) {
  return f < fs * 0.45;
}

/** Summary numbers for the measurement list. */
export function summarize(m, levelRms = 1) {
  const fr = frequencyResponse(m, { smoothing: 6, levelRms });
  const at = (f) => {
    let best = 0;
    for (let i = 0; i < fr.freqs.length; i++) if (Math.abs(Math.log(fr.freqs[i] / f)) < Math.abs(Math.log(fr.freqs[best] / f))) best = i;
    return fr.spl[best];
  };
  // Mid-band reference 300 Hz – 3 kHz, bass extension = lowest f within −6 dB.
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < fr.freqs.length; i++) {
    if (fr.freqs[i] >= 300 && fr.freqs[i] <= 3000) {
      sum += fr.spl[i];
      cnt++;
    }
  }
  const midDb = cnt ? sum / cnt : NaN;
  // Low-frequency extension: the lowest frequency where the ⅓-octave
  // smoothed response reaches −6 dB re. the mid band (NaN = below 10 Hz).
  const third = smoothOctave(fr.freqs, fr.spl, 3);
  let f6 = NaN;
  for (let i = 0; i < fr.freqs.length && fr.freqs[i] <= 300; i++) {
    if (third[i] >= midDb - 6) {
      if (i > 0) f6 = fr.freqs[i];
      break;
    }
  }
  // Bass smoothness: std-dev of the 1/6-oct response 20–200 Hz.
  const bass = [];
  for (let i = 0; i < fr.freqs.length; i++) if (fr.freqs[i] >= 20 && fr.freqs[i] <= 200) bass.push(fr.spl[i]);
  const bm = bass.reduce((a, b) => a + b, 0) / Math.max(1, bass.length);
  const bassDev = Math.sqrt(bass.reduce((a, b) => a + (b - bm) * (b - bm), 0) / Math.max(1, bass.length));
  return { spl1k: at(1000), midDb, f6, bassDev, arrivalMs: (m.delaySamples + m.peakIndex) / (m.sampleRate / 1000) };
}

// ------------------------------------------------------------ realtime-free runner

/**
 * Render a sweep through the simulation and return a measurement.
 * Browser only (OfflineAudioContext).
 * @param {object} o
 * @param {object} o.state application state
 * @param {'L'|'R'|'both'} [o.channel='both']
 * @param {number} [o.levelDb=-12] sweep peak level (dBFS)
 * @param {number} [o.seconds=2.7]
 * @param {number} [o.sampleRate=48000]
 * @param {(p:number, msg:string)=>void} [o.onProgress]
 */
export async function runSweepMeasurement(o) {
  const { SimulationEngine } = await import('./engine.js');
  const { rt60Bands } = await import('../acoustics/room.js');
  const { state: st, channel = 'both', levelDb = -12, seconds = 2.7, sampleRate = 48000, onProgress } = o;
  const state = JSON.parse(JSON.stringify(st));
  state.engine.simulation = true;
  onProgress?.(0.02, 'Generating sweep…');
  const sweep = makeSweep({ sampleRate, seconds, levelDb });
  // Record long enough for the room's slowest decay (and T30 evaluation).
  const rtMax = state.room.reverb?.enabled ? Math.max(...rt60Bands(state.room)) : 0.5;
  const tail = clamp(rtMax * 1.25 + 0.4, 1.2, 6);
  const total = sweep.signal.length / sampleRate + tail;
  const Ctor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Ctor(2, Math.ceil(total * sampleRate), sampleRate);
  onProgress?.(0.05, 'Building room model…');
  const engine = new SimulationEngine(ctx, { offline: true, quality: 'high', mic: true });
  await engine.applyState(state);
  const buf = ctx.createBuffer(2, sweep.signal.length, sampleRate);
  if (channel !== 'R') buf.copyToChannel(sweep.signal, 0);
  if (channel !== 'L') buf.copyToChannel(sweep.signal, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(engine.input);
  engine.micOut.connect(ctx.destination);
  src.start(0);
  const stepS = Math.max(0.25, total / 20);
  for (let t = stepS; t < total - 0.05; t += stepS) {
    const at = t;
    ctx
      .suspend(at)
      .then(() => {
        onProgress?.(0.08 + 0.7 * (at / total), 'Sweeping…');
        ctx.resume();
      })
      .catch(() => {});
  }
  const rendered = await ctx.startRendering();
  engine.dispose();
  onProgress?.(0.8, 'Deconvolving…');
  const rec = rendered.getChannelData(0);
  const full = deconvolve(sweep, rec);
  const m = splitResponse(full, sweep, { maxSeconds: tail });
  let peak = 0;
  for (let i = 0; i < rec.length; i++) peak = Math.max(peak, Math.abs(rec[i]));
  onProgress?.(1, 'Done');
  return {
    ...m,
    channel,
    levelDb,
    levelRms: sweep.amplitude / Math.SQRT2,
    peakSpl: REF_SPL + 20 * Math.log10(peak + 1e-12),
    sweep: { f1: sweep.f1, f2: sweep.f2, seconds, L: sweep.L },
  };
}
