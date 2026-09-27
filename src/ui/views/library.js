// Library views: home, songs, albums, artists, genres, liked, playlists, search.

import { h, icon, clear, debounce, viewDebounce } from '../dom.js';
import { enc } from '../router.js';
import { artEl } from '../components/lists.js';
import { trackTable } from '../components/trackTable.js';
import { segmented } from '../components/controls.js';
import { openMenu, confirmDialog, promptDialog, modal, toast } from '../components/overlays.js';
import { formatLongDuration, plural, formatTime } from '../../util/format.js';
import { getHardware } from '../../hardware/index.js';
import { ROOM_PRESETS, rt60Mid, volume } from '../../acoustics/room.js';
import { artistKeyOf, keyOf } from '../../library/library.js';
import { Importer } from '../../library/importer.js';

// ------------------------------------------------------------------ helpers

function playButton(onClick, big = true, label = 'Play') {
  return h('button.play-btn', { class: big ? 'big' : '', 'aria-label': label, onClick: (e) => { e.stopPropagation(); e.preventDefault(); onClick(); } }, icon('play', big ? 24 : 18));
}

export function hero(app, { kind, title, subtitle, meta, artId, round = false, gradient = null, seed = '', fallback = 'music' }) {
  const bg = h('div.hero-bg');
  const el = h(
    'section.hero',
    bg,
    h('div.hero-inner',
      artEl(app.art, artId, { size: 'full', lazy: false, className: round ? 'hero-art round' : 'hero-art', seed: seed || title, fallback }),
      h('div.hero-text', h('div.hero-kind', kind), h('h1.hero-title', title), subtitle ? h('div.hero-sub', subtitle) : null, meta ? h('div.hero-meta', meta) : null),
    ),
  );
  if (gradient) bg.style.background = gradient;
  else if (artId) {
    app.art.color(artId).then((c) => {
      if (c) bg.style.background = `linear-gradient(180deg, ${c} 0%, ${c}88 45%, transparent 100%)`;
    });
  }
  return el;
}

function actionBar(...children) {
  return h('div.action-bar', ...children);
}

export function albumTile(app, al) {
  const tile = h(
    'a.tile',
    { href: `#/album/${enc(al.key)}`, 'aria-label': `${al.name} by ${al.artist}` },
    artEl(app.art, al.artId, { seed: al.name, fallback: 'album' }),
    h('div.tile-title.ellipsis', al.name),
    h('div.tile-sub.ellipsis', `${al.year ? `${al.year} · ` : ''}${al.artist}`),
    h('div.tile-play', playButton(() => app.playTracks(app.library.albumTracks(al.key), 0, { type: 'album', id: al.key, name: al.name }), false, `Play ${al.name}`)),
  );
  tile.addEventListener('contextmenu', (e) => app.trackMenu(e, app.library.albumTracks(al.key).map((t) => t.id), { context: { type: 'album', id: al.key, name: al.name } }));
  return tile;
}

function artistTile(app, ar) {
  return h(
    'a.tile.round',
    { href: `#/artist/${enc(ar.key)}` },
    artEl(app.art, ar.artId, { seed: ar.name, fallback: 'artist' }),
    h('div.tile-title.ellipsis', ar.name),
    h('div.tile-sub', 'Artist'),
    h('div.tile-play', playButton(() => app.playTracks(ar.trackIds, 0, { type: 'artist', id: ar.key, name: ar.name }), false, `Play ${ar.name}`)),
  );
}

function shelf(title, link, tiles) {
  if (!tiles.length) return null;
  return h('section.shelf', h('div.shelf-head', h('h2', title), link ? h('a', { href: link }, 'Show all') : null), h('div.shelf-row', tiles));
}

