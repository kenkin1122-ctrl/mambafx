/**
 * research/src/context/PriorCandleAnalyzer.js
 *
 * Purpose:
 *   ScientificPlugin that extracts structural features of the prior (completed)
 *   candle relative to the current candle. This answers whether the context of
 *   the current tick is informed by the prior candle's character (bullish,
 *   bearish, doji, wide-range, narrow-range, etc.).
 *
 * Scientific rationale:
 *   "Prior candle context" was flagged as UNKNOWN in the Phase A audit and
 *   deferred pending investigation of what the existing bridge whitelist provides.
 *
 *   RESOLUTION (Phase B):
 *   ─────────────────────────────────────────────────────────────────────────
 *   The bridge exposes only getAllStates() → msdGetAllStates(), a pass-through
 *   returning whatever the legacy engine's msdGetAllStates() returns. There is
 *   NO bridge API for "prior candle" specifically. However, each state record
 *   contains candle_start (epoch seconds), candle_open, candle_high, candle_low,
 *   candle_close — all declared in PRIMITIVE_OBSERVABLES. By grouping all
 *   records by their distinct candle_start values, sorting those groups
 *   chronologically, and looking at the group preceding the current record's
 *   group, we can derive full prior-candle OHLC with ZERO additions to the
 *   bridge whitelist.
 *
 *   This derivation is causal (maxLookahead=0) because the prior candle is
 *   definitionally in the past relative to any current-candle tick.
 *
 *   NO WHITELIST ADDITIONS NEEDED.
 *   ─────────────────────────────────────────────────────────────────────────
 *
 *   Features computed from the prior candle:
 *     priorDirection     — +1 (close > open), -1 (close < open), 0 (doji)
 *     priorRange         — candle_high − candle_low (absolute price range)
 *     priorBodyRatio     — |close − open| / range (body fraction of range)
 *     priorUpperWick     — (high − max(open,close)) / range
 *     priorLowerWick     — (min(open,close) − low) / range
 *     priorClosePosition — (close − low) / range (0=closed at low, 1=at high)
 *
 * Phase B scope:
 *   Registered in ContextRegistry by phase11 bootstrap code.
 *
 * Dependencies: plugin/MachineReadableMathematics.js.
 * Public API: PriorCandleAnalyzer (plugin object), PRIOR_CANDLE_DIRECTIONS.
 * Complexity:
 *   O(n log n) for sorting + grouping (sort is dominant);
 *   O(n) thereafter for feature computation.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

/** Direction labels for the prior candle's body. */
export const PRIOR_CANDLE_DIRECTIONS = Object.freeze({
  BULLISH: 'BULLISH',  // close > open
  BEARISH: 'BEARISH',  // close < open
  DOJI:    'DOJI',     // close ≈ open (or zero range)
  UNKNOWN: 'UNKNOWN',  // no prior candle available
});

// ── Math definitions ─────────────────────────────────────────────────────────

const BODY_RATIO_MATH = createMathDefinition({
  humanReadable:
    'Ratio of the candle body length to the total high-low range: ' +
    '1 = full-body candle, 0 = doji.',
  symbolicExpression:
    String.raw`\beta = \frac{|C - O|}{H - L}, \quad H > L`,
  executableFormula: (open, high, low, close) => {
    const range = high - low;
    if (range === 0) return NaN;
    return Math.abs(close - open) / range;
  },
  units: 'dimensionless [0, 1]',
  domain: 'H > L',
  range: '[0, 1]',
});

const CLOSE_POSITION_MATH = createMathDefinition({
  humanReadable:
    'Normalized close position within the candle range: 0=closed at low, 1=closed at high.',
  symbolicExpression:
    String.raw`\gamma = \frac{C - L}{H - L}, \quad H > L`,
  executableFormula: (high, low, close) => {
    const range = high - low;
    if (range === 0) return NaN;
    return (close - low) / range;
  },
  units: 'dimensionless [0, 1]',
  domain: 'H > L, C ∈ [L, H]',
  range: '[0, 1]',
});

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Groups state records by candle_start and returns them sorted ascending.
 * O(n log n).
 * @param {object[]} states
 * @returns {{ candleStart: number, records: object[] }[]}
 */
function groupByCandle(states) {
  const map = new Map();
  for (const r of states) {
    const cs = Number(r.candle_start);
    if (!map.has(cs)) map.set(cs, []);
    map.get(cs).push(r);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([candleStart, records]) => ({ candleStart, records }));
}

