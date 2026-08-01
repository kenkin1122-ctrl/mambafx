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

export const MIN_ALIGNED_PAIRS = 60; // below this, a permutation test's null is not meaningfully estimable

/**
 * Computes the candidate's indicator reading at every valid index of a
 * price series, by delegating to the canonical indicator/IndicatorRegistry.js
 * -- the SAME registry candidate generation (discovery/
 * registryDrivenCandidateGenerator.js) and the original 3-candidate demo
 * (startPhase11Campaign.js) both resolve indicator identity through. This
 * function computes NOTHING itself: it looks up
 * indicatorRegistry.lookup(indicatorName) and calls that plugin's own
 * compute({prices, period}), exactly as generateCandidate()'s own callers
 * never reimplement indicator math either.
 *
 * PRIOR DESIGN (removed by this change): this function used to contain its
 * own hardcoded RSI/EMA_SLOPE/CCI formulas, entirely separate from the
 * Indicator Registry's real plugins of the same names. That duplication is
 * what caused "unrecognised indicatorName 'EMA'" for registry-generated
 * candidates: this function's hardcoded three-name list had no way to
 * know about the Indicator Registry's other 26 plugins, because it wasn't
 * consulting the registry at all. Verified byte-for-byte equivalent before
 * removal: the old hardcoded RSI and CCI formulas were IDENTICAL to
 * indicator/coreIndicators.js's RSIIndicator/CCIIndicator (same Wilder
 * smoothing, same mean-absolute-deviation CCI) -- so this change produces
 * IDENTICAL statistical results for existing RSI/CCI candidates, zero
 * behavioral change. EMA_SLOPE had no registry equivalent at all; it is
 * now registered as indicator/coreIndicators.js's EMASlopeIndicator,
 * using the EXACT SAME formula this function used to hardcode -- so the
 * original 3-candidate demo campaign's statistical behavior is preserved
 * exactly, just resolved through the canonical registry instead of a
 * second, parallel implementation.
 *
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} indicatorRegistry
 *   The canonical registry. Required -- there is no fallback hardcoded
 *   formula set anymore.
 * @param {string} indicatorName
 * @param {number} period
 * @param {number[]} prices
 * @returns {number[]} One value per input index; NaN where insufficient
 *   lookback exists yet (trimmed by the caller before use).
 */
export function computeIndicatorSeries(indicatorRegistry, indicatorName, period, prices) {
  if (!indicatorRegistry || typeof indicatorRegistry.lookup !== 'function') {
    throw new Phase11InsufficientDataError(
      'computeIndicatorSeries: a valid IndicatorRegistry is required -- indicator computation is no longer hardcoded in this module'
    );
  }
  const plugin = indicatorRegistry.lookup(indicatorName);
  if (!plugin) {
    throw new Phase11InsufficientDataError(
      `computeIndicatorSeries: "${indicatorName}" is not registered in the canonical Indicator Registry. ` +
      `Registered indicators: ${indicatorRegistry.listNames().join(', ')}.`
    );
  }
  const { signal } = plugin.compute({ prices, period });
  return signal;
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
  const stdDev = Math.sqrt(variance);
  const skewness = stdDev === 0 ? 0
    : (replicates.reduce((a, b) => a + (b - mean) ** 3, 0) / numResamples) / (stdDev ** 3);
  const alpha = 1 - confidenceLevel;
  const lowerIdx = Math.floor((alpha / 2) * numResamples);
  const upperIdx = Math.ceil((1 - alpha / 2) * numResamples) - 1;
  return {
    pointEstimate: pearsonCorrelation(xs, ys),
    standardError: stdDev,
    ciLower: replicates[Math.max(0, lowerIdx)],
    ciUpper: replicates[Math.min(numResamples - 1, upperIdx)],
    confidenceLevel,
    skewness,
    replicates,
  };
}