/** Render many tiles progressively to keep huge libraries snappy. */
function progressiveGrid(items, renderItem, batch = 120) {
  const grid = h('div.tile-grid');
  let n = 0;
  const sentinel = h('div', { style: { height: '1px' } });
  const more = () => {
    const end = Math.min(items.length, n + batch);
    for (; n < end; n++) grid.appendChild(renderItem(items[n]));
    if (n >= items.length) {
      io.disconnect();
      sentinel.remove();
    }
  };
  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '600px' });
  more();
  const wrap = h('div', grid, sentinel);
  if (n < items.length) requestAnimationFrame(() => io.observe(sentinel));
  wrap.destroy = () => io.disconnect();
  return wrap;
}

export function onboarding(app) {
  const canFs = Importer.supportsDirectoryPicker;
  return h(
    'div.onboard',
    h('div.onboard-glow'),
    h('div.onboard-inner',
      h('div.brand-mark.big', icon('logo', 34)),
      h('h1', 'Welcome to ', h('span.grad-text', 'AudioSpace')),
      h('p.lead', 'Your music, played through 100 simulated bookshelf speakers, 100 subwoofers, real amplifiers and a physically-modelled room — in your browser.'),
      h('div.split.wrap', { style: { justifyContent: 'center', marginTop: '22px' } },
        h('button.btn.primary.large', { onClick: () => app.importFolder() }, icon('folder-plus', 18), 'Import music folder'),
        h('button.btn.large', { onClick: () => app.importFiles() }, icon('file', 18), 'Choose files'),
        h('button.btn.large.ghost', { onClick: () => app.installDemo() }, icon('sparkle', 18), 'Add demo & test tracks'),
      ),
      h('p.dim', { style: { marginTop: '14px', fontSize: '12.5px' } }, canFs ? 'Your files never leave this device. Folder access is remembered between sessions.' : 'Your files never leave this device. Tip: Chrome/Edge remember folder access between sessions.', ' You can also drag & drop folders anywhere.'),
      h('div.feature-grid',
        feature('room', 'Interactive room', 'Drag speakers, subs and yourself around a room with real modal bass, corner loading and reverb.'),
        feature('speaker', '200 hardware models', 'Top-selling bookshelf speakers and subwoofers with modelled frequency response, power and voicing.'),
        feature('receiver', 'AV receiver & amps', 'Gain staging, amplifier clipping, driver excursion, voice-coil heating and protection.'),
        feature('eq', 'Crossover & EQ', 'Linkwitz–Riley crossovers, 31-band graphic + parametric EQ and automatic room correction.'),
        feature('spectrum', 'Pro analyzers', 'Spectrogram, RTA, analog VU, vectorscope, correlation and LUFS loudness.'),
        feature('bake', 'Bake to WAV', 'Render any song through your virtual system into a file you can keep.'),
      ),
    ),
  );
}

function feature(ic, title, text) {
  return h('div.feature', h('div.feature-icon', icon(ic, 20)), h('h3', title), h('p.dim', text));
}

function viewShell(...children) {
  return h('div.view-inner', ...children);
}

// ------------------------------------------------------------------ views

