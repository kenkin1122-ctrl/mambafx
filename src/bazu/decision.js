/**
 * src/bazu/decision.js
 *
 * DECISION layer (pure). Prediction (Rise/Fall call) -> Decision (trade signal / gate)
 * -> Execution (execution.js). No UI, no network.
 */

import { MIN_STRENGTH } from './predict.js?v=15';

export const GATE = Object.freeze({ OK: 'tradable', WEAK: 'weak signal', ARMED: 'armed: waiting for trigger', NO_QUOTE: 'awaiting Deriv quote', NO_DATA: 'waiting for data' });

/**
 * Build a trade signal from a prediction and the quote Deriv gave. Tradable when strength >= MIN_STRENGTH.
 * In families mode a signal is tradable only while its book entry is TRIGGERED (`bookSignal`, from signalBook3m).
 */
export function buildTradeSignal({ symbol, prediction, duration, quote, now = Date.now(), bookSignal = null }) {
  if (!prediction) return { gate: GATE.NO_DATA, market: symbol };
  const min = prediction.minStrength ?? MIN_STRENGTH;
  const up = prediction.direction > 0;
  const base = {
    market: symbol, direction: up ? 'Rise' : 'Fall', contractType: up ? 'CALL' : 'PUT', duration,
    strength: prediction.strength, agree: up ? prediction.up : prediction.down, total: prediction.total,
    drivers: prediction.drivers, proxy: prediction.proxy, quote, at: now,
    playbook: prediction.playbook, reason: prediction.reason, vetoes: prediction.vetoes, reasons: prediction.reasons, parts: prediction.parts, patterns: prediction.patterns, factors: prediction.factors, decisionTs: prediction.decisionTs, provisional: prediction.provisional, durationSec: prediction.durationSec,
    lifetime: prediction.lifetime, roomInfo: prediction.roomInfo || null, manual: !!prediction.manual, breakEven: quote && quote.payout > 0 ? quote.ask / quote.payout : null,
    mode: prediction.mode, regime: prediction.regime, momentum: prediction.momentum, entry: prediction.entry, families: prediction.families, familyAgreement: prediction.familyAgreement, votes: prediction.votes, verdicts: prediction.verdicts, setup: prediction.setup,
    signalId: bookSignal?.id || null, signalState: bookSignal?.state || null, signalReason: bookSignal?.lastReason || null, signalHistory: bookSignal?.history || null,
  };
  if (prediction.wait || !duration) return { ...base, gate: prediction.mode === 'families' && prediction.setup?.qualifies && bookSignal && duration ? GATE.ARMED : GATE.WEAK };
  if (prediction.mode === 'families' && bookSignal?.state !== 'TRIGGERED') return { ...base, gate: GATE.ARMED };
  if (!quote || !(quote.ask > 0) || !(quote.payout > 0)) return { ...base, gate: GATE.NO_QUOTE };
  return { ...base, gate: prediction.strength >= min ? GATE.OK : GATE.WEAK };
}

/** Whether a mode may act on a signal. Manual is never gated. */
export function modeMayAct(mode, signal) {
  if (mode === 'manual') return true;
  return !!signal && signal.gate === GATE.OK;
}