/**
 * Extracts a representative OHLC summary from a group of state records
 * belonging to the same candle. Uses the first record's values (the bridge
 * doesn't guarantee per-tick OHLC updates, so we take the candle's stated
 * OHLC which is the same for every record in the group by the legacy schema).
 * @param {{ candleStart: number, records: object[] }} group
 * @returns {{ open, high, low, close, start }}
 */
function ohlcFromGroup(group) {
  const r = group.records[0];
  return {
    open:  Number(r.candle_open),
    high:  Number(r.candle_high),
    low:   Number(r.candle_low),
    close: Number(r.candle_close),
    start: group.candleStart,
  };
}

/**
 * Computes prior-candle features from an OHLC object.
 * Returns all NaN for degenerate candles (high === low).
 * @param {{ open, high, low, close }} ohlc
 * @returns {object}
 */
function computePriorFeatures(ohlc) {
  const { open, high, low, close } = ohlc;
  const range = high - low;
  if (range === 0 || !Number.isFinite(range)) {
    return {
      priorDirection:     PRIOR_CANDLE_DIRECTIONS.DOJI,
      priorRange:         0,
      priorBodyRatio:     NaN,
      priorUpperWick:     NaN,
      priorLowerWick:     NaN,
      priorClosePosition: NaN,
    };
  }
  const direction =
    close > open ? PRIOR_CANDLE_DIRECTIONS.BULLISH :
    close < open ? PRIOR_CANDLE_DIRECTIONS.BEARISH :
    PRIOR_CANDLE_DIRECTIONS.DOJI;
  const bodyHigh = Math.max(open, close);
  const bodyLow  = Math.min(open, close);
  return {
    priorDirection:     direction,
    priorRange:         range,
    priorBodyRatio:     BODY_RATIO_MATH.executableFormula(open, high, low, close),
    priorUpperWick:     (high - bodyHigh) / range,
    priorLowerWick:     (bodyLow - low) / range,
    priorClosePosition: CLOSE_POSITION_MATH.executableFormula(high, low, close),
  };
}

// ── Null features for records with no prior candle ────────────────────────────

const NULL_PRIOR_FEATURES = Object.freeze({
  priorDirection:     PRIOR_CANDLE_DIRECTIONS.UNKNOWN,
  priorRange:         NaN,
  priorBodyRatio:     NaN,
  priorUpperWick:     NaN,
  priorLowerWick:     NaN,
  priorClosePosition: NaN,
});

// ── Plugin ────────────────────────────────────────────────────────────────────

/**
 * PriorCandleAnalyzer — ScientificPlugin.
 *
 * compute input:
 *   { states: StateRecord[] }
 *   Records from getAllStates(). Must contain candle_start, candle_open,
 *   candle_high, candle_low, candle_close.
 *
 * compute output:
 *   {
 *     priorDirection:     string[],   // PRIOR_CANDLE_DIRECTIONS per record
 *     priorRange:         number[],   // absolute H-L range of prior candle
 *     priorBodyRatio:     number[],   // body / range ratio of prior candle
 *     priorUpperWick:     number[],   // upper wick fraction
 *     priorLowerWick:     number[],   // lower wick fraction
 *     priorClosePosition: number[],   // close position in range
 *     metadata: { stateCount, candleCount }
 *   }
 *
 * Records on the FIRST candle receive NULL_PRIOR_FEATURES (UNKNOWN direction,
 * NaN numeric fields) — there is no prior candle to analyze.
 *
 * @type {import('../plugin/PluginContract.js').ScientificPlugin}
 */
