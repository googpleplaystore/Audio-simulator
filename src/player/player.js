// Transport: two <audio> decks routed into the Web Audio engine through
// MediaElementAudioSourceNodes (created exactly once per element), enabling
// crossfades, gapless pre-loading, ReplayGain, Media Session controls and
// robust error recovery. Object URLs are revoked whenever a deck unloads.

import { Emitter } from '../util/emitter.js';
import { clamp, dbToGain } from '../util/math.js';

class Deck {
  constructor(ctx, output, id) {
    this.id = id;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this.audio.setAttribute('data-deck', id);
    this.source = ctx.createMediaElementSource(this.audio);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain).connect(output);
    this.url = null;
    this.trackId = null;
    this.ready = false;
  }

  async load(blob, trackId) {
    this.unload();
    this.url = URL.createObjectURL(blob);
    this.trackId = trackId;
    this.ready = false;
    this.audio.src = this.url;
    this.audio.load();
  }

  unload() {
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.trackId = null;
    this.ready = false;
  }
}

export class Player extends Emitter {
  /**
   * @param {object} o
   * @param {AudioContext} o.ctx
   * @param {AudioNode} o.output  engine input node
   * @param {import('../library/library.js').Library} o.library
   * @param {import('./queue.js').Queue} o.queue
   * @param {import('../core/store.js').Store} o.store
   * @param {() => Promise<void>} o.unlock resumes the AudioContext (user gesture)
   */
  constructor({ ctx, output, library, queue, store, unlock }) {
    super();
    this.ctx = ctx;
    this.library = library;
    this.queue = queue;
    this.store = store;
    this.unlock = unlock;
    this.decks = [new Deck(ctx, output, 'A'), new Deck(ctx, output, 'B')];
    this.active = 0;
    this.state = 'idle'; // idle | loading | playing | paused | error
    this.track = null;
    this.failures = 0;
    this.loadToken = 0;
    this.preloaded = null; // {trackId, deckIndex}
    this.crossfading = false;
    for (const [i, deck] of this.decks.entries()) this._wire(deck, i);
    this._setupMediaSession();
    this._tick = this._tick.bind(this);
    this.tickTimer = setInterval(this._tick, 250);
  }

  get deck() {
    return this.decks[this.active];
  }

  get idleDeck() {
    return this.decks[1 - this.active];
  }

  get currentTime() {
    return this.deck.audio.currentTime || 0;
  }

  get duration() {
    const d = this.deck.audio.duration;
    return Number.isFinite(d) ? d : this.track?.duration || 0;
  }

  get playing() {
    return this.state === 'playing';
  }

  _wire(deck, index) {
    const a = deck.audio;
    a.addEventListener('ended', () => {
      if (index !== this.active || this.crossfading) return;
      this._onEnded();
    });
    a.addEventListener('error', () => {
      if (!deck.url) return;
      if (index !== this.active) {
        if (this.preloaded && this.preloaded.deckIndex === index) this.preloaded = null;
        return;
      }
      const code = a.error ? a.error.code : 0;
      const msg = code === 4 ? 'This file format or codec is not supported by your browser.' : 'The audio file could not be decoded.';
      this._fail(new Error(msg));
    });
    a.addEventListener('playing', () => {
      if (index === this.active) this._setState('playing');
    });
    a.addEventListener('pause', () => {
      if (index === this.active && this.state === 'playing' && !a.ended) this._setState('paused');
    });
    a.addEventListener('waiting', () => {
      if (index === this.active) this.emit('buffering', true);
    });
    a.addEventListener('canplay', () => {
      deck.ready = true;
      if (index === this.active) this.emit('buffering', false);
    });
    a.addEventListener('loadedmetadata', () => {
      if (index === this.active) {
        this.emit('duration', this.duration);
        // Correct stored durations that were estimated from headers.
        if (this.track && Number.isFinite(a.duration) && Math.abs((this.track.duration || 0) - a.duration) > 1.5) {
          this.library.updateTrack(this.track.id, { duration: a.duration });
        }
      }
    });
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none';
  }

  _fail(err) {
    this._setState('error');
    this.emit('error', err, this.track);
    this.failures++;
    const limit = Math.max(3, Math.min(this.queue.order.length, 25));
    if (this.failures < limit && this.queue.peekNext() && err.code !== 'PERMISSION') {
      setTimeout(() => {
        if (this.state === 'error') this.next(true);
      }, 1200);
    }
  }

