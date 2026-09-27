// Album art storage: de-duplicated by content hash, down-scaled thumbnails,
// dominant colour extraction, and an LRU cache of object URLs so we never leak
// blob URLs when scrolling through large libraries.

import { hashBytes } from '../util/hash.js';
import { sniffImageMime } from './tags/reader.js';

const THUMB_SIZE = 320;
const FULL_MAX = 1200;

async function toBitmap(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  // Fallback via <img>.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function resize(bitmap, maxSize, type = 'image/jpeg', quality = 0.86) {
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  return { blob: await canvasToBlob(canvas, type, quality), canvas, ctx, width: cw, height: ch };
}

/** Saturation-weighted average colour of a small render of the image. */
function dominantColor(bitmap) {
  const c = makeCanvas(16, 16);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, 16, 16);
  const { data } = ctx.getImageData(0, 0, 16, 16);
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (R + G + B) / 765;
    const w = 0.15 + sat * 1.5 * (1 - Math.abs(lum - 0.5));
    r += R * w;
    g += G * w;
    b += B * w;
    wsum += w;
  }
  if (!wsum) return '#404050';
  const hex = (v) => Math.round(v / wsum).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Store a picture (Uint8Array or Blob) and return its artwork id.
 * Re-uses an existing record when the same bytes were stored before.
 */
export async function storeArtwork(db, picture, knownIds = null) {
  let bytes;
  let mime;
  if (picture instanceof Blob) {
    bytes = new Uint8Array(await picture.arrayBuffer());
    mime = picture.type || sniffImageMime(bytes) || 'image/jpeg';
  } else {
    bytes = picture.data;
    mime = picture.mime || sniffImageMime(bytes) || 'image/jpeg';
  }
  if (!bytes || bytes.length < 16) return null;
  const id = `art_${hashBytes(bytes)}`;
  if (knownIds && knownIds.has(id)) return id;
  const existing = await db.get('artwork', id);
  if (existing) {
    if (knownIds) knownIds.add(id);
    return id;
  }
  const src = new Blob([bytes], { type: mime });
  let bitmap;
  try {
    bitmap = await toBitmap(src);
  } catch {
    return null; // undecodable image
  }
  try {
    const thumb = await resize(bitmap, THUMB_SIZE);
    const full = Math.max(bitmap.width, bitmap.height) > FULL_MAX ? (await resize(bitmap, FULL_MAX, 'image/jpeg', 0.9)).blob : src;
    const color = dominantColor(bitmap);
    await db.put('artwork', { id, thumb: thumb.blob, full, color, width: bitmap.width, height: bitmap.height });
    if (knownIds) knownIds.add(id);
    return id;
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
}

/** LRU cache of object URLs for artwork blobs. */
export class ArtCache {
  constructor(db, limit = 500) {
    this.db = db;
    this.limit = limit;
    this.urls = new Map(); // key -> url
    this.colors = new Map();
    this.pending = new Map();
  }

  /** @returns {Promise<string|null>} */
  async url(artId, size = 'thumb') {
    if (!artId) return null;
    const key = `${artId}:${size}`;
    const hit = this.urls.get(key);
    if (hit) {
      this.urls.delete(key);
      this.urls.set(key, hit);
      return hit;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      const rec = await this.db.get('artwork', artId);
      if (!rec) return null;
      this.colors.set(artId, rec.color);
      const blob = size === 'full' ? rec.full || rec.thumb : rec.thumb;
      const url = URL.createObjectURL(blob);
      this.urls.set(key, url);
      this._evict();
      return url;
    })();
    this.pending.set(key, p);
    try {
      return await p;
    } finally {
      this.pending.delete(key);
    }
  }

  async color(artId) {
    if (!artId) return null;
    if (this.colors.has(artId)) return this.colors.get(artId);
    const rec = await this.db.get('artwork', artId);
    const c = rec ? rec.color : null;
    this.colors.set(artId, c);
    return c;
  }

  _evict() {
    while (this.urls.size > this.limit) {
      const [k, url] = this.urls.entries().next().value;
      this.urls.delete(k);
      URL.revokeObjectURL(url);
    }
  }

  clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.colors.clear();
  }
}
