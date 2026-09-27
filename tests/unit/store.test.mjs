import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.js';
import { defaultState, migrateState } from '../../src/core/settings.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('subscribers are batched per microtask and filtered by path', async () => {
  const s = new Store({ a: { b: 1, c: 2 }, d: 3 });
  const calls = { ab: 0, d: 0, all: 0 };
  s.subscribe(['a.b'], () => calls.ab++);
  s.subscribe(['d'], () => calls.d++);
  s.subscribe(null, () => calls.all++);
  s.set('a.b', 5);
  s.set('a.b', 6);
  s.patch('a', { c: 9 });
  await tick();
  assert.deepEqual(calls, { ab: 1, d: 0, all: 1 });
  s.set('a', { b: 1, c: 1 }); // parent change notifies children
  await tick();
  assert.equal(calls.ab, 2);
});

test('a failing subscriber does not stop the others', async () => {
  const s = new Store({ x: 1 });
  let ok = 0;
  const err = console.error;
  console.error = () => {};
  s.subscribe(null, () => {
    throw new Error('boom');
  });
  s.subscribe(['x'], () => ok++);
  s.set('x', 2);
  await tick();
  console.error = err;
  assert.equal(ok, 1);
});

test('persistence saves state and reports quota errors once', async () => {
  const mem = new Map();
  let full = false;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (full) throw new Error('QuotaExceededError');
      mem.set(k, v);
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = new Store(defaultState(), { persistKey: 'test' });
    s.set('receiver.masterDb', -7);
    s.save();
    const loaded = migrateState(Store.load('test'));
    assert.equal(loaded.receiver.masterDb, -7);
    assert.deepEqual(loaded.scenes, []);
    let errors = 0;
    s.on('save-error', () => errors++);
    full = true;
    s.save();
    s.save();
    assert.equal(errors, 1);
    full = false;
    s.save();
    full = true;
    s.save();
    assert.equal(errors, 2);
  } finally {
    console.warn = warn;
    delete globalThis.localStorage;
  }
});

test('old saved state gains new settings on migration', () => {
  const old = defaultState();
  delete old.engine.limiter;
  delete old.engine.ceilingDb;
  delete old.engine.trimDb;
  delete old.scenes;
  const m = migrateState(JSON.parse(JSON.stringify(old)));
  assert.equal(m.engine.limiter, true);
  assert.equal(m.engine.ceilingDb, -1);
  assert.equal(m.engine.trimDb, 0);
  assert.deepEqual(m.scenes, []);
});