/**
 * Runs the full automated statistical procedure. Never asks for or
 * accepts a p-value as input — computes one.
 *
 * @param {object} params
 * @param {object} params.candidate - Provides indicatorName/period. Unused
 *   if featureValues/outcomeValues are both supplied directly.
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} [params.indicatorRegistry]
 *   The canonical Indicator Registry -- required unless featureValues/
 *   outcomeValues are both supplied directly (the Validation Suite's path,
 *   which never resolves a candidate's indicatorName at all).
 * @param {number[]} [params.prices] - The confirmation dataset's real price
 *   series. Required unless featureValues/outcomeValues are both supplied.
 * @param {number[]} [params.featureValues] - Optional pre-computed indicator
 *   series (bypasses computeIndicatorSeries) — used by the Validation Suite
 *   (research/src/validation/) to inject null-hypothesis or synthetic-effect
 *   data directly without needing a synthetic price series for every case.
 * @param {number[]} [params.outcomeValues] - Optional pre-computed outcome
 *   series, paired with featureValues (same requirement as above).
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} [params.targetDefinition]
 *   Required unless featureValues/outcomeValues are both supplied.
 * @param {number} params.seed - Required (no hidden randomness).
 * @param {number} [params.permutations=1000]
 * @param {number} [params.bootstrapResamples=2000]
 * @returns {{
 *   observedStatistic: number, effectSize: number, standardError: number,
 *   ci95: [number, number], pValue: number, sampleSize: number,
 *   permutations: number, nullModel: string, seed: number,
 *   nullMean: number, nullVariance: number, monteCarloStandardError: number,
 *   minAttainablePValue: number, bootstrapCiWidth: number,
 *   bootstrapSkewness: number, instabilityWarning: string|null
 * }}
 */
export function runAutomatedConfirmationTest({
  candidate, indicatorRegistry, prices, featureValues: injectedFeatureValues, outcomeValues: injectedOutcomeValues,
  targetDefinition, seed, permutations = 1000, bootstrapResamples = 2000,
} = {}) {
  let featureValues, outcomeValues;

  if (injectedFeatureValues && injectedOutcomeValues) {
    if (injectedFeatureValues.length !== injectedOutcomeValues.length) {
      throw new Phase11InsufficientDataError('runAutomatedConfirmationTest: injected featureValues and outcomeValues must be equal-length arrays');
    }
    featureValues = injectedFeatureValues;
    outcomeValues = injectedOutcomeValues;
  } else {
    const indicatorSeries = computeIndicatorSeries(indicatorRegistry, candidate.indicatorName, candidate.period, prices);
    const outcomeSeries = computeOutcomeSeries(prices, targetDefinition);
    featureValues = []; outcomeValues = [];
    for (let i = 0; i < prices.length; i++) {
      if (Number.isFinite(indicatorSeries[i]) && Number.isFinite(outcomeSeries[i])) {
        featureValues.push(indicatorSeries[i]);
        outcomeValues.push(outcomeSeries[i]);
      }
    }
  }

  if (featureValues.length < MIN_ALIGNED_PAIRS) {
    throw new Phase11InsufficientDataError(
      `runAutomatedConfirmationTest: only ${featureValues.length} valid (indicator, outcome) pairs are available -- ` +
      `at least ${MIN_ALIGNED_PAIRS} are required for a scientifically meaningful permutation-test null distribution. ` +
      'Let more ticks accumulate and try again.'
    );
  }

  const absCorrelationStat = (xs, ys) => Math.abs(pearsonCorrelation(xs, ys));

  const permTest = computeCircularShiftPermutationTest({
    featureValues, outcomeValues, statisticFn: absCorrelationStat, permutations, seed,
  });

  const bootstrap = bootstrapPairedCorrelation(featureValues, outcomeValues, { numResamples: bootstrapResamples, seed: seed + 1 });

  // ── Permutation diagnostics (Section 4): derived from the SAME null
  //    distribution the p-value above was actually computed from — never a
  //    second, independently-generated null.
  const nd = permTest.nullDistribution;
  const nullMean = nd.reduce((a, b) => a + b, 0) / nd.length;
  const nullVariance = nd.reduce((a, b) => a + (b - nullMean) ** 2, 0) / Math.max(1, nd.length - 1);
  const monteCarloStandardError = Math.sqrt((permTest.pValue * (1 - permTest.pValue)) / permutations);
  const minAttainablePValue = 1 / (permutations + 1);

  // ── Bootstrap diagnostics (Section 3).
  const bootstrapCiWidth = bootstrap.ciUpper - bootstrap.ciLower;
  const instabilityWarnings = [];
  if (Math.abs(bootstrap.skewness) > 1) instabilityWarnings.push(`bootstrap distribution is notably skewed (skewness=${bootstrap.skewness.toFixed(3)})`);
  if (bootstrapCiWidth > 1.5) instabilityWarnings.push(`bootstrap 95% CI is unusually wide (width=${bootstrapCiWidth.toFixed(3)}) for a correlation-bounded [-1,1] statistic`);
  if (permTest.pValue <= minAttainablePValue) instabilityWarnings.push(`observed p-value equals the minimum attainable value for ${permutations} permutations -- consider increasing permutations for a finer-grained estimate`);

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
    nullMean,
    nullVariance,
    monteCarloStandardError,
    minAttainablePValue,
    bootstrapCiWidth,
    bootstrapSkewness: bootstrap.skewness,
    instabilityWarning: instabilityWarnings.length ? instabilityWarnings.join('; ') : null,
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
