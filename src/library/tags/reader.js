// Random-access byte reading for Blobs/Files, plus binary cursor helpers.

export class BlobReader {
  constructor(blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  /** Read [offset, offset+length) clamped to the blob. Returns Uint8Array. */
  async read(offset, length) {
    const start = Math.max(0, Math.min(this.size, offset));
    const end = Math.max(start, Math.min(this.size, offset + length));
    if (end <= start) return new Uint8Array(0);
    const buf = await this.blob.slice(start, end).arrayBuffer();
    return new Uint8Array(buf);
  }
}

const decoders = {};
function decoder(label) {
  if (!decoders[label]) {
    try {
      decoders[label] = new TextDecoder(label, { fatal: false });
    } catch {
      decoders[label] = new TextDecoder('utf-8');
    }
  }
  return decoders[label];
}

/** Decode bytes with an ID3-style encoding: 0 latin1, 1 utf-16 (BOM), 2 utf-16be, 3 utf-8. */
export function decodeText(bytes, enc = 3) {
  if (!bytes || !bytes.length) return '';
  let label;
  switch (enc) {
    case 0:
    case 'latin1':
      label = 'windows-1252';
      break;
    case 1:
    case 'utf-16': {
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return decoder('utf-16be').decode(bytes.subarray(2));
      }
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return decoder('utf-16le').decode(bytes.subarray(2));
      }
      label = 'utf-16le';
      break;
    }
    case 2:
    case 'utf-16be':
      label = 'utf-16be';
      break;
    case 'utf-16le':
      label = 'utf-16le';
      break;
    default:
      label = 'utf-8';
  }
  return decoder(label).decode(bytes);
}

export function latin1(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function cleanText(s) {
  return s.replace(/\u0000+$/g, '').replace(/^﻿/, '').trim();
}

export const u16be = (b, o) => (b[o] << 8) | b[o + 1];
export const u24be = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
export const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
export const u64be = (b, o) => u32be(b, o) * 4294967296 + u32be(b, o + 4);
export const u64le = (b, o) => u32le(b, o) + u32le(b, o + 4) * 4294967296;
export const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

export function startsWith(bytes, str, offset = 0) {
  if (bytes.length < offset + str.length) return false;
  for (let i = 0; i < str.length; i++) if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  return true;
}

/** Find the index of a byte sequence (string) in bytes, or -1. */
export function indexOfBytes(bytes, str, from = 0) {
  const first = str.charCodeAt(0);
  outer: for (let i = from; i <= bytes.length - str.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < str.length; j++) if (bytes[i + j] !== str.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Parse "3/12" style numbers. */
export function parseNumberPair(v) {
  if (v == null) return [null, null];
  const m = String(v).match(/^\s*(\d+)\s*(?:\/\s*(\d+))?/);
  if (!m) return [null, null];
  return [Number(m[1]), m[2] ? Number(m[2]) : null];
}

/** Parse ReplayGain strings like "-6.54 dB". */
export function parseGain(v) {
  if (v == null) return null;
  const m = String(v).match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function sniffImageMime(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length > 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (data.length > 12 && startsWith(data, 'RIFF') && startsWith(data, 'WEBP', 8)) return 'image/webp';
  if (data.length > 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return null;
}

export function base64ToBytes(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}
