/**
 * tests/phase11/confirmationBridge.test.mjs
 *
 * Integration tests for research/src/bridge/Phase11ConfirmationBridge.js —
 * the Round 3 confirmation bridge into the existing, unmodified legacy
 * hypothesisRegistry.js / discoveryDecision.js / onlineFdr.js framework.
 *
 * Verifies (per the Stage 1 directive's required test coverage):
 *   - Full pipeline: Generate -> Screen -> Triage -> Confirmation Bridge
 *     -> hypothesisRegistry -> onlineFdr -> discoveryDecision.
 *   - No alpha spent before Round 3.
 *   - Alpha spent exactly once per confirmation attempt.
 *   - Legacy behaviour unchanged (onlineFdr's own wealth ledger semantics
 *     are exercised, not reimplemented).
 *   - Rejected hypotheses archived (NegativeEvidenceRegistry + Knowledge Graph).
 *   - DecisionAuditLog updated.
 *   - Knowledge Graph updated (Discovery node + CONFIRMED_AS edge).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import {
  confirmPhase11Candidate,
  Phase11ConfirmationValidationError,
} from '../../research/src/bridge/Phase11ConfirmationBridge.js';
import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { listWealthHistory } from '../../research/src/governance/onlineFdr.js';
import { getNode, listEdgesFrom } from '../../research/src/governance/knowledgeGraph.js';
import { PHASE11_NODE_TYPES, PHASE11_EDGE_TYPES } from '../../research/src/governance/phase11KnowledgeGraphBridge.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-cbridge-001', name: 'Confirmation bridge test', description: 'test',
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
    sapId: 'sap-cbridge-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [], ...overrides,
  });
}

async function buildTriagedCandidate(orchestrator, rc, id = 'cbridge-cand-1') {
  const [{ candidate, provenance }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id, family: 'momentum', parameters: { threshold: 0.5 },
      description: 'RSI-14 test candidate', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });
  const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  return { triaged, provenance };
}

test('full pipeline: Generate -> Screen -> Triage -> Confirmation Bridge -> legacy Discovery, no alpha spent before Round 3', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedCandidate(orchestrator, rc);

    // No hypothesis registered yet -- confirming Round 1/2 never touch hypothesisRegistry/onlineFdr.
    assert.equal((await getCurrentLifecycleStage(`ph11_${triaged.fingerprint}`)), null);

    const result = await orchestrator.confirm({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-cbridge-001' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      pValue: 0.0001,
    });

    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.CONFIRMED);

    // Legacy hypothesisRegistry lifecycle actually advanced to Discovery.
    const legacyStage = await getCurrentLifecycleStage(result.hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.DISCOVERY);

    // Alpha spent exactly once.
    const wealthHistory = await listWealthHistory(result.familyKey);
    assert.equal(wealthHistory.length, 1);
    assert.equal(wealthHistory[0].hypothesisId, result.hypothesisId);
    assert.equal(wealthHistory[0].rejected, true); // null hypothesis rejected = significant

    // DecisionAuditLog updated.
    const auditEntries = orchestrator.decisionAuditLog.forCandidate(triaged.id);
    assert.ok(auditEntries.some(e => e.decisionType === 'CONFIRMED'));
  } finally {
    teardown();
  }
});

test('rejected confirmation: no discovery, negative evidence archived, Knowledge Graph updated, legacy stage stays FeatureGeneration', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedCandidate(orchestrator, rc, 'cbridge-cand-2');

    const result = await orchestrator.confirm({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-cbridge-002' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Fall', runLength: 5 },
      pValue: 0.999,
    });

    assert.equal(result.outcome, 'rejected');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.DEPRECATED);

    // Legacy stage never advanced past FeatureGeneration (no Discovery transition on a non-significant result).
    const legacyStage = await getCurrentLifecycleStage(result.hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.FEATURE_GENERATION);

    // Still exactly one alpha spend attempt recorded (spending, even when non-significant, is the whole point of pre-registered sequential testing).
    const wealthHistory = await listWealthHistory(result.familyKey);
    assert.equal(wealthHistory.length, 1);
    assert.equal(wealthHistory[0].rejected, false);

    // Negative evidence archived, not discarded.
    const negEntries = orchestrator.negativeEvidenceRegistry.byFingerprint(triaged.fingerprint);
    assert.equal(negEntries.length, 1);
    assert.equal(negEntries[0].stageRejected, 'CONFIRMATION');

    // Decision audit updated.
    const auditEntries = orchestrator.decisionAuditLog.forCandidate(triaged.id);
    assert.ok(auditEntries.some(e => e.decisionType === 'CONFIRMED_REJECTED'));
  } finally {
    teardown();
  }
});

test('Knowledge Graph: confirmation registers a Discovery node linked to the candidate node via CONFIRMED_AS', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedCandidate(orchestrator, rc, 'cbridge-cand-3');
    await orchestrator.syncKnowledgeGraph(triaged);

    const result = await orchestrator.confirm({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-cbridge-003' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      pValue: 0.0001,
    });
    assert.equal(result.outcome, 'confirmed');

    const candidateNode = await getNode(PHASE11_NODE_TYPES.INDICATOR_FEATURE, 'cbridge-cand-3');
    assert.ok(candidateNode);
    const edges = await listEdgesFrom(candidateNode.id, { edgeType: PHASE11_EDGE_TYPES.CONFIRMED_AS });
    assert.equal(edges.length, 1);
    const discoveryNode = await getNode(PHASE11_NODE_TYPES.DISCOVERY, result.hypothesisId);
    assert.ok(discoveryNode);
    assert.equal(edges[0].toNodeId, discoveryNode.id);
  } finally {
    teardown();
  }
});

test('validation: refuses with a clear error when datasetManifest is missing — never touches hypothesisRegistry or onlineFdr', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });
    const { triaged, provenance } = await buildTriagedCandidate(orchestrator, rc, 'cbridge-cand-4');

    // Missing datasetManifest entirely.
    await assert.rejects(confirmPhase11Candidate({
      candidate: triaged, researchFreeze: freeze, sap, researchConfiguration: rc,
      datasetManifest: null, provenance, familyRegistry,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 }, pValue: 0.0001,
    }), Phase11ConfirmationValidationError);

    // No hypothesisRegistry row and no wealth spent as a result of the refusal above.
    assert.equal(await getCurrentLifecycleStage(`ph11_${triaged.fingerprint}`), null);
  } finally {
    teardown();
  }
});

test('does not import or duplicate onlineFdr/hypothesisRegistry/discoveryDecision statistical logic', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11ConfirmationBridge.js', import.meta.url), 'utf8'
  ));
  // Must import the sanctioned entry points...
  assert.match(src, /import\s*\{\s*evaluateDiscoveryCandidate\s*\}\s*from\s*'\.\.\/governance\/discoveryDecision\.js'/);
  // ...and must NOT import onlineFdr's own wealth-spending function directly.
  assert.ok(!/import\s*\{[^}]*recordTestAndUpdateWealth[^}]*\}\s*from\s*['"][^'"]*onlineFdr\.js['"]/.test(src),
    'bridge must spend alpha only through discoveryDecision.evaluateDiscoveryCandidate, never onlineFdr directly');
  assert.ok(!/import\s*\{[^}]*computeBid[^}]*\}\s*from/.test(src), 'bridge must not reimplement onlineFdr\'s bid computation');
});
