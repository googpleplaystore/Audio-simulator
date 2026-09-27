// Multi-subwoofer optimiser (in the spirit of Welti's work and MSO): choose
// subwoofer positions, delays, polarities and levels that minimise the
// seat-to-seat variation of the bass response, then its unevenness.
//
// Transfer functions come from the modal model, averaged over a head-sized
// region at each seat, exactly like the engine's room filters. When automatic
// time alignment is on, the engine delays every source by (d_max − d)/c, so the
// optimiser includes that distance-dependent delay too.

import { buildModalModel, modalTransfer, HEAD_OFFSETS } from './modes.js';
import { roomSpeedOfSound } from './room.js';
import { clamp, octaveGrid } from '../util/math.js';

export const SEAT_LAYOUTS = {
  single: { label: 'Main seat', offsets: [[0, 0]] },
  couch: { label: 'Sofa (3 seats)', offsets: [[-0.6, 0], [0, 0], [0.6, 0]] },
  rows: { label: 'Two rows (6 seats)', offsets: [[-0.6, 0], [0, 0], [0.6, 0], [-0.6, 0.9], [0, 0.9], [0.6, 0.9]] },
};

/** Seat positions around the main listener, kept inside the room. */
export function seatPositions(room, listener, layout = 'couch') {
  const offs = (SEAT_LAYOUTS[layout] || SEAT_LAYOUTS.couch).offsets;
  return offs.map(([dx, dz], i) => ({
    id: `seat-${i}`,
    main: dx === 0 && dz === 0,
    x: clamp(listener.x + dx, 0.3, room.width - 0.3),
    y: listener.y ?? 1.15,
    z: clamp(listener.z + dz, 0.3, room.depth - 0.3),
  }));
}

/** Candidate floor positions along the boundaries (corners, mid-walls, quarter points). */
export function candidatePositions(room, { inset = 0.3, height = 0.25 } = {}) {
  const W = room.width;
  const D = room.depth;
  const a = inset;
  const pts = [
    ['Front-left corner', a, a],
    ['Front-right corner', W - a, a],
    ['Back-left corner', a, D - a],
    ['Back-right corner', W - a, D - a],
    ['Front wall centre', W / 2, a],
    ['Back wall centre', W / 2, D - a],
    ['Left wall centre', a, D / 2],
    ['Right wall centre', W - a, D / 2],
    ['Front wall ¼', W / 4, a],
    ['Front wall ¾', (3 * W) / 4, a],
    ['Back wall ¼', W / 4, D - a],
    ['Back wall ¾', (3 * W) / 4, D - a],
  ];
  return pts.map(([label, x, z], i) => ({ id: `c${i}`, label, x, y: height, z }));
}

