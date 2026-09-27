// Physically-informed impulse response synthesis for a shoebox room.
//
// • Early reflections: image-source method (Allen & Berkley) up to a given
//   order, per-octave-band wall reflection coefficients √(1−α), 1/r spreading
//   and air absorption; each reflection is panned to the listener's ears by
//   its arrival direction (level + interaural time difference).
// • Late reverberation: decorrelated Gaussian noise per band with exponential
//   decay matching the Eyring RT60 of that band. The tail energy is calibrated
//   to the statistical reverberant-to-direct ratio 16π/R (R = room constant),
//   relative to the direct sound at 1 m, so the IR can be used un-normalised.
// • Output: 4-channel "true stereo" IR for ConvolverNode:
//   [L→L, L→R, R→L, R→R].

import { BANDS, MATERIALS, AIR_ABSORPTION } from './materials.js';
import { rt60Bands, roomConstant, roomSpeedOfSound, volume } from './room.js';
import { coefficients } from '../dsp/biquad.js';
import { mulberry32, qToDb, clamp } from '../util/math.js';

const EDGES = BANDS.slice(0, -1).map((f, i) => Math.sqrt(f * BANDS[i + 1])); // 88, 177, …, 5657

function bandFilters(b, sampleRate) {
  const specs = [];
  const q = qToDb(Math.SQRT1_2);
  const nyq = sampleRate / 2;
  if (b > 0) {
    specs.push({ type: 'highpass', frequency: EDGES[b - 1], Q: q }, { type: 'highpass', frequency: EDGES[b - 1], Q: q });
  }
  if (b < BANDS.length - 1 && EDGES[b] < nyq * 0.95) {
    specs.push({ type: 'lowpass', frequency: EDGES[b], Q: q }, { type: 'lowpass', frequency: EDGES[b], Q: q });
  }
  return specs.map((s) => coefficients(s, sampleRate));
}

