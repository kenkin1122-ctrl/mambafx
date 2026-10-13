/**
 * src/bazu/worker.js  (module Web Worker)
 * Runs heavy PREDICTION work off the UI thread: validation and live-signal evaluation.
 */
import { validateMarket, computeFeatures, signalForSetup, durationKey } from './validation.js';

self.onmessage = (ev) => {
  const { type, id } = ev.data;
  try {
    if (type === 'validate') {
      const { symbol, prices, epochs, duration, nullRuns, permutations } = ev.data;
      const res = validateMarket({ symbol, prices, epochs, duration, nullRuns, permutations });
      self.postMessage({ type: 'validated', id, result: res });
    } else if (type === 'signal') {
      const { prices, epochs, setupIds } = ev.data;
      const feats = computeFeatures(prices, epochs);
      const last = prices.length - 1;
      const out = {};
      for (const sid of setupIds) { const s = signalForSetup(feats, sid); out[sid] = s ? s[last] : 0; }
      self.postMessage({ type: 'signals', id, result: out, lastEpoch: epochs[last] });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, error: String(e && e.message || e) });
  }
};
export { durationKey };
