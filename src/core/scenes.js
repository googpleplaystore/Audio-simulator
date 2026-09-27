// Scenes: named snapshots of the complete virtual system (receiver, crossover,
// EQ, room correction, room, listener, speakers, subwoofers) that can be
// recalled instantly — and compared blind with the ABX tester.

import { uid } from '../util/hash.js';
import { getHardware } from '../hardware/index.js';
import { ROOM_PRESETS, roomFromPreset, defaultLayout } from '../acoustics/room.js';
import { buildPlan } from '../audio/plan.js';
import { predictSystem, bandMeanDb } from '../audio/predict.js';
import { octaveGrid } from '../util/math.js';
import { defaultState, makeSpeaker, makeSub } from './settings.js';

export const SCENE_KEYS = ['receiver', 'crossover', 'eq', 'roomCorrection', 'room', 'listener', 'speakers', 'subs'];

const clone = (v) => JSON.parse(JSON.stringify(v));

export function sceneSummary(data) {
  const spk = data.speakers?.find((s) => !s.muted);
  const sub = data.subs?.find((s) => !s.muted);
  const parts = [];
  if (spk) parts.push(getHardware(spk.modelId)?.name || spk.modelId);
  if (sub) parts.push(`${data.subs.filter((s) => !s.muted).length > 1 ? `${data.subs.filter((s) => !s.muted).length}× ` : ''}${getHardware(sub.modelId)?.name || sub.modelId}`);
  const room = ROOM_PRESETS[data.room?.preset]?.name || 'Custom room';
  return `${parts.join(' + ') || 'No speakers'} · ${room}`;
}

export function captureScene(state, name) {
  const data = {};
  for (const k of SCENE_KEYS) data[k] = clone(state[k]);
  return { id: uid('scene'), name, createdAt: Date.now(), data, summary: sceneSummary(data) };
}

/** Apply a scene's system settings to the store (one batched update). */
export function applyScene(store, scene) {
  for (const k of SCENE_KEYS) if (scene.data[k] !== undefined) store.set(k, clone(scene.data[k]));
}

/** The state that results from applying `scene` on top of `state`. */
export function stateWithScene(state, scene) {
  const s = clone(state);
  for (const k of SCENE_KEYS) if (scene.data[k] !== undefined) s[k] = clone(scene.data[k]);
  return s;
}

/**
 * Predicted loudness at the seat (dB SPL averaged 200 Hz – 4 kHz), used to
 * level-match blind comparisons.
 */
export function predictedLoudness(state, sampleRate = 48000) {
  const freqs = octaveGrid(100, 8000, 6);
  const plan = buildPlan(state, { sampleRate });
  const r = predictSystem(plan, freqs, { room: state.room, includeMaster: true });
  return bandMeanDb(freqs, r.db, 200, 4000);
}

/** Example scenes spanning very different systems and rooms. */
export function exampleScenes() {
  const make = (name, preset, speakerId, subId, extra = {}) => {
    const base = defaultState();
    const room = { ...base.room, ...roomFromPreset(preset) };
    const lay = defaultLayout(room);
    const data = {
      ...Object.fromEntries(SCENE_KEYS.map((k) => [k, clone(base[k])])),
      room,
      listener: { ...lay.listener },
      speakers: [makeSpeaker('spk-l', 'L', lay.left, speakerId), makeSpeaker('spk-r', 'R', lay.right, speakerId)],
      subs: subId ? [{ ...makeSub('sub-1', lay.sub, subId), trimDb: 3 }] : [],
      ...extra,
    };
    if (!subId) data.crossover = { ...data.crossover, speakerMode: 'large' };
    return { id: uid('scene'), name, createdAt: Date.now(), data, summary: sceneSummary(data) };
  };
  return [
    make('Desk setup', 'bedroom', 'edifier-r1280dbs', null),
    make('Reference monitors', 'studio', 'kef-ls50-meta', 'svs-sb-1000-pro'),
    make('Living room hi-fi', 'living', 'klipsch-rp-600m-ii', 'klipsch-r-120sw'),
  ];
}

// ------------------------------------------------------------------ ABX

/** One-sided binomial p-value: P(X ≥ k) for n fair coin flips. */
export function binomialPValue(k, n) {
  if (n <= 0) return 1;
  let p = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, p / Math.pow(2, n));
}

/** Random, balanced assignment of X to A/B for n trials. */
export function abxSequence(n, rand = Math.random) {
  const seq = Array.from({ length: n }, (_, i) => (i < Math.ceil(n / 2) ? 'A' : 'B'));
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [seq[i], seq[j]] = [seq[j], seq[i]];
  }
  return seq;
}
