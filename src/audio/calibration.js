// Room Correction (auto-EQ) and Audyssey-style automatic speaker setup,
// computed against the virtual measurement microphone.

import { buildPlan } from './plan.js';
import { predictSystem, bandMeanDb } from './predict.js';
import { fitFilters, smoothVariable } from '../dsp/fit.js';
import { cascadeMagnitudeDb } from '../dsp/biquad.js';
import { targetCurve, suggestCrossover } from '../dsp/curves.js';
import { getHardware } from '../hardware/index.js';
import { octaveGrid, clamp } from '../util/math.js';

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** State with all user EQ disabled — what the room correction "measures". */
export function measurementState(state) {
  const s = clone(state);
  s.eq.graphic.enabled = false;
  s.eq.parametric.enabled = false;
  s.roomCorrection.enabled = false;
  s.receiver.pureDirect = true;
  s.receiver.loudness = false;
  return s;
}

export const MEASURE_FREQS = octaveGrid(20, 20000, 24);

/** Predicted, smoothed in-room response (dB, normalised to the 300 Hz–3 kHz mean). */
export function measure(state, { roomFilters = {}, sampleRate = 48000, userEq = false } = {}) {
  const s = userEq ? state : measurementState(state);
  const plan = buildPlan(s, { sampleRate, roomFilters });
  const raw = predictSystem(plan, MEASURE_FREQS, { room: s.room, includeMaster: false }).db;
  const sm = smoothVariable(MEASURE_FREQS, raw);
  const ref = bandMeanDb(MEASURE_FREQS, sm, 300, 3000);
  return { freqs: MEASURE_FREQS, raw: raw.map((v) => v - ref), smoothed: sm.map((v) => v - ref), plan };
}

/** Resample a swept measurement ({freqs, db}) onto MEASURE_FREQS, smoothed and normalised. */
function fromMeasured(measured) {
  const { freqs, db } = measured;
  const raw = new Float64Array(MEASURE_FREQS.length);
  let j = 0;
  for (let i = 0; i < MEASURE_FREQS.length; i++) {
    const f = MEASURE_FREQS[i];
    while (j < freqs.length - 2 && freqs[j + 1] < f) j++;
    const t = clamp(Math.log(f / freqs[j]) / Math.log(freqs[j + 1] / freqs[j]), 0, 1);
    raw[i] = db[j] * (1 - t) + db[j + 1] * t;
  }
  const sm = smoothVariable(MEASURE_FREQS, raw);
  const ref = bandMeanDb(MEASURE_FREQS, sm, 300, 3000);
  return { freqs: MEASURE_FREQS, raw: raw.map((v) => v - ref), smoothed: sm.map((v) => v - ref) };
}

/**
 * Compute room correction filters that pull the measured response toward the
 * selected target curve within [fMin, fMax].
 */
export function computeRoomCorrection(state, { roomFilters = {}, sampleRate = 48000, measured = null } = {}) {
  const rc = state.roomCorrection;
  const m = measured ? fromMeasured(measured) : measure(state, { roomFilters, sampleRate });
  const tgtFn = targetCurve(rc.target).fn;
  const freqs = m.freqs;
  const tgt = Array.from(freqs, (f) => tgtFn(f));
  const tRef = bandMeanDb(freqs, tgt, 300, 3000);
  const target = tgt.map((v) => v - tRef);
  const desired = new Float64Array(freqs.length);
  const weights = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    desired[i] = target[i] - m.smoothed[i];
    const f = freqs[i];
    // Taper outside the correction band; de-emphasise deep nulls (can't be boosted away).
    weights[i] = f >= rc.fMin && f <= rc.fMax ? 1 : 0;
    if (desired[i] > rc.maxBoost + 3) weights[i] *= 0.3;
  }
  const fit = fitFilters(freqs, desired, {
    sampleRate,
    maxFilters: 12,
    fMin: rc.fMin,
    fMax: rc.fMax,
    maxBoost: rc.maxBoost,
    maxCut: rc.maxCut,
    qMin: 0.6,
    qMax: 12,
    tolerance: 0.5,
    weights,
  });
  const filters = fit.filters.map((f) => ({ type: f.type, frequency: Math.round(f.frequency * 10) / 10, Q: Math.round(f.Q * 100) / 100, gain: Math.round(f.gain * 10) / 10 }));
  const corr = cascadeMagnitudeDb(filters, freqs, sampleRate);
  const after = m.smoothed.map((v, i) => v + corr[i]);
  const errBand = (curve) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= rc.fMin && freqs[i] <= rc.fMax) {
        s += (curve[i] - target[i]) ** 2;
        n++;
      }
    }
    return n ? Math.sqrt(s / n) : 0;
  };
  return { filters, freqs, before: m.smoothed, after, target, errorBefore: errBand(m.smoothed), errorAfter: errBand(after) };
}

/**
 * Automatic speaker setup: channel levels, crossover and distances.
 * Returns suggested changes (does not mutate state).
 */
export function autoSetup(state, { roomFilters = {}, sampleRate = 48000 } = {}) {
  const s = measurementState(state);
  const mains = s.speakers.filter((x) => !x.muted);
  const subs = s.subs.filter((x) => !x.muted);
  const report = [];
  // Crossover from the smallest main speaker's f3.
  let crossover = null;
  if (subs.length && mains.length) {
    const f3 = Math.max(...mains.map((m) => getHardware(m.modelId)?.f3 || 60));
    crossover = { frequency: suggestCrossover(f3), speakerMode: 'small', enabled: true, autoAlign: true };
    s.crossover = { ...s.crossover, ...crossover };
    report.push(`Crossover set to ${crossover.frequency} Hz (smallest speaker f3 ≈ ${Math.round(f3)} Hz).`);
  }
  const plan = buildPlan(s, { sampleRate, roomFilters });
  const freqs = octaveGrid(20, 20000, 12);
  const level = (id, f1, f2) => {
    const r = predictSystem(plan, freqs, { filter: (x) => x.id === id, includeReverb: true, room: s.room, includeMaster: false });
    return bandMeanDb(freqs, r.db, f1, f2);
  };
  const lv = {};
  for (const m of mains) lv[m.id] = level(m.id, 500, 2000);
  for (const sb of subs) lv[sb.id] = level(sb.id, 35, Math.min(80, (crossover?.frequency || s.crossover.frequency) * 0.8));
  const mainLevels = mains.map((m) => lv[m.id]).filter(Number.isFinite);
  const ref = mainLevels.length ? Math.min(...mainLevels) : Math.min(...Object.values(lv));
  const trims = {};
  for (const x of [...mains, ...subs]) {
    const cur = x.trimDb || 0;
    const next = clamp(Math.round((cur + (ref - lv[x.id])) * 2) / 2, -12, 12);
    trims[x.id] = next;
    report.push(`${x.kind === 'sub' ? 'Subwoofer' : `Speaker ${x.channel}`} trim ${next >= 0 ? '+' : ''}${next.toFixed(1)} dB`);
  }
  return { trims, crossover, report };
}
