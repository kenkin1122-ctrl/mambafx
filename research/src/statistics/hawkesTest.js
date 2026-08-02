/**
 * research/src/statistics/hawkesTest.js
 *
 * Purpose:
 *   Stage G of Protocol P12-GAP's Null Model Hierarchy -- reached (per
 *   the orchestrator's eventual extension) only when Stage F (Semi-Markov,
 *   statistics/semiMarkovTest.js) has found NO state-dependence
 *   explaining Stage D's rejection of independence. Stage G asks whether
 *   the remaining dependence is explained by genuine TEMPORAL
 *   SELF-EXCITATION: do recent events make near-future events more
 *   likely, decaying over time (a Hawkes process), beyond what a
 *   homogeneous Poisson process would produce?
 *
 * THE HARDEST STAGE in this hierarchy, by design and by explicit
 *   agreement before starting: unlike Stages C-F, no closed-form
 *   likelihood-maximizing formula exists for a Hawkes process -- fitting
 *   requires numerical optimization, and comparing it against the nested
 *   Poisson-only model (alpha=0) requires care, because alpha=0 sits on
 *   the BOUNDARY of the parameter space (alpha >= 0), which invalidates
 *   the standard chi-squared asymptotic likelihood-ratio-test theory
 *   (the well-known Self & Liang 1987 boundary problem). Rather than use
 *   an asymptotic formula whose applicability here is genuinely
 *   questionable, this stage's p-value is Monte Carlo-calibrated (same
 *   discipline already applied for exactly this class of concern in
 *   Stage C's Lilliefors-bias fix): simulate many true-Poisson event
 *   sequences at the SAME fitted null rate, refit both models to each,
 *   and report the fraction of simulated likelihood-ratio statistics at
 *   least as extreme as the one observed on real data.
 *
 * MODEL: conditional intensity lambda(t) = mu + sum_{t_i < t} alpha *
 *   exp(-beta * (t - t_i)) -- the standard single-exponential-kernel
 *   Hawkes process. mu is the baseline rate; alpha is the excitation
 *   magnitude (jump in intensity per past event); beta is the decay rate
 *   (how fast that excitation fades). Fitted via a coarse-to-fine,
 *   DETERMINISTIC grid search over (mu, alpha, beta) in log-space
 *   (log-space keeps every search point positive by construction, no
 *   projection/clamping needed) -- not gradient-based, to avoid
 *   introducing numerical-gradient bugs into code this consequential;
 *   grid search is slower but every candidate point is independently and
 *   transparently evaluated. The stationarity constraint alpha < beta is
 *   enforced by excluding non-stationary grid points outright.
 *
 * VALIDATED, in three independent layers, before being trusted (see this
 *   module's own commit history for the exact numbers from each check):
 *   (1) parameter recovery -- fitting simulated data with KNOWN true
 *   (mu, alpha, beta) recovers values within ~15% of truth; (2) Type I
 *   error -- running the full test on true Poisson data at alpha=0.05
 *   rejects at close to the nominal rate, not some inflated or deflated
 *   rate; (3) power -- running the full test on true, strongly
 *   self-exciting Hawkes data correctly and confidently detects it.
 *
 * TIMESTAMPS, NOT GAPS: unlike every other stage in this hierarchy, the
 *   Hawkes model is naturally specified on ABSOLUTE event times, not
 *   inter-event gaps -- gapsToEventTimes() converts one to the other
 *   (cumulative sum), since Stages C-F all operate on the gap
 *   representation.
 *
 * COMPUTATIONAL COST, disclosed: each Monte Carlo simulation requires
 *   fitting BOTH models via grid search (O(rounds * pointsPerDim^3 * n)
 *   each) -- meaningfully more expensive than any earlier stage. Default
 *   numSimulations is kept modest (200) accordingly; a real analysis run
 *   can raise it, at proportional cost.
 *
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng --
 *   unmodified, reused for both the Hawkes-process simulator and the
 *   Monte Carlo calibration, same discipline as every Monte Carlo
 *   procedure elsewhere in this codebase).
 * Public API: hawkesLogLikelihood, fitHawkesMLE, fitPoissonMLE,
 *   simulateHawkesProcess, simulatePoissonProcess, gapsToEventTimes,
 *   testHawkesStage, HawkesTestError.
 * Complexity: O(n) per log-likelihood evaluation; O(rounds *
 *   pointsPerDim^3 * n) per MLE fit; O(numSimulations * fit cost) for
 *   the calibrated p-value.
 */

