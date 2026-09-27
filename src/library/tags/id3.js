// ID3v2.2 / v2.3 / v2.4 and ID3v1 tag parsing.

import { decodeText, cleanText, latin1, syncsafe, u24be, u32be, startsWith, parseNumberPair, parseGain, sniffImageMime } from './reader.js';
import { normalizeGenre } from './genres.js';

const V22_MAP = {
  TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TPA: 'TPOS', PIC: 'APIC',
  ULT: 'USLT', COM: 'COMM', TXX: 'TXXX', TCM: 'TCOM', TBP: 'TBPM', TLE: 'TLEN', TDA: 'TDAT',
};

function removeUnsync(bytes) {
  let n = 0;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

/** Split encoded text at the first terminator for that encoding. */
function splitTerminated(bytes, enc) {
  const wide = enc === 1 || enc === 2;
  if (wide) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return [bytes.subarray(0, i), bytes.subarray(i + 2)];
    }
  } else {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return [bytes.subarray(0, i), bytes.subarray(i + 1)];
  }
  return [bytes, new Uint8Array(0)];
}

function textFrame(data) {
  if (!data.length) return '';
  const enc = data[0];
  const text = decodeText(data.subarray(1), enc);
  // v2.4 multi-value frames are NUL-separated.
  return text
    .split('\u0000')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

/** Header check. Returns {version, flags, size} or null. `size` is total tag bytes incl. header/footer. */
export function id3v2Header(bytes, offset = 0) {
  if (!startsWith(bytes, 'ID3', offset) || bytes.length < offset + 10) return null;
  const major = bytes[offset + 3];
  if (major < 2 || major > 4 || bytes[offset + 4] === 0xff) return null;
  const flags = bytes[offset + 5];
  const size = syncsafe(bytes, offset + 6);
  const footer = major === 4 && flags & 0x10 ? 10 : 0;
  return { version: major, flags, bodySize: size, size: 10 + size + footer };
}

/**
 * Parse an ID3v2 tag contained in `bytes` (starting at offset 0).
 * Returns a partial tag object.
 */
export function parseId3v2(bytes) {
  const hdr = id3v2Header(bytes);
  if (!hdr) return null;
  const { version, flags } = hdr;
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + hdr.bodySize));
  if (version < 4 && flags & 0x80) body = removeUnsync(body);
  let pos = 0;
  if (flags & 0x40) {
    // Extended header.
    if (version === 3) pos = 4 + u32be(body, 0);
    else if (version === 4) pos = syncsafe(body, 0);
  }
  const tags = { pictures: [], txxx: {}, comments: [] };
  const idLen = version === 2 ? 3 : 4;
  const hdrLen = version === 2 ? 6 : 10;
  while (pos + hdrLen <= body.length) {
    if (body[pos] === 0) break; // padding
    let id = latin1(body, pos, pos + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    let size;
    let fflags = 0;
    if (version === 2) size = u24be(body, pos + 3);
    else if (version === 3) size = u32be(body, pos + 4);
    else {
      size = syncsafe(body, pos + 4);
      // Some v2.4 writers use plain integers; sanity-check against next frame.
      const plain = u32be(body, pos + 4);
      if (plain !== size && pos + hdrLen + plain <= body.length) {
        const nx = pos + hdrLen + plain;
        const nxId = latin1(body, nx, nx + 4);
        const ssNx = pos + hdrLen + size;
        const ssId = latin1(body, ssNx, ssNx + 4);
        if (/^[A-Z0-9]{4}$/.test(nxId) && !/^[A-Z0-9]{4}$/.test(ssId)) size = plain;
      }
    }
    if (version >= 3) fflags = (body[pos + 8] << 8) | body[pos + 9];
    const start = pos + hdrLen;
    const end = start + size;
    if (size <= 0 || end > body.length) break;
    let data = body.subarray(start, end);
    pos = end;
    if (version === 2) id = V22_MAP[id] || id;
    if (version === 3 && fflags & 0x00c0) continue; // compressed / encrypted
    if (version === 4) {
      if (fflags & 0x000c) continue; // compressed / encrypted
      if (fflags & 0x0001) data = data.subarray(4); // data length indicator
      if (fflags & 0x0002 || flags & 0x80) data = removeUnsync(data);
    }
    try {
      readFrame(id, data, tags, version);
    } catch {
      // Ignore malformed frames; keep parsing others.
    }
  }
  return finalizeId3(tags);
}

