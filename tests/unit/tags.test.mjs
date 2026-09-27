import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, isAudioFileName } from '../../src/library/tags/index.js';
import { normalizeGenre } from '../../src/library/tags/genres.js';
import { parseFilename } from '../../src/util/format.js';
import {
  concat, id3Tag, id3Text, id3Frame, mp3Frames, id3v1, flacFile, m4aFile, wavFile, oggVorbisFile, PNG, latin, enc,
} from './fixtures.mjs';

const blob = (bytes) => new Blob([bytes]);

test('ID3v2.3 MP3 with art, replaygain and CBR duration', async () => {
  const apic = id3Frame(3, 'APIC', concat(Uint8Array.of(0), latin('image/png'), Uint8Array.of(0, 3), latin('cover'), Uint8Array.of(0), PNG));
  const txxx = id3Frame(3, 'TXXX', concat(Uint8Array.of(0), latin('REPLAYGAIN_TRACK_GAIN'), Uint8Array.of(0), latin('-6.20 dB')));
  const tag = id3Tag(3, [
    id3Text(3, 'TIT2', 'Café del Mar', 1),
    id3Text(3, 'TPE1', 'Energy 52', 0),
    id3Text(3, 'TALB', 'Anthems', 0),
    id3Text(3, 'TCON', '(17)', 0),
    id3Text(3, 'TRCK', '3/12', 0),
    id3Text(3, 'TYER', '1999', 0),
    apic,
    txxx,
  ]);
  const file = concat(tag, mp3Frames(100));
  const t = await parseTags(blob(file));
  assert.equal(t.format, 'mp3');
  assert.equal(t.title, 'Café del Mar');
  assert.equal(t.artist, 'Energy 52');
  assert.equal(t.album, 'Anthems');
  assert.equal(t.genre, 'Rock');
  assert.equal(t.track, 3);
  assert.equal(t.trackTotal, 12);
  assert.equal(t.year, 1999);
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.channels, 2);
  assert.equal(t.bitrate, 128);
  assert.ok(Math.abs(t.duration - 2.606) < 0.02, String(t.duration));
  assert.equal(t.picture.mime, 'image/png');
  assert.equal(t.picture.data.length, PNG.length);
  assert.equal(t.replayGain.trackGain, -6.2);
});

test('Xing VBR header drives MP3 duration', async () => {
  const t = await parseTags(blob(concat(id3Tag(3, [id3Text(3, 'TIT2', 'VBR', 0)]), mp3Frames(10, { xingFrames: 1000 }))));
  assert.ok(Math.abs(t.duration - (1000 * 1152) / 44100) < 0.01, String(t.duration));
  assert.equal(t.vbr, true);
});

test('ID3v2.4 UTF-8 multi-value and v2.2 frames', async () => {
  const t4 = await parseTags(
    blob(concat(id3Tag(4, [id3Text(4, 'TIT2', 'Ünïcødé ✓', 3), id3Text(4, 'TPE1', 'A\u0000B', 3), id3Text(4, 'TDRC', '2021-05-01', 3)]), mp3Frames(5))),
  );
  assert.equal(t4.title, 'Ünïcødé ✓');
  assert.equal(t4.artist, 'A; B');
  assert.equal(t4.year, 2021);
  const pic = id3Frame(2, 'PIC', concat(Uint8Array.of(0), latin('PNG'), Uint8Array.of(3), Uint8Array.of(0), PNG));
  const t2 = await parseTags(blob(concat(id3Tag(2, [id3Text(2, 'TT2', 'Old School', 0), id3Text(2, 'TP1', 'Legacy', 0), pic]), mp3Frames(5))));
  assert.equal(t2.title, 'Old School');
  assert.equal(t2.artist, 'Legacy');
  assert.equal(t2.picture.mime, 'image/png');
});

test('ID3v1 fallback', async () => {
  const t = await parseTags(blob(concat(mp3Frames(20), id3v1({ title: 'V1 Title', artist: 'V1 Artist', album: 'V1 Album', year: '1987', track: 7, genre: 8 }))));
  assert.equal(t.title, 'V1 Title');
  assert.equal(t.artist, 'V1 Artist');
  assert.equal(t.track, 7);
  assert.equal(t.genre, 'Jazz');
  assert.equal(t.year, 1987);
});

