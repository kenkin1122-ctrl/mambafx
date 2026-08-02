/**
 * research/src/statistics/nullModelHierarchy.js
 *
 * Purpose:
 *   The advancement-gate orchestration for Protocol P12-GAP's Null Model
 *   Hierarchy -- sequences the individual stage tests in
 *   renewalProcessTests.js (Poisson -> Renewal -> Renewal Distribution,
 *   unmodified, reused) according to the protocol's own rule: "No stage
 *   may execute until every advancement criterion is satisfied." Built
 *   deliberately AFTER Stages C/D/E already existed and were validated
 *   independently, so this orchestrator has real stage results to gate
 *   between rather than hypothetical ones (the agreed pacing from the
 *   preceding scope/pacing check-in).
 *
 * ADVANCEMENT LOGIC (the scientific reasoning, not just code structure):
 *   the hierarchy tests increasingly complex models, advancing to a MORE
 *   complex model ONLY when the SIMPLER one is REJECTED by the evidence
 *   -- never runs a more complex stage "just in case." This is the
 *   standard scientific-modeling discipline against overfitting: don't
 *   reach for Hawkes-process self-excitation to explain data that a
 *   homogeneous Poisson process already explains perfectly well.
 *
 *   Stage C (Poisson) consistent  -> STOP. Simplest model suffices; this
 *     IS the expected, most likely outcome on a near-i.i.d. tick
 *     generator (per the accompanying scientific design review), and a
 *     genuine, successful negative result, not a failed search.
 *   Stage C rejected -> advance to Stage D (is it AT LEAST a general
 *     i.i.d. renewal process, even if not exponential?).
 *   Stage D (Renewal/independence) consistent -> advance to Stage E
 *     (characterize which distribution it actually is).
 *   Stage D rejected -> STOP the C/D/E branch here. Genuine dependence
 *     between successive gaps has been found -- real evidence that would
 *     motivate Stages F/G/H (Semi-Markov/Hawkes/HMM), which explicitly
 *     model dependence/self-excitation/hidden state. Those stages do NOT
 *     exist yet (each gets its own dedicated slice with its own synthetic
 *     validation, per the agreed pacing) -- this is reported honestly as
 *     "advancement warranted, not yet implemented," never silently
 *     dropped or misreported as a stronger conclusion than the evidence
 *     supports.
 *   Stage E always runs to completion once reached (it is descriptive,
 *     not a reject/advance test) and is the hierarchy's terminal stage
 *     for this slice's scope.
 *
 * STRUCTURAL ENFORCEMENT of "no stage may execute until every
 *   advancement criterion is satisfied": each stage's decision to invoke
 *   the next is a single, explicit boolean check on the PRECEDING stage's
 *   own already-computed result -- there is no code path that could call
 *   testRenewalStage before testPoissonStage has returned, or
 *   testRenewalDistributionStage before testRenewalStage has returned and
 *   confirmed independence. Verified by test via a call-count/call-order
 *   spy, not just by reading the reject/advance branches.
 *
 * Dependencies: statistics/renewalProcessTests.js (testPoissonStage,
 *   testRenewalStage, testRenewalDistributionStage -- all unmodified,
 *   reused; zero statistical logic is reimplemented here, this module is
 *   pure sequencing).
 * Public API: runNullModelHierarchy, HIERARCHY_CONCLUSIONS, NullModelHierarchyError.
 * Complexity: O(stage costs) -- at most one call to each of the three
 *   stage functions; never redundant.
 */

import { testPoissonStage, testRenewalStage, testRenewalDistributionStage } from './renewalProcessTests.js';

export class NullModelHierarchyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NullModelHierarchyError';
  }
}

/** Possible values of the hierarchy result's `conclusion` field. */
export const HIERARCHY_CONCLUSIONS = Object.freeze({
  CONSISTENT_WITH_POISSON: 'consistent-with-poisson',
  CONSISTENT_WITH_RENEWAL_NON_EXPONENTIAL: 'consistent-with-renewal-non-exponential',
  DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED: 'dependence-detected-advancement-required',
});

/**
 * Runs the Null Model Hierarchy's Stages C-E in sequence, gated by each
 * stage's own advancement criterion, and returns which stages actually
 * ran plus the overall conclusion.
 *
 * @param {number[]} gaps - Real, positive gap values.
 * @param {object} [options]
 * @param {number} [options.alpha=0.05]
 * @param {number} options.seed - Required (Stage C's Monte Carlo
 *   calibration needs it; no hidden randomness).
 * @param {number} [options.numSimulations=1000] - Stage C's Monte Carlo trial count.
 * @param {number} [options.maxLag=5] - Stage D's max autocorrelation lag.
 * @param {number} [options.cvTolerance=0.1] - Stage E's exponential-like tolerance band.
 * @returns {{
 *   stagesRun: object[],
 *   finalStage: 'Poisson'|'Renewal'|'RenewalDistribution',
 *   conclusion: string (a HIERARCHY_CONCLUSIONS value),
 *   summary: string
 * }}
 */
export function runNullModelHierarchy(gaps, { alpha = 0.05, seed, numSimulations = 1000, maxLag = 5, cvTolerance = 0.1 } = {}) {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    throw new NullModelHierarchyError('runNullModelHierarchy: gaps must be a non-empty array');
  }
  if (seed === undefined || seed === null) {
    throw new NullModelHierarchyError('runNullModelHierarchy: an explicit seed is required (Stage C needs it; no hidden randomness)');
  }

  const stagesRun = [];

  // Stage C -- always runs first; it is the hierarchy's entry point.
  const stageC = testPoissonStage(gaps, { alpha, seed, numSimulations });
  stagesRun.push(stageC);

  if (stageC.consistentWithPoisson) {
    return {
      stagesRun,
      finalStage: 'Poisson',
      conclusion: HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_POISSON,
      summary: 'Gap sequence is consistent with a homogeneous Poisson process (memoryless, i.i.d. exponential inter-arrival times). No further model complexity is warranted by the evidence.',
    };
  }

  // Stage D only ever runs because Stage C was just rejected, above.
  const stageD = testRenewalStage(gaps, { alpha, maxLag });
  stagesRun.push(stageD);

  if (!stageD.consistentWithIndependence) {
    return {
      stagesRun,
      finalStage: 'Renewal',
      conclusion: HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED,
      summary: 'Gap sequence shows genuine dependence between successive gaps (rejected both Poisson and independence). This would warrant advancing to Semi-Markov, Hawkes, or Hidden Markov Model stages (F/G/H) -- not yet implemented in this codebase; each gets its own dedicated slice with its own synthetic validation before being trusted on real data.',
    };
  }

  // Stage E only ever runs because Stage D was just confirmed, above.
  const stageE = testRenewalDistributionStage(gaps, { cvTolerance });
  stagesRun.push(stageE);

  return {
    stagesRun,
    finalStage: 'RenewalDistribution',
    conclusion: HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_RENEWAL_NON_EXPONENTIAL,
    summary: `Gap sequence is a genuine renewal process (independent inter-arrival times) but not exponential -- characterized as ${stageE.classification} (coefficient of variation = ${stageE.coefficientOfVariation.toFixed(3)}).`,
  };
}
