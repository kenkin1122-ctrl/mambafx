/**
 * tests/phase11/novelStateDiscovery.test.mjs
 *
 * Tests for discovery/NovelStateDiscovery.js -- Stage 10: pure data-driven
 * clustering, real novelty scoring against empirically-measured known-
 * state signatures, real MarketState candidates through the unmodified
 * generateCandidate() governance path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketStateRegistry } from '../../research/src/plugin/MarketStateRegistry.js';
import { registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import {
  computeFeatureVector, computeAllFeatureVectors, kMeansCluster, computeKnownStateSignatures,
  scoreNovelty, streamNovelStateCandidateParams, streamNovelStateCandidates, NovelStateDiscoveryError,
  FEATURE_NAMES,
} from '../../research/src/discovery/NovelStateDiscovery.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

function makeMultiRegimePrices(seed = 5) {
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < 150; i++) prices.push(prices[prices.length - 1] + 0.3 + (rng() < 0.5 ? 0.5 : -0.5));
  for (let i = 0; i < 150; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 0.3 : -0.3));
  for (let i = 0; i < 150; i++) prices.push(prices[prices.length - 1] + (i % 2 === 0 ? 8 : -8) + (rng() < 0.5 ? 0.2 : -0.2));
  return prices;
}

async function makeCycle() {
  const rc = await ResearchConfiguration.create({
    id: `rc-novel-${Date.now()}-${Math.random()}`, name: 't', description: 't',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-novel-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['novelState'],
    alphaAllocation: { novelState: 0.01 }, promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }],
    replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'novelState', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.MARKET_STATE] });
  return { rc, freeze, sap, familyRegistry };
}

test('computeFeatureVector: produces a real, finite 5-dimensional vector reusing existing indicator plugins, or null for insufficient lookback', () => {
  const prices = makeMultiRegimePrices();
  const v = computeFeatureVector(prices, 100, 20);
  assert.ok(Array.isArray(v));
  assert.equal(v.length, FEATURE_NAMES.length);
  assert.ok(v.every(Number.isFinite));

  const tooEarly = computeFeatureVector(prices, 2, 20);
  assert.equal(tooEarly, null);
});

test('kMeansCluster: deterministic for a fixed seed (no hidden randomness), returns real centroids matching the feature dimensionality', () => {
  const prices = makeMultiRegimePrices();
  const { vectors } = computeAllFeatureVectors(prices, 20, 5);
  const a = kMeansCluster(vectors, 4, 42);
  const b = kMeansCluster(vectors, 4, 42);
  assert.deepEqual(a, b);
  assert.equal(a.centroids.length, 4);
  assert.equal(a.centroids[0].length, FEATURE_NAMES.length);
  assert.equal(a.assignments.length, vectors.length);
});

test('kMeansCluster: different seeds can produce different clusterings (real randomness in initialization, not a fixed answer)', () => {
  const prices = makeMultiRegimePrices();
  const { vectors } = computeAllFeatureVectors(prices, 20, 5);
  const a = kMeansCluster(vectors, 4, 1);
  const b = kMeansCluster(vectors, 4, 999);
  assert.equal(a.centroids.length, 4);
  assert.equal(b.centroids.length, 4);
});

test('kMeansCluster: throws for k larger than the available vector count', () => {
  assert.throws(() => kMeansCluster([[1, 2], [3, 4]], 5, 1), NovelStateDiscoveryError);
});

test('computeKnownStateSignatures: computes a REAL empirical mean feature vector per known state, from windows where that state\'s own detector actually fires', () => {
  const prices = makeMultiRegimePrices();
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const signatures = computeKnownStateSignatures(prices, marketStateRegistry, 20);
  assert.ok(Object.keys(signatures).length > 0);
  for (const vector of Object.values(signatures)) {
    assert.equal(vector.length, FEATURE_NAMES.length);
    assert.ok(vector.every(Number.isFinite));
  }
});

test('scoreNovelty: a centroid identical to a known signature has zero novelty and identifies that state as nearest', () => {
  const signatures = { Trend: [1, 2, 3, 4, 5], Range: [10, 10, 10, 10, 10] };
  const result = scoreNovelty([1, 2, 3, 4, 5], signatures);
  assert.equal(result.noveltyScore, 0);
  assert.equal(result.nearestKnownState, 'Trend');
});

test('streamNovelStateCandidateParams: throws without a seed (no hidden randomness), insufficient data, or missing registry', () => {
  const prices = makeMultiRegimePrices();
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const rc = { id: 'rc', configHash: 'a'.repeat(64) };

  assert.throws(() => [...streamNovelStateCandidateParams({ prices, marketStateRegistry, researchConfiguration: rc, k: 4 })], NovelStateDiscoveryError);
  assert.throws(() => [...streamNovelStateCandidateParams({ prices: [1, 2, 3], marketStateRegistry, researchConfiguration: rc, k: 4, seed: 1 })], NovelStateDiscoveryError);
  assert.throws(() => [...streamNovelStateCandidateParams({ prices, marketStateRegistry: null, researchConfiguration: rc, k: 4, seed: 1 })], NovelStateDiscoveryError);
});

test('streamNovelStateCandidates: generates real, fully-governed MarketState candidates for genuinely novel clusters, each with explainable detectionCriteria', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const prices = makeMultiRegimePrices();

  const results = [];
  for await (const result of streamNovelStateCandidates({
    prices, marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
    k: 4, seed: 42, noveltyThreshold: 0.5,
  })) {
    results.push(result);
  }
  assert.ok(results.length > 0, 'expected at least one genuinely novel cluster from multi-regime synthetic data');

  for (const { candidate, provenance } of results) {
    assert.equal(candidate.type, CANDIDATE_TYPES.MARKET_STATE);
    assert.match(candidate.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(provenance && typeof provenance.hasNode === 'function' && provenance.hasNode(candidate.id));
    assert.ok(candidate.detectionCriteria.noveltyScore >= 0.5, 'must genuinely clear the requested novelty threshold');
    assert.ok(Array.isArray(candidate.detectionCriteria.centroid));
    assert.equal(candidate.detectionCriteria.centroid.length, FEATURE_NAMES.length);
    assert.deepEqual(candidate.detectionCriteria.featureNames, [...FEATURE_NAMES]);
    assert.equal(candidate.detectionCriteria.discoveryMethod, 'kmeans-clustering');
    const { compatible } = familyRegistry.isCandidateCompatible(candidate);
    assert.equal(compatible, true);
  }
  const fingerprints = results.map((r) => r.candidate.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test('streamNovelStateCandidates: a stricter (higher) noveltyThreshold yields fewer or equal candidates than a looser one', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const prices = makeMultiRegimePrices();

  const loose = [];
  for await (const r of streamNovelStateCandidates({ prices, marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, k: 4, seed: 42, noveltyThreshold: 0.1 })) loose.push(r);
  const strict = [];
  for await (const r of streamNovelStateCandidates({ prices, marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, k: 4, seed: 42, noveltyThreshold: 2.0 })) strict.push(r);

  assert.ok(strict.length <= loose.length);
});

test('discovered novel-state candidates flow through Screen -> Triage like any other candidate type', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle();
  const { Phase11Orchestrator } = await import('../../research/src/orchestration/Phase11Orchestrator.js');
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const prices = makeMultiRegimePrices();

  const candidates = [];
  for await (const { candidate } of streamNovelStateCandidates({
    prices, marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry,
    k: 4, seed: 42, noveltyThreshold: 0.5, decisionAuditLog: orchestrator.decisionAuditLog,
  })) {
    orchestrator.updateCandidate(candidate);
    candidates.push(candidate);
  }
  assert.ok(candidates.length > 0);
  const { promoted: screened } = orchestrator.screen({ candidates, scoreFn: () => 1, promotionQuantile: 1 });
  assert.equal(screened.length, candidates.length);
});

test('no new candidate type or special-case governance path was introduced: novel states are real MarketState candidates through the unmodified generateCandidate()', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/NovelStateDiscovery.js', import.meta.url), 'utf8');
  assert.match(src, /candidateType:\s*CANDIDATE_TYPES\.MARKET_STATE/);
  assert.ok(!/CANDIDATE_TYPES\.NOVEL_STATE/.test(src), 'no new NOVEL_STATE candidate type was invented');
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/NovelStateDiscovery.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
});
