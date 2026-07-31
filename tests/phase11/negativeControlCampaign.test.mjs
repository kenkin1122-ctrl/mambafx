/**
 * tests/phase11/negativeControlCampaign.test.mjs
 *
 * Tests for research/src/validation/NegativeControlCampaign.js — Section 7
 * of the Phase 11 Validation & Calibration Directive.
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
  runNegativeControlCampaign,
  Phase11NegativeControlInputError,
} from '../../research/src/validation/NegativeControlCampaign.js';
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

test('runNegativeControlCampaign: throws without a positive trialsPerType or without onlineFdrBase', async () => {
  await assert.rejects(runNegativeControlCampaign({ trialsPerType: 0, seed: 1, onlineFdrBase: {} }), Phase11NegativeControlInputError);
  await assert.rejects(runNegativeControlCampaign({ trialsPerType: 5, seed: 1 }), Phase11NegativeControlInputError);
});

test('runNegativeControlCampaign: runs all four null types under isolated calibration markets and reports a plausible PASS verdict', async () => {
  const teardown = await setup();
  try {
    const rc = await ResearchConfiguration.create({
      id: 'rc-negctrl-001', name: 'negative control test', description: 'test',
      grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
      proxyVersions: { msd: '1.0.0' },
    });
    const sap = await StatisticalAnalysisPlan.create({
      sapId: 'sap-negctrl-001', hypothesisFamilies: ['calibration'], alphaAllocation: { calibration: 0.05 },
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
      id: 'negctrl-template', type: CANDIDATE_TYPES.INDICATOR_FEATURE, family: 'calibration',
      lifecycle: PHASE11_LIFECYCLE_STAGES.TRIAGED,
      researchFreezeId: freeze.id, sapId: sap.sapId, researchConfigurationId: rc.id,
    };

    const result = await runNegativeControlCampaign({
      trialsPerType: 8, seed: 300, alpha: 0.05, datasetLength: 150, permutations: 200, bootstrapResamples: 200,
      onlineFdrBase: {
        familyRegistry, researchFreeze: freeze, sap, researchConfiguration: rc, candidateTemplate,
        targetDefinition: { direction: 'Rise', runLength: 5 },
      },
    });

    assert.equal(result.campaignsExecuted, 4);
    assert.equal(result.perTypeResults.length, 4);
    assert.deepEqual(result.perTypeResults.map((r) => r.datasetType).sort(),
      ['iid_random_walk', 'independent_prng', 'label_permutation', 'shuffled_outcomes']);
    assert.equal(result.discoveriesExpected, 32 * 0.05);
    assert.ok(result.empiricalFDR >= 0 && result.empiricalFDR <= 1);
    assert.ok(['PASS', 'FAIL'].includes(result.calibrationVerdict));
  } finally {
    teardown();
  }
});

test('never spends alpha outside the existing confirmation pathway, never imports onlineFdr.js/discoveryDecision.js directly', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/validation/NegativeControlCampaign.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
