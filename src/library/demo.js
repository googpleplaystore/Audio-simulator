// Procedurally synthesised demo music and calibration signals, rendered on
// demand with OfflineAudioContext. Lets the simulator be explored (and tested)
// without any local files, and provides classic measurement signals.

import { encodeWav } from '../audio/wav.js';
import { mulberry32 } from '../util/math.js';

const SR = 44100;

function noiseBuffer(ctx, seconds, seed = 1, channels = 1) {
  const rand = mulberry32(seed);
  const len = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
  }
  return buf;
}

/** Paul Kellett's refined pink-noise filter. */
function pinkNoise(ctx, seconds, seed, channels = 2, level = 0.25) {
  const len = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const rand = mulberry32(seed + c * 7919);
    const d = buf.getChannelData(c);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * level * 4;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function envGain(ctx, t, { a = 0.005, d = 0.2, s = 0, r = 0.1, peak = 1, dur = 0 }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (dur > 0) {
    g.gain.setTargetAtTime(peak * s, t + a, d / 3);
    g.gain.setValueAtTime(peak * s || 0.0001, t + dur);
    g.gain.setTargetAtTime(0, t + dur, r / 4);
  } else {
    g.gain.setTargetAtTime(0, t + a, d / 4);
  }
  return g;
}

function panner(ctx, pan) {
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    return p;
  }
  return ctx.createGain();
}

// ------------------------------------------------------------- instruments

function kick(ctx, out, t, { gain = 1, f0 = 140, f1 = 42, decay = 0.5, click = 0.3 } = {}, noise) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.09);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.02, decay / 4);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay * 2.5);
  if (click && noise) {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const ng = envGain(ctx, t, { a: 0.001, d: 0.012, peak: click });
    n.connect(hp).connect(ng).connect(out);
    n.start(t, (t * 5.7) % 0.5, 0.05);
  }
}

const hatBuses = new WeakMap();

/** Shared high-pass/peaking/pan chain per (context, output, pan) — hats are frequent. */
function hatBus(ctx, out, pan) {
  let perCtx = hatBuses.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    hatBuses.set(ctx, perCtx);
  }
  const key = pan.toFixed(2);
  let bus = perCtx.get(key);
  if (!bus) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 10500;
    pk.gain.value = 6;
    hp.connect(pk).connect(panner(ctx, pan)).connect(out);
    bus = hp;
    perCtx.set(key, bus);
  }
  return bus;
}

function hat(ctx, out, t, noise, { open = false, pan = 0, gain = 0.25 } = {}) {
  const n = ctx.createBufferSource();
  n.buffer = noise;
  const g = envGain(ctx, t, { a: 0.001, d: open ? 0.35 : 0.045, peak: gain });
  n.connect(g).connect(hatBus(ctx, out, pan));
  n.start(t, (t * 7.3) % 1, open ? 0.5 : 0.12);
}

function snare(ctx, out, t, noise, { gain = 0.7, pan = 0, tone = 185, decay = 0.18 } = {}) {
  const n = ctx.createBufferSource();
  n.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 0.7;
  const g = envGain(ctx, t, { a: 0.001, d: decay, peak: gain });
  const p = panner(ctx, pan);
  n.connect(bp).connect(g).connect(p).connect(out);
  n.start(t, (t * 3.1) % 1, decay * 2);
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(tone * 1.4, t);
  o.frequency.exponentialRampToValueAtTime(tone, t + 0.03);
  const og = envGain(ctx, t, { a: 0.001, d: 0.09, peak: gain * 0.6 });
  o.connect(og).connect(p);
  o.start(t);
  o.stop(t + 0.3);
}

function clap(ctx, out, t, noise, gain = 0.5) {
  for (let i = 0; i < 3; i++) snare(ctx, out, t + i * 0.011, noise, { gain: gain * (i === 2 ? 1 : 0.5), tone: 0.0001, decay: i === 2 ? 0.2 : 0.02, pan: (i - 1) * 0.3 });
}

