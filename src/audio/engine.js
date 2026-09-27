// The AudioSpace simulation engine: builds and maintains the complete Web
// Audio graph for any BaseAudioContext (realtime playback or offline baking).
//
//  input ─┬─ inputGain → tone → 31-band GEQ → PEQ → room-correction → headroom
//         │     → DSP 0 dBFS clip → master volume ─┬─ L/R/M/S buses → speaker chains
//         │                                        └─ LFE sum → LR low-pass → sub chains
//         │   each chain: HPF → driver/enclosure model → trim/polarity → amplifier
//         │     clipping → driver excursion → thermal compression → sensitivity →
//         │     room (modal/boundary) filters → time alignment → ┬ propagation delay →
//         │     directivity → air absorption → HRTF PannerNode (1/r) → dry bus
//         │                                                   └ reverb send
//         │   reverb sends → high-pass (Schroeder) → true-stereo convolver (A/B xfade)
//         └─ direct (bypass, level-matched)
//  dry+wet → monitor calibration ─ A/B crossfade ─ mix → volume → limiter → out

import { Emitter } from '../util/emitter.js';
import { buildPlan, reverbSourcePositions, BANK_SIZES } from './plan.js';
import { FilterBank, SaturationStage, setParam, monoGain, crossfade, setPannerPosition, setListenerPose, shaperCurve } from './nodes.js';
import { computeRoomFilters, computeIR } from '../acoustics/compute.js';
import { boundaryGain } from '../acoustics/room.js';
import { clamp, dbToGain } from '../util/math.js';

const REF_DISTANCE = 0.25; // PannerNode reference distance; compensated so gain = 1/r (m)
const MAX_DELAY = 1.0;
const OVERSAMPLE = { high: '4x', balanced: '2x', eco: 'none' };
const LIMITER_URL = new URL('./worklets/limiter.worklet.js', import.meta.url).href;

const workletModules = new WeakMap();

/** addModule() once per context and URL. */
export function loadWorkletModule(ctx, url) {
  let mods = workletModules.get(ctx);
  if (!mods) workletModules.set(ctx, (mods = new Map()));
  if (!mods.has(url)) {
    const p = ctx.audioWorklet.addModule(url);
    p.catch(() => mods.delete(url));
    mods.set(url, p);
  }
  return mods.get(url);
}

class SourceChain {
  constructor(engine, p) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;
    this.id = p.id;
    this.kind = p.kind;
    this.channel = null;
    this.in = ctx.createGain();
    this.hpf = p.kind === 'speaker' ? new FilterBank(ctx, BANK_SIZES.xo, `hpf:${p.id}`) : null;
    this.model = new FilterBank(ctx, BANK_SIZES.model, `model:${p.id}`);
    this.trim = ctx.createGain();
    this.amp = new SaturationStage(ctx, p.ampCurve, engine.oversample);
    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 6;
    this.dcBlock.Q.value = -3.01;
    this.driver = new SaturationStage(ctx, 'driver', engine.oversample);
    this.thermal = ctx.createGain();
    this.sens = ctx.createGain();
    this.room = new FilterBank(ctx, BANK_SIZES.room, `room:${p.id}`);
    this.align = ctx.createDelay(MAX_DELAY);
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.prop = ctx.createDelay(MAX_DELAY);
    this.dir = ctx.createBiquadFilter();
    this.air = ctx.createBiquadFilter();
    for (const f of [this.dir, this.air]) {
      f.type = 'highshelf';
      f.gain.value = 0;
    }
    this.panner = ctx.createPanner();
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = REF_DISTANCE;
    this.panner.rolloffFactor = 1;
    this.panner.maxDistance = 10000;
    this.panner.panningModel = engine.panningModel;
    this.send = ctx.createGain();
    this.sendL = ctx.createGain();
    this.sendR = ctx.createGain();

