/**
 * research/src/statistics/semiMarkovTest.js
 *
 * Purpose:
 *   Stage F of Protocol P12-GAP's Null Model Hierarchy -- reached only
 *   when Stage D (Renewal, statistics/renewalProcessTests.js) has
 *   REJECTED independence, i.e. real dependence between successive gaps
 *   has already been found. Stage F asks the most parsimonious
 *   explanation for that dependence first: does the gap distribution
 *   simply depend on which STATE the process is in (the direction of the
 *   PRECEDING event -- RISE or FALL, the two states this research
 *   question's own event data naturally provides), rather than requiring
 *   genuine temporal self-excitation (Stage G, Hawkes) or a hidden,
 *   unobserved state (Stage H, HMM)? A semi-Markov process is exactly
 *   this: state transitions follow a Markov chain, but each state's own
 *   sojourn-time (here, gap) distribution can be arbitrary and
 *   state-specific -- more general than a homogeneous renewal process
 *   (Stage D's null), but simpler than full self-excitation or hidden state.
 *
 * TEST: two-sample comparison of the gap distribution conditional on
 *   preceding-event state (RISE vs FALL) via the two-sample
 *   Kolmogorov-Smirnov statistic, calibrated by a LABEL-PERMUTATION test
 *   (shuffle which state label is attached to which gap, recompute the
 *   statistic, repeat) rather than any closed-form asymptotic formula.
 *   This deliberately avoids the exact class of pitfall found and fixed
 *   in Stage C (the Lilliefors bias, where fitting a distribution's
 *   parameters from the same sample being tested invalidates the
 *   standard asymptotic p-value) -- no parameters are fitted here at
 *   all; the null hypothesis under test is simply "the state label
 *   carries no information about which gap distribution a given gap
 *   value came from," which permutation-based calibration tests directly
 *   and correctly by construction, with no analogous bias to introduce.
 *
 * SCOPE, disclosed not hidden: this stage supports exactly 2 states
 *   (RISE/FALL preceding-event direction) -- the only states this
 *   research question's own event data naturally provides via the
 *   existing AlternatingRun-adjacent event schema. Generalizing to k>2
 *   states (e.g. a coarser market-regime label) would need either an
 *   omnibus multi-sample test or pairwise comparisons with multiple-
 *   comparison correction -- flagged as a possible future extension, not
 *   silently implied to already exist.
 *
 * ADVANCEMENT IMPLICATION (reported, not enforced here -- that is the
 *   orchestrator's job, mirroring statistics/nullModelHierarchy.js's own
 *   separation of "compute a stage result" from "decide what to do
 *   next"): if the two states' gap distributions differ significantly,
 *   that IS a plausible, well-characterized explanation for Stage D's
 *   rejection -- semi-Markov structure, not necessarily deeper self-
 *   excitation or hidden state. If they do NOT differ significantly, the
 *   state-conditioning explanation fails to account for the dependence
 *   Stage D found, motivating further advancement to Stage G (Hawkes).
 *
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng --
 *   unmodified, reused for the permutation null, same discipline as
 *   every Monte Carlo procedure elsewhere in this codebase).
 * Public API: twoSampleKolmogorovSmirnovStatistic, testSemiMarkovStage,
 *   SemiMarkovTestError.
 * Complexity: O(n log n) per statistic computation (sorting); O(numPermutations
 *   * n log n) for the calibrated p-value.
 */

import { createSeededRng } from './uncertaintyEstimation.js';

export class SemiMarkovTestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SemiMarkovTestError';
  }
}

/**
 * The two-sample Kolmogorov-Smirnov statistic: the maximum absolute
 * difference between two samples' empirical CDFs, evaluated at every
 * distinct value in their pooled union.
 * @param {number[]} sampleA
 * @param {number[]} sampleB
 * @returns {number}
 */
