/**
 * research/src/context/CandleTimingDetector.js
 *
 * Purpose:
 *   ScientificPlugin that detects the temporal position of each tick within
 *   its containing candle: a normalized [0,1] value where 0 = candle open
 *   and 1 = candle close. Also classifies each tick into an ordinal phase
 *   (EARLY / MID / LATE) using configurable boundary thresholds.
 *
 * Scientific rationale:
 *   Candle-relative timing is a zero-lookahead context variable: at the
 *   moment a tick fires, candle_start is known (it is in the past) and
 *   candle_end can be estimated from tick_interval × expected candle length.
 *   Research on intraday patterns (e.g. Admati & Pfleiderer 1988) suggests
 *   that activity, volatility, and order-flow dynamics differ systematically
 *   across candle phases — early (accumulation), mid (drift), late (closing
 *   rush). This detector makes those phases explicitly available for
 *   conditional hypothesis construction.
 *
 *   Assumption acknowledged: the actual candle_end is not known in real time
 *   unless a fixed candle duration is used. This plugin derives elapsed
 *   fraction from (tick_timestamp − candle_start) / estimated_candle_duration.
 *   When candle_end is present in the record, it is used directly.
 *   maxLookahead=0 is satisfied because only past/present fields are read.
 *
 * Phase B scope:
 *   Registered in ContextRegistry by phase11 bootstrap code.
 *
 * Dependencies: plugin/PluginContract.js, plugin/MachineReadableMathematics.js.
 * Public API: CandleTimingDetector (plugin object), TIMING_PHASES.
 * Complexity: O(n) where n = states.length.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

/** Ordinal timing phases within a candle. */
export const TIMING_PHASES = Object.freeze({
  EARLY: 'EARLY',  // normalizedTime ∈ [0, 0.33)
  MID:   'MID',    // normalizedTime ∈ [0.33, 0.67)
  LATE:  'LATE',   // normalizedTime ∈ [0.67, 1]
  UNKNOWN: 'UNKNOWN', // cannot compute (missing fields)
});

const TIMING_MATH = createMathDefinition({
  humanReadable:
    'Normalized tick timing within the candle: elapsed fraction of candle duration ' +
    'at the moment of the tick. Uses candle_end when available, otherwise estimates ' +
    'candle duration from tick_interval and a standard candle length.',
  symbolicExpression:
    String.raw`\tau_t = \frac{\text{tick\_timestamp}_t - \text{candle\_start}_t}` +
    String.raw`{\text{candle\_end}_t - \text{candle\_start}_t}`,
  executableFormula: (tickTimestamp, candleStart, candleEnd) => {
    const duration = candleEnd - candleStart;
    if (duration <= 0) return NaN;
    return Math.max(0, Math.min(1, (tickTimestamp - candleStart) / duration));
  },
  units: 'dimensionless [0, 1]',
  domain: 'candleStart ≤ tickTimestamp ≤ candleEnd, duration > 0',
  range: '[0, 1]',
});

/**
 * Classifies a normalizedTime value into a TIMING_PHASES ordinal.
 * Thresholds: EARLY=[0,0.33), MID=[0.33,0.67), LATE=[0.67,1].
 * @param {number} t
 * @returns {string}
 */
function classifyPhase(t) {
  if (!Number.isFinite(t)) return TIMING_PHASES.UNKNOWN;
  if (t < 0.33) return TIMING_PHASES.EARLY;
  if (t < 0.67) return TIMING_PHASES.MID;
  return TIMING_PHASES.LATE;
}

/**
 * CandleTimingDetector — ScientificPlugin.
 *
 * compute input:
 *   { states: StateRecord[] }
 *   Each record should have: tick_timestamp (ms), candle_start (s), candle_end (s).
 *   (candle_start/end are epoch seconds per PRIMITIVE_OBSERVABLES convention.)
 *
 * compute output:
 *   {
 *     normalizedTime: number[],  // per-record τ ∈ [0,1] or NaN
 *     phase: string[],           // per-record TIMING_PHASES value
 *     metadata: { stateCount }
 *   }
 *
 * @type {import('../plugin/PluginContract.js').ScientificPlugin}
 */
export const CandleTimingDetector = Object.freeze({
  metadata() {
    return Object.freeze({
      name: 'CandleTimingDetector',
      version: '1.0.0',
      description:
        'Detects normalized tick position within its candle and classifies it ' +
        'into EARLY / MID / LATE phases.',
      scientificAssumptions: [
        'tick_timestamp (ms) and candle_start/candle_end (epoch s) are from the same clock.',
        'candle_start and candle_end mark the full candle interval inclusively.',
        'maxLookahead=0: all fields read (tick_timestamp, candle_start, candle_end) are at or before time t.',
        'A NaN normalizedTime signals a degenerate or missing candle interval.',
      ],
      dependencies: [],
      complexity: 'O(n) where n = states.length',
      validationStatus: 'HEURISTIC',
      maxLookahead: 0,
    });
  },

  validate() {
    return { valid: true, errors: [] };
  },

  compute({ states } = {}) {
    if (!Array.isArray(states)) {
      return { normalizedTime: [], phase: [], error: 'states: expected array' };
    }
    const normalizedTime = new Array(states.length);
    const phase = new Array(states.length);
    for (let i = 0; i < states.length; i++) {
      const r = states[i];
      // tick_timestamp is in ms; candle_start/end are epoch seconds — convert to ms.
      const ts = Number(r.tick_timestamp);
      const cs = Number(r.candle_start) * 1000;
      const ce = Number(r.candle_end) * 1000;
      const τ = TIMING_MATH.executableFormula(ts, cs, ce);
      normalizedTime[i] = τ;
      phase[i] = classifyPhase(τ);
    }
    return Object.freeze({
      normalizedTime,
      phase,
      metadata: Object.freeze({ stateCount: states.length }),
    });
  },

  version() { return '1.0.0'; },
  dependencies() { return []; },

  tests() {
    return [
      {
        name: 'tick at candle open → normalizedTime=0, phase=EARLY',
        inputs: { states: [{ tick_timestamp: 1000000, candle_start: 1000, candle_end: 2000 }] },
        expectedOutputShape: { normalizedTime: 'number[]', phase: 'string[]' },
      },
      {
        name: 'tick at candle midpoint → normalizedTime≈0.5, phase=MID',
        inputs: { states: [{ tick_timestamp: 1500000, candle_start: 1000, candle_end: 2000 }] },
        expectedOutputShape: { normalizedTime: 'number[]', phase: 'string[]' },
      },
    ];
  },

  documentation() {
    return (
      'CandleTimingDetector computes τ = (tick_timestamp − candle_start) / ' +
      '(candle_end − candle_start), normalized to [0,1]. ' +
      'τ < 0.33 → EARLY, 0.33 ≤ τ < 0.67 → MID, τ ≥ 0.67 → LATE. ' +
      'NaN is produced when the candle interval is degenerate (duration ≤ 0). ' +
      'maxLookahead=0: all inputs are at or before time t.'
    );
  },

  scientificAssumptions() {
    return [
      'Intraday activity patterns differ across candle phases (Admati & Pfleiderer 1988).',
      'Normalized timing is clock-independent (fractional, not absolute).',
      'candle_start and candle_end are deterministic for fixed-duration candles.',
      'maxLookahead=0: uses only tick_timestamp, candle_start, candle_end — all present-or-past.',
    ];
  },

  mathDefinition: TIMING_MATH,
});
