import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roomFromPreset,
  rt60Bands,
  sabineRt60Bands,
  criticalDistance,
  schroederFrequency,
  boundaryGain,
  roomModes,
  defaultLayout,
  roomConstant,
  modalCrossover,
  ROOM_PRESETS,
} from '../../src/acoustics/room.js';
import { buildModalModel, modalTransfer, modalBoundaryGainDb, fitRoomFilters } from '../../src/acoustics/modes.js';
import { synthesizeIR, energyDecayCurve, estimateRt60, imageSources, bandLimit } from '../../src/acoustics/ir.js';
import { computeRoomFilters, computeHeatmap } from '../../src/acoustics/compute.js';
import { octaveGrid } from '../../src/util/math.js';

test('reverb times are ordered sensibly across presets', () => {
  const hall = rt60Bands(roomFromPreset('hall'))[4];
  const studio = rt60Bands(roomFromPreset('studio'))[4];
  const bathroom = rt60Bands(roomFromPreset('bathroom'))[4];
  const cathedral = rt60Bands(roomFromPreset('cathedral'))[4];
  assert.ok(studio < 0.4, `studio ${studio}`);
  assert.ok(hall > 1.2 && hall < 3.5, `hall ${hall}`);
  assert.ok(cathedral > hall, `cathedral ${cathedral}`);
  assert.ok(bathroom > studio, `bathroom ${bathroom}`);
});

test('Eyring is never longer than Sabine', () => {
  for (const id of Object.keys(ROOM_PRESETS)) {
    const e = rt60Bands(roomFromPreset(id));
    const s = sabineRt60Bands(roomFromPreset(id));
    e.forEach((v, i) => assert.ok(v <= s[i] + 1e-9, `${id} band ${i}`));
  }
});

test('heavy curtains damp high frequencies more than bare drywall', () => {
  const room = roomFromPreset('bedroom');
  const bare = { ...room, materials: { ...room.materials, front: 'drywall', back: 'drywall', left: 'drywall', right: 'drywall' } };
  const curt = { ...room, materials: { ...room.materials, front: 'curtains', back: 'curtains', left: 'curtains', right: 'curtains' } };
  assert.ok(rt60Bands(curt)[6] < rt60Bands(bare)[6] * 0.7);
});

test('critical distance and Schroeder frequency are plausible', () => {
  const room = roomFromPreset('living');
  const rc = criticalDistance(room);
  assert.ok(rc > 0.3 && rc < 3, `rc ${rc}`);
  const fs = schroederFrequency(room);
  assert.ok(fs > 60 && fs < 250, `fs ${fs}`);
  const x = modalCrossover(room);
  assert.ok(x >= 60 && x <= 350);
});

test('corner loading gives +6…+9 dB, mid-room ≈ 0 dB', () => {
  for (const id of ['bedroom', 'studio', 'living', 'garage']) {
    const room = roomFromPreset(id);
    const corner = boundaryGain(room, { x: 0.05, y: 0.2, z: 0.05 }).gainDb;
    assert.ok(corner >= 6 && corner <= 9.3, `${id} corner ${corner}`);
    const mid = boundaryGain(room, { x: room.width / 2, y: 0.2, z: room.depth / 2 }).gainDb;
    assert.ok(mid < 1, `${id} mid ${mid}`);
    const wall = boundaryGain(room, { x: room.width / 2, y: 0.2, z: 0.05 }).gainDb;
    assert.ok(wall > 2 && wall < 3.2, `${id} wall ${wall}`);
  }
});

test('room modes: first axial mode of a 5 m dimension is ~34 Hz', () => {
  const room = { ...roomFromPreset('studio'), width: 5, depth: 4, height: 3 };
  const modes = roomModes(room, 100);
  const ax = modes.find((m) => m.kind === 'axial' && m.nx === 1);
  assert.ok(Math.abs(ax.f - 34.3) < 0.3, String(ax.f));
});

