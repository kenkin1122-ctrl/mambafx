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
 *   Stage D rejected -> advance to Stage F (Semi-Markov,
 *     statistics/semiMarkovTest.js, unmodified, reused) ONLY IF a
 *     `states` array was supplied (Stage F needs the preceding-event
 *     RISE/FALL label per gap, an input the earlier stages don't need --
 *     see runNullModelHierarchy's own parameter docs). Without `states`,
 *     the hierarchy stops at Stage D and reports honestly that
 *     advancement is warranted but cannot be attempted without that
 *     input, rather than silently skipping straight past Stage F.
 *   Stage F (Semi-Markov) detects real state-dependence -> STOP. The
 *     dependence Stage D found is explained by state-conditional gap
 *     distributions -- a genuine, well-characterized conclusion, not a
 *     failure to find something deeper.
 *   Stage F does NOT detect state-dependence -> STOP the C/D/E/F branch
 *     here. The state-conditioning explanation fails to account for the
 *     dependence found; real evidence that would motivate Stage G
 *     (Hawkes) or Stage H (HMM), which do NOT exist yet (each gets its
 *     own dedicated slice with its own synthetic validation, per the
 *     agreed pacing) -- reported honestly as "advancement warranted, not
 *     yet implemented," never silently dropped or overstated.
 *   Stage E always runs to completion once reached (it is descriptive,
 *     not a reject/advance test) and is one of the hierarchy's two
 *     possible terminal stages for this slice's scope (alongside Stage F).
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
 *   reused) and statistics/semiMarkovTest.js (testSemiMarkovStage --
 *   unmodified, reused); zero statistical logic is reimplemented here,
 *   this module is pure sequencing.
 * Public API: runNullModelHierarchy, HIERARCHY_CONCLUSIONS, NullModelHierarchyError.
 * Complexity: O(stage costs) -- at most one call to each of the three
 *   stage functions; never redundant.
 */

import { testPoissonStage, testRenewalStage, testRenewalDistributionStage } from './renewalProcessTests.js';
import { testSemiMarkovStage } from './semiMarkovTest.js';

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
  CONSISTENT_WITH_SEMI_MARKOV: 'consistent-with-semi-markov',
  DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED: 'dependence-detected-advancement-required',
});

/**
 * Runs the Null Model Hierarchy's Stages C-F in sequence, gated by each
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
 * @param {string[]} [options.states] - Parallel array to `gaps` (RISE/FALL
 *   preceding-event labels), required ONLY to attempt Stage F if Stage D
 *   rejects independence. If omitted, the hierarchy correctly stops at
 *   Stage D rather than silently skipping Stage F.
 * @param {number} [options.numPermutations=1000] - Stage F's permutation trial count.
 * @returns {{
 *   stagesRun: object[],
 *   finalStage: 'Poisson'|'Renewal'|'RenewalDistribution'|'SemiMarkov',
 *   conclusion: string (a HIERARCHY_CONCLUSIONS value),
 *   summary: string
 * }}
 */
export function runNullModelHierarchy(gaps, {
  alpha = 0.05, seed, numSimulations = 1000, maxLag = 5, cvTolerance = 0.1, states = null, numPermutations = 1000,
} = {}) {
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
    if (!states) {
      return {
        stagesRun,
        finalStage: 'Renewal',
        conclusion: HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED,
        summary: 'Gap sequence shows genuine dependence between successive gaps (rejected both Poisson and independence). Advancing to Stage F (Semi-Markov) would require a `states` array (RISE/FALL preceding-event labels), which was not supplied to this call. Stages G (Hawkes) and H (HMM) are not yet implemented in this codebase; each gets its own dedicated slice with its own synthetic validation before being trusted on real data.',
      };
    }

    // Stage F only ever runs because Stage D was just rejected, above, AND states was supplied.
    const stageF = testSemiMarkovStage(gaps, states, { alpha, seed, numPermutations });
    stagesRun.push(stageF);

    if (stageF.stateDependenceDetected) {
      return {
        stagesRun,
        finalStage: 'SemiMarkov',
        conclusion: HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_SEMI_MARKOV,
        summary: 'Gap sequence shows genuine dependence explained by preceding-event state (RISE vs FALL gap distributions differ significantly) -- a semi-Markov process, not necessarily deeper self-excitation or hidden state.',
      };
    }

    return {
      stagesRun,
      finalStage: 'SemiMarkov',
      conclusion: HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED,
      summary: 'Gap sequence shows genuine dependence NOT explained by preceding-event state (Stage F found no significant RISE/FALL gap-distribution difference). This would warrant advancing to Hawkes (Stage G) or Hidden Markov Model (Stage H) stages -- not yet implemented in this codebase; each gets its own dedicated slice with its own synthetic validation before being trusted on real data.',
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
