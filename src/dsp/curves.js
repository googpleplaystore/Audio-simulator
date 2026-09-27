// Frequency constants, 31-band graphic EQ presets and target curves.

import { interpLogF } from '../util/math.js';

/** ISO 266 1/3-octave centre frequencies used by 31-band graphic EQs. */
export const GEQ_FREQS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

/** Constant-Q for a 1/3-octave peaking band. */
export const GEQ_Q = Math.sqrt(Math.pow(2, 1 / 3)) / (Math.pow(2, 1 / 3) - 1); // ≈ 4.318

/** Octave-band centres used for room acoustics. */
export const OCTAVE_BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/** Build a 31-value gain array from sparse anchor points (log-interpolated). */
function fromAnchors(anchors) {
  const fs = anchors.map((a) => a[0]);
  const gs = anchors.map((a) => a[1]);
  return GEQ_FREQS.map((f) => Math.round(interpLogF(fs, gs, f) * 10) / 10);
}

export const GEQ_PRESETS = [
  { id: 'flat', name: 'Flat', gains: GEQ_FREQS.map(() => 0) },
  {
    id: 'v-shape-extreme',
    name: 'V-Shape: Sub-Bass Impact + Treble Sparkle',
    description: 'Highly aggressive smile curve: massive sub-bass, scooped mids and airy treble.',
    gains: [
      9, 9, 8.5, 8, 7, 6, 4.5, 3, 1.5, 0, -1.5, -2.5, -3.5, -4, -4.5, -4.5, -4, -3.5, -3, -2, -1, 0, 1.5, 3, 4.5, 6, 7,
      8, 8.5, 9, 9,
    ],
  },
  { id: 'v-shape', name: 'V-Shape (Mild)', gains: fromAnchors([[20, 4], [60, 4], [250, 0], [1000, -2], [4000, 0], [12000, 4], [20000, 4]]) },
  { id: 'bass-boost', name: 'Bass Boost', gains: fromAnchors([[20, 6], [80, 6], [200, 2], [400, 0], [20000, 0]]) },
  { id: 'sub-rumble', name: 'Sub-Bass Rumble (<60 Hz)', gains: fromAnchors([[20, 9], [40, 8], [63, 4], [100, 0], [20000, 0]]) },
  { id: 'bass-cut', name: 'Bass Reducer', gains: fromAnchors([[20, -8], [80, -6], [200, -2], [400, 0], [20000, 0]]) },
  { id: 'treble-boost', name: 'Treble Boost', gains: fromAnchors([[20, 0], [2000, 0], [6000, 4], [20000, 6]]) },
  { id: 'treble-cut', name: 'Treble Reducer', gains: fromAnchors([[20, 0], [2000, 0], [6000, -4], [20000, -7]]) },
  { id: 'vocal', name: 'Vocal Presence', gains: fromAnchors([[20, -3], [100, -2], [300, 0], [1000, 2], [2500, 4], [5000, 2], [10000, 0], [20000, -1]]) },
  { id: 'loudness', name: 'Loudness', gains: fromAnchors([[20, 6], [60, 5], [200, 1], [1000, 0], [5000, 1], [12000, 3], [20000, 4]]) },
  { id: 'rock', name: 'Rock', gains: fromAnchors([[20, 4], [80, 4], [250, 1], [800, -2], [2000, 1], [5000, 3], [12000, 4], [20000, 4]]) },
  { id: 'electronic', name: 'Electronic / EDM', gains: fromAnchors([[20, 7], [60, 6], [150, 2], [400, -1], [1000, -1], [3000, 1], [8000, 4], [20000, 5]]) },
  { id: 'hip-hop', name: 'Hip-Hop / 808', gains: fromAnchors([[20, 7], [50, 7], [100, 4], [250, 0], [1000, -1], [3000, 1], [8000, 2], [20000, 2]]) },
  { id: 'jazz', name: 'Jazz', gains: fromAnchors([[20, 2], [100, 3], [300, 1], [1000, -1], [3000, 1], [8000, 2], [20000, 3]]) },
  { id: 'classical', name: 'Classical', gains: fromAnchors([[20, 3], [100, 2], [400, 0], [2000, 0], [8000, -1], [20000, 2]]) },
  { id: 'acoustic', name: 'Acoustic', gains: fromAnchors([[20, 2], [100, 3], [300, 1], [1000, 1], [3000, 2], [8000, 3], [20000, 2]]) },
  { id: 'speech', name: 'Podcast / Speech', gains: fromAnchors([[20, -10], [80, -6], [150, -1], [300, 0], [2500, 3], [5000, 2], [10000, -2], [20000, -4]]) },
  { id: 'late-night', name: 'Late Night (Neighbour-Friendly)', gains: fromAnchors([[20, -9], [60, -6], [150, -1], [400, 0], [3000, 1], [20000, -1]]) },
  { id: 'harman', name: 'Harman-Style Tilt', gains: fromAnchors([[20, 5], [60, 5], [150, 2], [300, 0], [1000, 0], [4000, -1], [10000, -2], [20000, -3]]) },
  { id: 'car', name: 'Car Audio Basshead', gains: fromAnchors([[20, 10], [40, 10], [80, 6], [160, 1], [500, -2], [2000, 0], [8000, 3], [20000, 3]]) },
  { id: 'x-curve', name: 'Cinema X-Curve Compensation', gains: fromAnchors([[20, 0], [2000, 0], [4000, 2], [8000, 5], [16000, 8], [20000, 9]]) },
  { id: 'small-speaker', name: 'Small Speaker Rescue', gains: fromAnchors([[20, -6], [50, 2], [80, 5], [150, 3], [400, 0], [3000, -1], [10000, 1], [20000, 2]]) },
];

/**
 * Target in-room curves for room correction. Each returns dB at f (relative).
 */
export const TARGET_CURVES = [
  { id: 'flat', name: 'Flat (Anechoic Neutral)', fn: () => 0 },
  {
    id: 'harman',
    name: 'Harman In-Room',
    fn: (f) => interpLogF([20, 40, 105, 200, 1000, 10000, 20000], [6.2, 6, 4, 1.2, 0, -2.5, -4.5], f),
  },
  { id: 'bk', name: 'B&K 1974 House Curve', fn: (f) => interpLogF([20, 100, 200, 1000, 10000, 20000], [3, 2, 1, 0, -3, -5], f) },
  { id: 'bass-heavy', name: 'Bass Enthusiast (+9 dB)', fn: (f) => interpLogF([20, 60, 150, 300, 20000], [9, 9, 3, 0, -2], f) },
  { id: 'x-curve', name: 'SMPTE X-Curve (Cinema)', fn: (f) => (f <= 2000 ? 0 : -3 * Math.log2(f / 2000)) },
];

export function targetCurve(id) {
  return TARGET_CURVES.find((t) => t.id === id) || TARGET_CURVES[0];
}

/** Standard subwoofer / AVR crossover frequencies. */
export const STANDARD_CROSSOVERS = [40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 180, 200, 250];

/** Round a speaker f3 up to the nearest standard AVR crossover setting. */
export function suggestCrossover(f3) {
  const want = f3 * 1.25;
  return STANDARD_CROSSOVERS.find((f) => f >= want) || 250;
}
