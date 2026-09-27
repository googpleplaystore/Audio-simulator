// Ogg Vorbis / Opus: identification + comment headers and duration from the
// last page's granule position.

import { startsWith, u32le, u64le, u16le, indexOfBytes } from './reader.js';
import { parseVorbisComment, vorbisToTags } from './vorbis.js';

/** Extract the first `count` packets of the first logical stream from bytes. */
function firstPackets(b, count) {
  const packets = [];
  let current = [];
  let p = 0;
  let serial = null;
  while (p + 27 <= b.length && packets.length < count) {
    if (!startsWith(b, 'OggS', p)) {
      const next = indexOfBytes(b, 'OggS', p + 1);
      if (next < 0) break;
      p = next;
      continue;
    }
    const segs = b[p + 26];
    const pageSerial = u32le(b, p + 14);
    const tableStart = p + 27;
    let dataPos = tableStart + segs;
    if (serial === null) serial = pageSerial;
    const mine = pageSerial === serial;
    for (let i = 0; i < segs; i++) {
      const len = b[tableStart + i];
      if (mine) current.push(b.subarray(dataPos, dataPos + len));
      dataPos += len;
      if (len < 255 && mine) {
        const total = current.reduce((s, c) => s + c.length, 0);
        const pkt = new Uint8Array(total);
        let o = 0;
        for (const c of current) {
          pkt.set(c, o);
          o += c.length;
        }
        packets.push(pkt);
        current = [];
        if (packets.length >= count) break;
      }
    }
    p = dataPos;
  }
  return { packets, serial };
}

export async function parseOgg(reader) {
  const head = await reader.read(0, Math.min(reader.size, 2 * 1024 * 1024));
  if (!startsWith(head, 'OggS')) return null;
  const { packets, serial } = firstPackets(head, 2);
  if (!packets.length) return { format: 'ogg', codec: 'Ogg' };
  const id = packets[0];
  const out = { format: 'ogg' };
  let rate = 0;
  let preSkip = 0;
  if (id[0] === 1 && startsWith(id, 'vorbis', 1)) {
    out.codec = 'Vorbis';
    out.channels = id[11];
    out.sampleRate = u32le(id, 12);
    rate = out.sampleRate;
    const nominal = u32le(id, 20);
    if (nominal > 0 && nominal < 2000000) out.bitrate = Math.round(nominal / 1000);
    if (packets[1] && packets[1][0] === 3 && startsWith(packets[1], 'vorbis', 1)) {
      Object.assign(out, vorbisToTags(parseVorbisComment(packets[1], 7).fields));
    }
  } else if (startsWith(id, 'OpusHead')) {
    out.codec = 'Opus';
    out.format = 'opus';
    out.channels = id[9];
    preSkip = u16le(id, 10);
    out.sampleRate = u32le(id, 12) || 48000;
    rate = 48000;
    if (packets[1] && startsWith(packets[1], 'OpusTags')) {
      Object.assign(out, vorbisToTags(parseVorbisComment(packets[1], 8).fields));
    }
  } else if (id[0] === 0x7f && startsWith(id, 'FLAC', 1)) {
    out.codec = 'FLAC (Ogg)';
  }
  // Duration: find the last page of this stream.
  if (rate) {
    const tailLen = Math.min(reader.size, 256 * 1024);
    const tail = await reader.read(reader.size - tailLen, tailLen);
    let idx = tail.length - 27;
    while (idx >= 0) {
      if (startsWith(tail, 'OggS', idx) && u32le(tail, idx + 14) === serial) {
        const granule = u64le(tail, idx + 6);
        if (granule > 0 && granule < 2 ** 52) {
          out.duration = Math.max(0, granule - preSkip) / rate;
          if (!out.bitrate && out.duration > 0) out.bitrate = Math.round((reader.size * 8) / out.duration / 1000);
        }
        break;
      }
      idx--;
    }
  }
  return out;
}
