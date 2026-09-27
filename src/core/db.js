// Promise-based IndexedDB wrapper with an in-memory fallback (private
// browsing modes / environments without IndexedDB).

const DB_NAME = 'audiospace';
const DB_VERSION = 1;

export const STORES = {
  tracks: { keyPath: 'id' },
  files: { keyPath: 'id' },
  dirs: { keyPath: 'id' },
  artwork: { keyPath: 'id' },
  waveforms: { keyPath: 'id' },
  playlists: { keyPath: 'id' },
  likes: { keyPath: 'id' },
  kv: { keyPath: 'key' },
};

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

class IdbDatabase {
  constructor(idb) {
    this.idb = idb;
    this.persistent = true;
  }

  _store(name, mode = 'readonly') {
    return this.idb.transaction(name, mode).objectStore(name);
  }

  get(store, key) {
    return req(this._store(store).get(key));
  }

  getAll(store) {
    return req(this._store(store).getAll());
  }

  getAllKeys(store) {
    return req(this._store(store).getAllKeys());
  }

  count(store) {
    return req(this._store(store).count());
  }

  put(store, value) {
    return req(this._store(store, 'readwrite').put(value));
  }

  delete(store, key) {
    return req(this._store(store, 'readwrite').delete(key));
  }

  clear(store) {
    return req(this._store(store, 'readwrite').clear());
  }

  /** Put many values in a single transaction. */
  putMany(store, values) {
    if (!values.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const v of values) os.put(v);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  deleteMany(store, keys) {
    if (!keys.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const k of keys) os.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  close() {
    this.idb.close();
  }
}

class MemoryDatabase {
  constructor() {
    this.data = Object.fromEntries(Object.keys(STORES).map((k) => [k, new Map()]));
    this.persistent = false;
  }

  _key(store, value) {
    return value[STORES[store].keyPath];
  }

  async get(store, key) {
    return this.data[store].get(key);
  }

  async getAll(store) {
    return [...this.data[store].values()];
  }

  async getAllKeys(store) {
    return [...this.data[store].keys()];
  }

  async count(store) {
    return this.data[store].size;
  }

  async put(store, value) {
    this.data[store].set(this._key(store, value), value);
  }

  async delete(store, key) {
    this.data[store].delete(key);
  }

  async clear(store) {
    this.data[store].clear();
  }

  async putMany(store, values) {
    for (const v of values) this.data[store].set(this._key(store, v), v);
  }

  async deleteMany(store, keys) {
    for (const k of keys) this.data[store].delete(k);
  }

  close() {}
}

export async function openDatabase() {
  if (typeof indexedDB === 'undefined') return new MemoryDatabase();
  try {
    const idb = await new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const [name, opts] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
    idb.onversionchange = () => idb.close();
    return new IdbDatabase(idb);
  } catch (err) {
    console.warn('[db] IndexedDB unavailable, using memory store', err);
    return new MemoryDatabase();
  }
}

export { MemoryDatabase };
