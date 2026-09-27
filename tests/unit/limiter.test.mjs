import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TruePeakLimiter, truePeak } from '../../src/audio/worklets/limiter.worklet.js';
import { mulberry32 } from '../../src/util/math.js';

const SR = 48000;

function run(lim, channels, block = 128) {
  const n = channels[0].length;
  const out = channels.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += block) {
    const len = Math.min(block, n - s);
    lim.process(
      channels.map((c) => c.subarray(s, s + len)),
      out.map((c) => c.subarray(s, s + len)),
      len,
    );
  }
  return out;
}

function samplePeakDb(chs) {
  let p = 0;
  for (const c of chs) for (const v of c) p = Math.max(p, Math.abs(v));
  return 20 * Math.log10(p);
}

test('truePeak finds inter-sample peaks that sample peak misses', () => {
  // fs/4 sine sampled at ±45°: every sample is 0.707, the waveform peaks at 1.
  const x = new Float32Array(4800);
  for (let n = 0; n < x.length; n++) x[n] = Math.sin((Math.PI / 2) * n + Math.PI / 4);
  assert.ok(Math.abs(samplePeakDb([x]) + 3.01) < 0.01);
  assert.ok(Math.abs(truePeak([x])) < 0.1, `true peak ${truePeak([x])}`);
});

test('signals below the ceiling pass bit-exactly after the latency', () => {
  const lim = new TruePeakLimiter({ sampleRate: SR, ceilingDb: -1 });
  const rnd = mulberry32(7);
  const L = new Float32Array(9600).map(() => (rnd() - 0.5) * 0.4);
  const R = new Float32Array(9600).map(() => (rnd() - 0.5) * 0.4);
  const [oL, oR] = run(lim, [L, R]);
  const d = lim.latency;
  for (let i = d; i < L.length; i++) {
    assert.equal(oL[i], L[i - d]);
    assert.equal(oR[i], R[i - d]);
  }
  for (let i = 0; i < d; i++) assert.equal(oL[i], 0);
});

test('hot program material never exceeds the ceiling (sample and true peak)', () => {
  const ceilingDb = -1;
  const lim = new TruePeakLimiter({ sampleRate: SR, ceilingDb });
  const rnd = mulberry32(3);
  const n = SR * 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Kick-like bass bursts, a near-Nyquist tone (inter-sample peaks) and noise, up to +9 dBFS.
    const kick = Math.exp(-((t % 0.5) * 18)) * Math.sin(2 * Math.PI * 55 * t) * 2.2;
    const hf = Math.sin(2 * Math.PI * 11990 * t + 0.785) * 0.9;
    L[i] = kick + hf + (rnd() - 0.5) * 0.3;
    R[i] = kick - hf * 0.5 + (rnd() - 0.5) * 0.3;
  }
  assert.ok(truePeak([L, R]) > 7);
  const out = run(lim, [L, R]);
  assert.ok(samplePeakDb(out) <= ceilingDb + 1e-4, `sample peak ${samplePeakDb(out)}`);
  const tp = truePeak(out);
  assert.ok(tp <= ceilingDb + 0.1, `true peak ${tp.toFixed(3)} dBTP`);
});

test('lookahead: gain is already reduced when a sudden transient arrives', () => {
  const lim = new TruePeakLimiter({ sampleRate: SR, ceilingDb: -0.1, lookaheadMs: 2 });
  const n = 4800;
  const x = new Float32Array(n);
  x.fill(0.1, 0, 2000);
  x.fill(4, 2000, 2010); // +12 dBFS spike
  x.fill(0.1, 2010);
  const [y] = run(lim, [x, new Float32Array(n)]);
  const peak = Math.max(...y.map(Math.abs));
  assert.ok(peak <= Math.pow(10, -0.1 / 20) + 1e-6, `peak ${peak}`);
  // The spike is reduced to the true-peak ceiling (its Gibbs overshoot is
  // ~1 dB above the samples), not muted.
  const d = lim.latency;
  assert.ok(Math.abs(y[2000 + d]) > 0.85);
  assert.ok(truePeak([y]) <= -0.1 + 0.05);
  // Gain reduction starts before the spike (lookahead ramp), not after.
  assert.ok(Math.abs(y[2000 + d - 20]) < 0.1 * 0.9);
});

test('release returns to unity gain and stats report gain reduction', () => {
  const lim = new TruePeakLimiter({ sampleRate: SR, ceilingDb: -1, releaseMs: 50 });
  const n = SR;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i < 4800 ? 2 : 0.2) * Math.sin((2 * Math.PI * 440 * i) / SR);
  const [y] = run(lim, [x, new Float32Array(n)]);
  const s = lim.takeStats();
  assert.ok(20 * Math.log10(s.minGain) < -6);
  assert.ok(s.inPeak > 1.9 && s.outPeak <= Math.pow(10, -1 / 20) + 1e-6);
  // One second later the quiet part is untouched.
  const d = lim.latency;
  for (let i = n - 2000; i < n; i++) assert.ok(Math.abs(y[i] - x[i - d]) < 1e-4);
});

test('disabled limiter passes overs through with unity gain', () => {
  const lim = new TruePeakLimiter({ sampleRate: SR });
  lim.setEnabled(false);
  const x = new Float32Array(2000).fill(1.5);
  const [y] = run(lim, [x, x]);
  assert.equal(y[1999], 1.5);
});
