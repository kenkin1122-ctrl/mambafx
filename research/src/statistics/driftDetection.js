/**
 * research/src/statistics/driftDetection.js
 *
 * Purpose:
 *   The pure statistical half of Volume IV v3.0 Part 16's Drift
 *   Surveillance Engine: "a policy-fixed, Scientific-Oversight-approved
 *   statistical test for regime change (e.g., a structural-break or
 *   distributional-shift test) applied to a Family's data over a
 *   hypothesis's test window." Implements the two-sample Kolmogorov–
 *   Smirnov test, a standard, well-known distributional-shift test.
 *
 * Scope note: Volume III's Software Architecture v10.1 names four
 *   candidate regime-change tests for Stage 7 (KS test, copula audit,
 *   spectral coherence, BCPD), run together inside a dedicated worker.
 *   Part 16's own Constitutional text gives the KS test as its first
 *   example ("e.g., a structural-break or distributional-shift test")
 *   and does not mandate all four simultaneously. This module implements
 *   the KS test only — the simplest, most standard, and most directly
 *   Node-testable of the four — consistent with this session's
 *   established pattern of building one complete, correct, disclosed
 *   mechanism now rather than a partial implementation of every named
 *   option. Copula audit / spectral coherence / BCPD remain explicitly
 *   out of scope, to be added as additional, independently-testable
 *   detectors behind the same driftSurveillance.js call site if ever
 *   built, not a redesign of this module.
 *
 * Responsibilities:
 *   - computeKSStatistic(sampleA, sampleB): the two-sample KS D statistic
 *     — the maximum absolute difference between the two samples'
 *     empirical CDFs, evaluated at every distinct value that appears in
 *     either sample (exact, not approximate).
 *   - computeKSPValue(D, nA, nB): the asymptotic two-sided p-value via
 *     the Kolmogorov distribution (Kolmogorov 1933; Smirnov 1948),
 *     lambda = D * sqrt(nA*nB/(nA+nB)), p = 2 * sum (-1)^(k-1)
 *     exp(-2 k^2 lambda^2), truncated once terms become numerically
 *     negligible.
 *   - detectRegimeChange({referenceWindow, currentWindow, alpha}): the
 *     single entry point combining both, returning a frozen result with
 *     an explicit driftDetected boolean at the caller-supplied
 *     significance level.
 *
 * Inputs: two arrays of finite numbers (a reference/baseline window and
 *   the current window under test), and a significance level.
 * Outputs: a frozen {statistic, pValue, alpha, driftDetected,
 *   sampleSizeA, sampleSizeB} record; throws on malformed input.
 * Dependencies: none (a pure statistics leaf module, matching
 *   normalDistribution.js's own no-dependency design).
 *
 * Public API: InvalidDriftDetectionInputError, computeKSStatistic,
 *   computeKSPValue, detectRegimeChange.
 * Internal API: none.
 *
 * Error handling: non-array, empty, or non-finite-number inputs throw
 *   InvalidDriftDetectionInputError before any computation.
 * Performance notes: computeKSStatistic sorts both samples
 *   (O(n log n) + O(m log m)) and evaluates the empirical CDFs at every
 *   distinct combined value via binary search — O((n+m) log(n+m))
 *   overall, appropriate for the bounded rolling-window sizes this
 *   engine operates on (not unbounded historical scans).
 * Threading model: pure, synchronous, side-effect-free — trivially safe
 *   from a Worker or the main thread (Volume III's own architecture runs
 *   this class of test inside drift.worker.js; this module makes no
 *   assumption about which thread calls it).
 * Storage usage: none.
 * Complexity analysis: see Performance notes above.
 * Future extension notes: additional regime-change detectors (copula
 *   audit, spectral coherence, BCPD) would each be a new pure function
 *   here with the same {statistic, pValue, driftDetected} result shape,
 *   letting driftSurveillance.js combine multiple detectors' verdicts
 *   later without changing this module's existing exports.
 */

export class InvalidDriftDetectionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDriftDetectionInputError';
  }
}

function assertFiniteNumberArray(sample, label) {
  if (!Array.isArray(sample) || sample.length === 0) {
    throw new InvalidDriftDetectionInputError(`${label}: must be a non-empty array`);
  }
  for (const value of sample) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidDriftDetectionInputError(`${label}: every element must be a finite number`);
    }
  }
}

