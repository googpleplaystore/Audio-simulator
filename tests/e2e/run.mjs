#!/usr/bin/env node
// End-to-end tests in headless Chromium via Playwright.
// Usage: npm run test:e2e   (requires Playwright + a Chromium build)
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../../scripts/serve.mjs';
import { encodeWav } from '../../src/audio/wav.js';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  }
}

const ART = fileURLToPath(new URL('./artifacts/', import.meta.url));
await mkdir(ART, { recursive: true });

// ---------------------------------------------------------------- fixtures
function toneWav(seconds, freq, sampleRate = 44100, meta = {}) {
  const n = Math.round(seconds * sampleRate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2000, (n - i) / 2000);
    l[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.4 * env;
    r[i] = Math.sin((2 * Math.PI * freq * 1.5 * i) / sampleRate) * 0.4 * env;
  }
  return encodeWav({ channels: [l, r], sampleRate }, { bitDepth: 16, meta });
}

async function writeFixtures() {
  const dir = join(ART, 'fixtures');
  await mkdir(dir, { recursive: true });
  const files = [];
  const specs = [
    ['01 - Test Artist - First Tone.wav', 3, 220, { title: 'First Tone', artist: 'Test Artist', album: 'E2E Album' }],
    ['02 - Test Artist - Second Tone.wav', 3, 330, { title: 'Second Tone', artist: 'Test Artist', album: 'E2E Album' }],
    ['03 - Other Artist - Third Tone.wav', 2.5, 110, { title: 'Third Tone', artist: 'Other Artist', album: 'E2E Album' }],
  ];
  for (const [name, sec, f, meta] of specs) {
    const blob = toneWav(sec, f, 44100, meta);
    const p = join(dir, name);
    await writeFile(p, Buffer.from(await blob.arrayBuffer()));
    files.push(p);
  }
  const bad = join(dir, 'Broken File.mp3');
  await writeFile(bad, Buffer.from('ID3 this is definitely not an mp3 file'.repeat(40)));
  files.push(bad);
  return files;
}

