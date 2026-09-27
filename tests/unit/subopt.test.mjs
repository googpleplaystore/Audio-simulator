import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeSubs, seatPositions, candidatePositions, TransferBank, scoreResponses, smoothestSeat } from '../../src/acoustics/subopt.js';
import { computeHeatmap } from '../../src/acoustics/compute.js';
import { octaveGrid } from '../../src/util/math.js';
import { defaultState } from '../../src/core/settings.js';

const s = defaultState();

test('seat layouts stay inside the room and include the main seat', () => {
  for (const layout of ['single', 'couch', 'rows']) {
    const seats = seatPositions(s.room, s.listener, layout);
    assert.ok(seats.some((x) => x.main));
    for (const p of seats) assert.ok(p.x > 0 && p.x < s.room.width && p.z > 0 && p.z < s.room.depth);
  }
  assert.equal(candidatePositions(s.room).length, 12);
});

test('a single seat has no seat-to-seat variation', () => {
  const seats = seatPositions(s.room, s.listener, 'single');
  const bank = new TransferBank(s.room, seats);
  const sc = scoreResponses(bank.responses([{ pos: { x: 0.3, y: 0.25, z: 0.3 }, gain: 1, delay: 0, polarity: 1 }]));
  assert.equal(sc.seatStd, 0);
  assert.ok(sc.flatness > 0);
});

test('optimiser beats the current layout on its own objective', () => {
  const r = optimizeSubs({ room: s.room, listener: s.listener, current: s.subs, layout: 'couch', count: 2 });
  assert.ok(r.best.objective <= r.before.objective + 1e-9);
  assert.ok(r.best.score.seatStd < r.before.score.seatStd, `${r.before.score.seatStd} -> ${r.best.score.seatStd}`);
  assert.equal(r.best.subs.length, 2);
  assert.equal(r.evaluated, 66 + 0); // 1 current sub < 2 requested: candidates only
  assert.ok(r.alternatives.every((a) => a.responses && a.objective >= r.best.objective));
  for (const sub of r.best.subs) assert.ok(sub.delayMs >= 0 && sub.trimDb <= 0 && (sub.polarity === 0 || sub.polarity === 180));
  assert.equal(r.refTrim, s.subs[0].trimDb);
});

test('calibrated sub level does not bias the comparison', () => {
  const at = (trimDb) => optimizeSubs({ room: s.room, listener: s.listener, current: [{ ...s.subs[0], trimDb }], layout: 'couch', count: 1 });
  const a = at(0);
  const b = at(8);
  assert.ok(Math.abs(a.before.score.level - b.before.score.level) < 1e-9);
  assert.equal(b.refTrim, 8);
});

test('two subs for a centred sofa end up mirror-symmetric (cancelling the first width mode)', () => {
  const r = optimizeSubs({ room: s.room, listener: { ...s.listener, x: s.room.width / 2 }, current: s.subs, layout: 'couch', count: 2 });
  const [a, b] = r.best.subs;
  assert.ok(Math.abs(a.x + b.x - s.room.width) < 0.05, `x ${a.x.toFixed(2)} + ${b.x.toFixed(2)} vs width ${s.room.width}`);
  assert.ok(Math.abs(a.z - b.z) < 0.05);
});

test('settings-only mode keeps positions and still never gets worse', () => {
  const current = [
    { x: 0.3, y: 0.25, z: 0.3, delayMs: 0, polarity: 0, trimDb: 0 },
    { x: s.room.width - 0.8, y: 0.25, z: s.room.depth - 0.3, delayMs: 7, polarity: 180, trimDb: 0 },
  ];
  const r = optimizeSubs({ room: s.room, listener: s.listener, current, layout: 'rows', movePositions: false });
  assert.equal(r.evaluated, 1);
  // With positions searched too, the current layout is one of the candidates.
  const r2 = optimizeSubs({ room: s.room, listener: s.listener, current, layout: 'rows', count: 2 });
  assert.equal(r2.evaluated, 67);
  assert.ok(r2.best.objective <= r2.before.objective + 1e-9);
  assert.deepEqual(r.best.subs.map((x) => [x.x, x.z]), current.map((x) => [x.x, x.z]));
  assert.ok(r.best.objective <= r.before.objective + 1e-9);
});

test('heat map reports unevenness and the smoothest seat lies in the listening area', () => {
  const freqs = [...octaveGrid(25, 120, 12)];
  const sub = s.subs[0];
  const hm = computeHeatmap({ room: s.room, cols: 40, rows: 32, height: 1.15, freqs, sources: [{ pos: { x: sub.x, y: sub.y, z: sub.z }, re: freqs.map(() => 1), im: freqs.map(() => 0) }] });
  assert.equal(hm.std.length, 40 * 32);
  assert.ok([...hm.std].every((v) => v >= 0 && Number.isFinite(v)));
  const spread = Math.max(...hm.std) - Math.min(...hm.std);
  assert.ok(spread > 1, `unevenness varies across the room (${spread.toFixed(2)} dB)`);
  const best = smoothestSeat(hm, s);
  assert.ok(best.x >= 0.6 && best.x <= s.room.width - 0.6);
  assert.ok(best.z >= Math.max(...s.speakers.map((x) => x.z)) + 1 - 1e-9 && best.z <= s.room.depth - 0.5);
  // It is at least as smooth as the current seat.
  const ci = Math.min(39, Math.floor((s.listener.x / s.room.width) * 40));
  const ri = Math.min(31, Math.floor((s.listener.z / s.room.depth) * 32));
  assert.ok(best.std <= hm.std[ri * 40 + ci] + 0.8);
});
