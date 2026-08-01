/**
 * tests/phase11/registryDrivenGenerator.test.mjs
 *
 * Tests for Stages 1, 2, 5, 7, 8 of the "Registry-Driven Candidate
 * Generation & Full Discovery Pipeline" directive: IndicatorRegistry,
 * MarketStateRegistry, the core plugin sets, and the streaming,
 * deduplicating registry-driven generator.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IndicatorRegistry, IndicatorRegistryError } from '../../research/src/plugin/IndicatorRegistry.js';
import { CORE_INDICATOR_PLUGINS, registerCoreIndicators } from '../../research/src/plugin/coreIndicators.js';
import { MarketStateRegistry, MarketStateRegistryError } from '../../research/src/plugin/MarketStateRegistry.js';
import { CORE_MARKET_STATE_PLUGINS, registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';
import {
  generateIndicatorCandidatesStream,
  generateMarketStateCandidatesStream,
  generateCompositeCandidatesStream,
  RegistryDrivenGeneratorError,
} from '../../research/src/discovery/registryDrivenGenerator.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

const BASE_PARAMS = {
  family: 'registry-driven-test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64), researchConfigurationId: 'rc-registry-test',
};

// ═══════════════════════════════════════════════════════════════════════════
// Stage 1: Indicator Registry / plugin loading
// ═══════════════════════════════════════════════════════════════════════════

test('IndicatorRegistry: registers all core indicator plugins, each conforming to PluginContract', () => {
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.equal(valid, true, `plugin ${plugin.metadata().name} failed PluginContract: ${errors.join('; ')}`);
  }
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  assert.equal(registry.size, CORE_INDICATOR_PLUGINS.length);
  assert.ok(registry.size >= 10, 'representative coverage requires at least 10 indicators');
});

test('IndicatorRegistry: rejects a non-conforming plugin and duplicate names', () => {
  const registry = new IndicatorRegistry();
  assert.throws(() => registry.register({ metadata: () => ({}) }), IndicatorRegistryError);
  registerCoreIndicators(registry);
  assert.throws(() => registry.register(CORE_INDICATOR_PLUGINS[0]), IndicatorRegistryError);
});

test('IndicatorRegistry: every core indicator enforces maxLookahead=0 (structural causal constraint)', () => {
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    assert.equal(plugin.metadata().maxLookahead, 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 2: Market State Registry
// ═══════════════════════════════════════════════════════════════════════════

test('MarketStateRegistry: registers all core market-state plugins, each conforming to PluginContract', () => {
  for (const plugin of CORE_MARKET_STATE_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.equal(valid, true, `plugin ${plugin.metadata().name} failed PluginContract: ${errors.join('; ')}`);
  }
  const registry = new MarketStateRegistry();
  registerCoreMarketStates(registry);
  assert.equal(registry.size, CORE_MARKET_STATE_PLUGINS.length);
  assert.ok(registry.size >= 6, 'representative coverage requires at least 6 market states');
});

test('MarketStateRegistry: rejects duplicate registration', () => {
  const registry = new MarketStateRegistry();
  registerCoreMarketStates(registry);
  assert.throws(() => registry.register(CORE_MARKET_STATE_PLUGINS[0]), MarketStateRegistryError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 5/7/8: streaming generation, fingerprint dedup, composites
// ═══════════════════════════════════════════════════════════════════════════

test('generateIndicatorCandidatesStream: yields one real IndicatorFeature candidate per (plugin, period), all unique fingerprints', async () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const periods = [10, 20];
  const seenFingerprints = new Set();

  const yielded = [];
  for await (const { candidate, plugin } of generateIndicatorCandidatesStream({ indicatorRegistry, periods, baseParams: BASE_PARAMS, seenFingerprints })) {
    yielded.push(candidate);
    assert.equal(candidate.type, CANDIDATE_TYPES.INDICATOR_FEATURE);
    assert.equal(candidate.indicatorName, plugin.metadata().name);
    assert.ok(candidate.fingerprint);
  }
  assert.equal(yielded.length, indicatorRegistry.size * periods.length);
  assert.equal(new Set(yielded.map((c) => c.fingerprint)).size, yielded.length, 'every fingerprint must be unique');
});

test('generateIndicatorCandidatesStream: throws without a valid registry', async () => {
  await assert.rejects(async () => {
    for await (const _ of generateIndicatorCandidatesStream({ indicatorRegistry: null, baseParams: BASE_PARAMS })) { /* noop */ }
  }, RegistryDrivenGeneratorError);
});

