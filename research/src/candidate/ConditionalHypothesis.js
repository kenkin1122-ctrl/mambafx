/**
 * research/src/candidate/ConditionalHypothesis.js
 *
 * Purpose:
 *   Phase 11 Candidate subclass for conditional hypotheses — a core hypothesis
 *   that is tested only when a specified set of context conditions hold simultaneously.
 *   The canonical example: "RSI-14 predicts a 5-tick rise, but only when the market
 *   is in a high-volatility regime AND the prior candle was bearish."
 *
 * Scientific rationale:
 *   Conditional testing is one of the most powerful tools in quantitative research
 *   but also one of the most dangerous: with enough conditioning variables, any
 *   null effect can be made to appear significant in some subgroup. The hard cap
 *   of 3 context conditions (enforced in the constructor, NOT just recommended)
 *   is a pre-committed discipline against overfitting: more than 3 conditioning
 *   variables in this domain reliably produces an overfit finding whose generalization
 *   probability is negligible. This cap is not configurable at the instance level
 *   — it is a Laboratory-wide policy enforced by the type itself.
 *
 *   See also: UNKNOWN #5 resolution — CausalLeakageValidator (Phase B) will
 *   further enforce that contextConditions do not introduce look-ahead.
 *
 * Additional fields (beyond base Candidate):
 *   contextConditions   — array of context condition objects (HARD CAP: ≤ 3)
 *   baseHypothesis      — the core hypothesis being tested
 *   conditionCombinator — 'all' (all conditions must hold) or 'any' (any suffices)
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: ConditionalHypothesis, MAX_CONTEXT_CONDITIONS.
 * Complexity: O(1) construction (cap check is O(1)); O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

/**
 * Hard maximum number of context conditions per ConditionalHypothesis.
 * This is a Laboratory-wide policy value, not a configurable threshold.
 * Scientific rationale: see module header.
 */
export const MAX_CONTEXT_CONDITIONS = 3;

/** Accepted values for conditionCombinator. */
export const CONDITION_COMBINATORS = Object.freeze({
  /** ALL conditions must hold for the hypothesis to be tested. */
  ALL: 'all',
  /** ANY single condition holding is sufficient. */
  ANY: 'any',
});

export class ConditionalHypothesis extends Candidate {
  // Note: no bare class field declarations — see IndicatorFeature.js for the rationale.
  // @field {ReadonlyArray<Object>} contextConditions    - ≤3 context conditions (hard cap).
  // @field {Readonly<Object>}      baseHypothesis       - The core hypothesis being tested.
  // @field {string}                conditionCombinator  - 'all' or 'any'.

  /** @private — use ConditionalHypothesis.create(). */
  constructor(fields) {
    super(fields);

    // HARD CAP re-verified in the constructor as a defence-in-depth measure.
    // This ensures the cap holds even if create() is bypassed (e.g., by a
    // malformed deserialized record being instantiated directly).
    if (!Array.isArray(fields.contextConditions) || fields.contextConditions.length > MAX_CONTEXT_CONDITIONS) {
      throw new CandidateValidationError(
        `ConditionalHypothesis: contextConditions length ${(fields.contextConditions || []).length} ` +
        `exceeds the hard cap of ${MAX_CONTEXT_CONDITIONS}. ` +
        `This limit is a Laboratory-wide policy against overfitting via excessive conditioning.`,
        { candidateType: CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS }
      );
    }

    Object.freeze(this.contextConditions);
    Object.freeze(this.baseHypothesis);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates conditional-hypothesis-specific fields, enforces the
   * max-3-context hard cap, computes fingerprint, returns a frozen instance.
   *
   * @param {object}   params - Base Candidate fields plus:
   * @param {object[]} params.contextConditions   - ≤ 3 context condition objects.
   * @param {object}   params.baseHypothesis      - The core hypothesis to test.
   * @param {string}   [params.conditionCombinator='all'] - 'all' or 'any'.
   * @returns {Promise<ConditionalHypothesis>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS,
    });
    const typeErrors = [];

    if (!Array.isArray(params.contextConditions))
      typeErrors.push('contextConditions: required array (may be empty for an unconditional hypothesis)');
    else if (params.contextConditions.length > MAX_CONTEXT_CONDITIONS)
      typeErrors.push(
        `contextConditions: ${params.contextConditions.length} conditions exceed the hard cap of ` +
        `${MAX_CONTEXT_CONDITIONS}. This cap is a Laboratory-wide anti-overfitting policy.`
      );

    if (!params.baseHypothesis || typeof params.baseHypothesis !== 'object' || Array.isArray(params.baseHypothesis))
      typeErrors.push('baseHypothesis: required plain object describing the core hypothesis');

    const combinator = params.conditionCombinator ?? CONDITION_COMBINATORS.ALL;
    if (!Object.values(CONDITION_COMBINATORS).includes(combinator))
      typeErrors.push(`conditionCombinator: must be one of [${Object.values(CONDITION_COMBINATORS).join(', ')}]`);

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS,
        fields: allErrors,
      });
    }

    const effectiveParams = { ...params, type: CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS };
    // Include type-specific identity fields in the fingerprint.
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        contextConditions: params.contextConditions,
        baseHypothesis: params.baseHypothesis,
        conditionCombinator: combinator,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new ConditionalHypothesis({
      ...common,
      // Object.freeze applied inside the constructor.
      contextConditions: [...params.contextConditions],
      baseHypothesis: { ...params.baseHypothesis },
      conditionCombinator: combinator,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      contextConditions: [...this.contextConditions],
      baseHypothesis: { ...this.baseHypothesis },
      conditionCombinator: this.conditionCombinator,
    };
  }
}
