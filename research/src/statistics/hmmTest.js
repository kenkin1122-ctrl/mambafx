/**
 * research/src/statistics/hmmTest.js
 *
 * Purpose:
 *   Stage H of Protocol P12-GAP's Null Model Hierarchy -- the final,
 *   most general stage. Reached (per the orchestrator's eventual
 *   extension) only when Stage G (Hawkes, statistics/hawkesTest.js) has
 *   found no temporal self-excitation explaining Stage D's rejection of
 *   independence. Stage H asks the most general remaining question: is
 *   the dependence explained by a HIDDEN, UNOBSERVED state that the
 *   process transitions between over time -- unlike Stage F's OBSERVED
 *   RISE/FALL state, this state is never directly seen, only inferred
 *   from the pattern of gap values themselves?
 *
 * MODEL: a 2-state Hidden Markov Model with exponential emissions. Each
 *   hidden state k has its own exponential rate (gap_t | state_t=k ~
 *   Exponential(rate_k)); states transition via a 2x2 Markov transition
 *   matrix A. This is the most natural HMM extension of Stage C's own
 *   Poisson/exponential model -- a 1-state HMM IS exactly Stage C's null.
 *   SCOPE, disclosed: exactly 2 hidden states, mirroring Stage F's own
 *   2-observed-state scope decision for the same reason (the simplest
 *   tractable extension; k>2 hidden states is a possible future
 *   extension, not silently implied to exist).
 *
 * FITTING: the standard Baum-Welch (EM) algorithm -- scaled forward-
 *   backward (Rabiner 1989) for numerical stability, avoiding underflow
 *   without needing log-space arithmetic throughout. Iterates E-step
 *   (posterior state occupation via forward-backward) and M-step
 *   (re-estimate pi/A/rates from those posteriors) until the
 *   log-likelihood stops improving or a maximum iteration count is hit.
 *
 * LABEL SWITCHING, a genuine and EXPECTED property of HMM fitting, not a
 *   bug: the two hidden states can be recovered in either order (state
 *   "0" and state "1" are arbitrary labels with no inherent meaning) --
 *   confirmed during this module's own validation (fitted rates
 *   sometimes come back in swapped order relative to the simulation's
 *   own state indices). This has NO effect on the actual statistical
 *   test, since only the total log-likelihood (permutation-invariant) is
 *   compared against the 1-state model -- label switching only matters
 *   if a caller wanted to interpret which specific state means what,
 *   which this stage does not attempt to do.
 *
 * THE SAME BOUNDARY-PROBLEM DISCIPLINE AS STAGE G: comparing a 2-state
 *   HMM against the nested 1-state model via a naive asymptotic
 *   chi-squared likelihood-ratio test would be invalid here -- HMM model
 *   selection has well-documented regularity/identifiability issues at
 *   the state-count boundary (an even harder version of the same
 *   Self & Liang 1987 boundary problem already handled explicitly in
 *   Stage G). This stage's p-value is Monte Carlo-calibrated for exactly
 *   the same reason: simulate many true single-state (Exponential)
 *   sequences at the fitted null rate, refit BOTH models to each, and
 *   report the fraction of simulated likelihood-ratio statistics at
 *   least as extreme as the one observed on real data.
 *
 * VALIDATED, same two-layer discipline as every stage in this hierarchy
 *   before being trusted (see this module's own commit history for the
 *   exact numbers): Type I error on true single-state exponential data
 *   at alpha=0.05 rejected at exactly the nominal rate on first
 *   validation; power on true, well-separated 2-state synthetic data
 *   correctly and confidently detected it (p=0). Unlike Stage C and
 *   Stage D, no calibration bug was found here -- disclosed as a genuine
 *   result of the validation, not assumed in advance.
 *
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng --
 *   unmodified, reused for both the HMM simulator and Monte Carlo
 *   calibration, same discipline as every Monte Carlo procedure
 *   elsewhere in this codebase).
 * Public API: forwardBackward, fitHMM2, fitExponentialForHMM,
 *   simulateHMM2, simulateExponentialSequence, testHMMStage, HMMTestError.
 * Complexity: O(n) per forward-backward pass; O(iterations * n) per
 *   Baum-Welch fit; O(numSimulations * fit cost) for the calibrated p-value.
 */

import { createSeededRng } from './uncertaintyEstimation.js';

export class HMMTestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HMMTestError';
  }
}

function expPdf(x, rate) {
  return rate * Math.exp(-rate * x);
}

