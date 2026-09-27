// Room geometry and statistical acoustics (Eyring/Sabine reverberation,
// room constant, critical distance, Schroeder frequency, boundary gain).
//
// Coordinate system (metres): x = left→right (0..width), y = floor→ceiling
// (0..height), z = front wall→back wall (0..depth). Speakers usually sit near
// the front wall (z≈0.5–1) facing +z, towards the listener.

import { MATERIALS, BANDS, AIR_ABSORPTION, alphaAt } from './materials.js';
import { clamp, speedOfSound } from '../util/math.js';

export const SURFACES = ['front', 'back', 'left', 'right', 'floor', 'ceiling'];

export const ROOM_PRESETS = {
  bedroom: {
    name: 'Small Bedroom',
    width: 3.6,
    depth: 3.2,
    height: 2.5,
    materials: { front: 'drywall', back: 'drywall', left: 'glass', right: 'drywall', floor: 'carpet', ceiling: 'drywall' },
  },
  studio: {
    name: 'Treated Studio',
    width: 5.8,
    depth: 4.8,
    height: 3.0,
    materials: { front: 'drywall', back: 'bass-trap', left: 'foam', right: 'foam', floor: 'hardwood', ceiling: 'drywall' },
  },
  living: {
    name: 'Vaulted Ceiling Living Room',
    width: 7.5,
    depth: 5.8,
    height: 4.4,
    materials: { front: 'drywall', back: 'glass', left: 'drywall', right: 'curtains', floor: 'hardwood', ceiling: 'drywall' },
  },
  theater: {
    name: 'Dedicated Home Theater',
    width: 5.2,
    depth: 6.4,
    height: 2.8,
    materials: { front: 'curtains', back: 'bass-trap', left: 'foam', right: 'foam', floor: 'carpet', ceiling: 'foam' },
  },
  hall: {
    name: 'Concert Hall',
    width: 26,
    depth: 42,
    height: 16,
    materials: { front: 'wood-panel', back: 'wood-panel', left: 'plaster', right: 'plaster', floor: 'audience', ceiling: 'plaster' },
  },
  cathedral: {
    name: 'Stone Cathedral',
    width: 24,
    depth: 60,
    height: 28,
    materials: { front: 'brick', back: 'brick', left: 'plaster', right: 'plaster', floor: 'tile', ceiling: 'plaster' },
  },
  bathroom: {
    name: 'Tiled Bathroom',
    width: 2.6,
    depth: 2.2,
    height: 2.4,
    materials: { front: 'tile', back: 'tile', left: 'tile', right: 'glass', floor: 'tile', ceiling: 'plaster' },
  },
  garage: {
    name: 'Concrete Garage',
    width: 6,
    depth: 6.5,
    height: 2.7,
    materials: { front: 'concrete', back: 'concrete', left: 'brick', right: 'concrete', floor: 'concrete', ceiling: 'drywall' },
  },
  club: {
    name: 'Night Club',
    width: 16,
    depth: 22,
    height: 6,
    materials: { front: 'brick', back: 'curtains', left: 'wood-panel', right: 'brick', floor: 'concrete', ceiling: 'foam' },
  },
  office: {
    name: 'Home Office',
    width: 3.4,
    depth: 3.8,
    height: 2.6,
    materials: { front: 'bookshelf', back: 'drywall', left: 'glass', right: 'drywall', floor: 'hardwood', ceiling: 'drywall' },
  },
  anechoic: {
    name: 'Anechoic Chamber',
    width: 6,
    depth: 6,
    height: 5,
    materials: { front: 'bass-trap', back: 'bass-trap', left: 'bass-trap', right: 'bass-trap', floor: 'bass-trap', ceiling: 'bass-trap' },
  },
};

export function volume(room) {
  return room.width * room.depth * room.height;
}

export function surfaces(room) {
  const { width: W, depth: D, height: H, materials } = room;
  return [
    { id: 'front', area: W * H, material: materials.front },
    { id: 'back', area: W * H, material: materials.back },
    { id: 'left', area: D * H, material: materials.left },
    { id: 'right', area: D * H, material: materials.right },
    { id: 'floor', area: W * D, material: materials.floor },
    { id: 'ceiling', area: W * D, material: materials.ceiling },
  ];
}

