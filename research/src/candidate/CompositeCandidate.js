/**
 * research/src/candidate/CompositeCandidate.js
 *
 * Purpose:
 *   Phase 11 Candidate subclass that combines two or more existing candidates
 *   into a single composite feature using a specified combination rule
 *   (conjunction / disjunction / weighted average).
 *
 * Scientific rationale:
 *   Individual indicators often have complementary strengths and weaknesses.
 *   A composite candidate tests whether combining two signals (e.g., RSI AND
 *   MACD aligned) is more reproducible than either signal alone. Requiring at
 *   least 2 component candidates prevents degenerate single-component composites
 *   that add no combinatorial information. The combinator is pre-committed in
 *   the Candidate record, preventing post-hoc selection of whichever combination
 *   rule produces the most significant result.
 *
 * Additional fields (beyond base Candidate):
 *   componentIds  — IDs of constituent candidates (minimum 2)
 *   combinator    — how components are combined
 *   weights       — weights for 'weighted' combinator; null otherwise
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: CompositeCandidate, COMBINATORS.
 * Complexity: O(c) validation where c = component count; O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

/** Recognised combination rules for CompositeCandidate. */
export const COMBINATORS = Object.freeze({
  /** Both components must signal simultaneously for the composite to signal. */
  CONJUNCTION:  'conjunction',
  /** Either component signalling is sufficient for the composite to signal. */
  DISJUNCTION:  'disjunction',
  /** Weighted average of component signals; requires a weights array. */
  WEIGHTED:     'weighted',
});

export class CompositeCandidate extends Candidate {
  // Note: no bare class field declarations — see IndicatorFeature.js for the rationale.
  // @field {ReadonlyArray<string>}        componentIds - IDs of ≥2 constituent candidates.
  // @field {string}                       combinator   - One of COMBINATORS values.
  // @field {ReadonlyArray<number>|null}   weights      - Weights for WEIGHTED; null otherwise.

  /** @private — use CompositeCandidate.create(). */
  constructor(fields) {
    super(fields);
    Object.freeze(this.componentIds);
    if (this.weights) Object.freeze(this.weights);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates composite-specific fields, computes fingerprint.
   *
   * @param {object}   params - Base Candidate fields plus:
   * @param {string[]} params.componentIds        - IDs of ≥ 2 constituent candidates.
   * @param {string}   params.combinator          - One of COMBINATORS values.
   * @param {number[]|null} [params.weights=null] - Weights for WEIGHTED combinator.
   * @returns {Promise<CompositeCandidate>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.COMPOSITE_CANDIDATE,
    });
    const typeErrors = [];

    if (!Array.isArray(params.componentIds) || params.componentIds.length < 2)
      typeErrors.push('componentIds: required array of at least 2 candidate IDs');
    if (!Object.values(COMBINATORS).includes(params.combinator))
      typeErrors.push(`combinator: must be one of [${Object.values(COMBINATORS).join(', ')}]`);

    // Weights validation for WEIGHTED combinator.
    if (params.combinator === COMBINATORS.WEIGHTED) {
      if (!Array.isArray(params.weights) || params.weights.length !== (params.componentIds || []).length)
        typeErrors.push('weights: for WEIGHTED combinator, must be an array with the same length as componentIds');
      else {
        const weightSum = params.weights.reduce((s, w) => s + (typeof w === 'number' ? w : 0), 0);
        if (Math.abs(weightSum - 1.0) > 1e-6)
          typeErrors.push(`weights: must sum to 1.0 (got ${weightSum.toFixed(6)})`);
        if (params.weights.some(w => typeof w !== 'number' || !Number.isFinite(w) || w < 0))
          typeErrors.push('weights: all weights must be non-negative finite numbers');
      }
    } else if (params.weights != null) {
      typeErrors.push(`weights: must be null for combinator "${params.combinator}" (only used with WEIGHTED)`);
    }

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.COMPOSITE_CANDIDATE,
        fields: allErrors,
      });
    }

    const effectiveParams = { ...params, type: CANDIDATE_TYPES.COMPOSITE_CANDIDATE };
    // Include type-specific identity fields in the fingerprint.
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        componentIds: [...params.componentIds].sort(), // sorted for determinism
        combinator: params.combinator,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new CompositeCandidate({
      ...common,
      componentIds: [...params.componentIds],
      combinator: params.combinator,
      weights: params.combinator === COMBINATORS.WEIGHTED ? [...params.weights] : null,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      componentIds: [...this.componentIds],
      combinator: this.combinator,
      weights: this.weights ? [...this.weights] : null,
    };
  }
}
