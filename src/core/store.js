// Small reactive state store with path-based updates, batched change
// notifications and debounced persistence to localStorage.

import { Emitter } from '../util/emitter.js';

function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

const related = (a, b) => a === b || !a || !b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

export class Store extends Emitter {
  constructor(initial, { persistKey = null, persistFilter = null } = {}) {
    super();
    this.state = initial;
    this.persistKey = persistKey;
    this.persistFilter = persistFilter;
    this.dirty = new Set();
    this.scheduled = false;
    this.subs = new Set();
    this.saveTimer = null;
  }

  get(path) {
    return getPath(this.state, path);
  }

  set(path, value) {
    if (getPath(this.state, path) === value && (typeof value !== 'object' || value === null)) return;
    setPath(this.state, path, value);
    this._touch(path);
  }

  /** Shallow-merge an object into the value at path. */
  patch(path, obj) {
    const cur = getPath(this.state, path);
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) Object.assign(cur, obj);
    else setPath(this.state, path, { ...obj });
    for (const k of Object.keys(obj)) this._touch(`${path}.${k}`);
  }

  /** Update an item in an array of {id} objects. */
  updateItem(listPath, id, patch) {
    const list = getPath(this.state, listPath);
    if (!Array.isArray(list)) return;
    const item = list.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    this._touch(listPath);
  }

  /** Mark a path changed after mutating it in place. */
  touch(path) {
    this._touch(path);
  }

  replace(state) {
    this.state = state;
    this._touch('');
  }

  _touch(path) {
    this.dirty.add(path);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this._flush());
    }
    this._scheduleSave();
  }

  _flush() {
    this.scheduled = false;
    const changed = this.dirty;
    this.dirty = new Set();
    for (const sub of [...this.subs]) {
      if (!sub.paths) {
        sub.fn(changed);
        continue;
      }
      let hit = false;
      for (const c of changed) {
        for (const p of sub.paths) {
          if (related(c, p)) {
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        try {
          sub.fn(changed);
        } catch (err) {
          console.error('[store] subscriber failed', err);
        }
      }
    }
    this.emit('change', changed);
  }

  /**
   * Subscribe to changes under any of `paths` (array or string). Pass null for all.
   * @returns {() => void} unsubscribe
   */
  subscribe(paths, fn) {
    const sub = { paths: paths == null ? null : Array.isArray(paths) ? paths : [paths], fn };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  _scheduleSave() {
    if (!this.persistKey) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  save() {
    if (!this.persistKey) return;
    try {
      const data = this.persistFilter ? this.persistFilter(this.state) : this.state;
      localStorage.setItem(this.persistKey, JSON.stringify(data));
    } catch (err) {
      console.warn('[store] save failed', err);
    }
  }

  static load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}

export { getPath, setPath };