/** Filter a buffer in place through a cascade of normalised biquads (TDF-II). */
export function processBiquads(buf, coeffList, length = buf.length) {
  for (const c of coeffList) {
    let z1 = 0;
    let z2 = 0;
    const { b0, b1, b2, a1, a2 } = c;
    for (let i = 0; i < length; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
  }
  return buf;
}

function reflectionCoeffs(room) {
  const walls = ['left', 'right', 'floor', 'ceiling', 'front', 'back'];
  const out = {};
  for (const w of walls) {
    const m = MATERIALS[room.materials[w]] || MATERIALS.drywall;
    out[w] = m.alpha.map((a) => Math.sqrt(Math.max(0, 1 - a)));
  }
  return out;
}

/** Enumerate image sources up to `order` reflections. */
export function imageSources(room, src, order) {
  const L = [room.width, room.height, room.depth];
  const s = [src.x, src.y ?? 1, src.z];
  const perAxis = [0, 1, 2].map((axis) => {
    const list = [];
    for (let l = -order; l <= order; l++) {
      for (let u = 0; u <= 1; u++) {
        const lo = Math.abs(l - u);
        const hi = Math.abs(l);
        if (lo + hi > order) continue;
        list.push({ pos: (1 - 2 * u) * s[axis] + 2 * l * L[axis], lo, hi });
      }
    }
    return list;
  });
  const out = [];
  for (const ix of perAxis[0]) {
    for (const iy of perAxis[1]) {
      const oxy = ix.lo + ix.hi + iy.lo + iy.hi;
      if (oxy > order) continue;
      for (const iz of perAxis[2]) {
        const total = oxy + iz.lo + iz.hi;
        if (total === 0 || total > order) continue;
        out.push({
          x: ix.pos,
          y: iy.pos,
          z: iz.pos,
          order: total,
          counts: { left: ix.lo, right: ix.hi, floor: iy.lo, ceiling: iy.hi, front: iz.lo, back: iz.hi },
        });
      }
    }
  }
  return out;
}

/** Equal-power ear gains + ITD for an arrival direction relative to the listener. */
function earPan(listener, p) {
  const yaw = ((listener.yaw ?? 0) * Math.PI) / 180;
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = Math.sin(yaw);
  const dx = p.x - listener.x;
  const dz = p.z - listener.z;
  const fwd = dx * fx + dz * fz;
  const right = dx * rx + dz * rz;
  const az = Math.atan2(right, fwd); // -π..π, + = right
  const lateral = Math.sin(az); // -1 (left) .. +1 (right)
  const theta = ((lateral + 1) * Math.PI) / 4;
  const back = fwd < 0 ? 0.85 : 1; // slight rear shadowing
  return {
    gl: Math.cos(theta) * back * Math.SQRT2 * 0.8 + 0.2,
    gr: Math.sin(theta) * back * Math.SQRT2 * 0.8 + 0.2,
    itd: 0.00066 * lateral, // positive → reaches right ear first
  };
}

function addImpulse(buf, t, amp, sampleRate) {
  const pos = t * sampleRate;
  const i = Math.floor(pos);
  const frac = pos - i;
  if (i >= 0 && i < buf.length) buf[i] += amp * (1 - frac);
  if (i + 1 >= 0 && i + 1 < buf.length) buf[i + 1] += amp * frac;
}

/**
 * Synthesize a true-stereo room impulse response.
 * @param {object} p
 * @param {object} p.room room state
 * @param {number} p.sampleRate
 * @param {{x,y,z}} p.srcL representative left-channel source position
 * @param {{x,y,z}} p.srcR representative right-channel source position
 * @param {{x,y,z,yaw}} p.listener
 * @param {number} [p.erOrder=3] image-source order
 * @param {number} [p.maxLength=6] seconds
 * @param {boolean} [p.includeDirect=false] include the direct path (for exporting a full IR)
 * @param {number} [p.seed=1]
 */
export function synthesizeIR(p) {
  const { room, sampleRate, listener, erOrder = 3, maxLength = 6, includeDirect = false, seed = 1 } = p;
  const srcL = p.srcL;
  const srcR = p.srcR || p.srcL;
  const c = roomSpeedOfSound(room);
  const rt = rt60Bands(room);
  const R = roomConstant(room);
  const V = volume(room);
  const nb = BANDS.length;
  const dL = Math.hypot(srcL.x - listener.x, (srcL.y ?? 1) - (listener.y ?? 1.2), srcL.z - listener.z);
  const dR = Math.hypot(srcR.x - listener.x, (srcR.y ?? 1) - (listener.y ?? 1.2), srcR.z - listener.z);
  const tDirect = Math.min(dL, dR) / c;
  const maxRt = Math.max(...rt);
  const lengthSec = Math.min(maxLength, tDirect + maxRt * 1.15 + 0.05);
  const N = Math.max(256, Math.ceil(lengthSec * sampleRate));
  const beta = reflectionCoeffs(room);
  const rand = mulberry32(seed);
  // Uniform white noise with unit variance; band filtering makes it Gaussian-like
  // (central limit) and it is ~20x cheaper than Box–Muller.
  const noise = () => (rand() * 2 - 1) * 1.7320508;
  const tailBuf = new Float64Array(N);

  // Early reflections per (source, band) into 4 ear channels.
  const channels = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const band = new Float64Array(N);
  const erEnergy = new Float64Array(nb * 4);
  const images = [
    { src: srcL, list: imageSources(room, srcL, erOrder), chans: [0, 1] },
    { src: srcR, list: imageSources(room, srcR, erOrder), chans: [2, 3] },
  ];
  const tMix = Math.max(0.012, Math.sqrt(V) / 1000);

  for (let b = 0; b < nb; b++) {
    const coeffs = bandFilters(b, sampleRate);
    // Effective length of this band (it decays at its own rate).
    const bandLen = Math.min(N, Math.ceil((tDirect + rt[b] * 1.15 + 0.05) * sampleRate));
    // Target reverberant energy relative to the direct sound at 1 m.
    const target = (16 * Math.PI) / Math.max(R[b], 1e-3);
    for (const group of images) {
      const [chL, chR] = group.chans;
      for (let ear = 0; ear < 2; ear++) {
        const ch = ear === 0 ? chL : chR;
        band.fill(0, 0, bandLen);
        let er = 0;
        let firstArrival = Infinity;
        if (includeDirect) {
          const s = group.src;
          const r = Math.max(0.1, Math.hypot(s.x - listener.x, (s.y ?? 1) - listener.y, s.z - listener.z));
          const pan = earPan(listener, s);
          const g = (ear === 0 ? pan.gl : pan.gr) / r;
          const t = r / c + (ear === 0 ? Math.max(0, pan.itd) : Math.max(0, -pan.itd));
          addImpulse(band, t, g, sampleRate);
        }
        for (const img of group.list) {
          const dx = img.x - listener.x;
          const dy = img.y - (listener.y ?? 1.2);
          const dz = img.z - listener.z;
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          let amp = 1 / Math.max(r, 0.1);
          for (const w in img.counts) {
            const k = img.counts[w];
            if (k) amp *= Math.pow(beta[w][b], k);
          }
          amp *= Math.exp((-AIR_ABSORPTION[b] * r) / 2);
          const pan = earPan(listener, img);
          const g = amp * (ear === 0 ? pan.gl : pan.gr);
          const t = r / c + (ear === 0 ? Math.max(0, pan.itd) : Math.max(0, -pan.itd));
          if (t * sampleRate >= bandLen - 2) continue;
          addImpulse(band, t, g, sampleRate);
          er += g * g;
          if (t < firstArrival) firstArrival = t;
        }
        erEnergy[b * 4 + ch] = er;
        // Late tail.
        const tOn = Math.min(Number.isFinite(firstArrival) ? firstArrival : tDirect, tDirect + 0.02);
        const decay = 6.907755 / rt[b];
        let envEnergy = 0;
        const start = Math.floor(tOn * sampleRate);
        for (let i = start; i < bandLen; i++) {
          const t = i / sampleRate - tOn;
          const fade = t < tMix ? Math.sin((Math.PI / 2) * (t / tMix)) ** 2 : 1;
          const env = fade * Math.exp(-decay * t);
          tailBuf[i] = env;
          envEnergy += env * env;
        }
        const tailTarget = Math.max(target - er, target * 0.25);
        const scale = envEnergy > 0 ? Math.sqrt(tailTarget / envEnergy) : 0;
        for (let i = start; i < bandLen; i++) band[i] += tailBuf[i] * scale * noise();
        processBiquads(band, coeffs, bandLen);
        const out = channels[ch];
        for (let i = 0; i < bandLen; i++) out[i] += band[i];
      }
    }
  }
  // Gentle fade-out of the last 30 ms to avoid truncation clicks.
  const fadeN = Math.min(N, Math.floor(0.03 * sampleRate));
  for (const ch of channels) {
    for (let i = 0; i < fadeN; i++) ch[N - 1 - i] *= i / fadeN;
  }
  return {
    channels,
    length: N,
    sampleRate,
    rt60: rt,
    tMix,
    erCount: images[0].list.length + images[1].list.length,
    energy: channels.map((ch) => {
      let e = 0;
      for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
      return e;
    }),
  };
}

/**
 * Energy decay curve (Schroeder backward integration) in dB for an IR channel.
 * Useful for verification/plots.
 */
export function energyDecayCurve(ir) {
  const n = ir.length;
  const out = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += ir[i] * ir[i];
    out[i] = acc;
  }
  const total = out[0] || 1;
  for (let i = 0; i < n; i++) out[i] = 10 * Math.log10(out[i] / total + 1e-30);
  return out;
}

/** Estimate RT60 from an EDC using a T20 fit (-5 to -25 dB). */
export function estimateRt60(edc, sampleRate) {
  let i5 = -1;
  let i25 = -1;
  for (let i = 0; i < edc.length; i++) {
    if (i5 < 0 && edc[i] <= -5) i5 = i;
    if (edc[i] <= -25) {
      i25 = i;
      break;
    }
  }
  if (i5 < 0 || i25 < 0) return NaN;
  return clamp(((i25 - i5) / sampleRate) * 3, 0, 60);
}

/** Band-limit a signal to one octave band (for analysis/testing). */
export function bandLimit(signal, bandIndex, sampleRate) {
  const buf = Float64Array.from(signal);
  return processBiquads(buf, bandFilters(bandIndex, sampleRate));
}
