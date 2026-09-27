import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getBookshelfSpeakers,
  getSubwoofers,
  getHardware,
  responseCurve,
  speakerResponseSpecs,
  subResponseSpecs,
  soundTags,
  DEFAULT_SPEAKER_ID,
  DEFAULT_SUB_ID,
  exportDatabase,
} from '../../src/hardware/index.js';
import { cascadeMagnitudeDb } from '../../src/dsp/biquad.js';

const REQUIRED_SEEDS_BOOKSHELF = [
  'Edifier R1280DBs', 'Klipsch RP-600M II', 'KEF LS50 Meta', 'Audioengine A2+', 'Audioengine HD6', 'Sony SS-CS5',
  'Polk Audio T15', 'ELAC Debut 2.0 B6.2', 'Micca PB42X', 'Vanatoo Transparent Zero', 'Sonos Era 100',
  'Q Acoustics 3020i', 'Bowers & Wilkins 607 S3', 'PreSonus Eris E3.5', 'Dali Spektor 2', 'Monitor Audio Bronze 50',
];
const REQUIRED_SEEDS_SUBS = [
  'SVS SB-1000 Pro', 'SVS PB-1000 Pro', 'Klipsch R-120SW', 'Klipsch R-100SW', 'Monoprice 9723 (8" 60W)', 'Sonos Sub Mini',
  'KEF KC62', 'RSL Speedwoofer 10S II', 'Polk Audio PSW10', 'Sony SA-CS9', 'ELAC Debut 2.0 SUB3030', 'Audioengine S8',
  'Pyle PW18SUBA', 'Bose Bass Module 700', 'Dayton Audio SUB-1200', 'BIC America F12',
];

test('exactly 100 bookshelf speakers and 100 subwoofers', () => {
  assert.equal(getBookshelfSpeakers().length, 100);
  assert.equal(getSubwoofers().length, 100);
});

test('all required seed models are present', () => {
  const names = new Set([...getBookshelfSpeakers(), ...getSubwoofers()].map((e) => e.name));
  for (const n of [...REQUIRED_SEEDS_BOOKSHELF, ...REQUIRED_SEEDS_SUBS]) assert.ok(names.has(n), n);
});

test('ids are unique and ranks are 1..100', () => {
  for (const list of [getBookshelfSpeakers(), getSubwoofers()]) {
    const ids = new Set(list.map((e) => e.id));
    assert.equal(ids.size, list.length);
    assert.deepEqual(list.map((e) => e.rank), Array.from({ length: 100 }, (_, i) => i + 1));
  }
  assert.ok(getHardware(DEFAULT_SPEAKER_ID));
  assert.ok(getHardware(DEFAULT_SUB_ID));
});

test('every entry carries the required spec fields', () => {
  for (const e of getBookshelfSpeakers()) {
    assert.ok(e.woofer.size > 0, e.id);
    assert.ok(['ported', 'sealed', 'pr'].includes(e.enclosure), e.id);
    assert.ok(e.freqLow > 20 && e.freqLow < 120, `${e.id} freqLow ${e.freqLow}`);
    assert.ok(e.freqHigh >= 15000, e.id);
    assert.ok(e.rmsWatts > 0, e.id);
    assert.ok(e.sensitivity > 80 && e.sensitivity < 100, `${e.id} sens ${e.sensitivity}`);
    assert.ok(['$', '$$', '$$$', '$$$$'].includes(e.priceBracket));
    assert.ok(Array.isArray(e.voicing));
  }
  for (const e of getSubwoofers()) {
    assert.ok(e.driver.size >= 6, e.id);
    assert.ok(e.freqLow >= 10 && e.freqLow <= 60, `${e.id} ${e.freqLow}`);
    assert.ok(e.freqHigh >= 100 && e.freqHigh <= 300, `${e.id} ${e.freqHigh}`);
    assert.ok(e.rmsWatts >= 50, e.id);
    assert.ok(e.maxSpl > 90 && e.maxSpl < 130, `${e.id} ${e.maxSpl}`);
  }
});

test('modelled response is -3 dB-ish at f3 and roughly flat in the passband', () => {
  const kef = getHardware('kef-ls50-meta');
  const db = cascadeMagnitudeDb(speakerResponseSpecs(kef), [kef.f3, 1000]);
  assert.ok(db[0] - db[1] < -1 && db[0] - db[1] > -6, `f3 rel ${db[0] - db[1]}`);
  const svs = getHardware('svs-pb-1000-pro');
  const s = cascadeMagnitudeDb(subResponseSpecs(svs), [10, 18, 50]);
  assert.ok(s[0] < s[2] - 10, 'ported sub rolls off steeply below tuning');
});

test('Klipsch is voiced brighter than KEF; SVS extends deeper than Monoprice', () => {
  const k = responseCurve(getHardware('klipsch-rp-600m-ii'), [1000, 10000]).db;
  const kef = responseCurve(getHardware('kef-ls50-meta'), [1000, 10000]).db;
  assert.ok(k[1] - k[0] > kef[1] - kef[0] + 1.5);
  const svs = responseCurve(getHardware('svs-sb-1000-pro'), [25, 60]).db;
  const mono = responseCurve(getHardware('monoprice-9723-8in-60w'), [25, 60]).db;
  assert.ok(svs[0] - svs[1] > mono[0] - mono[1] + 6);
  assert.ok(soundTags(getHardware('klipsch-rp-600m-ii')).includes('Bright'));
});

test('database exports as JSON', () => {
  const json = JSON.stringify(exportDatabase());
  assert.ok(json.length > 50000);
});
