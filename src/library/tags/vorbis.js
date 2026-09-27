// Vorbis comment blocks (FLAC, Ogg Vorbis, Opus) and FLAC PICTURE blocks.

import { decodeText, u32le, u32be, parseNumberPair, parseGain, base64ToBytes, sniffImageMime } from './reader.js';
import { normalizeGenre } from './genres.js';

/** Parse a Vorbis comment block (little-endian lengths). Returns {vendor, fields: {KEY: [values]}}. */
export function parseVorbisComment(b, offset = 0) {
  let p = offset;
  const vlen = u32le(b, p);
  p += 4;
  const vendor = decodeText(b.subarray(p, p + vlen), 3);
  p += vlen;
  const count = u32le(b, p);
  p += 4;
  const fields = {};
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p);
    p += 4;
    if (p + len > b.length) break;
    const s = decodeText(b.subarray(p, p + len), 3);
    p += len;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).toUpperCase();
    (fields[key] ||= []).push(s.slice(eq + 1));
  }
  return { vendor, fields };
}

/** Parse a FLAC METADATA_BLOCK_PICTURE payload (big-endian). */
export function parseFlacPicture(b, offset = 0) {
  let p = offset;
  const type = u32be(b, p);
  p += 4;
  const mlen = u32be(b, p);
  p += 4;
  const mime = decodeText(b.subarray(p, p + mlen), 0);
  p += mlen;
  const dlen = u32be(b, p);
  p += 4 + dlen;
  p += 16; // width, height, depth, colours
  const len = u32be(b, p);
  p += 4;
  const data = b.subarray(p, p + len);
  return { type, mime: sniffImageMime(data) || mime || 'image/jpeg', data };
}

/** Map vorbis fields to the common tag model. */
export function vorbisToTags(fields) {
  const get = (...keys) => {
    for (const k of keys) if (fields[k] && fields[k][0]) return fields[k][0].trim();
    return null;
  };
  const out = {};
  const title = get('TITLE');
  if (title) out.title = title;
  const artist = fields.ARTIST ? fields.ARTIST.join('; ') : null;
  if (artist) out.artist = artist;
  const aa = get('ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST');
  if (aa) out.albumArtist = aa;
  const album = get('ALBUM');
  if (album) out.album = album;
  const genre = fields.GENRE ? normalizeGenre(fields.GENRE.join('; ')) : null;
  if (genre) out.genre = genre;
  const date = get('DATE', 'YEAR', 'ORIGINALDATE');
  if (date) {
    const m = date.match(/\d{4}/);
    if (m) out.year = Number(m[0]);
  }
  const composer = get('COMPOSER');
  if (composer) out.composer = composer;
  const tn = get('TRACKNUMBER');
  if (tn) [out.track, out.trackTotal] = parseNumberPair(tn);
  const tt = get('TRACKTOTAL', 'TOTALTRACKS');
  if (tt && !out.trackTotal) out.trackTotal = Number(tt) || null;
  const dn = get('DISCNUMBER');
  if (dn) [out.disc, out.discTotal] = parseNumberPair(dn);
  const dt = get('DISCTOTAL', 'TOTALDISCS');
  if (dt && !out.discTotal) out.discTotal = Number(dt) || null;
  const bpm = get('BPM');
  if (bpm) out.bpm = Number(bpm) || null;
  const lyrics = get('LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS');
  if (lyrics) out.lyrics = lyrics;
  const comment = get('COMMENT', 'DESCRIPTION');
  if (comment) out.comment = comment;
  const rg = {
    trackGain: parseGain(get('REPLAYGAIN_TRACK_GAIN')),
    trackPeak: parseGain(get('REPLAYGAIN_TRACK_PEAK')),
    albumGain: parseGain(get('REPLAYGAIN_ALBUM_GAIN')),
    albumPeak: parseGain(get('REPLAYGAIN_ALBUM_PEAK')),
  };
  if (rg.trackGain != null || rg.albumGain != null) out.replayGain = rg;
  const pic = get('METADATA_BLOCK_PICTURE');
  if (pic) {
    try {
      const p = parseFlacPicture(base64ToBytes(pic));
      if (p.data.length) out.picture = { mime: p.mime, data: p.data };
    } catch {
      /* ignore malformed picture */
    }
  }
  return out;
}
