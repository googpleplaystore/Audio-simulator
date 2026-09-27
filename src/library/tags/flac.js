// FLAC metadata: STREAMINFO, VORBIS_COMMENT and PICTURE blocks.

import { startsWith, u24be } from './reader.js';
import { parseVorbisComment, vorbisToTags, parseFlacPicture } from './vorbis.js';

/**
 * @param {import('./reader.js').BlobReader} reader
 * @param {number} start offset of the "fLaC" marker
 */
export async function parseFlac(reader, start = 0) {
  const marker = await reader.read(start, 4);
  if (!startsWith(marker, 'fLaC')) return null;
  let pos = start + 4;
  const out = { format: 'flac', codec: 'FLAC' };
  let last = false;
  let pictures = [];
  let guard = 0;
  while (!last && pos < reader.size && guard++ < 128) {
    const hdr = await reader.read(pos, 4);
    if (hdr.length < 4) break;
    last = (hdr[0] & 0x80) !== 0;
    const type = hdr[0] & 0x7f;
    const len = u24be(hdr, 1);
    const dataPos = pos + 4;
    pos = dataPos + len;
    if (type === 0) {
      const b = await reader.read(dataPos, len);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const channels = ((b[12] >> 1) & 7) + 1;
      const bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      const totalSamples = (b[13] & 0x0f) * 4294967296 + ((b[14] << 24) >>> 0) + ((b[15] << 16) | (b[16] << 8) | b[17]);
      out.sampleRate = sampleRate;
      out.channels = channels;
      out.bitsPerSample = bits;
      if (sampleRate > 0 && totalSamples > 0) out.duration = totalSamples / sampleRate;
    } else if (type === 4) {
      const b = await reader.read(dataPos, len);
      Object.assign(out, vorbisToTags(parseVorbisComment(b).fields));
    } else if (type === 6 && len < 32 * 1024 * 1024) {
      const b = await reader.read(dataPos, len);
      try {
        pictures.push(parseFlacPicture(b));
      } catch {
        /* skip */
      }
    } else if (type === 127) {
      break;
    }
  }
  if (!out.picture && pictures.length) {
    const front = pictures.find((p) => p.type === 3) || pictures[0];
    out.picture = { mime: front.mime, data: front.data };
  }
  if (out.duration) out.bitrate = Math.round(((reader.size - pos) * 8) / out.duration / 1000);
  pictures = null;
  return out;
}