test('modal model agrees with statistical theory: mean |H|² ≈ 16π/A', () => {
  const room = roomFromPreset('living');
  const model = buildModalModel(room, 400);
  const freqs = octaveGrid(150, 250, 48);
  let acc = 0;
  let cnt = 0;
  const pts = [
    [1.1, 0.9, 1.3, 5.2, 1.2, 4.1],
    [2.3, 0.5, 0.8, 4.4, 1.1, 3.3],
    [6.1, 1.4, 2.2, 1.9, 1.2, 4.9],
    [3.7, 0.3, 1.0, 6.5, 1.5, 2.4],
  ];
  for (const [sx, sy, sz, lx, ly, lz] of pts) {
    const { re, im } = modalTransfer(model, { x: sx, y: sy, z: sz }, { x: lx, y: ly, z: lz }, freqs);
    for (let i = 0; i < freqs.length; i++) {
      acc += re[i] * re[i] + im[i] * im[i];
      cnt++;
    }
  }
  const measured = acc / cnt;
  // Expected reverberant ratio near 200 Hz (band 2 = 250 Hz is closest).
  const R = roomConstant(room)[2];
  const expected = (16 * Math.PI) / R;
  const ratioDb = 10 * Math.log10(measured / expected);
  assert.ok(Math.abs(ratioDb) < 4, `modal vs statistical: ${ratioDb.toFixed(2)} dB`);
});

test('modal model predicts corner loading gain for a subwoofer', () => {
  const room = roomFromPreset('bedroom');
  const model = buildModalModel(room, 250);
  const ref = { x: room.width / 2, y: 0.25, z: room.depth / 2 };
  const corner = modalBoundaryGainDb(model, { x: 0.15, y: 0.25, z: 0.15 }, ref);
  assert.ok(corner > 4 && corner < 12, `corner ${corner}`);
});

test('room filter fit tracks the modal target', () => {
  const room = roomFromPreset('studio');
  const lay = defaultLayout(room);
  const model = buildModalModel(room, 500);
  const res = fitRoomFilters(model, lay.sub, lay.listener, { maxFilters: 10 });
  assert.ok(res.filters.length > 0);
  assert.ok(res.rmsErrorDb < 3.5, `rms ${res.rmsErrorDb}`);
});

test('computeRoomFilters returns per-source results', () => {
  const room = roomFromPreset('bedroom');
  const lay = defaultLayout(room);
  const out = computeRoomFilters({
    room,
    listener: lay.listener,
    sampleRate: 48000,
    sources: [
      { id: 'a', pos: lay.left },
      { id: 'b', pos: lay.sub },
    ],
  });
  assert.ok(out.results.a && out.results.b);
  assert.ok(out.modeCount > 20);
});

test('heatmap produces finite values', () => {
  const room = roomFromPreset('bedroom');
  const lay = defaultLayout(room);
  const freqs = [30, 45, 60, 80];
  const hm = computeHeatmap({
    room,
    cols: 16,
    rows: 12,
    height: 1.1,
    freqs,
    sources: [{ pos: lay.sub, freqs, re: freqs.map(() => 1), im: freqs.map(() => 0) }],
  });
  assert.equal(hm.data.length, 16 * 12);
  for (const v of hm.data) assert.ok(Number.isFinite(v));
});

test('image sources: first order has 6 images', () => {
  const room = roomFromPreset('studio');
  const imgs = imageSources(room, { x: 1, y: 1, z: 1 }, 1);
  assert.equal(imgs.length, 6);
  assert.equal(imageSources(room, { x: 1, y: 1, z: 1 }, 2).length, 6 + 18);
});

test('synthesized IR decays at the target RT60', () => {
  const room = roomFromPreset('living');
  const lay = defaultLayout(room);
  const sr = 16000;
  const ir = synthesizeIR({ room, sampleRate: sr, srcL: lay.left, srcR: lay.right, listener: lay.listener, erOrder: 2 });
  assert.equal(ir.channels.length, 4);
  const target = ir.rt60[4];
  const band = bandLimit(ir.channels[0], 4, sr);
  const est = estimateRt60(energyDecayCurve(band), sr);
  assert.ok(Math.abs(est - target) / target < 0.25, `est ${est} target ${target}`);
  for (const ch of ir.channels) for (let i = 0; i < ch.length; i += 97) assert.ok(Number.isFinite(ch[i]));
});

test('IR energy follows the room constant (bigger/deader rooms → less reverb)', () => {
  const lay = (r) => defaultLayout(r);
  const e = (id) => {
    const room = roomFromPreset(id);
    const l = lay(room);
    return synthesizeIR({ room, sampleRate: 8000, srcL: l.left, srcR: l.right, listener: l.listener, erOrder: 1 }).energy[0];
  };
  assert.ok(e('bathroom') > e('studio') * 3);
});
