/**
 * research/src/eventProcess/EventProcessConfirmationProcedure.js
 *
 * Purpose:
 *   The statistical procedure EventProcessFeature candidates register in
 *   bridge/StatisticalProcedureRegistry.js (refinement #4's own purpose:
 *   "the Null Model Hierarchy as a pluggable statistical procedure
 *   resolved by a registry"). This is where the completed 6-stage
 *   hierarchy (statistics/nullModelHierarchy.js, unmodified, reused)
 *   actually enters Confirmation as a real, callable procedure for the
 *   first time -- everything built in this domain up to now
 *   (EventFeatureRegistry, EventProcessFeature, the stream generator, the
 *   Null Model Hierarchy itself) has been infrastructure; this module is
 *   the piece that connects it to the SAME dispatch mechanism every
 *   other candidate type's confirmation already goes through.
 *
 * A REAL SCOPING QUESTION, resolved explicitly rather than glossed over:
 *   the Null Model Hierarchy's every stage requires strictly positive,
 *   waiting-time-shaped values (renewalProcessTests.js's own
 *   assertValidGapSample rejects anything <= 0) -- it is built for
 *   GAP-LIKE features (TimeGap, TickGap), not for every
 *   EventFeatureRegistry plugin. AlternatingRun, for example, emits
 *   {0, 1, null} -- a binary indicator, not a waiting time -- and running
 *   the Null Model Hierarchy against it would either throw outright or
 *   (worse) silently produce a meaningless result if it happened to pass
 *   validation by coincidence. Since bridge/StatisticalProcedureRegistry.js
 *   dispatches by CANDIDATE TYPE alone (EVENT_PROCESS_FEATURE), not by
 *   the candidate's own featureName, this module itself must make that
 *   distinction -- GAP_LIKE_FEATURES below is the explicit, disclosed
 *   list of featureName values this procedure actually knows how to
 *   test. A featureName outside that list throws a clear
 *   "no statistical procedure for this feature yet" error rather than
 *   silently misapplying gap-shaped statistics to non-gap-shaped data.
 *
 * SCOPE OF THIS SLICE: registers the hierarchy as a real, callable,
 *   tested procedure. Does NOT (a separate, later slice) wire
 *   Confirmation's real live-analysis entry point
 *   (bridge/Phase11ConfirmationBridge.js / the orchestrator) to actually
 *   CALL StatisticalProcedureRegistry.run() during a live campaign --
 *   that is a larger, separate integration task, deliberately deferred
 *   per this project's own "one real, tested, bounded piece per slice"
 *   discipline, same as every prior Phase 12 slice.
 *
 * Dependencies: statistics/nullModelHierarchy.js (runNullModelHierarchy,
 *   HIERARCHY_CONCLUSIONS -- unmodified, reused; zero statistical logic
 *   is reimplemented here, this module is pure adaptation), candidate/Candidate.js
 *   (CANDIDATE_TYPES, read-only).
 * Public API: GAP_LIKE_FEATURES, runEventProcessFeatureConfirmation,
 *   registerEventProcessProcedures, EventProcessConfirmationError.
 * Complexity: O(hierarchy cost) -- delegates entirely to
 *   runNullModelHierarchy; this module adds only O(1) dispatch overhead.
 */

import { runNullModelHierarchy, HIERARCHY_CONCLUSIONS } from '../statistics/nullModelHierarchy.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

export class EventProcessConfirmationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventProcessConfirmationError';
  }
}

/**
 * The explicit, disclosed set of EventFeatureRegistry featureName values
 * the Null Model Hierarchy is a valid statistical procedure for --
 * strictly positive, waiting-time-shaped features only. Any featureName
 * not in this set has no registered procedure yet (see module header).
 */
export const GAP_LIKE_FEATURES = Object.freeze(['TimeGap', 'TickGap']);