export function homeView(app, params, query, disposer) {
  const lib = app.library;
  if (!lib.size) {
    const el = h('div.view-inner.flush', onboarding(app));
    disposer.add(lib.on('change', () => app.router.current?.name === 'home' && app.router.go('home', { replace: true })));
    return { el, title: 'Welcome' };
  }
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const recentAlbums = lib.albumList('recent').slice(0, 12);
  const quick = [];
  quick.push({ label: 'Liked Songs', href: '#/liked', grad: 'linear-gradient(135deg,#5b3cff,#9ecbff)', icon: 'heart-fill', play: () => app.playTracks(lib.likedTracks(), 0, { type: 'liked', name: 'Liked Songs' }) });
  for (const p of lib.playlistList().slice(0, 3)) quick.push({ label: p.name, href: `#/playlist/${enc(p.id)}`, artId: lib.get(p.trackIds[0])?.artId, play: () => app.playTracks(lib.playlistTracks(p.id), 0, { type: 'playlist', id: p.id, name: p.name }) });
  for (const al of recentAlbums.slice(0, 8 - quick.length)) quick.push({ label: al.name, href: `#/album/${enc(al.key)}`, artId: al.artId, play: () => app.playTracks(lib.albumTracks(al.key), 0, { type: 'album', id: al.key, name: al.name }) });
  const quickGrid = h('div.quick-grid', quick.map((q) => h('a.quick', { href: q.href },
    q.artId !== undefined ? artEl(app.art, q.artId, { seed: q.label }) : h('div.art', { style: { background: q.grad } }, icon(q.icon, 22)),
    h('span.ellipsis', q.label),
    h('div.quick-play', playButton(q.play, false, `Play ${q.label}`)),
  )));
  const played = lib.recentlyPlayed(12);
  const top = lib.mostPlayed(10);
  const genres = lib.genreList().slice(0, 12);
  const sys = systemCard(app);
  const el = viewShell(
    h('div.home-top', h('h1.greeting', greet)),
    quickGrid,
    sys,
    played.length ? shelf('Recently played', null, dedupeAlbums(app, played).map((al) => albumTile(app, al))) : null,
    shelf('Recently added', '#/albums', recentAlbums.map((al) => albumTile(app, al))),
    top.length ? h('section.shelf', h('div.shelf-head', h('h2', 'Your top tracks')), trackMini(app, top)) : null,
    shelf('Artists', '#/artists', lib.artistList().slice(0, 12).map((ar) => artistTile(app, ar))),
    genres.length ? h('section.shelf', h('div.shelf-head', h('h2', 'Genres'), h('a', { href: '#/genres' }, 'Show all')), h('div.genre-chips', genres.map((g) => h('a.chip', { href: `#/genre/${enc(g.key)}` }, g.name, h('span.dim', String(g.trackIds.length)))))) : null,
  );
  disposer.add(lib.on('change', viewDebounce(disposer, () => app.router.current?.name === 'home' && app.router.go('home', { replace: true }), 300)));
  return { el, title: 'Home' };
}

function dedupeAlbums(app, tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    if (seen.has(t._albumKey)) continue;
    seen.add(t._albumKey);
    const al = app.library.albums.get(t._albumKey);
    if (al) out.push(al);
  }
  return out;
}

function trackMini(app, tracks) {
  return h('div.mini-tracks', tracks.map((t, i) => {
    const row = h('div.mini-track', artEl(app.art, t.artId, { seed: t.album }), h('div.ellipsis.grow', h('div.ellipsis', { style: { fontWeight: 600 } }, t.title), h('div.dim.ellipsis', { style: { fontSize: '12.5px' } }, t.artist)), h('span.dim.mono', { style: { fontSize: '12px' } }, `${t.playCount} plays`));
    row.addEventListener('dblclick', () => app.playTracks(tracks, i, { type: 'top', name: 'Your top tracks' }));
    row.addEventListener('click', () => app.playTracks(tracks, i, { type: 'top', name: 'Your top tracks' }));
    row.addEventListener('contextmenu', (e) => app.trackMenu(e, [t.id]));
    return row;
  }));
}

function systemCard(app) {
  const s = app.store.state;
  const spk = s.speakers.map((x) => getHardware(x.modelId)?.name).filter(Boolean);
  const subs = s.subs.map((x) => getHardware(x.modelId)?.name).filter(Boolean);
  const preset = ROOM_PRESETS[s.room.preset];
  const uniq = [...new Set(spk)];
  return h(
    'a.system-card',
    { href: '#/studio/room' },
    h('div.system-glow'),
    h('div.grow',
      h('div.hero-kind', 'Your virtual system'),
      h('h2', uniq.join(' + ') || 'No speakers placed'),
      h('div.muted', `${subs.length ? `${subs.join(', ')} · ` : ''}${preset ? preset.name : 'Custom room'} (${s.room.width}×${s.room.depth}×${s.room.height} m)`),
      h('div.split.wrap', { style: { marginTop: '10px' } },
        h('span.badge.accent', `RT60 ${rt60Mid(s.room).toFixed(2)} s`),
        h('span.badge.teal', `${Math.round(volume(s.room))} m³`),
        h('span.badge', `Crossover ${s.crossover.enabled ? `${s.crossover.frequency} Hz LR${s.crossover.slope / 6}` : 'off'}`),
        h('span.badge', `${s.receiver.wattsPerChannel} W/ch`),
      ),
    ),
    h('div.system-cta', icon('room', 28), h('span', 'Open room')),
  );
}