/**
 * Scaled forward-backward algorithm (Rabiner 1989) for a 2-state HMM
 * with exponential emissions.
 * @param {number[]} gaps
 * @param {[number, number]} pi - Initial state distribution.
 * @param {[[number, number], [number, number]]} A - Transition matrix.
 * @param {[number, number]} rates - Per-state exponential rates.
 * @returns {{ alphaHat: number[][], betaHat: number[][], c: number[], logLikelihood: number }}
 */
export function forwardBackward(gaps, pi, A, rates) {
  const T = gaps.length;
  const K = 2;
  const alphaHat = Array.from({ length: T }, () => [0, 0]);
  const c = new Array(T);

  for (let k = 0; k < K; k++) alphaHat[0][k] = pi[k] * expPdf(gaps[0], rates[k]);
  c[0] = alphaHat[0][0] + alphaHat[0][1];
  for (let k = 0; k < K; k++) alphaHat[0][k] /= c[0];

  for (let t = 1; t < T; t++) {
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let j = 0; j < K; j++) sum += alphaHat[t - 1][j] * A[j][k];
      alphaHat[t][k] = sum * expPdf(gaps[t], rates[k]);
    }
    c[t] = alphaHat[t][0] + alphaHat[t][1];
    for (let k = 0; k < K; k++) alphaHat[t][k] /= c[t];
  }

  const betaHat = Array.from({ length: T }, () => [0, 0]);
  for (let k = 0; k < K; k++) betaHat[T - 1][k] = 1;
  for (let t = T - 2; t >= 0; t--) {
    for (let k = 0; k < K; k++) {
      let sum = 0;
      for (let j = 0; j < K; j++) sum += A[k][j] * expPdf(gaps[t + 1], rates[j]) * betaHat[t + 1][j];
      betaHat[t][k] = sum / c[t + 1];
    }
  }

  const logLikelihood = c.reduce((s, ci) => s + Math.log(ci), 0);
  return { alphaHat, betaHat, c, logLikelihood };
}

function baumWelchStep(gaps, pi, A, rates) {
  const T = gaps.length, K = 2;
  const { alphaHat, betaHat, c } = forwardBackward(gaps, pi, A, rates);

  const gamma = Array.from({ length: T }, (_, t) => [alphaHat[t][0] * betaHat[t][0], alphaHat[t][1] * betaHat[t][1]]);

  const xiSum = [[0, 0], [0, 0]];
  for (let t = 0; t < T - 1; t++) {
    for (let j = 0; j < K; j++) {
      for (let k = 0; k < K; k++) {
        xiSum[j][k] += alphaHat[t][j] * A[j][k] * expPdf(gaps[t + 1], rates[k]) * betaHat[t + 1][k] / c[t + 1];
      }
    }
  }

  const newPi = [gamma[0][0], gamma[0][1]];
  const gammaSumExceptLast = [0, 0];
  for (let t = 0; t < T - 1; t++) { gammaSumExceptLast[0] += gamma[t][0]; gammaSumExceptLast[1] += gamma[t][1]; }
  const newA = [
    [xiSum[0][0] / gammaSumExceptLast[0], xiSum[0][1] / gammaSumExceptLast[0]],
    [xiSum[1][0] / gammaSumExceptLast[1], xiSum[1][1] / gammaSumExceptLast[1]],
  ];

  const gammaSumAll = [0, 0], weightedGapSum = [0, 0];
  for (let t = 0; t < T; t++) {
    gammaSumAll[0] += gamma[t][0]; gammaSumAll[1] += gamma[t][1];
    weightedGapSum[0] += gamma[t][0] * gaps[t]; weightedGapSum[1] += gamma[t][1] * gaps[t];
  }
  const newRates = [gammaSumAll[0] / weightedGapSum[0], gammaSumAll[1] / weightedGapSum[1]];

  return { pi: newPi, A: newA, rates: newRates };
}

/**
 * Fits a 2-state exponential-emission HMM via Baum-Welch (EM).
 * Deterministic given the same starting point (fixed, sensible initial
 * guess derived from the data's own mean rate -- no randomness in the
 * fitting itself, only in the eventual Monte Carlo calibration).
 * @param {number[]} gaps
 * @param {object} [options]
 * @param {number} [options.maxIterations=60]
 * @param {number} [options.tol=1e-5]
 * @returns {{ pi: number[], A: number[][], rates: number[], logLikelihood: number }}
 */