/** Count of elements in a sorted ascending array that are <= v, via binary search. */
function countLessOrEqual(sortedArray, v) {
  let lo = 0;
  let hi = sortedArray.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedArray[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The two-sample KS D statistic: the maximum absolute difference between
 * the empirical CDFs of sampleA and sampleB, evaluated exactly at every
 * distinct value appearing in either sample.
 */
export function computeKSStatistic(sampleA, sampleB) {
  assertFiniteNumberArray(sampleA, 'computeKSStatistic: "sampleA"');
  assertFiniteNumberArray(sampleB, 'computeKSStatistic: "sampleB"');

  const sortedA = [...sampleA].sort((a, b) => a - b);
  const sortedB = [...sampleB].sort((a, b) => a - b);
  const nA = sortedA.length;
  const nB = sortedB.length;

  const combinedValues = Array.from(new Set([...sortedA, ...sortedB])).sort((a, b) => a - b);

  let D = 0;
  for (const v of combinedValues) {
    const cdfA = countLessOrEqual(sortedA, v) / nA;
    const cdfB = countLessOrEqual(sortedB, v) / nB;
    D = Math.max(D, Math.abs(cdfA - cdfB));
  }
  return D;
}

/**
 * Asymptotic two-sided p-value for a KS D statistic, via the Kolmogorov
 * distribution (Kolmogorov 1933; Smirnov 1948).
 */
export function computeKSPValue(D, nA, nB) {
  if (typeof D !== 'number' || !Number.isFinite(D) || D < 0 || D > 1) {
    throw new InvalidDriftDetectionInputError('computeKSPValue: "D" must be a finite number in [0, 1]');
  }
  if (!Number.isInteger(nA) || nA <= 0 || !Number.isInteger(nB) || nB <= 0) {
    throw new InvalidDriftDetectionInputError('computeKSPValue: "nA" and "nB" must be positive integers');
  }

  const effectiveN = (nA * nB) / (nA + nB);
  const lambda = D * Math.sqrt(effectiveN);

  // The Kolmogorov survival series (below) only converges QUICKLY for
  // lambda roughly >= 1 -- for small lambda its terms stay near +-1 for
  // many iterations (the D=0/near-0 "identical distributions" case is the
  // most important instance of this: naive truncation of that series at
  // D=0 produces an arbitrary, truncation-parity-dependent result instead
  // of the correct limiting p-value of 1). The dual-series approach below
  // is standard practice for evaluating the Kolmogorov distribution:
  // the CDF-form series converges quickly for SMALL lambda instead, so
  // each regime uses whichever series actually converges fast in it.
  if (lambda < 1e-6) {
    // Limiting behavior as lambda -> 0: P(D <= d) -> 0, so the survival
    // p-value -> 1 (no evidence against "the two windows are the same
    // distribution").
    return 1;
  }

  let p;
  if (lambda < 1) {
    // CDF-form series (converges quickly for small lambda).
    let cdf = 0;
    for (let k = 1; k <= 100; k += 1) {
      const exponent = -((2 * k - 1) ** 2) * Math.PI * Math.PI / (8 * lambda * lambda);
      const term = Math.exp(exponent);
      cdf += term;
      if (term < 1e-12) break;
    }
    cdf *= Math.sqrt(2 * Math.PI) / lambda;
    p = 1 - cdf;
  } else {
    // Survival-form alternating series (converges quickly for large lambda).
    let sum = 0;
    for (let k = 1; k <= 100; k += 1) {
      const term = (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
      sum += term;
      if (Math.abs(term) < 1e-12) break;
    }
    p = 2 * sum;
  }
  return Math.min(1, Math.max(0, p));
}

/**
 * The single entry point: computes the KS statistic and p-value between a
 * reference (baseline) window and the current window, and evaluates
 * driftDetected at the caller-supplied significance level.
 */
export function detectRegimeChange({ referenceWindow, currentWindow, alpha = 0.05 } = {}) {
  assertFiniteNumberArray(referenceWindow, 'detectRegimeChange: "referenceWindow"');
  assertFiniteNumberArray(currentWindow, 'detectRegimeChange: "currentWindow"');
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new InvalidDriftDetectionInputError('detectRegimeChange: "alpha" must be a finite number strictly between 0 and 1');
  }

  const statistic = computeKSStatistic(referenceWindow, currentWindow);
  const pValue = computeKSPValue(statistic, referenceWindow.length, currentWindow.length);

  return Object.freeze({
    statistic,
    pValue,
    alpha,
    driftDetected: pValue <= alpha,
    sampleSizeA: referenceWindow.length,
    sampleSizeB: currentWindow.length,
  });
}
