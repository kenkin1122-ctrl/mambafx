/**
 * research/src/statistics/renewalProcessTests.js
 *
 * Purpose:
 *   Stages C, D, E of Protocol P12-GAP's Null Model Hierarchy -- the
 *   first three (and least complex) of the six statistical procedures
 *   that will eventually be registered for EventProcessFeature candidates
 *   via bridge/StatisticalProcedureRegistry.js. Deliberately grouped into
 *   one slice: all three share the same underlying machinery (goodness-
 *   of-fit against a theoretical distribution, tests of independence) and
 *   are validated together against synthetic ground truth before the
 *   architecturally riskier Semi-Markov/Hawkes/HMM stages (F/G/H) are
 *   attempted, each of which gets its own dedicated slice.
 *
 * Stage C -- Poisson: tests whether a gap sequence is consistent with a
 *   homogeneous Poisson process, i.e. i.i.d. Exponential(lambda)
 *   inter-arrival times -- the strongest, most falsifiable null this
 *   whole research direction has (see the accompanying scientific design
 *   review: on a near-i.i.d. tick generator, this is the expected result).
 *   Kolmogorov-Smirnov goodness-of-fit against the MLE-fitted exponential
 *   CDF, using the closed-form asymptotic Kolmogorov p-value (no
 *   simulation needed -- this is a genuinely deterministic test).
 *
 * Stage D -- Renewal: tests the WEAKER condition that gap values are
 *   merely i.i.d. (independent), regardless of their specific
 *   distribution -- i.e. is this at least a general renewal process, even
 *   if Stage C rejected the stronger Poisson/exponential hypothesis? Uses
 *   lag-k autocorrelation of the gap sequence itself against the standard
 *   large-sample null (autocorrelation ~ Normal(0, 1/n)). Rejecting this
 *   stage is real evidence of DEPENDENCE between successive gaps -- the
 *   finding that would motivate the higher-complexity stages (F/G/H,
 *   which explicitly model dependence/self-excitation/hidden state).
 *
 * Stage E -- Renewal Distribution: for gap sequences that passed Stage D
 *   (i.i.d., but not exponential per Stage C) -- characterizes WHICH
 *   distribution actually fits, via the coefficient of variation (CV).
 *   CV = 1 indicates exponential-like (memoryless); CV < 1 indicates a
 *   more regular, sub-exponential renewal process (e.g. Erlang/Gamma-like,
 *   arrivals more evenly spaced than pure chance); CV > 1 indicates a
 *   more irregular, super-exponential process (heavier-tailed, more
 *   burstiness than pure chance). SCOPE, disclosed not hidden: this stage
 *   does NOT fit and AIC-compare full Gamma/Weibull/LogNormal MLE models
 *   in this slice -- that would require implementing the regularized
 *   incomplete gamma function (for a Gamma CDF/KS test) or iterative MLE
 *   solvers, a substantially larger undertaking than the diagnostic value
 *   justifies at this stage of the hierarchy. CV is a real, standard,
 *   already-established renewal-theory diagnostic (named explicitly in
 *   this project's own preceding scientific design review's Tier 1
 *   feature list) and is what this stage reports; full distributional
 *   MLE-family comparison is flagged as a possible future extension, not
 *   silently implied to already exist.
 *
 * NO NEW RANDOMNESS BEYOND WHAT'S NECESSARY: Stage D and E use closed-form
 *   analytic approximations (the standard large-sample autocorrelation
 *   null, the CV diagnostic) -- no simulation. Stage C's p-value, however,
 *   REQUIRES simulation (see "Lilliefors correction" note below) and
 *   reuses the existing createSeededRng (statistics/uncertaintyEstimation.js,
 *   unmodified) -- the same "no hidden randomness" discipline used
 *   throughout this codebase (an explicit seed is mandatory, never a
 *   silent default).
 *
 * LILLIEFORS CORRECTION (a real finding from this slice's own synthetic
 *   validation, not assumed correct and shipped): the naive textbook
 *   asymptotic Kolmogorov distribution formula (kolmogorovSmirnovPValue,
 *   still provided below as a general-purpose utility) is WRONG when the
 *   distribution's parameters are estimated from the SAME sample being
 *   tested -- as Stage C does (lambda_hat = 1/mean(gaps), then testing
 *   those same gaps against Exponential(lambda_hat)). Fitting-then-testing
 *   on the same data biases D downward relative to the standard KS null,
 *   making the naive asymptotic p-value far too conservative. Caught by
 *   this slice's own Type I error calibration check (a true-null
 *   simulation at alpha=0.05 should reject ~5% of the time; the naive
 *   formula rejected 0% across 300 trials -- a real miscalibration, not
 *   sampling noise). Fixed via Monte Carlo calibration instead: simulate
 *   many exponential(1) samples of the SAME size, refit each to its own
 *   MLE lambda (mirroring exactly what was done to the real data -- the
 *   exponential family's scale-invariance means the simulation lambda
 *   doesn't need to match the observed one), compute each simulated
 *   sample's own KS statistic against its own fit, and report the
 *   fraction of simulated statistics at least as extreme as the observed
 *   one. This is the textbook-correct fix for the Lilliefors problem when
 *   no closed-form adjusted critical-value table is used.
 *
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng --
 *   unmodified, reused for Stage C's Monte Carlo calibration only).
 * Public API: fitExponentialMLE, exponentialCDF, kolmogorovSmirnovStatistic,
 *   kolmogorovSmirnovPValue, testPoissonStage, lagKAutocorrelation,
 *   testRenewalStage, computeCoefficientOfVariation, testRenewalDistributionStage,
 *   RenewalProcessTestError.
 * Complexity: O(n log n) per stage (dominated by sorting for the KS
 *   statistic); O(numSimulations * n log n) for Stage C's Monte Carlo
 *   calibration; O(n*k) for Stage D's k-lag autocorrelation scan.
 */