  trackGainDb(track) {
    const mode = this.store.get('player.replayGain');
    const pre = this.store.get('player.replayGainPreampDb') || 0;
    if (!track || !track.replayGain || mode === 'off') return 0;
    const rg = track.replayGain;
    const g = mode === 'album' ? rg.albumGain ?? rg.trackGain : rg.trackGain ?? rg.albumGain;
    if (g == null) return 0;
    let db = g + pre;
    const peak = mode === 'album' ? rg.albumPeak ?? rg.trackPeak : rg.trackPeak ?? rg.albumPeak;
    if (peak && peak > 0) db = Math.min(db, -20 * Math.log10(peak)); // prevent clipping
    return clamp(db, -24, 12);
  }

  /** Load a track into the active deck. */
  async load(trackId, { autoplay = true, startAt = 0 } = {}) {
    const track = this.library.get(trackId);
    if (!track) throw new Error('Track not found');
    const token = ++this.loadToken;
    this.track = track;
    this.crossfading = false;
    this._setState('loading');
    this.emit('track', track);
    this._updateMediaSession(track);
    // Reuse a pre-loaded idle deck when possible (gapless).
    let deck;
    if (this.preloaded && this.preloaded.trackId === trackId && !this.preloaded.pending) {
      const prevActive = this.deck;
      this.active = this.preloaded.deckIndex;
      this.preloaded = null;
      deck = this.deck;
      prevActive.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      prevActive.unload();
    } else {
      this.preloaded = null;
      this.idleDeck.unload();
      deck = this.deck;
      let blob;
      try {
        blob = await this.library.getFile(trackId);
      } catch (err) {
        if (token === this.loadToken) this._fail(err);
        return;
      }
      if (token !== this.loadToken) return;
      await deck.load(blob, trackId);
    }
    const g = dbToGain(this.trackGainDb(track));
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(g, this.ctx.currentTime);
    deck.audio.playbackRate = this.store.get('player.rate') || 1;
    if (startAt > 0) {
      const seekWhenReady = () => {
        try {
          deck.audio.currentTime = startAt;
        } catch {
          /* ignore */
        }
      };
      if (deck.audio.readyState >= 1) seekWhenReady();
      else deck.audio.addEventListener('loadedmetadata', seekWhenReady, { once: true });
    }
    if (autoplay) await this.play();
    else this._setState('paused');
  }

  /** Start playing a context (album/playlist/etc.) at index. */
  async playContext(trackIds, index = 0, context = null) {
    if (!trackIds.length) return;
    const id = this.queue.setContext(trackIds, index, context);
    this.failures = 0;
    await this.load(id);
  }

  async play() {
    if (this.unlock) await this.unlock();
    if (!this.deck.url) {
      const id = this.queue.currentId || this.queue.next();
      if (id) return this.load(id);
      return;
    }
    try {
      await this.deck.audio.play();
      this.failures = 0;
      this._setState('playing');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (err && err.name === 'NotAllowedError') {
        this._setState('paused');
        this.emit('needs-gesture');
        return;
      }
      this._fail(err);
    }
  }

