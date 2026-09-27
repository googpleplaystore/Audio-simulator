// Analyzers, Bake & Export, Settings and Now Playing views.

import { h, icon, clear, debounce } from '../dom.js';
import { enc } from '../router.js';
import { artEl } from '../components/lists.js';
import { toggle, segmented, sliderRow, select } from '../components/controls.js';
import { toast, confirmDialog } from '../components/overlays.js';
import { spectrumAnalyzer, spectrogram, vuMeters, vectorscope, loudnessMeter, bassMonitor } from '../../viz/analyzers.js';
import { bakeTrack, exportImpulseResponse } from '../../audio/bake.js';
import { migrateState } from '../../core/settings.js';
import { formatTime, formatBytes, plural } from '../../util/format.js';
import { downloadJson } from './hardware.js';
import { artistKeyOf } from '../../library/library.js';

// ------------------------------------------------------------------ analyzers
export function analyzersView(app, params, query, disposer) {
  const e = app.engine;
  const spec = spectrumAnalyzer(e, { mode: 'bars', showSource: true });
  const sg = spectrogram(e);
  const vu = vuMeters(e, { reference: app.store.get('viz.vuReference') ?? -18 });
  const vs = vectorscope(e);
  const lufs = loudnessMeter(e);
  const bass = bassMonitor(app);
  for (const v of [spec, sg, vu, vs, lufs, bass]) disposer.add(v.destroy);
  const hapt = app.store.get('haptics');
  const vibSupported = typeof navigator.vibrate === 'function';
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Analyzers'), h('div.muted', 'Everything measured at the listening position, after the full simulation — high refresh rate, zero latency.'))),
    h('div.viz-grid',
      h('div.card.viz-wide', h('div.card-title', h('h3', icon('activity', 18), 'Spectrogram'), h('span.dim', { style: { fontSize: '12px' } }, 'log frequency · 8192-point FFT')), sg.el),
      h('div.card.viz-wide', h('div.card-title', h('h3', icon('spectrum', 18), 'Real-time analyzer'),
        h('div.split', segmented([{ value: 'bars', label: '⅓ octave' }, { value: 'curve', label: 'FFT' }], 'bars', (v) => spec.set({ mode: v })), toggle('Source overlay', true, (v) => spec.set({ showSource: v })))), spec.el),
      h('div.card', h('div.card-title', h('h3', 'VU meters'), select([{ value: -18, label: '0 VU = −18 dBFS' }, { value: -20, label: '0 VU = −20 dBFS' }, { value: -14, label: '0 VU = −14 dBFS' }], app.store.get('viz.vuReference') ?? -18, (v) => { app.store.set('viz.vuReference', Number(v)); vu.set({ reference: Number(v) }); })), vu.el),
      h('div.card', h('div.card-title', h('h3', 'Vectorscope & correlation')), vs.el),
      h('div.card', h('div.card-title', h('h3', 'Loudness (LUFS)')), lufs.el),
      h('div.card', h('div.card-title', h('h3', icon('vibrate', 18), 'Bass haptics')),
        bass.el,
        h('div.stack', { style: { marginTop: '10px' } },
          toggle(vibSupported ? 'Vibrate this device on bass hits' : 'Vibrate (not supported on this device)', hapt.enabled, (v) => app.store.set('haptics.enabled', v)),
          toggle('Gamepad rumble (connected controllers)', hapt.gamepad, (v) => app.store.set('haptics.gamepad', v)),
          sliderRow('Intensity', { min: 0.2, max: 2, step: 0.05, value: hapt.intensity, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => app.store.set('haptics.intensity', v) }),
          sliderRow('Sensitivity', { min: 0, max: 1, step: 0.05, value: 1 - hapt.threshold, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => app.store.set('haptics.threshold', 1 - v) }),
        ),
      ),
    ),
  );
  return { el, title: 'Analyzers' };
}

// ------------------------------------------------------------------ bake
const bakes = []; // session history {name, url, size, at}

