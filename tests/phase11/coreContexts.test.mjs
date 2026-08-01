/**
 * tests/phase11/coreContexts.test.mjs
 *
 * Tests for context/coreContexts.js — Stage 3 of the "Continue
 * Implementation" directive: automatic context generation, expanded to
 * representative coverage (10 contexts total: 3 pre-existing +
 * 7 new), plus the new canonical registerCoreContexts() registration path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextRegistry, ContextRegistryError } from '../../research/src/context/ContextRegistry.js';
import {
  CORE_CONTEXT_PLUGINS, registerCoreContexts,
  VolatilityStateContext, TrendStateContext, MomentumStateContext,
  CompressionContext, ExpansionContext, RangeContext, MarketSessionContext,
} from '../../research/src/context/coreContexts.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';
import { CandlePositionDetector } from '../../research/src/context/CandlePositionDetector.js';
import { CandleTimingDetector } from '../../research/src/context/CandleTimingDetector.js';
import { PriorCandleAnalyzer } from '../../research/src/context/PriorCandleAnalyzer.js';

function makeStates(length, { rising = true } = {}) {
  return Array.from({ length }, (_, i) => ({
    tick_price: 100 + (rising ? i : -i),
    candle_high: 100 + (rising ? i : -i) + 1,
    candle_low: 100 + (rising ? i : -i) - 1,
    tick_timestamp: 1700000000 + i * 60,
  }));
}

test('registerCoreContexts: registers all 10 core context plugins (3 pre-existing + 7 new), each PluginContract-conformant', () => {
  const registry = new ContextRegistry();
  registerCoreContexts(registry);
  assert.equal(registry.size, 10);
  assert.equal(registry.size, CORE_CONTEXT_PLUGINS.length);
  for (const plugin of CORE_CONTEXT_PLUGINS) {
    const { valid, errors } = validatePlugin(plugin);
    assert.equal(valid, true, `${plugin.metadata().name}: ${errors.join('; ')}`);
    assert.equal(plugin.metadata().maxLookahead, 0);
  }
});

test('the 3 pre-existing context plugins are included, unmodified, in the new canonical registration list', () => {
  assert.ok(CORE_CONTEXT_PLUGINS.includes(CandlePositionDetector));
  assert.ok(CORE_CONTEXT_PLUGINS.includes(CandleTimingDetector));
  assert.ok(CORE_CONTEXT_PLUGINS.includes(PriorCandleAnalyzer));
});

test('registerCoreContexts: rejects duplicate registration (same underlying ContextRegistry validation as before)', () => {
  const registry = new ContextRegistry();
  registerCoreContexts(registry);
  assert.throws(() => registry.register(VolatilityStateContext), ContextRegistryError);
});

test('VolatilityStateContext: classifies a genuinely high-variance series as HIGH', () => {
  const oscillating = Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 20 : -20), tick_timestamp: 0 }));
  const result = VolatilityStateContext.compute({ states: oscillating, window: 20 });
  assert.equal(result.category[result.category.length - 1], 'HIGH');
});

test('MomentumStateContext: classifies a rising series as POSITIVE, a falling series as NEGATIVE', () => {
  const rising = MomentumStateContext.compute({ states: makeStates(15, { rising: true }), period: 5 });
  const falling = MomentumStateContext.compute({ states: makeStates(15, { rising: false }), period: 5 });
  assert.equal(rising.category[rising.category.length - 1], 'POSITIVE');
  assert.equal(falling.category[falling.category.length - 1], 'NEGATIVE');
});

test('TrendStateContext/CompressionContext/ExpansionContext/RangeContext: reuse the underlying MarketState plugin verbatim (same tests pass)', () => {
  for (const [context, statePluginName] of [
    [TrendStateContext, 'Trend'], [CompressionContext, 'Compression'], [ExpansionContext, 'Expansion'], [RangeContext, 'Range'],
  ]) {
    assert.ok(context.metadata().dependencies.includes(statePluginName), `${context.metadata().name} must declare its reuse dependency on ${statePluginName}`);
    for (const t of context.tests()) {
      const result = context.compute(t.inputs);
      assert.ok(Array.isArray(result.category), `${context.metadata().name} must return a category array`);
    }
  }
});

test('MarketSessionContext: classifies known UTC hours into the expected session bucket', () => {
  const cases = [
    { hour: 2, expected: 'ASIA' }, { hour: 10, expected: 'EUROPE' }, { hour: 17, expected: 'US' }, { hour: 23, expected: 'OFF_HOURS' },
  ];
  for (const { hour, expected } of cases) {
    const epochSeconds = Date.UTC(2024, 0, 1, hour, 0, 0) / 1000;
    const result = MarketSessionContext.compute({ states: [{ tick_timestamp: epochSeconds }] });
    assert.equal(result.category[0], expected, `hour ${hour} UTC should classify as ${expected}`);
  }
});

test('reused contexts add ZERO new detection math -- they call the existing MarketState/Indicator plugin.compute() internally, not a reimplementation', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/context/coreContexts.js', import.meta.url), 'utf8');
  assert.match(src, /statePlugin\.compute\(/, 'wrapMarketStateAsContext must call the wrapped plugin\'s own compute()');
  assert.match(src, /MomentumIndicator\.compute\(/, 'MomentumStateContext must call the existing MomentumIndicator\'s own compute()');
  assert.ok(!/function windowStats/.test(src), 'no reimplementation of coreMarketStates.js\'s windowStats helper');
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/context/coreContexts.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
});
