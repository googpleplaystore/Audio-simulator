// Builders for synthetic audio container fixtures used by tag-parser tests.

export const enc = (s) => new TextEncoder().encode(s);
export const latin = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));

export function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const be32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const be16 = (n) => Uint8Array.from([(n >>> 8) & 255, n & 255]);
export const be24 = (n) => Uint8Array.from([(n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const le32 = (n) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
export const le16 = (n) => Uint8Array.from([n & 255, (n >>> 8) & 255]);
export const syncsafe = (n) => Uint8Array.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

// 1×1 transparent PNG.
export const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// ---------- ID3v2 ----------
export function id3Frame(version, id, data) {
  if (version === 2) return concat(latin(id), be24(data.length), data);
  const size = version === 4 ? syncsafe(data.length) : be32(data.length);
  return concat(latin(id), size, new Uint8Array(2), data);
}

export function id3Text(version, id, text, encoding = 3) {
  const body = encoding === 0 ? latin(text) : encoding === 1 ? utf16bom(text) : enc(text);
  return id3Frame(version, id, concat(Uint8Array.of(encoding), body));
}

export function utf16bom(text) {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 255;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

export function id3Tag(version, frames, padding = 64) {
  const body = concat(...frames, new Uint8Array(padding));
  return concat(latin('ID3'), Uint8Array.of(version, 0, 0), syncsafe(body.length), body);
}

// ---------- MPEG ----------
/** MPEG-1 Layer III 128 kbps 44.1 kHz stereo frames (417 bytes each). */
export function mp3Frames(count, { xingFrames = null } = {}) {
  const frameLen = 417;
  const out = new Uint8Array(frameLen * count);
  for (let i = 0; i < count; i++) {
    out.set([0xff, 0xfb, 0x90, 0x64], i * frameLen);
  }
  if (xingFrames != null) {
    out.set(latin('Xing'), 36);
    out.set(be32(1), 40);
    out.set(be32(xingFrames), 44);
  }
  return out;
}

export function id3v1({ title = '', artist = '', album = '', year = '', track = 0, genre = 255 }) {
  const b = new Uint8Array(128);
  b.set(latin('TAG'), 0);
  b.set(latin(title.slice(0, 30)), 3);
  b.set(latin(artist.slice(0, 30)), 33);
  b.set(latin(album.slice(0, 30)), 63);
  b.set(latin(year.slice(0, 4)), 93);
  b[125] = 0;
  b[126] = track;
  b[127] = genre;
  return b;
}

// ---------- FLAC ----------
export function flacFile({ sampleRate = 44100, channels = 2, bits = 16, totalSamples = 441000, comments = {}, picture = null }) {
  const si = new Uint8Array(34);
  si.set(be16(4096), 0);
  si.set(be16(4096), 2);
  si[10] = (sampleRate >> 12) & 0xff;
  si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0xf) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 1);
  si[13] = (((bits - 1) & 0xf) << 4) | Math.floor(totalSamples / 2 ** 32);
  si.set(be32(totalSamples >>> 0), 14);
  const vendor = enc('test');
  const entries = Object.entries(comments).map(([k, v]) => enc(`${k}=${v}`));
  const vc = concat(le32(vendor.length), vendor, le32(entries.length), ...entries.flatMap((e) => [le32(e.length), e]));
  const blocks = [
    { type: 0, data: si },
    { type: 4, data: vc },
  ];
  if (picture) {
    const mime = latin('image/png');
    const pic = concat(be32(3), be32(mime.length), mime, be32(0), be32(1), be32(1), be32(32), be32(0), be32(picture.length), picture);
    blocks.push({ type: 6, data: pic });
  }
  const parts = [latin('fLaC')];
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1 ? 0x80 : 0;
    parts.push(Uint8Array.of(last | b.type), be24(b.data.length), b.data);
  });
  parts.push(new Uint8Array(1000)); // fake audio frames
  return concat(...parts);
}

// ---------- MP4 ----------
export function atom(type, ...children) {
  const body = concat(...children);
  return concat(be32(body.length + 8), latin(type), body);
}

export function dataAtom(typeCode, value) {
  return atom('data', be32(typeCode), be32(0), value);
}

