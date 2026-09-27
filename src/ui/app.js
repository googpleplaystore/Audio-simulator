// Application controller: wires services (store, library, audio engine,
// player, importer…), mounts the shell, routes views and owns global actions.

import { Store } from '../core/store.js';
import { loadInstalledAddons } from '../hardware/addonStore.js';
import { importAddonFiles } from './components/addonManager.js';
import { migrateState, STORAGE_KEY, defaultState } from '../core/settings.js';
import { openDatabase } from '../core/db.js';
import { Library, artistKeyOf } from '../library/library.js';
import { ArtCache, storeArtwork } from '../library/artwork.js';
import { WaveformStore } from '../library/waveform.js';
import { Importer } from '../library/importer.js';
import { demoBlob, installDemoLibrary, DEMO_TRACKS } from '../library/demo.js';
import { AudioSystem } from '../audio/context.js';
import { SimulationEngine } from '../audio/engine.js';
import { AcousticsClient } from '../acoustics/client.js';
import { Haptics } from '../audio/haptics.js';
import { Queue } from '../player/queue.js';
import { Player } from '../player/player.js';
import { Router, enc } from './router.js';
import { h, clear, Disposer } from './dom.js';
import { toast, openMenu, promptDialog, confirmDialog, modal, isModalOpen } from './components/overlays.js';
import { formatTime, formatBytes, plural } from '../util/format.js';
import { createSidebar } from './shell/sidebar.js';
import { createTopbar } from './shell/topbar.js';
import { createPlayerBar } from './shell/playerbar.js';
import { createSidePanel } from './shell/sidepanel.js';
import { VIEWS } from './views/index.js';

const SESSION_KEY = 'audiospace:session';

const ENGINE_PATHS = ['engine', 'receiver', 'crossover', 'eq', 'roomCorrection', 'room', 'listener', 'speakers', 'subs', 'player.volume', 'player.muted'];

export class App {
  async init(root) {
    this.root = root;
    // Custom hardware first: saved settings may reference add-on models.
    this.addonProblems = loadInstalledAddons().problems;
    this.store = new Store(migrateState(Store.load(STORAGE_KEY)), { persistKey: STORAGE_KEY });
    this.db = await openDatabase();
    this.art = new ArtCache(this.db);
    this.library = new Library(this.db, this.art);
    this.library.demoResolver = (id) => demoBlob(id);
    this.waveforms = new WaveformStore(this.db);
    this.importer = new Importer(this.library, this.db);

    this.audio = new AudioSystem();
    this.ctx = this.audio.ctx;
    this.acoustics = new AcousticsClient();
    this.engine = new SimulationEngine(this.ctx, { acoustics: this.acoustics, quality: this.store.get('engine.quality') });
    this.engine.output.connect(this.ctx.destination);
    await this.engine.applyState(this.store.state);
    this.queue = new Queue();
    this.player = new Player({ ctx: this.ctx, output: this.engine.input, library: this.library, queue: this.queue, store: this.store, unlock: () => this.audio.unlock() });
    this.haptics = new Haptics(this.engine, this.store);
    this.haptics.start();

    this.store.subscribe(ENGINE_PATHS, () => this.scheduleEngine());
    this.store.on('save-error', () => toast('Settings could not be saved — browser storage is full or blocked. Delete some scenes or free up space.', { type: 'error', timeout: 8000 }));
    this.store.subscribe(['ui.reduceMotion'], () => document.documentElement.classList.toggle('reduce-motion', !!this.store.get('ui.reduceMotion')));
    document.documentElement.classList.toggle('reduce-motion', !!this.store.get('ui.reduceMotion'));

    await this.library.load();
    this._wirePlayer();
    this._restoreSession();
    this._mount();
    this._installShortcuts();
    this._installDropImport();
    this._installImporterFeedback();

    this.router = new Router([
      { pattern: 'home', name: 'home' },
      { pattern: 'search', name: 'search' },
      { pattern: 'songs', name: 'songs' },
      { pattern: 'albums', name: 'albums' },
      { pattern: 'album/:key', name: 'album' },
      { pattern: 'artists', name: 'artists' },
      { pattern: 'artist/:key', name: 'artist' },
      { pattern: 'genres', name: 'genres' },
      { pattern: 'genre/:key', name: 'genre' },
      { pattern: 'liked', name: 'liked' },
      { pattern: 'playlists', name: 'playlists' },
      { pattern: 'playlist/:id', name: 'playlist' },
      { pattern: 'now-playing', name: 'nowPlaying' },
      { pattern: 'studio/room', name: 'room' },
      { pattern: 'studio/hardware', name: 'hardware' },
      { pattern: 'studio/hardware/:id', name: 'hardwareDetail' },
      { pattern: 'studio/receiver', name: 'receiver' },
      { pattern: 'studio/crossover', name: 'crossover' },
      { pattern: 'studio/eq', name: 'eq' },
      { pattern: 'studio/analyzers', name: 'analyzers' },
      { pattern: 'studio/measure', name: 'measure' },
      { pattern: 'studio/bass', name: 'bass' },
      { pattern: 'studio/compare', name: 'compare' },
      { pattern: 'studio/bake', name: 'bake' },
      { pattern: 'settings', name: 'settings' },
    ]);
    this.router.on('change', (route) => this._showView(route));
    this.router.start();
    window.__audiospace = this; // debugging/e2e hook
    window.addEventListener('pagehide', () => this._saveSession());
    setInterval(() => this._saveSession(), 5000);
    // Warm up the first demo in the background so it starts instantly.
    if (this.library.size && this.library.get('demo_neon-sub')) setTimeout(() => demoBlob('neon-sub').catch(() => {}), 1500);
  }

