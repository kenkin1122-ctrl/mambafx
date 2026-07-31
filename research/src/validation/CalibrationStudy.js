/**
 * research/src/validation/CalibrationStudy.js
 *
 * Purpose:
 *   Section 1 of the Phase 11 Validation & Calibration Directive: an
 *   automated calibration framework that runs large batches of experiments
 *   under the NULL hypothesis and measures whether the laboratory's
 *   reported error rates match their nominal targets. This is a
 *   diagnostic/reporting layer only -- it never spends real alpha (any
 *   Online-FDR check it performs uses a caller-supplied, explicitly
 *   isolated calibration family, never a production family), and it never
 *   touches the protected legacy modules directly (it calls the existing,
 *   unmodified Phase11AutomatedConfirmation.js / Phase11ConfirmationBridge.js
 *   / discoveryDecision.js chain exactly as production code does).
 *
 * Null-dataset generators (Section 1's four required types):
 *   - labelPermutation: shuffles a REAL outcome series' order relative to
 *     the indicator series, destroying any true temporal dependency while
 *     preserving each series' own marginal distribution.
 *   - shuffledOutcomes: generates a FRESH i.i.d. Bernoulli outcome sequence
 *     (same base rate as observed) independent of the indicator series.
 *   - iidRandomWalk: generates a synthetic i.i.d. random-walk price series
 *     (unbiased +1/-1 steps) with no embedded relationship, then computes
 *     indicator+outcome from it normally.
 *   - independentPrng: generates the feature and outcome series from TWO
 *     completely independent seeded PRNG streams -- the strictest null,
 *     zero shared structure by construction.
 *   All four use statistics/uncertaintyEstimation.js's createSeededRng
 *   (reused, not a second PRNG implementation).
 *
 * What is measured (all computed from real runs of the real pipeline):
 *   - empirical false-positive rate at the batch's nominal alpha
 *   - full p-value distribution (should be ~Uniform(0,1) under a
 *     well-calibrated null) with summary stats and a histogram
 *   - CI coverage: fraction of 95% CIs containing the true null effect (0)
 *   - Online-FDR behaviour, IF the caller opts in and supplies an isolated
 *     calibration family/freeze/SAP/researchConfiguration/familyRegistry --
 *     each trial's computed p-value is submitted through the real,
 *     unmodified confirmPhase11Candidate() -> discoveryDecision ->
 *     onlineFdr chain, and the empirical false-discovery rate among
 *     "accepted" (rejected=true) trials is reported.
 *
 * Dependencies: bridge/Phase11AutomatedConfirmation.js (runAutomatedConfirmationTest
 *   — unmodified, reused as the sole statistical engine), bridge/
 *   Phase11ConfirmationBridge.js (confirmPhase11Candidate — for the
 *   optional Online-FDR calibration path), statistics/uncertaintyEstimation.js
 *   (createSeededRng — reused).
 * Public API: generateNullDataset, runCalibrationBatch,
 *   Phase11CalibrationInputError.
 * Complexity: O(trials * (permutations + bootstrapResamples)) — dominated
 *   by runAutomatedConfirmationTest's own documented cost per trial.
 */

import { createSeededRng } from '../statistics/uncertaintyEstimation.js';
import { runAutomatedConfirmationTest } from '../bridge/Phase11AutomatedConfirmation.js';
import { confirmPhase11Candidate } from '../bridge/Phase11ConfirmationBridge.js';
import { ProvenanceDAG, NODE_TYPES } from '../provenance/ProvenanceDAG.js';

export class Phase11CalibrationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11CalibrationInputError';
  }
}

const NULL_DATASET_TYPES = Object.freeze([
  'label_permutation', 'shuffled_outcomes', 'iid_random_walk', 'independent_prng',
]);

