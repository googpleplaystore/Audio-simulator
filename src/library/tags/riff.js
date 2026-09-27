// RIFF/WAVE (incl. RF64) and AIFF container parsing.

import { latin1, u16le, u32le, u64le, u32be, u16be, decodeText, cleanText, startsWith } from './reader.js';
import { parseId3v2 } from './id3.js';
import { parseNumberPair } from './reader.js';
import { normalizeGenre } from './genres.js';

const INFO_MAP = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICRD: 'year', ITRK: 'track', IPRT: 'track', ICMT: 'comment', ICMP: 'composer' };

export async function parseWav(reader) {
  const head = await reader.read(0, 12);
  const rf64 = startsWith(head, 'RF64');
  if (!(startsWith(head, 'RIFF') || rf64) || !startsWith(head, 'WAVE', 8)) return null;
  const out = { format: 'wav', codec: 'PCM' };
  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;
  let ds64Data = 0;
  let guard = 0;
  while (pos + 8 <= reader.size && guard++ < 512) {
    const ch = await reader.read(pos, 8);
    const id = latin1(ch, 0, 4);
    let size = u32le(ch, 4);
    const dataPos = pos + 8;
    if (id === 'ds64') {
      const b = await reader.read(dataPos, Math.min(size, 28));
      ds64Data = u64le(b, 8);
    } else if (id === 'fmt ') {
      const b = await reader.read(dataPos, Math.min(size, 40));
      const fmtTag = u16le(b, 0);
      out.channels = u16le(b, 2);
      out.sampleRate = u32le(b, 4);
      byteRate = u32le(b, 8);
      out.bitsPerSample = u16le(b, 14);
      let tag = fmtTag;
      if (fmtTag === 0xfffe && b.length >= 26) tag = u16le(b, 24);
      out.codec = tag === 3 ? 'PCM Float' : tag === 1 ? 'PCM' : tag === 0x55 ? 'MP3 in WAV' : `WAV (0x${tag.toString(16)})`;
    } else if (id === 'data') {
      if (rf64 && size === 0xffffffff) size = ds64Data;
      dataSize = size;
    } else if (id === 'LIST') {
      const b = await reader.read(dataPos, Math.min(size, 1024 * 1024));
      if (latin1(b, 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const sid = latin1(b, p, p + 4);
          const slen = u32le(b, p + 4);
          const val = cleanText(decodeText(b.subarray(p + 8, p + 8 + slen), 3).replace(/\u0000.*$/s, ''));
          const key = INFO_MAP[sid];
          if (key && val) {
            if (key === 'year') {
              const m = val.match(/\d{4}/);
              if (m) out.year = Number(m[0]);
            } else if (key === 'track') {
              [out.track] = parseNumberPair(val);
            } else if (key === 'genre') out.genre = normalizeGenre(val);
            else out[key] = val;
          }
          p += 8 + slen + (slen & 1);
        }
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const b = await reader.read(dataPos, Math.min(size, 32 * 1024 * 1024));
      const t = parseId3v2(b);
      if (t) Object.assign(out, t);
    }
    pos = dataPos + size + (size & 1);
  }
  if (byteRate && dataSize) {
    out.duration = dataSize / byteRate;
    out.bitrate = Math.round((byteRate * 8) / 1000);
  }
  return out;
}

/** 80-bit IEEE 754 extended to number (AIFF sample rate). */
function extended80(b, o) {
  const exp = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = u32be(b, o + 2);
  const lo = u32be(b, o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const f = (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  return b[o] & 0x80 ? -f : f;
}

export async function parseAiff(reader) {
  const head = await reader.read(0, 12);
  if (!startsWith(head, 'FORM') || !(startsWith(head, 'AIFF', 8) || startsWith(head, 'AIFC', 8))) return null;
  const out = { format: 'aiff', codec: 'PCM' };
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= reader.size && guard++ < 512) {
    const ch = await reader.read(pos, 8);
    const id = latin1(ch, 0, 4);
    const size = u32be(ch, 4);
    const dataPos = pos + 8;
    if (id === 'COMM') {
      const b = await reader.read(dataPos, Math.min(size, 64));
      out.channels = u16be(b, 0);
      const frames = u32be(b, 2);
      out.bitsPerSample = u16be(b, 6);
      out.sampleRate = Math.round(extended80(b, 8));
      if (out.sampleRate) out.duration = frames / out.sampleRate;
    } else if (id === 'ID3 ' || id === 'id3 ') {
      const b = await reader.read(dataPos, Math.min(size, 32 * 1024 * 1024));
      const t = parseId3v2(b);
      if (t) Object.assign(out, t);
    } else if (id === 'NAME') {
      const b = await reader.read(dataPos, size);
      out.title ||= cleanText(decodeText(b, 0));
    } else if (id === 'AUTH') {
      const b = await reader.read(dataPos, size);
      out.artist ||= cleanText(decodeText(b, 0));
    }
    pos = dataPos + size + (size & 1);
  }
  if (out.duration && out.sampleRate && out.channels && out.bitsPerSample) {
    out.bitrate = Math.round((out.sampleRate * out.channels * out.bitsPerSample) / 1000);
  }
  return out;
}