  // ------------------------------------------------------------ engine sync
  scheduleEngine() {
    if (this._engineTimer) return;
    this._engineTimer = setTimeout(() => {
      this._engineTimer = null;
      this.engine.applyState(this.store.state).catch((err) => console.error('[engine]', err));
    }, 0);
  }

  // ------------------------------------------------------------ layout
  /** Below this width the side panel overlays the page instead of docking. */
  panelOverlays() {
    return !!window.matchMedia?.('(max-width: 1180px)').matches;
  }

  _mount() {
    clear(this.root);
    // An overlaying panel would hide the whole page on phones: start closed.
    if (this.panelOverlays() && this.store.get('ui.queueOpen')) this.store.set('ui.queueOpen', false);
    this.shell = h('div.app', { class: this.store.get('ui.queueOpen') ? '' : 'panel-closed' });
    this.sidebar = createSidebar(this);
    this.viewScroller = h('div.view', { id: 'view', tabindex: '-1' });
    this.topbar = createTopbar(this);
    this.main = h('main.main', this.topbar.el, this.viewScroller);
    this.panel = createSidePanel(this);
    this.playerbar = createPlayerBar(this);
    this.shell.append(this.sidebar.el, this.main, this.panel.el, this.playerbar.el);
    this.root.appendChild(this.shell);
    this.viewScroller.addEventListener('scroll', () => this.topbar.setSolid(this.viewScroller.scrollTop > 40), { passive: true });
    this.store.subscribe(['ui.queueOpen'], () => this.shell.classList.toggle('panel-closed', !this.store.get('ui.queueOpen')));
  }

  _showView(route) {
    if (this.panelOverlays() && this.store.get('ui.queueOpen')) this.store.set('ui.queueOpen', false);
    if (this.currentView) {
      this.currentView.disposer?.run();
      this.currentView.destroy?.();
    }
    const factory = VIEWS[route.name] || VIEWS.home;
    const disposer = new Disposer();
    clear(this.viewScroller);
    this.viewScroller.scrollTop = 0;
    let view;
    try {
      view = factory(this, route.params, route.query, disposer);
    } catch (err) {
      console.error(err);
      view = { el: h('div.view-inner', h('div.empty', h('h2', 'Something went wrong'), h('p.muted', String(err.message || err)))) };
    }
    view.disposer = disposer;
    this.currentView = view;
    view.el.classList.add('view-enter');
    this.viewScroller.appendChild(view.el);
    this.topbar.setSolid(false);
    this.sidebar.setActive(route);
    this.topbar.onRoute(route);
    document.title = `${view.title ? `${view.title} · ` : ''}AudioSpace`;
    view.mounted?.();
  }

  go(path) {
    this.router.go(path);
  }

