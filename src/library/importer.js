// Library ingestion: File System Access API directory picking (persistent
// handles), <input webkitdirectory> fallback, drag-and-drop of files/folders,
// concurrent tag parsing with progress + cancellation, and folder-art fallback.

import { Emitter } from '../util/emitter.js';
import { hashString } from '../util/hash.js';
import { parseFilename } from '../util/format.js';
import { parseTags, isAudioFileName, extensionOf } from './tags/index.js';
import { storeArtwork } from './artwork.js';

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const COVER_PRIORITY = [/^cover\./i, /^folder\./i, /^front\./i, /^album\./i, /^albumart/i, /cover/i, /front/i];

export function trackIdFor(path, size, lastModified) {
  return `trk_${hashString(`${path}|${size}|${lastModified}`)}`;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function pickCover(images) {
  for (const re of COVER_PRIORITY) {
    const hit = images.find((e) => re.test(e.name));
    if (hit) return hit;
  }
  return images[0] || null;
}

/** Recursively scan a FileSystemDirectoryHandle. */
export async function scanDirectoryHandle(dir, basePath, onFound, signal) {
  const audio = [];
  const images = [];
  const stack = [{ handle: dir, path: basePath }];
  while (stack.length) {
    if (signal?.aborted) break;
    const { handle, path } = stack.pop();
    try {
      for await (const [name, child] of handle.entries()) {
        if (name.startsWith('.')) continue;
        const childPath = `${path}/${name}`;
        if (child.kind === 'directory') stack.push({ handle: child, path: childPath });
        else if (isAudioFileName(name)) {
          audio.push({ name, path: childPath, dirPath: path, handle: child, kind: 'fs' });
          if (onFound && audio.length % 50 === 0) onFound(audio.length);
        } else if (IMAGE_RE.test(name)) images.push({ name, path: childPath, dirPath: path, handle: child });
      }
    } catch (err) {
      console.warn('[import] cannot read directory', path, err);
    }
  }
  return { audio, images };
}

async function readAllEntries(dirEntry) {
  const reader = dirEntry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
}

async function walkWebkitEntry(entry, path, audio, images) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (isAudioFileName(file.name)) audio.push({ name: file.name, path, dirPath: dirOf(path), file, kind: 'session' });
    else if (IMAGE_RE.test(file.name)) images.push({ name: file.name, path, dirPath: dirOf(path), file });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry)) {
      if (child.name.startsWith('.')) continue;
      await walkWebkitEntry(child, `${path}/${child.name}`, audio, images);
    }
  }
}

export class Importer extends Emitter {
  constructor(library, db) {
    super();
    this.library = library;
    this.db = db;
    this.running = false;
    this.abort = null;
  }

  static get supportsDirectoryPicker() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  cancel() {
    if (this.abort) this.abort.abort();
  }

  /** Open the native folder picker (File System Access API). */
  async pickDirectory() {
    const dir = await window.showDirectoryPicker({ id: 'audiospace-music', mode: 'read' });
    const dirId = await this.library.addDirectory(dir, dir.name);
    this.library.permission = 'granted';
    this.abort = new AbortController();
    this.emit('progress', { phase: 'scan', done: 0, total: 0, current: dir.name });
    const { audio, images } = await scanDirectoryHandle(
      dir,
      dir.name,
      (n) => this.emit('progress', { phase: 'scan', done: n, total: 0, current: `${n} audio files found…` }),
      this.abort.signal,
    );
    for (const a of audio) a.dirId = dirId;
    return this.ingest(audio, images);
  }

  /** Files from <input type=file multiple webkitdirectory>. */
  async importFileList(fileList, { storeBlobs = false } = {}) {
    const audio = [];
    const images = [];
    for (const file of fileList) {
      const path = file.webkitRelativePath || file.name;
      if (isAudioFileName(file.name)) audio.push({ name: file.name, path, dirPath: dirOf(path), file, kind: storeBlobs ? 'blob' : 'session' });
      else if (IMAGE_RE.test(file.name)) images.push({ name: file.name, path, dirPath: dirOf(path), file });
    }
    return this.ingest(audio, images);
  }

  /**
   * Collect a drop synchronously (DataTransfer items expire after the event),
   * then import. Prefers persistent File System Access handles when available.
   */
  importDrop(dataTransfer, { storeBlobs = false } = {}) {
    const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
    const handlePromises = items.map((i) => (typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : null));
    const webkitEntries = items.map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
    const plainFiles = [...(dataTransfer.files || [])];
    return (async () => {
      const handles = await Promise.all(handlePromises);
      const audio = [];
      const images = [];
      this.abort = new AbortController();
      if (handles.some(Boolean)) {
        for (const h of handles) {
          if (!h) continue;
          if (h.kind === 'directory') {
            const dirId = await this.library.addDirectory(h, h.name);
            const res = await scanDirectoryHandle(h, h.name, null, this.abort.signal);
            res.audio.forEach((a) => (a.dirId = dirId));
            audio.push(...res.audio);
            images.push(...res.images);
          } else if (isAudioFileName(h.name)) {
            const file = await h.getFile();
            audio.push({ name: h.name, path: h.name, dirPath: '', file, kind: storeBlobs ? 'blob' : 'session' });
          }
        }
      } else if (webkitEntries.some(Boolean)) {
        for (const e of webkitEntries) if (e) await walkWebkitEntry(e, e.name, audio, images);
        if (storeBlobs) audio.forEach((a) => (a.kind = 'blob'));
      } else {
        for (const file of plainFiles) {
          if (isAudioFileName(file.name)) audio.push({ name: file.name, path: file.name, dirPath: '', file, kind: storeBlobs ? 'blob' : 'session' });
        }
      }
      return this.ingest(audio, images);
    })();
  }

