// Pure signal-flow "plan": converts application state into every numeric
// parameter the audio graph needs (filter specs, gains, delays, positions).
// The realtime engine, the offline bake renderer, the frequency-response
// predictor and the auto-EQ all consume the same plan, so they always agree.
//
// Gain staging model
// ------------------
// Digital full scale (0 dBFS peak) after the master volume drives the
// amplifier to s = 1, defined as 100 W into 8 Ω (40 V peak). An amplifier
// rated P watts therefore clips at s_clip = √P / 10. A speaker with
// sensitivity S (dB SPL @ 2.83 V/1 m) produces S + 20 dB at 1 m for a full-
// scale sine, so the acoustic output gain is 10^((S + 23.01 − 100)/20) in a
// domain where digital RMS 1.0 ≙ 100 dB SPL. PannerNode applies 1/r (inverse
// square law) and the monitor calibration maps SPL back to headphone level.

import { getHardware, speakerResponseSpecs, subResponseSpecs, DEFAULT_SPEAKER_ID, DEFAULT_SUB_ID } from '../hardware/index.js';
import { linkwitzRiley, cascadeMagnitudeDb, IDENTITY } from '../dsp/biquad.js';
import { GEQ_FREQS, GEQ_Q } from '../dsp/curves.js';
import { boundaryGain, modalCrossover, roomSpeedOfSound } from '../acoustics/room.js';
import { airAttenuationDbPerM } from '../acoustics/materials.js';
import { dbToGain, clamp, qToDb, logspace } from '../util/math.js';

export const REF_SPL = 100; // dB SPL represented by digital RMS 1.0 inside the simulation
export const BANK_SIZES = { tone: 4, geq: 31, peq: 12, rc: 12, xo: 4, model: 14, room: 10 };

const HEADROOM_GRID = logspace(20, 20000, 160);

/** Convert a parametric EQ band (linear Q for every type) to a Web Audio spec. */
export function bandToSpec(b) {
  const spec = { type: b.type, frequency: b.frequency, Q: b.Q, gain: b.gain };
  if (b.type === 'lowpass' || b.type === 'highpass') spec.Q = qToDb(Math.max(0.1, b.Q));
  return spec;
}

