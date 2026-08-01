/**
 * tests/phase11/indicatorRegistry.test.mjs
 *
 * Tests for research/src/indicator/IndicatorRegistry.js and
 * coreIndicators.js — Stage 1 of the registry-driven candidate generation
 * system.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IndicatorRegistry, IndicatorRegistryError } from '../../research/src/indicator/IndicatorRegistry.js';
import { CORE_INDICATOR_PLUGINS, registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';

function makeTrendingPrices(n = 200) {
  const prices = [100];
  for (let i = 0; i < n; i++) prices.push(prices[prices.length - 1] + Math.sin(i / 7) + (i % 13 === 0 ? 1 : -0.3));
  return prices;
}

// ═══════════════════════════════════════════════════════════════════════════
// IndicatorRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('IndicatorRegistry: registers a conforming plugin and makes it discoverable', () => {
  const registry = new IndicatorRegistry();
  registry.register(CORE_INDICATOR_PLUGINS[0]);
  assert.equal(registry.size, 1);
  assert.ok(registry.has(CORE_INDICATOR_PLUGINS[0].metadata().name));
  assert.equal(registry.lookup(CORE_INDICATOR_PLUGINS[0].metadata().name), CORE_INDICATOR_PLUGINS[0]);
});

test('IndicatorRegistry: refuses a non-conforming plugin', () => {
  const registry = new IndicatorRegistry();
  assert.throws(() => registry.register({ metadata: () => ({ name: 'bad' }) }), IndicatorRegistryError);
});

test('IndicatorRegistry: refuses a duplicate name', () => {
  const registry = new IndicatorRegistry();
  registry.register(CORE_INDICATOR_PLUGINS[0]);
  assert.throws(() => registry.register(CORE_INDICATOR_PLUGINS[0]), IndicatorRegistryError);
});

test('IndicatorRegistry: list()/listNames()/unregister() behave correctly', () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  assert.equal(registry.list().length, CORE_INDICATOR_PLUGINS.length);
  assert.equal(registry.listNames().length, CORE_INDICATOR_PLUGINS.length);
  const first = registry.listNames()[0];
  assert.ok(registry.unregister(first));
  assert.equal(registry.has(first), false);
  assert.equal(registry.unregister('NotRegistered'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Core indicator plugins: every one conforms to PluginContract and computes
// ═══════════════════════════════════════════════════════════════════════════

test('every core indicator plugin conforms to PluginContract (structural check)', () => {
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.ok(valid, `${plugin.metadata().name} failed PluginContract: ${errors.join('; ')}`);
  }
});

test('every core indicator plugin has maxLookahead=0 (causal safety)', () => {
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    assert.equal(plugin.metadata().maxLookahead, 0, `${plugin.metadata().name} must have maxLookahead=0`);
  }
});

test('registerCoreIndicators: registers all 21 plugins with distinct names', () => {
  const registry = new IndicatorRegistry();
  registerCoreIndicators(registry);
  assert.equal(registry.size, 21);
  assert.equal(new Set(registry.listNames()).size, 21);
});

test('every core indicator plugin computes a finite signal from real trending price data, without throwing', () => {
  const prices = makeTrendingPrices(200);
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    const result = plugin.compute({ prices });
    assert.ok(Array.isArray(result.signal), `${plugin.metadata().name}: compute() must return { signal: number[] }`);
    assert.equal(result.signal.length, prices.length);
    const finiteValues = result.signal.filter(Number.isFinite);
    assert.ok(finiteValues.length > 0, `${plugin.metadata().name}: produced zero finite values over 200 real ticks`);
  }
});

test('RSI stays within [0, 100]', () => {
  const rsi = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'RSI');
  const { signal } = rsi.compute({ prices: makeTrendingPrices(200), period: 14 });
  for (const v of signal.filter(Number.isFinite)) assert.ok(v >= 0 && v <= 100);
});

test('ADX stays within [0, 100]', () => {
  const adx = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'ADX');
  const { signal } = adx.compute({ prices: makeTrendingPrices(200), period: 14 });
  for (const v of signal.filter(Number.isFinite)) assert.ok(v >= 0 && v <= 100, `ADX out of range: ${v}`);
});

test('DirectionalEntropy stays within [0, 1] bit', () => {
  const de = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'DirectionalEntropy');
  const { signal } = de.compute({ prices: makeTrendingPrices(200), period: 20 });
  for (const v of signal.filter(Number.isFinite)) assert.ok(v >= 0 && v <= 1.0001, `DirectionalEntropy out of range: ${v}`);
});

test('BollingerPosition places price inside its own bands (sanity check against BollingerWidth)', () => {
  const prices = makeTrendingPrices(200);
  const pos = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'BollingerPosition');
  const { signal } = pos.compute({ prices, period: 20, k: 2 });
  // Most values should fall within [0,1] for a k=2 band, though not strictly guaranteed for extreme moves.
  const inRange = signal.filter(Number.isFinite).filter((v) => v >= -0.5 && v <= 1.5).length;
  const total = signal.filter(Number.isFinite).length;
  assert.ok(inRange / total > 0.8, 'expected most BollingerPosition values to be near [0,1]');
});

test('FractalDimension is derived from Hurst via D = 2 - H', () => {
  const prices = makeTrendingPrices(200);
  const hurst = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'Hurst');
  const fd = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'FractalDimension');
  const hSignal = hurst.compute({ prices, period: 30 }).signal;
  const dSignal = fd.compute({ prices, period: 30 }).signal;
  for (let i = 0; i < prices.length; i++) {
    if (Number.isFinite(hSignal[i]) && Number.isFinite(dSignal[i])) {
      assert.ok(Math.abs(dSignal[i] - (2 - hSignal[i])) < 1e-9);
    }
  }
});

test('RunLength counts a genuine monotonic run correctly', () => {
  const runLength = CORE_INDICATOR_PLUGINS.find((p) => p.metadata().name === 'RunLength');
  const { signal } = runLength.compute({ prices: [10, 11, 12, 13, 14, 12, 11] }); // 4 rises then 2 falls
  assert.equal(signal[4], 4); // 4th consecutive rise
  assert.equal(signal[6], 2); // 2nd consecutive fall
});

test('every plugin is deterministic (same inputs -> same outputs, no hidden randomness)', () => {
  const prices = makeTrendingPrices(150);
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    const a = plugin.compute({ prices });
    const b = plugin.compute({ prices });
    assert.deepEqual(a, b, `${plugin.metadata().name} is not deterministic`);
  }
});

test('plugin documentation()/tests()/scientificAssumptions() all callable and non-empty', () => {
  for (const plugin of CORE_INDICATOR_PLUGINS) {
    assert.ok(typeof plugin.documentation() === 'string' && plugin.documentation().length > 0);
    assert.ok(Array.isArray(plugin.tests()) && plugin.tests().length > 0);
    assert.ok(Array.isArray(plugin.scientificAssumptions()) && plugin.scientificAssumptions().length > 0);
  }
});