  /**
   * Parse and store entries.
   * entry: {name, path, dirPath, file?|handle?, kind: 'fs'|'session'|'blob'}
   */
  async ingest(entries, images = [], { concurrency = 6 } = {}) {
    if (this.running) throw new Error('An import is already running');
    this.running = true;
    this.abort = this.abort && !this.abort.signal.aborted ? this.abort : new AbortController();
    const signal = this.abort.signal;
    const lib = this.library;
    const total = entries.length;
    const stats = { added: 0, updated: 0, skipped: 0, failed: 0, relinked: 0, total, errors: [] };
    const imagesByDir = new Map();
    for (const img of images) {
      if (!imagesByDir.has(img.dirPath)) imagesByDir.set(img.dirPath, []);
      imagesByDir.get(img.dirPath).push(img);
    }
    const folderArt = new Map(); // dirPath -> Promise<artId|null>
    const getFolderArt = (dirPath) => {
      if (!imagesByDir.has(dirPath)) return Promise.resolve(null);
      if (!folderArt.has(dirPath)) {
        folderArt.set(
          dirPath,
          (async () => {
            const cover = pickCover(imagesByDir.get(dirPath));
            if (!cover) return null;
            try {
              const file = cover.file || (await cover.handle.getFile());
              return await storeArtwork(this.db, file, lib.knownArtIds);
            } catch {
              return null;
            }
          })(),
        );
      }
      return folderArt.get(dirPath);
    };

    let done = 0;
    let batch = [];
    let lastEmit = 0;
    const flush = async () => {
      if (!batch.length) return;
      const b = batch;
      batch = [];
      await lib.addTracks(b);
    };
    const emitProgress = (current, force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 120) return;
      lastEmit = now;
      this.emit('progress', { phase: 'parse', done, total, current, ...stats });
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length && !signal.aborted) {
        const entry = entries[cursor++];
        try {
          const file = entry.file || (await entry.handle.getFile());
          const id = trackIdFor(entry.path, file.size, file.lastModified);
          if (lib.tracks.has(id)) {
            if (entry.kind === 'session') {
              lib.sessionFiles.set(id, file);
              stats.relinked++;
            } else stats.skipped++;
          } else {
            let tags = {};
            try {
              tags = await parseTags(file);
            } catch (err) {
              console.warn('[import] tag parse failed', entry.path, err);
            }
            let artId = null;
            if (tags.picture) {
              try {
                artId = await storeArtwork(this.db, tags.picture, lib.knownArtIds);
              } catch {
                artId = null;
              }
            }
            if (!artId) artId = await getFolderArt(entry.dirPath);
            const fromName = parseFilename(entry.name);
            const dirParts = entry.dirPath.split('/').filter(Boolean);
            const parentDir = dirParts[dirParts.length - 1] || null;
            const grandDir = dirParts.length >= 3 ? dirParts[dirParts.length - 2] : null;
            const track = {
              id,
              title: tags.title || fromName.title,
              artist: tags.artist || fromName.artist || grandDir || 'Unknown Artist',
              albumArtist: tags.albumArtist || null,
              album: tags.album || (dirParts.length > 1 ? parentDir : null) || 'Unknown Album',
              genre: tags.genre || null,
              year: tags.year || null,
              track: tags.track ?? fromName.track ?? null,
              trackTotal: tags.trackTotal || null,
              disc: tags.disc || null,
              discTotal: tags.discTotal || null,
              composer: tags.composer || null,
              bpm: tags.bpm || null,
              lyrics: tags.lyrics || null,
              comment: tags.comment || null,
              duration: Number.isFinite(tags.duration) ? tags.duration : null,
              format: tags.format && tags.format !== 'unknown' ? tags.format : extensionOf(entry.name),
              codec: tags.codec || null,
              sampleRate: tags.sampleRate || null,
              channels: tags.channels || null,
              bitsPerSample: tags.bitsPerSample || null,
              bitrate: tags.bitrate || null,
              replayGain: tags.replayGain || null,
              size: file.size,
              lastModified: file.lastModified,
              name: entry.name,
              path: entry.path,
              dirPath: entry.dirPath,
              artId,
              source: entry.kind,
              addedAt: Date.now(),
            };
            let fileRec = null;
            if (entry.kind === 'fs') fileRec = { id, kind: 'fs', handle: entry.handle, dirId: entry.dirId };
            else if (entry.kind === 'blob') fileRec = { id, kind: 'blob', blob: file };
            else {
              fileRec = { id, kind: 'session' };
              lib.sessionFiles.set(id, file);
            }
            batch.push({ track, file: fileRec });
            stats.added++;
            if (batch.length >= 40) await flush();
          }
        } catch (err) {
          stats.failed++;
          if (stats.errors.length < 20) stats.errors.push(`${entry.path}: ${err.message || err}`);
        }
        done++;
        emitProgress(entry.path);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, entries.length)) }, worker));
      await flush();
    } finally {
      this.running = false;
      stats.cancelled = signal.aborted;
      lib.commit('import');
      emitProgress('', true);
      this.emit('done', stats);
      this.abort = null;
    }
    return stats;
  }
}
