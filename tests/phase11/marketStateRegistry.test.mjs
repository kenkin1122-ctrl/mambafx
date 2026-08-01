/**
 * tests/phase11/marketStateRegistry.test.mjs
 *
 * Tests for plugin/MarketStateRegistry.js + plugin/coreMarketStates.js —
 * Stage 2 of the Registry-Driven Candidate Generation directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketStateRegistry, MarketStateRegistryError } from '../../research/src/plugin/MarketStateRegistry.js';
import { CORE_MARKET_STATE_PLUGINS, registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';

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

test('MarketStateRegistry: rejects a non-conforming plugin and duplicate names', () => {
  const registry = new MarketStateRegistry();
  assert.throws(() => registry.register({ metadata: () => ({}) }), MarketStateRegistryError);
  registerCoreMarketStates(registry);
  assert.throws(() => registry.register(CORE_MARKET_STATE_PLUGINS[0]), MarketStateRegistryError);
});

test('MarketStateRegistry: every core state plugin enforces maxLookahead=0 (structural causal constraint)', () => {
  for (const plugin of CORE_MARKET_STATE_PLUGINS) {
    assert.equal(plugin.metadata().maxLookahead, 0);
  }
});

test('Trend/Range state plugins produce sane, mutually-consistent classifications on synthetic data', () => {
  const registry = new MarketStateRegistry();
  registerCoreMarketStates(registry);
  const trend = registry.lookup('Trend');
  const range = registry.lookup('Range');

  const risingSeries = Array.from({ length: 30 }, (_, i) => ({ tick_price: 100 + i }));
  const flatSeries = Array(30).fill({ tick_price: 100 });

  const trendOnRising = trend.compute({ states: risingSeries, window: 20 });
  const rangeOnFlat = range.compute({ states: flatSeries, window: 20 });

  assert.equal(trendOnRising.signal[trendOnRising.signal.length - 1], 1);
  assert.equal(rangeOnFlat.signal[rangeOnFlat.signal.length - 1], 1);
});

test('Compression/Expansion state plugins correctly detect narrowing vs. widening volatility', () => {
  const registry = new MarketStateRegistry();
  registerCoreMarketStates(registry);
  const compression = registry.lookup('Compression');
  const expansion = registry.lookup('Expansion');

  const narrowing = [
    ...Array.from({ length: 10 }, (_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 5 : -5) })),
    ...Array(10).fill({ tick_price: 100 }),
  ];
  const widening = [
    ...Array(10).fill({ tick_price: 100 }),
    ...Array.from({ length: 10 }, (_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 10 : -10) })),
  ];

  const compressionResult = compression.compute({ states: narrowing, window: 20 });
  const expansionResult = expansion.compute({ states: widening, window: 20 });

  assert.equal(compressionResult.signal[compressionResult.signal.length - 1], 1);
  assert.equal(expansionResult.signal[expansionResult.signal.length - 1], 1);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js', async () => {
  const fs = await import('node:fs');
  for (const file of ['MarketStateRegistry.js', 'coreMarketStates.js']) {
    const src = await fs.promises.readFile(new URL(`../../research/src/plugin/${file}`, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
  }
});
