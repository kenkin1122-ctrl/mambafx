/**
 * research/src/context/CandlePositionDetector.js
 *
 * Purpose:
 *   ScientificPlugin that detects the normalized price position of the current
 *   tick within the candle's high-low range and classifies it into a
 *   qualitative zone (LOWER_THIRD / MIDDLE_THIRD / UPPER_THIRD / UNKNOWN).
 *
 * Scientific rationale:
 *   The position of the current price within the intraday high-low range is a
 *   proxy for where price is trading relative to the candle's realized extremes.
 *   A tick near the high implies selling pressure was absorbed; a tick near the
 *   low implies buying pressure was absorbed. These observations are entirely
 *   causal (candle_high and candle_low are running maxima/minima up to time t)
 *   and form a simple but informative context for conditional hypothesis testing.
 *
 *   Note on lookahead: in live trading, the final candle_high/low are not known
 *   until the candle closes. This plugin treats the values in the state record
 *   as the running high/low up to tick t. The distinction between running and
 *   final high/low must be clarified in the research design; this plugin
 *   faithfully reports what the record contains and does not add lookahead.
 *
 * Phase B scope:
 *   Registered in ContextRegistry by phase11 bootstrap code.
 *
 * Dependencies: plugin/MachineReadableMathematics.js.
 * Public API: CandlePositionDetector (plugin object), POSITION_ZONES.
 * Complexity: O(n) where n = states.length.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

/** Qualitative price zones within the candle H-L range. */
export const POSITION_ZONES = Object.freeze({
  LOWER_THIRD:  'LOWER_THIRD',   // normalizedPos ∈ [0, 0.33)
  MIDDLE_THIRD: 'MIDDLE_THIRD',  // normalizedPos ∈ [0.33, 0.67)
  UPPER_THIRD:  'UPPER_THIRD',   // normalizedPos ∈ [0.67, 1]
  UNKNOWN:      'UNKNOWN',       // degenerate candle (high = low) or missing fields
});

const POSITION_MATH = createMathDefinition({
  humanReadable:
    'Normalized tick price within the candle high-low range: ' +
    '0 = at the low, 1 = at the high.',
  symbolicExpression:
    String.raw`\phi_t = \frac{P_t - L_t}{H_t - L_t}, \quad H_t > L_t`,
  executableFormula: (price, high, low) => {
    const range = high - low;
    if (range <= 0) return NaN;
    return Math.max(0, Math.min(1, (price - low) / range));
  },
  units: 'dimensionless [0, 1]',
  domain: 'price ∈ ℝ, high > low',
  range: '[0, 1] or NaN',
});

/**
 * Classifies normalizedPos into POSITION_ZONES ordinal.
 * @param {number} p
 * @returns {string}
 */
function classifyZone(p) {
  if (!Number.isFinite(p)) return POSITION_ZONES.UNKNOWN;
  if (p < 0.33) return POSITION_ZONES.LOWER_THIRD;
  if (p < 0.67) return POSITION_ZONES.MIDDLE_THIRD;
  return POSITION_ZONES.UPPER_THIRD;
}

/**
 * CandlePositionDetector — ScientificPlugin.
 *
 * compute input:
 *   { states: StateRecord[] }
 *   Each record should have: tick_price, candle_high, candle_low.
 *
 * compute output:
 *   {
 *     normalizedPosition: number[],  // φ ∈ [0,1] or NaN per record
 *     zone: string[],                // POSITION_ZONES value per record
 *     metadata: { stateCount }
 *   }
 *
 * @type {import('../plugin/PluginContract.js').ScientificPlugin}
 */
export const CandlePositionDetector = Object.freeze({
  metadata() {
    return Object.freeze({
      name: 'CandlePositionDetector',
      version: '1.0.0',
      description:
        'Detects normalized tick price position within the candle H-L range and ' +
        'classifies it into LOWER_THIRD / MIDDLE_THIRD / UPPER_THIRD zones.',
      scientificAssumptions: [
        'candle_high and candle_low in the state record are running extremes up to time t.',
        'tick_price is the mid-price at tick t.',
        'maxLookahead=0: all inputs (tick_price, candle_high, candle_low) are at or before t.',
        'NaN is returned for zero-range candles (high=low) — these are degenerate observations.',
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
      return { normalizedPosition: [], zone: [], error: 'states: expected array' };
    }
    const normalizedPosition = new Array(states.length);
    const zone = new Array(states.length);
    for (let i = 0; i < states.length; i++) {
      const r = states[i];
      const φ = POSITION_MATH.executableFormula(
        Number(r.tick_price),
        Number(r.candle_high),
        Number(r.candle_low),
      );
      normalizedPosition[i] = φ;
      zone[i] = classifyZone(φ);
    }
    return Object.freeze({
      normalizedPosition,
      zone,
      metadata: Object.freeze({ stateCount: states.length }),
    });
  },

  version() { return '1.0.0'; },
  dependencies() { return []; },

  tests() {
    return [
      {
        name: 'price at low → normalizedPosition=0, zone=LOWER_THIRD',
        inputs: { states: [{ tick_price: 100, candle_high: 110, candle_low: 100 }] },
        expectedOutputShape: { normalizedPosition: 'number[]', zone: 'string[]' },
      },
      {
        name: 'price at midpoint → normalizedPosition=0.5, zone=MIDDLE_THIRD',
        inputs: { states: [{ tick_price: 105, candle_high: 110, candle_low: 100 }] },
        expectedOutputShape: { normalizedPosition: 'number[]', zone: 'string[]' },
      },
    ];
  },

  documentation() {
    return (
      'CandlePositionDetector computes φ = (tick_price − candle_low) / (candle_high − candle_low). ' +
      'φ < 0.33 → LOWER_THIRD, 0.33 ≤ φ < 0.67 → MIDDLE_THIRD, φ ≥ 0.67 → UPPER_THIRD. ' +
      'NaN and UNKNOWN are returned for zero-range candles. ' +
      'maxLookahead=0: all inputs are at or before time t.'
    );
  },

  scientificAssumptions() {
    return [
      'Price zone within the candle range reflects supply/demand balance at tick t.',
      'Running high/low (not final) are used — this is causal and appropriate for online detection.',
      'maxLookahead=0: no future candle_high or candle_low is accessed.',
    ];
  },

  mathDefinition: POSITION_MATH,
});
