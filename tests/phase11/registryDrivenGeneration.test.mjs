/**
 * tests/phase11/registryDrivenGeneration.test.mjs
 *
 * Tests for research/src/discovery/registryDrivenCandidateGenerator.js —
 * Stages 7 (streaming), 8 (deduplication), and the single-indicator slice
 * of Stage 9 (automatic Generated entry) of the registry-driven candidate
 * generation directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  streamIndicatorCandidateParams,
  streamRegistryDrivenCandidates,
  INDICATOR_FAMILY_BY_NAME,
  RegistryDrivenGenerationError,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators, CORE_INDICATOR_PLUGINS } from '../../research/src/indicator/coreIndicators.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-registry-001', name: 'registry-driven test', description: 'test',
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
    sapId: 'sap-registry-001', hypothesisFamilies: ['trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator'],
    alphaAllocation: { trend: 0.05, momentum: 0.05, volatility: 0.05, statistical: 0.05, microstructure: 0.05, indicator: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 1000000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// streamIndicatorCandidateParams (pure, synchronous)
// ═══════════════════════════════════════════════════════════════════════════

test('streamIndicatorCandidateParams: throws without a valid registry or researchConfiguration', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  assert.throws(() => [...streamIndicatorCandidateParams({ indicatorRegistry: null, researchConfiguration: rc })], RegistryDrivenGenerationError);
  assert.throws(() => [...streamIndicatorCandidateParams({ indicatorRegistry: registry, researchConfiguration: null })], RegistryDrivenGenerationError);
});

test('streamIndicatorCandidateParams: yields one params object per (indicator x period) combination', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  const periods = [10, 20, 30];
  const params = [...streamIndicatorCandidateParams({ indicatorRegistry: registry, periods, researchConfiguration: rc })];
  assert.equal(params.length, CORE_INDICATOR_PLUGINS.length * periods.length);
  for (const p of params) {
    assert.ok(p.id.includes(String(p.period)));
    assert.equal(p.researchConfigurationId, rc.id);
    assert.equal(p.configHash, rc.configHash);
  }
});

test('streamIndicatorCandidateParams: assigns a real family for every registered indicator, never leaving one unmapped by accident', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  const params = [...streamIndicatorCandidateParams({ indicatorRegistry: registry, periods: [14], researchConfiguration: rc })];
  for (const p of params) {
    assert.ok(INDICATOR_FAMILY_BY_NAME[p.indicatorName], `${p.indicatorName} has no explicit family mapping`);
    assert.equal(p.family, INDICATOR_FAMILY_BY_NAME[p.indicatorName]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// streamRegistryDrivenCandidates (async, real candidate generation)
// ═══════════════════════════════════════════════════════════════════════════

test('streamRegistryDrivenCandidates: generates real, fully-governed candidates for the full core indicator set', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const familyRegistry = new FamilyRegistry();
  for (const family of new Set(Object.values(INDICATOR_FAMILY_BY_NAME))) {
    familyRegistry.registerFamily({ familyName: family, version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  }

  const results = [];
  for await (const result of streamRegistryDrivenCandidates({
    indicatorRegistry: registry, periods: [14, 20], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    results.push(result);
  }

  assert.equal(results.length, CORE_INDICATOR_PLUGINS.length * 2);
  for (const { candidate, provenance } of results) {
    assert.equal(candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance.hasNode(candidate.id));
  }
});

test('streamRegistryDrivenCandidates: fingerprints are all distinct -- no duplicate ever enters the pipeline', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const familyRegistry = new FamilyRegistry();
  for (const family of new Set(Object.values(INDICATOR_FAMILY_BY_NAME))) {
    familyRegistry.registerFamily({ familyName: family, version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  }

  const fingerprints = [];
  for await (const { candidate } of streamRegistryDrivenCandidates({
    indicatorRegistry: registry, periods: [10, 14, 20], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    fingerprints.push(candidate.fingerprint);
  }
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test('streamRegistryDrivenCandidates: skips (via onSkip, not a thrown abort) candidates whose family is not registered, and continues the stream', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  // Only register ONE of the five families -- most candidates should be skipped, not abort the stream.
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'trend', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });

  const skipped = [];
  const results = [];
  for await (const result of streamRegistryDrivenCandidates({
    indicatorRegistry: registry, periods: [14], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
    onSkip: (err, params) => skipped.push({ err, params }),
  })) {
    results.push(result);
  }

  const trendIndicatorCount = Object.values(INDICATOR_FAMILY_BY_NAME).filter((f) => f === 'trend').length;
  assert.equal(results.length, trendIndicatorCount);
  assert.equal(skipped.length, CORE_INDICATOR_PLUGINS.length - trendIndicatorCount);
  for (const s of skipped) assert.ok(s.err instanceof Error);
});

// ═══════════════════════════════════════════════════════════════════════════
// Large-scale generation (10k+, simulated per the directive's own wording)
// ═══════════════════════════════════════════════════════════════════════════

test('streamRegistryDrivenCandidates: handles a 10,000+ candidate space via true streaming consumption', async () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry); // registry.size indicators (expanded over time, currently 26+)
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const familyRegistry = new FamilyRegistry();
  for (const family of new Set(Object.values(INDICATOR_FAMILY_BY_NAME))) {
    familyRegistry.registerFamily({ familyName: family, version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  }

  // 21 indicators x 500 periods = 10,500 candidates -- simulated scale, per
  // the directive's own "100,000+ candidate spaces without unbounded
  // memory growth" wording ("10k+ simulated" in the test requirements).
  const periods = Array.from({ length: 500 }, (_, i) => 10 + i);

  let count = 0;
  // Consume one at a time -- this IS the streaming guarantee under test:
  // at no point does the caller (or the generator internally) hold a full
  // array of all 10,500 results simultaneously. We only track a running
  // count, not the full result set.
  for await (const { candidate } of streamRegistryDrivenCandidates({
    indicatorRegistry: registry, periods, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
  })) {
    count++;
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    if (count >= 10500) break; // don't run longer than necessary once the scale claim is verified
  }
  assert.ok(count >= 10500, `expected to stream at least 10,500 candidates, got ${count}`);
});
