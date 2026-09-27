// Left navigation: library, studio tools, playlists (drop targets), import.

import { h, icon, clear } from '../dom.js';
import { enc } from '../router.js';
import { artEl } from '../components/lists.js';
import { toast } from '../components/overlays.js';
import { plural } from '../../util/format.js';

export const TRACK_DRAG_TYPE = 'application/x-audiospace-tracks';

export function createSidebar(app) {
  const items = [];
  const nav = (path, iconName, label, { match = [], desktopOnly = false, badge = null } = {}) => {
    const a = h('a.nav-item', { href: `#/${path}`, class: desktopOnly ? 'desktop-only' : '', 'data-tip': label }, icon(iconName, 20), h('span.label', label), badge);
    items.push({ el: a, names: match });
    return a;
  };
  const likedBadge = h('span.badge');
  const importStatus = h('div.import-status', { hidden: true });
  const permBanner = h('button.btn.small.ghost', { hidden: true, onClick: () => app.reconnectLibrary() }, icon('link', 14), h('span.label', 'Reconnect library'));
  const playlistsEl = h('div.nav-playlists');

  const el = h(
    'aside.sidebar',
    { 'aria-label': 'Navigation' },
    h('div.brand', h('div.brand-mark', icon('logo', 20)), h('div.brand-text', h('div.brand-name', 'AudioSpace'), h('div.brand-sub', 'Virtual Audio Simulator'))),
    nav('home', 'home', 'Home', { match: ['home'] }),
    nav('search', 'search', 'Search', { match: ['search'] }),
    nav('songs', 'music', 'Songs', { match: ['songs'] }),
    h('div.nav-scroll',
      h('div.nav-section', h('span', 'Your Library')),
      nav('albums', 'album', 'Albums', { match: ['albums', 'album'], desktopOnly: true }),
      nav('artists', 'artist', 'Artists', { match: ['artists', 'artist'], desktopOnly: true }),
      nav('genres', 'genre', 'Genres', { match: ['genres', 'genre'], desktopOnly: true }),
      nav('liked', 'heart', 'Liked Songs', { match: ['liked'], desktopOnly: true, badge: likedBadge }),
      h('div.nav-section', h('span', 'Studio')),
      nav('studio/room', 'room', 'Room Simulator', { match: ['room'] }),
      nav('studio/hardware', 'speaker', 'Hardware Catalog', { match: ['hardware', 'hardwareDetail'], desktopOnly: true }),
      nav('studio/receiver', 'receiver', 'Receiver & Amp', { match: ['receiver'], desktopOnly: true }),
      nav('studio/crossover', 'crossover', 'Crossover', { match: ['crossover'], desktopOnly: true }),
      nav('studio/eq', 'eq', 'Equalizer', { match: ['eq'] }),
      nav('studio/analyzers', 'spectrum', 'Analyzers', { match: ['analyzers'] }),
      nav('studio/measure', 'mic', 'Measurements', { match: ['measure'], desktopOnly: true }),
      nav('studio/bake', 'bake', 'Bake & Export', { match: ['bake'], desktopOnly: true }),
      h('div.nav-section', h('span', 'Playlists'), h('button.icon-btn.small', { 'data-tip': 'Create playlist', 'aria-label': 'Create playlist', onClick: () => app.newPlaylist() }, icon('plus', 16))),
      playlistsEl,
    ),
    h('div.sidebar-footer',
      importStatus,
      permBanner,
      h('button.btn.small', { onClick: () => app.importFolder(), 'data-tip': 'Import a music folder (Ctrl+O)' }, icon('folder-plus', 16), h('span.label', 'Import folder')),
      nav('settings', 'settings', 'Settings', { match: ['settings'] }),
    ),
  );

  const renderPlaylists = () => {
    clear(playlistsEl);
    for (const p of app.library.playlistList()) {
      const firstTrack = app.library.get(p.trackIds[0]);
      const a = h('a.nav-playlist', { href: `#/playlist/${enc(p.id)}`, 'data-tip': p.name, dataset: { playlist: p.id } },
        artEl(app.art, firstTrack?.artId, { className: 'thumb', fallback: 'playlist', seed: p.id }),
        h('div.label.ellipsis', h('div.ellipsis', p.name), h('div.dim', { style: { fontSize: '11.5px' } }, plural(p.trackIds.length, 'track'))),
      );
      // Drop tracks onto a playlist.
      a.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes(TRACK_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          a.classList.add('drop-target');
        }
      });
      a.addEventListener('dragleave', () => a.classList.remove('drop-target'));
      a.addEventListener('drop', (e) => {
        a.classList.remove('drop-target');
        const raw = e.dataTransfer.getData(TRACK_DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          app.addToPlaylist(p.id, JSON.parse(raw));
        } catch {
          toast('Could not add tracks', { type: 'error' });
        }
      });
      playlistsEl.appendChild(a);
    }
    if (!app.library.playlists.size) playlistsEl.appendChild(h('div.dim.label', { style: { padding: '4px 12px', fontSize: '12px' } }, 'Create a playlist, then drag songs onto it.'));
    if (currentRoute) setActive(currentRoute);
  };

  const renderLikes = () => {
    likedBadge.textContent = app.library.likes.size ? String(app.library.likes.size) : '';
    likedBadge.hidden = !app.library.likes.size;
  };

  const renderPermission = () => {
    const need = app.library.permission !== 'granted' && app.library.dirs.size > 0;
    permBanner.hidden = !need;
  };

  let currentRoute = null;
  const setActive = (route) => {
    currentRoute = route;
    for (const it of items) it.el.classList.toggle('active', it.names.includes(route.name));
    for (const a of playlistsEl.querySelectorAll('.nav-playlist')) a.classList.toggle('active', route.name === 'playlist' && route.params.id === a.dataset.playlist);
  };

  // Import progress
  const bar = h('i');
  const statusText = h('div.ellipsis', { style: { fontSize: '12px' } });
  importStatus.append(h('div.split', icon('upload', 14), statusText, h('button.icon-btn.small', { 'aria-label': 'Cancel import', 'data-tip': 'Cancel import', onClick: () => app.importer.cancel() }, icon('close', 14))), h('div.progress', bar));
  app.importer.on('progress', (p) => {
    importStatus.hidden = false;
    if (p.phase === 'scan') {
      statusText.textContent = p.current || 'Scanning…';
      bar.style.width = '5%';
    } else {
      statusText.textContent = `Importing ${p.done}/${p.total}`;
      bar.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
    }
  });
  app.importer.on('done', () => {
    setTimeout(() => (importStatus.hidden = true), 800);
  });

  app.library.on('playlists', renderPlaylists);
  app.library.on('change', renderPlaylists);
  app.library.on('likes', renderLikes);
  app.library.on('permission', renderPermission);
  app.library.on('change', renderPermission);
  renderPlaylists();
  renderLikes();
  renderPermission();
  return { el, setActive };
}
