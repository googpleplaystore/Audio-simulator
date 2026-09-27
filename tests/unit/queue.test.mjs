import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../../src/player/queue.js';

const ids = ['a', 'b', 'c', 'd', 'e'];

test('linear playback, end of queue', () => {
  const q = new Queue();
  assert.equal(q.setContext(ids, 1), 'b');
  assert.equal(q.next(), 'c');
  assert.equal(q.next(), 'd');
  assert.equal(q.next(), 'e');
  assert.equal(q.next(), null);
});

test('repeat all wraps and repeat one repeats on auto-advance only', () => {
  const q = new Queue();
  q.setContext(ids, 4);
  q.setRepeat('all');
  assert.equal(q.next(), 'a');
  q.setRepeat('one');
  assert.equal(q.next(true), 'a');
  assert.equal(q.next(false), 'b');
});

test('manual queue has priority and prev returns to context', () => {
  const q = new Queue();
  q.setContext(ids, 0);
  q.addToQueue(['x', 'y']);
  q.addNext(['z']);
  assert.equal(q.peekNext(), 'z');
  assert.equal(q.next(), 'z');
  assert.equal(q.next(), 'x');
  assert.equal(q.next(), 'y');
  assert.equal(q.next(), 'b');
  assert.equal(q.prev(), 'a');
});

test('shuffle keeps current first and contains all tracks; unshuffle restores order', () => {
  const q = new Queue();
  q.seed(42);
  q.shuffle = true;
  q.setContext(ids, 2);
  assert.equal(q.currentId, 'c');
  assert.deepEqual([...q.order].sort(), [...ids].sort());
  assert.equal(q.order[0], 'c');
  q.next();
  const cur = q.currentId;
  q.setShuffle(false);
  assert.deepEqual(q.order, ids);
  assert.equal(q.order[q.index], cur);
});

test('reordering upcoming items and transferring between sections', () => {
  const q = new Queue();
  q.setContext(ids, 0);
  q.move('context', 0, 2); // b moves after d
  assert.deepEqual(q.upcoming(), ['c', 'd', 'b', 'e']);
  q.transfer('context', 3, 'manual', 0); // e into manual
  assert.deepEqual(q.manual.map((m) => m.id), ['e']);
  assert.deepEqual(q.upcoming(), ['c', 'd', 'b']);
  q.transfer('manual', 0, 'context', 1);
  assert.deepEqual(q.upcoming(), ['c', 'e', 'd', 'b']);
  q.remove('context', 0);
  assert.deepEqual(q.upcoming(), ['e', 'd', 'b']);
  assert.equal(q.jumpTo('context', 1), 'd');
  assert.deepEqual(q.upcoming(), ['b']);
});

test('serialize/restore round trip and prune', () => {
  const q = new Queue();
  q.setContext(ids, 1, { type: 'album', id: 'x', name: 'X' });
  q.addToQueue(['e']);
  const s = JSON.parse(JSON.stringify(q.serialize()));
  const r = new Queue();
  r.restore(s);
  assert.equal(r.currentId, 'b');
  assert.equal(r.peekNext(), 'e');
  r.prune((id) => id !== 'c');
  assert.deepEqual(r.upcoming(), ['d', 'e']);
});
