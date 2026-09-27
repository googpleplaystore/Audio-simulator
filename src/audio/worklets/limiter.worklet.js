// True-peak lookahead limiter.
/* global sampleRate */
//
// The DSP core (TruePeakLimiter) is plain JavaScript so it can be unit-tested
// in Node; the AudioWorkletProcessor wrapper at the bottom is only registered
// when this file is loaded as an AudioWorklet module.
//
// Detection: every sample and three inter-sample positions (4× oversampling,
// 16-tap windowed-sinc polyphase interpolator, as in ITU-R BS.1770 true-peak
// metering), linked across channels.
// Gain: required gain → sliding minimum (lookahead + hold) → instant attack /
// exponential release → moving average over the lookahead. The audio is
// delayed so that every sample around a detected peak is played with a gain at
// or below the gain that peak needs: the output never exceeds the ceiling at
// sample positions and stays within a few hundredths of a dB between them.

const PHASES = 4;
const HALF = 8; // interpolator half-length (taps per phase = 2·HALF)

function designInterpolator() {
  // phase p (1..3) interpolates at n + p/4 from x[n−HALF+1 … n+HALF]
  const taps = [];
  for (let p = 1; p < PHASES; p++) {
    const frac = p / PHASES;
    const h = new Float64Array(2 * HALF);
    let sum = 0;
    for (let i = 0; i < 2 * HALF; i++) {
      const k = i - HALF + 1; // sample offset relative to n
      const t = frac - k;
      const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 * (1 + Math.cos((Math.PI * t) / HALF));
      h[i] = sinc * w;
      sum += h[i];
    }
    for (let i = 0; i < 2 * HALF; i++) h[i] /= sum;
    taps.push(h);
  }
  return taps;
}

const TAPS = designInterpolator();

export class TruePeakLimiter {
  /**
   * @param {object} o
   * @param {number} o.sampleRate
   * @param {number} [o.channels=2]
   * @param {number} [o.lookaheadMs=2.5]
   * @param {number} [o.holdMs=5]
   * @param {number} [o.releaseMs=80]
   * @param {number} [o.ceilingDb=-1] dBTP
   */
  constructor({ sampleRate, channels = 2, lookaheadMs = 2.5, holdMs = 5, releaseMs = 80, ceilingDb = -1 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.L = Math.max(4, Math.round((lookaheadMs / 1000) * sampleRate));
    this.H = this.L + 4 + Math.max(0, Math.round((holdMs / 1000) * sampleRate));
    // Audio delay: interpolator group delay + lookahead + one sample so the
    // guaranteed-gain window is centred on the interpolated interval.
    this.latency = HALF + this.L + 1;
    this.enabled = true;
    this.setCeiling(ceilingDb);
    this.setRelease(releaseMs);

    // Detector history (per channel), length 2·HALF, circular.
    this.hist = Array.from({ length: channels }, () => new Float64Array(2 * HALF));
    this.hpos = 0;
    // Audio delay lines.
    this.dlen = this.latency + 1;
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.dlen));
    this.dpos = 0;
    // Sliding minimum (monotonic deque) over H samples.
    this.qv = new Float64Array(this.H + 1);
    this.qi = new Float64Array(this.H + 1);
    this.qh = 0;
    this.qt = 0;
    this.qn = 0;
    this.t = 0;
    // Release envelope and moving average.
    this.env = 1;
    this.box = new Float64Array(this.L).fill(1);
    this.bpos = 0;
    this.bsum = this.L;
    this.sinceResum = 0;
    this.resetStats();
  }

  setCeiling(db) {
    this.ceilingDb = db;
    this.ceiling = Math.pow(10, db / 20);
  }

  setRelease(ms) {
    this.releaseMs = ms;
    this.relCoef = 1 - Math.exp(-1 / Math.max(1, (ms / 1000) * this.sampleRate));
  }

  setEnabled(on) {
    this.enabled = !!on;
  }

  resetStats() {
    this.stats = { minGain: 1, inPeak: 0, outPeak: 0 };
  }

  /** Returns and resets the statistics gathered since the last call. */
  takeStats() {
    const s = this.stats;
    this.resetStats();
    return s;
  }

  _pushMin(v) {
    const cap = this.H + 1;
    // Drop larger values from the back.
    while (this.qn > 0) {
      const back = (this.qt - 1 + cap) % cap;
      if (this.qv[back] < v) break;
      this.qt = back;
      this.qn--;
    }
    this.qv[this.qt] = v;
    this.qi[this.qt] = this.t;
    this.qt = (this.qt + 1) % cap;
    this.qn++;
    // Expire from the front.
    while (this.qi[this.qh] <= this.t - this.H) {
      this.qh = (this.qh + 1) % cap;
      this.qn--;
    }
    return this.qv[this.qh];
  }

  /**
   * Process `n` frames. `inputs`/`outputs` are arrays of Float32Array per
   * channel (a missing input channel is treated as silence). In-place
   * processing (inputs === outputs) is supported.
   */
  process(inputs, outputs, n) {
    const C = this.channels;
    const H2 = 2 * HALF;
    const ceiling = this.ceiling;
    const stats = this.stats;
    for (let s = 0; s < n; s++) {
      // 1. Detector: write the new sample into the history ring.
      let pk = 0;
      const hp = this.hpos;
      for (let c = 0; c < C; c++) {
        const src = inputs[c];
        const x = src ? src[s] : 0;
        const hist = this.hist[c];
        hist[hp] = x;
        // Sample at n = newest − HALF + 1 … evaluate x[n] and the three
        // positions between x[n] and x[n+1].
        const base = hp + 1; // oldest sample in the ring
        const xn = hist[(base + HALF - 1) % H2];
        let m = Math.abs(xn);
        for (let p = 0; p < PHASES - 1; p++) {
          const h = TAPS[p];
          let acc = 0;
          for (let i = 0; i < H2; i++) acc += h[i] * hist[(base + i) % H2];
          const a = Math.abs(acc);
          if (a > m) m = a;
        }
        if (m > pk) pk = m;
        if (Math.abs(x) > stats.inPeak) stats.inPeak = Math.abs(x);
      }
      this.hpos = (hp + 1) % H2;

      // 2. Gain computer.
      const g = this.enabled && pk > ceiling ? ceiling / pk : 1;
      const held = this._pushMin(g);
      this.t++;
      if (held < this.env) this.env = held;
      else this.env += (held - this.env) * this.relCoef;
      this.bsum += this.env - this.box[this.bpos];
      this.box[this.bpos] = this.env;
      this.bpos = (this.bpos + 1) % this.L;
      if (++this.sinceResum >= 8192) {
        // Avoid floating-point drift of the running sum.
        this.sinceResum = 0;
        let sum = 0;
        for (let i = 0; i < this.L; i++) sum += this.box[i];
        this.bsum = sum;
      }
      const gain = Math.min(1, this.bsum / this.L);
      if (gain < stats.minGain) stats.minGain = gain;

      // 3. Delay line and output.
      const dp = this.dpos;
      const rp = (dp + 1) % this.dlen; // oldest = written `latency` samples ago
      for (let c = 0; c < C; c++) {
        const src = inputs[c];
        const d = this.delay[c];
        d[dp] = src ? src[s] : 0;
        const y = d[rp] * gain;
        const out = outputs[c];
        if (out) out[s] = y;
        const a = y < 0 ? -y : y;
        if (a > stats.outPeak) stats.outPeak = a;
      }
      this.dpos = rp;
    }
  }
}

