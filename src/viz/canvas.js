// Shared canvas utilities: HiDPI sizing and a single requestAnimationFrame
// loop that only runs while something is registered and the tab is visible.

const tasks = new Set();
let rafId = 0;

function frame(t) {
  rafId = 0;
  for (const fn of [...tasks]) {
    try {
      fn(t);
    } catch (err) {
      console.error('[viz] frame task failed', err);
      tasks.delete(fn);
    }
  }
  if (tasks.size) rafId = requestAnimationFrame(frame);
}

/** Register a per-frame callback; returns an unregister function. */
export function onFrame(fn) {
  tasks.add(fn);
  if (!rafId) rafId = requestAnimationFrame(frame);
  return () => tasks.delete(fn);
}

/**
 * Ensure the canvas backing store matches its CSS size × devicePixelRatio.
 * Returns {ctx, w, h, dpr, resized} with w/h in CSS pixels; the context is
 * scaled so drawing uses CSS pixel units.
 */
export function fitCanvas(canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const hh = Math.max(1, Math.round(canvas.clientHeight));
  let resized = false;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    resized = true;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh, dpr, resized };
}

export function isVisible(el) {
  if (!el.isConnected) return false;
  if (document.hidden) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

/** Magma-like colormap LUT (256 × [r,g,b]). */
export function colormap() {
  const stops = [
    [0, [4, 4, 12]],
    [0.13, [28, 16, 68]],
    [0.25, [79, 18, 123]],
    [0.38, [129, 37, 129]],
    [0.5, [181, 54, 122]],
    [0.63, [229, 80, 100]],
    [0.75, [251, 135, 97]],
    [0.88, [254, 194, 135]],
    [1, [252, 253, 191]],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const u = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return lut;
}

export const FONT = '600 10px Inter, system-ui, sans-serif';
export const GRID = 'rgba(255,255,255,0.06)';
export const GRID_STRONG = 'rgba(255,255,255,0.13)';
export const LABEL = 'rgba(255,255,255,0.42)';
