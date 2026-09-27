// MP4 / M4A (AAC, ALAC) atom parsing: iTunes-style metadata (ilst), cover art
// and duration from mvhd/mdhd. The moov atom may be at the end of the file, so
// top-level atoms are walked via header reads without loading media data.

import { latin1, u32be, u64be, u16be, decodeText, sniffImageMime, parseGain } from './reader.js';
import { ID3_GENRES, normalizeGenre } from './genres.js';

const CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'ilst', 'meta']);

function atoms(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = latin1(b, p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = u64be(b, p + 8);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p, dataStart: p + header, end: p + size });
    p += size;
  }
  return out;
}

function walk(b, start, end, visit, depth = 0) {
  if (depth > 12) return;
  for (const a of atoms(b, start, end)) {
    visit(a);
    if (CONTAINERS.has(a.type)) {
      let childStart = a.dataStart;
      if (a.type === 'meta') {
        // ISO full box (4 bytes version/flags) vs QuickTime style (no header).
        const next = latin1(b, a.dataStart + 4, a.dataStart + 8);
        if (next !== 'hdlr' && next !== 'ilst' && next !== 'keys') childStart += 4;
        else if (u32be(b, a.dataStart) === 0) childStart += 4;
      }
      if (a.type !== 'ilst') walk(b, childStart, a.end, visit, depth + 1);
    } else if (a.type === 'stsd') {
      // FullBox + entry count, then sample entries.
      walk(b, a.dataStart + 8, a.end, visit, depth + 1);
    }
  }
}

function readDataAtom(b, item) {
  const out = [];
  for (const a of atoms(b, item.dataStart, item.end)) {
    if (a.type === 'data') {
      const typeCode = u32be(b, a.dataStart) & 0xffffff;
      out.push({ typeCode, value: b.subarray(a.dataStart + 8, a.end) });
    }
  }
  return out;
}

function parseIlst(b, ilst) {
  const tags = {};
  for (const item of atoms(b, ilst.dataStart, ilst.end)) {
    const key = item.type;
    if (key === '----') {
      let mean = '';
      let name = '';
      let value = null;
      for (const c of atoms(b, item.dataStart, item.end)) {
        if (c.type === 'mean') mean = latin1(b, c.dataStart + 4, c.end);
        else if (c.type === 'name') name = latin1(b, c.dataStart + 4, c.end);
        else if (c.type === 'data') value = decodeText(b.subarray(c.dataStart + 8, c.end), 3);
      }
      if (name && value != null) tags[`----:${mean}:${name}`.toUpperCase()] = value.trim();
      continue;
    }
    const datas = readDataAtom(b, item);
    if (!datas.length) continue;
    const d = datas[0];
    switch (key) {
      case 'trkn':
      case 'disk': {
        if (d.value.length >= 6) tags[key] = [u16be(d.value, 2), u16be(d.value, 4)];
        break;
      }
      case 'gnre': {
        if (d.value.length >= 2) tags.gnre = ID3_GENRES[u16be(d.value, 0) - 1] || null;
        break;
      }
      case 'covr': {
        const pics = datas.map((x) => ({ data: x.value, mime: x.typeCode === 14 ? 'image/png' : sniffImageMime(x.value) || 'image/jpeg' }));
        tags.covr = pics[0];
        break;
      }
      case 'tmpo': {
        if (d.value.length >= 2) tags.tmpo = u16be(d.value, 0);
        break;
      }
      default:
        if (d.typeCode === 1 || d.typeCode === 0) tags[key] = decodeText(d.value, 3).trim();
        else if (d.typeCode === 2) tags[key] = decodeText(d.value, 'utf-16be').trim();
    }
  }
  return tags;
}