function subBass(ctx, out, t, dur, freq, { gain = 0.6, glideFrom = null, harmonics = 0.18 } = {}) {
  const g = envGain(ctx, t, { a: 0.008, d: 0.3, s: 0.85, r: 0.08, peak: gain, dur });
  for (const [mul, lvl] of [
    [1, 1],
    [2, harmonics],
  ]) {
    const o = ctx.createOscillator();
    if (glideFrom) {
      o.frequency.setValueAtTime(glideFrom * mul, t);
      o.frequency.exponentialRampToValueAtTime(freq * mul, t + 0.12);
    } else o.frequency.setValueAtTime(freq * mul, t);
    const lg = ctx.createGain();
    lg.gain.value = lvl;
    o.connect(lg).connect(g);
    o.start(t);
    o.stop(t + dur + 0.5);
  }
  g.connect(out);
}

function supersaw(ctx, out, t, dur, notes, { gain = 0.05, cutoff = 2400, env = 3000, width = 0.8 } = {}) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 3;
  lp.frequency.setValueAtTime(cutoff + env, t);
  // Finite ramp: a never-ending setTarget keeps the biquad recomputing
  // coefficients every sample, which is expensive.
  lp.frequency.exponentialRampToValueAtTime(cutoff, t + 0.7);
  const g = envGain(ctx, t, { a: 0.02, d: 0.4, s: 0.7, r: 0.35, peak: gain, dur });
  lp.connect(g).connect(out);
  const detunes = [-17, 0, 17];
  // One panner per detune voice, shared by all chord notes.
  const pans = detunes.map((_, i) => {
    const p = panner(ctx, ((i / (detunes.length - 1)) * 2 - 1) * width);
    p.connect(lp);
    return p;
  });
  for (const n of notes) {
    detunes.forEach((d, i) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(n);
      o.detune.value = d;
      o.connect(pans[i]);
      o.start(t);
      o.stop(t + dur + 0.6);
    });
  }
}

function fmKey(ctx, out, t, note, dur, { vel = 0.5, ratio = 1, index = 2.5, pan = 0, decay = 1.6 } = {}) {
  const f = midi(note);
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f * ratio;
  const mi = ctx.createGain();
  mi.gain.setValueAtTime(f * index, t);
  mi.gain.setTargetAtTime(f * index * 0.15, t, 0.25);
  mod.connect(mi).connect(car.frequency);
  const tine = ctx.createOscillator();
  tine.frequency.value = f * 14;
  const tg = envGain(ctx, t, { a: 0.001, d: 0.05, peak: vel * 0.06 });
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel * 0.3, t + 0.004);
  g.gain.setTargetAtTime(vel * 0.12, t + 0.004, decay * 0.2);
  g.gain.setTargetAtTime(0, t + dur, 0.12);
  const p = panner(ctx, pan);
  car.connect(g).connect(p).connect(out);
  tine.connect(tg).connect(p);
  for (const o of [car, mod, tine]) {
    o.start(t);
    o.stop(t + dur + 1);
  }
}

function strings(ctx, out, t, dur, notes, { gain = 0.035, cutoff = 1800 } = {}) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  const g = envGain(ctx, t, { a: dur * 0.35, d: 1, s: 1, r: 1.2, peak: gain, dur });
  lp.connect(g).connect(out);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5.2;
  const lfoG = ctx.createGain();
  lfoG.gain.value = 9;
  lfo.connect(lfoG);
  lfo.start(t);
  lfo.stop(t + dur + 2);
  notes.forEach((n, k) => {
    for (const d of [-7, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(n);
      o.detune.value = d;
      lfoG.connect(o.detune);
      o.connect(panner(ctx, (k % 2 ? 0.5 : -0.5) * (d > 0 ? 1 : 0.6))).connect(lp);
      o.start(t);
      o.stop(t + dur + 2);
    }
  });
}

function masterBus(ctx) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  comp.knee.value = 8;
  const g = ctx.createGain();
  g.gain.value = 0.8;
  comp.connect(g).connect(ctx.destination);
  return comp;
}

// ------------------------------------------------------------------ tracks

