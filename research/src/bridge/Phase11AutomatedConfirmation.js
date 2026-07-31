/**
 * research/src/bridge/Phase11AutomatedConfirmation.js
 *
 * Purpose:
 *   Replaces manual p-value entry with a genuinely automated Round 3
 *   confirmation test. A p-value is an OUTPUT of a statistical procedure,
 *   never a user input — this module computes one, end to end, from the
 *   candidate's own mathematical definition applied to the confirmation
 *   dataset, and submits the result to the existing, unmodified
 *   Phase11ConfirmationBridge.js (which itself calls the existing,
 *   unmodified discoveryDecision.evaluateDiscoveryCandidate(), the ONLY
 *   code path permitted to spend Online-FDR alpha).
 *
 * Statistical procedure (reuses existing, already-tested primitives —
 *   nothing here reimplements a null distribution or a p-value formula):
 *   1. Compute the candidate's indicator series over the confirmation
 *      dataset's price series, using the candidate's own
 *      indicatorName/period (its mathematical definition) — see
 *      computeIndicatorSeries below.
 *   2. Compute the outcome series (did the target N-tick run condition
 *      hold, forward-looking from each point) — see computeOutcomeSeries.
 *   3. Observed statistic: |Pearson correlation| between the indicator
 *      series and the outcome series (a signed, standard, always-
 *      re-derivable statistic; absolute value so the existing
 *      "null >= observed" one-sided permutation-test formula in
 *      statistics/permutationTest.js applies correctly regardless of the
 *      correlation's sign).
 *   4. Null distribution + p-value: statistics/permutationTest.js's own
 *      computeCircularShiftPermutationTest — the SAME existing procedure
 *      already used by Phase 9 (randomnessAudit.js/rngForensics.js cite
 *      this exact primitive). Not reimplemented here.
 *   5. Effect size + standard error + 95% CI: a paired bootstrap over the
 *      (indicator, outcome) pairs, using statistics/uncertaintyEstimation.js's
 *      existing createSeededRng (the same "no hidden randomness, seed
 *      required" discipline already established there) — reused, not a
 *      second PRNG. computeBootstrapCI itself only accepts a flat numeric
 *      array, so a small (few-line) paired-resampling loop is implemented
 *      here rather than modifying that module; it performs no different
 *      resampling logic than computeBootstrapCI already does, just over
 *      index pairs instead of a flat array.
 *   6. The computed p-value is submitted to Phase11ConfirmationBridge.js's
 *      existing confirmPhase11Candidate() exactly as Stage 1 built it —
 *      unchanged, still the only place alpha is spent.
 *
 * Graceful failure: if the confirmation dataset doesn't have enough valid
 *   (indicator, outcome) pairs for a meaningful test, this throws
 *   Phase11InsufficientDataError with a specific scientific explanation
 *   (how many pairs were available vs. required) — it never falls back to
 *   asking a human for a number, and never fabricates one.
 *
 * Dependencies: statistics/permutationTest.js (computeCircularShiftPermutationTest
 *   — unmodified), statistics/uncertaintyEstimation.js (createSeededRng —
 *   unmodified, reused), bridge/Phase11ConfirmationBridge.js
 *   (confirmPhase11Candidate — unmodified, still the sole submission path).
 * Public API: computeIndicatorSeries, computeOutcomeSeries,
 *   runAutomatedConfirmationTest, confirmPhase11CandidateAutomatically,
 *   Phase11InsufficientDataError.
 * Complexity: O(n) indicator/outcome computation + O(permutations * n)
 *   for the permutation test (see that module's own complexity note) +
 *   O(numResamples * n) for the bootstrap CI.
 */

import { computeCircularShiftPermutationTest } from '../statistics/permutationTest.js';
import { createSeededRng } from '../statistics/uncertaintyEstimation.js';
import { confirmPhase11Candidate } from './Phase11ConfirmationBridge.js';

export class Phase11InsufficientDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11InsufficientDataError';
  }
}

const MIN_ALIGNED_PAIRS = 60; // below this, a permutation test's null is not meaningfully estimable