export function bakeView(app, params, query, disposer) {
  const lib = app.library;
  let trackId = query.track || app.player.track?.id || lib.list[0]?.id || null;
  const opts = { sampleRate: 48000, bitDepth: 24, range: 'full', start: 0, length: 30, normalize: false, output: app.store.get('engine.output') };
  const trackBox = h('div');
  const renderTrack = () => {
    clear(trackBox);
    const t = lib.get(trackId);
    if (!t) {
      trackBox.appendChild(h('p.dim', 'No track selected.'));
      return;
    }
    trackBox.appendChild(h('div.mini-track', artEl(app.art, t.artId, { seed: t.album }), h('div.grow.ellipsis', h('div', { style: { fontWeight: 700 } }, t.title), h('div.dim', `${t.artist} · ${formatTime(t.duration)}`))));
  };
  const finder = h('input.input', { placeholder: 'Search your library to pick a track…', style: { width: '100%' } });
  const results = h('div.stack.tight');
  finder.addEventListener('keydown', (e) => e.stopPropagation());
  finder.addEventListener('input', debounce(() => {
    clear(results);
    for (const t of lib.search(finder.value, 6).tracks) {
      results.appendChild(h('button.mini-track', { onClick: () => { trackId = t.id; renderTrack(); clear(results); finder.value = ''; } }, artEl(app.art, t.artId, { seed: t.album }), h('div.grow.ellipsis', h('div.ellipsis', t.title), h('div.dim.ellipsis', t.artist))));
    }
  }, 120));
  renderTrack();
  const progress = h('i');
  const status = h('div.dim', 'Ready.');
  const history = h('div.stack.tight');
  const renderHistory = () => {
    clear(history);
    for (const b of bakes) history.appendChild(h('div.bake-item', icon('file', 18), h('div.grow.ellipsis', h('div.ellipsis', b.name), h('div.dim', `${formatBytes(b.size)} · ${b.info}`)), h('a.btn.small', { href: b.url, download: b.name }, icon('download', 14), 'Download')));
    if (!bakes.length) history.appendChild(h('p.dim', 'Baked files appear here for this session.'));
  };
  renderHistory();
  let running = null;
  const bakeBtn = h('button.btn.primary.large', icon('bake', 18), 'Bake to WAV');
  bakeBtn.addEventListener('click', async () => {
    const t = lib.get(trackId);
    if (!t || running) return;
    running = { cancelled: false };
    bakeBtn.disabled = true;
    try {
      const blob = await lib.getFile(t.id);
      const res = await bakeTrack({
        blob,
        state: app.store.state,
        sampleRate: opts.sampleRate,
        bitDepth: opts.bitDepth,
        start: opts.range === 'full' ? 0 : opts.start,
        duration: opts.range === 'full' ? null : opts.length,
        normalize: opts.normalize,
        output: opts.output,
        token: running,
        meta: { title: `${t.title} (AudioSpace bake)`, artist: t.artist, album: t.album },
        onProgress: (p, msg) => {
          progress.style.width = `${Math.round(p * 100)}%`;
          status.textContent = `${msg} ${Math.round(p * 100)}%`;
        },
      });
      const name = `${t.artist} - ${t.title} [AudioSpace ${app.store.state.room.preset}].wav`.replace(/[\\/:*?"<>|]/g, '_');
      const url = URL.createObjectURL(res.blob);
      bakes.unshift({ name, url, size: res.blob.size, info: `${opts.sampleRate / 1000} kHz · ${opts.bitDepth}-bit · ${res.truePeakDb.toFixed(1)} dBTP` });
      renderHistory();
      status.textContent = `Done — ${formatTime(res.duration)} rendered. Sample peak ${res.peakDb.toFixed(1)} dBFS, true peak ${res.truePeakDb.toFixed(1)} dBTP${res.truePeakDb > -0.5 ? ' (consider Normalize)' : ''}.`;
      const a = h('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Bake complete — download started', { type: 'success' });
    } catch (err) {
      status.textContent = `Failed: ${err.message || err}`;
      toast(`Bake failed: ${err.message || err}`, { type: 'error' });
    } finally {
      bakeBtn.disabled = false;
      running = null;
    }
  });
  const rangeBox = h('div.stack', { hidden: true },
    sliderRow('Start', { min: 0, max: 600, step: 1, value: 0, format: (v) => formatTime(v), onInput: (v) => (opts.start = v) }),
    sliderRow('Length', { min: 5, max: 300, step: 1, value: 30, format: (v) => formatTime(v), onInput: (v) => (opts.length = v) }),
  );
  const importProfile = () => {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      input.remove();
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const s = migrateState(data.state || data);
        app.store.replace(s);
        toast('DSP profile loaded', { type: 'success' });
      } catch (err) {
        toast(`Invalid profile: ${err.message}`, { type: 'error' });
      }
    });
    document.body.appendChild(input);
    input.click();
  };
  const el = h(
    'div.view-inner',
    h('div.page-head', h('div', h('h1', 'Bake & Export'), h('div.muted', 'Render any song through your complete virtual system — room, speakers, amps, crossover, EQ and reverb — into a WAV you can keep.'))),
    h('div.studio-grid',
      h('div.card',
        h('div.card-title', h('h3', icon('music', 18), 'Source track')),
        trackBox,
        h('div', { style: { marginTop: '10px' } }, finder, results),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('settings', 18), 'Render settings')),
        h('div.stack',
          h('div.field', h('label', 'Range'), segmented([{ value: 'full', label: 'Full track' }, { value: 'part', label: 'Excerpt' }], 'full', (v) => { opts.range = v; rangeBox.hidden = v === 'full'; })),
          rangeBox,
          h('div.field', h('label', 'Sample rate'), segmented([{ value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }, { value: 96000, label: '96 kHz' }], 48000, (v) => (opts.sampleRate = Number(v)))),
          h('div.field', h('label', 'Format'), segmented([{ value: 16, label: '16-bit (dithered)' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }], 24, (v) => (opts.bitDepth = Number(v)))),
          h('div.field', h('label', 'Render for'), segmented([{ value: 'headphones', label: 'Headphones (binaural)' }, { value: 'speakers', label: 'Speakers' }], opts.output, (v) => (opts.output = v))),
          toggle('Normalize true peak to −1 dBTP', false, (v) => (opts.normalize = v)),
        ),
      ),
      h('div.card.span-2',
        h('div.split', bakeBtn, h('div.grow', h('div.progress', progress), h('div', { style: { marginTop: '6px' } }, status))),
        h('div.hr'),
        h('h3', { style: { marginBottom: '8px' } }, 'Session exports'),
        history,
      ),
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('layers', 18), 'Profiles & data')),
        h('div.split.wrap',
          h('button.btn', { onClick: () => downloadJson({ app: 'AudioSpace', version: 1, exportedAt: new Date().toISOString(), state: app.store.state }, 'audiospace-profile.json') }, icon('save', 16), 'Export DSP profile'),
          h('button.btn', { onClick: importProfile }, icon('upload', 16), 'Import DSP profile'),
          h('button.btn', { onClick: () => { const b = exportImpulseResponse(app.store.state, 48000); const url = URL.createObjectURL(b); const a = h('a', { href: url, download: `audiospace-room-ir-${app.store.state.room.preset}.wav` }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 20000); } }, icon('download', 16), 'Export room impulse response (4-ch WAV)'),
        ),
        h('p.dim', { style: { fontSize: '12px', marginTop: '10px' } }, 'The impulse response is true-stereo (L→L, L→R, R→L, R→R), 32-bit float, with direct sound, image-source early reflections and the frequency-dependent diffuse tail — load it into any convolution reverb.'),
      ),
    ),
  );
  return { el, title: 'Bake & Export' };
}