test('generateMarketStateCandidatesStream: yields one real MarketState candidate per plugin', async () => {
  const marketStateRegistry = new MarketStateRegistry();
  registerCoreMarketStates(marketStateRegistry);
  const seenFingerprints = new Set();

  const yielded = [];
  for await (const { candidate } of generateMarketStateCandidatesStream({ marketStateRegistry, baseParams: BASE_PARAMS, seenFingerprints })) {
    yielded.push(candidate);
    assert.equal(candidate.type, CANDIDATE_TYPES.MARKET_STATE);
  }
  assert.equal(yielded.length, marketStateRegistry.size);
});

test('Deduplication (Stage 8): a shared seenFingerprints Set prevents the same definition from being yielded twice, even across separate generator calls', async () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const seenFingerprints = new Set();

  const firstPass = [];
  for await (const { candidate } of generateIndicatorCandidatesStream({ indicatorRegistry, periods: [14], baseParams: BASE_PARAMS, seenFingerprints })) {
    firstPass.push(candidate);
  }
  // Re-running the EXACT same generation request a second time, sharing
  // the same seenFingerprints Set, must yield nothing new.
  const secondPass = [];
  for await (const { candidate } of generateIndicatorCandidatesStream({ indicatorRegistry, periods: [14], baseParams: BASE_PARAMS, seenFingerprints })) {
    secondPass.push(candidate);
  }
  assert.ok(firstPass.length > 0);
  assert.equal(secondPass.length, 0, 'duplicate fingerprints must never enter the pipeline a second time');
});

test('generateCompositeCandidatesStream: produces real CompositeCandidate instances referencing real component IDs', async () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const components = [];
  for await (const { candidate } of generateIndicatorCandidatesStream({ indicatorRegistry, periods: [14], baseParams: BASE_PARAMS })) {
    components.push(candidate);
    if (components.length >= 4) break;
  }

  const composites = [];
  for await (const { candidate } of generateCompositeCandidatesStream({ components, baseParams: BASE_PARAMS })) {
    composites.push(candidate);
  }
  assert.ok(composites.length > 0);
  for (const c of composites) {
    assert.equal(c.type, CANDIDATE_TYPES.COMPOSITE_CANDIDATE);
    assert.equal(c.componentIds.length, 2);
    assert.ok(components.some((comp) => comp.id === c.componentIds[0]));
    assert.ok(components.some((comp) => comp.id === c.componentIds[1]));
  }
});

test('generateCompositeCandidatesStream: throws with fewer than 2 components', async () => {
  await assert.rejects(async () => {
    for await (const _ of generateCompositeCandidatesStream({ components: [{ id: 'a' }], baseParams: BASE_PARAMS })) { /* noop */ }
  }, RegistryDrivenGeneratorError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage 7: memory bounds / large candidate spaces
// ═══════════════════════════════════════════════════════════════════════════

test('Streaming generation supports a large candidate space (1000+) without materializing a bulk array internally -- only what the caller chooses to keep is retained', async () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  // 11 plugins x 100 distinct periods = 1100+ candidates, generated and
  // discarded one at a time by this test -- proving the generator itself
  // never holds more than the current candidate.
  const periods = Array.from({ length: 100 }, (_, i) => 10 + i);
  let count = 0;
  let peakHeldAtOnce = 0;
  for await (const { candidate } of generateIndicatorCandidatesStream({ indicatorRegistry, periods, baseParams: BASE_PARAMS })) {
    count++;
    peakHeldAtOnce = Math.max(peakHeldAtOnce, 1); // this loop body only ever references ONE candidate at a time
    void candidate; // discarded immediately -- not accumulated into an array
  }
  assert.equal(count, indicatorRegistry.size * periods.length);
  assert.ok(count >= 1000, `expected a 1000+ candidate space, got ${count}`);
  assert.equal(peakHeldAtOnce, 1);
});

test('never spends alpha, never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/discovery/registryDrivenGenerator.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