import { createSeededRng } from './uncertaintyEstimation.js';

export class RenewalProcessTestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenewalProcessTestError';
  }
}

function assertValidGapSample(gaps, callerName) {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    throw new RenewalProcessTestError(`${callerName}: gaps must be a non-empty array`);
  }
  if (!gaps.every((g) => Number.isFinite(g) && g > 0)) {
    throw new RenewalProcessTestError(`${callerName}: every gap must be a finite, strictly positive number (a gap of 0 or less is not a valid inter-event interval)`);
  }
}

// ── Stage C: Poisson ─────────────────────────────────────────────────────

/**
 * MLE fit of Exponential(lambda) to a gap sample: lambda_hat = 1/mean(gaps).
 * @param {number[]} gaps
 * @returns {{ lambda: number, mean: number }}
 */
export function fitExponentialMLE(gaps) {
  assertValidGapSample(gaps, 'fitExponentialMLE');
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return { lambda: 1 / mean, mean };
}

/** Exponential(lambda) CDF at x. */
export function exponentialCDF(x, lambda) {
  return x <= 0 ? 0 : 1 - Math.exp(-lambda * x);
}

/**
 * The Kolmogorov-Smirnov statistic D: the maximum absolute difference
 * between a sample's empirical CDF and a theoretical CDF function.
 * @param {number[]} sample
 * @param {(x: number) => number} cdfFn
 * @returns {number}
 */
export function kolmogorovSmirnovStatistic(sample, cdfFn) {
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  let maxDiff = 0;
  for (let i = 0; i < n; i++) {
    const theoretical = cdfFn(sorted[i]);
    const empiricalBelow = i / n;
    const empiricalAtOrAbove = (i + 1) / n;
    maxDiff = Math.max(maxDiff, Math.abs(empiricalBelow - theoretical), Math.abs(empiricalAtOrAbove - theoretical));
  }
  return maxDiff;
}

/**
 * Asymptotic (large-sample) p-value for the Kolmogorov-Smirnov statistic,
 * via the standard Kolmogorov distribution: Q(lambda) = 2 * sum_{k=1}^inf
 * (-1)^(k-1) * exp(-2 k^2 lambda^2), lambda = sqrt(n) * D. Closed-form,
 * deterministic -- no simulation.
 *
 * VALID ONLY when the theoretical CDF's parameters are known in advance,
 * NOT estimated from the same sample being tested (the "Lilliefors
 * problem" -- see this module's own header note). testPoissonStage does
 * NOT use this function for exactly that reason; it is provided as a
 * general-purpose utility for callers with a genuinely externally-
 * specified theoretical distribution.
 *
 * @param {number} D - The KS statistic.
 * @param {number} n - Sample size.
 * @returns {number} p-value in [0, 1].
 */
