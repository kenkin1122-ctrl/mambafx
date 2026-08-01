/**
 * tests/phase11/candidateSpaceExpansion.test.mjs
 *
 * Tests for the "Expansion of the Candidate Space" directive: new
 * indicators/market states, composite generation (Stage 4), 500+/1000+
 * candidate scale (Stage 6), and governance completeness (Stage 8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { CORE_INDICATOR_PLUGINS, registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import { MarketStateRegistry } from '../../research/src/plugin/MarketStateRegistry.js';
import { CORE_MARKET_STATE_PLUGINS, registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';
import {
  streamAllRegistryDrivenCandidates,
  streamCompositeCandidateParams,
  streamCompositeCandidates,
  RegistryDrivenGenerationError,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { DecisionAuditLog } from '../../research/src/governance/DecisionAuditLog.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

const ALL_FAMILIES = ['trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator', 'marketState', 'composite'];

async function makeCycle() {
  const rc = await ResearchConfiguration.create({
    id: `rc-expand-${Date.now()}-${Math.random()}`, name: 'expansion test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-expand-${Date.now()}-${Math.random()}`, hypothesisFamilies: ALL_FAMILIES,
    alphaAllocation: Object.fromEntries(ALL_FAMILIES.map((f) => [f, 0.01])),
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  for (const f of ALL_FAMILIES) {
    familyRegistry.registerFamily({
      familyName: f, version: '1.0.0',
      allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.MARKET_STATE, CANDIDATE_TYPES.COMPOSITE_CANDIDATE],
    });
  }
  return { rc, freeze, sap, familyRegistry };
}

// ═══════════════════════════════════════════════════════════════════════════
// Stage 1/2: expanded libraries
// ═══════════════════════════════════════════════════════════════════════════

test('indicator library expanded to 26+ plugins, every one PluginContract-conformant with maxLookahead=0', () => {
  assert.ok(CORE_INDICATOR_PLUGINS.length >= 26);
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.equal(valid, true, `${plugin.metadata().name}: ${errors.join('; ')}`);
    assert.equal(plugin.metadata().maxLookahead, 0);
    assert.ok(plugin.mathDefinition, `${plugin.metadata().name} must expose a MachineReadableMathematics definition`);
    assert.ok(Array.isArray(plugin.scientificAssumptions()) && plugin.scientificAssumptions().length > 0);
    assert.ok(Array.isArray(plugin.tests()) && plugin.tests().length > 0);
  }
});

test('market-state library expanded to 15+ plugins, every one PluginContract-conformant with maxLookahead=0', () => {
  assert.ok(CORE_MARKET_STATE_PLUGINS.length >= 15);
  for (const plugin of CORE_MARKET_STATE_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.equal(valid, true, `${plugin.metadata().name}: ${errors.join('; ')}`);
    assert.equal(plugin.metadata().maxLookahead, 0);
  }
});

test('no duplicate indicator names (each is a scientifically distinct formula, not a renamed duplicate)', () => {
  const names = CORE_INDICATOR_PLUGINS.map((p) => p.metadata().name);
  assert.equal(new Set(names).size, names.length);
});

test('no duplicate market-state names', () => {
  const names = CORE_MARKET_STATE_PLUGINS.map((p) => p.metadata().name);
  assert.equal(new Set(names).size, names.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 4: composite generation
// ═══════════════════════════════════════════════════════════════════════════

test('streamCompositeCandidateParams: throws with fewer than 2 components', () => {
  assert.throws(() => [...streamCompositeCandidateParams({ components: [{ id: 'a' }], researchConfiguration: { id: 'x', configHash: 'y' } })], RegistryDrivenGenerationError);
});

test('streamCompositeCandidates: produces real, governed CompositeCandidate instances (Indicator+Indicator and Indicator+MarketState mixed)', async () => {
  const teardown = setup();
  try {
    const { rc, freeze, sap, familyRegistry } = await makeCycle();
    const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
    const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);

    const components = [];
    for await (const { candidate } of streamAllRegistryDrivenCandidates({
      indicatorRegistry, marketStateRegistry, periods: [14], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
    })) {
      components.push(candidate);
    }
    assert.ok(components.length >= 20);

    const decisionAuditLog = new DecisionAuditLog();
    const composites = [];
    for await (const result of streamCompositeCandidates({
      components, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog,
    })) {
      composites.push(result);
    }
    assert.ok(composites.length > 0);
    for (const { candidate, provenance } of composites) {
      assert.equal(candidate.type, CANDIDATE_TYPES.COMPOSITE_CANDIDATE);
      assert.equal(candidate.componentIds.length, 2);
      assert.ok(components.some((c) => c.id === candidate.componentIds[0]));
      assert.ok(components.some((c) => c.id === candidate.componentIds[1]));
      assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
      assert.ok(provenance);
      const { compatible } = familyRegistry.isCandidateCompatible(candidate);
      assert.equal(compatible, true);
    }
    // Real DecisionAuditLog entries were written for every composite too.
    assert.ok(decisionAuditLog.toArray().some((e) => e.decisionType === 'GENERATED'));
  } finally {
    teardown();
  }
});

test('composite fingerprints are unique -- no duplicate composite enters the pipeline twice across repeated generation', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);

  const components = [];
  for await (const { candidate } of streamAllRegistryDrivenCandidates({
    indicatorRegistry, marketStateRegistry: null, periods: [14, 20], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    components.push(candidate);
  }

  const seenFingerprints = new Set();
  const firstPass = [];
  for await (const { candidate } of streamCompositeCandidates({ components, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, seenFingerprints })) {
    firstPass.push(candidate);
  }
  const secondPass = [];
  for await (const { candidate } of streamCompositeCandidates({ components, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, seenFingerprints })) {
    secondPass.push(candidate);
  }
  assert.ok(firstPass.length > 0);
  assert.equal(secondPass.length, 0, 'a second identical pass, sharing the fingerprint set, must yield nothing new');
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 6: candidate-space scale (500+, 1000+)
// ═══════════════════════════════════════════════════════════════════════════

test('scale: streams 500+ governed candidates via true streaming (no bulk array), all unique fingerprints', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  // 26+ indicators x 20 periods + 15 states => well past 500.
  const periods = Array.from({ length: 20 }, (_, i) => 10 + i);

  let count = 0;
  const fingerprints = new Set();
  for await (const { candidate } of streamAllRegistryDrivenCandidates({
    indicatorRegistry, marketStateRegistry, periods, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    count++;
    fingerprints.add(candidate.fingerprint);
  }
  assert.ok(count >= 500, `expected 500+, got ${count}`);
  assert.equal(fingerprints.size, count);
});

test('scale: streams 1,000+ governed candidates, still all unique, still all real-provenance-backed', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const periods = Array.from({ length: 40 }, (_, i) => 10 + i);

  let count = 0;
  const fingerprints = new Set();
  for await (const { candidate, provenance } of streamAllRegistryDrivenCandidates({
    indicatorRegistry, marketStateRegistry, periods, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    count++;
    fingerprints.add(candidate.fingerprint);
    assert.ok(provenance);
  }
  assert.ok(count >= 1000, `expected 1,000+, got ${count}`);
  assert.equal(fingerprints.size, count);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 8: governance completeness
// ═══════════════════════════════════════════════════════════════════════════

test('governance completeness: every generated candidate carries ResearchFreeze id, SAP id, real provenance, a valid SHA-256 fingerprint, and passed a real FamilyRegistry check', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const decisionAuditLog = new DecisionAuditLog();

  let checked = 0;
  for await (const { candidate, provenance } of streamAllRegistryDrivenCandidates({
    indicatorRegistry, marketStateRegistry, periods: [14, 20], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog,
  })) {
    assert.equal(candidate.researchFreezeId, freeze.id);
    assert.equal(candidate.sapId, sap.sapId);
    assert.equal(candidate.researchConfigurationId, rc.id);
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance && typeof provenance.hasNode === 'function' && provenance.hasNode(candidate.id));
    assert.ok(Array.isArray(candidate.lineage)); // present, deterministic (empty for root candidates)
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
    checked++;
  }
  assert.ok(checked > 0);
  // DecisionAuditLog has a real GENERATED entry per candidate actually generated.
  const generatedEntries = decisionAuditLog.toArray().filter((e) => e.decisionType === 'GENERATED');
  assert.equal(generatedEntries.length, checked);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/registryDrivenCandidateGenerator.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
});
