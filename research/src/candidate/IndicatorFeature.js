/**
 * research/src/candidate/IndicatorFeature.js
 *
 * Purpose:
 *   Phase 11 Candidate subclass for technical indicator features.
 *   An IndicatorFeature is a computation applied to raw price/tick data
 *   (e.g., RSI-14 applied to close prices) that produces a scalar or
 *   categorical signal used as a candidate predictor in the discovery funnel.
 *
 * Scientific rationale:
 *   Technical indicators are the most common form of market-prediction hypothesis
 *   in systematic trading. Formalising them as first-class Candidates with
 *   explicit inputObservables (tracing back to MeasurementRegistry primitives)
 *   and a fixed indicator name + parameter set ensures they are reproducible
 *   and auditable — "RSI-14 on close prices" is unambiguous when indicatorName,
 *   period, and inputField are locked in the Candidate record.
 *
 * Additional fields (beyond base Candidate):
 *   indicatorName  — canonical name of the indicator (e.g. 'RSI', 'MACD', 'ATR')
 *   period         — primary lookback window in ticks
 *   signalLine     — secondary smoothing window (e.g. MACD signal line); null if N/A
 *   inputField     — which raw price field drives the indicator
 *   inputObservables — observable names from MeasurementRegistry
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: IndicatorFeature.
 * Complexity: O(1) construction; O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

/** Accepted input fields for indicator computation. */
export const INDICATOR_INPUT_FIELDS = Object.freeze({
  CLOSE: 'close',
  OPEN:  'open',
  HIGH:  'high',
  LOW:   'low',
  HL2:   'hl2',   // (high + low) / 2
  HLC3:  'hlc3',  // (high + low + close) / 3
  OHLC4: 'ohlc4', // (open + high + low + close) / 4
});

export class IndicatorFeature extends Candidate {
  // Note: no class field declarations here — Object.assign in Candidate's constructor
  // sets all fields from the `fields` argument. Bare `fieldName;` declarations in a
  // subclass are initialized AFTER super() returns, which would overwrite the values
  // set by Object.assign with undefined. JSDoc annotations below document the fields.
  //
  // @field {string}               indicatorName   - Canonical indicator name (e.g. 'RSI', 'MACD').
  // @field {number}               period          - Primary lookback window (≥ 2 ticks).
  // @field {number|null}          signalLine      - Secondary smoothing window; null if N/A.
  // @field {string}               inputField      - Input price field (INDICATOR_INPUT_FIELDS).
  // @field {ReadonlyArray<string>} inputObservables - MeasurementRegistry observable names.

  /** @private — use IndicatorFeature.create(). */
  constructor(fields) {
    super(fields);
    Object.freeze(this.inputObservables);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates indicator-specific fields, computes fingerprint,
   * returns a frozen IndicatorFeature instance.
   *
   * @param {object} params - Base Candidate fields plus:
   * @param {string}   params.indicatorName    - Canonical indicator name.
   * @param {number}   params.period           - Primary lookback window (≥ 2 ticks).
   * @param {number|null} [params.signalLine=null] - Secondary window (null if N/A).
   * @param {string}   [params.inputField='close'] - Input price field.
   * @param {string[]} [params.inputObservables=[]] - MeasurementRegistry observable names.
   * @returns {Promise<IndicatorFeature>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.INDICATOR_FEATURE,
    });
    const typeErrors = [];
    if (!params.indicatorName || typeof params.indicatorName !== 'string')
      typeErrors.push('indicatorName: required non-empty string (e.g. "RSI", "MACD", "ATR")');
    if (!Number.isInteger(params.period) || params.period < 2)
      typeErrors.push('period: required integer ≥ 2 (minimum meaningful lookback)');
    if (params.signalLine !== undefined && params.signalLine !== null &&
        (!Number.isInteger(params.signalLine) || params.signalLine < 1))
      typeErrors.push('signalLine: must be null or an integer ≥ 1');
    const inputField = params.inputField ?? INDICATOR_INPUT_FIELDS.CLOSE;
    if (!Object.values(INDICATOR_INPUT_FIELDS).includes(inputField))
      typeErrors.push(`inputField: must be one of [${Object.values(INDICATOR_INPUT_FIELDS).join(', ')}]`);

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
        fields: allErrors,
      });
    }

    const effectiveParams = { ...params, type: CANDIDATE_TYPES.INDICATOR_FEATURE };
    // Include type-specific identity fields in the fingerprint so that two IndicatorFeature
    // instances with the same base params but different indicatorName/period/inputField are
    // treated as distinct scientific identities. We merge them into parameters for hashing
    // only — the top-level fields remain authoritative for access.
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        indicatorName: params.indicatorName,
        period: params.period,
        signalLine: params.signalLine ?? null,
        inputField,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new IndicatorFeature({
      ...common,
      indicatorName: params.indicatorName,
      period: params.period,
      signalLine: params.signalLine ?? null,
      inputField,
      inputObservables: Array.isArray(params.inputObservables) ? [...params.inputObservables] : [],
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      indicatorName: this.indicatorName,
      period: this.period,
      signalLine: this.signalLine,
      inputField: this.inputField,
      inputObservables: [...this.inputObservables],
    };
  }
}
