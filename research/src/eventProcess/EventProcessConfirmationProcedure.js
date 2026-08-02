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
 *   registerEventProcessProcedures, extractConfirmationPValue,
 *   computeEventProcessPartitionStatistics, EventProcessConfirmationError.
 * Complexity: O(hierarchy cost) -- delegates entirely to
 *   runNullModelHierarchy; this module adds only O(1) dispatch overhead.
 */

import { runNullModelHierarchy, HIERARCHY_CONCLUSIONS } from '../statistics/nullModelHierarchy.js';
import { fitExponentialMLE, kolmogorovSmirnovStatistic, exponentialCDF } from '../statistics/renewalProcessTests.js';
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

/**
 * Extracts the SINGLE p-value to submit to alpha-spending
 * (discoveryDecision.js's evaluateDiscoveryCandidate(), via
 * bridge/Phase11ConfirmationBridge.js's confirmPhase11Candidate() --
 * neither touched by this module) for a completed Null Model Hierarchy
 * run: Stage C's (Poisson) p-value, ALWAYS.
 *
 * WHY STAGE C, not whichever stage produced the final conclusion -- a
 * real design decision, resolved here explicitly rather than left
 * ambiguous:
 *
 *   Online FDR's own correctness REQUIRES submitting exactly one p-value
 *   per candidate, for EVERY candidate that reaches Confirmation,
 *   regardless of outcome -- refusing to submit "uninteresting" results
 *   (e.g. Poisson-consistent candidates) would break the sequential
 *   wealth-tracking guarantee the whole Online FDR mechanism depends on.
 *   This rules out "only submit a p-value when something interesting was
 *   found."
 *
 *   Submitting a DIFFERENT stage's p-value depending on how far the
 *   cascade advanced (Stage C's for a Poisson-consistent candidate,
 *   Stage F's for a semi-Markov-explained one, Stage H's for a hidden-
 *   Markov-explained one, etc.) would mean each candidate's "primary
 *   test" is a DIFFERENT statistical procedure depending on its own
 *   outcome -- a well-known problem (the specific test chosen is itself
 *   a function of the data), and would additionally require its own
 *   multi-stage alpha-correction scheme (Stages D through H would each
 *   need to spend SOME alpha too, on top of Stage C, requiring a
 *   Bonferroni-style split of the family's alpha budget across up to 5
 *   further tests -- a substantially larger governance change than this
 *   slice's scope, and one this project's own "no unregistered analyses,
 *   no relaxed stopping rules" discipline would require pre-registering
 *   explicitly before ever spending against it).
 *
 *   Stage C -- "is this gap sequence consistent with a homogeneous
 *   Poisson process" -- is the ONE test every EventProcessFeature
 *   candidate always undergoes, first, with a real, well-defined,
 *   Monte-Carlo-calibrated p-value (see statistics/renewalProcessTests.js's
 *   own Lilliefors-bias fix). Treating it as the pre-registered primary
 *   test, and everything past it (Stages D-H) as EXPLORATORY structural
 *   characterization of an already-statistically-established rejection
 *   -- not a second, third, fourth independent confirmatory test each
 *   consuming its own alpha -- is the simplest, cleanest, most standard
 *   sequential-testing discipline available, and requires no change to
 *   any protected governance module.
 *
 * @param {ReturnType<import('../statistics/nullModelHierarchy.js').runNullModelHierarchy>} hierarchyResult
 * @returns {number} Stage C's p-value.
 */
export function extractConfirmationPValue(hierarchyResult) {
  if (!hierarchyResult || !Array.isArray(hierarchyResult.stagesRun) || hierarchyResult.stagesRun.length === 0) {
    throw new EventProcessConfirmationError('extractConfirmationPValue: hierarchyResult must be a real runNullModelHierarchy() result with at least one stage run');
  }
  const stageC = hierarchyResult.stagesRun[0];
  if (stageC.stage !== 'Poisson' || typeof stageC.pValue !== 'number') {
    throw new EventProcessConfirmationError('extractConfirmationPValue: stagesRun[0] must be the Poisson stage with a real pValue -- the hierarchy always runs Stage C first, this indicates a malformed or foreign result object');
  }
  return stageC.pValue;
}

