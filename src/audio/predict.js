// Frequency-domain prediction of the simulated system at the listening
// position — the "virtual measurement microphone". Uses exactly the plan the
// audio engine plays, evaluated with complex biquad responses, delays and
// 1/r spreading, plus the statistical reverberant energy.

import { Response } from '../dsp/biquad.js';
import { roomConstant } from '../acoustics/room.js';
import { BANDS } from '../acoustics/materials.js';
import { interpLogF } from '../util/math.js';

function busWeight(channel) {
  // Mono test signal (L = R = 1): matrix surrounds cancel.
  if (channel === 'SL' || channel === 'SR') return 0;
  return 1;
}

/**
 * @param {object} plan from buildPlan()
 * @param {Float64Array|number[]} freqs
 * @param {object} [opts]
 * @param {boolean} [opts.includeReverb=true]
 * @param {boolean} [opts.includeEq=true]
 * @param {(s:object)=>boolean} [opts.filter] choose sources
 * @param {object} [opts.room] room state (needed for reverb energy)
 * @param {boolean} [opts.includeMaster=true] include master volume/EQ gain
 */
export function predictSystem(plan, freqs, opts = {}) {
  const { includeReverb = true, includeEq = true, filter = null, room = null, includeMaster = true } = opts;
  const sr = plan.sampleRate;
  const master = new Response(freqs, sr);
  if (includeEq) master.filter([...plan.toneSpecs, ...plan.geqSpecs, ...plan.peqSpecs, ...plan.rcSpecs]).gain(plan.eqPreampGain);
  if (includeMaster) master.gain(plan.masterGain * plan.inputGain);
  const total = Response.zero(freqs, sr);
  const revPow = new Float64Array(freqs.length);
  let E = null;
  if (includeReverb && plan.reverb.enabled && room) {
    const R = roomConstant(room);
    const e = R.map((r) => (16 * Math.PI) / Math.max(r, 1e-3));
    E = Array.from(freqs, (f) => interpLogF(BANDS, e, f));
  }
  const perSource = {};
  for (const s of plan.sources) {
    if (!s.active) continue;
    if (filter && !filter(s)) continue;
    const w = busWeight(s.channel);
    if (!w) continue;
    const r = master.clone();
    if (s.kind === 'sub') r.filter(plan.lfeSpecs);
    else r.filter(s.hpfSpecs);
    r.filter(s.modelSpecs).gain(s.trimGain * s.polarity * s.sensGain * w);
    let pre = null;
    if (E) pre = r.clone().filter(plan.reverb.hpSpecs);
    r.filter(s.roomSpecs)
      .delay(s.alignDelay + s.manualDelay + s.propDelay)
      .filter([s.dirSpec, s.airSpec])
      .gain(1 / s.distance);
    total.add(r);
    perSource[s.id] = r;
    if (pre) {
      const p = pre.power();
      const send = s.sendGain * plan.reverb.wetGain;
      const ear = s.sendL * s.sendL + s.sendR * s.sendR;
      for (let i = 0; i < freqs.length; i++) revPow[i] += p[i] * send * send * ear * E[i];
    }
  }
  const pw = total.power();
  const db = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) db[i] = 10 * Math.log10(pw[i] + revPow[i] + 1e-20);
  return { db, phase: total.phaseDeg(), complex: total, perSource, reverbPower: revPow };
}

/** Mean dB of a curve over [f1, f2]. */
export function bandMeanDb(freqs, db, f1, f2) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= f1 && freqs[i] <= f2) {
      s += Math.pow(10, db[i] / 10);
      n++;
    }
  }
  return n ? 10 * Math.log10(s / n) : -Infinity;
}
