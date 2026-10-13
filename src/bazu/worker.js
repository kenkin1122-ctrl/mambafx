/**
 * src/bazu/worker.js  (module Web Worker)
 * Runs the PREDICTION work off the UI thread: feature computation and the Rise/Fall call.
 */
import { computeFeatures } from './validation.js?v=11';
import { predictDirection } from './predict.js?v=11';

self.onmessage = (ev) => {
  const { type, id } = ev.data;
  try {
    if (type === 'predict') {
      const { prices, epochs } = ev.data;
      const feats = computeFeatures(prices, epochs);
      self.postMessage({ type: 'prediction', id, result: predictDirection(feats, prices), lastEpoch: epochs[epochs.length - 1] });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String(e && e.message || e) });
  }
};