/**
 * Computes real, per-partition "effect sizes" for replication --
 * analysis/DiscoveryStabilityAnalysis.js's computeDiscoveryStabilityIndex()
 * (unmodified, reused via replicatePhase11Candidate, not called directly
 * here), applied to Stage C's KS statistic -- the SAME primary test
 * whose p-value is submitted for confirmation (see
 * extractConfirmationPValue's own reasoning for why Stage C, not
 * whichever stage the cascade happened to reach, is the one quantity
 * treated as this candidate's confirmable/replicable statistic).
 *
 * A REAL, DISCLOSED LIMITATION, not silently worked around: this reuses
 * fitExponentialMLE/kolmogorovSmirnovStatistic (statistics/renewalProcessTests.js,
 * unmodified) to compute each partition's KS statistic against a fitted
 * exponential -- and a KS statistic is ALWAYS NON-NEGATIVE by
 * construction. computeDiscoveryStabilityIndex's sign-agreement
 * component (does the effect consistently point the same direction
 * across partitions, e.g. a momentum indicator's correlation being
 * consistently positive) is therefore TRIVIALLY satisfied here every
 * time (every KS statistic has the same "sign," +1) -- not wrong, but
 * contributing zero real discriminating information for this candidate
 * type. The stability index effectively reduces to
 * computeDiscoveryStabilityIndex's OTHER component, magnitudeConsistency
 * -- does the SIZE of the Poisson-rejection signal replicate consistently
 * across independent held-out partitions -- which remains a genuinely
 * meaningful replication check on its own. This limitation is inherent to
 * applying a signed-effect-size-shaped stability metric to an
 * unsigned test statistic, not a defect in this function; documented
 * here rather than silently accepted without comment.
 *
 * @param {number[]} gaps - A real, held-out replication dataset's gap series.
 * @param {number} partitionCount - Number of contiguous partitions (>= 2).
 * @returns {{ partitionEffectSizes: number[], pooledEffectSize: number }}
 */
export function computeEventProcessPartitionStatistics(gaps, partitionCount) {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    throw new EventProcessConfirmationError('computeEventProcessPartitionStatistics: gaps must be a non-empty array');
  }
  if (!Number.isInteger(partitionCount) || partitionCount < 2) {
    throw new EventProcessConfirmationError('computeEventProcessPartitionStatistics: partitionCount must be an integer >= 2');
  }
  const MIN_GAPS_PER_PARTITION = 10;
  const partitionSize = Math.floor(gaps.length / partitionCount);
  if (partitionSize < MIN_GAPS_PER_PARTITION) {
    throw new EventProcessConfirmationError(
      `computeEventProcessPartitionStatistics: not enough gaps (${gaps.length}) to form ${partitionCount} partitions of at least ${MIN_GAPS_PER_PARTITION} each`
    );
  }

  const partitionEffectSizes = [];
  for (let p = 0; p < partitionCount; p++) {
    const start = p * partitionSize;
    const end = p === partitionCount - 1 ? gaps.length : start + partitionSize; // last partition absorbs any remainder
    const partitionGaps = gaps.slice(start, end);
    const { lambda } = fitExponentialMLE(partitionGaps);
    partitionEffectSizes.push(kolmogorovSmirnovStatistic(partitionGaps, (x) => exponentialCDF(x, lambda)));
  }

  const { lambda: pooledLambda } = fitExponentialMLE(gaps);
  const pooledEffectSize = kolmogorovSmirnovStatistic(gaps, (x) => exponentialCDF(x, pooledLambda));

  return { partitionEffectSizes, pooledEffectSize };
}

export { HIERARCHY_CONCLUSIONS };
