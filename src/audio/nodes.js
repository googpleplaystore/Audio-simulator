// Reusable Web Audio building blocks with click-free parameter handling.

import { IDENTITY } from '../dsp/biquad.js';

/** True when parameters should be set immediately (offline or not yet running). */
function immediate(ctx) {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext ? true : ctx.state !== 'running';
}

/**
 * Smoothly move an AudioParam to a value (exponential approach, tau seconds).
 * Avoids zipper noise and pops when dragging sliders.
 */
export function setParam(ctx, param, value, tau = 0.015) {
  if (!Number.isFinite(value)) return;
  const v = Math.min(Math.max(value, param.minValue ?? -3.4e38), param.maxValue ?? 3.4e38);
  if (immediate(ctx) || tau <= 0) {
    param.cancelScheduledValues(0);
    param.value = v;
    return;
  }
  const t = ctx.currentTime;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else param.cancelScheduledValues(t);
  param.setTargetAtTime(v, t, tau);
}

// ------------------------------------------------------------ shaper curves

const CURVE_SIZE = 8192;
const curveCache = new Map();

/**
 * Transfer curves on x ∈ [−1, 1] whose output saturates at |y| = 0.5 — the
 * drive stage maps the clip level to x = 0.5 so that WaveShaper's input
 * clamping beyond ±1 simply continues the flat rail.
 */
export function shaperCurve(kind) {
  if (curveCache.has(kind)) return curveCache.get(kind);
  const c = new Float32Array(CURVE_SIZE);
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = (i / (CURVE_SIZE - 1)) * 2 - 1;
    const a = Math.abs(x);
    const sgn = Math.sign(x);
    let y;
    switch (kind) {
      case 'ab': // linear to 80 % of the rail, then a smooth knee into clipping
        y = a <= 0.4 ? x : sgn * (0.4 + 0.1 * Math.tanh((a - 0.4) / 0.1));
        break;
      case 'd': // very linear until the rail, then abrupt clipping
        y = a <= 0.47 ? x : sgn * (0.47 + 0.03 * Math.tanh((a - 0.47) / 0.03));
        break;
      case 'tube': // progressive compression with even-order asymmetry
        y = 0.5 * Math.tanh(2 * x + 0.35 * x * x);
        break;
      case 'driver': // soft excursion limiting of a loudspeaker motor/suspension
        y = 0.5 * Math.tanh(2 * x);
        break;
      case 'digital': // hard 0 dBFS clip of a DSP stage (domain ±1 ↔ ±1)
        y = x;
        break;
      default:
        y = x;
    }
    c[i] = y;
  }
  curveCache.set(kind, c);
  return c;
}

/**
 * Chain of N biquads with fixed topology. Unused stages are set to an exact
 * identity (peaking, 0 dB). Changing a stage's *type* is declicked by briefly
 * fading the bank's output.
 */
const BANK_SETTLE = 0.05; // s the incoming chain runs silently before it is faded in
const BANK_FADE = 0.03; // s sample-accurate crossfade

/**
 * A fixed-size cascade of biquads whose specs can change at any time without
 * clicks. Frequency/gain/Q changes glide on the active chain. Filter *type*
 * changes cannot be automated, so the bank is double-buffered: the new types
 * go into the idle chain, which runs silently for a moment and is then
 * crossfaded in with AudioParam ramps — sample-accurate on the audio clock,
 * independent of main-thread timer jitter.
 */
export class FilterBank {
  constructor(ctx, size, name = 'bank') {
    this.ctx = ctx;
    this.name = name;
    this.size = size;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.chains = [this._chain(), this._chain()];
    this.active = 0;
    this.chains[0].gain.gain.value = 1;
    this.chains[1].gain.gain.value = 0;
    this._connect(this.chains[0]);
    this.current = new Array(size).fill(IDENTITY);
    this.key = '';
    this.transition = null;
    this.queued = null;
  }

  _chain() {
    const filters = [];
    const gain = this.ctx.createGain();
    let prev = null;
    for (let i = 0; i < this.size; i++) {
      const f = this.ctx.createBiquadFilter();
      f.type = IDENTITY.type;
      f.frequency.value = IDENTITY.frequency;
      f.Q.value = IDENTITY.Q;
      f.gain.value = 0;
      if (prev) prev.connect(f);
      prev = f;
      filters.push(f);
    }
    if (prev) prev.connect(gain);
    gain.connect(this.output);
    return { filters, gain, first: filters[0] || gain, connected: false };
  }

  _connect(chain) {
    if (chain.connected) return;
    this.input.connect(chain.first);
    chain.connected = true;
  }

  _disconnect(chain) {
    if (!chain.connected) return;
    try {
      this.input.disconnect(chain.first);
    } catch {
      /* already disconnected */
    }
    chain.connected = false;
  }

  /** The active chain's BiquadFilterNodes. */
  get filters() {
    return this.chains[this.active].filters;
  }

  _program(chain, next, tau) {
    next.forEach((s, i) => {
      const f = chain.filters[i];
      if (f.type !== s.type) f.type = s.type;
      setParam(this.ctx, f.frequency, Math.min(s.frequency, this.ctx.sampleRate / 2 - 1), tau);
      setParam(this.ctx, f.Q, s.Q ?? 1, tau);
      setParam(this.ctx, f.gain, s.gain ?? 0, tau);
    });
  }

