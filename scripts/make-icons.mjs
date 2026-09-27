#!/usr/bin/env node
// Render assets/icon.svg into the desktop packaging icons (development-time
// tool; the results are committed so packaging needs no rasterizer):
//   packaging/icons/audiospace.ico       Windows exe/installer/shortcut icon
//   packaging/icons/audiospace-<n>.png   Linux hicolor icons
// Requires Playwright's Chromium (like the E2E suite).
import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'packaging', 'icons');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  }
}

/** Render the SVG at `size`: returns {png: Buffer, rgba: Uint8Array}. */
async function render(page, svg, size) {
  const res = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, size, size);
      const rgba = Array.from(g.getImageData(0, 0, size, size).data);
      return { png: c.toDataURL('image/png').split(',')[1], rgba };
    },
    { svg, size },
  );
  return { png: Buffer.from(res.png, 'base64'), rgba: Uint8Array.from(res.rgba) };
}

/** 32-bit BGRA DIB (bottom-up, with an all-zero AND mask) for small ICO entries. */
function dib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

const svg = await readFile(join(ROOT, 'assets', 'icon.svg'), 'utf8');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await mkdir(OUT, { recursive: true });
const entries = [];
for (const size of ICO_SIZES) {
  const { png, rgba } = await render(page, svg, size);
  // PNG for the 256 px entry (Vista+ format), classic DIBs below for NSIS/old shells.
  entries.push({ size, data: size >= 256 ? png : dib(rgba, size) });
}
await writeFile(join(OUT, 'audiospace.ico'), ico(entries));
for (const size of PNG_SIZES) {
  const { png } = await render(page, svg, size);
  await writeFile(join(OUT, `audiospace-${size}.png`), png);
}
await browser.close();
console.log(`icons written to ${OUT}`);