// ---------------------------------------------------------------- harness
const results = [];
let page;
const consoleErrors = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n      ')}`);
    try {
      await page.screenshot({ path: join(ART, `fail-${name.replace(/[^a-z0-9]+/gi, '_')}.png`) });
    } catch {
      /* ignore */
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const evalApp = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

async function waitFor(fn, { timeout = 15000, interval = 100, message = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalApp(fn);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for ${message}`);
    await wait(interval);
  }
}

// ---------------------------------------------------------------- run
const { chromium } = await loadPlaywright();
const server = await startServer(0);
const base = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1480, height: 920 }, acceptDownloads: true });
page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
const fixtures = await writeFixtures();

console.log('AudioSpace end-to-end tests');

await step('boots to onboarding without errors', async () => {
  await page.goto(base);
  await page.waitForSelector('text=Welcome to');
  assert(await page.isVisible('text=Import music folder'), 'import button visible');
});

await step('imports local files with tag + filename metadata', async () => {
  const chooser = page.waitForEvent('filechooser');
  await page.click('text=Choose files');
  await (await chooser).setFiles(fixtures);
  await waitFor(() => window.__audiospace.library.size >= 3, { message: 'import' });
  const info = await evalApp(() => {
    const lib = window.__audiospace.library;
    const t = [...lib.tracks.values()].find((x) => x.title === 'First Tone');
    return { size: lib.size, artist: t?.artist, album: t?.album, track: t?.track, dur: t?.duration, albums: lib.albums.size };
  });
  assert(info.artist === 'Test Artist', `artist ${info.artist}`);
  assert(info.album === 'E2E Album', `album ${info.album}`);
  assert(info.track === 1, `track number from filename ${info.track}`);
  assert(Math.abs(info.dur - 3) < 0.05, `duration ${info.dur}`);
});

await step('adds demo + calibration tracks', async () => {
  await evalApp(() => window.__audiospace.installDemo());
  await waitFor(() => window.__audiospace.library.size >= 13, { message: 'demo install' });
});

await step('plays a track through the simulation engine', async () => {
  await page.goto(`${base}#/songs`);
  await page.waitForSelector('.tl-row');
  const row = page.locator('.tl-row', { hasText: 'First Tone' });
  await row.locator('.tl-title-text').dblclick();
  await waitFor(() => window.__audiospace.player.state === 'playing', { message: 'playing' });
  await wait(1200);
  const s = await evalApp(() => {
    const a = window.__audiospace;
    const buf = new Float32Array(2048);
    a.engine.taps.L.getFloatTimeDomainData(buf);
    let pk = 0;
    for (const v of buf) pk = Math.max(pk, Math.abs(v));
    return { pk, t: a.player.currentTime, chains: a.engine.chains.size, ctx: a.ctx.state, spl: a.engine.meters.spl };
  });
  assert(s.ctx === 'running', 'context running');
  assert(s.pk > 0.001, `signal at listener (peak ${s.pk})`);
  assert(s.t > 0.5, `time advancing ${s.t}`);
  assert(s.chains === 3, `3 source chains (${s.chains})`);
  assert(s.spl > 40 && s.spl < 120, `plausible SPL ${s.spl}`);
});

await step('A/B bypass crossfades to the direct path', async () => {
  await page.keyboard.press('b');
  await wait(300);
  const g = await evalApp(() => ({ sim: window.__audiospace.engine.simX.gain.value, dir: window.__audiospace.engine.directX.gain.value }));
  assert(g.sim < 0.05 && g.dir > 0.95, `bypass gains ${JSON.stringify(g)}`);
  await page.keyboard.press('b');
  await wait(300);
});

await step('corrupt file is reported and skipped', async () => {
  const before = await evalApp(() => window.__audiospace.player.track?.title);
  await evalApp(() => {
    const a = window.__audiospace;
    const bad = [...a.library.tracks.values()].find((t) => t.name === 'Broken File.mp3');
    const good = [...a.library.tracks.values()].find((t) => t.title === 'Second Tone');
    return a.playTracks([bad.id, good.id], 0, { type: 'test', name: 'Test' });
  });
  await page.waitForSelector('.toast.error', { timeout: 8000 });
  await waitFor(() => window.__audiospace.player.track?.title === 'Second Tone' && window.__audiospace.player.state === 'playing', { message: 'skip to next after error', timeout: 10000 });
  void before;
});

await step('queue: add to queue via context menu and reorder by dragging', async () => {
  // Pause so a short fixture finishing doesn't consume the queue mid-test.
  await evalApp(() => window.__audiospace.player.pause());
  await page.goto(`${base}#/songs`);
  await page.waitForSelector('.tl-row');
  for (const title of ['Third Tone', 'First Tone']) {
    await page.locator('.tl-row', { hasText: title }).click({ button: 'right' });
    await page.click('.menu-item:has-text("Add to queue")');
  }
  const manual = await evalApp(() => window.__audiospace.queue.manual.map((m) => window.__audiospace.library.get(m.id).title));
  assert(manual.join('|') === 'Third Tone|First Tone', `manual queue ${manual}`);
  await page.waitForSelector('.q-list[data-section="manual"] .q-item');
  const items = page.locator('.q-list[data-section="manual"] .q-item .grip');
  const a = await items.nth(0).boundingBox();
  const b = await items.nth(1).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 8, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 12, { steps: 4 });
  await page.mouse.up();
  await wait(200);
  const after = await evalApp(() => window.__audiospace.queue.manual.map((m) => window.__audiospace.library.get(m.id).title));
  assert(after.join('|') === 'First Tone|Third Tone', `reordered queue ${after}`);
});

await step('like a song and see it in Liked Songs', async () => {
  const row = page.locator('.tl-row', { hasText: 'Second Tone' });
  await row.hover();
  await row.locator('.tl-like').click();
  await page.goto(`${base}#/liked`);
  await page.waitForSelector('.tl-row:has-text("Second Tone")');
});

await step('create a playlist and drag a song onto it', async () => {
  page.once('dialog', () => {});
  await page.click('.nav-section button[aria-label="Create playlist"]');
  await page.fill('.modal input', 'Road Trip');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.nav-playlist:has-text("Road Trip")');
  await page.goto(`${base}#/songs`);
  await page.waitForSelector('.tl-row');
  await page.dragAndDrop('.tl-row:has-text("Neon Sub Pressure") .tl-title-text', '.nav-playlist:has-text("Road Trip")');
  await waitFor(() => [...window.__audiospace.library.playlists.values()].some((p) => p.name === 'Road Trip' && p.trackIds.length === 1), { message: 'playlist add' });
});

