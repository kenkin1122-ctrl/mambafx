/**
 * research/src/candidate/MarketState.js
 *
 * Purpose:
 *   Phase 11 Candidate subclass for discrete market state classifications.
 *   A MarketState is a named, rule-based classification of overall market
 *   conditions (e.g., "trending up", "choppy/ranging", "high-volatility regime")
 *   that a candidate uses as a conditional context or a direct predictor.
 *
 * Scientific rationale:
 *   Market behaviour is known to be regime-dependent: strategies that work in
 *   trending markets often fail in ranging ones. Formalising market states as
 *   Candidates allows the discovery engine to test whether state-conditioned
 *   hypotheses are more reproducible than unconditional ones, while keeping
 *   the state definition explicit and auditable.
 *
 *   NOTE: This class occupies the `research/src/candidate/` namespace and
 *   is entirely separate from the legacy `window.msdComputeUnifiedLifecycleStage`
 *   (bridgeToLegacyMsd/read.js) and from the research-governance lifecycle stages
 *   (hypothesisRegistry.js LIFECYCLE_STAGES). The naming is intentionally precise:
 *   MarketState = a market condition classification candidate; lifecycle stage =
 *   where a hypothesis is in the research pipeline.
 *
 * Additional fields (beyond base Candidate):
 *   stateLabel        — human-readable state name
 *   detectionCriteria — rule set for classifying a candle as this state
 *   minimumDurationTicks — minimum consecutive ticks the state must persist
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: MarketState.
 * Complexity: O(1) construction; O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

export class MarketState extends Candidate {
  // Note: no bare class field declarations — see IndicatorFeature.js for the rationale.
  // @field {string}          stateLabel            - Human-readable state name.
  // @field {Readonly<Object>} detectionCriteria    - Classification rule set.
  // @field {number}           minimumDurationTicks - Min consecutive qualifying ticks (≥ 1).

  /** @private — use MarketState.create(). */
  constructor(fields) {
    super(fields);
    Object.freeze(this.detectionCriteria);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates MarketState-specific fields, computes fingerprint.
   *
   * @param {object} params - Base Candidate fields plus:
   * @param {string} params.stateLabel            - Human-readable state name.
   * @param {object} params.detectionCriteria     - Classification rule set.
   * @param {number} [params.minimumDurationTicks=1] - Min consecutive qualifying ticks.
   * @returns {Promise<MarketState>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.MARKET_STATE,
    });
    const typeErrors = [];
    if (!params.stateLabel || typeof params.stateLabel !== 'string')
      typeErrors.push('stateLabel: required non-empty string');
    if (!params.detectionCriteria || typeof params.detectionCriteria !== 'object' || Array.isArray(params.detectionCriteria))
      typeErrors.push('detectionCriteria: required plain object describing the classification rule');
    const minDuration = params.minimumDurationTicks ?? 1;
    if (!Number.isInteger(minDuration) || minDuration < 1)
      typeErrors.push('minimumDurationTicks: must be an integer ≥ 1');

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.MARKET_STATE,
        fields: allErrors,
      });
    }

    const effectiveParams = { ...params, type: CANDIDATE_TYPES.MARKET_STATE };
    // Include type-specific identity fields in the fingerprint.
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        stateLabel: params.stateLabel,
        detectionCriteria: params.detectionCriteria,
        minimumDurationTicks: minDuration,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new MarketState({
      ...common,
      stateLabel: params.stateLabel,
      detectionCriteria: { ...params.detectionCriteria },
      minimumDurationTicks: minDuration,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateLabel: this.stateLabel,
      detectionCriteria: { ...this.detectionCriteria },
      minimumDurationTicks: this.minimumDurationTicks,
    };
  }
}