// ------------------------------------------------------------------ settings
export function settingsView(app, params, query, disposer) {
  const store = app.store;
  const storageInfo = h('div.dim');
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => (storageInfo.textContent = `Browser storage used: ${formatBytes(e.usage || 0)} of ${formatBytes(e.quota || 0)} available.`));
  }
  const persistBtn = h('button.btn.small', { onClick: async () => {
    if (navigator.storage && navigator.storage.persist) {
      const ok = await navigator.storage.persist();
      toast(ok ? 'Storage will not be evicted automatically' : 'The browser declined persistent storage');
    }
  } }, 'Request persistent storage');
  const el = h(
    'div.view-inner',
    h('div.page-head', h('h1', 'Settings')),
    h('div.studio-grid',
      h('div.card',
        h('div.card-title', h('h3', icon('headphones', 18), 'Audio output')),
        h('div.stack',
          h('div.field', h('label', 'Listening on'), segmented([{ value: 'headphones', label: 'Headphones (HRTF binaural)' }, { value: 'speakers', label: 'Speakers (equal-power)' }], store.get('engine.output'), (v) => store.set('engine.output', v))),
          h('div.field', h('label', 'Processing quality'), segmented([{ value: 'high', label: 'High (4× oversampled)' }, { value: 'balanced', label: 'Balanced' }, { value: 'eco', label: 'Eco' }], store.get('engine.quality'), (v) => store.set('engine.quality', v))),
          toggle('Simulation enabled (B toggles A/B)', store.get('engine.simulation'), (v) => store.set('engine.simulation', v)),
          toggle('Level-match the bypass path for fair A/B', store.get('engine.levelMatch'), (v) => store.set('engine.levelMatch', v)),
          toggle('Output protection limiter (true-peak, 2.5 ms look-ahead)', store.get('engine.limiter') !== false, (v) => store.set('engine.limiter', v)),
          h('div.field', h('label', 'Limiter ceiling'), segmented([{ value: -0.1, label: '−0.1 dBTP' }, { value: -1, label: '−1 dBTP' }, { value: -2, label: '−2 dBTP' }, { value: -6, label: '−6 dBTP' }], store.get('engine.ceilingDb') ?? -1, (v) => store.set('engine.ceilingDb', Number(v)))),
          h('div.dim', `Audio context: ${app.ctx.sampleRate} Hz · base latency ${((app.ctx.baseLatency || 0) * 1000).toFixed(1)} ms · state ${app.ctx.state}`),
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('music', 18), 'Playback')),
        h('div.stack',
          sliderRow('Crossfade', { min: 0, max: 12, step: 0.5, value: store.get('player.crossfade') || 0, format: (v) => (v ? `${v.toFixed(1)} s` : 'Off'), onInput: (v) => store.set('player.crossfade', v) }),
          toggle('Gapless playback (pre-load next track)', store.get('player.gapless') !== false, (v) => store.set('player.gapless', v)),
          h('div.field', h('label', 'ReplayGain'), segmented([{ value: 'off', label: 'Off' }, { value: 'track', label: 'Track' }, { value: 'album', label: 'Album' }], store.get('player.replayGain'), (v) => store.set('player.replayGain', v))),
          sliderRow('ReplayGain preamp', { min: -6, max: 12, step: 0.5, value: store.get('player.replayGainPreampDb') || 0, reset: 0, format: (v) => `${v > 0 ? '+' : ''}${v} dB`, onInput: (v) => store.set('player.replayGainPreampDb', v) }),
          sliderRow('Playback speed', { min: 0.5, max: 2, step: 0.05, value: store.get('player.rate') || 1, reset: 1, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => app.player.setRate(v) }),
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('library', 18), 'Library')),
        h('div.stack',
          h('div', `${plural(app.library.size, 'track')} · ${plural(app.library.albums.size, 'album')} · ${plural(app.library.playlists.size, 'playlist')}`),
          storageInfo,
          h('div.split.wrap',
            h('button.btn.small', { onClick: () => app.importFolder() }, icon('folder-plus', 14), 'Import folder'),
            h('button.btn.small', { onClick: () => app.importFiles() }, icon('file', 14), 'Import files'),
            h('button.btn.small', { onClick: () => app.relinkFolder(), 'data-tip': 'Reconnect tracks imported without persistent folder access' }, icon('link', 14), 'Relink folder'),
            h('button.btn.small', { onClick: () => app.installDemo() }, icon('sparkle', 14), 'Add demo tracks'),
            persistBtn,
          ),
          h('button.btn.small.danger', { onClick: async () => { if (await confirmDialog('Clear library?', 'Removes all tracks, playlists, likes and cached artwork from AudioSpace. Files on disk are untouched.', { ok: 'Clear', danger: true })) { app.player.pause(); await app.library.clearAll(); toast('Library cleared'); } } }, icon('trash', 14), 'Clear library'),
        ),
      ),
      h('div.card',
        h('div.card-title', h('h3', icon('sliders', 18), 'Interface')),
        h('div.stack',
          toggle('Reduce motion', !!store.get('ui.reduceMotion'), (v) => store.set('ui.reduceMotion', v)),
          toggle('Show side panel', !!store.get('ui.queueOpen'), (v) => store.set('ui.queueOpen', v)),
          h('button.btn.small', { onClick: () => app.showShortcuts() }, icon('keyboard', 14), 'Keyboard shortcuts'),
          h('button.btn.small.danger', { onClick: async () => { if (await confirmDialog('Reset all settings?', 'Room, hardware, EQ and receiver settings return to defaults. Your library is kept.', { ok: 'Reset', danger: true })) { app.resetSettings(); toast('Settings reset'); } } }, 'Reset simulation settings'),
        ),
      ),
      h('div.card.span-2',
        h('div.card-title', h('h3', icon('info', 18), 'About AudioSpace')),
        h('p.muted', 'AudioSpace simulates a complete listening chain in your browser with the Web Audio API: 100 bookshelf speakers and 100 subwoofers modelled from their specifications, AV receiver gain staging with amplifier and driver non-linearities, Linkwitz–Riley bass management, 31-band and parametric EQ, a modal-sum low-frequency room model, image-source + statistical reverberation and HRTF spatialisation. Everything runs locally — your music never leaves your device.'),
      ),
    ),
  );
  return { el, title: 'Settings' };
}

