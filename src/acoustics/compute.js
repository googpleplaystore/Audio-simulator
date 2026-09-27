// Pure job implementations shared by the acoustics worker and the main-thread
// fallback (and offline rendering).

import { buildModalModel, fitRoomFilters, bassHeatmap, modalBoundaryGainDb } from './modes.js';
import { synthesizeIR } from './ir.js';
import { modalCrossover } from './room.js';

const modelCache = new Map();

function roomKey(room, fMax) {
  return JSON.stringify([room.width, room.depth, room.height, room.materials, room.temperature ?? 20, Math.round(fMax)]);
}

export function getModel(room, fMax) {
  const key = roomKey(room, fMax);
  let m = modelCache.get(key);
  if (!m) {
    m = buildModalModel(room, fMax);
    if (modelCache.size > 6) modelCache.delete(modelCache.keys().next().value);
    modelCache.set(key, m);
  }
  return m;
}

/**
 * Fit per-source room filters.
 * @param {{room, listener, sources:[{id,pos}], sampleRate, maxFilters}} job
 */
export function computeRoomFilters(job) {
  const crossover = modalCrossover(job.room);
  const fMax = Math.min(crossover * 1.8, 600) * 1.5;
  const model = getModel(job.room, fMax);
  const floorCentre = { x: job.room.width / 2, y: 0.25, z: job.room.depth / 2 };
  const results = {};
  for (const s of job.sources) {
    const fit = fitRoomFilters(model, s.pos, job.listener, {
      crossover,
      sampleRate: job.sampleRate,
      maxFilters: job.maxFilters ?? 10,
    });
    const boundary = modalBoundaryGainDb(model, s.pos, { ...floorCentre, y: s.pos.y ?? 0.25 });
    results[s.id] = {
      filters: fit.filters,
      rmsErrorDb: fit.rmsErrorDb,
      freqs: Array.from(fit.freqs),
      target: Array.from(fit.target),
      boundaryDb: boundary,
    };
  }
  return { crossover, modeCount: model.n, results };
}

/**
 * @param {{room, sources:[{pos, freqs:number[], re:number[], im:number[]}], cols, rows, height, freqs}} job
 */
export function computeHeatmap(job) {
  const crossover = modalCrossover(job.room);
  const fTop = Math.max(...job.freqs);
  const model = getModel(job.room, Math.max(fTop * 1.6, crossover));
  const sources = job.sources.map((s) => ({
    pos: s.pos,
    gain: (f) => {
      const i = job.freqs.indexOf(f);
      return i >= 0 ? [s.re[i], s.im[i]] : [1, 0];
    },
  }));
  return bassHeatmap(model, sources, { cols: job.cols, rows: job.rows, height: job.height, freqs: job.freqs });
}

export function computeIR(job) {
  return synthesizeIR(job);
}