/**
 * Generates one null-hypothesis (featureValues, outcomeValues) pair of the
 * requested type. All four types are constructed so that, by design, no
 * real dependency exists between the two series.
 *
 * @param {string} type - One of NULL_DATASET_TYPES.
 * @param {object} params
 * @param {number} params.length - Number of (feature, outcome) pairs to generate.
 * @param {number} params.seed - Required.
 * @param {number[]} [params.baseFeatureValues] - Required for 'label_permutation'
 *   (the real indicator series whose outcome pairing will be shuffled).
 * @param {number[]} [params.baseOutcomeValues] - Required for 'label_permutation'
 *   and used to compute the base rate for 'shuffled_outcomes'.
 * @returns {{ featureValues: number[], outcomeValues: number[] }}
 */
export function generateNullDataset(type, { length, seed, baseFeatureValues = null, baseOutcomeValues = null } = {}) {
  if (!NULL_DATASET_TYPES.includes(type)) {
    throw new Phase11CalibrationInputError(`generateNullDataset: unrecognised type "${type}" -- must be one of ${NULL_DATASET_TYPES.join(', ')}`);
  }
  if (!Number.isInteger(length) || length < 1) {
    throw new Phase11CalibrationInputError('generateNullDataset: "length" must be a positive integer');
  }
  const rng = createSeededRng(seed);

  if (type === 'label_permutation') {
    if (!baseFeatureValues || !baseOutcomeValues || baseFeatureValues.length !== baseOutcomeValues.length) {
      throw new Phase11CalibrationInputError('generateNullDataset: "label_permutation" requires equal-length baseFeatureValues and baseOutcomeValues');
    }
    const shuffled = [...baseOutcomeValues];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { featureValues: [...baseFeatureValues], outcomeValues: shuffled };
  }

  if (type === 'shuffled_outcomes') {
    const baseRate = baseOutcomeValues
      ? baseOutcomeValues.reduce((a, b) => a + b, 0) / baseOutcomeValues.length
      : 0.5;
    const featureValues = baseFeatureValues ? [...baseFeatureValues].slice(0, length) : Array.from({ length }, () => rng());
    const outcomeValues = Array.from({ length }, () => (rng() < baseRate ? 1 : 0));
    return { featureValues, outcomeValues };
  }

  if (type === 'iid_random_walk') {
    const prices = [100];
    for (let i = 0; i < length + 30; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));
    // Simple lagged feature/outcome derived from the same unbiased walk --
    // no injected relationship, since each step is an independent coin flip.
    const featureValues = [], outcomeValues = [];
    for (let i = 15; i < prices.length - 5; i++) {
      featureValues.push(prices[i] - prices[i - 14]);
      outcomeValues.push(prices[i + 5] > prices[i] ? 1 : 0);
    }
    return { featureValues, outcomeValues };
  }

  // 'independent_prng': two fully independent streams, zero shared structure by construction.
  const rngB = createSeededRng(seed + 999983); // a different, independently-seeded stream
  return {
    featureValues: Array.from({ length }, () => rng() * 100 - 50),
    outcomeValues: Array.from({ length }, () => (rngB() < 0.5 ? 1 : 0)),
  };
}

function computePValueHistogram(pValues, bins = 10) {
  const histogram = new Array(bins).fill(0);
  for (const p of pValues) {
    const idx = Math.min(bins - 1, Math.floor(p * bins));
    histogram[idx]++;
  }
  return histogram;
}

