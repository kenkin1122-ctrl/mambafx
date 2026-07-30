/**
 * research/src/features/RawObservationExtractor.js
 *
 * Purpose:
 *   ScientificPlugin that extracts arrays of primitive observable values from
 *   an array of legacy state records (as returned by bridgeToLegacyMsd/read.js
 *   getAllStates()). Each extraction maps a PRIMITIVE_OBSERVABLES field name to
 *   a numeric time-series array. The result is the foundational input layer for
 *   DerivedFeatureCalculator and all context/proxy plugins.
 *
 * Scientific rationale:
 *   Cleanly separating raw extraction from derived computation enforces the
 *   measurement model: primitive observables are directly read from reality
 *   (via the bridge), not inferred. Derived features (slope, entropy, variance)
 *   are computed downstream. This layering keeps each step independently
 *   auditable and makes causal leakage checks (maxLookahead=0) tractable.
 *
 *   The plugin uses only fields declared in PRIMITIVE_OBSERVABLES. Any field
 *   not in that set is ignored — this is intentional defensive coding that
 *   prevents accidental reliance on undocumented legacy schema fields.
 *
 * Phase B scope:
 *   Provides the extraction stage for Phase B detectors. DerivedFeatureCalculator
 *   consumes its output.
 *
 * Dependencies: plugin/PluginContract.js, plugin/MachineReadableMathematics.js,
 *   candidate/MeasurementRegistry.js.
 * Public API: RawObservationExtractor (plugin object).
 * Complexity: O(n·k) where n = states.length, k = fields requested (bounded by 11).
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

// ── Mathematical definitions for each primitive extraction ───────────────────

/**
 * Identity extraction: f(record, field) = record[field].
 * Trivially maxLookahead=0 (reads only the current record).
 */
const IDENTITY_MATH = createMathDefinition({
  humanReadable:
    'Identity extraction: the value at field f of state record r at time t.',
  symbolicExpression: String.raw`x_t = r_t[f]`,
  executableFormula: (record, field) => record[field],
  units: 'field-dependent',
  domain: 'StateRecord × FieldName',
  range: 'ℝ ∪ {undefined}',
});

// ── Plugin implementation ────────────────────────────────────────────────────

/**
 * Fields this plugin knows how to extract. Matches PRIMITIVE_OBSERVABLES values.
 * @type {ReadonlyArray<string>}
 */
export const EXTRACTABLE_FIELDS = Object.freeze([
  'tick_price',
  'tick_direction',
  'tick_size',
  'tick_timestamp',
  'candle_open',
  'candle_high',
  'candle_low',
  'candle_close',
  'candle_start',
  'candle_end',
  'tick_interval',
]);

/**
 * RawObservationExtractor — ScientificPlugin that maps legacy state records
 * to typed arrays of primitive observable values.
 *
 * compute(inputs) input shape:
 *   { states: StateRecord[], fields?: string[] }
 *   - states: array of legacy state records (from getAllStates())
 *   - fields: optional subset of EXTRACTABLE_FIELDS to extract (default: all)
 *
 * compute(inputs) output shape:
 *   { [fieldName]: number[], metadata: { stateCount, fieldsExtracted } }
 *
 * @type {import('../plugin/PluginContract.js').ScientificPlugin}
 */
export const RawObservationExtractor = Object.freeze({
  metadata() {
    return Object.freeze({
      name:               'RawObservationExtractor',
      version:            '1.0.0',
      description:
        'Extracts primitive observable arrays from legacy state records. ' +
        'Each output array is a time-ordered sequence of one numeric field ' +
        'across all provided state records.',
      scientificAssumptions: [
        'State records are independent observations at discrete time steps.',
        'Field names in state records match PRIMITIVE_OBSERVABLES snake_case names.',
        'Missing fields are represented as NaN rather than causing failures.',
        'maxLookahead=0: extraction reads only the record at time t (no future access).',
      ],
      dependencies:   [],
      complexity:     'O(n·k) where n=state count, k=fields requested (≤11)',
      validationStatus: 'THEORETICAL',
      maxLookahead:   0,
    });
  },

  validate() {
    // No configuration state — always valid.
    return { valid: true, errors: [] };
  },

  compute({ states, fields } = {}) {
    if (!Array.isArray(states)) {
      return { error: 'states: expected an array', result: null };
    }
    const requestedFields = Array.isArray(fields) ? fields : EXTRACTABLE_FIELDS;
    // Guard: silently drop any requested field not in the extractable whitelist.
    const safeFields = requestedFields.filter(f => EXTRACTABLE_FIELDS.includes(f));

    const result = {};
    for (const field of safeFields) {
      // Extract each field as an array, coercing missing/non-numeric to NaN.
      result[field] = states.map(record => {
        const val = IDENTITY_MATH.executableFormula(record, field);
        return (val === undefined || val === null) ? NaN : Number(val);
      });
    }

    return {
      ...result,
      metadata: Object.freeze({
        stateCount:      states.length,
        fieldsExtracted: safeFields,
      }),
    };
  },

  version() {
    return '1.0.0';
  },

  dependencies() {
    return [];
  },

  tests() {
    return [
      {
        name: 'extracts tick_price from a single record',
        inputs: { states: [{ tick_price: 100.5, tick_direction: 1 }], fields: ['tick_price'] },
        expectedOutputShape: { tick_price: 'number[]', metadata: 'object' },
      },
      {
        name: 'coerces missing field to NaN',
        inputs: { states: [{}], fields: ['tick_price'] },
        expectedOutputShape: { tick_price: 'number[]' },
      },
    ];
  },

  documentation() {
    return (
      'RawObservationExtractor maps an array of legacy state records into typed ' +
      'numeric arrays, one per requested PRIMITIVE_OBSERVABLES field. It is the ' +
      'first stage of the Phase 11 feature pipeline. Inputs are state records from ' +
      'bridgeToLegacyMsd/read.js getAllStates(); outputs feed DerivedFeatureCalculator ' +
      'and all context/proxy plugins. maxLookahead=0 is enforced by construction: ' +
      'extraction reads record[field] at time t with no look-forward.'
    );
  },

  scientificAssumptions() {
    return [
      'State records are temporally ordered (or will be sorted before use).',
      'Field names in legacy records match PRIMITIVE_OBSERVABLES snake_case keys.',
      'Missing or non-numeric field values are treated as NaN (not imputed).',
      'The extraction operation itself introduces no lookahead: f(r_t) depends only on r_t.',
    ];
  },
});
