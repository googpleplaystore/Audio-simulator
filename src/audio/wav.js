// WAV (RIFF) encoder: 16/24-bit PCM with TPDF dither, or 32-bit float, plus
// optional LIST/INFO metadata.

function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i) & 0xff);
}

function infoChunk(meta) {
  const map = { title: 'INAM', artist: 'IART', album: 'IPRD', comment: 'ICMT', software: 'ISFT', date: 'ICRD', genre: 'IGNR' };
  const subs = [];
  for (const [k, id] of Object.entries(map)) {
    if (!meta[k]) continue;
    const bytes = new TextEncoder().encode(String(meta[k]));
    const len = bytes.length + 1;
    const padded = len + (len & 1);
    const buf = new Uint8Array(8 + padded);
    const dv = new DataView(buf.buffer);
    writeStr(dv, 0, id);
    dv.setUint32(4, len, true);
    buf.set(bytes, 8);
    subs.push(buf);
  }
  if (!subs.length) return null;
  const bodyLen = 4 + subs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  writeStr(dv, 0, 'LIST');
  dv.setUint32(4, bodyLen, true);
  writeStr(dv, 8, 'INFO');
  let o = 12;
  for (const s of subs) {
    out.set(s, o);
    o += s.length;
  }
  return out;
}

/**
 * @param {{numberOfChannels:number, sampleRate:number, getChannelData:(i:number)=>Float32Array, length:number}|{channels:Float32Array[], sampleRate:number}} audio
 * @param {{bitDepth?:16|24|32, dither?:boolean, meta?:object}} opts
 * @returns {Blob}
 */
export function encodeWav(audio, opts = {}) {
  const channels = audio.channels || Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const sampleRate = audio.sampleRate;
  const bitDepth = opts.bitDepth || 16;
  const float = bitDepth === 32;
  const dither = opts.dither !== false && !float;
  const nCh = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = nCh * bytesPerSample;
  const dataLen = frames * blockAlign;
  const info = opts.meta ? infoChunk(opts.meta) : null;
  const infoLen = info ? info.length : 0;
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + infoLen + dataLen, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, float ? 3 : 1, true);
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, dataLen, true);

  // Encode in chunks to keep memory bounded.
  const parts = [];
  const CHUNK = 65536;
  let seed = 22222;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const scale = bitDepth === 16 ? 32767 : 8388607;
  const lsb = 1 / scale;
  for (let start = 0; start < frames; start += CHUNK) {
    const n = Math.min(CHUNK, frames - start);
    const buf = new ArrayBuffer(n * blockAlign);
    const out = new DataView(buf);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nCh; c++) {
        let s = channels[c][start + i];
        if (float) {
          out.setFloat32(o, s, true);
          o += 4;
          continue;
        }
        if (dither) s += (rnd() - rnd()) * lsb;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        const v = Math.round(s * scale);
        if (bitDepth === 16) {
          out.setInt16(o, v, true);
          o += 2;
        } else {
          out.setUint8(o, v & 0xff);
          out.setUint8(o + 1, (v >> 8) & 0xff);
          out.setUint8(o + 2, (v >> 16) & 0xff);
          o += 3;
        }
      }
    }
    parts.push(buf);
  }
  // Header must precede the INFO chunk; move the "data" header after INFO.
  if (info) {
    const pre = header.slice(0, 36);
    const dataHdr = header.slice(36, 44);
    return new Blob([pre, info, dataHdr, ...parts], { type: 'audio/wav' });
  }
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

/** Decode a PCM WAV ArrayBuffer (16/24/32f) — used by tests and IR import. */
export function decodeWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(arrayBuffer, o, n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= dv.byteLength) {
    const id = str(p, 4);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(p + 8, true), channels: dv.getUint16(p + 10, true), sampleRate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    else if (id === 'data') data = { offset: p + 8, size };
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('Malformed WAV');
  const bps = fmt.bits / 8;
  const frames = Math.floor(data.size / (bps * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let o = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      let v;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
      else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) {
        let x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else v = dv.getInt32(o, true) / 2147483648;
      channels[c][i] = v;
      o += bps;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}