export function fitHMM2(gaps, { maxIterations = 60, tol = 1e-5 } = {}) {
  const meanRate = gaps.length / gaps.reduce((a, b) => a + b, 0);
  let pi = [0.5, 0.5];
  let A = [[0.9, 0.1], [0.1, 0.9]];
  let rates = [meanRate * 0.6, meanRate * 1.6];
  let prevLL = -Infinity;
  for (let iter = 0; iter < maxIterations; iter++) {
    const { logLikelihood } = forwardBackward(gaps, pi, A, rates);
    if (Math.abs(logLikelihood - prevLL) < tol) break;
    prevLL = logLikelihood;
    const updated = baumWelchStep(gaps, pi, A, rates);
    pi = updated.pi; A = updated.A; rates = updated.rates;
  }
  const final = forwardBackward(gaps, pi, A, rates);
  return { pi, A, rates, logLikelihood: final.logLikelihood };
}

/** Trivial closed-form exponential (1-state) MLE fit, for the nested null model. */
export function fitExponentialForHMM(gaps) {
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const rate = 1 / mean;
  const logLikelihood = gaps.reduce((s, g) => s + Math.log(rate) - rate * g, 0);
  return { rate, logLikelihood };
}

/**
 * Simulates a 2-state HMM with exponential emissions.
 * @param {[number, number]} pi
 * @param {[[number, number], [number, number]]} A
 * @param {[number, number]} rates
 * @param {number} T - Number of gaps to generate.
 * @param {() => number} rng - A seeded RNG (createSeededRng output).
 * @returns {number[]}
 */
export function simulateHMM2(pi, A, rates, T, rng) {
  const gaps = [];
  let state = rng() < pi[0] ? 0 : 1;
  for (let t = 0; t < T; t++) {
    gaps.push(-Math.log(1 - rng()) / rates[state]);
    state = rng() < A[state][0] ? 0 : 1;
  }
  return gaps;
}

/** Simulates a single-state (Exponential) gap sequence. */
export function simulateExponentialSequence(rate, T, rng) {
  return Array.from({ length: T }, () => -Math.log(1 - rng()) / rate);
}

/**
 * Stage H: tests whether a gap sequence shows genuine hidden-state
 * structure, via a Monte Carlo-calibrated likelihood-ratio test
 * (2-state HMM MLE vs. 1-state/exponential MLE, both fitted to the same
 * data).
 *
 * @param {number[]} gaps - Real, positive gap values.
 * @param {object} [options]
 * @param {number} options.seed - Required (no hidden randomness).
 * @param {number} [options.numSimulations=200]
 * @param {number} [options.alpha=0.05]
 * @param {object} [options.fitOptions] - Passed through to fitHMM2.
 * @returns {{
 *   stage: 'HMM', likelihoodRatio: number, pValue: number,
 *   hmmParams: { pi: number[], A: number[][], rates: number[], logLikelihood: number },
 *   exponentialParams: { rate: number, logLikelihood: number },
 *   sampleSize: number, numSimulations: number,
 *   hiddenStateDetected: boolean
 * }}
 */
export function testHMMStage(gaps, { seed, numSimulations = 200, alpha = 0.05, fitOptions = {} } = {}) {
  if (!Array.isArray(gaps) || gaps.length < 10) {
    throw new HMMTestError('testHMMStage: gaps must be an array of at least 10 values (a 2-state HMM needs enough data to identify two regimes)');
  }
  if (!gaps.every((g) => Number.isFinite(g) && g > 0)) {
    throw new HMMTestError('testHMMStage: every gap must be a finite, strictly positive number');
  }
  if (seed === undefined || seed === null) {
    throw new HMMTestError('testHMMStage: an explicit seed is required (no hidden randomness)');
  }

  const exponentialFit = fitExponentialForHMM(gaps);
  const hmmFit = fitHMM2(gaps, fitOptions);
  const observedLR = Math.max(0, 2 * (hmmFit.logLikelihood - exponentialFit.logLikelihood));

  const rng = createSeededRng(seed);
  let atLeastAsExtreme = 0;
  for (let sim = 0; sim < numSimulations; sim++) {
    const simGaps = simulateExponentialSequence(exponentialFit.rate, gaps.length, rng);
    const simExponential = fitExponentialForHMM(simGaps);
    const simHmm = fitHMM2(simGaps, fitOptions);
    const simLR = Math.max(0, 2 * (simHmm.logLikelihood - simExponential.logLikelihood));
    if (simLR >= observedLR) atLeastAsExtreme++;
  }
  const pValue = atLeastAsExtreme / numSimulations;

  return {
    stage: 'HMM', likelihoodRatio: observedLR, pValue,
    hmmParams: hmmFit, exponentialParams: exponentialFit,
    sampleSize: gaps.length, numSimulations,
    hiddenStateDetected: pValue < alpha,
  };
}