export function twoSampleKolmogorovSmirnovStatistic(sampleA, sampleB) {
  const sortedA = [...sampleA].sort((a, b) => a - b);
  const sortedB = [...sampleB].sort((a, b) => a - b);
  const pooled = [...new Set([...sortedA, ...sortedB])].sort((a, b) => a - b);
  const nA = sortedA.length, nB = sortedB.length;

  function ecdfAt(sorted, n, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= x) lo = mid + 1; else hi = mid;
    }
    return lo / n;
  }

  let maxDiff = 0;
  for (const x of pooled) {
    const diff = Math.abs(ecdfAt(sortedA, nA, x) - ecdfAt(sortedB, nB, x));
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff;
}

/**
 * Stage F: tests whether the gap distribution depends on the preceding
 * event's state (RISE vs FALL), via a label-permutation-calibrated
 * two-sample KS test.
 *
 * @param {number[]} gaps - Real, positive gap values.
 * @param {string[]} states - Parallel array (same length as gaps), each
 *   entry either 'RISE' or 'FALL' -- the direction of the event that
 *   preceded the corresponding gap.
 * @param {object} [options]
 * @param {number} options.seed - Required (no hidden randomness).
 * @param {number} [options.numPermutations=1000]
 * @param {number} [options.alpha=0.05]
 * @returns {{
 *   stage: 'SemiMarkov', ksStatistic: number, pValue: number,
 *   riseSampleSize: number, fallSampleSize: number, numPermutations: number,
 *   stateDependenceDetected: boolean
 * }}
 */
export function testSemiMarkovStage(gaps, states, { seed, numPermutations = 1000, alpha = 0.05 } = {}) {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    throw new SemiMarkovTestError('testSemiMarkovStage: gaps must be a non-empty array');
  }
  if (!Array.isArray(states) || states.length !== gaps.length) {
    throw new SemiMarkovTestError('testSemiMarkovStage: states must be an array of the same length as gaps');
  }
  if (!gaps.every((g) => Number.isFinite(g) && g > 0)) {
    throw new SemiMarkovTestError('testSemiMarkovStage: every gap must be a finite, strictly positive number');
  }
  if (!states.every((s) => s === 'RISE' || s === 'FALL')) {
    throw new SemiMarkovTestError('testSemiMarkovStage: every state must be exactly "RISE" or "FALL" (2-state scope -- see module header)');
  }
  if (seed === undefined || seed === null) {
    throw new SemiMarkovTestError('testSemiMarkovStage: an explicit seed is required (no hidden randomness)');
  }

  const riseGaps = gaps.filter((_, i) => states[i] === 'RISE');
  const fallGaps = gaps.filter((_, i) => states[i] === 'FALL');
  if (riseGaps.length < 2 || fallGaps.length < 2) {
    throw new SemiMarkovTestError(`testSemiMarkovStage: need at least 2 gaps in each state, got RISE=${riseGaps.length} FALL=${fallGaps.length}`);
  }

  const observedD = twoSampleKolmogorovSmirnovStatistic(riseGaps, fallGaps);

  const rng = createSeededRng(seed);
  let atLeastAsExtreme = 0;
  for (let perm = 0; perm < numPermutations; perm++) {
    const shuffledStates = [...states];
    for (let i = shuffledStates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffledStates[i], shuffledStates[j]] = [shuffledStates[j], shuffledStates[i]];
    }
    const permRise = gaps.filter((_, i) => shuffledStates[i] === 'RISE');
    const permFall = gaps.filter((_, i) => shuffledStates[i] === 'FALL');
    const permD = twoSampleKolmogorovSmirnovStatistic(permRise, permFall);
    if (permD >= observedD) atLeastAsExtreme++;
  }
  const pValue = atLeastAsExtreme / numPermutations;

  return {
    stage: 'SemiMarkov', ksStatistic: observedD, pValue,
    riseSampleSize: riseGaps.length, fallSampleSize: fallGaps.length,
    numPermutations, stateDependenceDetected: pValue < alpha,
  };
}