function renderNeon(ctx) {
  const out = masterBus(ctx);
  const noise = noiseBuffer(ctx, 2, 11);
  const bpm = 124;
  const beat = 60 / bpm;
  const bars = 16;
  const prog = [
    [45, [57, 60, 64]],
    [41, [57, 60, 65]],
    [48, [55, 60, 64]],
    [43, [55, 59, 62]],
  ];
  const duck = ctx.createGain();
  duck.connect(out);
  for (let bar = 0; bar < bars; bar++) {
    const t0 = 0.05 + bar * 4 * beat;
    const [root, chord] = prog[bar % 4];
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      if (bar >= 1) kick(ctx, out, t, { gain: 0.95, f0: 150, f1: 44, decay: 0.42 }, noise);
      duck.gain.setValueAtTime(bar >= 1 ? 0.25 : 1, t);
      duck.gain.setTargetAtTime(1, t + 0.02, 0.09);
      if (bar >= 2) hat(ctx, out, t + beat / 2, noise, { open: b % 2 === 1, pan: 0.35, gain: 0.18 });
      if (bar >= 4) hat(ctx, out, t + beat / 4, noise, { pan: -0.4, gain: 0.08 });
      if (bar >= 4 && (b === 1 || b === 3)) clap(ctx, out, t, noise, 0.45);
      if (bar >= 2) subBass(ctx, duck, t + beat * 0.5, beat * 0.45, midi(root - 12), { gain: 0.55 });
    }
    if (bar >= 1) supersaw(ctx, duck, t0, 4 * beat - 0.05, chord, { gain: 0.05, cutoff: 900 + bar * 180, env: 2500 });
  }
}

function render808(ctx) {
  const out = masterBus(ctx);
  const noise = noiseBuffer(ctx, 2, 23);
  const bpm = 140;
  const beat = 60 / bpm;
  const notes = [38, 38, 41, 36];
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    const x = (i / 2047) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }
  shaper.curve = curve;
  const bassBus = ctx.createGain();
  bassBus.gain.value = 0.8;
  bassBus.connect(shaper).connect(out);
  for (let bar = 0; bar < 12; bar++) {
    const t0 = 0.05 + bar * 4 * beat;
    const n = notes[bar % 4];
    subBass(ctx, bassBus, t0, beat * 1.4, midi(n), { gain: 0.8, harmonics: 0.05 });
    subBass(ctx, bassBus, t0 + beat * 1.75, beat * 0.6, midi(n), { gain: 0.7, harmonics: 0.05 });
    subBass(ctx, bassBus, t0 + beat * 2.5, beat * 1.3, midi(n + (bar % 2 ? 3 : 5)), { gain: 0.75, glideFrom: midi(n), harmonics: 0.05 });
    kick(ctx, out, t0, { gain: 0.6, f0: 180, f1: 55, decay: 0.2 }, noise);
    kick(ctx, out, t0 + beat * 2.5, { gain: 0.5, f0: 180, f1: 55, decay: 0.2 }, noise);
    snare(ctx, out, t0 + beat * 2, noise, { gain: 0.6 });
    for (let s = 0; s < 16; s++) {
      const roll = bar % 4 === 3 && s >= 12;
      if (roll) for (let r = 0; r < 3; r++) hat(ctx, out, t0 + (s * beat) / 4 + (r * beat) / 12, noise, { pan: 0.2, gain: 0.1 });
      else hat(ctx, out, t0 + (s * beat) / 4, noise, { pan: 0.2, gain: s % 2 ? 0.07 : 0.13 });
    }
    if (bar >= 4) {
      const mel = [74, 77, 72, 70];
      fmKey(ctx, out, t0 + beat * 0.5, mel[bar % 4], beat * 1.5, { vel: 0.35, ratio: 3.5, index: 1.2, pan: -0.3, decay: 0.8 });
      fmKey(ctx, out, t0 + beat * 2.5, mel[(bar + 1) % 4], beat, { vel: 0.3, ratio: 3.5, index: 1.2, pan: 0.3, decay: 0.8 });
    }
  }
}