function combinations(n, k, limit = 600) {
  const out = [];
  const idx = Array.from({ length: k }, (_, i) => i);
  while (out.length < limit) {
    out.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/**
 * Pre-computed transfer bank: for every source position, seat and head
 * offset, the complex modal response over freqs.
 */
export class TransferBank {
  constructor(room, seats, { fMin = 20, fMax = 120, pointsPerOctave = 12 } = {}) {
    this.room = room;
    this.seats = seats;
    this.freqs = octaveGrid(fMin, fMax, pointsPerOctave);
    this.model = buildModalModel(room, Math.max(300, fMax * 2.5));
    this.c = roomSpeedOfSound(room);
    this.nO = HEAD_OFFSETS.length;
    this.cache = new Map();
  }

  /** Float64Array [seat][offset][freq] × (re, im) interleaved. */
  transfer(pos) {
    const key = `${pos.x.toFixed(3)},${(pos.y ?? 0).toFixed(3)},${pos.z.toFixed(3)}`;
    let t = this.cache.get(key);
    if (t) return t;
    const nF = this.freqs.length;
    t = new Float64Array(this.seats.length * this.nO * nF * 2);
    this.seats.forEach((s, si) => {
      HEAD_OFFSETS.forEach(([ox, oy, oz], oi) => {
        const p = { x: s.x + ox, y: s.y + oy, z: s.z + oz };
        const { re, im } = modalTransfer(this.model, pos, p, this.freqs);
        const base = (si * this.nO + oi) * nF * 2;
        for (let f = 0; f < nF; f++) {
          t[base + 2 * f] = re[f];
          t[base + 2 * f + 1] = im[f];
        }
      });
    });
    this.cache.set(key, t);
    return t;
  }

  /**
   * Seat responses (dB, power-averaged over the head region) for a set of subs
   * {pos, gain (linear), delay (s), polarity (±1)}. Returns Float64Array[seat].
   */
  responses(subs) {
    const nF = this.freqs.length;
    const nS = this.seats.length;
    const tr = subs.map((s) => this.transfer(s.pos));
    // Per-sub complex weights per frequency.
    const wr = subs.map(() => new Float64Array(nF));
    const wi = subs.map(() => new Float64Array(nF));
    subs.forEach((s, k) => {
      for (let f = 0; f < nF; f++) {
        const ph = -2 * Math.PI * this.freqs[f] * s.delay;
        const g = s.gain * s.polarity;
        wr[k][f] = g * Math.cos(ph);
        wi[k][f] = g * Math.sin(ph);
      }
    });
    const out = [];
    for (let si = 0; si < nS; si++) {
      const db = new Float64Array(nF);
      for (let f = 0; f < nF; f++) {
        let pw = 0;
        for (let oi = 0; oi < this.nO; oi++) {
          const idx = ((si * this.nO + oi) * nF + f) * 2;
          let re = 0;
          let im = 0;
          for (let k = 0; k < subs.length; k++) {
            const a = tr[k][idx];
            const b = tr[k][idx + 1];
            re += a * wr[k][f] - b * wi[k][f];
            im += a * wi[k][f] + b * wr[k][f];
          }
          pw += re * re + im * im;
        }
        db[f] = 10 * Math.log10(pw / this.nO + 1e-30);
      }
      out.push(db);
    }
    return out;
  }
}

/**
 * Score a set of seat responses.
 * seatStd: mean over frequency of the std-dev across seats (dB) — what EQ can't fix;
 * flatness: std-dev over frequency of the seat-averaged response (dB);
 * level: mean seat level (dB).
 */
export function scoreResponses(resp) {
  const nS = resp.length;
  const nF = resp[0].length;
  let seatStd = 0;
  const mean = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    let m = 0;
    for (let s = 0; s < nS; s++) m += resp[s][f];
    m /= nS;
    mean[f] = m;
    let v = 0;
    for (let s = 0; s < nS; s++) v += (resp[s][f] - m) ** 2;
    seatStd += Math.sqrt(v / nS);
  }
  seatStd /= nF;
  let lm = 0;
  for (let f = 0; f < nF; f++) lm += mean[f];
  lm /= nF;
  let fl = 0;
  for (let f = 0; f < nF; f++) fl += (mean[f] - lm) ** 2;
  return { seatStd, flatness: Math.sqrt(fl / nF), level: lm, mean };
}

function objective(sc, refLevel) {
  // Cancellation that costs output is penalised beyond 3 dB.
  const loss = Math.max(0, refLevel - sc.level - 3);
  return sc.seatStd + 0.5 * sc.flatness + 0.35 * loss;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);
}

/**
 * @param {object} o
 * @param {object} o.room
 * @param {object} o.listener main listening position
 * @param {Array<{x,y,z,delayMs,polarity,trimDb}>} o.current current subwoofers
 * @returns result; apply a sub's trim as `refTrim + sub.trimDb`
 * @param {string} [o.layout='couch']
 * @param {number} [o.count] number of subs (default: current count)
 * @param {boolean} [o.movePositions=true] search positions (else settings only)
 * @param {boolean} [o.autoAlign=true] engine time-aligns sources by distance
 * @param {number} [o.fMax=120]
 */
