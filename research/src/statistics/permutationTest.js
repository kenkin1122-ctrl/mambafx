/**
 * research/src/statistics/permutationTest.js
 *
 * Purpose:
 *   Provide the permutation-test primitive the Randomness Audit (Priority
 *   3, Final Core Research Pipeline Implementation) needs to answer "is
 *   this observed effect distinguishable from random chance" — the one
 *   statistical building block named in the brief that did not already
 *   exist anywhere in research/src (discoveryDecision.js's own header is
 *   explicit that it "accepts one [p-value] from any already-computed
 *   test result... whether that eventually flows in from the legacy
 *   permutation-test engine... or a future research/src-native test" —
 *   this module is that future test, arriving now that it's needed).
 *
 * Grounding: read legacy index.html directly before writing anything --
 *   msdMutualInformation (line 5598, a binned-histogram MI estimator) and
 *   msdCircularShiftPermutationTest (line 9792, a circular-shift null that
 *   preserves the outcome sequence's own autocorrelation/clustering
 *   structure while breaking the specific feature-outcome pointwise
 *   alignment — deliberately NOT a naive full-reshuffle null, which would
 *   destroy real temporal structure the null should preserve). Both are
 *   ported here as a fresh, Dependency-Rule-10-compliant reimplementation
 *   (Volume III forbids importing legacy functions directly outside
 *   bridgeToLegacyMsd/) — the exact binning scheme and null-construction
 *   logic are carried forward unchanged; only the RNG and module
 *   packaging differ.
 *
 * A deliberate improvement over the legacy version: msdCircularShiftPermutationTest
 *   used its own local msdSeededRandom. This module instead reuses
 *   uncertaintyEstimation.js's createSeededRng — the same "no hidden
 *   randomness, seed is REQUIRED, never defaulted" discipline already
 *   established there for computeBootstrapCI — rather than introducing a
 *   second, independently-maintained PRNG implementation into this
 *   codebase.
 *
 * Responsibilities:
 *   - computeMutualInformation(xs, ys, {binCount}): the binned-histogram
 *     MI estimator, ported verbatim from msdMutualInformation.
 *   - computeCircularShiftPermutationTest({featureValues, outcomeValues,
 *     statisticFn, observedStatistic, permutations, seed, minShift}):
 *     the generalized null — defaults statisticFn to
 *     computeMutualInformation, but accepts any two-array statistic, so a
 *     future caller is not locked into MI specifically. Ported null-
 *     construction logic (circular shift, minShift default = 5% of n,
 *     "(1 + count(null >= observed)) / (1 + permutations)" p-value
 *     formula) is unchanged from msdCircularShiftPermutationTest.
 *
 * Inputs: two equal-length numeric arrays (featureValues, outcomeValues),
 *   a REQUIRED seed (no default — matches this codebase's standing rule
 *   against hidden statistical randomness), and an optional statisticFn.
 * Outputs: { pValue, observedStatistic, permutations, minShift,
 *   nullModel: 'circular_shift' }.
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng).
 *
 * Public API: InvalidPermutationTestInputError, computeMutualInformation,
 *   computeCircularShiftPermutationTest.
 * Internal API: none.
 *
 * Error handling: InvalidPermutationTestInputError for malformed input
 *   (mismatched array lengths, sample too small for the requested
 *   minShift, missing seed) — thrown synchronously before any resampling
 *   begins.
 * Performance notes: O(permutations * n) — dominated by the MI
 *   recomputation on each resample, identical to the legacy design's own
 *   cost profile.
 * Threading model: pure, synchronous, side-effect-free.
 * Storage usage: none — this is a stateless statistical primitive; the
 *   caller (governance/randomnessAudit.js) is responsible for persistence.
 * Complexity analysis: see Performance notes.
 * Future extension notes: a future caller needing a different statistic
 *   (e.g. a rank-correlation) supplies statisticFn — no change to this
 *   file's own logic is needed, per the same pattern used throughout
 *   research/src for caller-supplied signal bundles.
 */

import { createSeededRng } from './uncertaintyEstimation.js';

export class InvalidPermutationTestInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPermutationTestInputError';
  }
}

function safeMin(arr) { return arr.reduce((m, v) => (v < m ? v : m), arr[0]); }
function safeMax(arr) { return arr.reduce((m, v) => (v > m ? v : m), arr[0]); }