/** Offline true-peak measurement (dBTP) using the same interpolator. */
export function truePeak(channels) {
  let peak = 0;
  for (const x of channels) {
    for (let n = 0; n < x.length; n++) {
      const a = Math.abs(x[n]);
      if (a > peak) peak = a;
      if (n < HALF - 1 || n + HALF >= x.length) continue;
      for (let p = 0; p < PHASES - 1; p++) {
        const h = TAPS[p];
        let acc = 0;
        for (let i = 0; i < 2 * HALF; i++) acc += h[i] * x[n - HALF + 1 + i];
        const b = Math.abs(acc);
        if (b > peak) peak = b;
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

// ------------------------------------------------------------ worklet wrapper
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
  class LimiterProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = options?.processorOptions || {};
      this.core = new TruePeakLimiter({ sampleRate, channels: 2, ...o });
      this.reportEvery = Math.round(sampleRate / 20);
      this.sinceReport = 0;
      this.alive = true;
      this.port.onmessage = (e) => {
        const m = e.data || {};
        if (m.dispose) this.alive = false;
        if (typeof m.ceilingDb === 'number') this.core.setCeiling(m.ceilingDb);
        if (typeof m.releaseMs === 'number') this.core.setRelease(m.releaseMs);
        if (typeof m.enabled === 'boolean') this.core.setEnabled(m.enabled);
      };
      this.port.postMessage({ type: 'ready', latency: this.core.latency });
    }

    process(inputs, outputs) {
      const input = inputs[0] || [];
      const output = outputs[0];
      const n = output[0].length;
      // Mono input is duplicated so both outputs carry it.
      const ins = input.length === 1 ? [input[0], input[0]] : input;
      this.core.process(ins, output, n);
      this.sinceReport += n;
      if (this.sinceReport >= this.reportEvery) {
        this.sinceReport = 0;
        const s = this.core.takeStats();
        this.port.postMessage({ type: 'stats', minGain: s.minGain, inPeak: s.inPeak, outPeak: s.outPeak });
      }
      return this.alive;
    }
  }
  registerProcessor('audiospace-limiter', LimiterProcessor);
}
