/**
 * src/bazu/decision.js
 *
 * DECISION layer (pure). Prediction (validated setups + live signal) -> Decision (trade signal / gate)
 * -> Execution (execution.js). No UI, no network.
 */

import { breakEven } from './stats.js';

export const GATE = Object.freeze({ OK: 'tradable', NO_EDGE: 'No validated edge', BELOW_BE: 'edge below break-even', NO_QUOTE: 'awaiting Deriv quote', STALE: 'validation stale' });

/** Setups for a market+duration that are Published (the only tradable stage). */
export function publishedSetups(validation) {
  return (validation?.setups || []).filter((s) => s.stage === 'Published');
}

/**
 * Build a trade signal from a firing, published setup and the quote Deriv actually gave.
 * Tradable only when Wilson LCB of the out-of-sample hit rate > ask/payout.
 */
export function buildTradeSignal({ symbol, setup, direction, quote, now = Date.now() }) {
  if (!setup || setup.stage !== 'Published') return { gate: GATE.NO_EDGE };
  if (!quote || !(quote.ask > 0) || !(quote.payout > 0)) return { gate: GATE.NO_QUOTE, market: symbol };
  const be = breakEven(quote.ask, quote.payout);
  const lcb = setup.oos.lo;
  const margin = lcb - be;
  return {
    market: symbol, direction: direction > 0 ? 'Rise' : 'Fall', contractType: direction > 0 ? 'CALL' : 'PUT',
    duration: setup.duration, probability: setup.probability, oosHitRate: setup.oos.p, oosN: setup.oos.n,
    oosLcb: lcb, evidence: [setup.id], breakEven: be, margin, proxy: !!setup.proxy,
    quote, at: now, gate: margin > 0 ? GATE.OK : GATE.BELOW_BE,
  };
}

/** Pick the best firing signal for a market (highest margin over break-even). */
export function bestSignal(candidates) {
  const ok = candidates.filter((c) => c.gate === GATE.OK).sort((a, b) => b.margin - a.margin);
  return ok[0] || candidates.sort((a, b) => (b.margin ?? -1) - (a.margin ?? -1))[0] || null;
}

/** Whether a mode may act on a signal for a market. Manual is never gated here (demo flag only). */
export function modeMayAct(mode, signal) {
  if (mode === 'manual') return true;
  return !!signal && signal.gate === GATE.OK;
}
