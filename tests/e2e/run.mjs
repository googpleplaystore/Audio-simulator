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

await step('room: 3D view renders, drags objects and orbits', async () => {
  await page.goto(`${base}#/studio/room`);
  await page.click('.room-toolbar .segmented button:has-text("3D")');
  await page.waitForFunction(() => window.__audiospace.currentView?.editor?.constructor?.name === 'Room3D');
  await page.evaluate(() => document.querySelector('.room-canvas').scrollIntoView({ block: 'end' }));
  await wait(300);
  const pos = await evalApp(() => {
    const ed = window.__audiospace.currentView.editor;
    const s = window.__audiospace.store.state.subs[0];
    const r = ed.canvas.getBoundingClientRect();
    const p = ed.project({ x: s.x, y: (ed._objects().find((o) => o.id === s.id).cy), z: s.z });
    return { x: r.left + p[0], y: r.top + p[1], before: [s.x, s.z] };
  });
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  // Drag toward the room centre (the sub may already sit in a corner).
  const centre = await evalApp(() => {
    const ed = window.__audiospace.currentView.editor;
    const r = ed.canvas.getBoundingClientRect();
    const room = window.__audiospace.store.state.room;
    const p = ed.project({ x: room.width / 2, y: 0.2, z: room.depth / 2 });
    return { x: r.left + p[0], y: r.top + p[1] };
  });
  await page.mouse.move((pos.x + centre.x) / 2, (pos.y + centre.y) / 2, { steps: 6 });
  await page.mouse.up();
  const after = await evalApp(() => [window.__audiospace.store.state.subs[0].x, window.__audiospace.store.state.subs[0].z]);
  assert(Math.hypot(after[0] - pos.before[0], after[1] - pos.before[1]) > 0.2, `sub moved in 3D ${pos.before} -> ${after}`);
  const cv = await page.$('.room-canvas');
  const b = await cv.boundingBox();
  const yaw0 = await evalApp(() => window.__audiospace.currentView.editor.cam.yaw);
  await page.mouse.move(b.x + 20, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 160, b.y + 60, { steps: 5 });
  await page.mouse.up();
  const yaw1 = await evalApp(() => window.__audiospace.currentView.editor.cam.yaw);
  assert(Math.abs(yaw1 - yaw0) > 0.3, 'orbit changes the camera');
  const lit = await page.evaluate(() => {
    const c = document.querySelector('.room-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) n++;
    return n;
  });
  assert(lit > 2000, `3D scene drew ${lit} bright pixels`);
  await page.click('.room-toolbar .segmented button:has-text("2D plan")');
  await page.waitForFunction(() => window.__audiospace.currentView?.editor?.constructor?.name === 'RoomEditor');
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

await step('true-peak limiter: realtime worklet attached, hot bake stays under the ceiling', async () => {
  const attached = await evalApp(async () => {
    await window.__audiospace.engine.ready;
    return !!window.__audiospace.engine.tpLimiter;
  });
  assert(attached, 'limiter worklet not attached to the realtime engine');
  const res = await page.evaluate(async () => {
    const app = window.__audiospace;
    const { bakeTrack } = await import('/src/audio/bake.js');
    const t = [...app.library.tracks.values()].find((x) => x.title === 'Pink Noise (Uncorrelated Stereo)') || [...app.library.tracks.values()].find((x) => x.source === 'demo');
    const state = JSON.parse(JSON.stringify(app.store.state));
    state.receiver.masterDb = 12; // drive everything well past full scale
    state.engine.limiter = true;
    state.engine.ceilingDb = -1;
    const r = await bakeTrack({ blob: await app.library.getFile(t.id), state, duration: 4, tail: 0.5, bitDepth: 32 });
    return { tp: r.truePeakDb, sp: r.peakDb };
  });
  assert(res.tp <= -1 + 0.15, `true peak ${res.tp.toFixed(2)} dBTP exceeds −1 dBTP ceiling`);
  assert(res.sp <= -1 + 1e-3, `sample peak ${res.sp.toFixed(2)} dBFS`);
  assert(res.sp > -6, `limiter should be working hard, got ${res.sp.toFixed(2)} dBFS`);
});

await step('measurements: sweep, analyses and sweep-based auto-EQ', async () => {
  await page.goto(`${base}#/studio/measure`);
  await page.click('button:has-text("Measure")');
  await page.waitForSelector('.meas-item', { timeout: 60000 });
  const s = await evalApp(() => {
    const m = window.__audiospace.measurements.current;
    return { spl: m.peakSpl, n: m.ir.length, fs: m.sampleRate, harm: m.harmonics.length };
  });
  assert(s.spl > 60 && s.spl < 130, `peak SPL ${s.spl}`);
  assert(s.n > s.fs * 0.5 && s.harm === 4, 'IR and harmonic IRs captured');
  for (const tab of ['Phase', 'Group delay', 'Impulse', 'Step', 'ETC', 'RT60', 'Waterfall', 'Distortion', 'SPL']) {
    await page.click(`.meas-controls .segmented button:has-text("${tab}")`);
    await wait(120);
  }
  const lit = await page.evaluate(() => {
    const c = document.querySelector('.meas-plot canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  assert(lit > 5000, `measurement plot drew ${lit} pixels`);
  // Auto-EQ: measures, applies bounded correction, verifies.
  await page.click('button:has-text("Auto-EQ from sweep")');
  await page.waitForFunction(() => document.querySelectorAll('.meas-item').length >= 3, null, { timeout: 90000 });
  const rc = await evalApp(async () => {
    const { cascadeMagnitudeDb } = await import('/src/dsp/biquad.js');
    const { octaveGrid } = await import('/src/util/math.js');
    const st = window.__audiospace.store.state;
    const db = cascadeMagnitudeDb(st.roomCorrection.filters, octaveGrid(10, 20000, 48), 48000);
    return { on: st.roomCorrection.enabled, n: st.roomCorrection.filters.length, boost: Math.max(...db), limit: st.roomCorrection.maxBoost };
  });
  assert(rc.on && rc.n > 0, 'room correction applied');
  assert(rc.boost <= rc.limit + 0.1, `correction cascade boost ${rc.boost.toFixed(2)} dB exceeds ${rc.limit} dB`);
  // Measurements persist across reload.
  await wait(400);
  await page.reload();
  await page.waitForFunction(() => window.__audiospace);
  await page.goto(`${base}#/studio/measure`);
  await page.waitForSelector('.meas-item', { timeout: 15000 });
  assert((await page.locator('.meas-item').count()) >= 3, 'measurements persisted');
  await evalApp(() => window.__audiospace.store.patch('roomCorrection', { enabled: false }));
});

await step('bass optimizer: two subs for the sofa, applied to the room', async () => {
  await page.goto(`${base}#/studio/bass`);
  await page.click('.segmented button:has-text("2")');
  await page.click('button:has-text("Optimise")');
  await page.waitForSelector('.alt-item', { timeout: 60000 });
  const txt = await page.textContent('.mini-stats');
  assert(/→/.test(txt), 'before → after stats shown');
  const before = await evalApp(() => window.__audiospace.store.state.subs.length);
  await page.click('button:has-text("Apply to room")');
  await wait(200);
  const subs = await evalApp(() => window.__audiospace.store.state.subs.filter((s) => !s.muted));
  assert(subs.length === 2 && before >= 1, `subs after apply: ${subs.length}`);
  assert(subs.every((s) => Number.isFinite(s.x) && Number.isFinite(s.z) && s.delayMs >= 0), 'valid sub settings');
});

await step('scenes and a complete ABX blind test restore the original system', async () => {
  await page.goto(`${base}#/studio/compare`);
  await page.click('button:has-text("Add example scenes")');
  await page.waitForSelector('.scene-item');
  assert((await page.locator('.scene-item').count()) === 3, 'three example scenes');
  const original = await evalApp(() => JSON.stringify([window.__audiospace.store.state.speakers, window.__audiospace.store.state.room.preset, window.__audiospace.store.state.receiver.masterDb]));
  const ids = await evalApp(() => window.__audiospace.store.state.scenes.map((s) => s.id));
  await page.selectOption('select[aria-label="Scene A"]', ids[0]);
  await page.selectOption('select[aria-label="Scene B"]', ids[1]);
  await page.click('.segmented button:has-text("10")');
  await page.click('button:has-text("Start blind test")');
  await page.waitForSelector('.abx-btn');
  const aRoom = await evalApp(() => window.__audiospace.store.state.room.preset);
  assert(aRoom === 'bedroom', `A is active (${aRoom})`);
  await page.click('.abx-btn:has-text("B")');
  assert((await evalApp(() => window.__audiospace.store.state.room.preset)) === 'studio', 'B switches the room');
  const trim = await evalApp(() => window.__audiospace.store.state.engine.trimDb);
  assert(trim <= 0, 'level matching never boosts');
  for (let i = 0; i < 10; i++) {
    await page.click('.abx-btn:has-text("X")');
    await page.keyboard.press(i % 2 ? '1' : '2');
    await wait(30);
  }
  await page.waitForSelector('.abx-score');
  const score = await page.textContent('.abx-score');
  assert(/\d+ \/ 10/.test(score), `score ${score}`);
  const restored = await evalApp(() => JSON.stringify([window.__audiospace.store.state.speakers, window.__audiospace.store.state.room.preset, window.__audiospace.store.state.receiver.masterDb]));
  assert(restored === original, 'original system restored after the test');
  assert((await evalApp(() => window.__audiospace.store.state.engine.trimDb)) === 0, 'trim reset');
  // Save the current system as a scene and load it back.
  await page.click('button:has-text("Save current")');
  await page.fill('.modal input', 'E2E scene');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.scene-item:has-text("E2E scene")');
  await wait(100);
  assert((await page.locator('.modal-backdrop').count()) === 0, 'Enter in a prompt must not reopen it');
});

await step('no clicks or pops while every control is changed during playback', async () => {
  const res = await page.evaluate(async () => {
    const app = window.__audiospace;
    await app.audio.unlock();
    app.player.pause();
    const ctx = app.ctx;
    const store = app.store;
    const { LiveRecorder } = await import('/src/audio/bake.js');
    const { decodeWav } = await import('/src/audio/wav.js');
    const { roomFromPreset } = await import('/src/acoustics/room.js');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(2, sr, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < sr; i++) d[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(app.engine.input);
    src.start();
    store.set('player.volume', 0.8);
    store.set('engine.simulation', true);
    await sleep(1200);
    const rec = new LiveRecorder(app.engine);
    await rec.start();
    await sleep(300);
    for (let k = 0; k <= 30; k++) {
      const g = store.state.eq.graphic.gains.slice();
      g[17] = Math.round(12 * Math.sin((k / 30) * 2 * Math.PI) * 10) / 10;
      store.set('eq.graphic.gains', g);
      await sleep(20);
    }
    for (const t of ['highshelf', 'lowshelf', 'peaking']) {
      store.set('eq.parametric.bands', store.state.eq.parametric.bands.map((x, i) => (i === 2 ? { ...x, type: t, gain: 6 } : x)));
      await sleep(120);
    }
    for (const sl of [12, 48, 24]) {
      store.set('crossover.slope', sl);
      await sleep(150);
    }
    for (const db of [-30, -12]) {
      store.set('receiver.masterDb', db);
      await sleep(100);
    }
    for (let i = 0; i < 4; i++) {
      store.set('engine.simulation', i % 2 === 1);
      await sleep(150);
    }
    store.set('engine.simulation', true);
    const sp0 = store.state.speakers.map((x) => ({ ...x }));
    for (let k = 0; k < 15; k++) {
      store.set('speakers', sp0.map((x, i) => (i === 0 ? { ...x, x: x.x + k * 0.03 } : x)));
      await sleep(25);
    }
    const room0 = store.state.room;
    store.set('room', { ...room0, ...roomFromPreset('living') });
    await sleep(900);
    store.set('room', room0);
    await sleep(900);
    const blob = await rec.stop();
    src.stop();
    src.disconnect();
    const x = decodeWav(await blob.arrayBuffer()).channels[0];
    const win = Math.round(0.005 * sr);
    const vals = [];
    for (let s = 2; s + win < x.length; s += win) {
      let m = 0;
      for (let i = s; i < s + win; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
      vals.push([s / sr, m]);
    }
    const med = vals.map((v) => v[1]).sort((a, b) => a - b)[vals.length >> 1];
    // A click: one 5 ms window above 12× the steady-tone baseline, or two
    // consecutive windows above 8× (real pops measured 12–80× and ring on).
    const r = vals.map((v) => v[1] / med);
    const spikes = [];
    for (let i = 0; i < r.length; i++) if (r[i] > 12 || (r[i] > 8 && (r[i - 1] > 8 || r[i + 1] > 8))) spikes.push([+vals[i][0].toFixed(3), +r[i].toFixed(1)]);
    return { seconds: x.length / sr, spikes };
  });
  assert(res.seconds > 4, `recorded ${res.seconds}s`);
  assert(res.spikes.length === 0, `clicks detected at ${JSON.stringify(res.spikes.slice(0, 8))}`);
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
  for (const v of ['home', 'songs', 'albums', 'artists', 'genres', 'liked', 'playlists', 'now-playing', 'search?q=tone', 'studio/room', 'studio/hardware', 'studio/hardware/svs-pb-1000-pro', 'studio/receiver', 'studio/crossover', 'studio/eq', 'studio/analyzers', 'studio/measure', 'studio/bass', 'studio/compare', 'studio/bake', 'settings']) {
    await page.goto(`${base}#/${v}`);
    await wait(250);
  }
  const album = await evalApp(() => [...window.__audiospace.library.albums.keys()][0]);
  await page.goto(`${base}#/album/${encodeURIComponent(album)}`);
  await wait(250);
  assert(!(await page.locator('.tl-head:has-text("null")').count()), 'no literal null in headers');
});

await step('phone layout: panel starts closed and "More" reaches every studio tool', async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  try {
    await p.goto(`${base}#/home`);
    await p.waitForFunction(() => window.__audiospace);
    const closed = await p.evaluate(() => document.querySelector('.app').classList.contains('panel-closed'));
    assert(closed, 'side panel must not cover the page on phones');
    const more = p.locator('.sidebar .nav-item.mobile-only');
    await more.scrollIntoViewIfNeeded();
    await more.tap();
    await p.waitForSelector('.menu');
    assert((await p.locator('.menu-item').count()) >= 10, 'More menu lists the tools');
    await p.tap('.menu-item:has-text("Measurements")');
    await p.waitForSelector('h1:has-text("Measurements")');
    const overflow = await p.evaluate(() => document.querySelector('.view').scrollWidth - document.querySelector('.view').clientWidth);
    assert(overflow <= 1, `horizontal overflow ${overflow}px`);
  } finally {
    await phone.close();
  }
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
