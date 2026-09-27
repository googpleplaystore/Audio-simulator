import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, aimYaw, yawVector, reverbSourcePositions } from '../../src/audio/plan.js';
import { predictSystem, bandMeanDb } from '../../src/audio/predict.js';
import { computeRoomCorrection, autoSetup, measure } from '../../src/audio/calibration.js';
import { defaultState, migrateState } from '../../src/core/settings.js';
import { computeRoomFilters } from '../../src/acoustics/compute.js';
import { octaveGrid } from '../../src/util/math.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

test('default plan: toe-in aims at listener, time alignment equalises arrival', () => {
  const s = defaultState();
  const p = buildPlan(s);
  const [l, r, sub] = p.sources;
  assert.ok(l.offAxisDeg < 10, `off-axis ${l.offAxisDeg}`);
  assert.ok(Math.abs(l.yaw + r.yaw) < 1e-6, 'symmetric toe-in');
  for (const x of p.sources) {
    const arrival = x.alignDelay + x.propDelay;
    assert.ok(Math.abs(arrival - (sub.alignDelay + sub.propDelay)) < 1e-9);
  }
});

test('amplifier headroom follows √P / 10 and active speakers use their own amp', () => {
  const s = defaultState();
  s.receiver.wattsPerChannel = 100;
  let p = buildPlan(s);
  assert.ok(Math.abs(p.sources[0].sClip - 1) < 1e-9);
  s.speakers[0].modelId = 'edifier-r1280dbs';
  p = buildPlan(s);
  assert.ok(Math.abs(p.sources[0].sClip - Math.sqrt(21) / 10) < 1e-9);
  assert.equal(p.sources[0].ampCurve, 'd');
});

test('master volume changes predicted SPL dB-for-dB', () => {
  const s = defaultState();
  const freqs = octaveGrid(100, 5000, 6);
  const a = predictSystem(buildPlan(s), freqs, { room: s.room });
  s.receiver.masterDb += 10;
  const b = predictSystem(buildPlan(s), freqs, { room: s.room });
  const d = bandMeanDb(freqs, b.db, 200, 2000) - bandMeanDb(freqs, a.db, 200, 2000);
  assert.ok(Math.abs(d - 10) < 0.01, String(d));
});

test('LR2 crossover without polarity flip produces a deeper crossover dip', () => {
  const base = defaultState();
  base.room.modes = false;
  base.room.boundary = false;
  base.room.reverb.enabled = false;
  base.room.propagation = false;
  // Place sub next to the left speaker so geometry doesn't dominate.
  base.subs[0].x = base.speakers[0].x + 0.3;
  base.subs[0].z = base.speakers[0].z;
  const freqs = octaveGrid(40, 200, 48);
  const dipAt = (state) => {
    // Isolate the electrical crossover: acoustic roll-offs of real drivers add
    // their own phase shift (which is why the polarity switch exists at all).
    const plan = buildPlan(state);
    for (const s of plan.sources) s.modelSpecs = [];
    const r = predictSystem(plan, freqs, { room: state.room });
    return bandMeanDb(freqs, r.db, 70, 110) - bandMeanDb(freqs, r.db, 150, 200);
  };
  const lr2 = clone(base);
  lr2.crossover.slope = 12;
  const lr2flip = clone(lr2);
  lr2flip.crossover.subPolarity = 180;
  assert.ok(dipAt(lr2) < dipAt(lr2flip) - 3, `${dipAt(lr2)} vs ${dipAt(lr2flip)}`);
});

test('room correction reduces deviation from target within its band', () => {
  const s = defaultState();
  s.roomCorrection.target = 'flat';
  s.roomCorrection.fMax = 500;
  const rf = computeRoomFilters({
    room: s.room,
    listener: s.listener,
    sampleRate: 48000,
    sources: [...s.speakers, ...s.subs].map((x) => ({ id: x.id, pos: { x: x.x, y: x.y, z: x.z } })),
  }).results;
  const res = computeRoomCorrection(s, { roomFilters: rf });
  assert.ok(res.filters.length > 0);
  assert.ok(res.errorAfter < res.errorBefore * 0.8, `${res.errorBefore} -> ${res.errorAfter}`);
  for (const f of res.filters) assert.ok(f.gain <= s.roomCorrection.maxBoost + 1e-9 && f.gain >= -s.roomCorrection.maxCut - 1e-9);
});

test('auto setup levels channels and picks a crossover', () => {
  const s = defaultState();
  s.subs[0].trimDb = 8; // deliberately hot sub
  const res = autoSetup(s);
  assert.ok(res.crossover && res.crossover.frequency >= 60);
  assert.ok(res.trims['sub-1'] < 8);
  // Applying the trims should bring the levels closer together.
  const s2 = clone(s);
  for (const x of [...s2.speakers, ...s2.subs]) x.trimDb = res.trims[x.id];
  Object.assign(s2.crossover, res.crossover);
  const again = autoSetup(s2);
  for (const id of Object.keys(res.trims)) assert.ok(Math.abs(again.trims[id] - res.trims[id]) <= 1.0, id);
});

test('measure() returns normalised curves; reverb positions resolved', () => {
  const m = measure(defaultState());
  assert.equal(m.freqs.length, m.smoothed.length);
  const pos = reverbSourcePositions(buildPlan(defaultState()));
  assert.ok(pos.srcL.x < pos.srcR.x);
});

test('yaw helpers are consistent', () => {
  const y = aimYaw({ x: 0, z: 0 }, { x: 1, z: 0 });
  assert.ok(Math.abs(y - 90) < 1e-9);
  const v = yawVector(180);
  assert.ok(Math.abs(v.z - 1) < 1e-9);
});

test('state migration fills missing keys and drops malformed sources', () => {
  const m = migrateState({ receiver: { masterDb: -30 }, speakers: [{ id: 'x' }], eq: { graphic: { gains: [1, 2] } } });
  assert.equal(m.receiver.masterDb, -30);
  assert.equal(m.receiver.monitorRefSpl, 92);
  assert.equal(m.speakers.length, 0);
  assert.equal(m.eq.graphic.gains.length, 31);
});