export function m4aFile({ title, artist, album, track = 0, trackTotal = 0, genreIndex = null, cover = null, durationSec = 180, sampleRate = 44100 }) {
  const mvhd = atom('mvhd', new Uint8Array(4), be32(0), be32(0), be32(1000), be32(durationSec * 1000), new Uint8Array(80));
  const items = [];
  if (title) items.push(atom('©nam', dataAtom(1, enc(title))));
  if (artist) items.push(atom('©ART', dataAtom(1, enc(artist))));
  if (album) items.push(atom('©alb', dataAtom(1, enc(album))));
  if (track) items.push(atom('trkn', dataAtom(0, concat(be16(0), be16(track), be16(trackTotal), be16(0)))));
  if (genreIndex != null) items.push(atom('gnre', dataAtom(0, be16(genreIndex + 1))));
  if (cover) items.push(atom('covr', dataAtom(14, cover)));
  items.push(
    atom('----', atom('mean', new Uint8Array(4), latin('com.apple.iTunes')), atom('name', new Uint8Array(4), latin('replaygain_track_gain')), dataAtom(1, enc('-7.25 dB'))),
  );
  const ilst = atom('ilst', ...items);
  const hdlrMeta = atom('hdlr', new Uint8Array(4), be32(0), latin('mdir'), new Uint8Array(12), Uint8Array.of(0));
  const meta = atom('meta', new Uint8Array(4), hdlrMeta, ilst);
  const udta = atom('udta', meta);
  const mdhd = atom('mdhd', new Uint8Array(4), be32(0), be32(0), be32(sampleRate), be32(durationSec * sampleRate), new Uint8Array(4));
  const hdlr = atom('hdlr', new Uint8Array(4), be32(0), latin('soun'), new Uint8Array(12), Uint8Array.of(0));
  const mp4a = atom('mp4a', new Uint8Array(6), be16(1), new Uint8Array(8), be16(2), be16(16), be16(0), be16(0), be32(sampleRate * 65536));
  const stsd = atom('stsd', new Uint8Array(4), be32(1), mp4a);
  const trak = atom('trak', atom('mdia', mdhd, hdlr, atom('minf', atom('stbl', stsd))));
  const moov = atom('moov', mvhd, trak, udta);
  const ftyp = atom('ftyp', latin('M4A '), be32(0), latin('M4A mp42isom'));
  const mdat = atom('mdat', new Uint8Array(2000));
  // moov at the end (like many streaming-unfriendly encoders)
  return concat(ftyp, mdat, moov);
}

// ---------- WAV ----------
export function wavFile({ sampleRate = 44100, channels = 2, bits = 16, seconds = 1, info = {}, id3 = null }) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const fmt = concat(latin('fmt '), le32(16), le16(1), le16(channels), le32(sampleRate), le32(byteRate), le16((channels * bits) / 8), le16(bits));
  const dataLen = Math.round(byteRate * seconds);
  const data = concat(latin('data'), le32(dataLen), new Uint8Array(dataLen));
  const subs = Object.entries(info).map(([k, v]) => {
    let b = concat(latin(v), Uint8Array.of(0));
    if (b.length & 1) b = concat(b, Uint8Array.of(0));
    return concat(latin(k), le32(b.length), b);
  });
  const listBody = concat(latin('INFO'), ...subs);
  const list = concat(latin('LIST'), le32(listBody.length), listBody);
  const chunks = [fmt, list, data];
  if (id3) chunks.push(concat(latin('id3 '), le32(id3.length), id3, id3.length & 1 ? Uint8Array.of(0) : new Uint8Array(0)));
  const body = concat(latin('WAVE'), ...chunks);
  return concat(latin('RIFF'), le32(body.length), body);
}

// ---------- OGG ----------
function oggPage({ serial, seq, granule, headerType, packets }) {
  const segTable = [];
  const payload = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      segTable.push(255);
      n -= 255;
    }
    segTable.push(n);
    payload.push(p);
  }
  const g = new Uint8Array(8);
  let v = granule;
  for (let i = 0; i < 8; i++) {
    g[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return concat(latin('OggS'), Uint8Array.of(0, headerType), g, le32(serial), le32(seq), le32(0), Uint8Array.of(segTable.length), Uint8Array.from(segTable), ...payload);
}

export function oggVorbisFile({ sampleRate = 44100, channels = 2, totalSamples = 441000, comments = {} }) {
  const ident = concat(Uint8Array.of(1), latin('vorbis'), le32(0), Uint8Array.of(channels), le32(sampleRate), le32(0), le32(128000), le32(0), Uint8Array.of(0xb8, 1));
  const vendor = enc('test');
  const entries = Object.entries(comments).map(([k, v]) => enc(`${k}=${v}`));
  const comment = concat(Uint8Array.of(3), latin('vorbis'), le32(vendor.length), vendor, le32(entries.length), ...entries.flatMap((e) => [le32(e.length), e]), Uint8Array.of(1));
  const setup = concat(Uint8Array.of(5), latin('vorbis'), new Uint8Array(20));
  const serial = 1234;
  return concat(
    oggPage({ serial, seq: 0, granule: 0, headerType: 2, packets: [ident] }),
    oggPage({ serial, seq: 1, granule: 0, headerType: 0, packets: [comment, setup] }),
    oggPage({ serial, seq: 2, granule: 1000, headerType: 0, packets: [new Uint8Array(300)] }),
    oggPage({ serial, seq: 3, granule: totalSamples, headerType: 4, packets: [new Uint8Array(300)] }),
  );
}