export function songsView(app, params, query, disposer) {
  const lib = app.library;
  if (!lib.size) return { el: h('div.view-inner.flush', onboarding(app)), title: 'Songs' };
  const table = trackTable(app, { getTracks: () => lib.list, scroller: app.viewScroller, context: { type: 'songs', name: 'All songs' } });
  disposer.add(() => table.destroy());
  const count = h('span');
  const upd = () => (count.textContent = `${plural(lib.size, 'song')} · ${formatLongDuration(lib.totalDuration())}`);
  upd();
  disposer.add(lib.on('change', upd));
  const el = viewShell(
    h('div.page-head', h('div', h('h1', 'Songs'), h('div.muted', count))),
    actionBar(playButton(() => app.playTracks(lib.list, 0, { type: 'songs', name: 'All songs' })), h('button.icon-btn', { 'data-tip': 'Shuffle play', 'aria-label': 'Shuffle play', onClick: () => shufflePlay(app, lib.list, { type: 'songs', name: 'All songs' }) }, icon('shuffle', 22))),
    table.el,
  );
  return { el, title: 'Songs' };
}

function shufflePlay(app, tracks, context) {
  if (!tracks.length) return;
  app.queue.shuffle = true;
  app.playTracks(tracks, Math.floor(Math.random() * tracks.length), context);
}

export function albumsView(app, params, query, disposer) {
  const lib = app.library;
  let sort = 'name';
  const holder = h('div');
  const render = () => {
    holder.innerHTML = '';
    const g = progressiveGrid(lib.albumList(sort), (al) => albumTile(app, al));
    disposer.add(() => g.destroy());
    holder.appendChild(g);
  };
  render();
  disposer.add(lib.on('change', viewDebounce(disposer, render, 200)));
  const el = viewShell(
    h('div.page-head', h('div', h('h1', 'Albums'), h('div.muted', plural(lib.albums.size, 'album'))),
      segmented([{ value: 'name', label: 'A–Z' }, { value: 'artist', label: 'Artist' }, { value: 'year', label: 'Year' }, { value: 'recent', label: 'Recent' }], sort, (v) => { sort = v; render(); }, { label: 'Sort albums' })),
    lib.albums.size ? holder : h('div.empty', h('div.empty-icon', icon('album', 28)), h('h3', 'No albums yet'), h('button.btn.primary', { onClick: () => app.importFolder() }, 'Import music')),
  );
  return { el, title: 'Albums' };
}

export function albumView(app, params, query, disposer) {
  const lib = app.library;
  const al = lib.albums.get(params.key);
  if (!al) return notFound('Album not found');
  const tracks = () => lib.albumTracks(al.key);
  const ctx = { type: 'album', id: al.key, name: al.name };
  const table = trackTable(app, { getTracks: tracks, scroller: app.viewScroller, context: ctx, showAlbum: false, showArt: false, numbering: 'track', sortable: false });
  disposer.add(() => table.destroy());
  const artistKey = keyOf(al.artist);
  const more = [...(lib.artists.get(artistKey)?.albumKeys || [])].filter((k) => k !== al.key).map((k) => lib.albums.get(k)).filter(Boolean);
  const list = tracks();
  const el = h('div.view-inner.flush',
    hero(app, { kind: 'Album', title: al.name, artId: al.artId, subtitle: h('span', h('a', { href: `#/artist/${enc(artistKey)}` }, al.artist)), meta: `${al.year ? `${al.year} · ` : ''}${plural(list.length, 'song')}, ${formatLongDuration(lib.totalDuration(list))}`, fallback: 'album' }),
    h('div.view-pad',
      actionBar(
        playButton(() => app.playTracks(tracks(), 0, ctx)),
        h('button.icon-btn', { 'aria-label': 'Shuffle', 'data-tip': 'Shuffle play', onClick: () => shufflePlay(app, tracks(), ctx) }, icon('shuffle', 22)),
        h('button.icon-btn', { 'aria-label': 'More', onClick: (e) => app.trackMenu(e, tracks().map((t) => t.id), { context: ctx }) }, icon('more', 22)),
      ),
      table.el,
      more.length ? shelf(`More by ${al.artist}`, `#/artist/${enc(artistKey)}`, more.map((a) => albumTile(app, a))) : null,
    ),
  );
  return { el, title: al.name };
}