    // Wiring
    let head = this.in;
    if (this.hpf) {
      head.connect(this.hpf.input);
      head = this.hpf.output;
    }
    head.connect(this.model.input);
    this.model.output.connect(this.trim);
    this.trim.connect(this.amp.input);
    this.amp.output.connect(this.dcBlock);
    this.dcBlock.connect(this.driver.input);
    this.driver.output.connect(this.thermal);
    this.thermal.connect(this.sens);
    this.sens.connect(this.room.input);
    this.room.output.connect(this.align);
    this.align.connect(this.fade);
    this.fade.connect(this.prop);
    this.prop.connect(this.dir);
    this.dir.connect(this.air);
    this.air.connect(this.panner);
    this.panner.connect(engine.dryBus);
    // Virtual measurement microphone: omni, 1/r, no HRTF.
    if (engine.micBus) {
      this.micGain = ctx.createGain();
      this.air.connect(this.micGain);
      this.micGain.connect(engine.micBus);
    }
    this.fade.connect(this.send);
    this.send.connect(this.sendL);
    this.send.connect(this.sendR);
    this.sendL.connect(engine.revInL);
    this.sendR.connect(engine.revInR);

    // Meters (realtime only)
    if (!engine.offline) {
      this.ampMeter = ctx.createAnalyser();
      this.ampMeter.fftSize = 512;
      this.amp.drive.connect(this.ampMeter);
      this.drvMeter = ctx.createAnalyser();
      this.drvMeter.fftSize = 512;
      this.driver.drive.connect(this.drvMeter);
      this.buf = new Float32Array(512);
    }
    this.meter = { watts: 0, peakWatts: 0, clipAt: 0, stressAt: 0, temp: 0, thermalDb: 0, ampLoad: 0 };
    this.plan = null;
  }

  connectBus(bus) {
    if (this.bus === bus) return;
    if (this.bus) {
      try {
        this.bus.disconnect(this.in);
      } catch {
        /* not connected */
      }
    }
    this.bus = bus;
    bus.connect(this.in);
  }

  update(p) {
    const ctx = this.ctx;
    this.plan = p;
    if (this.hpf) this.hpf.set(p.hpfSpecs);
    this.model.set(p.modelSpecs);
    setParam(ctx, this.trim.gain, p.trimGain * p.polarity);
    this.amp.setKind(p.ampCurve);
    this.amp.setLevel(p.sClip);
    this.driver.setLevel(p.sDrv);
    setParam(ctx, this.sens.gain, p.sensGain / REF_DISTANCE);
    this.room.set(p.roomSpecs, 0.05);
    setParam(ctx, this.align.delayTime, clamp(p.alignDelay + p.manualDelay, 0, MAX_DELAY - 0.01), 0.04);
    setParam(ctx, this.prop.delayTime, clamp(p.propDelay, 0, MAX_DELAY - 0.01), 0.06);
    for (const [node, spec] of [
      [this.dir, p.dirSpec],
      [this.air, p.airSpec],
    ]) {
      setParam(ctx, node.frequency, spec.frequency, 0.03);
      setParam(ctx, node.gain, spec.gain || 0, 0.03);
    }
    setPannerPosition(ctx, this.panner, p.pos, 0.04);
    if (this.micGain) setParam(ctx, this.micGain.gain, REF_DISTANCE / Math.max(p.distance, REF_DISTANCE), 0.04);
    setParam(ctx, this.send.gain, p.sendGain);
    setParam(ctx, this.sendL.gain, p.sendL);
    setParam(ctx, this.sendR.gain, p.sendR);
    setParam(ctx, this.fade.gain, p.active ? 1 : 0, 0.02);
  }

  setPanningModel(m) {
    if (this.panner.panningModel !== m) this.panner.panningModel = m;
  }

  setOversample(os) {
    this.amp.setOversample(os);
    this.driver.setOversample(os);
  }

  /** Update meter + thermal model. dt seconds. */
  tick(dt, thermalOn) {
    if (!this.ampMeter || !this.plan) return this.meter;
    const p = this.plan;
    const m = this.meter;
    this.ampMeter.getFloatTimeDomainData(this.buf);
    let peak = 0;
    let sq = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i]);
      if (v > peak) peak = v;
      sq += v * v;
    }
    const xr = Math.sqrt(sq / this.buf.length);
    const now = performance.now();
    if (peak > 0.47) m.clipAt = now;
    // Demanded power (W) into the nominal impedance; s = 2·level·x.
    const sRms = 2 * p.sClip * xr;
    const demanded = 200 * sRms * sRms * (8 / p.impedance);
    const delivered = Math.min(demanded, p.ampWatts * 1.25);
    m.watts = m.watts * 0.7 + delivered * 0.3;
    const sPk = 2 * p.sClip * Math.min(peak, 0.5);
    m.peakWatts = Math.max(m.peakWatts * 0.97, 100 * sPk * sPk * (8 / p.impedance));
    m.ampLoad = clamp(peak / 0.5, 0, 1.5);
    this.drvMeter.getFloatTimeDomainData(this.buf);
    let dpk = 0;
    for (let i = 0; i < this.buf.length; i++) dpk = Math.max(dpk, Math.abs(this.buf[i]));
    if (dpk > 0.42) m.stressAt = now;
    // Voice-coil thermal model (first-order, τ = 4 s).
    const rated = this.kind === 'sub' || p.hw.active ? p.ampWatts : p.hw.rmsWatts;
    m.temp += (dt / 4) * (delivered / Math.max(1, rated) - m.temp);
    const target = thermalOn && m.temp > 1 ? -Math.min(6, 4 * (m.temp - 1)) : 0;
    if (Math.abs(target - m.thermalDb) > 0.05) {
      m.thermalDb = target;
      setParam(this.ctx, this.thermal.gain, dbToGain(target), 0.3);
    }
    return m;
  }

  dispose(immediate = false) {
    const nodes = [this.in, this.trim, this.dcBlock, this.thermal, this.sens, this.align, this.fade, this.prop, this.dir, this.air, this.panner, this.send, this.sendL, this.sendR, this.micGain].filter(Boolean);
    const finish = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (this.hpf) this.hpf.disconnect();
      this.model.disconnect();
      this.room.disconnect();
      this.amp.disconnect();
      this.driver.disconnect();
      if (this.ampMeter) this.ampMeter.disconnect();
      if (this.drvMeter) this.drvMeter.disconnect();
      if (this.bus) {
        try {
          this.bus.disconnect(this.in);
        } catch {
          /* ignore */
        }
      }
    };
    if (immediate) finish();
    else {
      setParam(this.ctx, this.fade.gain, 0, 0.01);
      setTimeout(finish, 80);
    }
  }
}

