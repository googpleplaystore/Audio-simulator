import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Response,
  linkwitzRiley,
  specMagnitudeDb,
  cascadeMagnitudeDb,
  coefficients,
  butterworth,
} from '../../src/dsp/biquad.js';
import { fitFilters, smoothOctave } from '../../src/dsp/fit.js';
import { fft } from '../../src/dsp/fft.js';
import { GEQ_FREQS, GEQ_PRESETS, suggestCrossover } from '../../src/dsp/curves.js';
import { logspace, octaveGrid } from '../../src/util/math.js';

const FS = 48000;
const freqs = logspace(10, 20000, 400);

function sumDb(fc, slope, invertHp) {
  const lp = new Response(freqs, FS).filter(linkwitzRiley('lowpass', slope, fc));
  const hp = new Response(freqs, FS).filter(linkwitzRiley('highpass', slope, fc)).gain(invertHp ? -1 : 1);
  return lp.add(hp).magnitudeDb();
}

test('LR4 and LR8 crossovers sum to a flat (allpass) response', () => {
  for (const slope of [24, 48]) {
    const db = sumDb(80, slope, false);
    for (let i = 0; i < db.length; i++) {
      if (freqs[i] > 15000) continue; // bilinear warping near Nyquist
      assert.ok(Math.abs(db[i]) < 0.05, `slope ${slope} at ${freqs[i].toFixed(1)} Hz: ${db[i]}`);
    }
  }
});

test('LR2 needs the high-pass inverted to sum flat', () => {
  const notInverted = sumDb(100, 12, false);
  const minDb = Math.min(...notInverted);
  assert.ok(minDb < -30, `expected deep null, got ${minDb}`);
  const inverted = sumDb(100, 12, true);
  for (let i = 0; i < inverted.length; i++) {
    if (freqs[i] > 15000) continue;
    assert.ok(Math.abs(inverted[i]) < 0.05);
  }
});

test('Linkwitz-Riley sections are -6 dB at the crossover frequency', () => {
  for (const slope of [12, 24, 48]) {
    for (const type of ['lowpass', 'highpass']) {
      const db = cascadeMagnitudeDb(linkwitzRiley(type, slope, 120), [120], FS)[0];
      assert.ok(Math.abs(db + 6.02) < 0.1, `${type} ${slope}: ${db}`);
    }
  }
});

test('LR slopes have the right asymptotic roll-off', () => {
  for (const [slope, perOct] of [
    [12, 12],
    [24, 24],
    [48, 48],
  ]) {
    const a = cascadeMagnitudeDb(linkwitzRiley('lowpass', slope, 100), [1600, 3200], FS);
    assert.ok(Math.abs(a[0] - a[1] - perOct) < 1.0, `slope ${slope}: ${a[0] - a[1]}`);
  }
});

test('peaking filter hits its gain at centre frequency', () => {
  const db = specMagnitudeDb({ type: 'peaking', frequency: 1000, Q: 2, gain: 6 }, 1000, FS);
  assert.ok(Math.abs(db - 6) < 1e-6);
  const shelf = specMagnitudeDb({ type: 'lowshelf', frequency: 100, gain: 9 }, 10, FS);
  assert.ok(Math.abs(shelf - 9) < 0.2);
});

test('identity peaking spec has unity coefficients', () => {
  const c = coefficients({ type: 'peaking', frequency: 1000, Q: 1, gain: 0 }, FS);
  assert.ok(Math.abs(c.b0 - 1) < 1e-12 && Math.abs(c.b1 - c.a1) < 1e-12 && Math.abs(c.b2 - c.a2) < 1e-12);
});

test('butterworth 4th order high-pass is -3 dB at f3', () => {
  const db = cascadeMagnitudeDb(butterworth('highpass', 4, 50), [50], FS)[0];
  assert.ok(Math.abs(db + 3.01) < 0.05, String(db));
});

test('fitFilters recovers a curve built from known filters', () => {
  const grid = octaveGrid(20, 500, 24);
  const truth = [
    { type: 'peaking', frequency: 42, Q: 6, gain: 9 },
    { type: 'peaking', frequency: 97, Q: 3, gain: -12 },
    { type: 'peaking', frequency: 210, Q: 4, gain: 5 },
  ];
  const target = cascadeMagnitudeDb(truth, grid, FS);
  const res = fitFilters(grid, target, { maxFilters: 8, tolerance: 0.2 });
  assert.ok(res.rmsErrorDb < 0.6, `rms error ${res.rmsErrorDb}`);
});

test('octave smoothing preserves a flat curve', () => {
  const grid = octaveGrid(20, 20000, 24);
  const flat = new Float64Array(grid.length).fill(3);
  const sm = smoothOctave(grid, flat, 6);
  for (const v of sm) assert.ok(Math.abs(v - 3) < 1e-9);
});

test('FFT round trip and known spectrum', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
  const orig = Float64Array.from(re);
  fft(re, im);
  assert.ok(Math.abs(re[10] - n / 2) < 1e-6);
  fft(re, im, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('graphic EQ presets have 31 bands', () => {
  assert.equal(GEQ_FREQS.length, 31);
  for (const p of GEQ_PRESETS) assert.equal(p.gains.length, 31, p.id);
  const v = GEQ_PRESETS.find((p) => p.id === 'v-shape-extreme');
  assert.ok(v.gains[0] >= 8 && v.gains[30] >= 8 && Math.min(...v.gains) <= -4);
});

test('crossover suggestion rounds up to AVR steps', () => {
  assert.equal(suggestCrossover(45), 60);
  assert.equal(suggestCrossover(64), 80);
  assert.equal(suggestCrossover(79), 100);
});
