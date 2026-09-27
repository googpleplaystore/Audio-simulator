// Virtualised track table used by every library view.

import { h, icon, append } from '../dom.js';
import { enc } from '../router.js';
import { artEl, VirtualList } from './lists.js';
import { TRACK_DRAG_TYPE } from '../shell/sidebar.js';
import { formatTime } from '../../util/format.js';
import { artistKeyOf } from '../../library/library.js';

const ROW_H = 56;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const SORTS = {
  title: (a, b) => collator.compare(a.title || '', b.title || ''),
  album: (a, b) => collator.compare(a.album || '', b.album || '') || (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0),
  artist: (a, b) => collator.compare(a.artist || '', b.artist || ''),
  duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  added: (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
};

/**
 * @param {object} app
 * @param {object} o
 * @param {() => object[]} o.getTracks
 * @param {HTMLElement} o.scroller
 * @param {object} [o.context] play context {type,id,name}
 * @param {boolean} [o.showAlbum=true]
 * @param {boolean} [o.showArt=true]
 * @param {'index'|'track'} [o.numbering='index']
 * @param {string} [o.playlistId] enables reordering + "remove from playlist"
 * @param {boolean} [o.sortable=true]
 */
export function trackTable(app, o) {
  const { scroller, showAlbum = true, showArt = true, numbering = 'index', playlistId = null, sortable = true } = o;
  let tracks = o.getTracks();
  let sortKey = null;
  let sortDir = 1;
  const selected = new Set();
  let anchor = -1;

  const view = () => {
    if (!sortKey) return tracks;
    return [...tracks].sort((a, b) => SORTS[sortKey](a, b) * sortDir);
  };
  let rows = view();

  const headBtn = (key, label) => {
    if (!sortable) return h('span', label);
    const b = h('button', { onClick: () => {
      if (sortKey === key) {
        if (sortDir === 1) sortDir = -1;
        else sortKey = null;
      } else {
        sortKey = key;
        sortDir = 1;
      }
      rows = view();
      renderHead();
      list.setCount(rows.length);
    } }, label);
    if (sortKey === key) b.append(icon(sortDir === 1 ? 'chevron-down' : 'chevron', 12));
    return b;
  };
  const head = h('div.tl-head');
  const renderHead = () => {
    head.innerHTML = '';
    append(head, [h('span', { style: { textAlign: 'right' } }, '#'), headBtn('title', 'Title'), showAlbum ? headBtn('album', 'Album') : null, headBtn('added', 'Added'), h('span'), h('span', { style: { textAlign: 'right' } }, headBtn('duration', '⏱'))]);
  };
  renderHead();

  const currentId = () => app.player.track?.id;

  /** Update the dynamic parts of a row in place (selection, playing, like). */
  const decorate = (row, i) => {
    const t = rows[i];
    if (!t) return;
    const playing = t.id === currentId();
    const sel = selected.has(t.id);
    row.classList.toggle('selected', sel);
    row.classList.toggle('playing', playing);
    row.setAttribute('aria-selected', sel ? 'true' : 'false');
    const idx = row.firstChild;
    const state = playing ? (app.player.playing ? 'eq' : 'eq-paused') : 'num';
    if (idx.dataset.state !== state) {
      idx.dataset.state = state;
      idx.firstChild.replaceWith(
        playing
          ? h('span.eq-bars', { class: app.player.playing ? '' : 'paused' }, h('i'), h('i'), h('i'))
          : h('span.idx-num', String(numbering === 'track' ? t.track || i + 1 : i + 1)),
      );
    }
    const like = row.querySelector('.tl-like');
    const liked = app.library.isLiked(t.id);
    if (like.classList.contains('liked') !== liked) {
      like.classList.toggle('liked', liked);
      like.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
      like.innerHTML = '';
      like.appendChild(icon(liked ? 'heart-fill' : 'heart', 16));
    }
  };
  const updateStates = () => {
    for (const [i, row] of list.rows) decorate(row, i);
  };

  const renderRow = (i) => {
    const t = rows[i];
    const row = h(
      'div.tl-row',
      {
        class: app.library.isLinked(t.id) ? '' : 'unavailable',
        draggable: 'true',
        role: 'row',
      },
      h('div.tl-index', h('span.idx-num', String(numbering === 'track' ? t.track || i + 1 : i + 1)), h('span.idx-play', icon('play', 14))),
      h(
        'div.tl-title',
        showArt ? artEl(app.art, t.artId, { seed: t.album }) : null,
        h('div.ellipsis', h('div.tl-title-text.ellipsis', t.title), h('div.tl-artist.ellipsis', h('a', { href: `#/artist/${enc(artistKeyOf(t))}`, onClick: (e) => e.stopPropagation() }, t.artist))),
      ),
      showAlbum ? h('div.tl-album.ellipsis', h('a', { href: `#/album/${enc(t._albumKey)}`, onClick: (e) => e.stopPropagation() }, t.album)) : null,
      h('div.tl-added.dim.ellipsis', { style: { fontSize: '12.5px' } }, t.addedAt ? new Date(t.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''),
      h('button.icon-btn.small.tl-like', { 'aria-label': 'Like', onClick: (e) => { e.stopPropagation(); app.toggleLike(t.id); } }, icon('heart', 16)),
      h('div.tl-dur', formatTime(t.duration || 0)),
    );
    row.firstChild.dataset.state = 'num';
    decorate(row, i);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.idx-play')) {
        play(i);
        return;
      }
      if (e.shiftKey && anchor >= 0) {
        selected.clear();
        const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
        for (let k = a; k <= b; k++) selected.add(rows[k].id);
      } else if (e.metaKey || e.ctrlKey) {
        if (selected.has(t.id)) selected.delete(t.id);
        else selected.add(t.id);
        anchor = i;
      } else {
        selected.clear();
        selected.add(t.id);
        anchor = i;
      }
      updateStates();
    });
    row.addEventListener('dblclick', () => play(i));
    row.addEventListener('contextmenu', (e) => {
      if (!selected.has(t.id)) {
        selected.clear();
        selected.add(t.id);
        anchor = i;
        updateStates();
      }
      const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
      const indices = playlistId ? rows.map((r, k) => (selected.has(r.id) ? k : -1)).filter((k) => k >= 0) : null;
      app.trackMenu(e, ids, { context: o.context, playlistId, indices });
    });
    row.addEventListener('dragstart', (e) => {
      if (!selected.has(t.id)) {
        selected.clear();
        selected.add(t.id);
        anchor = i;
      }
      const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
      e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', ids.map((id) => app.library.get(id)?.title).join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
      if (playlistId && !sortKey) e.dataTransfer.setData('application/x-audiospace-index', String(i));
      const ghost = h('div.drag-ghost', ids.length === 1 ? t.title : `${ids.length} tracks`);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    });
    if (playlistId && !sortKey) {
      row.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('application/x-audiospace-index')) return;
        e.preventDefault();
        row.classList.add('drop-before');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
      row.addEventListener('drop', (e) => {
        row.classList.remove('drop-before');
        const from = Number(e.dataTransfer.getData('application/x-audiospace-index'));
        if (!Number.isFinite(from)) return;
        e.preventDefault();
        const to = from < i ? i - 1 : i;
        app.library.movePlaylistItem(playlistId, from, to);
      });
    }
    return row;
  };

  const play = (i) => {
    app.playTracks(rows, i, o.context);
  };

  const list = new VirtualList({ scroller, rowHeight: ROW_H, count: rows.length, render: renderRow });
  const el = h('div.tracklist', { class: showAlbum ? '' : 'no-album', role: 'grid' }, head, list.el);

  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && selected.size) {
      const idx = rows.findIndex((r) => selected.has(r.id));
      if (idx >= 0) play(idx);
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      rows.forEach((r) => selected.add(r.id));
      updateStates();
    } else if (e.key === 'Delete' && playlistId && selected.size) {
      const indices = rows.map((r, k) => (selected.has(r.id) ? k : -1)).filter((k) => k >= 0);
      app.library.removeFromPlaylist(playlistId, indices);
    }
  });

  const refreshData = () => {
    tracks = o.getTracks();
    rows = view();
    list.setCount(rows.length);
  };
  const offs = [
    app.player.on('track', updateStates),
    app.player.on('state', updateStates),
    app.library.on('likes', updateStates),
    app.library.on('change', refreshData),
    app.library.on('playlists', (id) => {
      if (playlistId && (id === playlistId || id == null)) refreshData();
    }),
  ];
  return {
    el,
    get rows() {
      return rows;
    },
    refresh: refreshData,
    destroy() {
      offs.forEach((f) => f());
      list.destroy();
    },
  };
}
