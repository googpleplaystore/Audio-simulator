// Unified metadata extraction: sniff the container from magic bytes and
// dispatch to the matching parser. Works on any Blob/File.

import { BlobReader, startsWith } from './reader.js';
import { id3v2Header, parseId3v2, parseId3v1 } from './id3.js';
import { mpegInfo } from './mpeg.js';
import { parseFlac } from './flac.js';
import { parseMp4 } from './mp4.js';
import { parseWav, parseAiff } from './riff.js';
import { parseOgg } from './ogg.js';

export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'aif', 'aiff', 'alac', 'wave'];

export function isAudioFileName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return !!m && AUDIO_EXTENSIONS.includes(m[1].toLowerCase());
}

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** MIME type used for playback / canPlayType checks. */
export function mimeFor(format, codec) {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'm4a':
      return codec === 'ALAC' ? 'audio/mp4; codecs="alac"' : 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
      return 'audio/ogg; codecs="vorbis"';
    case 'opus':
      return 'audio/ogg; codecs="opus"';
    case 'webm':
      return 'audio/webm';
    case 'aiff':
      return 'audio/aiff';
    default:
      return '';
  }
}

async function sniff(reader) {
  const head = await reader.read(0, 16);
  if (startsWith(head, 'fLaC')) return { kind: 'flac', offset: 0 };
  if (startsWith(head, 'ftyp', 4)) return { kind: 'mp4' };
  if ((startsWith(head, 'RIFF') || startsWith(head, 'RF64')) && startsWith(head, 'WAVE', 8)) return { kind: 'wav' };
  if (startsWith(head, 'FORM') && (startsWith(head, 'AIFF', 8) || startsWith(head, 'AIFC', 8))) return { kind: 'aiff' };
  if (startsWith(head, 'OggS')) return { kind: 'ogg' };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: 'webm' };
  if (startsWith(head, 'ID3')) {
    const hdr = await reader.read(0, 10);
    const h = id3v2Header(hdr);
    if (h) {
      const after = await reader.read(h.size, 4);
      if (startsWith(after, 'fLaC')) return { kind: 'flac', offset: h.size, id3: h };
      if (after[0] === 0xff && (after[1] & 0xf6) === 0xf0) return { kind: 'aac', id3: h };
      return { kind: 'mp3', id3: h };
    }
  }
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { kind: 'aac' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return { kind: 'mp3' };
  return { kind: 'unknown' };
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

async function parseAdts(reader, offset) {
  const b = await reader.read(offset, 64 * 1024);
  let p = 0;
  while (p < b.length - 7 && !(b[p] === 0xff && (b[p + 1] & 0xf6) === 0xf0)) p++;
  if (p >= b.length - 7) return { format: 'aac', codec: 'AAC' };
  const sr = ADTS_RATES[(b[p + 2] >> 2) & 0xf] || 44100;
  const ch = ((b[p + 2] & 1) << 2) | (b[p + 3] >> 6);
  // Estimate bitrate by averaging frame lengths over the chunk.
  let frames = 0;
  let bytes = 0;
  let q = p;
  while (q < b.length - 7 && b[q] === 0xff && (b[q + 1] & 0xf6) === 0xf0) {
    const len = ((b[q + 3] & 3) << 11) | (b[q + 4] << 3) | (b[q + 5] >> 5);
    if (len < 7) break;
    frames++;
    bytes += len;
    q += len;
  }
  const out = { format: 'aac', codec: 'AAC (ADTS)', sampleRate: sr, channels: ch || 2 };
  if (frames > 2) {
    const bytesPerSec = (bytes / frames) * (sr / 1024);
    out.bitrate = Math.round((bytesPerSec * 8) / 1000);
    out.duration = (reader.size - offset) / bytesPerSec;
  }
  return out;
}

/**
 * Extract metadata and stream info from an audio Blob/File.
 * @returns {Promise<object>} common tag model (fields may be missing)
 */
export async function parseTags(blob) {
  const reader = new BlobReader(blob);
  const s = await sniff(reader);
  let out = {};
  switch (s.kind) {
    case 'flac': {
      out = (await parseFlac(reader, s.offset || 0)) || {};
      if (s.id3) {
        const tag = parseId3v2(await reader.read(0, s.id3.size));
        out = { ...(tag || {}), ...out };
      }
      break;
    }
    case 'mp4':
      out = await parseMp4(reader);
      break;
    case 'wav':
      out = (await parseWav(reader)) || {};
      break;
    case 'aiff':
      out = (await parseAiff(reader)) || {};
      break;
    case 'ogg':
      out = (await parseOgg(reader)) || {};
      break;
    case 'webm':
      out = { format: 'webm', codec: 'WebM' };
      break;
    case 'aac': {
      const start = s.id3 ? s.id3.size : 0;
      out = await parseAdts(reader, start);
      if (s.id3) Object.assign(out, parseId3v2(await reader.read(0, s.id3.size)) || {});
      break;
    }
    case 'mp3': {
      let start = 0;
      let tag = {};
      if (s.id3) {
        start = s.id3.size;
        tag = parseId3v2(await reader.read(0, s.id3.size)) || {};
      }
      const tail = await reader.read(reader.size - 128, 128);
      const v1 = parseId3v1(tail);
      const end = reader.size - (v1 ? 128 : 0);
      const head = await reader.read(start, Math.min(64 * 1024, end - start));
      const info = mpegInfo(head, end - start) || {};
      out = { format: 'mp3', codec: 'MP3', ...(v1 || {}), ...info, ...tag };
      if (!info.duration && tag.lengthMs) out.duration = tag.lengthMs / 1000;
      break;
    }
    default:
      out = { format: 'unknown' };
  }
  delete out.firstFrame;
  delete out.lengthMs;
  return out;
}
