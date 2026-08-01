/**
 * tests/phase11/proxyCandidate.test.mjs
 *
 * Tests for candidate/ProxyCandidate.js and its wiring into the registry-
 * driven generator (Stage 4 of the ontology-repair directive): ProxyCandidate
 * generation, composite generation (Indicator+Proxy, State+Proxy,
 * Proxy+Proxy) via the UNMODIFIED CompositeCandidate infrastructure,
 * provenance, fingerprints, lifecycle, registry integration, and
 * governance compatibility.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { ProxyCandidate } from '../../research/src/candidate/ProxyCandidate.js';
import { CANDIDATE_TYPES, CandidateValidationError } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { MarketConstructProxyRegistry } from '../../research/src/proxy/MarketConstructProxyRegistry.js';
import { registerCoreProxies, CORE_PROXY_PLUGINS } from '../../research/src/proxy/coreProxies.js';
import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import {
  streamProxyCandidateParams, streamProxyCandidates, streamRegistryDrivenCandidates,
  streamCompositeCandidates, RegistryDrivenGenerationError,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
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

const ALL_FAMILIES = ['trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator', 'proxy', 'composite'];

async function makeCycle() {
  const rc = await ResearchConfiguration.create({
    id: `rc-proxy-${Date.now()}-${Math.random()}`, name: 'proxy candidate test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-proxy-${Date.now()}-${Math.random()}`, hypothesisFamilies: ALL_FAMILIES,
    alphaAllocation: Object.fromEntries(ALL_FAMILIES.map((f) => [f, 0.01])),
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  for (const f of ALL_FAMILIES) {
    familyRegistry.registerFamily({
      familyName: f, version: '1.0.0',
      allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.PROXY_CANDIDATE, CANDIDATE_TYPES.COMPOSITE_CANDIDATE],
    });
  }
  return { rc, freeze, sap, familyRegistry };
}

const BASE_FIELDS = {
  family: 'proxy', generatorVersion: '11.1.0', grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64), researchConfigurationId: 'rc-test',
  description: 'test proxy candidate', proxyName: 'RecentLocalMinimumProxy', assumedConstruct: 'Support level / demand zone',
};

// ═══════════════════════════════════════════════════════════════════════════
// ProxyCandidate class itself
// ═══════════════════════════════════════════════════════════════════════════

test('ProxyCandidate.create(): builds a real candidate with a valid SHA-256 fingerprint, default Generated lifecycle, and empty deterministic lineage', async () => {
  const candidate = await ProxyCandidate.create({ ...BASE_FIELDS, id: 'proxy-cand-1', parameters: {} });
  assert.equal(candidate.type, CANDIDATE_TYPES.PROXY_CANDIDATE);
  assert.equal(candidate.proxyName, 'RecentLocalMinimumProxy');
  assert.equal(candidate.assumedConstruct, 'Support level / demand zone');
  assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
  assert.deepEqual(candidate.lineage, []);
  assert.deepEqual(JSON.parse(JSON.stringify(candidate.toJSON())).proxyName, 'RecentLocalMinimumProxy');
});

test('ProxyCandidate.create(): rejects missing proxyName or assumedConstruct', async () => {
  await assert.rejects(ProxyCandidate.create({ ...BASE_FIELDS, id: 'x', parameters: {}, proxyName: undefined }), CandidateValidationError);
  await assert.rejects(ProxyCandidate.create({ ...BASE_FIELDS, id: 'x', parameters: {}, assumedConstruct: '' }), CandidateValidationError);
});

test('ProxyCandidate: two candidates with identical defining parameters produce identical fingerprints (deterministic)', async () => {
  const a = await ProxyCandidate.create({ ...BASE_FIELDS, id: 'proxy-det-a', parameters: {} });
  const b = await ProxyCandidate.create({ ...BASE_FIELDS, id: 'proxy-det-a', parameters: {} });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('ProxyCandidate: does NOT duplicate the proxy plugin\'s own rich metadata onto the candidate -- only proxyName/assumedConstruct are stored', async () => {
  const candidate = await ProxyCandidate.create({ ...BASE_FIELDS, id: 'proxy-cand-2', parameters: {} });
  const json = candidate.toJSON();
  assert.ok(!('failureModes' in json));
  assert.ok(!('biases' in json));
  assert.ok(!('mathDefinition' in json));
  assert.ok(!('scientificEvidenceTier' in json));
});

// ═══════════════════════════════════════════════════════════════════════════
// Registry integration: MarketConstructProxyRegistry -> ProxyCandidate
// ═══════════════════════════════════════════════════════════════════════════

test('streamProxyCandidateParams: yields one candidateParams per registered proxy, proxyName/assumedConstruct copied verbatim from the plugin\'s own metadata', async () => {
  const proxyRegistry = new MarketConstructProxyRegistry();
  registerCoreProxies(proxyRegistry);
  const rc = await ResearchConfiguration.create({ id: 'rc-stream', name: 't', description: 't', grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {} });

  const paramsList = [...streamProxyCandidateParams({ proxyRegistry, researchConfiguration: rc })];
  assert.equal(paramsList.length, CORE_PROXY_PLUGINS.length);
  for (const params of paramsList) {
    const plugin = proxyRegistry.lookup(params.proxyName);
    assert.ok(plugin, `${params.proxyName} must be a real registered plugin`);
    assert.equal(params.assumedConstruct, plugin.metadata().assumedConstruct, 'assumedConstruct must be copied verbatim, not invented');
  }
});

test('streamProxyCandidates: generates real, fully-governed ProxyCandidate instances for all 10 core proxies, each with real provenance and a DecisionAuditLog GENERATED entry', async () => {
  const proxyRegistry = new MarketConstructProxyRegistry();
  registerCoreProxies(proxyRegistry);
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const decisionAuditLog = new DecisionAuditLog();

  const results = [];
  for await (const result of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog })) {
    results.push(result);
  }
  assert.equal(results.length, 10);
  for (const { candidate, provenance } of results) {
    assert.equal(candidate.type, CANDIDATE_TYPES.PROXY_CANDIDATE);
    assert.equal(candidate.researchFreezeId, freeze.id);
    assert.equal(candidate.sapId, sap.sapId);
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance && typeof provenance.hasNode === 'function' && provenance.hasNode(candidate.id));
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
  }
  const fingerprints = results.map((r) => r.candidate.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  const generatedEntries = decisionAuditLog.toArray().filter((e) => e.decisionType === 'GENERATED');
  assert.equal(generatedEntries.length, 10);
});

test('streamProxyCandidateParams/streamProxyCandidates: throw with an invalid registry or missing ResearchConfiguration', async () => {
  assert.throws(() => [...streamProxyCandidateParams({ proxyRegistry: null, researchConfiguration: { id: 'x', configHash: 'y' } })], RegistryDrivenGenerationError);
  await assert.rejects(async () => {
    for await (const _ of streamProxyCandidates({ proxyRegistry: null, researchConfiguration: { id: 'x', configHash: 'y' } })) { /* noop */ }
  }, RegistryDrivenGenerationError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 4: Indicator+Proxy / State+Proxy / Proxy+Proxy composites --
