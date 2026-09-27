// Colour scales for the bass maps shared by the 2D and 3D room views.

import { clamp } from '../util/math.js';

/** Level relative to the seat: blue (weaker) → dark → orange/red (stronger), ±12 dB. */
export function levelColor(deltaDb) {
  const a = clamp(deltaDb / 12, -1, 1);
  if (a < 0) {
    const k = -a;
    return [20 + 20 * (1 - k), 60 + 80 * k, 120 + 135 * k];
  }
  return [40 + 215 * a, 40 + 120 * a * (1 - a * 0.4), 60 * (1 - a)];
}

/** Unevenness (std-dev in dB): teal (smooth, ≤2 dB) → amber → red (≥10 dB). */
export function smoothColor(stdDb) {
  const t = clamp((stdDb - 2) / 8, 0, 1);
  if (t < 0.5) {
    const k = t / 0.5;
    return [30 + 225 * k, 200 - 20 * k, 170 - 130 * k];
  }
  const k = (t - 0.5) / 0.5;
  return [255, 180 - 130 * k, 40 + 20 * k];
}

/** RGB for heat-map cell i given the map and its display mode. */
export function heatCell(hm, i) {
  return hm.mode === 'smooth' ? smoothColor(hm.std[i]) : levelColor(hm.data[i] - hm.ref);
}
