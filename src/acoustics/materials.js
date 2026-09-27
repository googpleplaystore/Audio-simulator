// Sound absorption coefficients per octave band (63 Hz … 8 kHz).
// Values compiled from standard architectural-acoustics tables (random-incidence
// absorption coefficients); 63 Hz and 8 kHz are extrapolated where tables stop.

export const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

export const MATERIALS = {
  glass: {
    name: 'Glass (Windows)',
    color: '#7fd3ff',
    alpha: [0.35, 0.35, 0.25, 0.18, 0.12, 0.07, 0.04, 0.04],
  },
  drywall: {
    name: 'Bare Drywall',
    color: '#c9c3b8',
    alpha: [0.3, 0.29, 0.1, 0.05, 0.04, 0.07, 0.09, 0.09],
  },
  curtains: {
    name: 'Heavy Curtains',
    color: '#9b3b5a',
    alpha: [0.1, 0.14, 0.35, 0.55, 0.72, 0.7, 0.65, 0.6],
  },
  foam: {
    name: 'Acoustic Foam (50 mm)',
    color: '#3a3f4b',
    alpha: [0.06, 0.13, 0.35, 0.78, 0.97, 0.99, 0.97, 0.95],
  },
  'bass-trap': {
    name: 'Broadband Bass Traps',
    color: '#51607a',
    alpha: [0.45, 0.62, 0.88, 0.98, 0.99, 0.99, 0.99, 0.97],
  },
  concrete: {
    name: 'Bare Concrete',
    color: '#8b8d90',
    alpha: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03, 0.04],
  },
  brick: {
    name: 'Exposed Brick',
    color: '#a4553a',
    alpha: [0.02, 0.03, 0.03, 0.03, 0.04, 0.05, 0.07, 0.08],
  },
  plaster: {
    name: 'Plaster on Masonry',
    color: '#e3ddd0',
    alpha: [0.01, 0.013, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06],
  },
  'wood-panel': {
    name: 'Wood Paneling',
    color: '#8a5a33',
    alpha: [0.3, 0.28, 0.22, 0.17, 0.09, 0.1, 0.11, 0.11],
  },
  hardwood: {
    name: 'Hardwood Floor',
    color: '#a8743f',
    alpha: [0.15, 0.15, 0.11, 0.1, 0.07, 0.06, 0.07, 0.07],
  },
  carpet: {
    name: 'Carpet on Underlay',
    color: '#5b4e6e',
    alpha: [0.04, 0.08, 0.24, 0.57, 0.69, 0.71, 0.73, 0.73],
  },
  tile: {
    name: 'Ceramic Tile / Marble',
    color: '#d7dee3',
    alpha: [0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.03],
  },
  audience: {
    name: 'Upholstered Seating',
    color: '#7a2838',
    alpha: [0.4, 0.6, 0.74, 0.88, 0.96, 0.93, 0.85, 0.8],
  },
  bookshelf: {
    name: 'Filled Bookshelves (Diffuse)',
    color: '#6b4a2b',
    alpha: [0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.5, 0.5],
  },
  'open-window': {
    name: 'Open Window',
    color: '#1d2b3a',
    alpha: [1, 1, 1, 1, 1, 1, 1, 1],
  },
};

export const MATERIAL_IDS = Object.keys(MATERIALS);

/** Absorption at an arbitrary frequency via log-frequency interpolation. */
export function alphaAt(materialId, f) {
  const m = MATERIALS[materialId] || MATERIALS.drywall;
  if (f <= BANDS[0]) return m.alpha[0];
  if (f >= BANDS[BANDS.length - 1]) return m.alpha[BANDS.length - 1];
  for (let i = 1; i < BANDS.length; i++) {
    if (f <= BANDS[i]) {
      const t = Math.log(f / BANDS[i - 1]) / Math.log(BANDS[i] / BANDS[i - 1]);
      return m.alpha[i - 1] + (m.alpha[i] - m.alpha[i - 1]) * t;
    }
  }
  return m.alpha[BANDS.length - 1];
}

/** Air absorption energy attenuation coefficient m (1/m) at 20 °C, 50 % RH per band. */
export const AIR_ABSORPTION = [0.00005, 0.0001, 0.0003, 0.0006, 0.001, 0.0024, 0.0072, 0.022];

/** Air attenuation in dB per metre, for the direct path high-frequency loss. */
export function airAttenuationDbPerM(f) {
  // 4.343 * m converts energy coefficient to dB/m.
  const ms = AIR_ABSORPTION;
  let m;
  if (f <= BANDS[0]) m = ms[0];
  else if (f >= BANDS[BANDS.length - 1]) m = ms[BANDS.length - 1] * (f / BANDS[BANDS.length - 1]) ** 1.6;
  else {
    for (let i = 1; i < BANDS.length; i++) {
      if (f <= BANDS[i]) {
        const t = Math.log(f / BANDS[i - 1]) / Math.log(BANDS[i] / BANDS[i - 1]);
        m = Math.exp(Math.log(ms[i - 1]) + (Math.log(ms[i]) - Math.log(ms[i - 1])) * t);
        break;
      }
    }
  }
  return 4.343 * m;
}
