// Right side panel: Up Next (drag-and-drop queue), Now Playing details and
// a live System monitor (SPL, amplifier power, clipping, thermal state).

import { h, icon, clear, append } from '../dom.js';
import { enc } from '../router.js';
import { artEl, makeSortable } from '../components/lists.js';
import { segmented } from '../components/controls.js';
import { openMenu } from '../components/overlays.js';
import { formatTime, plural } from '../../util/format.js';
import { getHardware } from '../../hardware/index.js';
import { artistKeyOf } from '../../library/library.js';

export function createSidePanel(app) {
  let tab = 'queue';
  const body = h('div.panel-body');
  const tabs = segmented(
    [
      { value: 'queue', label: 'Up Next' },
      { value: 'now', label: 'Playing' },
      { value: 'system', label: 'System' },
    ],
    tab,
    (v) => {
      tab = v;
      render();
    },
    { label: 'Panel' },
  );
  const el = h('aside.panel', { 'aria-label': 'Side panel' }, h('div.panel-head', tabs, h('button.icon-btn.small', { 'aria-label': 'Close panel', onClick: () => app.store.set('ui.queueOpen', false) }, icon('close', 16))), body);

  let cleanup = null;
  const render = () => {
    if (cleanup) cleanup();
    cleanup = null;
    clear(body);
    if (tab === 'queue') cleanup = renderQueue(app, body);
    else if (tab === 'now') cleanup = renderNow(app, body);
    else cleanup = renderSystem(app, body);
  };
  app.queue.on('change', () => tab === 'queue' && render());
  app.player.on('track', () => (tab === 'queue' || tab === 'now') && render());
  app.library.on('likes', () => tab === 'now' && render());
  render();
  return { el, show: (t) => { tab = t; tabs.setValue(t); render(); } };
}

function queueItem(app, id, section, index, { current = false } = {}) {
  const t = app.library.get(id);
  if (!t) return null;
  const item = h(
    'div.q-item',
    { class: current ? 'current' : '', dataset: { index: String(index) } },
    current ? h('div.grip', { style: { cursor: 'default' } }, h('span.eq-bars', { class: app.player.playing ? '' : 'paused' }, h('i'), h('i'), h('i'))) : h('div.grip', { 'aria-label': 'Drag to reorder' }, icon('grip', 16)),
    artEl(app.art, t.artId, { seed: t.album }),
    h('div.q-text', h('div.q-title.ellipsis', t.title), h('div.q-sub.ellipsis', t.artist)),
    current ? null : h('button.icon-btn.small.q-remove', { 'aria-label': 'Remove from queue', onClick: (e) => { e.stopPropagation(); app.queue.remove(section, index); } }, icon('close', 14)),
  );
  if (!current) {
    item.addEventListener('dblclick', () => app.player.jumpTo(section, index));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: 'Play now', icon: 'play', onClick: () => app.player.jumpTo(section, index) },
        { label: 'Remove from queue', icon: 'close', onClick: () => app.queue.remove(section, index) },
        '-',
        { label: 'Add to playlist', icon: 'plus', submenu: app.playlistSubmenu([id]) },
      ]);
    });
  }
  return item;
}