// ------------------------------------------------------------------ now playing
export function nowPlayingView(app, params, query, disposer) {
  const wrap = h('div.np-view');
  const bg = h('div.np-bg');
  const content = h('div.np-content');
  const spec = spectrumAnalyzer(app.engine, { mode: 'curve', showSource: false, dbMin: -80, dbMax: -15 });
  disposer.add(spec.destroy);
  const render = () => {
    clear(content);
    const t = app.player.track;
    if (!t) {
      content.appendChild(h('div.empty', h('div.empty-icon', icon('music', 28)), h('h2', 'Nothing playing')));
      return;
    }
    const art = artEl(app.art, t.artId, { size: 'full', lazy: false, className: 'np-big-art', seed: t.album });
    if (t.artId) app.art.url(t.artId, 'full').then((u) => u && (bg.style.backgroundImage = `url("${u}")`));
    else bg.style.backgroundImage = '';
    content.append(
      art,
      h('div.np-info',
        h('div.hero-kind', app.queue.context?.name ? `Playing from ${app.queue.context.name}` : 'Now playing'),
        h('h1', t.title),
        h('div.np-artist', h('a', { href: `#/artist/${enc(artistKeyOf(t))}` }, t.artist), ' · ', h('a', { href: `#/album/${enc(t._albumKey)}` }, t.album)),
        h('div.np-viz', spec.el),
        t.lyrics ? h('pre.lyrics-pre.np-lyrics', t.lyrics) : null,
      ),
    );
  };
  render();
  disposer.add(app.player.on('track', render));
  wrap.append(bg, content);
  return { el: h('div.view-inner.flush', wrap), title: 'Now Playing' };
}
