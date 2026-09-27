// Biquad filter math that exactly mirrors the Web Audio API BiquadFilterNode
// coefficient formulas (W3C Web Audio API, "Filters characteristics").
// Used for plotting, system-response prediction, auto-EQ fitting and tests,
// so what we draw is precisely what the audio graph does.

import { qToDb } from '../util/math.js';

/**
 * @typedef {{type: string, frequency: number, Q?: number, gain?: number}} FilterSpec
 * Filter description using Web Audio parameter names. For lowpass/highpass,
 * Q is in dB (as in Web Audio). For peaking/notch/bandpass/allpass Q is linear.
 */

export const IDENTITY = Object.freeze({ type: 'peaking', frequency: 1000, Q: 1, gain: 0 });

/** Normalised coefficients {b0,b1,b2,a1,a2} for a spec at a sample rate. */
export function coefficients(spec, sampleRate) {
  const { type } = spec;
  const nyquist = sampleRate / 2;
  const f = Math.min(Math.max(spec.frequency, 0), nyquist);
  const Q = spec.Q ?? 1;
  const G = spec.gain ?? 0;
  const A = Math.pow(10, G / 40);
  const fn = f / nyquist; // normalised 0..1

  // Degenerate edge cases per spec.
  if (type === 'lowpass') {
    if (fn >= 1) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    if (fn <= 0) return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  } else if (type === 'highpass') {
    if (fn >= 1) return { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
    if (fn <= 0) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  } else if (type === 'lowshelf') {
    if (fn >= 1) return { b0: A * A, b1: 0, b2: 0, a1: 0, a2: 0 };
    if (fn <= 0) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  } else if (type === 'highshelf') {
    if (fn >= 1) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    if (fn <= 0) return { b0: A * A, b1: 0, b2: 0, a1: 0, a2: 0 };
  } else if (fn <= 0 || fn >= 1) {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }

  const w0 = Math.PI * fn;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alphaQ = sw / (2 * Q);
  const alphaQdB = sw / (2 * Math.pow(10, Q / 20));
  const alphaS = (sw / 2) * Math.SQRT2; // S = 1
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alphaQdB;
      a1 = -2 * cw;
      a2 = 1 - alphaQdB;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alphaQdB;
      a1 = -2 * cw;
      a2 = 1 - alphaQdB;
      break;
    case 'bandpass':
      b0 = alphaQ;
      b1 = 0;
      b2 = -alphaQ;
      a0 = 1 + alphaQ;
      a1 = -2 * cw;
      a2 = 1 - alphaQ;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cw;
      b2 = 1;
      a0 = 1 + alphaQ;
      a1 = -2 * cw;
      a2 = 1 - alphaQ;
      break;
    case 'allpass':
      b0 = 1 - alphaQ;
      b1 = -2 * cw;
      b2 = 1 + alphaQ;
      a0 = 1 + alphaQ;
      a1 = -2 * cw;
      a2 = 1 - alphaQ;
      break;
    case 'peaking':
      if (Q <= 0) return { b0: A * A, b1: 0, b2: 0, a1: 0, a2: 0 };
      b0 = 1 + alphaQ * A;
      b1 = -2 * cw;
      b2 = 1 - alphaQ * A;
      a0 = 1 + alphaQ / A;
      a1 = -2 * cw;
      a2 = 1 - alphaQ / A;
      break;
    case 'lowshelf': {
      const sA = 2 * alphaS * Math.sqrt(A);
      b0 = A * (A + 1 - (A - 1) * cw + sA);
      b1 = 2 * A * (A - 1 - (A + 1) * cw);
      b2 = A * (A + 1 - (A - 1) * cw - sA);
      a0 = A + 1 + (A - 1) * cw + sA;
      a1 = -2 * (A - 1 + (A + 1) * cw);
      a2 = A + 1 + (A - 1) * cw - sA;
      break;
    }
    case 'highshelf': {
      const sA = 2 * alphaS * Math.sqrt(A);
      b0 = A * (A + 1 + (A - 1) * cw + sA);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - sA);
      a0 = A + 1 - (A - 1) * cw + sA;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - sA;
      break;
    }
    default:
      throw new Error(`Unknown biquad type: ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Complex response of normalised coefficients at a frequency. Returns [re, im]. */
export function evalCoefficients(c, f, sampleRate) {
  const w = (2 * Math.PI * f) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  // numerator: b0 + b1 e^{-jw} + b2 e^{-2jw}
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  const den = dr * dr + di * di || 1e-300;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}

/** Magnitude in dB of a single filter spec at frequency f. */
export function specMagnitudeDb(spec, f, sampleRate) {
  const [re, im] = evalCoefficients(coefficients(spec, sampleRate), f, sampleRate);
  return 10 * Math.log10(re * re + im * im + 1e-300);
}

/**
 * Complex frequency response on a fixed frequency grid. Operations compose
 * multiplicatively (cascade) or additively (acoustic summation).
 */
export class Response {
  constructor(freqs, sampleRate = 48000) {
    this.freqs = freqs;
    this.sampleRate = sampleRate;
    this.re = new Float64Array(freqs.length).fill(1);
    this.im = new Float64Array(freqs.length);
  }

  static zero(freqs, sampleRate) {
    const r = new Response(freqs, sampleRate);
    r.re.fill(0);
    return r;
  }

  clone() {
    const r = new Response(this.freqs, this.sampleRate);
    r.re.set(this.re);
    r.im.set(this.im);
    return r;
  }

  /** Cascade with a biquad spec (or array of specs). */
  filter(specs) {
    const list = Array.isArray(specs) ? specs : [specs];
    for (const spec of list) {
      if (!spec) continue;
      if (spec.type === 'peaking' && !spec.gain) continue; // identity
      const c = coefficients(spec, this.sampleRate);
      for (let i = 0; i < this.freqs.length; i++) {
        const [hr, hi] = evalCoefficients(c, this.freqs[i], this.sampleRate);
        const r = this.re[i];
        const im = this.im[i];
        this.re[i] = r * hr - im * hi;
        this.im[i] = r * hi + im * hr;
      }
    }
    return this;
  }

  /** Multiply by a real scalar gain (negative = polarity inversion). */
  gain(g) {
    for (let i = 0; i < this.re.length; i++) {
      this.re[i] *= g;
      this.im[i] *= g;
    }
    return this;
  }

  /** Pure delay of `seconds`. */
  delay(seconds) {
    if (!seconds) return this;
    for (let i = 0; i < this.re.length; i++) {
      const ph = -2 * Math.PI * this.freqs[i] * seconds;
      const c = Math.cos(ph);
      const s = Math.sin(ph);
      const r = this.re[i];
      const im = this.im[i];
      this.re[i] = r * c - im * s;
      this.im[i] = r * s + im * c;
    }
    return this;
  }

  /** Multiply by a real per-frequency magnitude curve given in dB. */
  magnitudeDbCurve(dbArray) {
    for (let i = 0; i < this.re.length; i++) {
      const g = Math.pow(10, dbArray[i] / 20);
      this.re[i] *= g;
      this.im[i] *= g;
    }
    return this;
  }

  add(other) {
    for (let i = 0; i < this.re.length; i++) {
      this.re[i] += other.re[i];
      this.im[i] += other.im[i];
    }
    return this;
  }

  multiply(other) {
    for (let i = 0; i < this.re.length; i++) {
      const r = this.re[i];
      const im = this.im[i];
      this.re[i] = r * other.re[i] - im * other.im[i];
      this.im[i] = r * other.im[i] + im * other.re[i];
    }
    return this;
  }

  magnitudeDb(out = new Float64Array(this.re.length)) {
    for (let i = 0; i < this.re.length; i++) {
      out[i] = 10 * Math.log10(this.re[i] * this.re[i] + this.im[i] * this.im[i] + 1e-300);
    }
    return out;
  }

  power(out = new Float64Array(this.re.length)) {
    for (let i = 0; i < this.re.length; i++) out[i] = this.re[i] * this.re[i] + this.im[i] * this.im[i];
    return out;
  }

  phaseDeg(out = new Float64Array(this.re.length)) {
    for (let i = 0; i < this.re.length; i++) out[i] = (Math.atan2(this.im[i], this.re[i]) * 180) / Math.PI;
    return out;
  }
}

/** Magnitude (dB) of a cascade of specs over a frequency grid. */
export function cascadeMagnitudeDb(specs, freqs, sampleRate = 48000) {
  return new Response(freqs, sampleRate).filter(specs).magnitudeDb();
}

// ---------------------------------------------------------------------------
// Crossover design (Linkwitz–Riley) expressed as Web Audio biquad specs.
// ---------------------------------------------------------------------------

const BW4_Q = [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos((3 * Math.PI) / 8))]; // 0.5412, 1.3066

/**
 * Linkwitz–Riley crossover sections.
 * slope 12 → LR2 (one 2nd-order section, Q = 0.5)
 * slope 24 → LR4 (two cascaded Butterworth 2nd-order sections, Q = 0.7071)
 * slope 48 → LR8 (two cascaded 4th-order Butterworth filters)
 * @param {'lowpass'|'highpass'} type
 * @param {0|12|24|48} slope
 */
export function linkwitzRiley(type, slope, frequency) {
  switch (Number(slope)) {
    case 12:
      return [{ type, frequency, Q: qToDb(0.5) }];
    case 24:
      return [
        { type, frequency, Q: qToDb(Math.SQRT1_2) },
        { type, frequency, Q: qToDb(Math.SQRT1_2) },
      ];
    case 48:
      return [
        { type, frequency, Q: qToDb(BW4_Q[0]) },
        { type, frequency, Q: qToDb(BW4_Q[1]) },
        { type, frequency, Q: qToDb(BW4_Q[0]) },
        { type, frequency, Q: qToDb(BW4_Q[1]) },
      ];
    default:
      return [];
  }
}

/** Butterworth high-pass of order 2 or 4 (for driver/enclosure roll-off models). */
export function butterworth(type, order, frequency, qScale = 1) {
  if (order === 1) return [{ type, frequency, Q: qToDb(0.5) }];
  if (order === 2) return [{ type, frequency, Q: qToDb(Math.SQRT1_2 * qScale) }];
  if (order === 4) {
    return [
      { type, frequency, Q: qToDb(BW4_Q[0] * qScale) },
      { type, frequency, Q: qToDb(BW4_Q[1] * qScale) },
    ];
  }
  throw new Error(`Unsupported Butterworth order ${order}`);
}

/** Whether an LR crossover of this slope needs the high-pass inverted to sum flat. */
export function lrNeedsInversion(slope) {
  return Number(slope) === 12;
}
