// Physical response model: converts a spec sheet into biquad filter specs
// (enclosure roll-off, port/tuning lift, HF limit and voicing).

import { butterworth, cascadeMagnitudeDb } from '../dsp/biquad.js';
import { qToDb, logspace } from '../util/math.js';

/**
 * Filter specs modelling a bookshelf speaker's anechoic on-axis response:
 * enclosure low-frequency roll-off (2nd order sealed / 4th order vented),
 * port/PR tuning bump, high-frequency limit and the brand/model voicing.
 */
export function speakerResponseSpecs(hw, sampleRate = 48000) {
  const specs = [];
  if (hw.enclosure === 'sealed') specs.push(...butterworth('highpass', 2, hw.f3, hw.qtc / Math.SQRT1_2));
  else if (hw.enclosure === 'pr') specs.push(...butterworth('highpass', 4, hw.f3, 1.08));
  else specs.push(...butterworth('highpass', 4, hw.f3));
  if (hw.portBumpDb) specs.push({ type: 'peaking', frequency: hw.f3 * 1.35, Q: 1.3, gain: hw.portBumpDb });
  if (hw.freqHigh < sampleRate * 0.45) specs.push({ type: 'lowpass', frequency: hw.freqHigh, Q: qToDb(Math.SQRT1_2) });
  specs.push(...hw.voicing);
  return specs;
}

/** Filter specs for a subwoofer's natural response (excluding the AVR crossover). */
export function subResponseSpecs(hw, sampleRate = 48000) {
  const specs = [];
  if (hw.enclosure === 'sealed') specs.push(...butterworth('highpass', 2, hw.f3, hw.qtc / Math.SQRT1_2));
  else if (hw.enclosure === 'pr') specs.push(...butterworth('highpass', 4, hw.f3, 1.1));
  else specs.push(...butterworth('highpass', 4, hw.f3));
  if (hw.portBumpDb) specs.push({ type: 'peaking', frequency: hw.f3 * 1.5, Q: 1.6, gain: hw.portBumpDb });
  if (hw.freqHigh < sampleRate * 0.45) specs.push({ type: 'lowpass', frequency: hw.freqHigh * 1.15, Q: qToDb(0.6) });
  specs.push(...hw.voicing);
  return specs;
}

export function responseSpecs(hw, sampleRate) {
  return hw.category === 'subwoofer' ? subResponseSpecs(hw, sampleRate) : speakerResponseSpecs(hw, sampleRate);
}

const PLOT_FREQS = logspace(10, 24000, 240);

/** Magnitude response (dB) on a default plotting grid. */
export function responseCurve(hw, freqs = PLOT_FREQS, sampleRate = 48000) {
  return { freqs, db: cascadeMagnitudeDb(responseSpecs(hw, sampleRate), freqs, sampleRate) };
}

/** Human summary tags derived from the modelled response. */
export function soundTags(hw) {
  const probe = [45, 100, 1000, 3500, 10000];
  const db = cascadeMagnitudeDb(responseSpecs(hw), probe);
  const tags = [];
  if (hw.category === 'subwoofer') {
    if (hw.f3 <= 20) tags.push('Infrasonic');
    else if (hw.f3 <= 26) tags.push('Deep');
    if (hw.enclosure === 'sealed') tags.push('Tight');
    if (hw.portBumpDb >= 2.5) tags.push('Boomy');
    if (hw.rmsWatts >= 500) tags.push('High output');
    if (hw.driver.count > 1) tags.push('Force-cancelling');
    return tags;
  }
  const bass = db[1] - db[2];
  const presence = db[3] - db[2];
  const air = db[4] - db[2];
  if (bass > 1.5) tags.push('Warm');
  if (air > 1.5 || presence > 1.8) tags.push('Bright');
  if (bass > 1.5 && air > 1.2) tags.push('V-shaped');
  if (Math.abs(bass) < 1 && Math.abs(presence) < 1 && Math.abs(air) < 1) tags.push('Neutral');
  if (hw.f3 <= 50) tags.push('Deep bass');
  if (hw.sensitivity >= 90) tags.push('Efficient');
  if (hw.active) tags.push('Powered');
  return tags;
}