export const PriorCandleAnalyzer = Object.freeze({
  metadata() {
    return Object.freeze({
      name: 'PriorCandleAnalyzer',
      version: '1.0.0',
      description:
        'Extracts structural features of the prior completed candle for each ' +
        'state record. Derived from getAllStates() by grouping on candle_start — ' +
        'no bridge additions required.',
      scientificAssumptions: [
        'State records share candle_start with all other records in the same candle.',
        'candle_open/high/low/close are consistent within a candle group (same for all records).',
        'Prior candle OHLC is causally available at any tick after the prior candle closes.',
        'maxLookahead=0: the prior candle is definitionally in the past.',
        'Records on the first candle have no prior and receive UNKNOWN direction / NaN features.',
      ],
      dependencies: [],
      complexity: 'O(n log n) for grouping/sorting; O(n) for feature extraction',
      validationStatus: 'HEURISTIC',
      maxLookahead: 0,
    });
  },

  validate() {
    return { valid: true, errors: [] };
  },

  compute({ states } = {}) {
    if (!Array.isArray(states)) {
      return {
        priorDirection: [], priorRange: [], priorBodyRatio: [],
        priorUpperWick: [], priorLowerWick: [], priorClosePosition: [],
        error: 'states: expected array',
      };
    }
    if (states.length === 0) {
      return {
        priorDirection: [], priorRange: [], priorBodyRatio: [],
        priorUpperWick: [], priorLowerWick: [], priorClosePosition: [],
        metadata: Object.freeze({ stateCount: 0, candleCount: 0 }),
      };
    }

    // Group records by candle and sort chronologically.
    const candleGroups = groupByCandle(states);

    // Build a map: candleStart → prior candle features
    const priorFeaturesMap = new Map();
    for (let i = 0; i < candleGroups.length; i++) {
      const currentStart = candleGroups[i].candleStart;
      if (i === 0) {
        priorFeaturesMap.set(currentStart, NULL_PRIOR_FEATURES);
      } else {
        const priorOhlc = ohlcFromGroup(candleGroups[i - 1]);
        priorFeaturesMap.set(currentStart, computePriorFeatures(priorOhlc));
      }
    }

    // Map each record to its prior candle features (O(n) lookup).
    const priorDirection     = new Array(states.length);
    const priorRange         = new Array(states.length);
    const priorBodyRatio     = new Array(states.length);
    const priorUpperWick     = new Array(states.length);
    const priorLowerWick     = new Array(states.length);
    const priorClosePosition = new Array(states.length);

    for (let i = 0; i < states.length; i++) {
      const cs = Number(states[i].candle_start);
      const f  = priorFeaturesMap.get(cs) ?? NULL_PRIOR_FEATURES;
      priorDirection[i]     = f.priorDirection;
      priorRange[i]         = f.priorRange;
      priorBodyRatio[i]     = f.priorBodyRatio;
      priorUpperWick[i]     = f.priorUpperWick;
      priorLowerWick[i]     = f.priorLowerWick;
      priorClosePosition[i] = f.priorClosePosition;
    }

    return Object.freeze({
      priorDirection,
      priorRange,
      priorBodyRatio,
      priorUpperWick,
      priorLowerWick,
      priorClosePosition,
      metadata: Object.freeze({
        stateCount:  states.length,
        candleCount: candleGroups.length,
      }),
    });
  },

  version() { return '1.0.0'; },
  dependencies() { return []; },

  tests() {
    return [
      {
        name: 'first candle records receive UNKNOWN direction',
        inputs: {
          states: [
            { candle_start: 1000, candle_open: 100, candle_high: 110, candle_low: 95, candle_close: 108 },
          ],
        },
        expectedOutputShape: { priorDirection: 'string[]', priorRange: 'number[]' },
      },
      {
        name: 'second candle records receive prior candle features',
        inputs: {
          states: [
            { candle_start: 1000, candle_open: 100, candle_high: 110, candle_low: 95, candle_close: 108 },
            { candle_start: 2000, candle_open: 108, candle_high: 115, candle_low: 105, candle_close: 112 },
          ],
        },
        expectedOutputShape: { priorDirection: 'string[]', priorBodyRatio: 'number[]' },
      },
    ];
  },

  documentation() {
    return (
      'PriorCandleAnalyzer groups state records by candle_start (epoch seconds), ' +
      'sorts groups chronologically, and for each record provides features of the ' +
      'immediately preceding candle group. Prior candle features include direction ' +
      '(BULLISH/BEARISH/DOJI), range, body ratio, upper/lower wick fractions, and ' +
      'close position within the range. Records on the first candle receive UNKNOWN ' +
      'direction and NaN numeric features. NO bridge whitelist additions are required — ' +
      'all data is derived from candle_start/open/high/low/close in getAllStates() output.'
    );
  },

  scientificAssumptions() {
    return [
      'Prior candle patterns (engulfing, doji, pin bar) carry predictive information ' +
      'according to Japanese candlestick theory; this is a HEURISTIC assumption.',
      'The prior candle is causally available at any tick in the subsequent candle.',
      'OHLC consistency within a candle group is assumed (not verified at runtime).',
      'maxLookahead=0 is satisfied because the prior candle closed before time t.',
    ];
  },

  /** Exposed for testing the math formulas independently. */
  _mathBodyRatio: BODY_RATIO_MATH,
  _mathClosePosition: CLOSE_POSITION_MATH,
});
