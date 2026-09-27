import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScene, applyScene, stateWithScene, predictedLoudness, exampleScenes, binomialPValue, abxSequence, SCENE_KEYS } from '../../src/core/scenes.js';
import { defaultState } from '../../src/core/settings.js';
import { mulberry32 } from '../../src/util/math.js';

test('binomial p-values for ABX scores', () => {
  assert.equal(binomialPValue(0, 16), 1);
  assert.ok(Math.abs(binomialPValue(16, 16) - 1 / 65536) < 1e-12);
  assert.ok(Math.abs(binomialPValue(12, 16) - 0.0384) < 1e-4); // the classic 12/16 threshold
  assert.ok(binomialPValue(11, 16) > 0.05);
  assert.ok(Math.abs(binomialPValue(8, 16) - 0.5982) < 1e-4);
});

test('ABX sequences are balanced and shuffled', () => {
  const rnd = mulberry32(5);
  const seq = abxSequence(16, rnd);
  assert.equal(seq.length, 16);
  assert.equal(seq.filter((x) => x === 'A').length, 8);
  const seq2 = abxSequence(16, rnd);
  assert.notDeepEqual(seq, seq2);
});

test('scenes capture and restore the system settings only', () => {
  const s = defaultState();
  s.receiver.masterDb = -20;
  s.player.volume = 0.3;
  const sc = captureScene(s, 'Test');
  assert.deepEqual(Object.keys(sc.data).sort(), [...SCENE_KEYS].sort());
  assert.match(sc.summary, /KEF LS50 Meta \+ SVS SB-1000 Pro · Treated Studio/);
  // Mutating the source must not change the snapshot.
  s.receiver.masterDb = 0;
  assert.equal(sc.data.receiver.masterDb, -20);
  const set = new Map();
  applyScene({ set: (k, v) => set.set(k, v) }, sc);
  assert.equal(set.get('receiver').masterDb, -20);
  assert.ok(!set.has('player'));
  const merged = stateWithScene(s, sc);
  assert.equal(merged.receiver.masterDb, -20);
  assert.equal(merged.player.volume, 0.3);
});

test('predicted loudness follows the master volume (for level matching)', () => {
  const a = defaultState();
  const b = defaultState();
  b.receiver.masterDb = a.receiver.masterDb - 6;
  const d = predictedLoudness(a) - predictedLoudness(b);
  assert.ok(Math.abs(d - 6) < 0.3, `difference ${d}`);
});

test('example scenes are complete and distinct', () => {
  const ex = exampleScenes();
  assert.equal(ex.length, 3);
  for (const sc of ex) {
    for (const k of SCENE_KEYS) assert.ok(sc.data[k] !== undefined, `${sc.name} ${k}`);
    assert.ok(Number.isFinite(predictedLoudness(stateWithScene(defaultState(), sc))));
  }
  assert.equal(new Set(ex.map((x) => x.summary)).size, 3);
});