function readFrame(id, data, tags, version) {
  if (id === 'APIC') {
    const enc = data[0];
    let rest;
    let mime;
    if (version === 2) {
      const fmt = latin1(data, 1, 4).toUpperCase();
      mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
      rest = data.subarray(4);
    } else {
      let i = 1;
      while (i < data.length && data[i] !== 0) i++;
      mime = latin1(data, 1, i).toLowerCase() || 'image/jpeg';
      if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
      rest = data.subarray(i + 1);
    }
    const type = rest[0];
    const [desc, img] = splitTerminated(rest.subarray(1), enc);
    const sniff = sniffImageMime(img);
    tags.pictures.push({ type, mime: sniff || mime, description: cleanText(decodeText(desc, enc)), data: img });
    return;
  }
  if (id === 'USLT' || id === 'COMM') {
    const enc = data[0];
    const [desc, text] = splitTerminated(data.subarray(4), enc);
    const value = cleanText(decodeText(text, enc));
    if (id === 'USLT') tags.lyrics = value;
    else tags.comments.push({ description: cleanText(decodeText(desc, enc)), text: value });
    return;
  }
  if (id === 'TXXX') {
    const enc = data[0];
    const [desc, val] = splitTerminated(data.subarray(1), enc);
    tags.txxx[cleanText(decodeText(desc, enc)).toUpperCase()] = cleanText(decodeText(val, enc));
    return;
  }
  if (id[0] === 'T') {
    tags[id] = textFrame(data);
  }
}

function finalizeId3(t) {
  const out = {};
  if (t.TIT2) out.title = t.TIT2;
  if (t.TPE1) out.artist = t.TPE1;
  if (t.TPE2) out.albumArtist = t.TPE2;
  if (t.TALB) out.album = t.TALB;
  if (t.TCON) out.genre = normalizeGenre(t.TCON);
  if (t.TCOM) out.composer = t.TCOM;
  const year = t.TDRC || t.TYER || t.TDOR;
  if (year) {
    const m = String(year).match(/\d{4}/);
    if (m) out.year = Number(m[0]);
  }
  if (t.TRCK) [out.track, out.trackTotal] = parseNumberPair(t.TRCK);
  if (t.TPOS) [out.disc, out.discTotal] = parseNumberPair(t.TPOS);
  if (t.TBPM) out.bpm = Number(t.TBPM) || null;
  if (t.TLEN) out.lengthMs = Number(t.TLEN) || null;
  if (t.lyrics) out.lyrics = t.lyrics;
  const comm = t.comments.find((c) => !c.description || c.description === '') || t.comments[0];
  if (comm && comm.text && !/^iTun/.test(comm.description)) out.comment = comm.text;
  const rg = {
    trackGain: parseGain(t.txxx.REPLAYGAIN_TRACK_GAIN),
    trackPeak: parseGain(t.txxx.REPLAYGAIN_TRACK_PEAK),
    albumGain: parseGain(t.txxx.REPLAYGAIN_ALBUM_GAIN),
    albumPeak: parseGain(t.txxx.REPLAYGAIN_ALBUM_PEAK),
  };
  if (rg.trackGain != null || rg.albumGain != null) out.replayGain = rg;
  if (t.pictures.length) {
    const front = t.pictures.find((p) => p.type === 3) || t.pictures[0];
    out.picture = { mime: front.mime, data: front.data };
  }
  return out;
}

/** Parse a 128-byte ID3v1 tag. */
export function parseId3v1(bytes) {
  if (bytes.length < 128 || !startsWith(bytes, 'TAG', bytes.length - 128)) return null;
  const b = bytes.subarray(bytes.length - 128);
  const str = (s, e) => cleanText(decodeText(b.subarray(s, e), 0).replace(/\u0000.*$/s, ''));
  const out = {};
  const title = str(3, 33);
  const artist = str(33, 63);
  const album = str(63, 93);
  const year = str(93, 97);
  if (title) out.title = title;
  if (artist) out.artist = artist;
  if (album) out.album = album;
  if (/^\d{4}$/.test(year)) out.year = Number(year);
  if (b[125] === 0 && b[126] !== 0) out.track = b[126];
  const g = b[127];
  if (g !== 255) out.genre = normalizeGenre(String(g));
  return out;
}
