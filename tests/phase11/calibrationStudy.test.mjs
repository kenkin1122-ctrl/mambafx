/**
 * tests/phase11/calibrationStudy.test.mjs
 *
 * Tests for research/src/validation/CalibrationStudy.js — Section 1 of the
 * Phase 11 Validation & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  openExistingDbExtended,
  _resetConnectionCacheForTesting as _resetExistingDbCacheForTesting,
} from '../../research/src/storage/existingDbExtensions.js';
import { _resetKnownFamiliesForTesting } from '../../research/src/governance/family.js';

import {
  generateNullDataset,
  runCalibrationBatch,
  Phase11CalibrationInputError,
} from '../../research/src/validation/CalibrationStudy.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

// ═══════════════════════════════════════════════════════════════════════════
// generateNullDataset
// ═══════════════════════════════════════════════════════════════════════════

test('generateNullDataset: throws for an unrecognised type', () => {
  assert.throws(() => generateNullDataset('not_a_real_type', { length: 100, seed: 1 }), Phase11CalibrationInputError);
});

test('generateNullDataset: label_permutation preserves the outcome set but shuffles its order', () => {
  const baseFeatureValues = Array.from({ length: 50 }, (_, i) => i);
  const baseOutcomeValues = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const { featureValues, outcomeValues } = generateNullDataset('label_permutation', {
    length: 50, seed: 1, baseFeatureValues, baseOutcomeValues,
  });
  assert.deepEqual(featureValues, baseFeatureValues);
  assert.equal(outcomeValues.length, baseOutcomeValues.length);
  assert.equal(outcomeValues.reduce((a, b) => a + b, 0), baseOutcomeValues.reduce((a, b) => a + b, 0)); // same count of 1s
  assert.notDeepEqual(outcomeValues, baseOutcomeValues); // but reordered
});

test('generateNullDataset: shuffled_outcomes produces equal-length feature/outcome arrays even without base data', () => {
  const { featureValues, outcomeValues } = generateNullDataset('shuffled_outcomes', { length: 100, seed: 2 });
  assert.equal(featureValues.length, 100);
  assert.equal(outcomeValues.length, 100);
});

test('generateNullDataset: iid_random_walk and independent_prng each produce equal-length feature/outcome arrays', () => {
  const walk = generateNullDataset('iid_random_walk', { length: 100, seed: 3 });
  assert.equal(walk.featureValues.length, walk.outcomeValues.length);
  assert.ok(walk.featureValues.length > 0);

  const prng = generateNullDataset('independent_prng', { length: 100, seed: 4 });
  assert.equal(prng.featureValues.length, 100);
  assert.equal(prng.outcomeValues.length, 100);
});

test('generateNullDataset: is deterministic for a fixed seed', () => {
  const a = generateNullDataset('independent_prng', { length: 50, seed: 42 });
  const b = generateNullDataset('independent_prng', { length: 50, seed: 42 });
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// runCalibrationBatch
// ═══════════════════════════════════════════════════════════════════════════

test('runCalibrationBatch: throws for a non-positive trial count', async () => {
  await assert.rejects(runCalibrationBatch({ datasetType: 'independent_prng', trials: 0, seed: 1 }), Phase11CalibrationInputError);
});

test('runCalibrationBatch: a well-calibrated null produces an empirical FPR reasonably close to nominal alpha, uniform-ish p-values, and good CI coverage', async () => {
  const result = await runCalibrationBatch({
    datasetType: 'independent_prng', trials: 40, seed: 100, alpha: 0.05,
    datasetLength: 150, permutations: 300, bootstrapResamples: 300,
  });

  assert.equal(result.trials, 40);
  assert.equal(result.reports.length, 40);
  // With only 40 trials, exact 5% is not expected, but it should be in a
  // sane neighborhood -- nowhere near, say, 50%, which would indicate a
  // badly miscalibrated test.
  assert.ok(result.empiricalFalsePositiveRate <= 0.3, `empirical FPR too high for a null: ${result.empiricalFalsePositiveRate}`);
  assert.ok(result.pValueMean > 0.2 && result.pValueMean < 0.8, `p-value mean far from the ~0.5 expected under a uniform null: ${result.pValueMean}`);
  assert.equal(result.pValueHistogram.length, 10);
  assert.equal(result.pValueHistogram.reduce((a, b) => a + b, 0), 40);
  assert.ok(result.ciCoverage >= 0.7, `CI coverage of the true null effect (0) unexpectedly low: ${result.ciCoverage}`);
  assert.equal(result.onlineFdrEmpiricalFDR, null); // not requested
});

test('runCalibrationBatch: label_permutation type works from a real base indicator/outcome series', async () => {
  const baseFeatureValues = Array.from({ length: 200 }, (_, i) => Math.sin(i / 5));
  const baseOutcomeValues = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  const result = await runCalibrationBatch({
    datasetType: 'label_permutation', trials: 20, seed: 55, alpha: 0.05,
    datasetLength: 200, permutations: 200, bootstrapResamples: 200,
    baseFeatureValues, baseOutcomeValues,
  });
  assert.equal(result.trials, 20);
  assert.ok(result.empiricalFalsePositiveRate <= 0.5);
});

test('runCalibrationBatch: with onlineFdr opted in, submits real trials through the unmodified confirmation bridge and reports empirical FDR', async () => {
  const teardown = await setup();
  try {
    const rc = await ResearchConfiguration.create({
      id: 'rc-calib-001', name: 'calibration test', description: 'test',
      grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
      proxyVersions: { msd: '1.0.0' },
    });
    const sap = await StatisticalAnalysisPlan.create({
      sapId: 'sap-calib-001', hypothesisFamilies: ['calibration'], alphaAllocation: { calibration: 0.05 },
      promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000 }], replicationCriteria: {},
      publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
    });
    const freeze = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
      candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'calibration', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });

    const candidateTemplate = {
      id: 'calib-template', type: CANDIDATE_TYPES.INDICATOR_FEATURE, family: 'calibration',
      lifecycle: PHASE11_LIFECYCLE_STAGES.TRIAGED,
      researchFreezeId: freeze.id, sapId: sap.sapId, researchConfigurationId: rc.id,
    };

    const result = await runCalibrationBatch({
      datasetType: 'independent_prng', trials: 15, seed: 200, alpha: 0.05,
      datasetLength: 150, permutations: 200, bootstrapResamples: 200,
      onlineFdr: {
        familyRegistry, researchFreeze: freeze, sap, researchConfiguration: rc, candidateTemplate,
        market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      },
    });

    assert.equal(result.trials, 15);
    assert.ok(typeof result.onlineFdrEmpiricalFDR === 'number');
    assert.ok(result.onlineFdrEmpiricalFDR >= 0 && result.onlineFdrEmpiricalFDR <= 1);
  } finally {
    teardown();
  }
});

test('never spends alpha outside the existing confirmation pathway, never imports onlineFdr.js/discoveryDecision.js directly', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/validation/CalibrationStudy.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
  assert.match(src, /import\s*\{\s*confirmPhase11Candidate\s*\}\s*from\s*'\.\.\/bridge\/Phase11ConfirmationBridge\.js'/);
});