function renderKeys(ctx) {
  const out = masterBus(ctx);
  const noise = noiseBuffer(ctx, 2, 31);
  const bpm = 84;
  const beat = 60 / bpm;
  const chords = [
    [50, 57, 60, 64, 69],
    [55, 59, 62, 65, 69],
    [48, 55, 59, 62, 64],
    [45, 52, 55, 60, 64],
  ];
  for (let bar = 0; bar < 8; bar++) {
    const t0 = 0.05 + bar * 4 * beat;
    const ch = chords[bar % 4];
    ch.forEach((n, i) => fmKey(ctx, out, t0 + i * 0.012, n, beat * 3.6, { vel: 0.3 + (i === ch.length - 1 ? 0.1 : 0), pan: (i / (ch.length - 1)) * 1.2 - 0.6 }));
    fmKey(ctx, out, t0 + beat * 2.5, ch[ch.length - 1] + 2, beat, { vel: 0.25, pan: 0.5 });
    subBass(ctx, out, t0, beat * 1.8, midi(ch[0] - 12), { gain: 0.35, harmonics: 0.3 });
    subBass(ctx, out, t0 + beat * 2, beat * 1.8, midi(ch[0] - 12 + 7), { gain: 0.3, harmonics: 0.3 });
    if (bar >= 1) {
      kick(ctx, out, t0, { gain: 0.5, f0: 110, f1: 50, decay: 0.35, click: 0.05 }, noise);
      kick(ctx, out, t0 + beat * 2.5, { gain: 0.35, f0: 110, f1: 50, decay: 0.3, click: 0.05 }, noise);
      snare(ctx, out, t0 + beat, noise, { gain: 0.18, decay: 0.3 });
      snare(ctx, out, t0 + beat * 3, noise, { gain: 0.18, decay: 0.3 });
      for (let s = 0; s < 8; s++) hat(ctx, out, t0 + (s * beat) / 2 + (s % 2 ? beat * 0.08 : 0), noise, { pan: -0.3, gain: 0.05 });
    }
  }
}

function renderOrchestral(ctx) {
  const out = masterBus(ctx);
  const noise = noiseBuffer(ctx, 2, 41);
  const chords = [
    [38, 50, 57, 62, 65, 69],
    [34, 46, 53, 58, 62, 65],
    [36, 48, 55, 60, 64, 67],
    [33, 45, 52, 57, 61, 64],
  ];
  for (let i = 0; i < 4; i++) {
    const t = 0.1 + i * 6;
    strings(ctx, out, t, 6.5, chords[i], { gain: 0.03, cutoff: 1200 + i * 500 });
    subBass(ctx, out, t, 6, midi(chords[i][0]), { gain: 0.25, harmonics: 0.5 });
    // Timpani
    kick(ctx, out, t, { gain: 0.5, f0: midi(chords[i][0] + 12) * 1.2, f1: midi(chords[i][0] + 12), decay: 1.4, click: 0.1 }, noise);
    if (i >= 1) for (let k = 0; k < 3; k++) fmKey(ctx, out, t + 3 + k * 0.5, chords[i][3 + k] + 12, 0.8, { vel: 0.18, ratio: 2, index: 1.5, pan: 0.4 });
  }
}

function renderDrums(ctx) {
  const out = masterBus(ctx);
  const noise = noiseBuffer(ctx, 2, 53);
  const bpm = 96;
  const beat = 60 / bpm;
  const K = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
  const S = [0, 0, 0, 0, 1, 0, 0, 0.3, 0, 0.3, 0, 0, 1, 0, 0, 0.4];
  for (let bar = 0; bar < 10; bar++) {
    const t0 = 0.05 + bar * 4 * beat;
    for (let s = 0; s < 16; s++) {
      const swing = s % 2 ? beat * 0.06 : 0;
      const t = t0 + (s * beat) / 4 + swing;
      if (K[s]) kick(ctx, out, t, { gain: 0.9, f0: 120, f1: 50, decay: 0.35, click: 0.2 }, noise);
      if (S[s]) snare(ctx, out, t, noise, { gain: 0.65 * S[s], pan: 0.05 });
      hat(ctx, out, t, noise, { open: s === 14, pan: 0.3, gain: s % 4 === 0 ? 0.16 : 0.09 });
    }
  }
}

function renderSweep(ctx) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const dur = ctx.length / ctx.sampleRate;
  o.frequency.setValueAtTime(20, 0.25);
  o.frequency.exponentialRampToValueAtTime(20000, dur - 0.25);
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(0.25, 0.25);
  g.gain.setValueAtTime(0.25, dur - 0.3);
  g.gain.linearRampToValueAtTime(0, dur - 0.05);
  o.connect(g).connect(ctx.destination);
  o.start(0);
}

function renderPink(ctx) {
  const src = ctx.createBufferSource();
  src.buffer = pinkNoise(ctx, ctx.length / ctx.sampleRate, 7, 2, 0.2);
  const g = ctx.createGain();
  const dur = ctx.length / ctx.sampleRate;
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.1);
  g.gain.setValueAtTime(1, dur - 0.15);
  g.gain.linearRampToValueAtTime(0, dur);
  src.connect(g).connect(ctx.destination);
  src.start(0);
}

