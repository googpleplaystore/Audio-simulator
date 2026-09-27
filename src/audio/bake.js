// "Bake" the full simulation (room, speakers, amps, EQ, reverb) into an
// audio file with OfflineAudioContext — faster than realtime and bit-exact
// with what the realtime engine plays.

import { SimulationEngine } from './engine.js';
import { encodeWav } from './wav.js';
import { computeIR } from '../acoustics/compute.js';
import { buildPlan, reverbSourcePositions } from './plan.js';
import { truePeak } from './worklets/limiter.worklet.js';

function offlineCtor() {
  return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
}

export async function decodeBlob(blob, sampleRate) {
  const Ctor = offlineCtor();
  const tmp = new Ctor(2, 1, sampleRate);
  return tmp.decodeAudioData(await blob.arrayBuffer());
}

/**
 * @param {object} o
 * @param {Blob} o.blob source audio file
 * @param {object} o.state application state snapshot
 * @param {number} [o.sampleRate=48000]
 * @param {16|24|32} [o.bitDepth=24]
 * @param {number} [o.start=0] seconds
 * @param {number|null} [o.duration=null] seconds (null = to end)
 * @param {number} [o.tail=1.5] extra seconds for reverb tail
 * @param {boolean} [o.normalize=false] normalise the true peak to −1 dBTP
 * @param {'headphones'|'speakers'} [o.output]
 * @param {(p:number)=>void} [o.onProgress]
 * @param {{cancelled:boolean}} [o.token]
 */
export async function bakeTrack(o) {
  const { blob, sampleRate = 48000, bitDepth = 24, start = 0, tail = 1.5, normalize = false, onProgress, token, meta = {} } = o;
  const state = JSON.parse(JSON.stringify(o.state));
  state.player.volume = 1;
  state.player.muted = false;
  state.engine.simulation = true;
  if (o.output) state.engine.output = o.output;
  onProgress?.(0, 'Decoding source…');
  const src = await decodeBlob(blob, sampleRate);
  if (token?.cancelled) throw new Error('Cancelled');
  const dur = Math.max(0.1, Math.min(o.duration ?? src.duration - start, src.duration - start));
  const total = dur + tail;
  const Ctor = offlineCtor();
  const ctx = new Ctor(2, Math.ceil(total * sampleRate), sampleRate);
  onProgress?.(0.02, 'Building room model…');
  const engine = new SimulationEngine(ctx, { offline: true, quality: 'high' });
  await engine.applyState(state);
  await engine.ready;
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(engine.input);
  engine.output.connect(ctx.destination);
  node.start(0, start, dur);
  // Progress via scheduled suspensions.
  const step = Math.max(0.5, total / 40);
  for (let t = step; t < total - 0.05; t += step) {
    const at = t;
    ctx
      .suspend(at)
      .then(() => {
        onProgress?.(0.05 + 0.85 * (at / total), 'Rendering…');
        ctx.resume();
      })
      .catch(() => {});
  }
  const rendered = await ctx.startRendering();
  if (token?.cancelled) throw new Error('Cancelled');
  onProgress?.(0.92, 'Measuring true peak…');
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  let truePeakDb = truePeak(channels);
  // Normalise the true peak (not just the sample peak) to −1 dBTP.
  let gain = 1;
  if (normalize && Number.isFinite(truePeakDb)) gain = Math.pow(10, (-1 - truePeakDb) / 20);
  if (gain !== 1) {
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
    truePeakDb += 20 * Math.log10(gain);
  }
  onProgress?.(0.95, 'Encoding WAV…');
  const out = encodeWav({ channels, sampleRate }, { bitDepth, meta: { software: 'AudioSpace Simulator', ...meta } });
  onProgress?.(1, 'Done');
  engine.dispose();
  return { blob: out, peakDb: 20 * Math.log10(Math.max(peak * gain, 1e-9)), truePeakDb, duration: total, sampleRate };
}

/** Export the synthesised room impulse response (4-ch true stereo, incl. direct sound). */
export function exportImpulseResponse(state, sampleRate = 48000) {
  const plan = buildPlan(state, { sampleRate });
  const { srcL, srcR } = reverbSourcePositions(plan);
  const ir = computeIR({
    room: state.room,
    sampleRate,
    srcL,
    srcR,
    listener: { ...state.listener },
    erOrder: state.room.reverb.erOrder ?? 3,
    includeDirect: true,
    maxLength: 8,
  });
  return encodeWav({ channels: ir.channels, sampleRate }, { bitDepth: 32, meta: { title: `AudioSpace IR – ${state.room.preset || 'custom room'}`, software: 'AudioSpace Simulator' } });
}

/**
 * Realtime recorder of the engine output using an AudioWorklet (lossless),
 * falling back to MediaRecorder when worklets are unavailable.
 */
export class LiveRecorder {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.chunks = [[], []];
    this.frames = 0;
    this.node = null;
    this.recording = false;
    this.mediaRecorder = null;
  }

  async start() {
    if (this.recording) return;
    this.chunks = [[], []];
    this.frames = 0;
    if (this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule(new URL('./worklets/recorder.worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.ctx, 'audiospace-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      this.node.port.onmessage = (e) => {
        const [l, r] = e.data;
        this.chunks[0].push(l);
        this.chunks[1].push(r);
        this.frames += l.length;
      };
      this.engine.output.connect(this.node);
      this.node.port.postMessage('start');
      this.mode = 'wav';
    } else {
      const dest = this.engine.getStreamDestination();
      this.mediaRecorder = new MediaRecorder(dest.stream);
      this.mrChunks = [];
      this.mediaRecorder.ondataavailable = (e) => this.mrChunks.push(e.data);
      this.mediaRecorder.start(250);
      this.mode = 'webm';
    }
    this.recording = true;
    this.startedAt = performance.now();
  }

  get seconds() {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : this.frames / this.ctx.sampleRate;
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    if (this.mode === 'webm') {
      await new Promise((resolve) => {
        this.mediaRecorder.onstop = resolve;
        this.mediaRecorder.stop();
      });
      return new Blob(this.mrChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
    }
    this.node.port.postMessage('stop');
    await new Promise((r) => setTimeout(r, 60));
    try {
      this.engine.output.disconnect(this.node);
    } catch {
      /* ignore */
    }
    this.node.port.onmessage = null;
    this.node = null;
    const join = (list) => {
      const out = new Float32Array(this.frames);
      let o = 0;
      for (const c of list) {
        out.set(c.subarray(0, Math.min(c.length, this.frames - o)), o);
        o += c.length;
      }
      return out;
    };
    const blob = encodeWav({ channels: [join(this.chunks[0]), join(this.chunks[1])], sampleRate: this.ctx.sampleRate }, { bitDepth: 24, meta: { software: 'AudioSpace Simulator (live recording)' } });
    this.chunks = [[], []];
    return blob;
  }
}