export function optimizeSubs(o) {
  const { room, listener, layout = 'couch', movePositions = true, autoAlign = true, fMax = 120 } = o;
  // Levels are relative to the user's calibrated subwoofer level (the
  // loudest current trim); results carry offsets ≤ 0 dB from it.
  const refTrim = o.current?.length ? Math.max(...o.current.map((x) => x.trimDb || 0)) : 0;
  const current = (o.current || []).map((x) => ({ ...x, trimDb: (x.trimDb || 0) - refTrim }));
  const count = clamp(Math.round(o.count ?? Math.max(1, current.length)), 1, 4);
  const seats = seatPositions(room, listener, layout);
  const bank = new TransferBank(room, seats, { fMax });
  const c = bank.c;
  const alignOf = (pos) => (autoAlign ? -distance(pos, listener) / c : 0);
  const toSub = (pos, s) => ({ pos, gain: Math.pow(10, (s.trimDb || 0) / 20), delay: (s.delayMs || 0) / 1000 + alignOf(pos), polarity: s.polarity === 180 ? -1 : 1 });

  // Baseline: the current configuration.
  const before = current.length ? scoreResponses(bank.responses(current.map((s) => toSub({ x: s.x, y: s.y ?? 0.25, z: s.z }, s)))) : null;
  const beforeResp = current.length ? bank.responses(current.map((s) => toSub({ x: s.x, y: s.y ?? 0.25, z: s.z }, s))) : null;

  // Reference level: one sub in the best-loaded corner.
  const cands = candidatePositions(room);
  const refLevel = Math.max(...cands.slice(0, 4).map((p) => scoreResponses(bank.responses([toSub(p, {})])).level));

  // Search sets: {positions, init}. The current layout (with its current
  // settings as the starting point) is always included, so the result is
  // never worse than what the user has now.
  const zero = () => ({ delayMs: 0, polarity: 0, trimDb: 0 });
  const sets = [];
  if (current.length >= count) {
    const cur = current.slice(0, count);
    sets.push({
      positions: cur.map((s, i) => ({ id: `cur${i}`, label: `Sub ${i + 1} (current)`, x: s.x, y: s.y ?? 0.25, z: s.z })),
      init: cur.map((s) => ({ delayMs: clamp(Math.round(s.delayMs || 0), -10, 10), polarity: s.polarity === 180 ? 180 : 0, trimDb: clamp(s.trimDb || 0, -6, 0) })),
    });
  }
  if (movePositions || !sets.length) {
    for (const ix of combinations(cands.length, count)) sets.push({ positions: ix.map((i) => cands[i]), init: ix.map(zero) });
  }

  const DELAYS = [];
  for (let d = -10; d <= 10; d += 1) DELAYS.push(d);
  const GAINS = [0, -1.5, -3, -4.5, -6];

  const evaluate = (positions, settings) => {
    const subs = positions.map((p, k) => toSub(p, settings[k]));
    const sc = scoreResponses(bank.responses(subs));
    return { sc, obj: objective(sc, refLevel) };
  };

  const results = [];
  for (const { positions, init } of sets) {
    const settings = init.map((x) => ({ ...x }));
    let best = evaluate(positions, settings);
    if (count > 1) {
      for (let pass = 0; pass < 2; pass++) {
        const startObj = best.obj;
        for (let k = 1; k < count; k++) {
          for (const d of DELAYS) {
            const trial = settings.map((s, j) => (j === k ? { ...s, delayMs: d } : s));
            const r = evaluate(positions, trial);
            if (r.obj < best.obj - 1e-9) {
              best = r;
              settings[k] = trial[k];
            }
          }
          const flip = settings.map((s, j) => (j === k ? { ...s, polarity: s.polarity ? 0 : 180 } : s));
          const rf = evaluate(positions, flip);
          if (rf.obj < best.obj - 1e-9) {
            best = rf;
            settings[k] = flip[k];
          }
        }
        for (let k = 0; k < count; k++) {
          for (const g of GAINS) {
            const trial = settings.map((s, j) => (j === k ? { ...s, trimDb: g } : s));
            const r = evaluate(positions, trial);
            if (r.obj < best.obj - 1e-9) {
              best = r;
              settings[k] = trial[k];
            }
          }
        }
        if (best.obj > startObj - 0.01) break; // converged
      }
    }
    // Normalise delays so the smallest is 0 ms (only relative delay matters).
    const minD = Math.min(...settings.map((s) => s.delayMs));
    results.push({
      subs: positions.map((p, k) => ({ ...p, delayMs: settings[k].delayMs - minD, polarity: settings[k].polarity, trimDb: settings[k].trimDb })),
      score: best.sc,
      objective: best.obj,
    });
  }
  results.sort((a, b) => a.objective - b.objective);
  const top = results.slice(0, 5).map((r) => ({ ...r, responses: bank.responses(r.subs.map((s) => toSub(s, s))) }));
  return {
    freqs: bank.freqs,
    seats,
    candidates: cands,
    before: before ? { score: before, objective: objective(before, refLevel), responses: beforeResp } : null,
    best: top[0],
    alternatives: top.slice(1),
    evaluated: results.length,
    refTrim,
  };
}

/**
 * The smoothest bass spot of a heat map (with a per-point `std`) inside the
 * listening area — in front of the speakers and away from the walls —
 * gently preferring the centre line and the current seat.
 * @param {{cols:number, rows:number, std:ArrayLike<number>}} hm
 * @param {{room, speakers, listener}} s
 */
export function smoothestSeat(hm, s) {
  const { width: W, depth: D } = s.room;
  const zMin = Math.max(0.8, ...s.speakers.map((x) => x.z + 1.0));
  let best = null;
  for (let r = 0; r < hm.rows; r++) {
    const z = ((r + 0.5) / hm.rows) * D;
    if (z < zMin || z > D - 0.5) continue;
    for (let c = 0; c < hm.cols; c++) {
      const x = ((c + 0.5) / hm.cols) * W;
      if (x < 0.6 || x > W - 0.6) continue;
      const std = hm.std[r * hm.cols + c];
      const score = std + 0.4 * Math.abs(x - W / 2) + 0.15 * Math.abs(z - s.listener.z);
      if (!best || score < best.score) best = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, std, score };
    }
  }
  return best;
}