export function artistsView(app, params, query, disposer) {
  const lib = app.library;
  const g = progressiveGrid(lib.artistList(), (ar) => artistTile(app, ar));
  disposer.add(() => g.destroy());
  return { el: viewShell(h('div.page-head', h('div', h('h1', 'Artists'), h('div.muted', plural(lib.artists.size, 'artist')))), lib.artists.size ? g : h('div.empty', h('div.empty-icon', icon('artist', 28)), h('h3', 'No artists yet'))), title: 'Artists' };
}

export function artistView(app, params, query, disposer) {
  const lib = app.library;
  const ar = lib.artists.get(params.key);
  if (!ar) return notFound('Artist not found');
  const tracks = () => ar.trackIds.map((id) => lib.get(id)).filter(Boolean);
  const ctx = { type: 'artist', id: ar.key, name: ar.name };
  const popular = [...tracks()].sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 5);
  const albums = [...ar.albumKeys].map((k) => lib.albums.get(k)).filter(Boolean).sort((a, b) => (b.year || 0) - (a.year || 0));
  const table = trackTable(app, { getTracks: tracks, scroller: app.viewScroller, context: ctx });
  disposer.add(() => table.destroy());
  const el = h('div.view-inner.flush',
    hero(app, { kind: 'Artist', title: ar.name, artId: ar.artId, round: true, meta: `${plural(ar.trackIds.length, 'song')} · ${plural(albums.length, 'album')}`, fallback: 'artist' }),
    h('div.view-pad',
      actionBar(playButton(() => app.playTracks(tracks(), 0, ctx)), h('button.icon-btn', { 'aria-label': 'Shuffle', onClick: () => shufflePlay(app, tracks(), ctx) }, icon('shuffle', 22))),
      h('section.shelf', h('div.shelf-head', h('h2', 'Popular')), trackMini(app, popular.map((t) => ({ ...t, playCount: t.playCount || 0 })))),
      shelf('Discography', null, albums.map((a) => albumTile(app, a))),
      h('h2', { style: { margin: '10px 0 8px' } }, 'All songs'),
      table.el,
    ),
  );
  return { el, title: ar.name };
}

export function genresView(app) {
  const lib = app.library;
  const colors = ['#e13300', '#1e3264', '#8400e7', '#e8115b', '#148a08', '#bc5900', '#509bf5', '#dc148c', '#477d95', '#8d67ab', '#e91429', '#27856a', '#503750', '#af2896', '#ba5d07', '#0d73ec'];
  const tiles = lib.genreList().map((g, i) =>
    h('a.genre-tile', { href: `#/genre/${enc(g.key)}`, style: { background: colors[i % colors.length] } }, h('span', g.name), h('span.dim-white', plural(g.trackIds.length, 'song'))),
  );
  return { el: viewShell(h('div.page-head', h('h1', 'Genres')), tiles.length ? h('div.genre-grid', tiles) : h('div.empty', h('h3', 'No genres yet'))), title: 'Genres' };
}