  // ------------------------------------------------------------ player wiring
  _wirePlayer() {
    this.player.on('error', (err, track) => {
      toast(`${track ? `“${track.title}”: ` : ''}${err.message || err}`, {
        type: 'error',
        timeout: 5200,
        action: err.code === 'PERMISSION' ? { label: 'Reconnect', fn: () => this.reconnectLibrary() } : null,
      });
    });
    this.player.on('needs-gesture', () => toast('Click play to start audio (browser autoplay policy).'));
    this.player.on('track', () => this._saveSession());
    this.library.on('change', ({ reason }) => {
      if (reason === 'remove' || reason === 'clear') this.queue.prune((id) => this.library.tracks.has(id));
    });
  }

  _saveSession() {
    try {
      const data = { queue: this.queue.serialize(), trackId: this.player.track?.id || null, position: this.player.currentTime || 0 };
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch {
      /* quota / private mode */
    }
  }

  _restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      this.queue.restore(s.queue);
      this.queue.prune((id) => this.library.tracks.has(id));
      if (s.trackId && this.library.get(s.trackId)) this.player.prepare(s.trackId, s.position || 0);
    } catch (err) {
      console.warn('[session] restore failed', err);
    }
  }

  // ------------------------------------------------------------ actions
  async playTracks(tracks, index = 0, context = null) {
    const ids = tracks.map((t) => (typeof t === 'string' ? t : t.id));
    if (!ids.length) return;
    await this.audio.unlock();
    await this.player.playContext(ids, index, context);
  }

  playNext(ids) {
    this.queue.addNext(ids);
    toast(ids.length === 1 ? 'Playing next' : `${ids.length} tracks will play next`);
  }

  addToQueue(ids) {
    this.queue.addToQueue(ids);
    toast(ids.length === 1 ? 'Added to queue' : `Added ${ids.length} tracks to queue`);
  }

  async toggleLike(id) {
    const liked = await this.library.toggleLike(id);
    toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
    return liked;
  }

  async newPlaylist(trackIds = []) {
    const name = await promptDialog('Create playlist', { value: `My Playlist #${this.library.playlists.size + 1}`, ok: 'Create' });
    if (!name) return null;
    const p = await this.library.createPlaylist(name, trackIds);
    toast(`Created “${p.name}”${trackIds.length ? ` with ${plural(trackIds.length, 'track')}` : ''}`);
    return p;
  }

  async addToPlaylist(playlistId, ids) {
    const n = await this.library.addToPlaylist(playlistId, ids);
    const p = this.library.playlists.get(playlistId);
    toast(`Added ${plural(n, 'track')} to “${p?.name}”`);
  }

  playlistSubmenu(ids) {
    return [
      { label: 'New playlist…', icon: 'plus', onClick: () => this.newPlaylist(ids) },
      ...(this.library.playlists.size ? ['-'] : []),
      ...this.library.playlistList().map((p) => ({ label: p.name, icon: 'playlist', onClick: () => this.addToPlaylist(p.id, ids) })),
    ];
  }

  /** Context menu for one or more tracks. */
  trackMenu(e, ids, opts = {}) {
    e.preventDefault();
    const first = this.library.get(ids[0]);
    if (!first) return;
    const single = ids.length === 1;
    const liked = single && this.library.isLiked(first.id);
    const items = [
      { heading: single ? first.title : plural(ids.length, 'track') },
      { label: 'Play', icon: 'play', onClick: () => this.playTracks(ids, 0, opts.context) },
      { label: 'Play next', icon: 'queue', onClick: () => this.playNext(ids) },
      { label: 'Add to queue', icon: 'playlist', onClick: () => this.addToQueue(ids) },
      '-',
      { label: 'Add to playlist', icon: 'plus', submenu: this.playlistSubmenu(ids) },
      single ? { label: liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: liked ? 'heart-fill' : 'heart', onClick: () => this.toggleLike(first.id) } : null,
      opts.playlistId != null ? { label: 'Remove from this playlist', icon: 'minus', onClick: () => this.library.removeFromPlaylist(opts.playlistId, opts.indices) } : null,
      '-',
      single ? { label: 'Go to artist', icon: 'artist', onClick: () => this.go(`artist/${enc(artistKeyOf(first))}`) } : null,
      single ? { label: 'Go to album', icon: 'album', onClick: () => this.go(`album/${enc(first._albumKey)}`) } : null,
      single ? { label: 'Track info', icon: 'info', onClick: () => this.showTrackInfo(first) } : null,
      single ? { label: 'Bake with room simulation…', icon: 'bake', onClick: () => this.go(`studio/bake?track=${enc(first.id)}`) } : null,
      '-',
      { label: single ? 'Remove from library' : `Remove ${ids.length} from library`, icon: 'trash', danger: true, onClick: () => this.removeTracks(ids) },
    ];
    openMenu(e.clientX, e.clientY, items);
  }

  async removeTracks(ids) {
    const ok = await confirmDialog('Remove from library?', `${plural(ids.length, 'track')} will be removed from AudioSpace. Your files on disk are not touched.`, { ok: 'Remove', danger: true });
    if (!ok) return;
    if (this.player.track && ids.includes(this.player.track.id)) this.player.pause();
    await this.library.removeTracks(ids);
    toast(`Removed ${plural(ids.length, 'track')}`);
  }

  showTrackInfo(t) {
    const rows = [
      ['Title', t.title],
      ['Artist', t.artist],
      ['Album artist', t.albumArtist],
      ['Album', t.album],
      ['Genre', t.genre],
      ['Year', t.year],
      ['Track', t.track ? `${t.track}${t.trackTotal ? ` / ${t.trackTotal}` : ''}` : null],
      ['Disc', t.disc ? `${t.disc}${t.discTotal ? ` / ${t.discTotal}` : ''}` : null],
      ['Composer', t.composer],
      ['Duration', t.duration ? formatTime(t.duration) : null],
      ['Format', [t.format?.toUpperCase(), t.codec].filter(Boolean).join(' · ')],
      ['Sample rate', t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : null],
      ['Bit depth', t.bitsPerSample ? `${t.bitsPerSample}-bit` : null],
      ['Channels', t.channels],
      ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : null],
      ['ReplayGain', t.replayGain?.trackGain != null ? `${t.replayGain.trackGain.toFixed(2)} dB (track)` : null],
      ['File size', t.size ? formatBytes(t.size) : null],
      ['Path', t.path],
      ['Plays', t.playCount || 0],
    ].filter(([, v]) => v != null && v !== '');
    modal((close) =>
      h(
        'div',
        h('h2', 'Track info'),
        h('div.info-grid', rows.map(([k, v]) => [h('div.dim', k), h('div.ellipsis', { title: String(v) }, String(v))])),
        t.lyrics ? h('details', { style: { marginTop: '14px' } }, h('summary', 'Lyrics'), h('pre.lyrics-pre', t.lyrics)) : null,
        h('div.modal-actions', h('button.btn.primary', { onClick: () => close() }, 'Close')),
      ),
    );
  }

  // ------------------------------------------------------------ import
  async importFolder() {
    await this.audio.unlock();
    if (Importer.supportsDirectoryPicker) {
      try {
        const stats = await this.importer.pickDirectory();
        return stats;
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
        toast(`Import failed: ${err.message || err}`, { type: 'error' });
        return null;
      }
    }
    return this.importViaInput(true);
  }

  importFiles() {
    return this.importViaInput(false);
  }

  importViaInput(directory) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', multiple: true, accept: 'audio/*,.flac,.m4a,.mp3,.wav,.ogg,.opus,.aac,.aif,.aiff', style: { display: 'none' } });
      if (directory) input.setAttribute('webkitdirectory', '');
      input.addEventListener('change', async () => {
        const files = [...(input.files || [])];
        input.remove();
        if (!files.length) return resolve(null);
        try {
          resolve(await this.importer.importFileList(files));
        } catch (err) {
          toast(`Import failed: ${err.message || err}`, { type: 'error' });
          resolve(null);
        }
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  async relinkFolder() {
    const input = h('input', { type: 'file', multiple: true, webkitdirectory: '', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const files = [...(input.files || [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
      input.remove();
      const n = this.library.relink(files);
      toast(n ? `Relinked ${plural(n, 'track')}` : 'No matching tracks found in that folder', { type: n ? 'success' : 'info' });
    });
    document.body.appendChild(input);
    input.click();
  }

  async reconnectLibrary() {
    const ok = await this.library.requestPermission();
    toast(ok ? 'Library folder reconnected' : 'Permission was not granted', { type: ok ? 'success' : 'error' });
  }

  async installDemo() {
    if (DEMO_TRACKS.every((d) => this.library.get(`demo_${d.id}`))) {
      toast('Demo tracks are already in your library');
      return;
    }
    const n = await installDemoLibrary(this.library, this.db, storeArtwork);
    toast(`Added ${n} demo & calibration tracks`, { type: 'success' });
    demoBlob('neon-sub').catch(() => {});
  }

  _installImporterFeedback() {
    this.importer.on('done', (s) => {
      if (s.cancelled) toast(`Import cancelled — ${plural(s.added, 'track')} added`);
      else if (s.total === 0) toast('No supported audio files found (MP3, FLAC, WAV, M4A, OGG, OPUS).', { type: 'error' });
      else {
        const parts = [`Imported ${plural(s.added, 'track')}`];
        if (s.skipped) parts.push(`${s.skipped} already in library`);
        if (s.relinked) parts.push(`${s.relinked} relinked`);
        if (s.failed) parts.push(`${s.failed} failed`);
        toast(parts.join(' · '), { type: s.failed && !s.added ? 'error' : 'success', timeout: 5000 });
      }
    });
  }

  _installDropImport() {
    const overlay = h('div.drop-overlay', h('div.drop-box', h('div.empty-icon', { html: '' }), h('h2', 'Drop music to import'), h('p.muted', 'Folders and files — MP3, FLAC, WAV, M4A, OGG, OPUS — or hardware add-ons (.json)')));
    document.body.appendChild(overlay);
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      overlay.classList.add('show');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      // Hardware add-ons (.json) go to the add-on importer, music to the library.
      const files = [...(e.dataTransfer.files || [])];
      const addons = files.filter((f) => /\.json$/i.test(f.name));
      if (addons.length) importAddonFiles(this, addons);
      if (addons.length && addons.length === files.length) return;
      this.importer.importDrop(e.dataTransfer).catch((err) => toast(`Import failed: ${err.message || err}`, { type: 'error' }));
    });
  }

  // ------------------------------------------------------------ shortcuts
  _installShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (isModalOpen()) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (t && t.getAttribute && (t.getAttribute('role') === 'slider' || t.closest?.('.menu'))) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'f') {
        e.preventDefault();
        this.topbar.focusSearch();
      } else if (mod && k === 'o') {
        e.preventDefault();
        this.importFolder();
      } else if (mod) return;
      else if (e.key === ' ') {
        e.preventDefault();
        this.player.toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) this.player.next();
        else this.player.seekBy(5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) this.player.prev();
        else this.player.seekBy(-5);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = Math.min(1, Math.max(0, (this.store.get('player.volume') ?? 0.8) + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
        this.store.set('player.volume', Math.round(v * 100) / 100);
        this.store.set('player.muted', false);
      } else if (k === 'm') this.store.set('player.muted', !this.store.get('player.muted'));
      else if (k === 's') this.queue.setShuffle(!this.queue.shuffle);
      else if (k === 'r') this.queue.cycleRepeat();
      else if (k === 'l' && this.player.track) this.toggleLike(this.player.track.id);
      else if (k === 'q') this.store.set('ui.queueOpen', !this.store.get('ui.queueOpen'));
      else if (k === 'b') this.toggleSimulation();
      else if (e.key === '/') {
        e.preventDefault();
        this.topbar.focusSearch();
      } else if (e.key === '?') this.showShortcuts();
    });
  }

  toggleSimulation() {
    const on = !this.store.get('engine.simulation');
    this.store.set('engine.simulation', on);
    toast(on ? 'Simulation ON — hearing the virtual room' : 'Simulation BYPASSED — direct source (level-matched)');
  }

  showShortcuts() {
    const rows = [
      ['Space', 'Play / pause'],
      ['← / →', 'Seek 5 s'],
      ['Shift + ← / →', 'Previous / next track'],
      ['↑ / ↓', 'Volume'],
      ['M', 'Mute'],
      ['S', 'Shuffle'],
      ['R', 'Repeat mode'],
      ['L', 'Like current track'],
      ['Q', 'Toggle side panel'],
      ['B', 'A/B: bypass simulation'],
      ['/ or Ctrl+F', 'Search'],
      ['Ctrl+O', 'Import music folder'],
      ['?', 'This help'],
    ];
    modal((close) =>
      h('div', h('h2', 'Keyboard shortcuts'), h('div.info-grid', rows.map(([k, v]) => [h('div', h('span.kbd', k)), h('div', v)])), h('div.modal-actions', h('button.btn.primary', { onClick: () => close() }, 'Got it'))),
    );
  }

  resetSettings() {
    const fresh = defaultState();
    this.store.replace(fresh);
    this.scheduleEngine();
  }
}
