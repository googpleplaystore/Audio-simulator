// Interactive waveform seek bar. Peaks are pre-rendered into two offscreen
// layers (played / unplayed) so each animation frame is just two blits.

import { h } from '../dom.js';
import { fitCanvas, onFrame } from '../../viz/canvas.js';
import { formatTime, } from '../../util/format.js';
import { clamp } from '../../util/math.js';

export function createWaveformSeek(app) {
  const canvas = h('canvas.wave-canvas', { role: 'slider', 'aria-label': 'Seek', tabindex: 0 });
  const tip = h('div.wave-tip', { hidden: true });
  const el = h('div.wave-seek', canvas, tip);
  let peaks = null;
  let layers = null;
  let hoverX = -1;
  let dragging = false;
  let dragT = 0;
  let lastKey = '';
  let loadingPhase = 0;

  const buildLayers = (w, hh, dpr) => {
    const mk = (color) => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      const barW = 2;
      const gap = 1;
      const n = Math.floor(w / (barW + gap));
      let max = 0;
      for (let i = 0; i < peaks.length; i += 2) max = Math.max(max, peaks[i]);
      max = max || 1;
      g.fillStyle = color;
      const mid = hh / 2;
      for (let i = 0; i < n; i++) {
        const b0 = Math.floor((i / n) * (peaks.length / 2));
        const b1 = Math.max(b0 + 1, Math.floor(((i + 1) / n) * (peaks.length / 2)));
        let pk = 0;
        let rms = 0;
        for (let b = b0; b < b1; b++) {
          pk = Math.max(pk, peaks[b * 2]);
          rms = Math.max(rms, peaks[b * 2 + 1]);
        }
        const v = Math.pow(pk / max, 0.8);
        const hgt = Math.max(1.5, v * (hh - 4));
        const x = i * (barW + gap);
        g.globalAlpha = 0.55 + 0.45 * Math.min(1, (rms / max) * 2.5);
        g.fillRect(x, mid - hgt / 2, barW, hgt);
      }
      return c;
    };
    const grad = (() => {
      const c = document.createElement('canvas').getContext('2d');
      const gr = c.createLinearGradient(0, 0, w, 0);
      gr.addColorStop(0, '#8d7dff');
      gr.addColorStop(1, '#36e2cf');
      return gr;
    })();
    return { played: mk(grad), rest: mk('rgba(255,255,255,0.28)') };
  };

  const timeAt = (clientX) => {
    const r = canvas.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * (app.player.duration || 0);
  };

  const draw = () => {
    const { ctx, w, h: hh, dpr, resized } = fitCanvas(canvas);
    const dur = app.player.duration || 0;
    const t = dragging ? dragT : app.player.currentTime;
    const frac = dur ? clamp(t / dur, 0, 1) : 0;
    const key = `${w}x${hh}:${frac.toFixed(4)}:${hoverX}:${!!peaks}:${loadingPhase}`;
    if (key === lastKey && !resized) return;
    lastKey = key;
    ctx.clearRect(0, 0, w, hh);
    if (peaks) {
      if (!layers || resized || layers.w !== w) {
        layers = buildLayers(w, hh, dpr);
        layers.w = w;
      }
      const px = frac * w;
      ctx.drawImage(layers.rest, 0, 0, w, hh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, px, hh);
      ctx.clip();
      ctx.drawImage(layers.played, 0, 0, w, hh);
      ctx.restore();
    } else {
      // Placeholder: slim track with shimmer while the waveform computes.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, hh / 2 - 2, w, 4);
      ctx.fillStyle = '#b1b1c3';
      ctx.fillRect(0, hh / 2 - 2, frac * w, 4);
      if (app.player.track) {
        const sx = ((loadingPhase % 100) / 100) * (w + 80) - 80;
        const g = ctx.createLinearGradient(sx, 0, sx + 80, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(sx, hh / 2 - 8, 80, 16);
      }
    }
    // Playhead
    const px = frac * w;
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(px) - 1, 2, 2, hh - 4);
    if (hoverX >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(Math.round(hoverX), 0, 1, hh);
    }
  };

  const unFrame = onFrame(() => {
    if (!peaks && app.player.track) loadingPhase = (loadingPhase + 1.5) % 100;
    if (el.isConnected && !document.hidden) draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    hoverX = e.clientX - r.left;
    tip.hidden = false;
    tip.textContent = formatTime(timeAt(e.clientX));
    tip.style.left = `${clamp(hoverX, 16, r.width - 16)}px`;
    if (dragging) dragT = timeAt(e.clientX);
  });
  canvas.addEventListener('pointerleave', () => {
    if (!dragging) {
      hoverX = -1;
      tip.hidden = true;
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (!app.player.track) return;
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    dragT = timeAt(e.clientX);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    app.player.seek(timeAt(e.clientX));
    hoverX = -1;
    tip.hidden = true;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') app.player.seekBy(5);
    else if (e.key === 'ArrowLeft') app.player.seekBy(-5);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  let token = 0;
  const loadPeaks = async (track) => {
    const my = ++token;
    peaks = null;
    layers = null;
    if (!track) return;
    try {
      const p = await app.waveforms.get(track.id, () => app.library.getFile(track.id));
      if (my === token) {
        peaks = p;
        layers = null;
        lastKey = '';
      }
    } catch {
      /* no waveform (unsupported codec) — keep placeholder */
    }
  };
  app.player.on('track', (t) => loadPeaks(t));
  if (app.player.track) loadPeaks(app.player.track);

  return { el, destroy: unFrame };
}