class Reverb {
  constructor(ctx) {
    this.ctx = ctx;
    this.merger = ctx.createChannelMerger(2);
    this.hp = new FilterBank(ctx, 2, 'reverb-hp');
    this.merger.connect(this.hp.input);
    this.convs = [ctx.createConvolver(), ctx.createConvolver()];
    this.gains = [ctx.createGain(), ctx.createGain()];
    this.output = ctx.createGain();
    this.convs.forEach((c, i) => {
      c.normalize = false;
      this.hp.output.connect(c);
      c.connect(this.gains[i]);
      this.gains[i].gain.value = 0;
      this.gains[i].connect(this.output);
    });
    this.active = -1;
    this.info = null;
  }

  setIR(ir) {
    const buf = this.ctx.createBuffer(4, ir.length, ir.sampleRate);
    ir.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
    const next = this.active === 0 ? 1 : 0;
    this.convs[next].buffer = buf;
    if (this.active < 0) {
      this.gains[next].gain.value = 1;
    } else {
      crossfade(this.ctx, this.gains[this.active], this.gains[next], 0.08);
    }
    this.active = next;
    this.info = { rt60: ir.rt60, length: ir.length / ir.sampleRate, erCount: ir.erCount };
  }
}

export class SimulationEngine extends Emitter {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} [opts]
   * @param {import('../acoustics/client.js').AcousticsClient} [opts.acoustics]
   * @param {boolean} [opts.offline]
   * @param {string} [opts.quality] 'high' | 'balanced' | 'eco'
   * @param {boolean} [opts.mic] build a mono measurement-microphone output (`micOut`)
   */
  constructor(ctx, { acoustics = null, offline = false, quality = 'balanced', mic = false } = {}) {
    super();
    this.ctx = ctx;
    this.wantMic = mic;
    this.acoustics = acoustics;
    this.offline = offline;
    this.quality = quality;
    this.oversample = OVERSAMPLE[offline ? 'high' : quality] || '2x';
    this.panningModel = 'HRTF';
    this.chains = new Map();
    this.roomFilters = {};
    this.roomInfo = null;
    this.state = null;
    this.plan = null;
    this.roomKey = '';
    this.irKey = '';
    this.roomTimer = null;
    this.irTimer = null;
    this.directMatch = 1;
    this.meters = { dspOverAt: 0, limiterDb: 0, spl: 0, splPeak: 0, sources: {} };
    this._build();
  }

  _build() {
    const ctx = this.ctx;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.input = g();
    this.input.channelCount = 2;
    this.input.channelCountMode = 'explicit';
    this.inputGain = g();
    this.tone = new FilterBank(ctx, BANK_SIZES.tone, 'tone');
    this.geq = new FilterBank(ctx, BANK_SIZES.geq, 'geq');
    this.peq = new FilterBank(ctx, BANK_SIZES.peq, 'peq');
    this.rc = new FilterBank(ctx, BANK_SIZES.rc, 'room-correction');
    this.eqPre = g();
    this.dspClip = ctx.createWaveShaper();
    this.dspClip.curve = shaperCurve('digital');
    this.master = g(0);
    this.simIn = g();
    this.input.connect(this.inputGain);
    this.inputGain.connect(this.tone.input);
    this.tone.output.connect(this.geq.input);
    this.geq.output.connect(this.peq.input);
    this.peq.output.connect(this.rc.input);
    this.rc.output.connect(this.eqPre);
    this.eqPre.connect(this.dspClip);
    this.dspClip.connect(this.master);
    this.master.connect(this.simIn);

    // Buses
    this.splitter = ctx.createChannelSplitter(2);
    this.simIn.connect(this.splitter);
    this.busL = monoGain(ctx);
    this.busR = monoGain(ctx);
    this.splitter.connect(this.busL, 0);
    this.splitter.connect(this.busR, 1);
    this.busM = monoGain(ctx);
    this.simIn.connect(this.busM);
    // Passive-matrix surround: S = ½(L − R), delayed and band-limited.
    const invR = monoGain(ctx, -1);
    const sDiff = monoGain(ctx, 0.5);
    this.busL.connect(sDiff);
    this.busR.connect(invR).connect(sDiff);
    const sDelay = ctx.createDelay(0.1);
    sDelay.delayTime.value = 0.012;
    const sLp = ctx.createBiquadFilter();
    sLp.type = 'lowpass';
    sLp.frequency.value = 7000;
    sDiff.connect(sDelay).connect(sLp);
    this.busSL = monoGain(ctx);
    this.busSR = monoGain(ctx, -1);
    sLp.connect(this.busSL);
    const srDelay = ctx.createDelay(0.1);
    srDelay.delayTime.value = 0.003;
    sLp.connect(srDelay).connect(this.busSR);
    // LFE / bass management
    this.lfeIn = monoGain(ctx);
    this.simIn.connect(this.lfeIn);
    this.lfe = new FilterBank(ctx, BANK_SIZES.xo, 'lfe-lpf');
    this.lfeIn.connect(this.lfe.input);
    this.lfeOut = g();
    this.lfe.output.connect(this.lfeOut);

    // Acoustic summation
    this.dryBus = g();
    this.revInL = monoGain(ctx);
    this.revInR = monoGain(ctx);
    this.reverb = new Reverb(ctx);
    this.revInL.connect(this.reverb.merger, 0, 0);
    this.revInR.connect(this.reverb.merger, 0, 1);
    this.wet = g(0);
    this.reverb.output.connect(this.wet);
    this.listenerShelf = new FilterBank(ctx, 1, 'listener-boundary');
    this.dryBus.connect(this.listenerShelf.input);
    this.simSum = g();
    this.listenerShelf.output.connect(this.simSum);
    this.wet.connect(this.simSum);
    this.monitorCal = g();
    this.simSum.connect(this.monitorCal);
    if (this.wantMic) {
      // Mono omni mic at the seat, in SPL units (1.0 ≙ 100 dB): direct sound
      // of every source plus the diffuse field of the left-ear reverb.
      this.micBus = monoGain(ctx);
      this.micShelf = new FilterBank(ctx, 1, 'mic-boundary');
      this.micBus.connect(this.micShelf.input);
      this.micOut = monoGain(ctx);
      this.micShelf.output.connect(this.micOut);
      const wetSplit = ctx.createChannelSplitter(2);
      this.wet.connect(wetSplit);
      wetSplit.connect(this.micOut, 0);
    }
    this.simX = g(1);
    this.monitorCal.connect(this.simX);

    // Direct (bypass) path
    this.direct = g(1);
    this.directX = g(0);
    this.input.connect(this.direct).connect(this.directX);

    // Mix, taps, volume, protection limiter
    this.mix = g();
    this.simX.connect(this.mix);
    this.directX.connect(this.mix);
    this.volume = g(1);
    this.mix.connect(this.volume);
    // Output protection: the true-peak lookahead limiter worklet is swapped in
    // as soon as its module loads; a DynamicsCompressor covers the meantime
    // (and browsers without AudioWorklet).
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.knee.value = 0;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.limiterComp = g(1);
    this.fallbackOut = g(1);
    this.output = g();
    this.volume.connect(this.limiter).connect(this.limiterComp).connect(this.fallbackOut).connect(this.output);
    this.tpLimiter = null;
    this.tpStats = null;
    this.limiterCfg = { enabled: true, ceilingDb: -1 };
    this._configureFallbackLimiter();

    if (!this.offline) this._buildTaps();
    this.ready = this._attachLimiter();
  }

  _configureFallbackLimiter() {
    const { enabled, ceilingDb } = this.limiterCfg;
    // The compressor overshoots on fast transients, so it aims 1 dB lower.
    const T = enabled ? ceilingDb - 1 : 0;
    const R = enabled ? 20 : 1;
    this.limiter.threshold.value = T;
    this.limiter.ratio.value = R;
    // Cancel the compressor's automatic make-up gain: 0.6·(−(T + (0−T)/R)).
    this.limiterComp.gain.value = dbToGain(-0.6 * -(T - T / R));
  }

  async _attachLimiter() {
    const ctx = this.ctx;
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    try {
      await loadWorkletModule(ctx, LIMITER_URL);
      if (this.disposed) return false;
      const node = new AudioWorkletNode(ctx, 'audiospace-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { ceilingDb: this.limiterCfg.ceilingDb, releaseMs: 80, lookaheadMs: 2.5, holdMs: 5 },
      });
      node.port.postMessage({ enabled: this.limiterCfg.enabled });
      node.port.onmessage = (e) => {
        if (e.data?.type === 'stats') this.tpStats = e.data;
      };
      const out = ctx.createGain();
      out.gain.value = 0;
      this.volume.connect(node).connect(out).connect(this.output);
      this.tpLimiter = node;
      this.tpOut = out;
      crossfade(ctx, this.fallbackOut, out, 0.03);
      const detach = () => {
        try {
          this.volume.disconnect(this.limiter);
        } catch {
          /* already detached */
        }
      };
      if (this.offline) detach();
      else setTimeout(detach, 250);
      return true;
    } catch (err) {
      console.warn('[engine] true-peak limiter unavailable, using DynamicsCompressor', err);
      return false;
    }
  }

  _setLimiter(enabled, ceilingDb) {
    const cfg = this.limiterCfg;
    if (cfg.enabled === enabled && cfg.ceilingDb === ceilingDb) return;
    cfg.enabled = enabled;
    cfg.ceilingDb = ceilingDb;
    this._configureFallbackLimiter();
    this.tpLimiter?.port.postMessage({ enabled, ceilingDb });
  }

  _buildTaps() {
    const ctx = this.ctx;
    const an = (size, smoothing = 0) => {
      const a = ctx.createAnalyser();
      a.fftSize = size;
      a.smoothingTimeConstant = smoothing;
      a.minDecibels = -110;
      a.maxDecibels = -10;
      return a;
    };
    const split = ctx.createChannelSplitter(2);
    this.mix.connect(split);
    const dspSplit = ctx.createChannelSplitter(2);
    this.eqPre.connect(dspSplit);
    this.taps = {
      L: an(2048),
      R: an(2048),
      spectrum: an(8192, 0.6),
      source: an(8192, 0.6),
      spl: an(4096),
      lfe: an(1024),
      dspL: an(256),
      dspR: an(256),
      kL: an(32768),
      kR: an(32768),
      srcRms: an(2048),
      mixRms: an(2048),
    };
    split.connect(this.taps.L, 0);
    split.connect(this.taps.R, 1);
    this.mix.connect(this.taps.spectrum);
    this.input.connect(this.taps.source);
    this.simSum.connect(this.taps.spl);
    this.lfeOut.connect(this.taps.lfe);
    dspSplit.connect(this.taps.dspL, 0);
    dspSplit.connect(this.taps.dspR, 1);
    this.input.connect(this.taps.srcRms);
    this.monitorCal.connect(this.taps.mixRms);
    // K-weighting (ITU-R BS.1770): high-shelf +4 dB @ 1.68 kHz, RLB high-pass 38 Hz.
    for (const [ch, tap] of [
      [0, this.taps.kL],
      [1, this.taps.kR],
    ]) {
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1681.97;
      shelf.gain.value = 4;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 38.13;
      hp.Q.value = 20 * Math.log10(0.5003);
      split.connect(shelf, ch);
      shelf.connect(hp).connect(tap);
    }
    this.tmp = new Float32Array(2048);
    this.tmpSmall = new Float32Array(256);
    this.meterTimer = setInterval(() => this._tickMeters(), 50);
    this.lastTick = performance.now();
  }

  // ------------------------------------------------------------ state

  /**
   * Apply application state. In offline mode room filters and the IR are
   * computed synchronously so the returned promise resolves render-ready.
   */
  async applyState(state) {
    this.state = state;
    if (this.offline) {
      const plan0 = buildPlan(state, { sampleRate: this.ctx.sampleRate });
      if (state.room.modes) {
        const res = computeRoomFilters(this._roomJob(state));
        this.roomFilters = res.results;
        this.roomInfo = res;
      }
      if (state.room.reverb.enabled) this.reverb.setIR(computeIR(this._irJob(state, plan0)));
    }
    this._applyPlan();
    if (!this.offline) {
      this._scheduleRoomFilters();
      this._scheduleIR();
    }
  }

  _applyPlan() {
    const state = this.state;
    const plan = buildPlan(state, { sampleRate: this.ctx.sampleRate, roomFilters: this.roomFilters });
    this.plan = plan;
    const ctx = this.ctx;
    // Quality / panning
    const os = OVERSAMPLE[this.offline ? 'high' : state.engine.quality] || '2x';
    if (os !== this.oversample) {
      this.oversample = os;
      for (const c of this.chains.values()) c.setOversample(os);
    }
    if (plan.panningModel !== this.panningModel) {
      this.panningModel = plan.panningModel;
      for (const c of this.chains.values()) c.setPanningModel(plan.panningModel);
    }
    // Master
    setParam(ctx, this.inputGain.gain, plan.inputGain);
    this.tone.set(plan.toneSpecs);
    this.geq.set(plan.geqSpecs);
    this.peq.set(plan.peqSpecs);
    this.rc.set(plan.rcSpecs);
    setParam(ctx, this.eqPre.gain, plan.eqPreampGain, 0.03);
    setParam(ctx, this.master.gain, plan.masterGain, 0.03);
    this.lfe.set(plan.lfeSpecs);
    setParam(ctx, this.monitorCal.gain, plan.monitorCal);
    setParam(ctx, this.wet.gain, plan.reverb.wetGain, 0.05);
    this.reverb.hp.set(plan.reverb.hpSpecs);
    setListenerPose(ctx, ctx.listener, plan.listener, plan.listener.yaw, 0.04);
    // Listener boundary (only when the modal model is off; the modal model includes it).
    let lshelf = [];
    if (!state.room.modes && state.room.boundary) {
      const bg = boundaryGain(state.room, plan.listener);
      if (bg.gainDb > 0.1) lshelf = [{ type: 'lowshelf', frequency: bg.cornerFreq, gain: bg.gainDb * 0.5 }];
    }
    this.listenerShelf.set(lshelf);
    this.micShelf?.set(lshelf);
    // Simulation vs direct
    this._setSimulation(plan.simulation);
    // Volume
    const pl = state.player;
    const vol = pl.muted ? 0 : Math.pow(clamp(pl.volume ?? 0.8, 0, 1), 2);
    setParam(ctx, this.volume.gain, vol, 0.02);
    this._setLimiter(state.engine.limiter !== false, clamp(state.engine.ceilingDb ?? -1, -12, 0));
    this._reconcileSources(plan);
  }

  _setSimulation(on) {
    if (this.simOn === on) return;
    this.simOn = on;
    const ctx = this.ctx;
    if (on) crossfade(ctx, this.directX, this.simX, 0.04);
    else crossfade(ctx, this.simX, this.directX, 0.04);
  }

  _busFor(channel, kind) {
    if (kind === 'sub') return this.lfeOut;
    switch (channel) {
      case 'L':
        return this.busL;
      case 'R':
        return this.busR;
      case 'SL':
        return this.busSL;
      case 'SR':
        return this.busSR;
      default:
        return this.busM;
    }
  }

  _reconcileSources(plan) {
    const seen = new Set();
    for (const p of plan.sources) {
      seen.add(p.id);
      let chain = this.chains.get(p.id);
      if (chain && chain.kind !== p.kind) {
        chain.dispose(this.offline);
        this.chains.delete(p.id);
        chain = null;
      }
      if (!chain) {
        chain = new SourceChain(this, p);
        this.chains.set(p.id, chain);
      }
      chain.connectBus(this._busFor(p.channel, p.kind));
      chain.update(p);
    }
    for (const [id, chain] of this.chains) {
      if (!seen.has(id)) {
        chain.dispose(this.offline);
        this.chains.delete(id);
        delete this.meters.sources[id];
      }
    }
  }

  // ------------------------------------------------------ acoustics jobs

  _roomJob(state) {
    return {
      room: state.room,
      listener: { x: state.listener.x, y: state.listener.y, z: state.listener.z },
      sampleRate: this.ctx.sampleRate,
      maxFilters: BANK_SIZES.room,
      sources: [...state.speakers, ...state.subs].map((s) => ({ id: s.id, pos: { x: s.x, y: s.y, z: s.z } })),
    };
  }

  _irJob(state, plan) {
    const { srcL, srcR } = reverbSourcePositions(plan);
    return {
      room: state.room,
      sampleRate: this.ctx.sampleRate,
      srcL,
      srcR,
      listener: { x: state.listener.x, y: state.listener.y, z: state.listener.z, yaw: state.listener.yaw || 0 },
      erOrder: state.room.reverb.erOrder ?? 3,
      maxLength: 6,
    };
  }

  _scheduleRoomFilters() {
    const state = this.state;
    if (!state.room.modes) {
      if (Object.keys(this.roomFilters).length) {
        this.roomFilters = {};
        this.roomKey = '';
      }
      return;
    }
    const job = this._roomJob(state);
    const key = JSON.stringify(job);
    if (key === this.roomKey) return;
    this.roomKey = key;
    clearTimeout(this.roomTimer);
    this.roomTimer = setTimeout(async () => {
      try {
        const res = this.acoustics ? await this.acoustics.run('roomFilters', job, 'roomFilters') : computeRoomFilters(job);
        if (!res || key !== this.roomKey) return;
        this.roomFilters = res.results;
        this.roomInfo = res;
        this._applyPlan();
        this.emit('room-filters', res);
      } catch (err) {
        console.error('[engine] room filter computation failed', err);
      }
    }, 90);
  }

  _scheduleIR() {
    const state = this.state;
    if (!state.room.reverb.enabled) return;
    const job = this._irJob(state, this.plan);
    // Quantise positions so tiny drags don't regenerate the IR constantly.
    const q = (p) => [Math.round(p.x * 10), Math.round(p.y * 10), Math.round(p.z * 10)];
    const key = JSON.stringify([job.room.width, job.room.depth, job.room.height, job.room.materials, job.room.temperature, job.erOrder, q(job.srcL), q(job.srcR), q(job.listener), Math.round(job.listener.yaw / 5)]);
    if (key === this.irKey) return;
    this.irKey = key;
    clearTimeout(this.irTimer);
    this.irTimer = setTimeout(async () => {
      try {
        const ir = this.acoustics ? await this.acoustics.run('ir', job, 'ir') : computeIR(job);
        if (!ir || key !== this.irKey) return;
        this.reverb.setIR(ir);
        this.emit('ir', this.reverb.info);
      } catch (err) {
        console.error('[engine] IR synthesis failed', err);
      }
    }, 160);
  }

  // ------------------------------------------------------------ metering

  _tickMeters() {
    if (this.ctx.state !== 'running') return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const thermalOn = this.state?.receiver?.thermal !== false;
    for (const [id, chain] of this.chains) this.meters.sources[id] = chain.tick(dt, thermalOn);
    // DSP overload (pre-clip peak > 0 dBFS)
    for (const a of [this.taps.dspL, this.taps.dspR]) {
      a.getFloatTimeDomainData(this.tmpSmall);
      for (let i = 0; i < this.tmpSmall.length; i++) {
        if (Math.abs(this.tmpSmall[i]) > 1) {
          this.meters.dspOverAt = now;
          break;
        }
      }
    }
    if (this.tpLimiter) {
      const s = this.tpStats;
      this.meters.limiterDb = s ? 20 * Math.log10(Math.max(s.minGain, 1e-6)) : 0;
      this.meters.outPeakDb = s && s.outPeak > 0 ? 20 * Math.log10(s.outPeak) : -Infinity;
    } else {
      this.meters.limiterDb = this.limiter.reduction;
    }
    // SPL at the listening position (Z-weighted, fast).
    this.taps.spl.getFloatTimeDomainData(this.tmp);
    let sq = 0;
    for (let i = 0; i < 2048; i++) sq += this.tmp[i] * this.tmp[i];
    const rms = Math.sqrt(sq / 2048);
    const spl = rms > 1e-7 ? 100 + 20 * Math.log10(rms) : 0;
    this.meters.spl = this.meters.spl * 0.75 + spl * 0.25;
    this.meters.splPeak = Math.max(this.meters.splPeak - 0.05, spl);
    // Automatic A/B level matching of the bypass path.
    if (this.state?.engine?.levelMatch !== false && this.simOn) {
      this.taps.srcRms.getFloatTimeDomainData(this.tmp);
      let s1 = 0;
      for (let i = 0; i < 2048; i++) s1 += this.tmp[i] * this.tmp[i];
      this.taps.mixRms.getFloatTimeDomainData(this.tmp);
      let s2 = 0;
      for (let i = 0; i < 2048; i++) s2 += this.tmp[i] * this.tmp[i];
      if (s1 > 1e-8 && s2 > 1e-10) {
        const ratio = clamp(Math.sqrt(s2 / s1), 0.01, 10);
        this.directMatch = this.directMatch * 0.95 + ratio * 0.05;
        setParam(this.ctx, this.direct.gain, this.directMatch, 0.2);
      }
    } else if (this.state?.engine?.levelMatch === false) {
      setParam(this.ctx, this.direct.gain, 1, 0.05);
    }
    this.emit('meters', this.meters);
  }

  /** Recording tap (MediaStream) of the final output. */
  getStreamDestination() {
    if (!this.streamDest) {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.output.connect(this.streamDest);
    }
    return this.streamDest;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.meterTimer);
    clearTimeout(this.roomTimer);
    clearTimeout(this.irTimer);
    for (const c of this.chains.values()) c.dispose(true);
    this.chains.clear();
    try {
      this.output.disconnect();
    } catch {
      /* ignore */
    }
    if (this.tpLimiter) {
      this.tpLimiter.port.onmessage = null;
      this.tpLimiter.port.postMessage({ dispose: true });
      this.tpLimiter.port.close();
      this.tpLimiter.disconnect();
    }
    this.removeAll();
  }
}
