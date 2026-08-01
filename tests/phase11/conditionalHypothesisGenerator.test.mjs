/**
 * tests/phase11/conditionalHypothesisGenerator.test.mjs
 *
 * Tests for the Conditional Hypothesis Generator (Stage 5): MarketState
 * (or any candidate type) + up to 3 real registered contexts, routed
 * through the existing, unmodified generateCandidate() and
 * candidate/ConditionalHypothesis.js's own hard 3-context cap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { MarketStateRegistry } from '../../research/src/plugin/MarketStateRegistry.js';
import { registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { ContextRegistry } from '../../research/src/context/ContextRegistry.js';
import { registerCoreContexts } from '../../research/src/context/coreContexts.js';
import {
  streamMarketStateCandidates, streamConditionalHypothesisCandidateParams, streamConditionalHypothesisCandidates,
  RegistryDrivenGenerationError,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
import { MAX_CONTEXT_CONDITIONS } from '../../research/src/candidate/ConditionalHypothesis.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { DecisionAuditLog } from '../../research/src/governance/DecisionAuditLog.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function makeCycle() {
  const families = ['marketState', 'conditional'];
  const rc = await ResearchConfiguration.create({
    id: `rc-cond-${Date.now()}-${Math.random()}`, name: 'conditional test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-cond-${Date.now()}-${Math.random()}`, hypothesisFamilies: families,
    alphaAllocation: Object.fromEntries(families.map((f) => [f, 0.01])),
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'marketState', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.MARKET_STATE] });
  familyRegistry.registerFamily({ familyName: 'conditional', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS] });
  return { rc, freeze, sap, familyRegistry };
}

async function makeBaseCandidates(rc, freeze, sap, familyRegistry) {
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    baseCandidates.push(candidate);
  }
  return baseCandidates;
}

test('streamConditionalHypothesisCandidateParams: the 3-context cap is validated BEFORE any candidate params are yielded (contextsPerHypothesis=4 throws immediately)', () => {
  const contextRegistry = new ContextRegistry();
  registerCoreContexts(contextRegistry);
  assert.throws(() => [...streamConditionalHypothesisCandidateParams({
    baseCandidates: [{ id: 'x', type: 'MarketState', description: 'x' }], contextRegistry,
    researchConfiguration: { id: 'rc', configHash: 'a'.repeat(64) }, contextsPerHypothesis: 4,
  })], RegistryDrivenGenerationError);
  assert.equal(MAX_CONTEXT_CONDITIONS, 3, 'sanity check: the cap this generator defers to is still 3');
});

test('streamConditionalHypothesisCandidateParams: rejects zero/negative contextsPerHypothesis and empty baseCandidates', () => {
  const contextRegistry = new ContextRegistry();
  registerCoreContexts(contextRegistry);
  const rc = { id: 'rc', configHash: 'a'.repeat(64) };
  assert.throws(() => [...streamConditionalHypothesisCandidateParams({ baseCandidates: [{ id: 'x', type: 'MarketState', description: 'x' }], contextRegistry, researchConfiguration: rc, contextsPerHypothesis: 0 })], RegistryDrivenGenerationError);
  assert.throws(() => [...streamConditionalHypothesisCandidateParams({ baseCandidates: [], contextRegistry, researchConfiguration: rc })], RegistryDrivenGenerationError);
  assert.throws(() => [...streamConditionalHypothesisCandidateParams({ baseCandidates: [{ id: 'x', type: 'MarketState', description: 'x' }], contextRegistry: null, researchConfiguration: rc })], RegistryDrivenGenerationError);
});

test('streamConditionalHypothesisCandidates: generates real, fully-governed ConditionalHypothesis candidates from real MarketState base candidates and real registered contexts', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const baseCandidates = await makeBaseCandidates(rc, freeze, sap, familyRegistry);
  const contextRegistry = new ContextRegistry();
  registerCoreContexts(contextRegistry);
  const decisionAuditLog = new DecisionAuditLog();

  const results = [];
  for await (const result of streamConditionalHypothesisCandidates({
    baseCandidates, contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog, contextsPerHypothesis: 2,
  })) {
    results.push(result);
  }
  assert.equal(results.length, baseCandidates.length);
  for (const { candidate, provenance } of results) {
    assert.equal(candidate.type, CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS);
    assert.equal(candidate.contextConditions.length, 2, 'must respect the requested contextsPerHypothesis, never exceeding the cap');
    assert.ok(candidate.contextConditions.length <= MAX_CONTEXT_CONDITIONS);
    assert.equal(candidate.baseHypothesis.candidateType, CANDIDATE_TYPES.MARKET_STATE);
    assert.ok(baseCandidates.some((b) => b.id === candidate.baseHypothesis.candidateId));
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance && typeof provenance.hasNode === 'function' && provenance.hasNode(candidate.id));
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
  }
  const fingerprints = results.map((r) => r.candidate.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  const generatedEntries = decisionAuditLog.toArray().filter((e) => e.decisionType === 'GENERATED');
  assert.equal(generatedEntries.length, results.length);
});

test('streamConditionalHypothesisCandidates: never constructs more than MAX_CONTEXT_CONDITIONS contexts, even when requesting the maximum (3)', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const baseCandidates = await makeBaseCandidates(rc, freeze, sap, familyRegistry);
  const contextRegistry = new ContextRegistry();
  registerCoreContexts(contextRegistry);

  for await (const { candidate } of streamConditionalHypothesisCandidates({
    baseCandidates: baseCandidates.slice(0, 3), contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, contextsPerHypothesis: 3,
  })) {
    assert.equal(candidate.contextConditions.length, 3);
    assert.equal(new Set(candidate.contextConditions.map((c) => c.contextName)).size, 3, 'the 3 contexts within one hypothesis must be distinct');
  }
});

test('baseHypothesis stores only an identity reference to the real base candidate -- the base candidate\'s own full record is never duplicated onto the ConditionalHypothesis', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const baseCandidates = await makeBaseCandidates(rc, freeze, sap, familyRegistry);
  const contextRegistry = new ContextRegistry();
  registerCoreContexts(contextRegistry);

  const results = [];
  for await (const result of streamConditionalHypothesisCandidates({
    baseCandidates: baseCandidates.slice(0, 1), contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    results.push(result);
  }
  const { candidate } = results[0];
  assert.deepEqual(Object.keys(candidate.baseHypothesis).sort(), ['candidateId', 'candidateType', 'description'].sort());
  assert.ok(!('fingerprint' in candidate.baseHypothesis), 'must not duplicate the base candidate\'s own fingerprint/provenance/lifecycle etc.');
});

test('Conditional Hypothesis candidates flow through Screen -> Triage like any other candidate type', async () => {
  const teardown = setup();
  try {
    const { rc, freeze, sap, familyRegistry } = await makeCycle();
    const { Phase11Orchestrator } = await import('../../research/src/orchestration/Phase11Orchestrator.js');
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const baseCandidates = await makeBaseCandidates(rc, freeze, sap, familyRegistry);
    const contextRegistry = new ContextRegistry();
    registerCoreContexts(contextRegistry);

    const candidates = [];
    for await (const { candidate } of streamConditionalHypothesisCandidates({
      baseCandidates, contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog,
    })) {
      orchestrator.updateCandidate(candidate);
      candidates.push(candidate);
    }
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, candidates.length);

    const { promoted: screened } = orchestrator.screen({ candidates, scoreFn: () => 1, promotionQuantile: 1 });
    assert.equal(screened.length, candidates.length);
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, candidates.length);
  } finally {
    teardown();
  }
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/registryDrivenCandidateGenerator.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
});