await step('real-time search filters the library', async () => {
  await page.fill('.search-box input', '808');
  await page.waitForFunction(() => location.hash.startsWith('#/search?q=808'));
  await page.waitForSelector('.search-top');
  await page.waitForSelector('.tracklist .tl-row:has-text("808 Midnight Drive")');
  const n = await page.locator('.tracklist .tl-row').count();
  assert(n === 1, `one result row (${n})`);
  await page.fill('.search-box input', '');
});

await step('room: drag the subwoofer into a corner → corner loading & new modal filters', async () => {
  await page.goto(`${base}#/studio/room`);
  await page.waitForSelector('canvas.room-canvas');
  await wait(600);
  const before = await evalApp(() => JSON.stringify(window.__audiospace.engine.roomFilters['sub-1']?.filters || []));
  const geo = await evalApp(() => {
    const s = window.__audiospace.store.state;
    return { sub: s.subs[0], room: s.room };
  });
  const box = await page.locator('canvas.room-canvas').boundingBox();
  // Reconstruct the editor layout (same maths as RoomEditor._layout).
  const M = 54;
  const scale = Math.min((box.width - M * 2) / geo.room.width, (box.height - M * 2) / geo.room.depth);
  const ox = box.x + (box.width - geo.room.width * scale) / 2;
  const oy = box.y + (box.height - geo.room.depth * scale) / 2;
  await page.mouse.move(ox + geo.sub.x * scale, oy + geo.sub.z * scale);
  await page.mouse.down();
  await page.mouse.move(ox + (geo.room.width - 0.1) * scale, oy + (geo.room.depth - 0.1) * scale, { steps: 12 });
  await page.mouse.up();
  const sub = await evalApp(() => window.__audiospace.store.state.subs[0]);
  assert(sub.x > geo.room.width - 0.6 && sub.z > geo.room.depth - 0.6, `sub moved to corner (${sub.x}, ${sub.z})`);
  await waitFor(() => window.__audiospace.engine.roomInfo && window.__audiospace.engine.roomInfo.results['sub-1'], { message: 'room filters' });
  await wait(600);
  const after = await evalApp(() => ({ f: JSON.stringify(window.__audiospace.engine.roomFilters['sub-1']?.filters || []), b: window.__audiospace.engine.roomFilters['sub-1']?.boundaryDb }));
  assert(after.f !== before, 'modal filters recomputed');
  assert(after.b > 4, `corner loading ${after.b}`);
});

await step('room: bass heatmap renders', async () => {
  await page.click('label.toggle:has-text("Bass heatmap")');
  await page.waitForSelector('.heat-legend:has-text("relative to your seat")', { timeout: 15000 });
});

await step('hardware: assign Klipsch RP-600M II to L+R', async () => {
  await page.goto(`${base}#/studio/hardware`);
  await page.locator('.hw-card', { hasText: 'RP-600M II' }).locator('button:has-text("Use L+R")').click();
  const ids = await evalApp(() => window.__audiospace.store.state.speakers.map((s) => s.modelId));
  assert(ids.every((id) => id === 'klipsch-rp-600m-ii'), `models ${ids}`);
  await wait(200);
  const plan = await evalApp(() => window.__audiospace.engine.plan.sources[0].hw.id);
  assert(plan === 'klipsch-rp-600m-ii', 'engine uses new model');
});

await step('receiver: auto setup produces trims and room correction', async () => {
  await page.goto(`${base}#/studio/receiver`);
  await page.click('.avr-btn:has-text("AUTO SETUP")');
  await page.waitForSelector('.modal:has-text("Auto setup complete")');
  await page.click('.modal .btn.primary');
  const rc = await evalApp(() => window.__audiospace.store.state.roomCorrection);
  assert(rc.enabled && rc.filters.length > 0, 'room correction filters');
});

await step('crossover: LR48 slope programs four biquads per filter bank', async () => {
  await page.goto(`${base}#/studio/crossover`);
  await page.click('.segmented button:has-text("LR 48 dB")');
  await wait(200);
  const q = await evalApp(() => window.__audiospace.engine.lfe.filters.map((f) => [f.type, Math.round(f.Q.value * 100) / 100]));
  assert(q.every(([t]) => t === 'lowpass'), `types ${JSON.stringify(q)}`);
  assert(Math.abs(q[0][1] - -5.33) < 0.05 && Math.abs(q[1][1] - 2.32) < 0.05, `LR8 Q values ${JSON.stringify(q)}`);
  await page.click('button:has-text("Optimize")');
  await page.waitForSelector('.toast:has-text("Best integration")');
});

