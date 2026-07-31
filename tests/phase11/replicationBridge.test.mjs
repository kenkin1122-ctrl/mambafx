/**
 * tests/phase11/replicationBridge.test.mjs
 *
 * Integration tests for research/src/bridge/Phase11ReplicationBridge.js —
 * bridges a Confirmed Phase 11 candidate through the existing Lockbox
 * replication framework (unmodified), with the verdict computed by the
 * already-built DiscoveryStabilityAnalysis, not a new ad hoc rule.
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
  replicatePhase11Candidate,
  Phase11ReplicationValidationError,
} from '../../research/src/bridge/Phase11ReplicationBridge.js';
import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { getLockboxAllocation } from '../../research/src/governance/lockbox.js';

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-repl-001', name: 'Replication bridge test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' }, ...overrides,
  });
}
async function makeFreeze(rc, overrides = {}) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64), ...overrides,
  });
}
async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-repl-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }],
    replicationCriteria: { minStabilityIndex: 0.5 }, publicationCriteria: {},
    effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [], ...overrides,
  });
}

/** Builds a fully Confirmed candidate + its legacy hypothesisId/familyKey, ready for replication. */
async function buildConfirmedCandidate(orchestrator, rc, id) {
  const [{ candidate, provenance }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id, family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });
  const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  const confirmResult = await orchestrator.confirm({
    candidate: triaged, researchConfiguration: rc,
    datasetManifest: { datasetId: `ds-${id}` }, provenance,
    market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
    pValue: 0.0001,
  });
  return { confirmed: confirmResult.candidate, hypothesisId: confirmResult.hypothesisId, familyKey: confirmResult.familyKey };
}

test('successful replication: consistent partitions across threshold -> Replicated, legacy stays at Lockbox', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { confirmed, hypothesisId, familyKey } = await buildConfirmedCandidate(orchestrator, rc, 'repl-cand-1');

    const result = await orchestrator.replicate({
      candidate: confirmed, hypothesisId, familyKey,
      featureKey: 'rsi14-close', generation: 0, holdoutRange: { startTick: 1000, endTick: 2000 },
      partitionEffectSizes: [0.12, 0.11, 0.13, 0.12], pooledEffectSize: 0.12,
    });

    assert.equal(result.outcome, 'replicated');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.REPLICATED);
    assert.ok(result.stability.stabilityIndex >= 0.5);

    const legacyStage = await getCurrentLifecycleStage(hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.LOCKBOX);

    const allocation = await getLockboxAllocation('rsi14-close', 0);
    assert.ok(allocation);
    assert.ok(allocation.consumedAt);

    const auditEntries = orchestrator.decisionAuditLog.forCandidate('repl-cand-1');
    assert.ok(auditEntries.some(e => e.decisionType === 'REPLICATED'));
  } finally {
    teardown();
  }
});

test('failed replication: inconsistent partitions below threshold -> Deprecated, negative evidence archived, holdout still consumed', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { confirmed, hypothesisId, familyKey } = await buildConfirmedCandidate(orchestrator, rc, 'repl-cand-2');

    const result = await orchestrator.replicate({
      candidate: confirmed, hypothesisId, familyKey,
      featureKey: 'rsi14-close', generation: 1, holdoutRange: { startTick: 3000, endTick: 4000 },
      partitionEffectSizes: [0.5, -0.4, 0.3, -0.6], pooledEffectSize: 0.1, // sign flips -> low stability
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.DEPRECATED);
    assert.ok(result.stability.stabilityIndex < 0.5);

    const allocation = await getLockboxAllocation('rsi14-close', 1);
    assert.ok(allocation.consumedAt); // holdout consumed regardless of outcome

    const negEntries = orchestrator.negativeEvidenceRegistry.byFingerprint(confirmed.fingerprint);
    assert.equal(negEntries.length, 1);
    assert.equal(negEntries[0].stageRejected, 'REPLICATION');
    assert.equal(negEntries[0].replicationStatus, 'failed');

    const auditEntries = orchestrator.decisionAuditLog.forCandidate('repl-cand-2');
    assert.ok(auditEntries.some(e => e.decisionType === 'REPLICATION_FAILED'));
  } finally {
    teardown();
  }
});

test('validation: refuses a candidate that is not Confirmed, before any Lockbox call', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const [{ candidate }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'repl-cand-3', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });

    await assert.rejects(replicatePhase11Candidate({
      candidate, hypothesisId: 'ph11_fake', familyKey: 'family:fake',
      featureKey: 'rsi14-close', generation: 0, holdoutRange: { startTick: 1, endTick: 2 },
      partitionEffectSizes: [0.1, 0.1], pooledEffectSize: 0.1,
    }), Phase11ReplicationValidationError);

    const allocation = await getLockboxAllocation('rsi14-close', 0);
    assert.equal(allocation, undefined); // nothing was allocated
  } finally {
    teardown();
  }
});

test('replication spends no additional alpha and never imports onlineFdr', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11ReplicationBridge.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
