import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSweep, deconvolve, splitResponse, frequencyResponse, distortion, decayAnalysis, waterfall, energyTimeCurve, stepResponse, summarize, REF_SPL } from '../../src/audio/measure.js';
import { processBiquads } from '../../src/acoustics/ir.js';
import { coefficients, specMagnitudeDb } from '../../src/dsp/biquad.js';
import { mulberry32 } from '../../src/util/math.js';

const SR = 48000;
const sweep = makeSweep({ sampleRate: SR, seconds: 2, levelDb: -6 });

function record(fn, tail = 1.5) {
  const out = new Float32Array(sweep.signal.length + Math.round(tail * SR));
  fn(out);
  return out;
}

function measure(rec) {
  return splitResponse(deconvolve(sweep, rec), sweep);
}

const near = (freqs, f) => {
  let b = 0;
  for (let i = 0; i < freqs.length; i++) if (Math.abs(Math.log(freqs[i] / f)) < Math.abs(Math.log(freqs[b] / f))) b = i;
  return b;
};

test('sweep deconvolution recovers delay and gain of a pure delay system', () => {
  const D = 480; // 10 ms
  const g = 0.5;
  const m = measure(record((o) => sweep.signal.forEach((v, i) => (o[i + D] = v * g))));
  assert.equal(m.delaySamples + m.peakIndex, D);
  const fr = frequencyResponse(m);
  for (let i = 0; i < fr.freqs.length; i++) {
    const f = fr.freqs[i];
    if (f < 20 || f > 18000) continue;
    assert.ok(Math.abs(fr.spl[i] - (REF_SPL + 20 * Math.log10(g))) < 0.1, `${f.toFixed(0)} Hz: ${fr.spl[i].toFixed(2)}`);
    assert.ok(Math.abs(fr.phase[i]) < 3, `phase ${fr.phase[i]} at ${f}`);
    assert.ok(Math.abs(fr.groupDelayMs[i]) < (f < 100 ? 0.5 : 0.05), `group delay ${fr.groupDelayMs[i]} at ${f}`);
  }
  const s = summarize(m);
  assert.ok(Math.abs(s.arrivalMs - 10) < 0.05);
  const step = stepResponse(m);
  // A delta's step settles at (just under) its Gibbs-overshoot-normalised peak.
  const v = step[m.peakIndex + 96];
  assert.ok(v > 0.85 && v <= 1, `step ${v}`);
  const etc = energyTimeCurve(m);
  assert.ok(Math.abs(etc[m.peakIndex]) < 0.5);
});

test('measured response of a filter matches its analytic magnitude', () => {
  const spec = { type: 'peaking', frequency: 1000, Q: 2, gain: 6 };
  const c = coefficients(spec, SR);
  const m = measure(record((o) => {
    o.set(sweep.signal);
    processBiquads(o, [c]);
  }));
  const fr = frequencyResponse(m);
  for (const f of [100, 700, 1000, 1400, 5000]) {
    const i = near(fr.freqs, f);
    const want = REF_SPL + specMagnitudeDb(spec, fr.freqs[i], SR);
    assert.ok(Math.abs(fr.spl[i] - want) < 0.2, `${f} Hz measured ${fr.spl[i].toFixed(2)} want ${want.toFixed(2)}`);
  }
});

test('harmonic distortion of a static nonlinearity is measured correctly', () => {
  // y = x + a·x²: a sine of amplitude A yields H2 = a·A/2 relative to the fundamental.
  const a = 0.2;
  const m = measure(record((o) => sweep.signal.forEach((v, i) => (o[i + 100] = v + a * v * v))));
  const d = distortion(m, { levelRms: sweep.amplitude / Math.SQRT2 });
  const want = (a * sweep.amplitude) / 2; // ≈ 5 %
  for (const f of [100, 1000, 3000]) {
    const i = near(d.freqs, f);
    const h2 = d.harmonics.find((x) => x.k === 2);
    const ratio = Math.pow(10, (h2.spl[i] - d.fundamental[i]) / 20);
    assert.ok(Math.abs(ratio / want - 1) < 0.1, `${f} Hz: H2 ${(ratio * 100).toFixed(2)} % want ${(want * 100).toFixed(2)} %`);
    assert.ok(Math.abs(d.thdPct[i] / (want * 100) - 1) < 0.15, `THD ${d.thdPct[i].toFixed(2)} %`);
  }
  // A linear system shows (numerically) no distortion.
  const lin = measure(record((o) => o.set(sweep.signal)));
  const dl = distortion(lin);
  assert.ok(Math.max(...dl.thdPct.filter((_, i) => dl.freqs[i] > 30 && dl.freqs[i] < 5000)) < 0.05);
});

test('decay analysis finds the RT60 of an exponentially decaying tail', () => {
  const rt = 0.8;
  const rnd = mulberry32(11);
  const len = Math.round(1.6 * SR);
  const ir = new Float32Array(len);
  ir[0] = 1;
  for (let i = 1; i < len; i++) ir[i] = (rnd() * 2 - 1) * 0.05 * Math.pow(10, (-3 * (i / SR)) / rt);
  const m = { ir, sampleRate: SR, peakIndex: 0, delaySamples: 0, harmonics: [] };
  const d = decayAnalysis(m);
  for (const b of d.bands.filter((x) => x.f >= 250 && x.f <= 4000)) {
    assert.ok(Math.abs(b.t20 - rt) < 0.08, `${b.f} Hz T20 ${b.t20}`);
    assert.ok(Math.abs(b.t30 - rt) < 0.08, `${b.f} Hz T30 ${b.t30}`);
  }
  assert.ok(Number.isFinite(d.c80) && Number.isFinite(d.c50) && d.c50 < d.c80);
});

test('waterfall shows a resonance ringing longer than its surroundings', () => {
  const spec = { type: 'peaking', frequency: 50, Q: 12, gain: 12 };
  const ir = new Float64Array(SR);
  ir[480] = 1;
  processBiquads(ir, [coefficients(spec, SR)]);
  const m = { ir: Float32Array.from(ir), sampleRate: SR, peakIndex: 480, delaySamples: 0, harmonics: [] };
  const w = waterfall(m, { slices: 20, stepMs: 15 });
  const i50 = near(w.freqs, 50);
  const i200 = near(w.freqs, 200);
  const last = w.slices[w.slices.length - 1];
  assert.ok(last[i50] - last[i200] > 20, `50 Hz ${last[i50].toFixed(1)} dB vs 200 Hz ${last[i200].toFixed(1)} dB`);
  assert.ok(w.slices[0][i50] > w.slices[0][i200]);
});