export function totalSurface(room) {
  return 2 * (room.width * room.depth + room.width * room.height + room.depth * room.height);
}

/** Area-weighted mean absorption per octave band. */
export function meanAlpha(room) {
  const surf = surfaces(room);
  const S = totalSurface(room);
  return BANDS.map((_, b) => {
    let a = 0;
    for (const s of surf) a += s.area * (MATERIALS[s.material] || MATERIALS.drywall).alpha[b];
    return Math.min(a / S, 0.99);
  });
}

/** Eyring reverberation time (s) per octave band, including air absorption. */
export function rt60Bands(room) {
  const V = volume(room);
  const S = totalSurface(room);
  const alphas = meanAlpha(room);
  return alphas.map((a, b) => {
    const A = -S * Math.log(1 - a);
    return clamp((0.161 * V) / (A + 4 * AIR_ABSORPTION[b] * V), 0.05, 12);
  });
}

/** Sabine reverberation time per band (for comparison / display). */
export function sabineRt60Bands(room) {
  const V = volume(room);
  const S = totalSurface(room);
  return meanAlpha(room).map((a, b) => clamp((0.161 * V) / (S * a + 4 * AIR_ABSORPTION[b] * V), 0.05, 20));
}

/** Mid-frequency RT60 (average of 500 Hz and 1 kHz bands). */
export function rt60Mid(room) {
  const rt = rt60Bands(room);
  return (rt[3] + rt[4]) / 2;
}

/** RT60 at an arbitrary frequency (log interpolation between bands). */
export function rt60At(room, f, rt = rt60Bands(room)) {
  if (f <= BANDS[0]) return rt[0];
  if (f >= BANDS[BANDS.length - 1]) return rt[BANDS.length - 1];
  for (let i = 1; i < BANDS.length; i++) {
    if (f <= BANDS[i]) {
      const t = Math.log(f / BANDS[i - 1]) / Math.log(BANDS[i] / BANDS[i - 1]);
      return rt[i - 1] + (rt[i] - rt[i - 1]) * t;
    }
  }
  return rt[BANDS.length - 1];
}

/** Room constant R = S·ᾱ/(1−ᾱ) per band (m²). */
export function roomConstant(room) {
  const S = totalSurface(room);
  return meanAlpha(room).map((a) => (S * a) / (1 - a));
}

/** Critical distance (m) where direct and reverberant energy are equal. */
export function criticalDistance(room, directivityQ = 2, band = 4) {
  const R = roomConstant(room)[band];
  return Math.sqrt((directivityQ * R) / (16 * Math.PI));
}

/** Schroeder frequency: transition between modal and diffuse behaviour. */
export function schroederFrequency(room) {
  return 2000 * Math.sqrt(rt60Mid(room) / volume(room));
}

/**
 * Crossover frequency between the modal (low-frequency) model and the
 * statistical reverb model used by the engine.
 */
export function modalCrossover(room) {
  return clamp(1.5 * schroederFrequency(room), 60, 350);
}

export function roomSpeedOfSound(room) {
  return speedOfSound(room.temperature ?? 20);
}

/**
 * Enumerate room modes up to fMax. Returns [{nx,ny,nz,f,kind}] sorted by frequency.
 */
export function roomModes(room, fMax, limit = 4000) {
  const c = roomSpeedOfSound(room);
  const { width: Lx, height: Ly, depth: Lz } = room;
  const out = [];
  const nxMax = Math.floor((2 * fMax * Lx) / c);
  const nyMax = Math.floor((2 * fMax * Ly) / c);
  const nzMax = Math.floor((2 * fMax * Lz) / c);
  for (let nx = 0; nx <= nxMax; nx++) {
    for (let ny = 0; ny <= nyMax; ny++) {
      for (let nz = 0; nz <= nzMax; nz++) {
        const f = (c / 2) * Math.sqrt((nx / Lx) ** 2 + (ny / Ly) ** 2 + (nz / Lz) ** 2);
        if (f > fMax) continue;
        const nonzero = (nx > 0) + (ny > 0) + (nz > 0);
        const kind = nonzero === 0 ? 'pressure' : nonzero === 1 ? 'axial' : nonzero === 2 ? 'tangential' : 'oblique';
        out.push({ nx, ny, nz, f, kind });
      }
    }
  }
  out.sort((a, b) => a.f - b.f);
  return out.length > limit ? out.slice(0, limit) : out;
}