test('FLAC STREAMINFO, Vorbis comments and PICTURE', async () => {
  const t = await parseTags(
    blob(
      flacFile({
        sampleRate: 96000,
        bits: 24,
        totalSamples: 96000 * 42,
        comments: { TITLE: 'Hi-Res', ARTIST: 'Studio', ALBUMARTIST: 'Various', ALBUM: 'Masters', GENRE: 'Classical', TRACKNUMBER: '5', TRACKTOTAL: '9', DATE: '2019', REPLAYGAIN_TRACK_GAIN: '+1.5 dB' },
        picture: PNG,
      }),
    ),
  );
  assert.equal(t.format, 'flac');
  assert.equal(t.sampleRate, 96000);
  assert.equal(t.bitsPerSample, 24);
  assert.equal(t.channels, 2);
  assert.ok(Math.abs(t.duration - 42) < 1e-6);
  assert.equal(t.title, 'Hi-Res');
  assert.equal(t.albumArtist, 'Various');
  assert.equal(t.track, 5);
  assert.equal(t.trackTotal, 9);
  assert.equal(t.year, 2019);
  assert.equal(t.replayGain.trackGain, 1.5);
  assert.equal(t.picture.data.length, PNG.length);
});

test('FLAC with a leading ID3v2 tag', async () => {
  const t = await parseTags(blob(concat(id3Tag(3, [id3Text(3, 'TCOM', 'Composer X', 0)]), flacFile({ comments: { TITLE: 'Wrapped' } }))));
  assert.equal(t.format, 'flac');
  assert.equal(t.title, 'Wrapped');
  assert.equal(t.composer, 'Composer X');
});

test('M4A with moov at end, iTunes atoms and cover', async () => {
  const t = await parseTags(blob(m4aFile({ title: 'Apple Tune', artist: 'Band', album: 'LP', track: 2, trackTotal: 10, genreIndex: 13, cover: PNG, durationSec: 215 })));
  assert.equal(t.format, 'm4a');
  assert.equal(t.codec, 'AAC');
  assert.equal(t.title, 'Apple Tune');
  assert.equal(t.artist, 'Band');
  assert.equal(t.album, 'LP');
  assert.equal(t.track, 2);
  assert.equal(t.trackTotal, 10);
  assert.equal(t.genre, 'Pop');
  assert.equal(t.duration, 215);
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.channels, 2);
  assert.equal(t.picture.mime, 'image/png');
  assert.equal(t.replayGain.trackGain, -7.25);
});

test('WAV with LIST/INFO and id3 chunk', async () => {
  const t = await parseTags(
    blob(wavFile({ sampleRate: 48000, seconds: 0.5, info: { INAM: 'Wave Title', IART: 'Wave Artist', ICRD: '2001' }, id3: id3Tag(3, [id3Text(3, 'TALB', 'Wave Album', 0)]) })),
  );
  assert.equal(t.format, 'wav');
  assert.equal(t.sampleRate, 48000);
  assert.ok(Math.abs(t.duration - 0.5) < 1e-6);
  assert.equal(t.title, 'Wave Title');
  assert.equal(t.artist, 'Wave Artist');
  assert.equal(t.album, 'Wave Album');
  assert.equal(t.year, 2001);
  assert.equal(t.bitrate, 1536);
});

test('Ogg Vorbis comments and granule duration', async () => {
  const t = await parseTags(blob(oggVorbisFile({ sampleRate: 44100, totalSamples: 44100 * 12, comments: { TITLE: 'Ogg Song', ARTIST: 'Xiph', GENRE: 'Electronic' } })));
  assert.equal(t.format, 'ogg');
  assert.equal(t.codec, 'Vorbis');
  assert.equal(t.title, 'Ogg Song');
  assert.equal(t.artist, 'Xiph');
  assert.equal(t.genre, 'Electronic');
  assert.ok(Math.abs(t.duration - 12) < 1e-6);
});

test('unknown data does not throw', async () => {
  const t = await parseTags(blob(enc('hello world, definitely not audio')));
  assert.equal(t.format, 'unknown');
});

test('genre + filename helpers', () => {
  assert.equal(normalizeGenre('(17)Rock'), 'Rock');
  assert.equal(normalizeGenre('13'), 'Pop');
  assert.equal(normalizeGenre('Hip-Hop'), 'Hip-Hop');
  assert.deepEqual(parseFilename('03 - Daft Punk - Around the World.mp3'), { track: 3, artist: 'Daft Punk', title: 'Around the World' });
  assert.deepEqual(parseFilename('Just A Title.flac'), { track: null, artist: null, title: 'Just A Title' });
  assert.ok(isAudioFileName('song.FLAC'));
  assert.ok(!isAudioFileName('cover.jpg'));
});