function renderBassLadder(ctx) {
  const freqs = [20, 25, 31.5, 40, 50, 63, 80, 100, 125];
  const step = 2.2;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0;
  freqs.forEach((f, i) => {
    const t = 0.1 + i * step;
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4, t + 0.08);
    g.gain.setValueAtTime(0.4, t + step - 0.3);
    g.gain.linearRampToValueAtTime(0, t + step - 0.1);
  });
  o.connect(g).connect(ctx.destination);
  o.start(0);
}

function renderImaging(ctx) {
  const merger = ctx.destination;
  const blocks = [
    { pan: -1, f: 440 },
    { pan: 0, f: 660 },
    { pan: 1, f: 880 },
  ];
  blocks.forEach((b, i) => {
    for (let k = 0; k < 6; k++) {
      const t = 0.1 + i * 3 + k * 0.45;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = b.f;
      const g = envGain(ctx, t, { a: 0.01, d: 0.25, peak: 0.3 });
      o.connect(g).connect(panner(ctx, b.pan)).connect(merger);
      o.start(t);
      o.stop(t + 0.5);
    }
  });
  // Circular pan sweep with pink noise.
  const src = ctx.createBufferSource();
  src.buffer = pinkNoise(ctx, 8, 99, 1, 0.3);
  const p = panner(ctx, 0);
  if (p.pan) {
    for (let k = 0; k <= 80; k++) p.pan.setValueAtTime(Math.sin((k / 80) * Math.PI * 4), 9.5 + k * 0.1);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 9.4);
  g.gain.linearRampToValueAtTime(0.8, 9.6);
  g.gain.setValueAtTime(0.8, 17.4);
  g.gain.linearRampToValueAtTime(0, 17.6);
  src.connect(g).connect(p).connect(merger);
  src.start(9.4);
}

function renderPhase(ctx) {
  const dur = ctx.length / ctx.sampleRate;
  const mono = pinkNoise(ctx, dur, 5, 1, 0.2);
  const src = ctx.createBufferSource();
  src.buffer = mono;
  const split = ctx.createChannelMerger(2);
  const l = ctx.createGain();
  const r = ctx.createGain();
  r.gain.setValueAtTime(1, 0);
  r.gain.setValueAtTime(-1, dur / 2);
  src.connect(l).connect(split, 0, 0);
  src.connect(r).connect(split, 0, 1);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.1);
  g.gain.setValueAtTime(1, dur - 0.15);
  g.gain.linearRampToValueAtTime(0, dur);
  split.connect(g).connect(ctx.destination);
  src.start(0);
}

export const DEMO_ALBUMS = {
  sessions: { name: 'Demo Sessions', hues: [265, 190] },
  signals: { name: 'Calibration Signals', hues: [150, 40] },
};

export const DEMO_TRACKS = [
  { id: 'neon-sub', title: 'Neon Sub Pressure', album: 'sessions', genre: 'Electronic', track: 1, seconds: 31.2, bpm: 124, render: renderNeon },
  { id: '808-drive', title: '808 Midnight Drive', album: 'sessions', genre: 'Hip-Hop', track: 2, seconds: 21, bpm: 140, render: render808 },
  { id: 'velvet-keys', title: 'Velvet Keys', album: 'sessions', genre: 'Jazz', track: 3, seconds: 23.5, bpm: 84, render: renderKeys },
  { id: 'orchestral', title: 'Orchestral Swell', album: 'sessions', genre: 'Classical', track: 4, seconds: 26, render: renderOrchestral },
  { id: 'drum-break', title: 'Dry Drum Break (Reverb Audition)', album: 'sessions', genre: 'Funk', track: 5, seconds: 25.4, bpm: 96, render: renderDrums },
  { id: 'sweep', title: 'Log Sine Sweep 20 Hz – 20 kHz', album: 'signals', genre: 'Test Signal', track: 1, seconds: 20, render: renderSweep },
  { id: 'pink', title: 'Pink Noise (Uncorrelated Stereo)', album: 'signals', genre: 'Test Signal', track: 2, seconds: 20, render: renderPink },
  { id: 'bass-ladder', title: 'Bass Ladder 20–125 Hz (Room Modes)', album: 'signals', genre: 'Test Signal', track: 3, seconds: 20.2, render: renderBassLadder },
  { id: 'imaging', title: 'Stereo Imaging: L · C · R · Orbit', album: 'signals', genre: 'Test Signal', track: 4, seconds: 18, render: renderImaging },
  { id: 'phase', title: 'Polarity Check (In → Out of Phase)', album: 'signals', genre: 'Test Signal', track: 5, seconds: 12, render: renderPhase },
];

