// Default application state and migration of persisted state.

import { roomFromPreset, defaultLayout } from '../acoustics/room.js';
import { DEFAULT_SPEAKER_ID, DEFAULT_SUB_ID } from '../hardware/index.js';
import { GEQ_FREQS } from '../dsp/curves.js';

export const STATE_VERSION = 2;
export const STORAGE_KEY = 'audiospace:state';

export function defaultPeqBands() {
  return [
    { id: 'p1', enabled: true, type: 'lowshelf', frequency: 60, Q: 0.71, gain: 0 },
    { id: 'p2', enabled: true, type: 'peaking', frequency: 160, Q: 1.2, gain: 0 },
    { id: 'p3', enabled: true, type: 'peaking', frequency: 600, Q: 1.0, gain: 0 },
    { id: 'p4', enabled: true, type: 'peaking', frequency: 2000, Q: 1.0, gain: 0 },
    { id: 'p5', enabled: true, type: 'peaking', frequency: 5500, Q: 1.2, gain: 0 },
    { id: 'p6', enabled: true, type: 'highshelf', frequency: 11000, Q: 0.71, gain: 0 },
  ];
}

export function makeSpeaker(id, channel, pos, modelId = DEFAULT_SPEAKER_ID) {
  return { id, kind: 'speaker', modelId, channel, x: pos.x, y: pos.y, z: pos.z, yaw: 180, aim: true, trimDb: 0, delayMs: 0, muted: false, solo: false };
}

export function makeSub(id, pos, modelId = DEFAULT_SUB_ID) {
  return { id, kind: 'sub', modelId, x: pos.x, y: pos.y, z: pos.z, yaw: 180, trimDb: 0, polarity: 0, phaseDeg: 0, delayMs: 0, muted: false, solo: false };
}

export function defaultState() {
  const room = roomFromPreset('studio');
  const lay = defaultLayout(room);
  return {
    version: STATE_VERSION,
    player: { volume: 0.8, muted: false, crossfade: 0, gapless: true, replayGain: 'track', replayGainPreampDb: 0, rate: 1 },
    engine: { simulation: true, output: 'headphones', quality: 'balanced', levelMatch: true, limiter: true, ceilingDb: -1, trimDb: 0 },
    receiver: {
      preset: 'denon-avr-s760h',
      wattsPerChannel: 75,
      ampClass: 'ab',
      masterDb: -12,
      inputGainDb: 0,
      bass: 0,
      treble: 0,
      pureDirect: true,
      loudness: false,
      loudnessRefDb: 0,
      monitorRefSpl: 92,
      thermal: true,
    },
    crossover: { enabled: true, frequency: 100, slope: 24, speakerMode: 'small', subPolarity: 0, autoAlign: true },
    eq: {
      graphic: { enabled: true, preset: 'flat', gains: GEQ_FREQS.map(() => 0) },
      parametric: { enabled: true, bands: defaultPeqBands() },
      preampDb: 0,
      autoHeadroom: true,
    },
    roomCorrection: { enabled: false, target: 'harman', maxBoost: 3, maxCut: 12, fMin: 20, fMax: 500, strength: 1, filters: [], measuredAt: null },
    room: {
      ...room,
      reverb: { enabled: true, wetDb: 0, erOrder: 3 },
      modes: true,
      boundary: true,
      airAbsorption: true,
      directivity: true,
      propagation: true,
    },
    listener: { ...lay.listener },
    speakers: [makeSpeaker('spk-l', 'L', lay.left), makeSpeaker('spk-r', 'R', lay.right)],
    subs: [{ ...makeSub('sub-1', lay.sub), trimDb: 4 }],
    haptics: { enabled: false, intensity: 1, threshold: 0.5, gamepad: true, visual: true },
    viz: { spectrumMode: 'bars', spectrogramRange: 90, vuReference: -18 },
    scenes: [],
    ui: { queueOpen: true, reduceMotion: false, heatmap: false, heatmapFreq: 'bass', showRays: true, snap: true, room3d: false },
  };
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge saved state over defaults so new settings get sensible values. */
export function mergeDefaults(defaults, saved) {
  if (!isPlainObject(saved)) return defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(saved)) {
    if (!(k in defaults)) continue;
    const d = defaults[k];
    if (isPlainObject(d) && isPlainObject(v)) out[k] = mergeDefaults(d, v);
    else if (Array.isArray(d)) out[k] = Array.isArray(v) ? v : d;
    else if (typeof d === typeof v || d === null) out[k] = v;
  }
  return out;
}

export function migrateState(saved) {
  const defaults = defaultState();
  if (!saved || typeof saved !== 'object') return defaults;
  const merged = mergeDefaults(defaults, saved);
  if (!Array.isArray(merged.eq.graphic.gains) || merged.eq.graphic.gains.length !== GEQ_FREQS.length) merged.eq.graphic.gains = GEQ_FREQS.map(() => 0);
  merged.speakers = (merged.speakers || []).filter((s) => s && s.id && Number.isFinite(s.x) && Number.isFinite(s.z));
  merged.subs = (merged.subs || []).filter((s) => s && s.id && Number.isFinite(s.x) && Number.isFinite(s.z));
  merged.version = STATE_VERSION;
  return merged;
}

/** Strip transient fields before persisting. */
export function persistFilter(state) {
  return state;
}
