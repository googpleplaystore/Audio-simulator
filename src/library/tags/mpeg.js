// MPEG audio (MP1/2/3) frame header parsing and duration estimation
// (Xing/Info/VBRI headers for VBR, bitrate-based for CBR).

import { u32be, startsWith, u16be } from './reader.js';

const BITRATES = {
  // [version][layer] -> kbps table (index 1..14)
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

/** Parse a 4-byte frame header at offset. Returns null when invalid. */
export function parseFrameHeader(b, o) {
  if (o + 4 > b.length) return null;
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[o + 1] >> 3) & 3;
  const layerBits = (b[o + 1] >> 1) & 3;
  if (verBits === 1 || layerBits === 0) return null;
  const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
  const layer = 4 - layerBits;
  const protection = (b[o + 1] & 1) === 0;
  const brIndex = (b[o + 2] >> 4) & 0xf;
  const srIndex = (b[o + 2] >> 2) & 3;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const padding = (b[o + 2] >> 1) & 1;
  const channelMode = (b[o + 3] >> 6) & 3;
  const bitrate = BITRATES[version === 1 ? 1 : 2][layer][brIndex];
  const sampleRate = SAMPLE_RATES[version][srIndex];
  let samplesPerFrame;
  if (layer === 1) samplesPerFrame = 384;
  else if (layer === 2) samplesPerFrame = 1152;
  else samplesPerFrame = version === 1 ? 1152 : 576;
  let frameLength;
  if (layer === 1) frameLength = (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4;
  else frameLength = Math.floor(((samplesPerFrame / 8) * bitrate * 1000) / sampleRate) + padding;
  return {
    version,
    layer,
    protection,
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameLength,
    channels: channelMode === 3 ? 1 : 2,
  };
}

/** Find the first valid frame (verified by a following frame) starting at `from`. */
export function findFirstFrame(b, from = 0) {
  for (let i = from; i < b.length - 4; i++) {
    if (b[i] !== 0xff) continue;
    const h = parseFrameHeader(b, i);
    if (!h || h.frameLength < 24) continue;
    const next = parseFrameHeader(b, i + h.frameLength);
    if (next && next.sampleRate === h.sampleRate && next.layer === h.layer) return { offset: i, header: h };
    if (i + h.frameLength >= b.length - 4) return { offset: i, header: h }; // tiny file
  }
  return null;
}

/**
 * Compute stream info. `head` holds bytes starting at `audioStart` (enough
 * to include the first frame and its Xing header), `audioBytes` is the size
 * of the audio payload (file size minus tags).
 */
export function mpegInfo(head, audioBytes) {
  const found = findFirstFrame(head, 0);
  if (!found) return null;
  const { offset, header: h } = found;
  let sideInfo;
  if (h.version === 1) sideInfo = h.channels === 1 ? 17 : 32;
  else sideInfo = h.channels === 1 ? 9 : 17;
  const xingOff = offset + 4 + (h.protection ? 2 : 0) + sideInfo;
  let frames = null;
  let bytes = null;
  let vbr = false;
  if (startsWith(head, 'Xing', xingOff) || startsWith(head, 'Info', xingOff)) {
    vbr = startsWith(head, 'Xing', xingOff);
    const flags = u32be(head, xingOff + 4);
    let p = xingOff + 8;
    if (flags & 1) {
      frames = u32be(head, p);
      p += 4;
    }
    if (flags & 2) bytes = u32be(head, p);
  } else if (startsWith(head, 'VBRI', offset + 36)) {
    vbr = true;
    bytes = u32be(head, offset + 36 + 10);
    frames = u32be(head, offset + 36 + 14);
    void u16be;
  }
  let duration;
  let bitrate = h.bitrate;
  if (frames) {
    duration = (frames * h.samplesPerFrame) / h.sampleRate;
    const payload = bytes || audioBytes - offset;
    if (duration > 0) bitrate = Math.round((payload * 8) / duration / 1000);
  } else {
    duration = ((audioBytes - offset) * 8) / (h.bitrate * 1000);
  }
  return {
    codec: h.layer === 3 ? 'MP3' : `MPEG Layer ${h.layer}`,
    sampleRate: h.sampleRate,
    channels: h.channels,
    bitrate,
    vbr,
    duration,
    firstFrame: offset,
  };
}
