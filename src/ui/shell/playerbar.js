// Persistent bottom playback bar.

import { h, icon, clear } from '../dom.js';
import { enc } from '../router.js';
import { artEl } from '../components/lists.js';
import { slider } from '../components/controls.js';
import { createWaveformSeek } from './waveformSeek.js';
import { onFrame, fitCanvas } from '../../viz/canvas.js';
import { formatTime } from '../../util/format.js';
import { albumKeyOf, artistKeyOf } from '../../library/library.js';

export function createPlayerBar(app) {
  const artBox = h('a.pb-art', { href: '#/now-playing', 'aria-label': 'Open Now Playing' });
  const title = h('a.pb-title.ellipsis');
  const artist = h('a.pb-artist.ellipsis');
  const likeBtn = h('button.icon-btn.small', { 'aria-label': 'Like' }, icon('heart', 18));
  const left = h('div.pb-left', artBox, h('div.pb-meta', title, artist), likeBtn);

  const shuffleBtn = h('button.icon-btn', { 'aria-label': 'Shuffle', 'data-tip': 'Shuffle (S)' }, icon('shuffle', 18));
  const prevBtn = h('button.icon-btn', { 'aria-label': 'Previous', 'data-tip': 'Previous' }, icon('prev', 18));
  const playBtn = h('button.play-btn', { 'aria-label': 'Play' }, icon('play', 20));
  const nextBtn = h('button.icon-btn', { 'aria-label': 'Next', 'data-tip': 'Next' }, icon('next', 18));
  const repeatBtn = h('button.icon-btn', { 'aria-label': 'Repeat', 'data-tip': 'Repeat (R)' }, icon('repeat', 18));
  const tNow = h('span.pb-time.mono', '0:00');
  const tDur = h('span.pb-time.mono', '0:00');
  const wave = createWaveformSeek(app);
  const center = h('div.pb-center', h('div.pb-controls', shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn), h('div.pb-progress', tNow, wave.el, tDur));

  const meter = h('canvas.pb-meter', { 'aria-hidden': 'true' });
  const muteBtn = h('button.icon-btn.small', { 'aria-label': 'Mute', 'data-tip': 'Mute (M)' }, icon('volume', 18));
  const vol = slider({
    min: 0,
    max: 1,
    step: 0.01,
    value: app.store.get('player.volume') ?? 0.8,
    reset: 0.8,
    label: 'Volume',
    wheel: true,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => {
      app.store.set('player.volume', v);
      if (app.store.get('player.muted')) app.store.set('player.muted', false);
    },
  });
  vol.classList.add('pb-volume');
  const queueBtn = h('button.icon-btn.small', { 'aria-label': 'Queue', 'data-tip': 'Up Next (Q)', onClick: () => app.store.set('ui.queueOpen', !app.store.get('ui.queueOpen')) }, icon('queue', 18));
  const roomBtn = h('a.icon-btn.small.hide-mobile', { href: '#/studio/room', 'aria-label': 'Room simulator', 'data-tip': 'Room Simulator' }, icon('room', 18));
  const vizBtn = h('a.icon-btn.small.hide-mobile', { href: '#/studio/analyzers', 'aria-label': 'Analyzers', 'data-tip': 'Analyzers' }, icon('spectrum', 18));
  const right = h('div.pb-right', h('div.hide-mobile', meter), vizBtn, roomBtn, queueBtn, muteBtn, h('div.hide-mobile.pb-vol-wrap', vol));

  const el = h('footer.playerbar', { 'aria-label': 'Player' }, left, center, right);

  // ---- behaviour
  playBtn.addEventListener('click', () => app.player.toggle());
  prevBtn.addEventListener('click', () => app.player.prev());
  nextBtn.addEventListener('click', () => app.player.next());
  shuffleBtn.addEventListener('click', () => app.queue.setShuffle(!app.queue.shuffle));
  repeatBtn.addEventListener('click', () => app.queue.cycleRepeat());
  muteBtn.addEventListener('click', () => app.store.set('player.muted', !app.store.get('player.muted')));
  likeBtn.addEventListener('click', () => app.player.track && app.toggleLike(app.player.track.id));

  const renderTrack = (t) => {
    clear(artBox);
    artBox.appendChild(artEl(app.art, t?.artId, { lazy: false, seed: t?.album || '' }));
    title.textContent = t ? t.title : 'Nothing playing';
    artist.textContent = t ? t.artist : 'Import music or add the demo tracks to begin';
    if (t) {
      title.href = `#/album/${enc(t._albumKey || albumKeyOf(t))}`;
      artist.href = `#/artist/${enc(artistKeyOf(t))}`;
    } else {
      title.removeAttribute('href');
      artist.removeAttribute('href');
    }
    renderLike();
    tDur.textContent = formatTime(t?.duration || 0);
  };
  const renderLike = () => {
    const t = app.player.track;
    const liked = t && app.library.isLiked(t.id);
    likeBtn.innerHTML = '';
    likeBtn.appendChild(icon(liked ? 'heart-fill' : 'heart', 18));
    likeBtn.classList.toggle('liked', !!liked);
    likeBtn.hidden = !t;
  };
  const renderState = (s) => {
    playBtn.innerHTML = '';
    const playing = s === 'playing';
    playBtn.appendChild(icon(s === 'loading' ? 'refresh' : playing ? 'pause' : 'play', 20));
    playBtn.classList.toggle('loading', s === 'loading');
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  const renderQueueModes = () => {
    shuffleBtn.classList.toggle('on', app.queue.shuffle);
    repeatBtn.classList.toggle('on', app.queue.repeat !== 'off');
    repeatBtn.innerHTML = '';
    repeatBtn.appendChild(icon(app.queue.repeat === 'one' ? 'repeat-one' : 'repeat', 18));
  };
  const renderVolume = () => {
    const muted = app.store.get('player.muted');
    const v = app.store.get('player.volume') ?? 0.8;
    muteBtn.innerHTML = '';
    muteBtn.appendChild(icon(muted || v === 0 ? 'mute' : v < 0.45 ? 'volume-low' : 'volume', 18));
    vol.setValue(muted ? 0 : v);
  };
  app.player.on('track', renderTrack);
  app.player.on('state', renderState);
  app.player.on('duration', (d) => (tDur.textContent = formatTime(d)));
  app.library.on('likes', renderLike);
  app.queue.on('change', renderQueueModes);
  app.store.subscribe(['player.volume', 'player.muted'], renderVolume);

  // Time + mini stereo level meter
  const buf = new Float32Array(2048);
  const lv = [0, 0];
  const pk = [0, 0];
  let lastPos = 0;
  onFrame(() => {
    if (document.hidden) return;
    tNow.textContent = formatTime(app.player.currentTime);
    const now = performance.now();
    if (now - lastPos > 1000) {
      lastPos = now;
      app.player.updatePositionState();
    }
    if (!meter.isConnected || !meter.clientWidth) return;
    const { ctx, w, h: hh } = fitCanvas(meter);
    ctx.clearRect(0, 0, w, hh);
    const taps = app.engine.taps;
    if (!taps) return;
    [taps.L, taps.R].forEach((a, i) => {
      a.getFloatTimeDomainData(buf);
      let p = 0;
      let s = 0;
      for (let j = 0; j < buf.length; j++) {
        const v = Math.abs(buf[j]);
        if (v > p) p = v;
        s += v * v;
      }
      const rms = Math.sqrt(s / buf.length);
      const db = rms > 1e-6 ? 20 * Math.log10(rms) : -90;
      const x = Math.max(0, Math.min(1, (db + 54) / 54));
      lv[i] = x > lv[i] ? x : lv[i] * 0.9 + x * 0.1;
      const pdb = p > 1e-6 ? 20 * Math.log10(p) : -90;
      const px = Math.max(0, Math.min(1, (pdb + 54) / 54));
      pk[i] = Math.max(px, pk[i] - 0.006);
      const y = 2 + i * (hh / 2);
      const bh = hh / 2 - 4;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, y, w, bh);
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#36e2cf');
      g.addColorStop(0.75, '#8d7dff');
      g.addColorStop(0.95, '#ff5470');
      ctx.fillStyle = g;
      ctx.fillRect(0, y, lv[i] * w, bh);
      ctx.fillStyle = pk[i] > 0.97 ? '#ff5470' : '#fff';
      ctx.fillRect(pk[i] * w - 1, y, 2, bh);
    });
  });

  renderTrack(app.player.track);
  renderState(app.player.state);
  renderQueueModes();
  renderVolume();
  return { el };
}