/**
 * The statistical procedure registered for EVENT_PROCESS_FEATURE
 * candidates in bridge/StatisticalProcedureRegistry.js. Matches the same
 * ({candidate, ...params}) -> report shape every other registered
 * procedure follows, but returns the Null Model Hierarchy's own natural
 * result shape ({stagesRun, finalStage, conclusion, summary}) rather than
 * forcing it into the pre-Phase-12 permutation-test report shape -- the
 * hierarchy is a genuinely different kind of statistical procedure (a
 * multi-stage structural discovery, not a single hypothesis test with
 * one p-value), and reshaping it to fit a p-value-centric report would
 * lose real information (which stages ran, which structural model, if
 * any, explained the dependence).
 *
 * @param {object} params
 * @param {object} params.candidate - Must be type EVENT_PROCESS_FEATURE.
 * @param {number[]} params.gaps - The real gap series for this
 *   candidate's featureName, resolved by the caller from real event data
 *   (this function does not resolve it itself, mirroring how
 *   runAutomatedConfirmationTest requires the caller to supply `prices`).
 * @param {string[]} [params.states] - Passed through to Stage F, if provided.
 * @param {number} params.seed - Required (no hidden randomness).
 * @param {number} [params.alpha=0.05]
 * @param {number} [params.numSimulations] - Stage C's Monte Carlo trial count.
 * @param {number} [params.maxLag] - Stage D's max autocorrelation lag.
 * @param {number} [params.cvTolerance] - Stage E's exponential-like tolerance band.
 * @param {number} [params.numPermutations] - Stage F's permutation trial count.
 * @param {number} [params.hawkesNumSimulations] - Stage G's Monte Carlo trial count.
 * @param {number} [params.hmmNumSimulations] - Stage H's Monte Carlo trial count.
 * @returns {ReturnType<import('../statistics/nullModelHierarchy.js').runNullModelHierarchy>}
 */
export function runEventProcessFeatureConfirmation(params = {}) {
  const { candidate, gaps, ...hierarchyOptions } = params;

  if (!candidate || candidate.type !== CANDIDATE_TYPES.EVENT_PROCESS_FEATURE) {
    throw new EventProcessConfirmationError(
      `runEventProcessFeatureConfirmation: expected a candidate of type "${CANDIDATE_TYPES.EVENT_PROCESS_FEATURE}", got "${candidate?.type}"`
    );
  }
  if (!GAP_LIKE_FEATURES.includes(candidate.featureName)) {
    throw new EventProcessConfirmationError(
      `runEventProcessFeatureConfirmation: no statistical procedure is registered yet for featureName "${candidate.featureName}" -- ` +
      `the Null Model Hierarchy is only valid for gap-like (strictly positive, waiting-time) features: ${GAP_LIKE_FEATURES.join(', ')}. ` +
      `A candidate for a non-gap-like feature (e.g. AlternatingRun) must never be silently tested with gap-shaped statistics.`
    );
  }
  if (!Array.isArray(gaps) || gaps.length === 0) {
    throw new EventProcessConfirmationError('runEventProcessFeatureConfirmation: params.gaps must be a non-empty array (the real gap series for this feature, resolved by the caller)');
  }

  return runNullModelHierarchy(gaps, hierarchyOptions);
}

/**
 * Registers this domain's statistical procedure into a
 * StatisticalProcedureRegistry -- kept here, in the Event Process
 * domain's own module, rather than inside bridge/StatisticalProcedureRegistry.js
 * itself, so the generic registry never needs to import from (or know
 * anything about) a specific domain -- each domain registers ITSELF into
 * the generic registry, never the reverse. Mirrors
 * eventProcess/coreEventFeatures.js's own registerCoreEventFeatures()
 * pattern for the Feature Extractor layer.
 *
 * @param {import('../bridge/StatisticalProcedureRegistry.js').StatisticalProcedureRegistry} registry
 * @returns {import('../bridge/StatisticalProcedureRegistry.js').StatisticalProcedureRegistry} the same registry, for chaining.
 */
export function registerEventProcessProcedures(registry) {
  registry.register(CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, runEventProcessFeatureConfirmation);
  return registry;
}

export { HIERARCHY_CONCLUSIONS };