export function genreView(app, params, query, disposer) {
  const g = app.library.genres.get(params.key);
  if (!g) return notFound('Genre not found');
  const tracks = () => g.trackIds.map((id) => app.library.get(id)).filter(Boolean);
  const ctx = { type: 'genre', id: g.key, name: g.name };
  const table = trackTable(app, { getTracks: tracks, scroller: app.viewScroller, context: ctx });
  disposer.add(() => table.destroy());
  const el = h('div.view-inner.flush',
    hero(app, { kind: 'Genre', title: g.name, gradient: 'linear-gradient(180deg, #2c5364 0%, #203a4388 50%, transparent)', meta: plural(g.trackIds.length, 'song'), fallback: 'genre', artId: null }),
    h('div.view-pad', actionBar(playButton(() => app.playTracks(tracks(), 0, ctx)), h('button.icon-btn', { 'aria-label': 'Shuffle', onClick: () => shufflePlay(app, tracks(), ctx) }, icon('shuffle', 22))), table.el),
  );
  return { el, title: g.name };
}

export function likedView(app, params, query, disposer) {
  const lib = app.library;
  const ctx = { type: 'liked', name: 'Liked Songs' };
  const table = trackTable(app, { getTracks: () => lib.likedTracks(), scroller: app.viewScroller, context: ctx });
  disposer.add(() => table.destroy());
  const meta = h('span');
  const upd = () => {
    meta.textContent = plural(lib.likes.size, 'song');
    table.refresh();
  };
  disposer.add(lib.on('likes', upd));
  upd();
  const el = h('div.view-inner.flush',
    hero(app, { kind: 'Playlist', title: 'Liked Songs', gradient: 'linear-gradient(180deg, #4d2fd6 0%, #4d2fd688 50%, transparent)', meta, fallback: 'heart-fill', seed: 'liked' }),
    h('div.view-pad',
      actionBar(playButton(() => app.playTracks(lib.likedTracks(), 0, ctx)), h('button.icon-btn', { 'aria-label': 'Shuffle', onClick: () => shufflePlay(app, lib.likedTracks(), ctx) }, icon('shuffle', 22))),
      lib.likes.size ? table.el : h('div.empty', h('div.empty-icon', icon('heart', 28)), h('h3', 'Songs you like will appear here'), h('p.dim', 'Save songs by tapping the heart icon.')),
    ),
  );
  return { el, title: 'Liked Songs' };
}

export function playlistsView(app, params, query, disposer) {
  const lib = app.library;
  const grid = h('div.tile-grid');
  const render = () => {
    clear(grid);
    grid.appendChild(h('button.tile.new-playlist', { onClick: () => app.newPlaylist() }, h('div.art', icon('plus', 40)), h('div.tile-title', 'Create playlist'), h('div.tile-sub', 'Build your own mix')));
    for (const p of lib.playlistList()) {
      grid.appendChild(
        h('a.tile', { href: `#/playlist/${enc(p.id)}` },
          artEl(app.art, lib.get(p.trackIds[0])?.artId, { seed: p.id, fallback: 'playlist' }),
          h('div.tile-title.ellipsis', p.name),
          h('div.tile-sub', plural(p.trackIds.length, 'song')),
          h('div.tile-play', playButton(() => app.playTracks(lib.playlistTracks(p.id), 0, { type: 'playlist', id: p.id, name: p.name }), false)),
        ),
      );
    }
  };
  render();
  disposer.add(lib.on('playlists', render));
  return { el: viewShell(h('div.page-head', h('h1', 'Playlists')), grid), title: 'Playlists' };
}

