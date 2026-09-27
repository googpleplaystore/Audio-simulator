// Client for the acoustics worker with latest-wins semantics per job channel
// and a synchronous main-thread fallback when workers are unavailable.
import { computeRoomFilters, computeHeatmap, computeIR } from './compute.js';

const RUNNERS = { ir: computeIR, roomFilters: computeRoomFilters, heatmap: computeHeatmap };

export class AcousticsClient {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.latest = new Map(); // channel -> id
    this.nextId = 1;
    try {
      this.worker = new Worker(new URL('./acoustics.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => {
        console.warn('[acoustics] worker error, falling back to main thread', e.message);
        this._failAll(e);
        this.worker = null;
      };
    } catch (err) {
      console.warn('[acoustics] worker unavailable, using main thread', err);
      this.worker = null;
    }
  }

  _onMessage({ id, ok, result, error }) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error));
  }

  _failAll(err) {
    for (const [id, p] of this.pending) {
      // Re-run on main thread.
      Promise.resolve()
        .then(() => RUNNERS[p.type](p.job))
        .then(p.resolve, p.reject);
      this.pending.delete(id);
    }
    void err;
  }

  /**
   * Run a job. If `channel` is given, a newer job on the same channel makes the
   * older result resolve to null (stale), so callers can simply ignore it.
   */
  run(type, job, channel = null) {
    const id = this.nextId++;
    if (channel) this.latest.set(channel, id);
    const guard = (res) => (channel && this.latest.get(channel) !== id ? null : res);
    if (!this.worker) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(guard(RUNNERS[type](job)));
          } catch (err) {
            reject(err);
          }
        }, 0);
      });
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(guard(r)), reject, type, job });
      this.worker.postMessage({ id, type, job });
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
