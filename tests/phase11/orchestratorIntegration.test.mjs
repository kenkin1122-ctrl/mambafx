/**
 * tests/phase11/orchestratorIntegration.test.mjs
 *
 * Verifies the campaign-level integration surface added to
 * Phase11Orchestrator for the UI layer: getCampaignSummary(),
 * listCandidates()/getCandidate(), and syncKnowledgeGraph()/
 * syncNegativeEvidenceToKnowledgeGraph() wiring into
 * phase11KnowledgeGraphBridge.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { getNode } from '../../research/src/governance/knowledgeGraph.js';
import { PHASE11_NODE_TYPES } from '../../research/src/governance/phase11KnowledgeGraphBridge.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-orchint-001', name: 'Orchestrator integration test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
  });
}
async function makeFreeze(rc) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
}
async function makeSap() {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-orchint-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.03 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 500 }], replicationCriteria: {}, publicationCriteria: {},
    effectSizeThresholds: { default: 0.1 }, minimumSampleSizes: { default: 200 }, requiredDiagnostics: ['stationarity'],
  });
}

test('getCampaignSummary/listCandidates: reflect state across generate -> screen -> triage', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });

  const paramsList = Array.from({ length: 4 }, (_, i) => ({
    id: `oi-${i}`, family: 'momentum', parameters: { threshold: i },
    description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
    configHash: rc.configHash, researchConfigurationId: rc.id,
    indicatorName: 'RSI', period: 14, inputObservables: [],
  }));
  const generated = await orchestrator.generate({ candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE, candidateParamsList: paramsList });
  assert.equal(orchestrator.listCandidates().length, 4);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 4);

  const candidates = generated.map(g => g.candidate);
  const { promoted: screened } = orchestrator.screen({ candidates, scoreFn: (c) => candidates.indexOf(c), promotionQuantile: 0.5 });
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, 2);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 2); // rejected candidates stay Generated

  const diagnosticsByCandidateId = {};
  for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.5, diagnosticsPassed: ['stationarity'] };
  orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });

  const summary = orchestrator.getCampaignSummary();
  assert.equal(summary.candidateCount, 4);
  assert.equal(summary.countsByStage.Triaged, 2);
  assert.equal(summary.researchFreezeId, freeze.id);
  assert.equal(summary.sapId, sap.sapId);
});

test('syncKnowledgeGraph: registers the candidate into the Knowledge Graph via the bridge', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });

    const [{ candidate }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'oi-kg-1', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });

    await orchestrator.syncKnowledgeGraph(candidate, { contextIds: ['ctx-a'], proxyIds: ['proxy-a'] });
    const node = await getNode(PHASE11_NODE_TYPES.INDICATOR_FEATURE, candidate.id);
    assert.ok(node);
    assert.equal(node.metadata.fingerprint, candidate.fingerprint);
  } finally {
    teardown();
  }
});

test('syncNegativeEvidenceToKnowledgeGraph: records rejections after a screening sync', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });

    const paramsList = Array.from({ length: 4 }, (_, i) => ({
      id: `oi-ne-${i}`, family: 'momentum', parameters: { threshold: i },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }));
    const generated = await orchestrator.generate({ candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE, candidateParamsList: paramsList });
    const candidates = generated.map(g => g.candidate);
    const { rejected } = orchestrator.screen({ candidates, scoreFn: (c) => candidates.indexOf(c), promotionQuantile: 0.25 });
    assert.ok(rejected.length > 0);

    const rejectedOne = rejected[0];
    await orchestrator.syncKnowledgeGraph(rejectedOne);
    const nodes = await orchestrator.syncNegativeEvidenceToKnowledgeGraph(rejectedOne.id);
    assert.ok(nodes.length >= 1);
  } finally {
    teardown();
  }
});

test('Phase11Orchestrator.confirm(): remains honest -- always throws, never simulates confirmation or replication', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  assert.throws(() => orchestrator.confirm(), /NotYetIntegratedError|not yet available/i);
});