await step('EQ: V-shape preset and room correction measurement', async () => {
  await page.goto(`${base}#/studio/eq`);
  await page.waitForSelector('.geq-faders');
  await page.selectOption('.card:has-text("31-band") select', 'v-shape-extreme');
  await wait(200);
  const g = await evalApp(() => ({ gains: window.__audiospace.store.state.eq.graphic.gains, active: window.__audiospace.engine.geq.filters.filter((f) => f.gain.value !== 0).length, pre: window.__audiospace.engine.plan.eqMaxBoost }));
  assert(g.gains[0] === 9 && g.gains[30] === 9, 'preset gains');
  assert(g.pre > 8, `auto headroom ${g.pre}`);
  await page.click('button:has-text("Measure & correct")');
  await page.waitForSelector('.toast:has-text("Room correction applied")');
});

await step('analyzers draw pixels', async () => {
  await evalApp(() => window.__audiospace.player.play());
  await page.goto(`${base}#/studio/analyzers`);
  await wait(1500);
  const lit = await evalApp(() => {
    const c = document.querySelector('.viz-box.spectrum canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++;
    return n;
  });
  assert(lit > 50, `spectrum pixels ${lit}`);
});

await step('bake renders a WAV download', async () => {
  const id = await evalApp(() => [...window.__audiospace.library.tracks.values()].find((t) => t.title === 'Third Tone').id);
  await page.goto(`${base}#/studio/bake?track=${encodeURIComponent(id)}`);
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.click('button:has-text("Bake to WAV")');
  const d = await dl;
  const path = join(ART, 'baked.wav');
  await d.saveAs(path);
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  assert(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE', 'wav header');
  assert(buf.length > 48000 * 2 * 3 * 2, `wav size ${buf.length}`);
});

await step('settings: speaker output switches panners to equal-power', async () => {
  await page.goto(`${base}#/settings`);
  await page.click('.segmented button:has-text("Speakers (equal-power)")');
  await wait(100);
  const models = await evalApp(() => [...window.__audiospace.engine.chains.values()].map((c) => c.panner.panningModel));
  assert(models.every((m) => m === 'equalpower'), `panning ${models}`);
});

await step('state and library persist across reload', async () => {
  await wait(700); // debounced save
  await page.reload();
  await page.waitForSelector('.nav-playlist:has-text("Road Trip")', { timeout: 15000 });
  const s = await evalApp(() => ({ n: window.__audiospace.library.size, preset: window.__audiospace.store.state.eq.graphic.preset, out: window.__audiospace.store.state.engine.output, spk: window.__audiospace.store.state.speakers[0].modelId }));
  assert(s.n >= 13, `library size ${s.n}`);
  assert(s.preset === 'v-shape-extreme', `eq preset ${s.preset}`);
  assert(s.out === 'speakers', 'output mode');
  assert(s.spk === 'klipsch-rp-600m-ii', 'speaker model');
});

await step('every view renders without console errors', async () => {
  for (const v of ['home', 'songs', 'albums', 'artists', 'genres', 'liked', 'playlists', 'now-playing', 'search?q=tone', 'studio/room', 'studio/hardware', 'studio/hardware/svs-pb-1000-pro', 'studio/receiver', 'studio/crossover', 'studio/eq', 'studio/analyzers', 'studio/bake', 'settings']) {
    await page.goto(`${base}#/${v}`);
    await wait(250);
  }
  const album = await evalApp(() => [...window.__audiospace.library.albums.keys()][0]);
  await page.goto(`${base}#/album/${encodeURIComponent(album)}`);
  await wait(250);
  assert(!(await page.locator('.tl-head:has-text("null")').count()), 'no literal null in headers');
});

await step('no console errors during the whole run', async () => {
  const relevant = consoleErrors.filter((e) => !/Failed to load resource|MEDIA_ERR|DEMUXER|PIPELINE_ERROR|format or codec|could not be decoded/i.test(e));
  assert(!relevant.length, `console errors:\n${relevant.join('\n')}`);
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