/** Axial modes only (display list). */
export function axialModes(room, fMax = 300) {
  return roomModes(room, fMax).filter((m) => m.kind === 'axial');
}

/** Distances from a point to each wall. */
export function wallDistances(room, p) {
  return {
    left: clamp(p.x, 0, room.width),
    right: clamp(room.width - p.x, 0, room.width),
    front: clamp(p.z, 0, room.depth),
    back: clamp(room.depth - p.z, 0, room.depth),
    floor: clamp(p.y ?? 0, 0, room.height),
    ceiling: clamp(room.height - (p.y ?? 0), 0, room.height),
  };
}

const proximity = (d) => 1 / (1 + (d / 0.35) ** 2);

/**
 * Simple boundary-gain model (used for display and when the full modal model is
 * disabled). Each nearby wall adds up to +3 dB of low-frequency reinforcement
 * (pressure doubling into a reduced solid angle); two adjacent walls add a
 * further corner-coupling bonus. A subwoofer jammed into a corner therefore
 * gains roughly +6…+9 dB depending on how reflective the walls are.
 * @returns {{gainDb:number, cornerFreq:number, walls:object}}
 */
export function boundaryGain(room, p) {
  const d = wallDistances(room, p);
  // Radiated power next to a boundary with pressure reflection coefficient β
  // scales by (1+β); normalise so a rigid wall (β=1) contributes a full 3 dB.
  const lf = (wall) => Math.log2(1 + Math.sqrt(Math.max(0, 1 - alphaAt(room.materials[wall], 63))));
  const w = {
    left: proximity(d.left) * lf('left'),
    right: proximity(d.right) * lf('right'),
    front: proximity(d.front) * lf('front'),
    back: proximity(d.back) * lf('back'),
  };
  let gain = 3 * (w.left + w.right + w.front + w.back);
  const corner = Math.max(w.left * w.front, w.left * w.back, w.right * w.front, w.right * w.back);
  gain += 3 * corner;
  const nearest = Math.min(d.left, d.right, d.front, d.back);
  const c = roomSpeedOfSound(room);
  const cornerFreq = clamp(c / (4 * Math.max(nearest, 0.05)), 60, 400);
  return { gainDb: gain, cornerFreq, walls: w, corner };
}

/** Deep clone a preset into a room state object. */
export function roomFromPreset(id) {
  const p = ROOM_PRESETS[id] || ROOM_PRESETS.studio;
  return {
    preset: id,
    width: p.width,
    depth: p.depth,
    height: p.height,
    materials: { ...p.materials },
    temperature: 20,
  };
}

/**
 * Suggested stereo layout for a room: equilateral triangle, speakers ~0.7 m
 * from the front wall, sub near the front-left corner.
 */
export function defaultLayout(room) {
  const W = room.width;
  const D = room.depth;
  const spacing = clamp(W * 0.45, 1.2, 3.2);
  const zSpk = clamp(D * 0.16, 0.45, 2.5);
  const zListener = clamp(zSpk + spacing * 0.866, zSpk + 0.8, D - 0.6);
  const xc = W / 2;
  return {
    left: { x: xc - spacing / 2, y: Math.min(1.0, room.height - 0.3), z: zSpk },
    right: { x: xc + spacing / 2, y: Math.min(1.0, room.height - 0.3), z: zSpk },
    sub: { x: clamp(xc - spacing / 2 - 0.9, 0.3, W - 0.3), y: 0.22, z: 0.35 },
    listener: { x: xc, y: Math.min(1.15, room.height - 0.2), z: zListener, yaw: 0 },
  };
}