/**
 * Ported verbatim from legacy msdMutualInformation (binned-histogram
 * estimator, default 8 bins per axis). Returns null for fewer than 2
 * observations, matching the legacy function's own behavior exactly.
 */
export function computeMutualInformation(xs, ys, { binCount = 8 } = {}) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length) {
    throw new InvalidPermutationTestInputError('computeMutualInformation: "xs" and "ys" must be equal-length arrays');
  }
  const n = xs.length;
  if (n < 2) return null;

  const xMin = safeMin(xs), xMax = safeMax(xs);
  const yMin = safeMin(ys), yMax = safeMax(ys);
  function binOf(v, lo, hi) {
    if (hi === lo) return 0;
    let idx = Math.floor(((v - lo) / (hi - lo)) * binCount);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    return idx;
  }

  const jointCounts = new Map();
  const xCounts = new Array(binCount).fill(0);
  const yCounts = new Array(binCount).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = binOf(xs[i], xMin, xMax);
    const yi = binOf(ys[i], yMin, yMax);
    const key = `${xi},${yi}`;
    jointCounts.set(key, (jointCounts.get(key) || 0) + 1);
    xCounts[xi]++;
    yCounts[yi]++;
  }

  let mi = 0;
  jointCounts.forEach((count, key) => {
    const [xi, yi] = key.split(',').map(Number);
    const pxy = count / n, px = xCounts[xi] / n, py = yCounts[yi] / n;
    if (pxy > 0 && px > 0 && py > 0) mi += pxy * Math.log2(pxy / (px * py));
  });
  return mi;
}

/**
 * Ported and generalized from legacy msdCircularShiftPermutationTest.
 * Null model: rotate outcomeValues by a pseudo-random shift (never
 * smaller than minShift), preserving the outcome sequence's own
 * autocorrelation/clustering structure exactly (it is the same sequence,
 * rotated) while breaking the specific pointwise feature-outcome
 * alignment the null needs to break. Dependence structure NOT preserved:
 * the specific alignment between a given feature observation and its
 * paired outcome.
 */
export function computeCircularShiftPermutationTest({
  featureValues,
  outcomeValues,
  statisticFn = computeMutualInformation,
  observedStatistic,
  permutations = 200,
  seed,
  minShift,
} = {}) {
  if (!Array.isArray(featureValues) || !Array.isArray(outcomeValues) || featureValues.length !== outcomeValues.length) {
    throw new InvalidPermutationTestInputError('computeCircularShiftPermutationTest: "featureValues" and "outcomeValues" must be equal-length arrays');
  }
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new InvalidPermutationTestInputError('computeCircularShiftPermutationTest: "seed" is required and must be a finite number (no hidden randomness)');
  }
  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new InvalidPermutationTestInputError('computeCircularShiftPermutationTest: "permutations" must be a positive integer');
  }

  const n = outcomeValues.length;
  const effectiveMinShift = minShift != null ? minShift : Math.max(1, Math.floor(n * 0.05));
  if (n - effectiveMinShift * 2 <= 0) {
    throw new InvalidPermutationTestInputError('computeCircularShiftPermutationTest: sample too small for a meaningful circular-shift null at this minShift');
  }

  const observed = observedStatistic ?? statisticFn(featureValues, outcomeValues);
  if (typeof observed !== 'number' || !Number.isFinite(observed)) {
    throw new InvalidPermutationTestInputError('computeCircularShiftPermutationTest: the observed statistic must be a finite number (statisticFn returned null/NaN — sample too small?)');
  }

  const rng = createSeededRng(seed);
  let countGE = 0;
  for (let p = 0; p < permutations; p++) {
    const shift = effectiveMinShift + Math.floor(rng() * (n - 2 * effectiveMinShift));
    const shifted = new Array(n);
    for (let i = 0; i < n; i++) shifted[i] = outcomeValues[(i + shift) % n];
    const stat = statisticFn(featureValues, shifted);
    if (stat != null && stat >= observed) countGE++;
  }

  return Object.freeze({
    pValue: (1 + countGE) / (1 + permutations),
    observedStatistic: observed,
    permutations,
    minShift: effectiveMinShift,
    nullModel: 'circular_shift',
  });
}