/** Parse from a fully-read moov atom buffer (for tests and small files). */
export function parseMoov(b, start = 0, end = b.length) {
  const out = { format: 'm4a', codec: 'AAC' };
  let ilstTags = null;
  let trackTimescale = null;
  let trackDuration = null;
  let isSound = false;
  walk(b, start, end, (a) => {
    if (a.type === 'mvhd') {
      const v = b[a.dataStart];
      if (v === 1) {
        out.timescale = u32be(b, a.dataStart + 20);
        out.durationUnits = u64be(b, a.dataStart + 24);
      } else {
        out.timescale = u32be(b, a.dataStart + 12);
        out.durationUnits = u32be(b, a.dataStart + 16);
      }
    } else if (a.type === 'hdlr') {
      const handler = latin1(b, a.dataStart + 8, a.dataStart + 12);
      if (handler === 'soun') isSound = true;
    } else if (a.type === 'mdhd' && trackTimescale == null) {
      const v = b[a.dataStart];
      if (v === 1) {
        trackTimescale = u32be(b, a.dataStart + 20);
        trackDuration = u64be(b, a.dataStart + 24);
      } else {
        trackTimescale = u32be(b, a.dataStart + 12);
        trackDuration = u32be(b, a.dataStart + 16);
      }
    } else if (a.type === 'mp4a' || a.type === 'alac' || a.type === 'fLaC' || a.type === 'Opus' || a.type === 'ac-3' || a.type === 'ec-3') {
      out.codec = { mp4a: 'AAC', alac: 'ALAC', fLaC: 'FLAC', Opus: 'Opus', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3' }[a.type];
      const p = a.dataStart;
      out.channels = u16be(b, p + 16);
      out.bitsPerSample = u16be(b, p + 18);
      const sr = u32be(b, p + 24) >>> 16;
      if (sr) out.sampleRate = sr;
    } else if (a.type === 'ilst') {
      ilstTags = parseIlst(b, a);
    }
  });
  if (out.timescale && out.durationUnits) out.duration = out.durationUnits / out.timescale;
  else if (trackTimescale && trackDuration) out.duration = trackDuration / trackTimescale;
  if (isSound && trackTimescale && !out.sampleRate) out.sampleRate = trackTimescale;
  delete out.timescale;
  delete out.durationUnits;
  if (ilstTags) {
    const t = ilstTags;
    const str = (k) => (t[k] ? String(t[k]) : null);
    if (str('©nam')) out.title = str('©nam');
    if (str('©ART')) out.artist = str('©ART');
    if (str('aART')) out.albumArtist = str('aART');
    if (str('©alb')) out.album = str('©alb');
    const g = str('©gen') || t.gnre;
    if (g) out.genre = normalizeGenre(g);
    if (str('©wrt')) out.composer = str('©wrt');
    if (str('©day')) {
      const m = str('©day').match(/\d{4}/);
      if (m) out.year = Number(m[0]);
    }
    if (t.trkn) {
      out.track = t.trkn[0] || null;
      out.trackTotal = t.trkn[1] || null;
    }
    if (t.disk) {
      out.disc = t.disk[0] || null;
      out.discTotal = t.disk[1] || null;
    }
    if (t.tmpo) out.bpm = t.tmpo;
    if (str('©lyr')) out.lyrics = str('©lyr');
    if (str('©cmt')) out.comment = str('©cmt');
    if (t.covr && t.covr.data.length) out.picture = t.covr;
    const rgT = t['----:COM.APPLE.ITUNES:REPLAYGAIN_TRACK_GAIN'];
    const rgA = t['----:COM.APPLE.ITUNES:REPLAYGAIN_ALBUM_GAIN'];
    if (rgT || rgA) {
      out.replayGain = {
        trackGain: parseGain(rgT),
        trackPeak: parseGain(t['----:COM.APPLE.ITUNES:REPLAYGAIN_TRACK_PEAK']),
        albumGain: parseGain(rgA),
        albumPeak: parseGain(t['----:COM.APPLE.ITUNES:REPLAYGAIN_ALBUM_PEAK']),
      };
    }
  }
  if (out.codec === 'ALAC') out.format = 'm4a';
  return out;
}

/** Walk top-level atoms of a file and parse the moov box. */
export async function parseMp4(reader) {
  let pos = 0;
  let moov = null;
  let mdatSize = 0;
  let guard = 0;
  while (pos + 8 <= reader.size && guard++ < 1000) {
    const h = await reader.read(pos, 16);
    let size = u32be(h, 0);
    const type = latin1(h, 4, 8);
    if (size === 1) size = u64be(h, 8);
    else if (size === 0) size = reader.size - pos;
    if (size < 8) break;
    if (type === 'moov') {
      if (size > 96 * 1024 * 1024) break;
      moov = await reader.read(pos, size);
    } else if (type === 'mdat') mdatSize += size;
    pos += size;
  }
  if (!moov) return { format: 'm4a', codec: 'AAC' };
  const out = parseMoov(moov, 0, moov.length);
  if (out.duration && mdatSize) out.bitrate = Math.round((mdatSize * 8) / out.duration / 1000);
  return out;
}
