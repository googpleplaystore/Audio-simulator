// In-memory music library model backed by IndexedDB: tracks, derived
// album/artist/genre indexes, real-time search, likes, playlists, play stats
// and file resolution (File System Access handles, session files, stored
// blobs, or procedurally generated demo tracks).

import { Emitter } from '../util/emitter.js';
import { uid } from '../util/hash.js';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();

export function albumKeyOf(t) {
  const album = norm(t.album || UNKNOWN_ALBUM);
  const who = t.albumArtist ? norm(t.albumArtist) : t.dirPath ? `dir:${norm(t.dirPath)}` : norm(t.artist || UNKNOWN_ARTIST);
  return `${album}|${who}`;
}

/** Normalised lookup key (case/diacritic-insensitive). */
export const keyOf = (s) => norm(s);

/** Key of the artist page a track links to. */
export function artistKeyOf(t) {
  return norm(t.albumArtist || splitArtists(t.artist)[0] || UNKNOWN_ARTIST);
}

export function primaryArtist(t) {
  return t.albumArtist || t.artist || UNKNOWN_ARTIST;
}

/**
 * Split "A feat. B; C" style artist strings into individual artists. Commas
 * and ampersands are deliberately kept ("Earth, Wind & Fire").
 */
export function splitArtists(s) {
  if (!s) return [UNKNOWN_ARTIST];
  return s
    .split(/\s*(?:;|\s\/\s|\bfeat\.|\bfeat\b|\bft\.|\bfeaturing\b)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export class Library extends Emitter {
  constructor(db, artCache) {
    super();
    this.db = db;
    this.art = artCache;
    this.tracks = new Map();
    this.list = [];
    this.albums = new Map();
    this.artists = new Map();
    this.genres = new Map();
    this.likes = new Map(); // id -> timestamp
    this.playlists = new Map();
    this.sessionFiles = new Map(); // trackId -> File (not persisted)
    this.fileRecords = new Map(); // trackId -> files store record (without blob)
    this.dirs = new Map();
    this.permission = 'granted'; // 'granted' | 'prompt' | 'denied'
    this.demoResolver = null; // (demoId) => Promise<Blob>
    this.knownArtIds = new Set();
  }

  async load() {
    const [tracks, likes, playlists, files, dirs] = await Promise.all([
      this.db.getAll('tracks'),
      this.db.getAll('likes'),
      this.db.getAll('playlists'),
      this.db.getAll('files'),
      this.db.getAll('dirs'),
    ]);
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.likes = new Map(likes.map((l) => [l.id, l.at]));
    this.playlists = new Map(playlists.map((p) => [p.id, p]));
    this.fileRecords = new Map(files.map((f) => [f.id, { id: f.id, kind: f.kind, handle: f.handle, demo: f.demo, hasBlob: !!f.blob }]));
    this.dirs = new Map(dirs.map((d) => [d.id, d]));
    for (const t of tracks) if (t.artId) this.knownArtIds.add(t.artId);
    await this.checkPermission();
    this._rebuild();
    this.emit('change', { reason: 'load' });
  }

  async checkPermission() {
    let state = 'granted';
    for (const d of this.dirs.values()) {
      if (!d.handle || !d.handle.queryPermission) continue;
      try {
        const p = await d.handle.queryPermission({ mode: 'read' });
        if (p !== 'granted') state = p;
      } catch {
        state = 'prompt';
      }
    }
    this.permission = state;
    return state;
  }

  /** Must be called from a user gesture. */
  async requestPermission() {
    let ok = true;
    for (const d of this.dirs.values()) {
      if (!d.handle || !d.handle.requestPermission) continue;
      try {
        const p = await d.handle.requestPermission({ mode: 'read' });
        if (p !== 'granted') ok = false;
      } catch {
        ok = false;
      }
    }
    await this.checkPermission();
    this.emit('permission', this.permission);
    return ok;
  }

  _rebuild() {
    const list = [...this.tracks.values()];
    list.sort(
      (a, b) =>
        collator.compare(primaryArtist(a), primaryArtist(b)) ||
        collator.compare(a.album || '', b.album || '') ||
        (a.disc || 1) - (b.disc || 1) ||
        (a.track || 0) - (b.track || 0) ||
        collator.compare(a.title || '', b.title || ''),
    );
    this.list = list;
    const albums = new Map();
    const artists = new Map();
    const genres = new Map();
    for (const t of list) {
      t._hay = norm(`${t.title} ${t.artist} ${t.albumArtist || ''} ${t.album} ${t.genre || ''} ${t.year || ''} ${t.composer || ''}`);
      t._albumKey = albumKeyOf(t);
      let al = albums.get(t._albumKey);
      if (!al) {
        al = { key: t._albumKey, name: t.album || UNKNOWN_ALBUM, artists: new Set(), albumArtist: t.albumArtist || null, year: t.year || null, artId: t.artId || null, trackIds: [], duration: 0, genre: t.genre || null, addedAt: t.addedAt || 0 };
        albums.set(t._albumKey, al);
      }
      al.trackIds.push(t.id);
      al.duration += t.duration || 0;
      al.artists.add(t.artist || UNKNOWN_ARTIST);
      if (!al.artId && t.artId) al.artId = t.artId;
      if (!al.year && t.year) al.year = t.year;
      al.addedAt = Math.max(al.addedAt, t.addedAt || 0);
      for (const name of new Set([...splitArtists(t.artist), ...(t.albumArtist ? [t.albumArtist] : [])])) {
        const k = norm(name);
        let ar = artists.get(k);
        if (!ar) {
          ar = { key: k, name, trackIds: [], albumKeys: new Set(), artId: null };
          artists.set(k, ar);
        }
        ar.trackIds.push(t.id);
        ar.albumKeys.add(t._albumKey);
        if (!ar.artId && t.artId) ar.artId = t.artId;
      }
      for (const g of (t.genre || 'Unknown').split(/\s*[,;]\s*/)) {
        const gk = norm(g);
        if (!gk) continue;
        let ge = genres.get(gk);
        if (!ge) {
          ge = { key: gk, name: g, trackIds: [] };
          genres.set(gk, ge);
        }
        ge.trackIds.push(t.id);
      }
    }
    for (const al of albums.values()) {
      al.artist = al.albumArtist || (al.artists.size > 1 ? 'Various Artists' : [...al.artists][0]);
    }
    this.albums = albums;
    this.artists = artists;
    this.genres = genres;
  }

  get size() {
    return this.tracks.size;
  }

  get(id) {
    return this.tracks.get(id) || null;
  }

  albumList(sort = 'name') {
    const arr = [...this.albums.values()];
    if (sort === 'recent') arr.sort((a, b) => b.addedAt - a.addedAt);
    else if (sort === 'year') arr.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sort === 'artist') arr.sort((a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.name, b.name));
    else arr.sort((a, b) => collator.compare(a.name, b.name));
    return arr;
  }

  artistList() {
    return [...this.artists.values()].sort((a, b) => collator.compare(a.name, b.name));
  }

  genreList() {
    return [...this.genres.values()].sort((a, b) => b.trackIds.length - a.trackIds.length);
  }

  albumTracks(key) {
    const al = this.albums.get(key);
    if (!al) return [];
    return al.trackIds
      .map((id) => this.tracks.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0) || collator.compare(a.title, b.title));
  }

  recentlyAdded(limit = 24) {
    return [...this.tracks.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, limit);
  }

  recentlyPlayed(limit = 24) {
    return [...this.tracks.values()]
      .filter((t) => t.lastPlayed)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, limit);
  }

  mostPlayed(limit = 24) {
    return [...this.tracks.values()]
      .filter((t) => t.playCount)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, limit);
  }

  /**
   * Real-time search. Every query token must match somewhere; results are
   * ranked by where the match occurred.
   */
  search(query, limit = 200) {
    const q = norm(query);
    const empty = { tracks: [], albums: [], artists: [], genres: [] };
    if (!q) return empty;
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const t of this.list) {
      const hay = t._hay;
      let ok = true;
      for (const tok of tokens) {
        if (!hay.includes(tok)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const title = norm(t.title);
      let score = 0;
      if (title === q) score += 100;
      else if (title.startsWith(q)) score += 50;
      else if (title.includes(q)) score += 20;
      if (norm(t.artist).startsWith(q)) score += 15;
      if (norm(t.album).startsWith(q)) score += 8;
      score += (t.playCount || 0) * 0.1 + (this.likes.has(t.id) ? 2 : 0);
      scored.push([score, t]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const matchName = (name) => {
      const n = norm(name);
      return tokens.every((tok) => n.includes(tok));
    };
    return {
      tracks: scored.slice(0, limit).map((s) => s[1]),
      albums: [...this.albums.values()].filter((a) => matchName(`${a.name} ${a.artist}`)).slice(0, 24),
      artists: [...this.artists.values()].filter((a) => matchName(a.name)).slice(0, 24),
      genres: [...this.genres.values()].filter((g) => matchName(g.name)).slice(0, 12),
    };
  }

  // ---------------------------------------------------------------- mutation

  /**
   * Add or update tracks.
   * @param {Array<{track:object, file:object}>} items track records + file records
   */
  async addTracks(items) {
    const trackRecs = [];
    const fileRecs = [];
    for (const { track, file } of items) {
      const prev = this.tracks.get(track.id);
      const rec = { ...track, playCount: prev?.playCount || 0, lastPlayed: prev?.lastPlayed || null, addedAt: prev?.addedAt || track.addedAt || Date.now() };
      delete rec._hay;
      delete rec._albumKey;
      trackRecs.push(rec);
      this.tracks.set(rec.id, rec);
      if (file) {
        fileRecs.push(file);
        this.fileRecords.set(file.id, { id: file.id, kind: file.kind, handle: file.handle, demo: file.demo, hasBlob: !!file.blob });
      }
      if (rec.artId) this.knownArtIds.add(rec.artId);
    }
    await this.db.putMany('tracks', trackRecs);
    if (fileRecs.length) await this.db.putMany('files', fileRecs);
  }

  /** Call after one or more addTracks batches. */
  commit(reason = 'import') {
    this._rebuild();
    this.emit('change', { reason });
  }

  async addDirectory(handle, name) {
    const id = `dir_${name}_${Date.now().toString(36)}`;
    const rec = { id, name, handle, addedAt: Date.now() };
    await this.db.put('dirs', rec);
    this.dirs.set(id, rec);
    return id;
  }

  async removeTracks(ids) {
    for (const id of ids) {
      this.tracks.delete(id);
      this.fileRecords.delete(id);
      this.sessionFiles.delete(id);
      this.likes.delete(id);
    }
    await this.db.deleteMany('tracks', ids);
    await this.db.deleteMany('files', ids);
    await this.db.deleteMany('likes', ids);
    await this.db.deleteMany('waveforms', ids);
    for (const p of this.playlists.values()) {
      const before = p.trackIds.length;
      p.trackIds = p.trackIds.filter((t) => this.tracks.has(t));
      if (p.trackIds.length !== before) await this.db.put('playlists', p);
    }
    this.commit('remove');
  }

  async clearAll() {
    for (const s of ['tracks', 'files', 'dirs', 'waveforms', 'likes', 'playlists', 'artwork']) await this.db.clear(s);
    this.tracks.clear();
    this.fileRecords.clear();
    this.sessionFiles.clear();
    this.likes.clear();
    this.playlists.clear();
    this.dirs.clear();
    this.knownArtIds.clear();
    if (this.art) this.art.clear();
    this.commit('clear');
    this.emit('playlists');
    this.emit('likes');
  }

  async updateTrack(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    const rec = { ...t };
    delete rec._hay;
    delete rec._albumKey;
    await this.db.put('tracks', rec);
    this.emit('track-updated', t);
  }

  async recordPlay(id) {
    const t = this.tracks.get(id);
    if (!t) return;
    await this.updateTrack(id, { playCount: (t.playCount || 0) + 1, lastPlayed: Date.now() });
  }

  // ---------------------------------------------------------------- likes

  isLiked(id) {
    return this.likes.has(id);
  }

  async toggleLike(id) {
    if (this.likes.has(id)) {
      this.likes.delete(id);
      await this.db.delete('likes', id);
    } else {
      const at = Date.now();
      this.likes.set(id, at);
      await this.db.put('likes', { id, at });
    }
    this.emit('likes', id);
    return this.likes.has(id);
  }

  likedTracks() {
    return [...this.likes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.tracks.get(id))
      .filter(Boolean);
  }

  // ---------------------------------------------------------------- playlists

  playlistList() {
    return [...this.playlists.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async createPlaylist(name, trackIds = []) {
    const p = { id: uid('pl'), name: name || `My Playlist #${this.playlists.size + 1}`, description: '', trackIds: [...trackIds], createdAt: Date.now(), updatedAt: Date.now() };
    this.playlists.set(p.id, p);
    await this.db.put('playlists', p);
    this.emit('playlists');
    return p;
  }

  async savePlaylist(p) {
    p.updatedAt = Date.now();
    this.playlists.set(p.id, p);
    await this.db.put('playlists', p);
    this.emit('playlists', p.id);
  }

  async renamePlaylist(id, name, description) {
    const p = this.playlists.get(id);
    if (!p) return;
    p.name = name || p.name;
    if (description != null) p.description = description;
    await this.savePlaylist(p);
  }

  async deletePlaylist(id) {
    this.playlists.delete(id);
    await this.db.delete('playlists', id);
    this.emit('playlists');
  }

  async addToPlaylist(id, trackIds) {
    const p = this.playlists.get(id);
    if (!p) return 0;
    const add = trackIds.filter((t) => this.tracks.has(t));
    p.trackIds.push(...add);
    await this.savePlaylist(p);
    return add.length;
  }

  async removeFromPlaylist(id, indices) {
    const p = this.playlists.get(id);
    if (!p) return;
    const set = new Set(indices);
    p.trackIds = p.trackIds.filter((_, i) => !set.has(i));
    await this.savePlaylist(p);
  }

  async movePlaylistItem(id, from, to) {
    const p = this.playlists.get(id);
    if (!p || from === to) return;
    const [item] = p.trackIds.splice(from, 1);
    p.trackIds.splice(to, 0, item);
    await this.savePlaylist(p);
  }

  playlistTracks(id) {
    const p = this.playlists.get(id);
    return p ? p.trackIds.map((t) => this.tracks.get(t)).filter(Boolean) : [];
  }

  // ---------------------------------------------------------------- files

  /** False only for tracks whose session-only File was lost on reload. */
  isLinked(id) {
    if (this.sessionFiles.has(id)) return true;
    const f = this.fileRecords.get(id);
    return !!f && f.kind !== 'session';
  }

  isAvailable(id) {
    if (this.sessionFiles.has(id)) return true;
    const f = this.fileRecords.get(id);
    if (!f) return false;
    if (f.kind === 'fs') return this.permission === 'granted';
    return f.kind === 'blob' || f.kind === 'demo';
  }

  /** Resolve a playable Blob/File for a track. */
  async getFile(id) {
    const session = this.sessionFiles.get(id);
    if (session) return session;
    const f = this.fileRecords.get(id);
    if (!f) throw new Error('File for this track is not available. Re-import or relink the folder.');
    if (f.kind === 'fs') {
      try {
        return await f.handle.getFile();
      } catch (err) {
        this.permission = 'prompt';
        this.emit('permission', 'prompt');
        const e = new Error('Permission needed to read your music folder. Click "Reconnect library".');
        e.code = 'PERMISSION';
        e.cause = err;
        throw e;
      }
    }
    if (f.kind === 'blob') {
      const rec = await this.db.get('files', id);
      if (rec && rec.blob) return rec.blob;
      throw new Error('Stored audio is missing.');
    }
    if (f.kind === 'demo') {
      if (!this.demoResolver) throw new Error('Demo generator unavailable');
      return this.demoResolver(f.demo);
    }
    throw new Error('Track file is not linked in this session. Use "Relink folder" to reconnect it.');
  }

  /** Attach session File objects to tracks that were imported without handles. */
  relink(entries) {
    let n = 0;
    const byPath = new Map();
    for (const t of this.tracks.values()) if (t.path) byPath.set(`${t.path}|${t.size}`, t.id);
    for (const e of entries) {
      const id = byPath.get(`${e.path}|${e.file.size}`);
      if (id) {
        this.sessionFiles.set(id, e.file);
        n++;
      }
    }
    if (n) this.emit('change', { reason: 'relink' });
    return n;
  }

  totalDuration(tracks = this.list) {
    let s = 0;
    for (const t of tracks) s += t.duration || 0;
    return s;
  }
}