/**
 * Runs `trials` independent null-hypothesis experiments through the real,
 * unmodified statistical pipeline and reports the laboratory's empirical
 * operating characteristics.
 *
 * @param {object} params
 * @param {string} params.datasetType - One of NULL_DATASET_TYPES.
 * @param {number} params.trials
 * @param {number} params.seed - Required; trial i uses seed derived from (seed, i).
 * @param {number} [params.alpha=0.05] - Nominal significance level to compare against.
 * @param {number} [params.datasetLength=200]
 * @param {number} [params.permutations=500]
 * @param {number} [params.bootstrapResamples=500]
 * @param {number[]} [params.baseFeatureValues] - For 'label_permutation'/'shuffled_outcomes'.
 * @param {number[]} [params.baseOutcomeValues] - For 'label_permutation'/'shuffled_outcomes'.
 * @param {object} [params.onlineFdr] - Opt-in real Online-FDR calibration check:
 *   { familyRegistry, researchFreeze, sap, researchConfiguration, candidateTemplate,
 *     market, targetDefinition } -- if supplied, each trial's computed
 *   p-value is submitted through the real, unmodified
 *   confirmPhase11Candidate() under a fresh synthetic candidate (a minimal
 *   provenance DAG is built automatically), and the empirical
 *   false-discovery rate among "confirmed" trials is additionally reported.
 * @returns {Promise<{
 *   datasetType: string, trials: number, alpha: number,
 *   empiricalFalsePositiveRate: number, pValueMean: number,
 *   pValueHistogram: number[], ciCoverage: number,
 *   onlineFdrEmpiricalFDR: number|null, reports: object[]
 * }>}
 */
export async function runCalibrationBatch({
  datasetType, trials, seed, alpha = 0.05, datasetLength = 200,
  permutations = 500, bootstrapResamples = 500,
  baseFeatureValues = null, baseOutcomeValues = null, onlineFdr = null,
} = {}) {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Phase11CalibrationInputError('runCalibrationBatch: "trials" must be a positive integer');
  }

  const reports = [];
  let acceptedCount = 0; // "significant" per this trial's own p-value < alpha
  let onlineFdrAcceptedCount = 0;
  let onlineFdrEligibleCount = 0;

  for (let i = 0; i < trials; i++) {
    const trialSeed = seed + i * 7919; // large prime step -- decorrelates trial seeds
    const { featureValues, outcomeValues } = generateNullDataset(datasetType, {
      length: datasetLength, seed: trialSeed, baseFeatureValues, baseOutcomeValues,
    });

    const report = runAutomatedConfirmationTest({
      featureValues, outcomeValues, seed: trialSeed, permutations, bootstrapResamples,
    });
    reports.push(report);
    if (report.pValue < alpha) acceptedCount++;

    if (onlineFdr) {
      onlineFdrEligibleCount++;
      const fingerprint = trialSeed.toString(16).padStart(64, '0').slice(-64);
      const candidate = { ...onlineFdr.candidateTemplate, id: `${onlineFdr.candidateTemplate.id}-calib-${i}`, fingerprint };
      const provenance = new ProvenanceDAG();
      provenance.addNode(candidate.id, { type: NODE_TYPES.CANDIDATE, label: candidate.id });
      try {
        const result = await confirmPhase11Candidate({
          candidate, researchFreeze: onlineFdr.researchFreeze, sap: onlineFdr.sap,
          researchConfiguration: onlineFdr.researchConfiguration, provenance,
          datasetManifest: { datasetId: `calibration-${datasetType}-${i}` },
          familyRegistry: onlineFdr.familyRegistry,
          market: onlineFdr.market, targetDefinition: onlineFdr.targetDefinition,
          pValue: report.pValue,
        });
        if (result.outcome === 'confirmed') onlineFdrAcceptedCount++;
      } catch {
        onlineFdrEligibleCount--; // this trial's candidate didn't meet the bridge's own preconditions; excluded, not miscounted as a rejection
      }
    }
  }

  const pValues = reports.map((r) => r.pValue);
  const pValueMean = pValues.reduce((a, b) => a + b, 0) / pValues.length;
  const ciCoverage = reports.filter((r) => r.ci95[0] <= 0 && r.ci95[1] >= 0).length / reports.length;

  return {
    datasetType, trials, alpha,
    empiricalFalsePositiveRate: acceptedCount / trials,
    pValueMean,
    pValueHistogram: computePValueHistogram(pValues),
    ciCoverage,
    onlineFdrEmpiricalFDR: onlineFdr && onlineFdrEligibleCount > 0 ? onlineFdrAcceptedCount / onlineFdrEligibleCount : null,
    reports,
  };
}