function renderQueue(app, body) {
  const q = app.queue;
  const cur = app.player.track;
  if (cur) {
    body.appendChild(h('div.q-section', 'Now playing'));
    body.appendChild(queueItem(app, cur.id, 'current', 0, { current: true }));
  }
  const manualList = h('div.q-list', { dataset: { section: 'manual' } });
  q.manual.forEach((m, i) => {
    const it = queueItem(app, m.id, 'manual', i);
    if (it) manualList.appendChild(it);
  });
  const upcoming = q.upcoming();
  const LIMIT = 200;
  const ctxList = h('div.q-list', { dataset: { section: 'context' } });
  upcoming.slice(0, LIMIT).forEach((id, i) => {
    const it = queueItem(app, id, 'context', i);
    if (it) ctxList.appendChild(it);
  });
  body.appendChild(h('div.q-section', h('span', 'Next in queue'), q.manual.length || upcoming.length ? h('button.btn.small.ghost', { onClick: () => q.clearUpcoming() }, 'Clear') : null));
  if (!q.manual.length) manualList.appendChild(h('div.dim', { style: { padding: '4px 10px 8px', fontSize: '12.5px' } }, 'Right-click any song → “Add to queue”, or drag items here.'));
  body.appendChild(manualList);
  body.appendChild(h('div.q-section', h('span.ellipsis', `Next from: ${q.context?.name || 'your library'}`), h('span.dim', plural(upcoming.length, 'track'))));
  body.appendChild(ctxList);
  if (upcoming.length > LIMIT) body.appendChild(h('div.dim', { style: { padding: '8px 10px', fontSize: '12px' } }, `…and ${upcoming.length - LIMIT} more`));
  if (!cur && !upcoming.length && !q.manual.length) {
    body.appendChild(h('div.empty', h('div.empty-icon', icon('queue', 28)), h('h3', 'Your queue is empty'), h('p.dim', 'Play an album, playlist or song to fill it.')));
  }
  return makeSortable([manualList, ctxList], {
    scroller: body,
    onMove: (fs, fi, ts, ti) => q.transfer(fs, fi, ts, ti),
  });
}

function renderNow(app, body) {
  const t = app.player.track;
  if (!t) {
    body.appendChild(h('div.empty', h('div.empty-icon', icon('music', 28)), h('h3', 'Nothing playing'), h('p.dim', 'Pick something from your library.')));
    return null;
  }
  const liked = app.library.isLiked(t.id);
  append(body, [
    h('div.np-card',
      artEl(app.art, t.artId, { size: 'full', lazy: false, className: 'np-art', seed: t.album }),
      h('div.split', { style: { marginTop: '14px', alignItems: 'flex-start' } },
        h('div.grow',
          h('a.np-title', { href: `#/album/${enc(t._albumKey)}` }, t.title),
          h('a.np-artist', { href: `#/artist/${enc(artistKeyOf(t))}` }, t.artist),
        ),
        h('button.icon-btn', { class: liked ? 'liked' : '', 'aria-label': 'Like', onClick: () => app.toggleLike(t.id) }, icon(liked ? 'heart-fill' : 'heart', 20)),
      ),
    ),
    h('div.card', { style: { marginTop: '14px' } },
      h('div.card-title', h('h3', 'About this track')),
      h('div.info-grid.compact',
        [['Album', t.album], ['Year', t.year], ['Genre', t.genre], ['Format', [t.format?.toUpperCase(), t.codec, t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : null, t.bitsPerSample ? `${t.bitsPerSample}-bit` : null].filter(Boolean).join(' · ')], ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : null], ['Duration', formatTime(t.duration)], ['Plays', t.playCount || 0]]
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => [h('div.dim', k), h('div.ellipsis', String(v))]),
      ),
    ),
    t.lyrics ? h('div.card', { style: { marginTop: '14px' } }, h('div.card-title', h('h3', icon('lyrics', 16), 'Lyrics')), h('pre.lyrics-pre', t.lyrics)) : null,
    h('button.btn.ghost', { style: { marginTop: '14px', width: '100%' }, onClick: () => app.go('now-playing') }, icon('expand', 16), 'Full-screen Now Playing'),
  ]);

  return null;
}

