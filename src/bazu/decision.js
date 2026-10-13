/**
 * src/bazu/decision.js
 *
 * DECISION layer (pure). Prediction (Rise/Fall call) -> Decision (trade signal / gate)
 * -> Execution (execution.js). No UI, no network.
 */

import { MIN_STRENGTH } from './predict.js?v=5';

export const GATE = Object.freeze({ OK: 'tradable', WEAK: 'weak signal', NO_QUOTE: 'awaiting Deriv quote', NO_DATA: 'waiting for data' });

/** Build a trade signal from a prediction and the quote Deriv gave. Tradable when strength >= MIN_STRENGTH. */
export function buildTradeSignal({ symbol, prediction, duration, quote, now = Date.now() }) {
  if (!prediction) return { gate: GATE.NO_DATA, market: symbol };
  const up = prediction.direction > 0;
  const base = {
    market: symbol, direction: up ? 'Rise' : 'Fall', contractType: up ? 'CALL' : 'PUT', duration,
    strength: prediction.strength, agree: up ? prediction.up : prediction.down, total: prediction.total,
    drivers: prediction.drivers, proxy: prediction.proxy, quote, at: now,
  };
  if (!quote || !(quote.ask > 0) || !(quote.payout > 0)) return { ...base, gate: GATE.NO_QUOTE };
  return { ...base, gate: prediction.strength >= MIN_STRENGTH ? GATE.OK : GATE.WEAK };
}

/** Whether a mode may act on a signal. Manual is never gated. */
export function modeMayAct(mode, signal) {
  if (mode === 'manual') return true;
  return !!signal && signal.gate === GATE.OK;
}