/**
 * Computes the candidate's indicator reading at every valid index of a
 * price series — this IS "the candidate's mathematical definition" (its
 * indicatorName + period), applied for real, not a placeholder.
 *
 * @param {string} indicatorName - 'RSI' | 'EMA_SLOPE' | 'CCI'.
 * @param {number} period
 * @param {number[]} prices
 * @returns {number[]} One value per input index; NaN where insufficient
 *   lookback exists yet (trimmed by the caller before use).
 */
export function computeIndicatorSeries(indicatorName, period, prices) {
  const n = prices.length;
  const out = new Array(n).fill(NaN);

  if (indicatorName === 'RSI') {
    let avgGain = null, avgLoss = null;
    for (let i = 1; i < n; i++) {
      const change = prices[i] - prices[i - 1];
      const gain = Math.max(change, 0), loss = Math.max(-change, 0);
      if (i <= period) {
        avgGain = (avgGain ?? 0) + gain / period;
        avgLoss = (avgLoss ?? 0) + loss / period;
        if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  if (indicatorName === 'EMA_SLOPE') {
    const k = 2 / (period + 1);
    let ema = null;
    const emaSeries = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      ema = ema === null ? prices[i] : prices[i] * k + ema * (1 - k);
      emaSeries[i] = ema;
    }
    for (let i = 1; i < n; i++) out[i] = emaSeries[i] - emaSeries[i - 1];
    return out;
  }

  if (indicatorName === 'CCI') {
    // Standard CCI formula with "typical price" simplified to the raw
    // price itself (tick-level data has no high/low/close to average) —
    // an honest, disclosed simplification, not a different indicator.
    for (let i = period - 1; i < n; i++) {
      const window = prices.slice(i - period + 1, i + 1);
      const sma = window.reduce((a, b) => a + b, 0) / period;
      const meanAbsDev = window.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
      out[i] = meanAbsDev === 0 ? 0 : (prices[i] - sma) / (0.015 * meanAbsDev);
    }
    return out;
  }

  throw new Phase11InsufficientDataError(`computeIndicatorSeries: unrecognised indicatorName "${indicatorName}"`);
}

/**
 * Computes the forward-looking outcome series: 1 if the next `runLength`
 * ticks are ALL strictly in `direction` from the current point (matching
 * this app's own "N consecutive ticks" run definition, e.g. "5 rises in a
 * row"), else 0. NaN where there isn't enough forward lookahead left.
 *
 * @param {number[]} prices
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} targetDefinition
 * @returns {number[]}
 */
export function computeOutcomeSeries(prices, { direction, runLength }) {
  const n = prices.length;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i + runLength < n; i++) {
    let allMatch = true;
    for (let k = 0; k < runLength; k++) {
      const isRise = prices[i + k + 1] > prices[i + k];
      if ((direction === 'Rise') !== isRise) { allMatch = false; break; }
    }
    out[i] = allMatch ? 1 : 0;
  }
  return out;
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

/** Paired bootstrap (resample INDEX pairs together) for effect size + SE + 95% CI. Reuses createSeededRng, not a second PRNG. */
function bootstrapPairedCorrelation(xs, ys, { confidenceLevel = 0.95, numResamples = 2000, seed }) {
  const rng = createSeededRng(seed);
  const n = xs.length;
  const replicates = new Array(numResamples);
  for (let r = 0; r < numResamples; r++) {
    const rxs = new Array(n), rys = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      rxs[i] = xs[idx]; rys[i] = ys[idx];
    }
    replicates[r] = pearsonCorrelation(rxs, rys);
  }
  replicates.sort((a, b) => a - b);
  const mean = replicates.reduce((a, b) => a + b, 0) / numResamples;
  const variance = replicates.reduce((a, b) => a + (b - mean) ** 2, 0) / (numResamples - 1);
  const alpha = 1 - confidenceLevel;
  const lowerIdx = Math.floor((alpha / 2) * numResamples);
  const upperIdx = Math.ceil((1 - alpha / 2) * numResamples) - 1;
  return {
    pointEstimate: pearsonCorrelation(xs, ys),
    standardError: Math.sqrt(variance),
    ciLower: replicates[Math.max(0, lowerIdx)],
    ciUpper: replicates[Math.min(numResamples - 1, upperIdx)],
    confidenceLevel,
  };
}

/**
 * Runs the full automated statistical procedure. Never asks for or
 * accepts a p-value as input — computes one.
 *
 * @param {object} params
 * @param {object} params.candidate - Provides indicatorName/period.
 * @param {number[]} params.prices - The confirmation dataset's real price series.
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} params.targetDefinition
 * @param {number} params.seed - Required (no hidden randomness).
 * @param {number} [params.permutations=1000]
 * @param {number} [params.bootstrapResamples=2000]
 * @returns {{
 *   observedStatistic: number, effectSize: number, standardError: number,
 *   ci95: [number, number], pValue: number, sampleSize: number,
 *   permutations: number, nullModel: string, seed: number
 * }}
 */
export function runAutomatedConfirmationTest({
  candidate, prices, targetDefinition, seed, permutations = 1000, bootstrapResamples = 2000,
} = {}) {
  const indicatorSeries = computeIndicatorSeries(candidate.indicatorName, candidate.period, prices);
  const outcomeSeries = computeOutcomeSeries(prices, targetDefinition);

  const featureValues = [], outcomeValues = [];
  for (let i = 0; i < prices.length; i++) {
    if (Number.isFinite(indicatorSeries[i]) && Number.isFinite(outcomeSeries[i])) {
      featureValues.push(indicatorSeries[i]);
      outcomeValues.push(outcomeSeries[i]);
    }
  }

  if (featureValues.length < MIN_ALIGNED_PAIRS) {
    throw new Phase11InsufficientDataError(
      `runAutomatedConfirmationTest: only ${featureValues.length} valid (indicator, outcome) pairs are available after ` +
      `aligning the ${candidate.indicatorName}-${candidate.period} series with the ${targetDefinition.runLength}-tick ` +
      `${targetDefinition.direction} outcome window — at least ${MIN_ALIGNED_PAIRS} are required for a scientifically ` +
      'meaningful permutation-test null distribution. Let more ticks accumulate and try again.'
    );
  }

  const absCorrelationStat = (xs, ys) => Math.abs(pearsonCorrelation(xs, ys));

  const permTest = computeCircularShiftPermutationTest({
    featureValues, outcomeValues, statisticFn: absCorrelationStat, permutations, seed,
  });

  const bootstrap = bootstrapPairedCorrelation(featureValues, outcomeValues, { numResamples: bootstrapResamples, seed: seed + 1 });

  return {
    observedStatistic: permTest.observedStatistic,
    effectSize: bootstrap.pointEstimate,
    standardError: bootstrap.standardError,
    ci95: [bootstrap.ciLower, bootstrap.ciUpper],
    pValue: permTest.pValue,
    sampleSize: featureValues.length,
    permutations: permTest.permutations,
    nullModel: permTest.nullModel,
    seed,
  };
}

/**
 * Runs the automated confirmation test and, if successful, submits the
 * computed p-value to the existing, unmodified Phase11ConfirmationBridge.js.
 * Never spends alpha itself; never asks for manual input.
 *
 * @param {object} params - All of runAutomatedConfirmationTest's params,
 *   plus everything Phase11ConfirmationBridge.confirmPhase11Candidate needs
 *   (researchFreeze, sap, researchConfiguration, datasetManifest, provenance,
 *   familyRegistry, market, targetDefinition, decisionAuditLog,
 *   negativeEvidenceRegistry, knowledgeGraphCandidateNode).
 * @returns {Promise<{ outcome: 'confirmed'|'rejected', candidate: object,
 *   hypothesisId: string, familyKey: string, legacyResult: object,
 *   statisticalReport: object }>}
 */
export async function confirmPhase11CandidateAutomatically(params) {
  const statisticalReport = runAutomatedConfirmationTest(params);
  const confirmResult = await confirmPhase11Candidate({ ...params, pValue: statisticalReport.pValue });
  return { ...confirmResult, statisticalReport };
}
