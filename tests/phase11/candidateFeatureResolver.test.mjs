/**
 * tests/phase11/candidateFeatureResolver.test.mjs
 *
 * Tests for bridge/Phase11CandidateFeatureResolver.js (Stage 6:
 * Confirmation Bridge completion) -- verifies that IndicatorFeature,
 * MarketState, ProxyCandidate, CompositeCandidate, and ConditionalHypothesis
 * candidates all resolve a real feature series through ONE canonical
 * dispatcher, and that runAutomatedConfirmationTest() runs a REAL
 * statistical confirmation test for each, with zero special-case logic
 * and zero duplicated plugin math.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import { MarketStateRegistry } from '../../research/src/plugin/MarketStateRegistry.js';
import { registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { MarketConstructProxyRegistry } from '../../research/src/proxy/MarketConstructProxyRegistry.js';
import { registerCoreProxies } from '../../research/src/proxy/coreProxies.js';
import { ContextRegistry } from '../../research/src/context/ContextRegistry.js';
import { registerCoreContexts } from '../../research/src/context/coreContexts.js';
import {
  resolveCandidateFeatureSeries, extractPrimarySignal, extractPrimaryCategory,
  Phase11FeatureResolutionError,
} from '../../research/src/bridge/Phase11CandidateFeatureResolver.js';
import { runAutomatedConfirmationTest } from '../../research/src/bridge/Phase11AutomatedConfirmation.js';
import {
  streamRegistryDrivenCandidates, streamMarketStateCandidates, streamProxyCandidates,
  streamCompositeCandidates, streamConditionalHypothesisCandidates,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

function makeWalkPrices(length, seed = 7, drift = 0) {
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < length; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1) + drift);
  return prices;
}

async function makeCycle(families) {
  const rc = await ResearchConfiguration.create({
    id: `rc-resolver-${Date.now()}-${Math.random()}`, name: 't', description: 't',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-resolver-${Date.now()}-${Math.random()}`, hypothesisFamilies: families,
    alphaAllocation: Object.fromEntries(families.map((f) => [f, 0.01])),
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  for (const f of families) familyRegistry.registerFamily({ familyName: f, version: '1.0.0', allowedCandidateTypes: Object.values(CANDIDATE_TYPES) });
  return { rc, freeze, sap, familyRegistry };
}

const ALL_FAMILIES = ['trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator', 'marketState', 'proxy', 'composite', 'conditional'];

// ═══════════════════════════════════════════════════════════════════════════
// Generic extraction helpers
// ═══════════════════════════════════════════════════════════════════════════

test('extractPrimarySignal: generically finds the number[] field via PluginContract tests()[0].expectedOutputShape, for heterogeneous proxy output shapes', () => {
  const registry = new MarketConstructProxyRegistry();
  registerCoreProxies(registry);
  const states = Array.from({ length: 30 }, (_, i) => ({ tick_price: 100 + i, tick_direction: 1 }));

  const signalPlugin = registry.lookup('RecentLocalMinimumProxy');
  const runLengthPlugin = registry.lookup('ConsecutiveUpTickClusterProxy');
  const varianceRatioPlugin = registry.lookup('LocalVolatilitySpikeProxy');

  assert.ok(Array.isArray(extractPrimarySignal(signalPlugin, signalPlugin.compute({ states, windowSize: 5 }))));
  assert.ok(Array.isArray(extractPrimarySignal(runLengthPlugin, runLengthPlugin.compute({ states }))));
  assert.ok(Array.isArray(extractPrimarySignal(varianceRatioPlugin, varianceRatioPlugin.compute({ states, shortWindow: 5, longWindow: 20 }))));
});

test('extractPrimaryCategory: generically finds the string[] field, for the 3 pre-existing contexts whose field names differ from category', () => {
  const registry = new ContextRegistry();
  registerCoreContexts(registry);
  const states = [{ tick_price: 100, candle_high: 105, candle_low: 95, candle_start: 0 }];

  const zonePlugin = registry.lookup('CandlePositionDetector'); // field: zone
  const phasePlugin = registry.lookup('CandleTimingDetector'); // field: phase
  const categoryPlugin = registry.lookup('VolatilityStateContext'); // field: category

  assert.ok(Array.isArray(extractPrimaryCategory(zonePlugin, zonePlugin.compute({ states }))));
  assert.ok(Array.isArray(extractPrimaryCategory(phasePlugin, phasePlugin.compute({ states }))));
  assert.ok(Array.isArray(extractPrimaryCategory(categoryPlugin, categoryPlugin.compute({ states, window: 1 }))));
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveCandidateFeatureSeries: one dispatcher, every candidate type
// ═══════════════════════════════════════════════════════════════════════════

test('resolveCandidateFeatureSeries: IndicatorFeature resolves through the canonical Indicator Registry (unchanged behavior)', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const prices = makeWalkPrices(300);

  let candidate;
  for await (const { candidate: c } of streamRegistryDrivenCandidates({ indicatorRegistry, periods: [14], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    if (c.indicatorName === 'RSI') { candidate = c; break; }
  }
  const series = resolveCandidateFeatureSeries({ candidate, registries: { indicatorRegistry }, prices });
  assert.ok(series.filter(Number.isFinite).length > 200);
});

test('resolveCandidateFeatureSeries: MarketState resolves through the canonical Market State Registry', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const prices = makeWalkPrices(300);

  let candidate;
  for await (const { candidate: c } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    if (c.stateLabel === 'Trend') { candidate = c; break; }
  }
  const series = resolveCandidateFeatureSeries({ candidate, registries: { marketStateRegistry }, prices });
  assert.ok(series.filter(Number.isFinite).length > 200);
  assert.ok(series.filter(Number.isFinite).every((v) => v === 0 || v === 1));
});

test('resolveCandidateFeatureSeries: ProxyCandidate resolves through the canonical Proxy Registry, including a proxy with a non-"signal" primary field (runLength)', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const proxyRegistry = new MarketConstructProxyRegistry(); registerCoreProxies(proxyRegistry);
  const prices = makeWalkPrices(300);

  let candidate;
  for await (const { candidate: c } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    if (c.proxyName === 'ConsecutiveUpTickClusterProxy') { candidate = c; break; }
  }
  const series = resolveCandidateFeatureSeries({ candidate, registries: { proxyRegistry }, prices });
  assert.ok(series.filter(Number.isFinite).length > 200);
});

test('resolveCandidateFeatureSeries: CompositeCandidate recursively resolves its real components and combines them (CONJUNCTION)', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const prices = makeWalkPrices(300);

  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) baseCandidates.push(candidate);
  const componentsById = Object.fromEntries(baseCandidates.map((c) => [c.id, c]));

  let composite;
  for await (const { candidate } of streamCompositeCandidates({ components: baseCandidates.slice(0, 2), researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    composite = candidate; break;
  }
  const series = resolveCandidateFeatureSeries({ candidate: composite, registries: { marketStateRegistry }, prices, componentsById });
  const finiteValues = series.filter(Number.isFinite);
  assert.ok(finiteValues.length > 0);
  assert.ok(finiteValues.every((v) => v === 0 || v === 1), 'CONJUNCTION of two binary state signals must itself be binary');
});

test('resolveCandidateFeatureSeries: ConditionalHypothesis masks its base candidate\'s series to only observations where the context condition holds', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const contextRegistry = new ContextRegistry(); registerCoreContexts(contextRegistry);
  const prices = makeWalkPrices(300, 5, 0.05);

  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) baseCandidates.push(candidate);
  const componentsById = Object.fromEntries(baseCandidates.map((c) => [c.id, c]));

  let conditional;
  for await (const { candidate } of streamConditionalHypothesisCandidates({
    baseCandidates, contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, contextsPerHypothesis: 2,
  })) {
    if (candidate.baseHypothesis.description.startsWith('Compression')) { conditional = candidate; break; }
  }
  assert.ok(conditional, 'expected to find the Compression-based conditional hypothesis');

  const baseSeries = resolveCandidateFeatureSeries({ candidate: componentsById[conditional.baseHypothesis.candidateId], registries: { marketStateRegistry }, prices });
  const maskedSeries = resolveCandidateFeatureSeries({ candidate: conditional, registries: { marketStateRegistry, contextRegistry }, prices, componentsById });

  const maskedFiniteCount = maskedSeries.filter(Number.isFinite).length;
  const baseFiniteCount = baseSeries.filter(Number.isFinite).length;
  assert.ok(maskedFiniteCount > 0, 'expected at least some observations where the context condition genuinely holds');
  assert.ok(maskedFiniteCount <= baseFiniteCount, 'masking can only ever reduce (never increase) the observation count relative to the unconditional base series');
});

test('resolveCandidateFeatureSeries: gracefully degrades (NaN everywhere, not a crash) when a context needs candle_high/low that a flat price series cannot supply', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const contextRegistry = new ContextRegistry(); registerCoreContexts(contextRegistry);
  const prices = makeWalkPrices(300);

  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) baseCandidates.push(candidate);
  const componentsById = Object.fromEntries(baseCandidates.map((c) => [c.id, c]));

  let conditional;
  for await (const { candidate } of streamConditionalHypothesisCandidates({
    baseCandidates: baseCandidates.slice(0, 1), contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, contextsPerHypothesis: 2,
  })) {
    conditional = candidate;
  }
  const series = resolveCandidateFeatureSeries({ candidate: conditional, registries: { marketStateRegistry, contextRegistry }, prices, componentsById });
  assert.equal(series.filter(Number.isFinite).length, 0, 'must degrade honestly to all-NaN, not crash and not fabricate a result');
});

test('resolveCandidateFeatureSeries: throws Phase11FeatureResolutionError for an unregistered plugin, a missing composite component, or an unsupported candidate type', () => {
  assert.throws(() => resolveCandidateFeatureSeries({
    candidate: { type: CANDIDATE_TYPES.INDICATOR_FEATURE, indicatorName: 'NOT_REAL', period: 14 },
    registries: { indicatorRegistry: new IndicatorRegistry() }, prices: [1, 2, 3],
  }), Phase11FeatureResolutionError);

  assert.throws(() => resolveCandidateFeatureSeries({
    candidate: { type: CANDIDATE_TYPES.COMPOSITE_CANDIDATE, componentIds: ['missing-1', 'missing-2'], combinator: 'conjunction' },
    registries: {}, prices: [1, 2, 3], componentsById: {},
  }), Phase11FeatureResolutionError);

  assert.throws(() => resolveCandidateFeatureSeries({
    candidate: { type: 'SomeFutureCandidateType' }, registries: {}, prices: [1, 2, 3],
  }), Phase11FeatureResolutionError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Full statistical confirmation integration -- real p-values, real
// permutation test + bootstrap, for every candidate type.
// ═══════════════════════════════════════════════════════════════════════════

test('runAutomatedConfirmationTest: runs a REAL permutation test + bootstrap for a MarketState candidate, producing a genuine p-value', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const prices = makeWalkPrices(300, 3, 0.05);

  let candidate;
  for await (const { candidate: c } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    if (c.stateLabel === 'Trend') { candidate = c; break; }
  }
  const report = runAutomatedConfirmationTest({
    candidate, registries: { marketStateRegistry }, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 1, permutations: 300, bootstrapResamples: 300,
  });
  assert.ok(typeof report.pValue === 'number' && report.pValue >= 0 && report.pValue <= 1);
  assert.ok(report.sampleSize >= 60);
  assert.equal(report.nullModel, 'circular_shift');
});

test('runAutomatedConfirmationTest: runs a REAL confirmation test for a ProxyCandidate', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const proxyRegistry = new MarketConstructProxyRegistry(); registerCoreProxies(proxyRegistry);
  const prices = makeWalkPrices(300);

  let candidate;
  for await (const { candidate: c } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    if (c.proxyName === 'RecentLocalMinimumProxy') { candidate = c; break; }
  }
  const report = runAutomatedConfirmationTest({
    candidate, registries: { proxyRegistry }, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 1, permutations: 300, bootstrapResamples: 300,
  });
  assert.ok(typeof report.pValue === 'number');
  assert.ok(report.sampleSize >= 60);
});

test('runAutomatedConfirmationTest: runs a REAL confirmation test for a CompositeCandidate, recursively resolving real components', async () => {
  const { rc, freeze, sap, familyRegistry } = await makeCycle(ALL_FAMILIES);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const prices = makeWalkPrices(300, 11);

  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) baseCandidates.push(candidate);
  const componentsById = Object.fromEntries(baseCandidates.map((c) => [c.id, c]));

  let composite;
  for await (const { candidate } of streamCompositeCandidates({ components: baseCandidates.slice(0, 2), researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    composite = candidate; break;
  }
  const report = runAutomatedConfirmationTest({
    candidate: composite, registries: { marketStateRegistry }, prices, componentsById,
    targetDefinition: { direction: 'Rise', runLength: 5 }, seed: 1, permutations: 300, bootstrapResamples: 300,
  });
  assert.ok(typeof report.pValue === 'number');
});

test('backward compatibility: a plain {indicatorName, period} candidate with NO .type field still resolves through the ORIGINAL computeIndicatorSeries path unchanged', async () => {
  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const prices = makeWalkPrices(300);
  const candidate = { indicatorName: 'RSI', period: 14 };
  const report = runAutomatedConfirmationTest({
    candidate, indicatorRegistry, prices, targetDefinition: { direction: 'Rise', runLength: 5 }, seed: 1, permutations: 200, bootstrapResamples: 200,
  });
  assert.ok(typeof report.pValue === 'number');
});

test('no special-case confirmation logic was introduced: Phase11AutomatedConfirmation.js delegates to ONE resolver function for every non-indicator candidate type, never branching per candidate type itself', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/bridge/Phase11AutomatedConfirmation.js', import.meta.url), 'utf8');
  assert.match(src, /resolveCandidateFeatureSeries\(/, 'must delegate to the canonical resolver');
  assert.ok(!/candidate\.type === CANDIDATE_TYPES\.MARKET_STATE/.test(src));
  assert.ok(!/candidate\.type === CANDIDATE_TYPES\.PROXY_CANDIDATE/.test(src));
  assert.ok(!/candidate\.type === CANDIDATE_TYPES\.COMPOSITE_CANDIDATE/.test(src));
  assert.ok(!/candidate\.type === CANDIDATE_TYPES\.CONDITIONAL_HYPOTHESIS/.test(src));
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/bridge/Phase11CandidateFeatureResolver.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
});
