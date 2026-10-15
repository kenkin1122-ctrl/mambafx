// Shared fixture: finds a tradable signal on a synthetic walk and returns buildRecord inputs.
import { configFor } from '../../src/bazu/config3m.js';
import { predict3m } from '../../src/bazu/predict3m.js';
import { buildTradeSignal } from '../../src/bazu/decision.js';
import { regimeWalk, remoteFrom, T0 } from './support3m.mjs';

export const QUOTE = { ask: 1, payout: 1.95 };

export function findSignal({ seed = 7, symbol = 'R_100', from = 4000, to = 20000, step = 37, overrides = { CONFLUENCE_MODE: 'families' } } = {}) {
  const w = regimeWalk(to + 2000, seed), cfg = configFor(symbol, overrides);
  for (let k = from; k < to; k += step) {
    const prices = w.p.slice(0, k), epochs = w.e.slice(0, k);
    let pred;
    try { pred = predict3m({ symbol, prices, epochs, remote: remoteFrom(w, k, cfg), decisionEpoch: epochs[k - 1], overrides, logPatterns: false }); } catch { continue; }
    if (!pred) continue;
    const sig = buildTradeSignal({ symbol, prediction: pred, duration: pred.durKey || '10t', quote: QUOTE, now: epochs[k - 1] * 1000 });
    if (sig && sig.direction && sig.contractType && sig.decisionTs && sig.votes?.length && sig.strength > 0) {
      return { w, k, cfg, pred, sig, symbol, prices, epochs, remote: remoteFrom(w, k, cfg) };
    }
  }
  return null;
}
export { T0 };
