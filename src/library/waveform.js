// Waveform peak extraction for the seek bar. Audio is decoded at a low sample
// rate (to bound memory), reduced to per-bin peak/RMS pairs and cached in
// IndexedDB. Decodes are serialised so only one track is in memory at a time.

const MAX_DECODE_BYTES = 200 * 1024 * 1024;
export const WAVEFORM_BINS = 1200;

function offlineCtor() {
  return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
}

async function decodeLowRate(arrayBuffer) {
  const Ctor = offlineCtor();
  if (!Ctor) throw new Error('OfflineAudioContext unavailable');
  let lastErr;
  for (const rate of [8000, 22050, 44100]) {
    try {
      const ctx = new Ctor(1, 1, rate);
      // decodeAudioData detaches the buffer, so hand it a copy for retries.
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Reduce an AudioBuffer-like object to [peak, rms] pairs per bin. */
export function peaksFromBuffer(audio, bins = WAVEFORM_BINS) {
  const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const n = audio.length;
  const out = new Float32Array(bins * 2);
  const per = n / bins;
  let globalMax = 0;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * per);
    const e = Math.max(s + 1, Math.floor((b + 1) * per));
    let peak = 0;
    let sq = 0;
    let cnt = 0;
    for (const ch of chans) {
      for (let i = s; i < e && i < n; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
        sq += v * v;
        cnt++;
      }
    }
    out[b * 2] = peak;
    out[b * 2 + 1] = cnt ? Math.sqrt(sq / cnt) : 0;
    if (peak > globalMax) globalMax = peak;
  }
  return out;
}

export class WaveformStore {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.queue = Promise.resolve();
  }

  async get(trackId, getBlob) {
    if (this.cache.has(trackId)) return this.cache.get(trackId);
    const rec = await this.db.get('waveforms', trackId);
    if (rec && rec.peaks) {
      this._remember(trackId, rec.peaks);
      return rec.peaks;
    }
    // Serialise decodes to avoid holding several decoded tracks at once.
    const job = this.queue.then(async () => {
      if (this.cache.has(trackId)) return this.cache.get(trackId);
      const blob = await getBlob();
      if (!blob || blob.size > MAX_DECODE_BYTES) return null;
      let audio = await decodeLowRate(await blob.arrayBuffer());
      const peaks = peaksFromBuffer(audio);
      audio = null;
      await this.db.put('waveforms', { id: trackId, peaks });
      this._remember(trackId, peaks);
      return peaks;
    });
    this.queue = job.catch(() => null);
    return job;
  }

  _remember(id, peaks) {
    this.cache.set(id, peaks);
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
  }
}