import { createSeededRng } from './uncertaintyEstimation.js';

export class HawkesTestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HawkesTestError';
  }
}

/** Converts a gap sequence into cumulative absolute event times (t_0 = 0). */
export function gapsToEventTimes(gaps) {
  const times = [];
  let t = 0;
  for (const g of gaps) { t += g; times.push(t); }
  return times;
}

/**
 * Hawkes process log-likelihood (single exponential kernel), computed via
 * the standard O(n) recursion (Ogata 1981): A_i = exp(-beta*(t_i - t_{i-1})) * (1 + A_{i-1}),
 * lambda(t_i) = mu + alpha * A_i for i > 1 (A_1 = 0, lambda(t_1) = mu).
 * @param {number[]} eventTimes - Strictly increasing, real event times.
 * @param {number} mu - Baseline intensity (> 0).
 * @param {number} alpha - Excitation magnitude (>= 0).
 * @param {number} beta - Decay rate (> alpha, for stationarity).
 * @param {number} T - Observation window end (>= last event time).
 * @returns {number}
 */
export function hawkesLogLikelihood(eventTimes, mu, alpha, beta, T) {
  const n = eventTimes.length;
  if (n === 0) return -mu * T;
  let A = 0;
  let logLambdaSum = Math.log(mu);
  for (let i = 1; i < n; i++) {
    A = Math.exp(-beta * (eventTimes[i] - eventTimes[i - 1])) * (1 + A);
    logLambdaSum += Math.log(mu + alpha * A);
  }
  let excitationIntegral = 0;
  for (const ti of eventTimes) excitationIntegral += (alpha / beta) * (1 - Math.exp(-beta * (T - ti)));
  return logLambdaSum - (mu * T + excitationIntegral);
}

function geomSpace(lo, hi, n) {
  const vals = [];
  const logLo = Math.log(lo), logHi = Math.log(hi);
  for (let i = 0; i < n; i++) vals.push(Math.exp(logLo + (logHi - logLo) * i / (n - 1)));
  return vals;
}

/**
 * Deterministic, coarse-to-fine grid-search MLE fit of a Hawkes process.
 * No randomness -- same starting ranges and shrink schedule every call
 * for the same input.
 * @param {number[]} eventTimes
 * @param {number} T
 * @param {object} [options]
 * @param {number} [options.rounds=3]
 * @param {number} [options.pointsPerDim=7]
 * @returns {{ mu: number, alpha: number, beta: number, ll: number }}
 */
export function fitHawkesMLE(eventTimes, T, { rounds = 3, pointsPerDim = 7 } = {}) {
  const n = eventTimes.length;
  const meanRate = Math.max(n / T, 1e-6);
  let muRange = [meanRate * 0.2, meanRate * 2.5];
  let alphaRange = [1e-4, 3];
  let betaRange = [0.05, 15];
  let best = { mu: meanRate, alpha: 1e-4, beta: 1, ll: hawkesLogLikelihood(eventTimes, meanRate, 1e-4, 1, T) };

  for (let r = 0; r < rounds; r++) {
    const muVals = geomSpace(muRange[0], muRange[1], pointsPerDim);
    const alphaVals = geomSpace(alphaRange[0], alphaRange[1], pointsPerDim);
    const betaVals = geomSpace(betaRange[0], betaRange[1], pointsPerDim);
    let roundBest = { ...best };
    for (const mu of muVals) {
      for (const alpha of alphaVals) {
        for (const beta of betaVals) {
          if (alpha >= beta) continue; // enforce stationarity
          const ll = hawkesLogLikelihood(eventTimes, mu, alpha, beta, T);
          if (ll > roundBest.ll) roundBest = { mu, alpha, beta, ll };
        }
      }
    }
    best = roundBest;
    const shrink = 3;
    muRange = [best.mu / shrink, best.mu * shrink];
    alphaRange = [Math.max(1e-4, best.alpha / shrink), best.alpha * shrink];
    betaRange = [Math.max(0.05, best.beta / shrink), best.beta * shrink];
  }
  return best;
}

/** Trivial closed-form Poisson MLE fit: mu_hat = n / T. */
export function fitPoissonMLE(eventTimes, T) {
  const n = eventTimes.length;
  const mu = n / T;
  return { mu, ll: -mu * T + n * Math.log(Math.max(mu, 1e-300)) };
}

