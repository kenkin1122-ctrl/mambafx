/**
 * research/src/validation/PowerStudy.js
 *
 * Purpose:
 *   Section 2 of the Phase 11 Validation & Calibration Directive: injects
 *   KNOWN synthetic effects of varying magnitude and measures the
 *   laboratory's empirical detection probability, effect-size recovery,
 *   and confidence-interval accuracy — i.e. does the real pipeline
 *   actually detect real effects at the rate its own theory predicts?
 *   Diagnostic/reporting layer only — runs the real, unmodified
 *   bridge/Phase11AutomatedConfirmation.js pipeline; never spends alpha,
 *   never touches the protected legacy modules.
 *
 * Synthetic effect injection: generates a (feature, outcome) pair with a
 *   KNOWN target Pearson correlation via the standard construction
 *   outcome_continuous = rho*feature + sqrt(1-rho^2)*independentNoise
 *   (both feature and independentNoise drawn from independent standard
 *   normal variates via a Box-Muller transform over
 *   statistics/uncertaintyEstimation.js's createSeededRng — reused, not a
 *   second PRNG), then binarized at the median to match this pipeline's
 *   always-binary outcome series. Binarization is known to attenuate the
 *   observable point-biserial correlation below the raw target rho —
 *   this is disclosed, not hidden, and is exactly why "effect-size
 *   recovery" is measured empirically rather than assumed to equal rho.
 *
 * What is measured, per effect size, across many trials:
 *   - empirical detection probability (fraction of trials with pValue < alpha)
 *   - mean recovered effect size vs. the true (attenuated) correlation
 *   - mean bootstrap CI width
 *   - CI coverage of the true (empirically attenuated) effect
 *   - the theoretical power computeAchievedPower() would predict, using
 *     this batch's own mean empirical standard error (a genuine
 *     theory-vs-observation cross-check, not a duplicate power formula
 *     invented here)
 *   - minimum detectable effect: the smallest injected effect size in the
 *     supplied list whose empirical detection probability reaches the
 *     requested power threshold (default 0.8)
 *
 * Dependencies: bridge/Phase11AutomatedConfirmation.js
 *   (runAutomatedConfirmationTest — unmodified), statistics/powerEngine.js
 *   (computeAchievedPower — unmodified, reused for the theory-vs-observation
 *   cross-check), statistics/uncertaintyEstimation.js (createSeededRng —
 *   reused).
 * Public API: injectSyntheticEffect, runPowerCurve, Phase11PowerStudyInputError.
 * Complexity: O(effectSizes.length * trialsPerEffectSize * (permutations +
 *   bootstrapResamples)).
 */

import { createSeededRng } from '../statistics/uncertaintyEstimation.js';
import { computeAchievedPower } from '../statistics/powerEngine.js';
import { runAutomatedConfirmationTest } from '../bridge/Phase11AutomatedConfirmation.js';

export class Phase11PowerStudyInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11PowerStudyInputError';
  }
}

/** Standard normal variate via Box-Muller, drawn from a reused seeded uniform RNG. */
function makeStandardNormalGenerator(seed) {
  const rng = createSeededRng(seed);
  let cached = null;
  return () => {
    if (cached !== null) { const v = cached; cached = null; return v; }
    let u1 = rng(), u2 = rng();
    if (u1 <= 0) u1 = 1e-12;
    const mag = Math.sqrt(-2 * Math.log(u1));
    cached = mag * Math.sin(2 * Math.PI * u2);
    return mag * Math.cos(2 * Math.PI * u2);
  };
}

/**
 * Generates a synthetic (featureValues, outcomeValues) pair with a KNOWN
 * target population correlation `trueEffectSize`, outcome binarized at
 * the median (see module header for why).
 *
 * @param {object} params
 * @param {number} params.length
 * @param {number} params.trueEffectSize - Target correlation, in [-1, 1].
 * @param {number} params.seed
 * @returns {{ featureValues: number[], outcomeValues: number[] }}
 */
