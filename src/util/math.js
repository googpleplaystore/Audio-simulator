// General numeric helpers shared by DSP, acoustics and UI code.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(Math.abs(g), 1e-12));
export const dbToPower = (db) => Math.pow(10, db / 10);
export const powerToDb = (p) => 10 * Math.log10(Math.max(p, 1e-24));

/** Linear Q value -> the dB-valued Q that Web Audio lowpass/highpass filters expect. */
export const qToDb = (q) => 20 * Math.log10(q);
export const dbToQ = (qdb) => Math.pow(10, qdb / 20);

/** Speed of sound in air (m/s) for a temperature in °C. */
export const speedOfSound = (tempC = 20) => 331.3 * Math.sqrt(1 + tempC / 273.15);

/** Position (0..1) of frequency f on a log axis between fMin and fMax. */
export const logPos = (f, fMin, fMax) => Math.log(f / fMin) / Math.log(fMax / fMin);
/** Inverse of logPos. */
export const logFreq = (t, fMin, fMax) => fMin * Math.pow(fMax / fMin, t);

/** n logarithmically spaced values from a to b inclusive. */
export function logspace(a, b, n) {
  const out = new Float64Array(n);
  if (n === 1) {
    out[0] = a;
    return out;
  }
  const ratio = Math.log(b / a);
  for (let i = 0; i < n; i++) out[i] = a * Math.exp((ratio * i) / (n - 1));
  return out;
}

/** Points per octave frequency grid. */
export function octaveGrid(fMin, fMax, pointsPerOctave) {
  const n = Math.max(2, Math.round(Math.log2(fMax / fMin) * pointsPerOctave) + 1);
  return logspace(fMin, fMax, n);
}

export const roundTo = (v, step) => Math.round(v / step) * step;
export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;
export const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian random number generator driven by a uniform PRNG (Box–Muller). */
export function gaussian(rand) {
  let spare = null;
  return function next() {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u <= Number.EPSILON) u = rand();
    v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/** Linear interpolation of y at x on a sorted (xs, ys) table, clamped at the ends. */
export function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

/** Interpolate on a log-frequency axis. */
export function interpLogF(freqs, values, f) {
  const n = freqs.length;
  if (f <= freqs[0]) return values[0];
  if (f >= freqs[n - 1]) return values[n - 1];
  for (let i = 1; i < n; i++) {
    if (f <= freqs[i]) {
      const t = Math.log(f / freqs[i - 1]) / Math.log(freqs[i] / freqs[i - 1]);
      return values[i - 1] + (values[i] - values[i - 1]) * t;
    }
  }
  return values[n - 1];
}

export function mean(arr, start = 0, end = arr.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += arr[i];
  return end > start ? s / (end - start) : 0;
}

export function stddev(arr, start = 0, end = arr.length) {
  const m = mean(arr, start, end);
  let s = 0;
  for (let i = start; i < end; i++) s += (arr[i] - m) ** 2;
  return end > start ? Math.sqrt(s / (end - start)) : 0;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function distance3(a, b) {
  const dx = a.x - b.x;
  const dy = (a.y ?? 0) - (b.y ?? 0);
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