export function playlistView(app, params, query, disposer) {
  const lib = app.library;
  const p = lib.playlists.get(params.id);
  if (!p) return notFound('Playlist not found');
  const ctx = { type: 'playlist', id: p.id, name: p.name };
  const tracks = () => lib.playlistTracks(p.id);
  const table = trackTable(app, { getTracks: tracks, scroller: app.viewScroller, context: ctx, playlistId: p.id });
  disposer.add(() => table.destroy());
  const titleEl = h('span');
  const meta = h('span');
  const heroEl = hero(app, { kind: 'Playlist', title: '', artId: lib.get(p.trackIds[0])?.artId || null, meta, seed: p.id, fallback: 'playlist', gradient: lib.get(p.trackIds[0])?.artId ? null : 'linear-gradient(180deg,#3a3a5a,transparent)' });
  const titleH = heroEl.querySelector('.hero-title');
  titleH.appendChild(titleEl);
  const desc = h('div.hero-sub');
  titleH.after(desc);
  const upd = () => {
    const cur = lib.playlists.get(p.id);
    if (!cur) return;
    titleEl.textContent = cur.name;
    desc.textContent = cur.description || '';
    const list = tracks();
    meta.textContent = `${plural(list.length, 'song')}${list.length ? `, ${formatLongDuration(lib.totalDuration(list))}` : ''}`;
  };
  upd();
  disposer.add(lib.on('playlists', (id) => {
    if (!lib.playlists.has(p.id)) app.router.go('playlists', { replace: true });
    else if (!id || id === p.id) upd();
  }));
  const edit = async () => {
    const res = await modal((close) => {
      const name = h('input.input', { value: p.name, style: { width: '100%' } });
      const d = h('textarea.input', { style: { width: '100%', height: '80px', padding: '8px 12px', resize: 'vertical' }, placeholder: 'Add an optional description' }, p.description || '');
      return h('div', h('h2', 'Edit details'), h('div.stack', h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'Description'), d)), h('div.modal-actions', h('button.btn.ghost', { onClick: () => close(null) }, 'Cancel'), h('button.btn.primary', { onClick: () => close({ name: name.value.trim(), description: d.value.trim() }) }, 'Save')));
    });
    if (res && res.name) await lib.renamePlaylist(p.id, res.name, res.description);
  };
  const del = async () => {
    if (await confirmDialog('Delete playlist?', `“${p.name}” will be deleted. Songs stay in your library.`, { ok: 'Delete', danger: true })) {
      await lib.deletePlaylist(p.id);
      toast('Playlist deleted');
      app.go('playlists');
    }
  };
  const finder = songFinder(app, (id) => lib.addToPlaylist(p.id, [id]));
  const el = h('div.view-inner.flush', heroEl,
    h('div.view-pad',
      actionBar(
        playButton(() => app.playTracks(tracks(), 0, ctx)),
        h('button.icon-btn', { 'aria-label': 'Shuffle', onClick: () => shufflePlay(app, tracks(), ctx) }, icon('shuffle', 22)),
        h('button.icon-btn', { 'aria-label': 'More', onClick: (e) => openMenu(e.clientX, e.clientY, [
          { label: 'Edit details', icon: 'edit', onClick: edit },
          { label: 'Add to queue', icon: 'queue', onClick: () => app.addToQueue(p.trackIds) },
          { label: 'Duplicate', icon: 'layers', onClick: async () => { const n = await promptDialog('Duplicate playlist', { value: `${p.name} (copy)` }); if (n) { await lib.createPlaylist(n, p.trackIds); toast('Playlist duplicated'); } } },
          '-',
          { label: 'Delete playlist', icon: 'trash', danger: true, onClick: del },
        ]) }, icon('more', 22)),
      ),
      table.el,
      h('div.card', { style: { marginTop: '24px' } }, h('div.card-title', h('h3', 'Let’s find something for your playlist')), finder),
    ),
  );
  return { el, title: p.name };
}

