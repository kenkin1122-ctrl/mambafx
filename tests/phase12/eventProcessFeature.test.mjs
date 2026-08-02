/**
 * tests/phase12/eventProcessFeature.test.mjs
 *
 * Tests for candidate/EventProcessFeature.js -- Phase 12's sixth Candidate
 * subtype, per approved design v1.2's refinements #3 (passive data object)
 * and #5 (versioned provenance distinct from software version).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventProcessFeature } from '../../research/src/candidate/EventProcessFeature.js';
import { CANDIDATE_TYPES, CandidateValidationError } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { generateCandidate } from '../../research/src/discovery/candidateGenerator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { DecisionAuditLog } from '../../research/src/governance/DecisionAuditLog.js';

const BASE_FIELDS = {
  family: 'eventProcess', generatorVersion: '12.0.0', grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64), researchConfigurationId: 'rc-test',
  description: 'test event process feature',
  featureName: 'TimeGap', eventId: 'evt-2', previousEventId: 'evt-1',
  protocolVersion: 'P12-GAP-v1.1.0', extractorVersion: '1.0.0', schemaVersion: '2.0.0',
};

async function makeCycle() {
  const rc = await ResearchConfiguration.create({
    id: `rc-p12-${Date.now()}-${Math.random()}`, name: 't', description: 't',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-p12-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['eventProcess'],
    alphaAllocation: { eventProcess: 0.01 }, promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000 }],
    replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
  return { rc, freeze, sap, familyRegistry };
}

// ═══════════════════════════════════════════════════════════════════════════
// EventProcessFeature class itself
// ═══════════════════════════════════════════════════════════════════════════

test('EventProcessFeature.create(): builds a real candidate with a valid SHA-256 fingerprint, Generated lifecycle, correct identity fields', async () => {
  const candidate = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-1', parameters: {} });
  assert.equal(candidate.type, CANDIDATE_TYPES.EVENT_PROCESS_FEATURE);
  assert.equal(candidate.featureName, 'TimeGap');
  assert.equal(candidate.eventId, 'evt-2');
  assert.equal(candidate.previousEventId, 'evt-1');
  assert.equal(candidate.protocolVersion, 'P12-GAP-v1.1.0');
  assert.equal(candidate.extractorVersion, '1.0.0');
  assert.equal(candidate.schemaVersion, '2.0.0');
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
});

test('EventProcessFeature.create(): previousEventId may be explicitly null (first event of session), not an error', async () => {
  const candidate = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-first', parameters: {}, previousEventId: null });
  assert.equal(candidate.previousEventId, null);
});

test('EventProcessFeature.create(): rejects missing featureName/eventId/protocolVersion/extractorVersion/schemaVersion', async () => {
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, featureName: undefined }), CandidateValidationError);
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, eventId: '' }), CandidateValidationError);
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, protocolVersion: undefined }), CandidateValidationError);
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, extractorVersion: undefined }), CandidateValidationError);
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, schemaVersion: undefined }), CandidateValidationError);
});

test('EventProcessFeature.create(): rejects a non-string, non-null previousEventId (e.g. a number)', async () => {
  await assert.rejects(EventProcessFeature.create({ ...BASE_FIELDS, id: 'x', parameters: {}, previousEventId: 42 }), CandidateValidationError);
});

test('EventProcessFeature: two candidates with identical defining parameters produce identical fingerprints (deterministic)', async () => {
  const a = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-det', parameters: {} });
  const b = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-det', parameters: {} });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('refinement #5: protocolVersion is a genuinely distinct field from the base Candidate\'s generatorVersion -- both are independently recorded', async () => {
  const candidate = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-versions', parameters: {} });
  assert.equal(candidate.generatorVersion, '12.0.0'); // software version (base Candidate field)
  assert.equal(candidate.protocolVersion, 'P12-GAP-v1.1.0'); // frozen scientific protocol version (this class's own field)
  assert.notEqual(candidate.generatorVersion, candidate.protocolVersion);
});

test('refinement #3: EventProcessFeature is a passive data object -- no compute/test/statistical method exists on the class or its instances', async () => {
  const candidate = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-passive', parameters: {} });
  assert.equal(typeof candidate.compute, 'undefined');
  assert.equal(typeof candidate.test, 'undefined');
  assert.equal(typeof candidate.runStatisticalTest, 'undefined');
  const json = candidate.toJSON();
  assert.ok(!('value' in json) && !('signal' in json) && !('pValue' in json));
});

test('EventProcessFeature: does not duplicate any EventFeatureRegistry plugin metadata onto the candidate -- only featureName is stored, routing back to the real plugin', async () => {
  const candidate = await EventProcessFeature.create({ ...BASE_FIELDS, id: 'evtf-nodup', parameters: {} });
  const json = candidate.toJSON();
  assert.ok(!('mathDefinition' in json));
  assert.ok(!('scientificAssumptions' in json));
  assert.ok(!('maxLookahead' in json));
});

// ═══════════════════════════════════════════════════════════════════════════
// Governance integration: the ONE construction path, real fingerprint/provenance
// ═══════════════════════════════════════════════════════════════════════════

test('EventProcessFeature flows through the real, unmodified generateCandidate() governance path with real provenance and DecisionAuditLog entry', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const decisionAuditLog = new DecisionAuditLog();

  const candidateParams = {
    id: 'evtf-gov-1', family: 'eventProcess', parameters: {},
    description: 'TimeGap between evt-2 and evt-1.',
    generatorVersion: '12.0.0', grammarVersion: '11.0.0', configHash: rc.configHash, researchConfigurationId: rc.id,
    featureName: 'TimeGap', eventId: 'evt-2', previousEventId: 'evt-1',
    protocolVersion: 'P12-GAP-v1.1.0', extractorVersion: '1.0.0', schemaVersion: '2.0.0',
  };
  const { candidate, provenance } = await generateCandidate({
    candidateType: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, candidateParams,
    researchFreeze: freeze, sap, familyRegistry, decisionAuditLog,
  });

  assert.equal(candidate.type, CANDIDATE_TYPES.EVENT_PROCESS_FEATURE);
  assert.equal(candidate.researchFreezeId, freeze.id);
  assert.equal(candidate.sapId, sap.sapId);
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(provenance && provenance.hasNode(candidate.id));
  const { compatible } = familyRegistry.isCandidateCompatible(candidate);
  assert.equal(compatible, true);
  const generatedEntries = decisionAuditLog.toArray().filter((e) => e.decisionType === 'GENERATED');
  assert.equal(generatedEntries.length, 1);
});

test('EventProcessFeature candidates flow through Screen -> Triage like any other candidate type', async () => {
  const { freeze, sap, familyRegistry } = await makeCycle();
  const { Phase11Orchestrator } = await import('../../research/src/orchestration/Phase11Orchestrator.js');
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

  const candidate = await EventProcessFeature.create({
    ...BASE_FIELDS, id: 'evtf-lifecycle', parameters: {},
    researchFreezeId: freeze.id, sapId: sap.sapId,
  });
  orchestrator.updateCandidate(candidate);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 1);

  const { promoted: screened } = orchestrator.screen({ candidates: [candidate], scoreFn: () => 1, promotionQuantile: 1 });
  assert.equal(screened.length, 1);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, 1);

  const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId: { [candidate.id]: { effectSize: 0.1, diagnosticsPassed: [] } } });
  assert.equal(triaged.length, 1);
  assert.equal(triaged[0].type, CANDIDATE_TYPES.EVENT_PROCESS_FEATURE);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/candidate/EventProcessFeature.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
