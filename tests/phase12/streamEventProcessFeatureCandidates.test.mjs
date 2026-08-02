/**
 * tests/phase12/streamEventProcessFeatureCandidates.test.mjs
 *
 * Tests for eventProcess/streamEventProcessFeatureCandidates.js -- the
 * Event Process domain's Candidate Generator, one candidate per
 * registered event-local feature plugin, routed through the exact same
 * canonical generateCandidate() every other domain uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventFeatureRegistry } from '../../research/src/eventProcess/EventFeatureRegistry.js';
import { registerCoreEventFeatures, CORE_EVENT_FEATURE_PLUGINS } from '../../research/src/eventProcess/coreEventFeatures.js';
import {
  streamEventProcessFeatureCandidateParams, streamEventProcessFeatureCandidates, EventProcessGenerationError,
} from '../../research/src/eventProcess/streamEventProcessFeatureCandidates.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { DecisionAuditLog } from '../../research/src/governance/DecisionAuditLog.js';

async function makeCycle() {
  const rc = await ResearchConfiguration.create({
    id: `rc-p12stream-${Date.now()}-${Math.random()}`, name: 't', description: 't',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-p12stream-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['eventProcess'],
    alphaAllocation: { eventProcess: 0.01 }, promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000 }],
    replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
  return { rc, freeze, sap, familyRegistry };
}

test('streamEventProcessFeatureCandidateParams: yields one candidateParams per registered event-local feature plugin, featureName copied verbatim from the plugin\'s own metadata', async () => {
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);
  const rc = await ResearchConfiguration.create({ id: 'rc-stream-params', name: 't', description: 't', grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {} });

  const paramsList = [...streamEventProcessFeatureCandidateParams({ eventFeatureRegistry, researchConfiguration: rc, protocolVersion: 'P12-GAP-v1.1.0' })];
  assert.equal(paramsList.length, CORE_EVENT_FEATURE_PLUGINS.length);
  for (const params of paramsList) {
    const plugin = eventFeatureRegistry.lookup(params.featureName);
    assert.ok(plugin, `${params.featureName} must be a real registered plugin`);
    assert.equal(params.protocolVersion, 'P12-GAP-v1.1.0');
    assert.equal(params.extractorVersion, plugin.metadata().version);
    assert.equal(params.schemaVersion, '1.0.0'); // default
  }
});

test('streamEventProcessFeatureCandidateParams: throws without protocolVersion (refinement #5), an invalid registry, or missing ResearchConfiguration', () => {
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);
  const rc = { id: 'rc', configHash: 'a'.repeat(64) };
  assert.throws(() => [...streamEventProcessFeatureCandidateParams({ eventFeatureRegistry, researchConfiguration: rc })], EventProcessGenerationError);
  assert.throws(() => [...streamEventProcessFeatureCandidateParams({ eventFeatureRegistry: null, researchConfiguration: rc, protocolVersion: 'x' })], EventProcessGenerationError);
  assert.throws(() => [...streamEventProcessFeatureCandidateParams({ eventFeatureRegistry, researchConfiguration: null, protocolVersion: 'x' })], EventProcessGenerationError);
});

test('streamEventProcessFeatureCandidates: generates real, fully-governed EventProcessFeature instances for all 3 core plugins, each with real provenance and a DecisionAuditLog GENERATED entry', async () => {
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const decisionAuditLog = new DecisionAuditLog();

  const results = [];
  for await (const result of streamEventProcessFeatureCandidates({
    eventFeatureRegistry, researchConfiguration: rc, protocolVersion: 'P12-GAP-v1.1.0',
    researchFreeze: freeze, sap, familyRegistry, decisionAuditLog,
  })) {
    results.push(result);
  }
  assert.equal(results.length, 3);
  for (const { candidate, provenance } of results) {
    assert.equal(candidate.type, CANDIDATE_TYPES.EVENT_PROCESS_FEATURE);
    assert.equal(candidate.researchFreezeId, freeze.id);
    assert.equal(candidate.sapId, sap.sapId);
    assert.equal(candidate.protocolVersion, 'P12-GAP-v1.1.0');
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance && provenance.hasNode(candidate.id));
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
  }
  const fingerprints = results.map((r) => r.candidate.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  const generatedEntries = decisionAuditLog.toArray().filter((e) => e.decisionType === 'GENERATED');
  assert.equal(generatedEntries.length, 3);
});

test('streamEventProcessFeatureCandidates: candidates flow through Screen -> Triage exactly like every other candidate type', async () => {
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const { Phase11Orchestrator } = await import('../../research/src/orchestration/Phase11Orchestrator.js');
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

  const candidates = [];
  for await (const { candidate } of streamEventProcessFeatureCandidates({
    eventFeatureRegistry, researchConfiguration: rc, protocolVersion: 'P12-GAP-v1.1.0',
    researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog,
  })) {
    orchestrator.updateCandidate(candidate);
    candidates.push(candidate);
  }
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 3);

  const { promoted: screened } = orchestrator.screen({ candidates, scoreFn: () => 1, promotionQuantile: 1 });
  assert.equal(screened.length, 3);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, 3);

  const diagnosticsByCandidateId = {};
  for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.1, diagnosticsPassed: [] };
  const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });
  assert.equal(triaged.length, 3);
  assert.ok(triaged.every((c) => c.type === CANDIDATE_TYPES.EVENT_PROCESS_FEATURE));
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/eventProcess/streamEventProcessFeatureCandidates.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
