// Builds the normalised hardware catalogue: seeds are completed with derived
// fields, roster entries are extrapolated from first principles, and the
// result is exactly 100 entries per category.

import { BOOKSHELF_SEEDS, BOOKSHELF_ROSTER } from './bookshelf.js';
import { SUB_SEEDS, SUB_ROSTER } from './subwoofers.js';
import {
  SPEAKER_HOUSE_SOUND,
  SUB_HOUSE_SOUND,
  DEFAULT_SPEAKER_VOICING,
  DEFAULT_SUB_VOICING,
  DIRECTIVITY_DB,
  DIRECTIVITY_Q,
} from './voicing.js';
import { mulberry32, clamp } from '../util/math.js';
import { seedFrom } from '../util/hash.js';

export const CATEGORY_SIZE = 100;

export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/["″]/g, 'in')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const round = (v, step = 1) => Math.round(v / step) * step;

export const BRAND_STYLE = {
  Klipsch: { cabinet: '#1b1b1d', baffle: '#101012', woofer: '#b8733a', tweeter: '#2a2a2e', accent: '#c8894a' },
  KEF: { cabinet: '#d9d7d2', baffle: '#cfcac1', woofer: '#9aa1a8', tweeter: '#c9a55b', accent: '#e0c27a' },
  'Bowers & Wilkins': { cabinet: '#f1f0ec', baffle: '#e8e6e1', woofer: '#bfc3c7', tweeter: '#9aa0a6', accent: '#d7d9db' },
  'Polk Audio': { cabinet: '#1c1c1f', baffle: '#141416', woofer: '#2d2d31', tweeter: '#3a3a3f', accent: '#b5b5b5' },
  Sony: { cabinet: '#18181a', baffle: '#121213', woofer: '#6d6a60', tweeter: '#2c2c2f', accent: '#9f9f9f' },
  Edifier: { cabinet: '#6e4b2e', baffle: '#1b1b1d', woofer: '#2a2a2c', tweeter: '#303034', accent: '#b0843f' },
  Audioengine: { cabinet: '#e9e7e2', baffle: '#e2dfd8', woofer: '#e8c451', tweeter: '#e9e9e9', accent: '#e8c451' },
  ELAC: { cabinet: '#1f1f22', baffle: '#1a1a1c', woofer: '#3f4a3a', tweeter: '#2d2d30', accent: '#a0a0a0' },
  'Q Acoustics': { cabinet: '#2b2b2e', baffle: '#232326', woofer: '#e8e8e8', tweeter: '#3c3c40', accent: '#d6d6d6' },
  Dali: { cabinet: '#5b3a22', baffle: '#1c1c1c', woofer: '#8a5d34', tweeter: '#2a2a2a', accent: '#b98a55' },
  'Monitor Audio': { cabinet: '#3c2a1f', baffle: '#1a1a1a', woofer: '#c7c9cc', tweeter: '#d4af37', accent: '#d4af37' },
  Micca: { cabinet: '#1d1d1f', baffle: '#1d1d1f', woofer: '#343438', tweeter: '#2d2d30', accent: '#8a8a8a' },
  Vanatoo: { cabinet: '#eeeeea', baffle: '#e5e5e0', woofer: '#b9bdc1', tweeter: '#2c2c2e', accent: '#7fb3d5' },
  Sonos: { cabinet: '#f4f4f2', baffle: '#ecece9', woofer: '#dadad6', tweeter: '#dadad6', accent: '#1f1f1f' },
  PreSonus: { cabinet: '#1c1c1e', baffle: '#141416', woofer: '#2e3a4a', tweeter: '#333', accent: '#5aa0ff' },
  KRK: { cabinet: '#141414', baffle: '#141414', woofer: '#f2c200', tweeter: '#f2c200', accent: '#f2c200' },
  JBL: { cabinet: '#18181a', baffle: '#121213', woofer: '#2b2b2f', tweeter: '#2b2b2f', accent: '#ff6a00' },
  Yamaha: { cabinet: '#f2f2f0', baffle: '#ececea', woofer: '#f4f4f4', tweeter: '#e0e0e0', accent: '#555' },
  'Adam Audio': { cabinet: '#1a1a1c', baffle: '#1a1a1c', woofer: '#2a2a2d', tweeter: '#6b6b6b', accent: '#bdbdbd' },
  Neumann: { cabinet: '#2e3033', baffle: '#2a2c2f', woofer: '#3b3d41', tweeter: '#44474b', accent: '#c7c7c7' },
  Genelec: { cabinet: '#c9ccce', baffle: '#c1c4c6', woofer: '#2c2c2e', tweeter: '#2c2c2e', accent: '#e0e0e0' },
  Mackie: { cabinet: '#1c1c1e', baffle: '#1c1c1e', woofer: '#2a2a2d', tweeter: '#2a2a2d', accent: '#28c76f' },
  Fluance: { cabinet: '#2c1d14', baffle: '#1a1a1a', woofer: '#2f2f33', tweeter: '#3a3a3a', accent: '#b08a5a' },
  Kanto: { cabinet: '#233a2d', baffle: '#1f1f21', woofer: '#2d2d30', tweeter: '#2d2d30', accent: '#d8c9a8' },
  Wharfedale: { cabinet: '#4a2d1c', baffle: '#1c1c1c', woofer: '#9b9b9b', tweeter: '#2a2a2a', accent: '#c19a6b' },
  Bose: { cabinet: '#1d1d1f', baffle: '#1d1d1f', woofer: '#2c2c2f', tweeter: '#2c2c2f', accent: '#888' },
  'Dayton Audio': { cabinet: '#1c1c1e', baffle: '#1c1c1e', woofer: '#303034', tweeter: '#5b5b5b', accent: '#d33' },
  SVS: { cabinet: '#1a1a1c', baffle: '#141416', woofer: '#2d2d31', tweeter: '#3a3a3f', accent: '#9aa0a6' },
  Pyle: { cabinet: '#1b1b1b', baffle: '#1b1b1b', woofer: '#333', tweeter: '#444', accent: '#e33' },
};
export const DEFAULT_STYLE = { cabinet: '#1c1c1f', baffle: '#151517', woofer: '#2e2e33', tweeter: '#3a3a40', accent: '#999' };

const WOOFER_MATERIAL = {
  Klipsch: 'Copper-spun / Cerametallic',
  KEF: 'Aluminium (Uni-Q)',
  'Bowers & Wilkins': 'Continuum / paper',
  'Polk Audio': 'Mica-reinforced polypropylene',
  Sony: 'Mica-reinforced cellular',
  Edifier: 'Paper composite',
  Audioengine: 'Kevlar',
  ELAC: 'Aramid fibre',
  'Q Acoustics': 'Aramid fibre',
  Dali: 'Wood fibre',
  'Monitor Audio': 'C-CAM',
  Wharfedale: 'Klarity woven polypropylene',
  Fluance: 'Polypropylene',
  KRK: 'Glass-aramid composite',
  JBL: 'Polypropylene',
  Yamaha: 'Polypropylene',
  'Adam Audio': 'Polypropylene',
  Kanto: 'Aramid fibre',
  Mackie: 'Polypropylene',
  PreSonus: 'Woven composite',
  'Dayton Audio': 'Polypropylene',
  SVS: 'Glass fibre',
  Micca: 'Carbon fibre',
};

const IMPEDANCE_6 = new Set(['ELAC', 'Q Acoustics', 'Dali', 'Sony', 'Triangle']);

export function priceBracket(price, category) {
  const t = category === 'subwoofer' ? [200, 500, 1000] : [150, 400, 1000];
  if (price < t[0]) return '$';
  if (price < t[1]) return '$$';
  if (price < t[2]) return '$$$';
  return '$$$$';
}

function tweeterMaterial(type) {
  return (
    {
      dome: 'Soft dome',
      horn: 'Horn-loaded dome',
      amt: 'Air Motion Transformer',
      ribbon: 'Ribbon / AMT',
      coax: 'Coaxial dome',
      none: 'Full-range (no tweeter)',
    }[type] || 'Dome'
  );
}

/** Deterministic small response ripple — unit-to-unit / design imperfections. */
function modelRipple(id, price, category) {
  const r = mulberry32(seedFrom(`${id}:ripple`));
  const amp = clamp(1.9 - Math.log10(price) * 0.5, 0.3, 1.6);
  const out = [];
  if (category === 'bookshelf') {
    for (let i = 0; i < 2; i++) {
      const f = Math.round(400 * Math.pow(15, r()));
      const g = Math.round((r() * 2 - 1) * amp * 10) / 10;
      if (Math.abs(g) >= 0.2) out.push({ type: 'peaking', frequency: f, Q: 1.5 + r() * 2.5, gain: g });
    }
  } else {
    const f = Math.round(35 + r() * 60);
    const g = Math.round((r() * 2 - 1) * amp * 10) / 10;
    if (Math.abs(g) >= 0.2) out.push({ type: 'peaking', frequency: f, Q: 1.5 + r() * 2, gain: g });
  }
  return out;
}

function bookshelfDims(wooferIn, ways) {
  const w = wooferIn * 2.54 * 1.35 + 3;
  const h = w * 1.65 + (ways === 3 ? 6 : 0);
  const d = w * 1.3;
  const litres = (w * h * d) / 1000;
  return { w: round(w, 0.5), h: round(h, 0.5), d: round(d, 0.5), litres: round(litres, 0.1), weightKg: round(litres * 0.55 + wooferIn * 0.35, 0.1) };
}

function subDims(driverIn, count, enclosure) {
  const s = driverIn * 2.54 * 1.28 + 8;
  const d = s * (enclosure === 'ported' ? 1.18 : 1.0) * (count > 1 ? 1.1 : 1);
  const litres = (s * s * d) / 1000;
  return { w: round(s, 0.5), h: round(s * 1.04, 0.5), d: round(d, 0.5), litres: round(litres, 0.1), weightKg: round(litres * 0.75 + driverIn * 0.6, 0.1) };
}

export function finalizeBookshelf(e, rank) {
  const id = e.id || slug(`${e.brand} ${e.model}`);
  const house = SPEAKER_HOUSE_SOUND[e.brand] || DEFAULT_SPEAKER_VOICING;
  const tType = e.tweeter.type;
  const rms = e.active ? e.ampWatts : e.rmsWatts;
  const maxSpl = e.maxSpl ?? round((e.sensitivity ?? 86) + 10 * Math.log10(rms || 30) + (e.active ? 3 : 0), 0.5);
  const dims = e.dims || bookshelfDims(e.woofer, e.ways);
  return {
    id,
    rank,
    category: 'bookshelf',
    brand: e.brand,
    model: e.model,
    name: `${e.brand} ${e.model}`,
    active: !!e.active,
    ampWatts: e.active ? e.ampWatts : null,
    rmsWatts: rms,
    peakWatts: e.peakWatts ?? rms * (tType === 'horn' ? 4 : 2),
    recommendedAmp: e.active ? null : [round(rms * 0.25, 5) || 10, round(rms * 1.25, 5)],
    woofer: { size: e.woofer, material: e.wooferMaterial || WOOFER_MATERIAL[e.brand] || 'Polypropylene' },
    tweeter: { size: e.tweeter.size, type: tType, material: e.tweeter.material || tweeterMaterial(tType) },
    ways: e.ways,
    enclosure: e.enclosure,
    port: e.enclosure === 'sealed' ? null : e.port || 'rear',
    freqLow: e.freqLow,
    freqHigh: e.freqHigh,
    f3: e.f3,
    qtc: e.qtc ?? 0.75,
    portBumpDb: e.portBumpDb ?? (e.enclosure === 'sealed' ? 0 : e.price < 200 ? 1.8 : e.price < 600 ? 1.0 : 0.5),
    sensitivity: e.sensitivity,
    impedance: e.impedance,
    crossoverHz: e.crossoverHz,
    maxSpl,
    price: e.price,
    priceBracket: priceBracket(e.price, 'bookshelf'),
    signature: house.tag,
    voicing: e.voicing ? e.voicing.map((f) => ({ ...f })) : [...house.filters.map((f) => ({ ...f })), ...modelRipple(id, e.price, 'bookshelf')],
    directivityDb: DIRECTIVITY_DB[tType] ?? 8,
    directivityQ: DIRECTIVITY_Q[tType] ?? 2.2,
    dims,
    style: e.style || BRAND_STYLE[e.brand] || DEFAULT_STYLE,
    features: e.features || [],
    specSource: e.specSource || 'published',
    estimated: e.estimated || [],
    ...(e.addon ? { addon: e.addon, measured: e.measured || null, fit: e.fit || null } : {}),
  };
}

/** Extrapolate a full spec sheet for a roster bookshelf speaker. */
export function extrapolateBookshelf(t) {
  const [brand, model, D, enclosure, amp, price, tweeterType, ways, port] = t;
  const r = mulberry32(seedFrom(`${brand} ${model}`));
  const jit = (a) => 1 + (r() * 2 - 1) * a;
  let f3 = 62 * Math.pow(D / 4.5, -0.8);
  if (enclosure === 'sealed') f3 *= 1.25;
  else if (enclosure === 'pr') f3 *= 0.95;
  if (amp > 0) f3 *= 0.94;
  if (price < 150) f3 *= 1.08;
  else if (price > 800) f3 *= 0.93;
  if (tweeterType === 'none') f3 *= 1.15;
  f3 = Math.round(f3 * jit(0.05));
  let freqHigh;
  if (tweeterType === 'amt' || tweeterType === 'ribbon') freqHigh = price > 500 ? 40000 : 35000;
  else if (tweeterType === 'coax') freqHigh = price > 1000 ? 45000 : 28000;
  else if (tweeterType === 'horn') freqHigh = 25000;
  else if (tweeterType === 'none') freqHigh = 18000;
  else freqHigh = price < 150 ? 20000 : price < 500 ? 25000 : 30000;
  let sens;
  if (amp > 0) sens = 85;
  else {
    sens = 86 + 2 * Math.log2(D / 5.25) + (tweeterType === 'horn' ? 5 : 0) + (tweeterType === 'amt' ? 1 : 0) + (price < 150 ? 1 : 0);
    sens = round(sens + (r() * 2 - 1), 0.5);
  }
  let rms;
  if (amp > 0) rms = amp;
  else rms = clamp(round(50 * Math.pow(D / 5.25, 1.5) * (price > 600 ? 1.4 : 1) * jit(0.1), 5), 15, 200);
  let xo = null;
  if (tweeterType === 'horn') xo = 1600;
  else if (tweeterType === 'coax') xo = 2200;
  else if (tweeterType === 'amt' || tweeterType === 'ribbon') xo = 3000;
  else if (tweeterType !== 'none') xo = round(2500 * Math.pow(5.25 / D, 0.3), 100);
  return {
    brand,
    model,
    active: amp > 0,
    ampWatts: amp > 0 ? amp : null,
    rmsWatts: amp > 0 ? amp : rms,
    woofer: D,
    tweeter: { size: tweeterType === 'none' ? 0 : tweeterType === 'horn' ? 1 : 1, type: tweeterType },
    ways,
    enclosure,
    port: port || 'rear',
    freqLow: Math.round(f3 * 0.82),
    freqHigh,
    f3,
    sensitivity: sens,
    impedance: amp > 0 ? 4 : IMPEDANCE_6.has(brand) ? 6 : 8,
    crossoverHz: xo,
    price,
    specSource: 'extrapolated',
    estimated: ['all'],
  };
}

export function finalizeSub(e, rank) {
  const id = e.id || slug(`${e.brand} ${e.model}`);
  const house = SUB_HOUSE_SOUND[e.brand] || DEFAULT_SUB_VOICING;
  const sens = e.sensitivity ?? subEfficiency(e.driver, e.count, e.enclosure);
  const dims = e.dims || subDims(e.driver, e.count, e.enclosure);
  return {
    id,
    rank,
    category: 'subwoofer',
    brand: e.brand,
    model: e.model,
    name: `${e.brand} ${e.model}`,
    active: true,
    driver: { size: e.driver, count: e.count || 1, material: e.material || WOOFER_MATERIAL[e.brand] || 'Treated paper / polymer' },
    enclosure: e.enclosure,
    port: e.enclosure === 'ported' ? e.port || 'front' : null,
    rmsWatts: e.rmsWatts,
    peakWatts: e.peakWatts ?? e.rmsWatts * 2,
    freqLow: e.freqLow,
    freqHigh: e.freqHigh,
    f3: e.f3,
    qtc: e.qtc ?? 0.65,
    portBumpDb: e.portBumpDb ?? (e.enclosure === 'ported' ? (e.price < 200 ? 2.5 : e.price < 500 ? 1.5 : 0.6) : 0),
    sensitivity: sens,
    maxSpl: e.maxSpl ?? round(sens + 10 * Math.log10(e.rmsWatts), 0.5),
    price: e.price,
    priceBracket: priceBracket(e.price, 'subwoofer'),
    phase: e.phase || 'switch',
    lpfRange: e.lpfRange || [40, 160],
    signature: house.tag,
    voicing: e.voicing ? e.voicing.map((f) => ({ ...f })) : [...house.filters.map((f) => ({ ...f })), ...modelRipple(id, e.price, 'subwoofer')],
    dims,
    style: e.style || BRAND_STYLE[e.brand] || DEFAULT_STYLE,
    features: e.features || [],
    specSource: e.specSource || 'published',
    estimated: e.estimated || [],
    ...(e.addon ? { addon: e.addon, measured: e.measured || null, fit: e.fit || null } : {}),
  };
}

/** Electro-acoustic efficiency (dB SPL @ 1 m for the "1 W" equivalent drive). */
export function subEfficiency(D, count = 1, enclosure = 'ported') {
  return round(84 + 3 * Math.log2(D / 10) + 10 * Math.log10(count) + (enclosure === 'ported' ? 2 : enclosure === 'pr' ? 1 : 0), 0.5);
}

export function extrapolateSub(t) {
  const [brand, model, D, count, enclosure, rms, price, phase] = t;
  const r = mulberry32(seedFrom(`${brand} ${model}`));
  const jit = (a) => 1 + (r() * 2 - 1) * a;
  let f3 = 26 * Math.pow(D / 12, -0.6);
  if (count > 1) f3 *= 0.93;
  if (enclosure === 'sealed') f3 *= 1.12;
  else if (enclosure === 'pr') f3 *= 1.03;
  if (price < 200) f3 *= 1.15;
  else if (price < 600) f3 *= 1;
  else if (price < 1500) f3 *= 0.85;
  else f3 *= 0.75;
  f3 = Math.round(f3 * jit(0.05));
  const freqHigh = price < 200 ? 150 : price < 600 ? 180 : price < 1500 ? 220 : 260;
  return {
    brand,
    model,
    driver: D,
    count,
    enclosure,
    rmsWatts: rms,
    price,
    phase,
    freqLow: Math.round(f3 * 0.88),
    freqHigh,
    f3,
    lpfRange: price < 300 ? [50, 150] : [30, 200],
    specSource: 'extrapolated',
    estimated: ['all'],
  };
}

export function buildBookshelfCatalog() {
  const seeds = BOOKSHELF_SEEDS.map((s) => ({ ...s }));
  const need = CATEGORY_SIZE - seeds.length;
  if (BOOKSHELF_ROSTER.length < need) throw new Error('Bookshelf roster too short');
  const extra = BOOKSHELF_ROSTER.slice(0, need).map(extrapolateBookshelf);
  return [...seeds, ...extra].map((e, i) => finalizeBookshelf(e, i + 1));
}

export function buildSubCatalog() {
  const seeds = SUB_SEEDS.map((s) => ({ ...s }));
  const need = CATEGORY_SIZE - seeds.length;
  if (SUB_ROSTER.length < need) throw new Error('Subwoofer roster too short');
  const extra = SUB_ROSTER.slice(0, need).map(extrapolateSub);
  return [...seeds, ...extra].map((e, i) => finalizeSub(e, i + 1));
}