export function injectSyntheticEffect({ length, trueEffectSize, seed } = {}) {
  if (!Number.isInteger(length) || length < 1) {
    throw new Phase11PowerStudyInputError('injectSyntheticEffect: "length" must be a positive integer');
  }
  if (typeof trueEffectSize !== 'number' || trueEffectSize < -1 || trueEffectSize > 1) {
    throw new Phase11PowerStudyInputError('injectSyntheticEffect: "trueEffectSize" must be a number in [-1, 1]');
  }
  const normal = makeStandardNormalGenerator(seed);
  const featureValues = new Array(length);
  const continuousOutcome = new Array(length);
  for (let i = 0; i < length; i++) {
    const z1 = normal(), z2 = normal();
    featureValues[i] = z1;
    continuousOutcome[i] = trueEffectSize * z1 + Math.sqrt(1 - trueEffectSize * trueEffectSize) * z2;
  }
  const sorted = [...continuousOutcome].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const outcomeValues = continuousOutcome.map((v) => (v > median ? 1 : 0));
  return { featureValues, outcomeValues };
}

/**
 * Runs a full power curve: for each requested true effect size, runs
 * `trialsPerEffectSize` independent synthetic-effect trials through the
 * real, unmodified statistical pipeline.
 *
 * @param {object} params
 * @param {number[]} params.effectSizes - True correlations to test, e.g. [0.05, 0.1, 0.2, 0.3].
 * @param {number} params.trialsPerEffectSize
 * @param {number} params.seed
 * @param {number} [params.alpha=0.05]
 * @param {number} [params.datasetLength=200]
 * @param {number} [params.permutations=500]
 * @param {number} [params.bootstrapResamples=500]
 * @param {number} [params.powerThreshold=0.8] - For minimum-detectable-effect reporting.
 * @returns {Promise<{
 *   points: { trueEffectSize: number, detectionProbability: number,
 *     meanRecoveredEffectSize: number, meanAbsoluteBias: number,
 *     meanCiWidth: number, ciCoverage: number, theoreticalPower: number }[],
 *   minimumDetectableEffect: number|null
 * }>}
 */
export function runPowerCurve({
  effectSizes, trialsPerEffectSize, seed, alpha = 0.05, datasetLength = 200,
  permutations = 500, bootstrapResamples = 500, powerThreshold = 0.8,
} = {}) {
  if (!Array.isArray(effectSizes) || effectSizes.length === 0) {
    throw new Phase11PowerStudyInputError('runPowerCurve: "effectSizes" must be a non-empty array');
  }
  if (!Number.isInteger(trialsPerEffectSize) || trialsPerEffectSize < 1) {
    throw new Phase11PowerStudyInputError('runPowerCurve: "trialsPerEffectSize" must be a positive integer');
  }

  const points = [];
  for (const trueEffectSize of effectSizes) {
    let detected = 0, sumEffect = 0, sumAbsBias = 0, sumCiWidth = 0, sumSE = 0, ciCoveredCount = 0;
    const reports = [];
    for (let t = 0; t < trialsPerEffectSize; t++) {
      const trialSeed = seed + Math.round(trueEffectSize * 1e6) + t * 7919;
      const { featureValues, outcomeValues } = injectSyntheticEffect({ length: datasetLength, trueEffectSize, seed: trialSeed });
      const report = runAutomatedConfirmationTest({ featureValues, outcomeValues, seed: trialSeed, permutations, bootstrapResamples });
      reports.push(report);
      if (report.pValue < alpha) detected++;
      sumEffect += report.effectSize;
      sumCiWidth += (report.ci95[1] - report.ci95[0]);
      sumSE += report.standardError;
    }
    const meanRecoveredEffectSize = sumEffect / trialsPerEffectSize;
    for (const report of reports) sumAbsBias += Math.abs(report.effectSize - meanRecoveredEffectSize);
    for (const report of reports) if (report.ci95[0] <= meanRecoveredEffectSize && report.ci95[1] >= meanRecoveredEffectSize) ciCoveredCount++;

    const meanSE = sumSE / trialsPerEffectSize;
    const theoreticalPower = meanSE > 0
      ? computeAchievedPower({ effectSize: meanRecoveredEffectSize, standardError: meanSE, alpha }).power
      : null;

    points.push({
      trueEffectSize,
      detectionProbability: detected / trialsPerEffectSize,
      meanRecoveredEffectSize,
      meanAbsoluteBias: sumAbsBias / trialsPerEffectSize,
      meanCiWidth: sumCiWidth / trialsPerEffectSize,
      ciCoverage: ciCoveredCount / trialsPerEffectSize,
      theoreticalPower,
    });
  }

  const sortedAscending = [...points].sort((a, b) => a.trueEffectSize - b.trueEffectSize);
  const firstAboveThreshold = sortedAscending.find((p) => p.detectionProbability >= powerThreshold);

  return {
    points,
    minimumDetectableEffect: firstAboveThreshold ? firstAboveThreshold.trueEffectSize : null,
  };
}
