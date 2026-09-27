// Web Worker hosting the heavy acoustics computations so the UI and audio
// thread stay smooth while the user drags speakers around.
import { computeRoomFilters, computeHeatmap, computeIR } from './compute.js';
import { optimizeSubs } from './subopt.js';

self.onmessage = (e) => {
  const { id, type, job } = e.data;
  try {
    if (type === 'ir') {
      const res = computeIR(job);
      self.postMessage(
        { id, ok: true, result: res },
        res.channels.map((c) => c.buffer),
      );
    } else if (type === 'roomFilters') {
      self.postMessage({ id, ok: true, result: computeRoomFilters(job) });
    } else if (type === 'subOptimize') {
      self.postMessage({ id, ok: true, result: optimizeSubs(job) });
    } else if (type === 'heatmap') {
      const res = computeHeatmap(job);
      self.postMessage({ id, ok: true, result: res }, [res.data.buffer]);
    } else {
      throw new Error(`Unknown job type ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack ? err.stack : err) });
  }
};