  /** Apply specs (array). Returns true if anything changed. */
  set(specs, tau = 0.02) {
    const list = specs.slice(0, this.size);
    if (specs.length > this.size) console.warn(`[${this.name}] ${specs.length} filters > bank size ${this.size}; truncated`);
    const key = JSON.stringify(list);
    if (key === this.key) return false;
    const next = [];
    for (let i = 0; i < this.size; i++) next.push(list[i] || IDENTITY);
    if (this.transition) {
      // A crossfade is running; apply the latest specs once it has finished.
      this.queued = { specs, tau };
      this.key = key;
      return true;
    }
    this.key = key;
    const cur = this.chains[this.active];
    const typeChange = next.some((s, i) => s.type !== cur.filters[i].type);
    if (!typeChange || immediate(this.ctx)) {
      this._program(cur, next, immediate(this.ctx) ? 0 : tau);
      this.current = next;
      return true;
    }
    const ctx = this.ctx;
    const nextIdx = 1 - this.active;
    const inc = this.chains[nextIdx];
    this._program(inc, next, 0);
    this._connect(inc);
    const now = ctx.currentTime;
    const t0 = now + BANK_SETTLE;
    const t1 = t0 + BANK_FADE;
    const go = cur.gain.gain;
    go.cancelScheduledValues(now);
    go.setValueAtTime(go.value, now);
    go.setValueAtTime(go.value, t0);
    go.linearRampToValueAtTime(0, t1);
    const gi = inc.gain.gain;
    gi.cancelScheduledValues(now);
    gi.setValueAtTime(0, now);
    gi.setValueAtTime(0, t0);
    gi.linearRampToValueAtTime(1, t1);
    this.active = nextIdx;
    this.current = next;
    const finish = () => {
      // Only detach the old chain once the audio clock is past the fade.
      if (ctx.currentTime < t1 + 0.005 && ctx.state === 'running') {
        this.transition = setTimeout(finish, Math.max(10, (t1 + 0.01 - ctx.currentTime) * 1000));
        return;
      }
      this._disconnect(cur);
      this.transition = null;
      const q = this.queued;
      this.queued = null;
      if (q) {
        this.key = '';
        this.set(q.specs, q.tau);
      }
    };
    this.transition = setTimeout(finish, (BANK_SETTLE + BANK_FADE) * 1000 + 30);
    return true;
  }

  disconnect() {
    clearTimeout(this.transition);
    this.transition = null;
    this.input.disconnect();
    for (const c of this.chains) {
      for (const f of c.filters) f.disconnect();
      c.gain.disconnect();
    }
    this.output.disconnect();
  }
}

/**
 * Saturation stage: drive → WaveShaper → makeup. The clip level (in input
 * units) is `level`; below it the stage is (near) unity gain.
 */
export class SaturationStage {
  constructor(ctx, kind, oversample = '2x') {
    this.ctx = ctx;
    this.drive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = shaperCurve(kind);
    this.shaper.oversample = oversample;
    this.makeup = ctx.createGain();
    this.drive.connect(this.shaper).connect(this.makeup);
    this.kind = kind;
    this.level = 1;
    this.setLevel(1, 0);
  }

  get input() {
    return this.drive;
  }

  get output() {
    return this.makeup;
  }

  setLevel(level, tau = 0.03) {
    const l = Math.max(1e-4, level);
    this.level = l;
    setParam(this.ctx, this.drive.gain, 1 / (2 * l), tau);
    setParam(this.ctx, this.makeup.gain, 2 * l, tau);
  }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    this.shaper.curve = shaperCurve(kind);
  }

  setOversample(os) {
    if (this.shaper.oversample !== os) this.shaper.oversample = os;
  }

  disconnect() {
    this.drive.disconnect();
    this.shaper.disconnect();
    this.makeup.disconnect();
  }
}

/** Create a mono (explicit 1-channel) GainNode — downmixes stereo input. */
export function monoGain(ctx, value = 1) {
  const g = ctx.createGain();
  g.channelCount = 1;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  g.gain.value = value;
  return g;
}

/** Linear crossfade between two gains (A/B switches without pops). */
export function crossfade(ctx, from, to, seconds = 0.03, targetTo = 1) {
  if (immediate(ctx)) {
    from.gain.value = 0;
    to.gain.value = targetTo;
    return;
  }
  const t = ctx.currentTime;
  for (const [g, v] of [
    [from.gain, 0],
    [to.gain, targetTo],
  ]) {
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(v, t + seconds);
  }
}

export function setPannerPosition(ctx, panner, p, tau = 0.03) {
  if (panner.positionX) {
    setParam(ctx, panner.positionX, p.x, tau);
    setParam(ctx, panner.positionY, p.y, tau);
    setParam(ctx, panner.positionZ, p.z, tau);
  } else {
    panner.setPosition(p.x, p.y, p.z);
  }
}

export function setListenerPose(ctx, listener, p, yawDeg, tau = 0.03) {
  const r = (yawDeg * Math.PI) / 180;
  const fx = Math.sin(r);
  const fz = -Math.cos(r);
  if (listener.positionX) {
    setParam(ctx, listener.positionX, p.x, tau);
    setParam(ctx, listener.positionY, p.y, tau);
    setParam(ctx, listener.positionZ, p.z, tau);
    setParam(ctx, listener.forwardX, fx, tau);
    setParam(ctx, listener.forwardY, 0, tau);
    setParam(ctx, listener.forwardZ, fz, tau);
    setParam(ctx, listener.upX, 0, tau);
    setParam(ctx, listener.upY, 1, tau);
    setParam(ctx, listener.upZ, 0, tau);
  } else {
    listener.setPosition(p.x, p.y, p.z);
    listener.setOrientation(fx, 0, fz, 0, 1, 0);
  }
}
