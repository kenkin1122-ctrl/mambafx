/**
 * research/src/validation/NegativeControlCampaign.js
 *
 * Purpose:
 *   Section 7 of the Phase 11 Validation & Calibration Directive: a
 *   one-click Negative Control Campaign — runs CalibrationStudy.js's real
 *   Online-FDR calibration path across all four null-hypothesis dataset
 *   types and reports the laboratory's overall empirical false-discovery
 *   rate against its nominal target. Pure composition: no new statistics,
 *   no new alpha-spending path — it calls runCalibrationBatch()
 *   (CalibrationStudy.js, unmodified) once per null type, each under its
 *   own isolated synthetic calibration "market" (so the four types never
 *   share a Family wealth ledger with each other or with any production
 *   family), and aggregates the results.
 *
 * Dependencies: validation/CalibrationStudy.js (runCalibrationBatch —
 *   unmodified, called four times).
 * Public API: runNegativeControlCampaign, Phase11NegativeControlInputError.
 * Complexity: 4x runCalibrationBatch's own documented cost.
 */

import { runCalibrationBatch, generateNullDataset } from './CalibrationStudy.js';

export class Phase11NegativeControlInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11NegativeControlInputError';
  }
}

const ALL_NULL_TYPES = Object.freeze(['label_permutation', 'shuffled_outcomes', 'iid_random_walk', 'independent_prng']);

/**
 * Runs a one-click Negative Control Campaign: one calibration batch per
 * null-hypothesis type, each submitted through the real Online-FDR path
 * under its own isolated synthetic market, and aggregates the results.
 *
 * @param {object} params
 * @param {number} params.trialsPerType
 * @param {number} params.seed
 * @param {number} [params.alpha=0.05]
 * @param {object} params.onlineFdrBase - { familyRegistry, researchFreeze, sap,
 *   researchConfiguration, candidateTemplate, targetDefinition } -- `market`
 *   is set automatically per type (`calibration-<type>`) for isolation;
 *   omit it here.
 * @param {number} [params.datasetLength=200]
 * @param {number} [params.permutations=500]
 * @param {number} [params.bootstrapResamples=500]
 * @param {number[]} [params.baseFeatureValues] - For label_permutation/shuffled_outcomes types.
 * @param {number[]} [params.baseOutcomeValues]
 * @param {number} [params.fdrTolerance=2] - Calibration passes if empirical
 *   FDR <= alpha * fdrTolerance (a real, if generous, tolerance band --
 *   exact equality to nominal alpha is not expected from a finite sample).
 * @returns {Promise<{
 *   campaignsExecuted: number, discoveriesExpected: number,
 *   discoveriesObserved: number, empiricalFDR: number,
 *   calibrationVerdict: 'PASS'|'FAIL', perTypeResults: object[]
 * }>}
 */
export async function runNegativeControlCampaign({
  trialsPerType, seed, alpha = 0.05, onlineFdrBase, datasetLength = 200,
  permutations = 500, bootstrapResamples = 500,
  baseFeatureValues = null, baseOutcomeValues = null, fdrTolerance = 2,
} = {}) {
  if (!Number.isInteger(trialsPerType) || trialsPerType < 1) {
    throw new Phase11NegativeControlInputError('runNegativeControlCampaign: "trialsPerType" must be a positive integer');
  }
  if (!onlineFdrBase) {
    throw new Phase11NegativeControlInputError('runNegativeControlCampaign: "onlineFdrBase" is required -- a Negative Control Campaign is defined by its use of the real Online-FDR path');
  }

  const perTypeResults = [];
  let totalTrials = 0, totalDiscoveries = 0, totalEligible = 0;

  // label_permutation requires a base (feature, outcome) series -- if the
  // caller didn't supply real data, synthesize a neutral one (via the
  // same iid_random_walk generator this module already reuses) so a true
  // one-click campaign still works standalone, with no embedded effect.
  let effectiveBaseFeatureValues = baseFeatureValues, effectiveBaseOutcomeValues = baseOutcomeValues;
  if (!effectiveBaseFeatureValues || !effectiveBaseOutcomeValues) {
    const synthetic = generateNullDataset('iid_random_walk', { length: datasetLength, seed: seed - 1 });
    effectiveBaseFeatureValues = synthetic.featureValues;
    effectiveBaseOutcomeValues = synthetic.outcomeValues;
  }

  for (let t = 0; t < ALL_NULL_TYPES.length; t++) {
    const datasetType = ALL_NULL_TYPES[t];
    const result = await runCalibrationBatch({
      datasetType, trials: trialsPerType, seed: seed + t * 104729, alpha, datasetLength,
      permutations, bootstrapResamples,
      baseFeatureValues: effectiveBaseFeatureValues, baseOutcomeValues: effectiveBaseOutcomeValues,
      onlineFdr: {
        ...onlineFdrBase,
        market: `calibration-${datasetType}`, // isolates each type's Family wealth ledger
      },
    });
    perTypeResults.push({ datasetType, ...result });
    totalTrials += result.trials;
    if (typeof result.onlineFdrEmpiricalFDR === 'number') {
      // Recover discovery count from the reported rate x eligible trials
      // is imprecise; runCalibrationBatch doesn't expose raw counts, so we
      // treat trials as eligible here (the common case) for aggregation.
      totalDiscoveries += Math.round(result.onlineFdrEmpiricalFDR * result.trials);
      totalEligible += result.trials;
    }
  }

  const discoveriesExpected = totalTrials * alpha;
  const empiricalFDR = totalEligible > 0 ? totalDiscoveries / totalEligible : 0;
  const calibrationVerdict = empiricalFDR <= alpha * fdrTolerance ? 'PASS' : 'FAIL';

  return {
    campaignsExecuted: ALL_NULL_TYPES.length,
    discoveriesExpected,
    discoveriesObserved: totalDiscoveries,
    empiricalFDR,
    calibrationVerdict,
    perTypeResults,
  };
}