/** Facing unit vector (x, z) for a yaw in degrees (0 = towards the front wall, −z). */
export function yawVector(yawDeg) {
  const r = (yawDeg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

/** Yaw (deg) pointing from `from` towards `to`. */
export function aimYaw(from, to) {
  return (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
}

function channelSends(channel) {
  switch (channel) {
    case 'L':
    case 'SL':
      return [1, 0];
    case 'R':
    case 'SR':
      return [0, 1];
    default:
      return [Math.SQRT1_2, Math.SQRT1_2];
  }
}

/**
 * @param {object} state application state
 * @param {object} [opts]
 * @param {number} [opts.sampleRate]
 * @param {Object<string,{filters:object[]}>} [opts.roomFilters] modal fits keyed by source id
 */
export function buildPlan(state, opts = {}) {
  const sampleRate = opts.sampleRate || 48000;
  const roomFilters = opts.roomFilters || {};
  const { receiver, crossover: xo, eq, room, listener } = state;
  const c = roomSpeedOfSound(room);

  // ---------------------------------------------------------- master chain
  const toneSpecs = [];
  if (!receiver.pureDirect) {
    if (receiver.bass) toneSpecs.push({ type: 'lowshelf', frequency: 100, gain: clamp(receiver.bass, -12, 12) });
    if (receiver.treble) toneSpecs.push({ type: 'highshelf', frequency: 10000, gain: clamp(receiver.treble, -12, 12) });
  }
  if (receiver.loudness) {
    const below = Math.max(0, (receiver.loudnessRefDb ?? 0) - receiver.masterDb);
    const low = Math.min(12, 0.3 * below);
    const high = Math.min(5, 0.1 * below);
    if (low > 0.05) toneSpecs.push({ type: 'lowshelf', frequency: 90, gain: low });
    if (high > 0.05) toneSpecs.push({ type: 'highshelf', frequency: 11000, gain: high });
  }
  const geqSpecs = eq.graphic.enabled ? GEQ_FREQS.map((f, i) => ({ type: 'peaking', frequency: f, Q: GEQ_Q, gain: eq.graphic.gains[i] || 0 })).filter((s) => s.gain) : [];
  const peqSpecs = eq.parametric.enabled ? eq.parametric.bands.filter((b) => b.enabled && (b.gain || ['lowpass', 'highpass', 'notch', 'bandpass'].includes(b.type))).map(bandToSpec) : [];
  const rc = state.roomCorrection;
  const rcSpecs = rc.enabled && rc.filters ? rc.filters.map((f) => ({ ...f, gain: (f.gain || 0) * (rc.strength ?? 1) })) : [];
  const allEq = [...toneSpecs, ...geqSpecs, ...peqSpecs, ...rcSpecs];
  let eqMaxBoost = 0;
  if (allEq.length) {
    const db = cascadeMagnitudeDb(allEq, HEADROOM_GRID, sampleRate);
    eqMaxBoost = Math.max(0, ...db);
  }
  const eqPreampDb = (eq.preampDb || 0) - (eq.autoHeadroom ? eqMaxBoost : 0);
  const masterGain = receiver.masterDb <= -80 ? 0 : dbToGain(receiver.masterDb);

  const xoOn = xo.enabled && Number(xo.slope) > 0;
  const lfeSpecs = xoOn ? linkwitzRiley('lowpass', xo.slope, xo.frequency) : [];
  const hpfSpecs = xoOn && xo.speakerMode === 'small' ? linkwitzRiley('highpass', xo.slope, xo.frequency) : [];
  const modalXo = modalCrossover(room);

  // ---------------------------------------------------------- sources
  const lis = { x: listener.x, y: listener.y ?? 1.15, z: listener.z };
  const all = [...state.speakers.map((s) => ({ ...s, kind: 'speaker' })), ...state.subs.map((s) => ({ ...s, kind: 'sub' }))];
  const anySolo = all.some((s) => s.solo);
  const sources = all.map((s) => {
    const isSub = s.kind === 'sub';
    const hw = getHardware(s.modelId) || getHardware(isSub ? DEFAULT_SUB_ID : DEFAULT_SPEAKER_ID);
    const pos = { x: s.x, y: s.y ?? (isSub ? 0.25 : 1), z: s.z };
    const dx = lis.x - pos.x;
    const dy = lis.y - pos.y;
    const dz = lis.z - pos.z;
    const d = Math.max(0.3, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const yaw = s.aim !== false && !isSub ? aimYaw(pos, lis) : s.yaw ?? 180;
    let roomSpecs = [];
    let boundaryDb = null;
    if (room.modes && roomFilters[s.id]) {
      roomSpecs = roomFilters[s.id].filters;
      boundaryDb = roomFilters[s.id].boundaryDb ?? null;
    } else if (room.boundary) {
      const bg = boundaryGain(room, pos);
      boundaryDb = bg.gainDb;
      if (bg.gainDb > 0.1) roomSpecs = [{ type: 'lowshelf', frequency: isSub ? clamp(bg.cornerFreq, 60, 200) : bg.cornerFreq, gain: bg.gainDb }];
    }
    let offAxisDeg = 0;
    let dirSpec = IDENTITY;
    if (!isSub) {
      const f = yawVector(yaw);
      const hd = Math.hypot(dx, dz) || 1;
      const cosH = (f.x * dx + f.z * dz) / hd;
      // Combine horizontal and vertical angles.
      const horiz = Math.acos(clamp(cosH, -1, 1));
      const vert = Math.atan2(Math.abs(dy), hd);
      const cosT = Math.cos(horiz) * Math.cos(vert);
      offAxisDeg = (Math.acos(clamp(cosT, -1, 1)) * 180) / Math.PI;
      if (room.directivity) {
        const g = -hw.directivityDb * (1 - cosT);
        if (g < -0.05) dirSpec = { type: 'highshelf', frequency: 3000, gain: clamp(g, -24, 0) };
      }
    }
    const airSpec = room.airAbsorption && !isSub ? { type: 'highshelf', frequency: 8000, gain: -airAttenuationDbPerM(12000) * d } : IDENTITY;
    let sClip;
    let ampCurve;
    let sDrv;
    let ampWatts;
    if (isSub) {
      ampWatts = hw.rmsWatts;
      sClip = Math.sqrt(ampWatts) / 10;
      ampCurve = 'd';
      sDrv = sClip * (hw.price < 300 ? 0.9 : 1.3);
    } else {
      ampWatts = hw.active ? hw.ampWatts : receiver.wattsPerChannel;
      sClip = Math.sqrt(Math.max(0.5, ampWatts)) / 10;
      ampCurve = hw.active ? 'd' : receiver.ampClass;
      sDrv = hw.active ? sClip * 1.2 : Math.sqrt(4 * hw.rmsWatts * (hw.impedance || 8)) / 40;
    }
    const [sendL, sendR] = isSub ? [Math.SQRT1_2, Math.SQRT1_2] : channelSends(s.channel);
    let polarity = 1;
    let phaseDelay = 0;
    if (isSub) {
      if (((xo.subPolarity || 0) + (s.polarity || 0)) % 360 === 180) polarity = -1;
      if (xoOn && s.phaseDeg) phaseDelay = (s.phaseDeg / 360) / xo.frequency;
    }
    return {
      id: s.id,
      kind: s.kind,
      channel: isSub ? 'LFE' : s.channel,
      hw,
      pos,
      yaw,
      distance: d,
      offAxisDeg,
      hpfSpecs: isSub ? [] : hpfSpecs,
      modelSpecs: isSub ? subResponseSpecs(hw, sampleRate) : speakerResponseSpecs(hw, sampleRate),
      trimGain: dbToGain(s.trimDb || 0),
      polarity,
      ampWatts,
      sClip,
      ampCurve,
      sDrv,
      impedance: isSub ? 4 : hw.impedance || 8,
      sensGain: dbToGain(hw.sensitivity + 23.01 - REF_SPL),
      roomSpecs,
      boundaryDb,
      propDelay: room.propagation ? d / c : 0,
      manualDelay: Math.max(0, (s.delayMs || 0) / 1000) + phaseDelay,
      alignDelay: 0,
      dirSpec,
      airSpec,
      sendGain: isSub ? 1 : 1 / Math.sqrt(hw.directivityQ || 2),
      sendL,
      sendR,
      active: !s.muted && (!anySolo || !!s.solo),
    };
  });
  if (xo.autoAlign && room.propagation) {
    const dMax = Math.max(0, ...sources.map((s) => s.distance));
    for (const s of sources) s.alignDelay = (dMax - s.distance) / c;
  }

  return {
    sampleRate,
    speedOfSound: c,
    inputGain: dbToGain(receiver.inputGainDb || 0),
    toneSpecs,
    geqSpecs,
    peqSpecs,
    rcSpecs,
    eqMaxBoost,
    eqPreampGain: dbToGain(eqPreampDb),
    masterGain,
    monitorCal: dbToGain(REF_SPL - (receiver.monitorRefSpl ?? 85)),
    lfeSpecs,
    hpfSpecs,
    crossover: { on: xoOn, frequency: xo.frequency, slope: Number(xo.slope), speakerMode: xo.speakerMode },
    modalCrossover: modalXo,
    reverb: {
      enabled: !!room.reverb.enabled,
      wetGain: room.reverb.enabled ? dbToGain(room.reverb.wetDb || 0) : 0,
      hpSpecs: room.modes ? linkwitzRiley('highpass', 24, modalXo) : [],
      erOrder: room.reverb.erOrder ?? 3,
    },
    listener: { ...lis, yaw: listener.yaw || 0 },
    panningModel: state.engine.output === 'speakers' ? 'equalpower' : 'HRTF',
    simulation: state.engine.simulation !== false,
    sources,
  };
}

/** Representative left/right source positions for the reverb IR. */
export function reverbSourcePositions(plan) {
  const act = plan.sources.filter((s) => s.active);
  const avg = (list) => {
    if (!list.length) return null;
    const p = { x: 0, y: 0, z: 0 };
    for (const s of list) {
      p.x += s.pos.x;
      p.y += s.pos.y;
      p.z += s.pos.z;
    }
    return { x: p.x / list.length, y: p.y / list.length, z: p.z / list.length };
  };
  const left = avg(act.filter((s) => s.sendL > s.sendR));
  const right = avg(act.filter((s) => s.sendR > s.sendL));
  const centre = avg(act.filter((s) => s.sendL === s.sendR)) || avg(act) || { x: plan.listener.x, y: 1, z: Math.max(0.5, plan.listener.z - 2) };
  return { srcL: left || right || centre, srcR: right || left || centre };
}