/** Render a demo track to an AudioBuffer. */
export async function renderDemo(id, sampleRate = SR) {
  const def = DEMO_TRACKS.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown demo ${id}`);
  const Ctor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Ctor(2, Math.ceil(def.seconds * sampleRate), sampleRate);
  def.render(ctx);
  return ctx.startRendering();
}

const blobCache = new Map();

/** WAV Blob for a demo track (cached in memory, max 3). */
export async function demoBlob(id) {
  if (blobCache.has(id)) {
    const b = blobCache.get(id);
    blobCache.delete(id);
    blobCache.set(id, b);
    return b;
  }
  const p = renderDemo(id).then((buf) => {
    const def = DEMO_TRACKS.find((d) => d.id === id);
    return encodeWav(buf, { bitDepth: 16, meta: { title: def.title, artist: 'AudioSpace Labs', album: DEMO_ALBUMS[def.album].name } });
  });
  blobCache.set(id, p);
  while (blobCache.size > 3) blobCache.delete(blobCache.keys().next().value);
  try {
    return await p;
  } catch (err) {
    blobCache.delete(id);
    throw err;
  }
}

/** Procedural album cover (browser only). */
export async function makeCover(title, hues, seed = 1) {
  const size = 600;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, `hsl(${hues[0]} 70% 22%)`);
  g.addColorStop(1, `hsl(${hues[1]} 80% 45%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(seed);
  // Concentric "speaker cone" rings.
  const cx = size * (0.35 + rand() * 0.3);
  const cy = size * (0.35 + rand() * 0.3);
  for (let r = 20; r < size * 0.9; r += 18 + rand() * 14) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${hues[1]} 100% 85% / ${0.05 + rand() * 0.2})`;
    ctx.lineWidth = 1 + rand() * 4;
    ctx.stroke();
  }
  // Waveform band.
  ctx.beginPath();
  for (let x = 0; x <= size; x += 4) {
    const y = size * 0.78 + Math.sin(x * 0.03) * 18 * Math.sin(x * 0.007 + seed) + (rand() - 0.5) * 10;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '700 52px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  const words = title.split(' ');
  let line = '';
  let y = 40;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > size - 80) {
      ctx.fillText(line, 40, y);
      y += 60;
      line = w;
    } else line = test;
  }
  ctx.fillText(line, 40, y);
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('AUDIOSPACE LABS', 40, size - 60);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Add the demo tracks to the library (file kind "demo" → rendered on demand).
 */
export async function installDemoLibrary(library, db, storeArtwork) {
  const art = {};
  let seed = 3;
  for (const [key, album] of Object.entries(DEMO_ALBUMS)) {
    try {
      const blob = await makeCover(album.name, album.hues, seed++);
      art[key] = await storeArtwork(db, blob, library.knownArtIds);
    } catch (err) {
      console.warn('[demo] cover generation failed', err);
      art[key] = null;
    }
  }
  const items = DEMO_TRACKS.map((d) => {
    const id = `demo_${d.id}`;
    return {
      track: {
        id,
        title: d.title,
        artist: 'AudioSpace Labs',
        albumArtist: 'AudioSpace Labs',
        album: DEMO_ALBUMS[d.album].name,
        genre: d.genre,
        year: 2026,
        track: d.track,
        trackTotal: DEMO_TRACKS.filter((x) => x.album === d.album).length,
        bpm: d.bpm || null,
        duration: d.seconds,
        format: 'wav',
        codec: 'PCM',
        sampleRate: SR,
        channels: 2,
        bitsPerSample: 16,
        bitrate: 1411,
        size: Math.round(d.seconds * SR * 4),
        path: `AudioSpace Demo/${DEMO_ALBUMS[d.album].name}/${d.title}.wav`,
        name: `${d.title}.wav`,
        dirPath: `AudioSpace Demo/${DEMO_ALBUMS[d.album].name}`,
        artId: art[d.album],
        source: 'demo',
        addedAt: Date.now(),
      },
      file: { id, kind: 'demo', demo: d.id },
    };
  });
  await library.addTracks(items);
  library.commit('demo');
  return items.length;
}