  pause() {
    this.deck.audio.pause();
    if (this.crossfading) this.idleDeck.audio.pause();
    this._setState('paused');
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  seek(t) {
    const a = this.deck.audio;
    if (!Number.isFinite(t)) return;
    const d = this.duration;
    a.currentTime = clamp(t, 0, d ? d - 0.05 : t);
    this.preloaded = null;
    this.emit('seek', a.currentTime);
  }

  seekBy(dt) {
    this.seek(this.currentTime + dt);
  }

  async next(auto = false) {
    const id = this.queue.next(auto);
    if (!id) {
      this.pause();
      this.seek(0);
      this.emit('ended-queue');
      return;
    }
    await this.load(id);
  }

  async prev() {
    if (this.currentTime > 3) {
      this.seek(0);
      return;
    }
    const id = this.queue.prev();
    if (id) await this.load(id);
    else this.seek(0);
  }

  async jumpTo(section, i) {
    const id = this.queue.jumpTo(section, i);
    if (id) await this.load(id);
  }

  setRate(rate) {
    const r = clamp(rate, 0.5, 2);
    this.store.set('player.rate', r);
    for (const d of this.decks) d.audio.playbackRate = r;
  }

  async _onEnded() {
    if (this.track) this.library.recordPlay(this.track.id);
    await this.next(true);
  }

  /** Periodic housekeeping: gapless pre-load and crossfade scheduling. */
  async _tick() {
    if (this.state !== 'playing' || this.crossfading) return;
    const remain = this.duration - this.currentTime;
    if (!Number.isFinite(remain) || this.duration <= 0) return;
    const xfade = this.store.get('player.crossfade') || 0;
    const nextId = this.queue.peekNext();
    if (!nextId) return;
    if (xfade > 0 && remain <= xfade + 0.1 && this.queue.repeat !== 'one' && this.duration > xfade * 2.5) {
      this._crossfadeTo(nextId, xfade);
      return;
    }
    if (remain < 12 && (!this.preloaded || this.preloaded.trackId !== nextId) && this.store.get('player.gapless') !== false) {
      this._preload(nextId);
    }
  }

  async _preload(trackId) {
    const idx = 1 - this.active;
    this.preloaded = { trackId, deckIndex: idx, pending: true };
    try {
      const blob = await this.library.getFile(trackId);
      if (!this.preloaded || this.preloaded.trackId !== trackId) return;
      await this.decks[idx].load(blob, trackId);
      this.decks[idx].gain.gain.value = 0;
      this.preloaded.pending = false;
    } catch {
      this.preloaded = null;
    }
  }

  async _crossfadeTo(nextId, seconds) {
    this.crossfading = true;
    const from = this.deck;
    const toIndex = 1 - this.active;
    const to = this.decks[toIndex];
    try {
      if (!(this.preloaded && this.preloaded.trackId === nextId && !this.preloaded.pending)) {
        const blob = await this.library.getFile(nextId);
        await to.load(blob, nextId);
      }
      this.preloaded = null;
      const track = this.library.get(nextId);
      const target = dbToGain(this.trackGainDb(track));
      const now = this.ctx.currentTime;
      const n = 32;
      const up = new Float32Array(n);
      const down = new Float32Array(n);
      const startGain = from.gain.gain.value;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        up[i] = Math.sin((x * Math.PI) / 2) * target;
        down[i] = Math.cos((x * Math.PI) / 2) * startGain;
      }
      to.gain.gain.cancelScheduledValues(now);
      from.gain.gain.cancelScheduledValues(now);
      to.gain.gain.setValueCurveAtTime(up, now, seconds);
      from.gain.gain.setValueCurveAtTime(down, now, seconds);
      to.audio.playbackRate = this.store.get('player.rate') || 1;
      await to.audio.play();
      // Advance queue/model now; the old deck finishes fading out.
      if (this.track) this.library.recordPlay(this.track.id);
      this.queue.next(true);
      this.active = toIndex;
      this.track = track;
      this.emit('track', track);
      this._updateMediaSession(track);
      setTimeout(() => {
        from.unload();
        this.crossfading = false;
      }, seconds * 1000 + 100);
    } catch (err) {
      this.crossfading = false;
      console.warn('[player] crossfade failed', err);
    }
  }

  // --------------------------------------------------------- Media Session

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekbackward', (d) => this.seekBy(-(d.seekOffset || 10)));
    set('seekforward', (d) => this.seekBy(d.seekOffset || 10));
    set('seekto', (d) => this.seek(d.seekTime));
    set('stop', () => {
      this.pause();
      this.seek(0);
    });
  }

  async _updateMediaSession(track) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const artwork = [];
    if (track.artId && this.library.art) {
      const url = await this.library.art.url(track.artId, 'full');
      if (url) artwork.push({ src: url, sizes: '512x512', type: 'image/jpeg' });
    }
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork });
  }

  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.duration;
    if (!d || !Number.isFinite(d)) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(this.currentTime, d), playbackRate: this.deck.audio.playbackRate || 1 });
    } catch {
      /* ignore */
    }
  }

  dispose() {
    clearInterval(this.tickTimer);
    for (const d of this.decks) d.unload();
    this.removeAll();
  }
}