function songFinder(app, onAdd) {
  const input = h('input.input', { placeholder: 'Search for songs', style: { width: '100%', maxWidth: '420px' } });
  const results = h('div.stack.tight', { style: { marginTop: '10px' } });
  const run = debounce(() => {
    clear(results);
    const q = input.value.trim();
    if (!q) return;
    for (const t of app.library.search(q, 8).tracks) {
      results.appendChild(h('div.mini-track', artEl(app.art, t.artId, { seed: t.album }), h('div.grow.ellipsis', h('div.ellipsis', { style: { fontWeight: 600 } }, t.title), h('div.dim.ellipsis', { style: { fontSize: '12.5px' } }, `${t.artist} · ${t.album}`)), h('button.btn.small', { onClick: () => onAdd(t.id) }, 'Add')));
    }
  }, 120);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div', input, results);
}

export function searchView(app, params, query, disposer) {
  const lib = app.library;
  const q = (query.q || '').trim();
  if (!q) {
    const colors = ['#e13300', '#1e3264', '#8400e7', '#e8115b', '#148a08', '#bc5900', '#509bf5', '#dc148c', '#477d95', '#8d67ab'];
    const browse = [
      { label: 'Room Simulator', href: '#/studio/room', ic: 'room' },
      { label: 'Hardware Catalog', href: '#/studio/hardware', ic: 'speaker' },
      { label: 'Equalizer', href: '#/studio/eq', ic: 'eq' },
      { label: 'Analyzers', href: '#/studio/analyzers', ic: 'spectrum' },
      ...lib.genreList().slice(0, 12).map((g) => ({ label: g.name, href: `#/genre/${enc(g.key)}`, ic: 'genre' })),
    ];
    return {
      el: viewShell(h('h2', { style: { marginBottom: '14px' } }, 'Browse all'), h('div.genre-grid', browse.map((b, i) => h('a.genre-tile', { href: b.href, style: { background: colors[i % colors.length] } }, h('span', b.label), h('div.genre-icon', icon(b.ic, 40)))))),
      title: 'Search',
    };
  }
  const res = lib.search(q, 500);
  const any = res.tracks.length || res.albums.length || res.artists.length;
  if (!any) return { el: viewShell(h('div.empty', h('div.empty-icon', icon('search', 28)), h('h2', `No results found for “${q}”`), h('p.dim', 'Check the spelling, or search by artist, album, genre or year.'))), title: 'Search' };
  const top = res.tracks[0];
  const topCard = top
    ? h('div.top-result', { onClick: () => app.playTracks(res.tracks, 0, { type: 'search', name: `Search: ${q}` }) },
      artEl(app.art, top.artId, { seed: top.album }),
      h('h2.ellipsis', top.title),
      h('div.muted', h('span.badge', 'Song'), ' ', top.artist),
      h('div.top-play', playButton(() => app.playTracks(res.tracks, 0, { type: 'search', name: `Search: ${q}` }))),
    )
    : null;
  const table = trackTable(app, { getTracks: () => res.tracks, scroller: app.viewScroller, context: { type: 'search', name: `Search: ${q}` }, sortable: true });
  disposer.add(() => table.destroy());
  const el = viewShell(
    h('div.search-top', top ? h('div', h('h2', 'Top result'), topCard) : null, h('div.grow', h('h2', 'Songs'), trackMini(app, res.tracks.slice(0, 4).map((t) => ({ ...t, playCount: t.playCount || 0 }))))),
    shelf('Artists', null, res.artists.map((ar) => artistTile(app, ar))),
    shelf('Albums', null, res.albums.map((al) => albumTile(app, al))),
    res.genres.length ? h('section.shelf', h('div.shelf-head', h('h2', 'Genres')), h('div.genre-chips', res.genres.map((g) => h('a.chip', { href: `#/genre/${enc(g.key)}` }, g.name)))) : null,
    h('h2', { style: { margin: '10px 0' } }, `All songs (${res.tracks.length})`),
    table.el,
  );
  return { el, title: `Search: ${q}` };
}

export function notFound(msg) {
  return { el: viewShell(h('div.empty', h('div.empty-icon', icon('info', 28)), h('h2', msg), h('a.btn', { href: '#/home' }, 'Go home'))), title: msg };
}

export { artistKeyOf, formatTime };