function renderSystem(app, body) {
  const splVal = h('div.stat-value', '—');
  const splPk = h('div.dim.mono', { style: { fontSize: '11px' } }, 'peak —');
  const dspLed = h('span.led');
  const limLed = h('span.led');
  const limVal = h('span.mono.dim', '0.0 dB');
  const rows = h('div.stack.tight');
  const ir = h('div.dim', { style: { fontSize: '12px' } }, 'Reverb IR: computing…');
  body.append(
    h('div.card',
      h('div.split', h('div.stat.grow', splVal, h('div.stat-label', 'SPL at listener (Z)')), splPk),
      h('div.hr'),
      h('div.split', dspLed, h('span.grow', 'DSP overload (0 dBFS)'), h('span.dim', { style: { fontSize: '11px' } }, 'EQ headroom')),
      h('div.split', { style: { marginTop: '6px' } }, limLed, h('span.grow', 'Output protection limiter'), limVal),
    ),
    h('div.q-section', 'Amplifier channels'),
    rows,
    h('div.card', { style: { marginTop: '12px' } }, ir, h('a.btn.small.ghost', { href: '#/studio/receiver', style: { marginTop: '10px' } }, icon('receiver', 14), 'Open receiver')),
  );
  const build = () => {
    clear(rows);
    const plan = app.engine.plan;
    if (!plan) return {};
    const els = {};
    for (const s of plan.sources) {
      const hw = getHardware(s.hw.id) || s.hw;
      const watts = h('span.mono', '0 W');
      const bar = h('i');
      const clip = h('span.led', { 'data-tip': 'Amplifier clipping' });
      const drv = h('span.led', { 'data-tip': 'Driver over-excursion / distortion' });
      const temp = h('span.mono.dim', { style: { fontSize: '11px' } }, '');
      rows.appendChild(
        h('div.chan-row',
          h('div.split', h('span.badge', { class: s.kind === 'sub' ? 'teal' : 'accent' }, s.channel), h('span.ellipsis.grow', { style: { fontSize: '12.5px', fontWeight: 600 } }, hw.name), clip, drv),
          h('div.split', { style: { marginTop: '5px' } }, h('div.meter-bar.grow', bar), watts),
          h('div.split.dim', { style: { fontSize: '11px', marginTop: '3px' } }, h('span.grow', `${Math.round(s.ampWatts)} W ${s.kind === 'sub' || hw.active ? 'built-in amp' : 'receiver channel'}`), temp),
        ),
      );
      els[s.id] = { watts, bar, clip, drv, temp, max: s.ampWatts };
    }
    return els;
  };
  let els = build();
  const onMeters = (m) => {
    const playing = app.player.playing;
    splVal.textContent = playing && m.spl > 20 ? `${m.spl.toFixed(1)} dB` : '—';
    splPk.textContent = playing && m.splPeak > 20 ? `peak ${m.splPeak.toFixed(1)} dB` : 'peak —';
    const now = performance.now();
    dspLed.className = `led ${now - m.dspOverAt < 400 ? 'on red' : 'on green'}`;
    limLed.className = `led ${m.limiterDb < -0.5 ? 'on amber' : 'on green'}`;
    limVal.textContent = `${m.limiterDb.toFixed(1)} dB`;
    for (const [id, e] of Object.entries(els)) {
      const s = m.sources[id];
      if (!s) continue;
      e.watts.textContent = `${s.watts < 10 ? s.watts.toFixed(1) : Math.round(s.watts)} W`;
      e.bar.style.width = `${Math.min(100, (s.peakWatts / Math.max(1, e.max)) * 100)}%`;
      e.bar.style.setProperty('--full', `${e.bar.parentElement.clientWidth}px`);
      e.clip.className = `led ${now - s.clipAt < 300 ? 'on red' : ''}`;
      e.drv.className = `led ${now - s.stressAt < 300 ? 'on amber' : ''}`;
      e.temp.textContent = s.temp > 0.05 ? `coil ${Math.round(s.temp * 100)}%${s.thermalDb < -0.1 ? ` · ${s.thermalDb.toFixed(1)} dB comp.` : ''}` : '';
    }
  };
  const onIr = (info) => {
    if (!info) return;
    ir.textContent = `Reverb IR: ${info.length.toFixed(2)} s · ${info.erCount} early reflections · RT60(1k) ${info.rt60[4].toFixed(2)} s`;
  };
  onIr(app.engine.reverb.info);
  const offM = app.engine.on('meters', onMeters);
  const offI = app.engine.on('ir', onIr);
  const offS = app.store.subscribe(['speakers', 'subs', 'receiver'], () => setTimeout(() => (els = build()), 0));
  return () => {
    offM();
    offI();
    offS();
  };
}