/**
 * Simulates a Hawkes process (exponential kernel) via Ogata's (1981)
 * thinning algorithm.
 * @param {number} mu
 * @param {number} alpha
 * @param {number} beta
 * @param {number} T
 * @param {() => number} rng - A seeded RNG (createSeededRng output).
 * @returns {number[]} strictly increasing event times in [0, T].
 */
export function simulateHawkesProcess(mu, alpha, beta, T, rng) {
  let t = 0;
  const events = [];
  while (t < T) {
    let lambdaBar = mu;
    for (const ti of events) lambdaBar += alpha * Math.exp(-beta * (t - ti));
    const candidate = t - Math.log(rng()) / lambdaBar;
    if (candidate > T) break;
    let lambdaAtCandidate = mu;
    for (const ti of events) lambdaAtCandidate += alpha * Math.exp(-beta * (candidate - ti));
    if (rng() <= lambdaAtCandidate / lambdaBar) events.push(candidate);
    t = candidate;
  }
  return events;
}

/** Simulates a homogeneous Poisson process via standard exponential-gap sampling. */
export function simulatePoissonProcess(mu, T, rng) {
  let t = 0;
  const events = [];
  while (true) {
    t += -Math.log(rng()) / mu;
    if (t > T) break;
    events.push(t);
  }
  return events;
}

/**
 * Stage G: tests whether event times show genuine self-excitation beyond
 * a homogeneous Poisson process, via a Monte Carlo-calibrated
 * likelihood-ratio test (Hawkes MLE vs. Poisson MLE, both fitted to the
 * same data).
 *
 * @param {number[]} eventTimes - Strictly increasing absolute event times
 *   (use gapsToEventTimes() if starting from a gap sequence).
 * @param {number} T - Observation window end.
 * @param {object} [options]
 * @param {number} options.seed - Required (no hidden randomness).
 * @param {number} [options.numSimulations=200]
 * @param {number} [options.alpha=0.05]
 * @param {object} [options.fitOptions] - Passed through to fitHawkesMLE
 *   (rounds/pointsPerDim) for both the observed and every simulated fit.
 * @returns {{
 *   stage: 'Hawkes', likelihoodRatio: number, pValue: number,
 *   hawkesParams: { mu: number, alpha: number, beta: number, ll: number },
 *   poissonParams: { mu: number, ll: number },
 *   sampleSize: number, numSimulations: number,
 *   selfExcitationDetected: boolean
 * }}
 */
export function testHawkesStage(eventTimes, T, { seed, numSimulations = 200, alpha = 0.05, fitOptions = {} } = {}) {
  if (!Array.isArray(eventTimes) || eventTimes.length < 5) {
    throw new HawkesTestError('testHawkesStage: eventTimes must be an array of at least 5 event times');
  }
  for (let i = 1; i < eventTimes.length; i++) {
    if (!(eventTimes[i] > eventTimes[i - 1])) {
      throw new HawkesTestError('testHawkesStage: eventTimes must be strictly increasing');
    }
  }
  if (!Number.isFinite(T) || T <= eventTimes[eventTimes.length - 1]) {
    throw new HawkesTestError('testHawkesStage: T must be a finite number greater than or equal to the last event time');
  }
  if (seed === undefined || seed === null) {
    throw new HawkesTestError('testHawkesStage: an explicit seed is required (no hidden randomness)');
  }

  const poissonFit = fitPoissonMLE(eventTimes, T);
  const hawkesFit = fitHawkesMLE(eventTimes, T, fitOptions);
  const observedLR = Math.max(0, 2 * (hawkesFit.ll - poissonFit.ll));

  const rng = createSeededRng(seed);
  let atLeastAsExtreme = 0;
  for (let sim = 0; sim < numSimulations; sim++) {
    const simEvents = simulatePoissonProcess(poissonFit.mu, T, rng);
    const simPoisson = fitPoissonMLE(simEvents, T);
    const simHawkes = fitHawkesMLE(simEvents, T, fitOptions);
    const simLR = Math.max(0, 2 * (simHawkes.ll - simPoisson.ll));
    if (simLR >= observedLR) atLeastAsExtreme++;
  }
  const pValue = atLeastAsExtreme / numSimulations;

  return {
    stage: 'Hawkes', likelihoodRatio: observedLR, pValue,
    hawkesParams: hawkesFit, poissonParams: poissonFit,
    sampleSize: eventTimes.length, numSimulations,
    selfExcitationDetected: pValue < alpha,
  };
}