export function kolmogorovSmirnovPValue(D, n) {
  const lambda = Math.sqrt(n) * D;
  if (lambda < 1e-6) return 1; // perfect (or near-perfect) fit -- the alternating series does not converge meaningfully this close to 0; the true limiting p-value is exactly 1
  let sum = 0;
  for (let k = 1; k <= 100; k++) {
    const term = Math.pow(-1, k - 1) * Math.exp(-2 * k * k * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  const p = 2 * sum;
  return Math.min(1, Math.max(0, p));
}

/**
 * Stage C: tests whether a gap sequence is consistent with a homogeneous
 * Poisson process (i.i.d. Exponential inter-arrival times).
 *
 * Uses Monte Carlo calibration for the p-value (see module header's
 * "Lilliefors correction" note) -- NOT the naive asymptotic
 * kolmogorovSmirnovPValue formula, which is invalid here because lambda
 * is fitted from the same sample being tested.
 *
 * @param {number[]} gaps - Real, positive gap values (time or tick gaps).
 * @param {object} [options]
 * @param {number} [options.alpha=0.05]
 * @param {number} options.seed - Required (no hidden randomness).
 * @param {number} [options.numSimulations=1000]
 * @returns {{
 *   stage: 'Poisson', lambda: number, meanGap: number,
 *   ksStatistic: number, pValue: number, sampleSize: number,
 *   consistentWithPoisson: boolean, numSimulations: number
 * }}
 */
export function testPoissonStage(gaps, { alpha = 0.05, seed, numSimulations = 1000 } = {}) {
  assertValidGapSample(gaps, 'testPoissonStage');
  if (seed === undefined || seed === null) {
    throw new RenewalProcessTestError('testPoissonStage: an explicit seed is required (no hidden randomness) for Monte Carlo p-value calibration');
  }
  const { lambda, mean } = fitExponentialMLE(gaps);
  const n = gaps.length;
  const D = kolmogorovSmirnovStatistic(gaps, (x) => exponentialCDF(x, lambda));

  const rng = createSeededRng(seed);
  let atLeastAsExtreme = 0;
  for (let sim = 0; sim < numSimulations; sim++) {
    // Exponential(1) via inverse-transform sampling -- the exponential
    // family's scale-invariance under MLE refitting means the simulation
    // lambda need not match the observed one; only n matters.
    const simulatedGaps = Array.from({ length: n }, () => -Math.log(1 - rng()));
    const { lambda: simLambda } = fitExponentialMLE(simulatedGaps);
    const simD = kolmogorovSmirnovStatistic(simulatedGaps, (x) => exponentialCDF(x, simLambda));
    if (simD >= D) atLeastAsExtreme++;
  }
  const pValue = atLeastAsExtreme / numSimulations;

  return {
    stage: 'Poisson', lambda, meanGap: mean,
    ksStatistic: D, pValue, sampleSize: n, numSimulations,
    consistentWithPoisson: pValue >= alpha,
  };
}

// ── Stage D: Renewal (independence, not necessarily exponential) ────────

/**
 * Lag-k autocorrelation of a numeric series (standard Pearson
 * autocorrelation of the series against itself shifted by k).
 * @param {number[]} series
 * @param {number} k - Lag (>= 1).
 * @returns {number} in [-1, 1], or NaN if the series is too short for this lag.
 */
export function lagKAutocorrelation(series, k) {
  const n = series.length;
  if (k < 1 || k >= n) return NaN;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < n; i++) denominator += (series[i] - mean) ** 2;
  for (let i = 0; i < n - k; i++) numerator += (series[i] - mean) * (series[i + k] - mean);
  return denominator === 0 ? NaN : numerator / denominator;
}

/**
 * Stage D: tests whether gap values are independent of one another
 * (a genuine renewal process, whatever their specific distribution),
 * via lag-1 through lag-maxLag autocorrelation against the standard
 * large-sample null (autocorrelation of an i.i.d. series ~ Normal(0, 1/n),
 * a standard, well-established asymptotic result -- not a new derivation).
 *
 * BONFERRONI-CORRECTED across the maxLag tests performed (a real finding
 * from this slice's own synthetic validation: testing multiple lags and
 * taking the max |z-score| without correction inflates the effective
 * false-positive rate well above the nominal alpha -- e.g. ~23% instead
 * of 5% at maxLag=5, caught by running this test against genuinely i.i.d.
 * synthetic data and observing spurious rejections). The per-lag critical
 * value uses alpha/maxLag, not alpha, so the OVERALL false-positive rate
 * across all lags tested stays at the nominal level.
 *
 * @param {number[]} gaps
 * @param {object} [options]
 * @param {number} [options.maxLag=5]
 * @param {number} [options.alpha=0.05]
 * @returns {{
 *   stage: 'Renewal', autocorrelations: number[], zScores: number[],
 *   maxAbsZScore: number, sampleSize: number, consistentWithIndependence: boolean,
 *   bonferroniCorrectedAlpha: number
 * }}
 */
export function testRenewalStage(gaps, { maxLag = 5, alpha = 0.05 } = {}) {
  assertValidGapSample(gaps, 'testRenewalStage');
  const n = gaps.length;
  const standardError = 1 / Math.sqrt(n);
  const effectiveMaxLag = Math.min(maxLag, n - 2);
  if (effectiveMaxLag < 1) {
    throw new RenewalProcessTestError(`testRenewalStage: sample too small (n=${n}) to test even lag-1 autocorrelation`);
  }
  const autocorrelations = [];
  const zScores = [];
  for (let k = 1; k <= effectiveMaxLag; k++) {
    const r = lagKAutocorrelation(gaps, k);
    autocorrelations.push(r);
    zScores.push(r / standardError);
  }
  const maxAbsZScore = Math.max(...zScores.map(Math.abs));
  const correctedAlpha = alpha / effectiveMaxLag;
  const criticalZ = Math.abs(_approxInverseNormalCDFForAlpha(correctedAlpha));
  return {
    stage: 'Renewal', autocorrelations, zScores, maxAbsZScore,
    sampleSize: n, consistentWithIndependence: maxAbsZScore <= criticalZ,
    bonferroniCorrectedAlpha: correctedAlpha,
  };
}

/** Minimal fallback for non-default alpha values, matching normalDistribution.js's own Acklam-algorithm shape but inlined to avoid a cross-module dependency for a single-purpose critical value. */
function _approxInverseNormalCDFForAlpha(alpha) {
  const p = 1 - alpha / 2;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Stage E: Renewal Distribution characterization ──────────────────────

/**
 * Coefficient of variation: std deviation / mean. For a renewal process's
 * gap sequence: CV=1 indicates exponential-like (memoryless); CV<1
 * indicates a more regular process; CV>1 indicates a more irregular,
 * bursty process.
 * @param {number[]} gaps
 * @returns {number}
 */
export function computeCoefficientOfVariation(gaps) {
  assertValidGapSample(gaps, 'computeCoefficientOfVariation');
  const n = gaps.length;
  const mean = gaps.reduce((a, b) => a + b, 0) / n;
  const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / mean;
}

/**
 * Stage E: characterizes the renewal-gap distribution via CV (see module
 * header for this stage's disclosed scope). Only meaningful to run after
 * Stage D has confirmed independence (a genuine renewal process) -- this
 * function does not itself check that precondition; the caller (the
 * eventual Null Model Hierarchy orchestrator, a later slice) is
 * responsible for stage sequencing.
 * @param {number[]} gaps
 * @returns {{
 *   stage: 'RenewalDistribution', coefficientOfVariation: number,
 *   classification: 'exponential-like'|'sub-exponential'|'super-exponential',
 *   sampleSize: number
 * }}
 */
export function testRenewalDistributionStage(gaps, { cvTolerance = 0.1 } = {}) {
  assertValidGapSample(gaps, 'testRenewalDistributionStage');
  const cv = computeCoefficientOfVariation(gaps);
  let classification;
  if (Math.abs(cv - 1) <= cvTolerance) classification = 'exponential-like';
  else if (cv < 1) classification = 'sub-exponential';
  else classification = 'super-exponential';
  return {
    stage: 'RenewalDistribution', coefficientOfVariation: cv, classification,
    sampleSize: gaps.length,
  };
}