// via the UNMODIFIED CompositeCandidate infrastructure, no special path.
// ═══════════════════════════════════════════════════════════════════════════

test('Indicator+Proxy and Proxy+Proxy composites: generated with ZERO special-case composite code, using the exact same streamCompositeCandidates() already used for Indicator+Indicator', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const proxyRegistry = new MarketConstructProxyRegistry(); registerCoreProxies(proxyRegistry);

  const components = [];
  for await (const { candidate } of streamRegistryDrivenCandidates({ indicatorRegistry, periods: [14], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    components.push(candidate);
  }
  const indicatorCount = components.length;
  for await (const { candidate } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    components.push(candidate);
  }
  assert.ok(indicatorCount > 0 && components.length > indicatorCount, 'expected both indicator and proxy components present');

  const composites = [];
  for await (const { candidate, provenance } of streamCompositeCandidates({ components, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    composites.push({ candidate, provenance });
  }
  assert.ok(composites.length > 0);

  const boundaryComposite = composites.find(({ candidate }) => {
    const a = components.find((c) => c.id === candidate.componentIds[0]);
    const b = components.find((c) => c.id === candidate.componentIds[1]);
    return (a.type === CANDIDATE_TYPES.INDICATOR_FEATURE && b.type === CANDIDATE_TYPES.PROXY_CANDIDATE)
      || (a.type === CANDIDATE_TYPES.PROXY_CANDIDATE && b.type === CANDIDATE_TYPES.INDICATOR_FEATURE);
  });
  assert.ok(boundaryComposite, 'expected at least one real Indicator+Proxy composite');

  const proxyProxyComposite = composites.find(({ candidate }) => {
    const a = components.find((c) => c.id === candidate.componentIds[0]);
    const b = components.find((c) => c.id === candidate.componentIds[1]);
    return a.type === CANDIDATE_TYPES.PROXY_CANDIDATE && b.type === CANDIDATE_TYPES.PROXY_CANDIDATE;
  });
  assert.ok(proxyProxyComposite, 'expected at least one real Proxy+Proxy composite');

  for (const { candidate, provenance } of composites) {
    assert.equal(candidate.type, CANDIDATE_TYPES.COMPOSITE_CANDIDATE);
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance);
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
  }
});

test('no special composite implementation was created for proxy composites -- confirmed by static check', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/registryDrivenCandidateGenerator.js', import.meta.url), 'utf8');
  const compositeFunctionMatches = src.match(/export (async )?function\*? stream\w*Composite\w*/g) || [];
  assert.equal(compositeFunctionMatches.length, 2, 'expected exactly streamCompositeCandidateParams + streamCompositeCandidates, no proxy-specific variant');
});

// ═══════════════════════════════════════════════════════════════════════════
// Full pipeline integration
// ═══════════════════════════════════════════════════════════════════════════

test('Proxy candidates -> Screen -> Triage: flow through the same lifecycle transitions as any other candidate type', async () => {
  const teardown = setup();
  try {
    const { rc, freeze, sap, familyRegistry } = await makeCycle();
    const { Phase11Orchestrator } = await import('../../research/src/orchestration/Phase11Orchestrator.js');
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const proxyRegistry = new MarketConstructProxyRegistry();
    registerCoreProxies(proxyRegistry);
    const candidates = [];
    for await (const { candidate } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog })) {
      orchestrator.updateCandidate(candidate);
      candidates.push(candidate);
    }
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 10);

    const { promoted: screened } = orchestrator.screen({ candidates, scoreFn: () => 1, promotionQuantile: 1 });
    assert.equal(screened.length, 10);
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, 10);

    const diagnosticsByCandidateId = {};
    for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.1, diagnosticsPassed: [] };
    const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });
    assert.equal(triaged.length, 10);
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Triaged, 10);
    assert.ok(triaged.every((c) => c.type === CANDIDATE_TYPES.PROXY_CANDIDATE));
  } finally {
    teardown();
  }
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js directly', async () => {
  const fs = await import('node:fs');
  for (const file of ['../../research/src/candidate/ProxyCandidate.js', '../../research/src/discovery/registryDrivenCandidateGenerator.js']) {
    const src = await fs.promises.readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
  }
});
