/**
 * research/src/bridge/StatisticalProcedureRegistry.js
 *
 * Purpose:
 *   Refinement #4 from the approved Phase 12 design review: "Implement
 *   the Null Model Hierarchy as a pluggable statistical procedure
 *   resolved by a registry rather than hard-coded type checks in
 *   Confirmation."
 *
 *   Today, all 5 pre-Phase-12 candidate types (IndicatorFeature,
 *   MarketState, ProxyCandidate, CompositeCandidate, ConditionalHypothesis)
 *   share ONE statistical procedure -- a permutation test on Pearson
 *   correlation, in bridge/Phase11AutomatedConfirmation.js's
 *   runAutomatedConfirmationTest() -- differing only in how their feature
 *   series is RESOLVED (bridge/Phase11CandidateFeatureResolver.js's
 *   dispatch), never in what STATISTICAL TEST is applied. A single
 *   type-check branch for resolution was tolerable at that scale.
 *
 *   EventProcessFeature is the first candidate type needing a genuinely
 *   DIFFERENT statistical procedure (the Null Model Hierarchy -- Poisson,
 *   Renewal, Renewal Distribution, Semi-Markov, Hawkes, HMM -- not a
 *   correlation permutation test at all). Growing runAutomatedConfirmationTest
 *   with more `if (type === X) runProcedureY()` branches as procedures
 *   diverge would violate the same "no duplicated/branching scoring path"
 *   principle this whole project's Stage 11 audit specifically checked
 *   for, and would couple every future candidate type's confirmation
 *   logic to one shared, ever-growing function. A registry avoids both.
 *
 * THIS SLICE is infrastructure only -- StatisticalProcedureRegistry itself,
 *   plus registration of the EXISTING permutation-test procedure
 *   (wrapping runAutomatedConfirmationTest() UNMODIFIED) for the 5
 *   pre-Phase-12 types, proving the mechanism end-to-end. It does NOT yet
 *   refactor runAutomatedConfirmationTest() to consult this registry
 *   internally, and does NOT yet register a procedure for
 *   EventProcessFeature (the Null Model Hierarchy does not exist yet --
 *   that is a separate, later slice, at which point THIS registry is
 *   where its procedure gets registered, and THAT slice is where
 *   Confirmation's real entry point starts consulting this registry
 *   instead of calling runAutomatedConfirmationTest() unconditionally).
 *   Disclosed here rather than silently deferred.
 *
 * A "procedure" is any function matching runAutomatedConfirmationTest()'s
 *   own parameter/return shape ({candidate, ...} -> report) -- this
 *   registry does not define a new report shape; it dispatches to
 *   whichever existing or future function already produces one.
 *
 * Dependencies: candidate/Candidate.js (CANDIDATE_TYPES, read-only),
 *   bridge/Phase11AutomatedConfirmation.js (runAutomatedConfirmationTest --
 *   unmodified, wrapped, not reimplemented).
 * Public API: StatisticalProcedureRegistry, StatisticalProcedureRegistryError,
 *   registerCorePermutationTestProcedures.
 * Complexity: O(1) register/lookup/has/unregister; O(n) list/listTypes.
 */

import { CANDIDATE_TYPES } from '../candidate/Candidate.js';
import { runAutomatedConfirmationTest } from './Phase11AutomatedConfirmation.js';

export class StatisticalProcedureRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatisticalProcedureRegistryError';
  }
}

/**
 * Registry mapping a candidate TYPE (a CANDIDATE_TYPES value) to the
 * statistical procedure function that tests candidates of that type.
 *
 * Deliberately NOT a plugin registry in the PluginContract sense (a
 * procedure is a single function matching runAutomatedConfirmationTest's
 * shape, not a ScientificPlugin with metadata()/compute()/tests()/etc.)
 * -- this is dispatch infrastructure for STATISTICAL TESTS, a different
 * concern from the four PluginContract-based Feature Extractor registries.
 */
export class StatisticalProcedureRegistry {
  /** @type {Map<string, Function>} candidateType -> procedure function */
  #procedures = new Map();

  /**
   * Registers a statistical procedure for a candidate type.
   *
   * @param {string} candidateType - A CANDIDATE_TYPES value.
   * @param {Function} procedureFn - A function matching
   *   runAutomatedConfirmationTest's ({candidate, ...params}) -> report shape.
   * @returns {this} for chaining.
   */
  register(candidateType, procedureFn) {
    if (!candidateType || typeof candidateType !== 'string') {
      throw new StatisticalProcedureRegistryError('register: candidateType must be a non-empty string');
    }
    if (typeof procedureFn !== 'function') {
      throw new StatisticalProcedureRegistryError(`register: procedureFn for "${candidateType}" must be a function`);
    }
    if (this.#procedures.has(candidateType)) {
      throw new StatisticalProcedureRegistryError(`register: a procedure is already registered for candidate type "${candidateType}"`);
    }
    this.#procedures.set(candidateType, procedureFn);
    return this;
  }

  /**
   * Returns the procedure function registered for the given candidate
   * type, or undefined if none is registered.
   * @param {string} candidateType
   * @returns {Function|undefined}
   */
  lookup(candidateType) {
    return this.#procedures.get(candidateType);
  }

  /** @param {string} candidateType @returns {boolean} */
  has(candidateType) {
    return this.#procedures.has(candidateType);
  }

  /** @returns {Function[]} */
  list() {
    return [...this.#procedures.values()];
  }

  /** @returns {string[]} */
  listTypes() {
    return [...this.#procedures.keys()];
  }

  /** @param {string} candidateType @returns {boolean} */
  unregister(candidateType) {
    return this.#procedures.delete(candidateType);
  }

  /** @returns {number} */
  get size() {
    return this.#procedures.size;
  }

  /**
   * Resolves and invokes the registered procedure for params.candidate's
   * type. Throws StatisticalProcedureRegistryError (not a silent
   * fallback) if no procedure is registered for that type -- an
   * unregistered candidate type must never silently receive the wrong
   * test, or none at all.
   *
   * @param {object} params - Passed through unchanged to the resolved
   *   procedure function; must include params.candidate.
   * @returns {*} whatever the resolved procedure returns.
   */
  run(params) {
    const candidateType = params?.candidate?.type;
    const procedure = this.lookup(candidateType);
    if (!procedure) {
      throw new StatisticalProcedureRegistryError(
        `run: no statistical procedure is registered for candidate type "${candidateType}" -- an unregistered type must never silently fall back to the wrong test`
      );
    }
    return procedure(params);
  }
}

/**
 * Registers the EXISTING permutation-test procedure (wrapping
 * runAutomatedConfirmationTest UNMODIFIED) for all 5 pre-Phase-12
 * candidate types, proving zero-behavior-change: any of these types
 * resolved through this registry produces the exact same report
 * runAutomatedConfirmationTest already produced calling it directly.
 *
 * @param {StatisticalProcedureRegistry} registry
 * @returns {StatisticalProcedureRegistry} the same registry, for chaining.
 */
export function registerCorePermutationTestProcedures(registry) {
  const PRE_PHASE12_TYPES = [
    CANDIDATE_TYPES.INDICATOR_FEATURE,
    CANDIDATE_TYPES.MARKET_STATE,
    CANDIDATE_TYPES.PROXY_CANDIDATE,
    CANDIDATE_TYPES.COMPOSITE_CANDIDATE,
    CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS,
  ];
  for (const type of PRE_PHASE12_TYPES) {
    registry.register(type, runAutomatedConfirmationTest);
  }
  return registry;
}
