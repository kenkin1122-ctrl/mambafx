/**
 * tests/phase12/eventProcessFullLifecycle.test.mjs
 *
 * The real end-to-end test for EventProcessFeature candidates' full
 * governed lifecycle: Generate -> Screen -> Triage ->
 * confirmEventProcessFeatureAutomatically -> Confirmed -> orchestrator.replicate()
 * (using computeEventProcessPartitionStatistics for real per-partition
 * effect sizes) -> Replicated -> orchestrator.publish() -> Published --
 * every step a real call into real, unmodified orchestrator methods and
 * legacy governance modules, mirroring
 * tests/phase11/publicationBridge.test.mjs's own setup exactly.
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

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { REPRODUCIBILITY_LEVELS } from '../../research/src/governance/reproducibilityLevels.js';
import { IMPLEMENTATION_MATURITY } from '../../research/src/governance/implementationMaturity.js';
import { computeEventProcessPartitionStatistics } from '../../research/src/eventProcess/EventProcessConfirmationProcedure.js';

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: `rc-fulllc-${Date.now()}-${Math.random()}`, name: 'Event process full lifecycle test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '12.0.0', proxyVersions: {}, ...overrides,
  });
}
async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: `sap-fulllc-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['eventProcess'], alphaAllocation: { eventProcess: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }],
    replicationCriteria: { minStabilityIndex: 0 }, publicationCriteria: {},
    effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 10 },
    requiredDiagnostics: [], ...overrides,
  });
}

test('full governed lifecycle: Generate -> Confirm -> Replicate -> Publish, all real, for an EventProcessFeature candidate', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });

    const freezeDraft = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freezeDraft, sap, familyRegistry });

    const [{ candidate: draft, provenance }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE,
      candidateParamsList: [{
        id: 'fulllc-cand-1', family: 'eventProcess', parameters: {},
        description: 'TimeGap full lifecycle test', generatorVersion: '12.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        featureName: 'TimeGap', protocolVersion: 'P12-GAP-v1.1.0', extractorVersion: '1.0.0', schemaVersion: '2.0.0',
      }],
    });

    const freezeWithFp = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [draft.fingerprint], researchConfigurationHash: 'b'.repeat(64),
    });
    orchestrator.researchFreeze = freezeWithFp;

    let candidate = withField(draft, 'researchFreezeId', freezeWithFp.id);
    candidate = withField(candidate, 'reproducibilityLevel', REPRODUCIBILITY_LEVELS.CROSS_REGIME ?? 3);
    candidate = withField(candidate, 'implementationMaturity', IMPLEMENTATION_MATURITY.STABLE);

    const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
    const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);

    const rng = seededRng(42);
    const confirmationGaps = Array.from({ length: 300 }, () => 0.5 + rng());
    const confirmResult = await orchestrator.confirmEventProcessFeatureAutomatically({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-fulllc-001' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      gaps: confirmationGaps, seed: 999, numSimulations: 500,
    });
    assert.equal(confirmResult.outcome, 'confirmed');
    assert.equal(confirmResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.CONFIRMED);

    const holdoutGaps = Array.from({ length: 400 }, () => 0.5 + rng());
    const { partitionEffectSizes, pooledEffectSize } = computeEventProcessPartitionStatistics(holdoutGaps, 4);
    const replicateResult = await orchestrator.replicate({
      candidate: confirmResult.candidate, hypothesisId: confirmResult.hypothesisId, familyKey: confirmResult.familyKey,
      featureKey: 'fulllc-cand-1-feature', generation: 0, holdoutRange: { startTick: 1000, endTick: 2000 },
      partitionEffectSizes, pooledEffectSize,
    });
    assert.equal(replicateResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.REPLICATED);
    assert.ok(replicateResult.stability.stabilityIndex >= 0 && replicateResult.stability.stabilityIndex <= 1);

    await orchestrator.syncKnowledgeGraph(replicateResult.candidate);
    const publishResult = await orchestrator.publish({
      candidate: replicateResult.candidate, hypothesisId: confirmResult.hypothesisId, publishTimeConfig: rc,
    });

    assert.equal(publishResult.outcome, 'published');
    assert.equal(publishResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.PUBLISHED);
    assert.equal(publishResult.gateResult.passed, true);

    const legacyStage = await getCurrentLifecycleStage(confirmResult.hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.PUBLICATION);
  } finally {
    teardown();
  }
});
