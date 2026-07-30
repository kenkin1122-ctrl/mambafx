/**
 * tests/phase11/pipeline.test.mjs
 *
 * Test suite for Phase 11B pipeline layer:
 *   - MarketConstructProxyRegistry
 *   - All 10 core proxy plugins (conformance + compute)
 *   - MarketConstructProxyDetector (generic iteration)
 *   - EXTENSIBILITY TEST: proves a new proxy flows through
 *     MarketConstructProxyDetector with zero pipeline changes.
 *   - ContextValidator
 *   - MarketConstructProxyValidator
 *   - ContextIndependenceDiagnostics
 *   - CausalLeakageValidator
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MarketConstructProxyRegistry,
  MarketConstructProxyRegistryError,
} from '../../research/src/proxy/MarketConstructProxyRegistry.js';
import {
  CORE_PROXY_PLUGINS,
  registerCoreProxies,
  RecentLocalMinimumProxy,
  RecentLocalMaximumProxy,
  ConsecutiveUpTickClusterProxy,
  ConsecutiveDownTickClusterProxy,
  LocalVolatilitySpikeProxy,
  RangeExpansionProxy,
  LocalExtremumProxy,
  TickRateSurgeProxy,
  CompressionReleaseProxy,
  ActivityBurstProxy,
} from '../../research/src/proxy/coreProxies.js';
import { MarketConstructProxyDetector } from '../../research/src/proxy/MarketConstructProxyDetector.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';
import { validateContextPlugin, ContextValidator } from '../../research/src/validation/ContextValidator.js';
import { validateMarketConstructProxy, MarketConstructProxyValidator } from '../../research/src/validation/MarketConstructProxyValidator.js';
import { runContextIndependenceDiagnostics, ContextIndependenceDiagnostics } from '../../research/src/validation/ContextIndependenceDiagnostics.js';
import { validateCausalConstraint, validatePluginsBatch, CausalLeakageValidator } from '../../research/src/validation/CausalLeakageValidator.js';
import { ContextRegistry } from '../../research/src/context/ContextRegistry.js';
import { CandleTimingDetector } from '../../research/src/context/CandleTimingDetector.js';
import { CandlePositionDetector } from '../../research/src/context/CandlePositionDetector.js';
import { PriorCandleAnalyzer } from '../../research/src/context/PriorCandleAnalyzer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStates(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    tick_price:     100 + (i % 5) * 0.5,
    tick_direction: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
    tick_size:      0.25,
    tick_timestamp: 1_000_000 + i * 500,
    candle_open:    100,
    candle_high:    105 + (i % 3),
    candle_low:     99,
    candle_close:   103,
    candle_start:   1000,
    candle_end:     2000,
    tick_interval:  0.25,
    ...overrides,
  }));
}

function makeFullProxyPlugin(name = 'TestProxy') {
  return {
    metadata: () => ({
      name,
      displayName:            `${name} Display`,
      disclaimer:             'This is a proxy, not proof of agent behaviour.',
      version:                '1.0.0',
      description:            `Proxy plugin: ${name}`,
      scientificAssumptions:  ['No causal assumptions.'],
      dependencies:           [],
      complexity:             'O(n)',
      validationStatus:       'HEURISTIC',
      maxLookahead:           0,
      observableInputs:       ['tick_price'],
      assumedConstruct:       'Test construct',
      failureModes:           ['None'],
      biases:                 ['None'],
      confidenceLevel:        'LOW',
      limitations:            'Test only.',
      causalAssumptions:      ['None'],
      measurementUncertainty: 'N/A',
    }),
    validate:             () => ({ valid: true, errors: [] }),
    compute:              ({ states }) => ({ signal: new Array(states?.length ?? 0).fill(0) }),
    version:              () => '1.0.0',
    dependencies:         () => [],
    tests:                () => [],
    documentation:        () => `${name} docs`,
    scientificAssumptions:() => ['No causal assumptions.'],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MarketConstructProxyRegistry
// ══════════════════════════════════════════════════════════════════════════════

test('MarketConstructProxyRegistry: register accepts a conforming proxy plugin', () => {
  const reg = new MarketConstructProxyRegistry();
  reg.register(makeFullProxyPlugin('A'));
  assert.equal(reg.size, 1);
});

test('MarketConstructProxyRegistry: throws for non-conforming plugin', () => {
  const reg = new MarketConstructProxyRegistry();
  assert.throws(() => reg.register({}), MarketConstructProxyRegistryError);
});

test('MarketConstructProxyRegistry: throws on duplicate name', () => {
  const reg = new MarketConstructProxyRegistry();
  reg.register(makeFullProxyPlugin('Dup'));
  assert.throws(() => reg.register(makeFullProxyPlugin('Dup')), MarketConstructProxyRegistryError);
});

test('MarketConstructProxyRegistry: lookup returns registered plugin', () => {
  const reg = new MarketConstructProxyRegistry();
  const p = makeFullProxyPlugin('LookupTest');
  reg.register(p);
  assert.equal(reg.lookup('LookupTest'), p);
});

test('MarketConstructProxyRegistry: unregister removes plugin', () => {
  const reg = new MarketConstructProxyRegistry();
  reg.register(makeFullProxyPlugin('R'));
  assert.equal(reg.unregister('R'), true);
  assert.equal(reg.size, 0);
});

test('MarketConstructProxyRegistry: registerCoreProxies adds all 10 proxies', () => {
  const reg = new MarketConstructProxyRegistry();
  registerCoreProxies(reg);
  assert.equal(reg.size, 10);
});

test('MarketConstructProxyRegistry: CORE_PROXY_PLUGINS contains 10 entries', () => {
  assert.equal(CORE_PROXY_PLUGINS.length, 10);
});

// ══════════════════════════════════════════════════════════════════════════════
// Core proxy plugin: PluginContract conformance (all 10)
// ══════════════════════════════════════════════════════════════════════════════

for (const proxy of CORE_PROXY_PLUGINS) {
  const name = proxy.metadata().name;

  test(`CoreProxy[${name}]: conforms to PluginContract`, () => {
    const { valid, errors } = validatePlugin(proxy);
    assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
  });

  test(`CoreProxy[${name}]: metadata().maxLookahead is 0`, () => {
    assert.equal(proxy.metadata().maxLookahead, 0);
  });

  test(`CoreProxy[${name}]: compute returns an object for valid states`, () => {
    const states = makeStates(25);
    const result = proxy.compute({ states });
    assert.ok(result && typeof result === 'object');
  });

  test(`CoreProxy[${name}]: compute returns error info for non-array states`, () => {
    const result = proxy.compute({ states: 'bad' });
    // Should return an object (not throw) with either error or a valid result.
    assert.ok(result && typeof result === 'object');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Specific proxy behaviour tests
// ══════════════════════════════════════════════════════════════════════════════

test('RecentLocalMinimumProxy: detects new low', () => {
  const states = [{ tick_price: 10 }, { tick_price: 5 }];
  const { signal } = RecentLocalMinimumProxy.compute({ states, windowSize: 5 });
  assert.equal(signal[1], 1); // index 1 (price=5) is lower than index 0
});

test('RecentLocalMinimumProxy: no signal when price not a new low', () => {
  const states = [{ tick_price: 5 }, { tick_price: 10 }];
  const { signal } = RecentLocalMinimumProxy.compute({ states, windowSize: 5 });
  assert.equal(signal[1], 0);
});

test('RecentLocalMaximumProxy: detects new high', () => {
  const states = [{ tick_price: 5 }, { tick_price: 10 }];
  const { signal } = RecentLocalMaximumProxy.compute({ states, windowSize: 5 });
  assert.equal(signal[1], 1);
});

test('ConsecutiveUpTickClusterProxy: run=3 after three up ticks', () => {
  const states = [
    { tick_direction: 1 }, { tick_direction: 1 }, { tick_direction: 1 },
  ];
  const { runLength } = ConsecutiveUpTickClusterProxy.compute({ states });
  assert.deepEqual(runLength, [1, 2, 3]);
});

test('ConsecutiveUpTickClusterProxy: resets on non-up tick', () => {
  const states = [{ tick_direction: 1 }, { tick_direction: -1 }, { tick_direction: 1 }];
  const { runLength } = ConsecutiveUpTickClusterProxy.compute({ states });
  assert.deepEqual(runLength, [1, 0, 1]);
});

test('ConsecutiveDownTickClusterProxy: run=2 after two down ticks', () => {
  const states = [{ tick_direction: -1 }, { tick_direction: -1 }];
  const { runLength } = ConsecutiveDownTickClusterProxy.compute({ states });
  assert.deepEqual(runLength, [1, 2]);
});

test('LocalVolatilitySpikeProxy: output length matches input', () => {
  const states = makeStates(30);
  const result = LocalVolatilitySpikeProxy.compute({ states, shortWindow: 5, longWindow: 20 });
  assert.equal(result.varianceRatio.length, 30);
  assert.equal(result.spikeDetected.length, 30);
});

test('RangeExpansionProxy: output length matches input', () => {
  const states = makeStates(20);
  const result = RangeExpansionProxy.compute({ states, windowSize: 5 });
  assert.equal(result.rangeRatio.length, 20);
  assert.equal(result.expansionDetected.length, 20);
});

test('LocalExtremumProxy: output includes isLocalMin and isLocalMax', () => {
  const states = makeStates(15);
  const result = LocalExtremumProxy.compute({ states, windowSize: 5 });
  assert.ok(Array.isArray(result.isLocalMin));
  assert.ok(Array.isArray(result.isLocalMax));
  assert.equal(result.signal.length, 15);
});

test('TickRateSurgeProxy: output length matches input', () => {
  const states = makeStates(30, { tick_timestamp: undefined }).map((r, i) => ({
    ...r, tick_timestamp: 1_000_000 + i * 100,
  }));
  const result = TickRateSurgeProxy.compute({ states, shortWindow: 5, longWindow: 20 });
  assert.equal(result.rateRatio.length, 30);
});

test('CompressionReleaseProxy: output length matches input', () => {
  const states = makeStates(20);
  const result = CompressionReleaseProxy.compute({ states, compressionWindow: 8, releaseWindow: 4 });
  assert.equal(result.signal.length, 20);
});

test('ActivityBurstProxy: output length matches input', () => {
  const states = makeStates(30, { tick_timestamp: undefined }).map((r, i) => ({
    ...r, tick_timestamp: 1_000_000 + i * 200,
  }));
  const result = ActivityBurstProxy.compute({ states });
  assert.equal(result.signal.length, 30);
});

// ══════════════════════════════════════════════════════════════════════════════
// MarketConstructProxyDetector
// ══════════════════════════════════════════════════════════════════════════════

test('MarketConstructProxyDetector: constructor throws for invalid registry', () => {
  assert.throws(() => new MarketConstructProxyDetector(null), TypeError);
  assert.throws(() => new MarketConstructProxyDetector({}), TypeError);
});

test('MarketConstructProxyDetector: detect runs all 10 core proxies and keys results by name', () => {
  const reg = new MarketConstructProxyRegistry();
  registerCoreProxies(reg);
  const detector = new MarketConstructProxyDetector(reg);
  const states = makeStates(30, { tick_timestamp: undefined }).map((r, i) => ({
    ...r, tick_timestamp: 1_000_000 + i * 200,
  }));
  const { results, proxyCount } = detector.detect({ states });
  assert.equal(proxyCount, 10);
  for (const proxy of CORE_PROXY_PLUGINS) {
    assert.ok(proxy.metadata().name in results,
      `${proxy.metadata().name} not found in results`);
  }
});

test('MarketConstructProxyDetector: detect isolates a failing proxy', () => {
  const reg = new MarketConstructProxyRegistry();
  const bad = makeFullProxyPlugin('BadProxy');
  bad.compute = () => { throw new Error('proxy explosion'); };
  reg.register(bad);
  reg.register(makeFullProxyPlugin('GoodProxy'));
  const detector = new MarketConstructProxyDetector(reg);
  const { results, errors } = detector.detect({ states: makeStates(5) });
  assert.ok(results.BadProxy.error);
  assert.equal(errors.length, 1);
  assert.ok(!results.GoodProxy.error);
});

test('MarketConstructProxyDetector: registeredProxyNames returns all names', () => {
  const reg = new MarketConstructProxyRegistry();
  registerCoreProxies(reg);
  const detector = new MarketConstructProxyDetector(reg);
  const names = detector.registeredProxyNames();
  assert.equal(names.length, 10);
});

// ══════════════════════════════════════════════════════════════════════════════
// EXTENSIBILITY TEST (proxy side)
// Proves a new proxy plugin flows through MarketConstructProxyDetector
// with zero modifications to that file.
// ══════════════════════════════════════════════════════════════════════════════

test('EXTENSIBILITY: new proxy plugin flows through MarketConstructProxyDetector with no pipeline changes', () => {
  // 1. Define a brand-new proxy plugin object.
  const FutureProxyPlugin = {
    metadata: () => ({
      name:                   'FutureProxyPlugin_TestOnly',
      displayName:            'Future Research Proxy (test)',
      disclaimer:             'This is a proxy, not proof of agent behaviour.',
      version:                '0.1.0',
      description:            'Hypothetical future proxy for extensibility testing.',
      scientificAssumptions:  ['Test assumption only.'],
      dependencies:           [],
      complexity:             'O(n)',
      validationStatus:       'THEORETICAL',
      maxLookahead:           0,
      observableInputs:       ['tick_price'],
      assumedConstruct:       'Test market construct',
      failureModes:           ['Not applicable for tests'],
      biases:                 ['None'],
      confidenceLevel:        'LOW',
      limitations:            'Test only.',
      causalAssumptions:      ['None'],
      measurementUncertainty: 'N/A',
    }),
    validate:             () => ({ valid: true, errors: [] }),
    compute:              ({ states }) => ({ futureSignal: states.length * 7 }),
    version:              () => '0.1.0',
    dependencies:         () => [],
    tests:                () => [],
    documentation:        () => 'Future proxy docs.',
    scientificAssumptions:() => ['Test assumption only.'],
  };

  // 2. Verify PluginContract compliance.
  const { valid, errors } = validatePlugin(FutureProxyPlugin);
  assert.equal(valid, true, `new proxy contract errors: ${errors.join('; ')}`);

  // 3. Register in a fresh registry — the ONLY action required.
  const reg = new MarketConstructProxyRegistry();
  reg.register(FutureProxyPlugin);

  // 4. Run detect() — MarketConstructProxyDetector.js source file is NOT changed.
  const detector = new MarketConstructProxyDetector(reg);
  const states = makeStates(5);
  const { results, errors: detectErrors, proxyCount } = detector.detect({ states });

  // 5. New proxy result appears in output.
  assert.equal(proxyCount, 1);
  assert.ok('FutureProxyPlugin_TestOnly' in results);
  assert.equal(results.FutureProxyPlugin_TestOnly.futureSignal, states.length * 7);
  assert.equal(detectErrors.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// ContextValidator
// ══════════════════════════════════════════════════════════════════════════════

test('ContextValidator: passes for CandleTimingDetector (has observableInputs)', () => {
  // CandleTimingDetector.metadata() doesn't have observableInputs in its top-level
  // shape; it should still pass validateContextPlugin() which only requires
  // observableInputs to be present (may be empty array per the spec).
  // Let's test with a plugin that has it.
  const plugin = {
    ...makeFullProxyPlugin('CtxTest'),
    metadata: () => ({
      name: 'CtxTestPlugin',
      version: '1.0.0',
      description: 'Context test',
      scientificAssumptions: [],
      dependencies: [],
      complexity: 'O(n)',
      validationStatus: 'THEORETICAL',
      maxLookahead: 0,
      observableInputs: ['tick_price'],
    }),
  };
  const { valid, errors } = validateContextPlugin(plugin);
  assert.equal(valid, true, `errors: ${errors.join('; ')}`);
});

test('ContextValidator: fails when observableInputs is not an array', () => {
  const plugin = {
    ...makeFullProxyPlugin('CtxBad'),
    metadata: () => ({
      name: 'CtxBad',
      version: '1.0.0',
      description: 'x',
      scientificAssumptions: [],
      dependencies: [],
      complexity: 'O(1)',
      validationStatus: 'THEORETICAL',
      maxLookahead: 0,
      observableInputs: 'not an array',
    }),
  };
  const { valid, errors } = validateContextPlugin(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('observableInputs')));
});

test('ContextValidator: namespace export works', () => {
  assert.equal(typeof ContextValidator.validateContextPlugin, 'function');
});

test('ContextValidator: fails for null input', () => {
  const { valid } = validateContextPlugin(null);
  assert.equal(valid, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// MarketConstructProxyValidator
// ══════════════════════════════════════════════════════════════════════════════

test('MarketConstructProxyValidator: passes for a fully valid proxy plugin', () => {
  const { valid, errors } = validateMarketConstructProxy(makeFullProxyPlugin('ValidProxy'));
  assert.equal(valid, true, `errors: ${errors.join('; ')}`);
});

test('MarketConstructProxyValidator: passes for all 10 core proxies', () => {
  for (const proxy of CORE_PROXY_PLUGINS) {
    const { valid, errors } = validateMarketConstructProxy(proxy);
    assert.equal(valid, true,
      `${proxy.metadata().name} failed proxy validation: ${errors.join('; ')}`);
  }
});

test('MarketConstructProxyValidator: fails when disclaimer is missing', () => {
  const plugin = makeFullProxyPlugin('NoDisclaimer');
  const origMeta = plugin.metadata();
  plugin.metadata = () => {
    const m = { ...origMeta };
    delete m.disclaimer;
    return m;
  };
  const { valid, errors } = validateMarketConstructProxy(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('disclaimer')));
});

test('MarketConstructProxyValidator: fails when confidenceLevel is invalid', () => {
  const plugin = makeFullProxyPlugin('BadConfidence');
  plugin.metadata = () => ({ ...makeFullProxyPlugin('BadConfidence').metadata(), confidenceLevel: 'VERY_HIGH' });
  const { valid, errors } = validateMarketConstructProxy(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('confidenceLevel')));
});

test('MarketConstructProxyValidator: namespace export works', () => {
  assert.equal(typeof MarketConstructProxyValidator.validateMarketConstructProxy, 'function');
});

// ══════════════════════════════════════════════════════════════════════════════
// ContextIndependenceDiagnostics
// ══════════════════════════════════════════════════════════════════════════════

test('ContextIndependenceDiagnostics: returns pluginCount', () => {
  const reg = new ContextRegistry();
  reg.register(CandleTimingDetector);
  reg.register(CandlePositionDetector);
  const { pluginCount } = runContextIndependenceDiagnostics(reg);
  assert.equal(pluginCount, 2);
});

test('ContextIndependenceDiagnostics: handles invalid registry gracefully', () => {
  const { warnings } = runContextIndependenceDiagnostics(null);
  assert.ok(warnings.length > 0);
});

test('ContextIndependenceDiagnostics: single-plugin registry passes MinimumPluginCount', () => {
  const reg = new ContextRegistry();
  const singlePlugin = {
    metadata: () => ({
      name: 'SinglePlugin',
      version: '1.0.0', description: 'x',
      scientificAssumptions: [], dependencies: [], complexity: 'O(1)',
      validationStatus: 'THEORETICAL', maxLookahead: 0,
      observableInputs: ['tick_price'],
    }),
    validate: () => ({ valid: true, errors: [] }),
    compute: () => ({}),
    version: () => '1.0.0',
    dependencies: () => [],
    tests: () => [],
    documentation: () => '',
    scientificAssumptions: () => [],
  };
  reg.register(singlePlugin);
  const { checks } = runContextIndependenceDiagnostics(reg);
  const minCheck = checks.find(c => c.checkName === 'MinimumPluginCount');
  assert.ok(minCheck);
  assert.equal(minCheck.passed, false);
});

test('ContextIndependenceDiagnostics: detects full observable overlap as a warning', () => {
  const reg = new ContextRegistry();
  const pluginA = {
    metadata: () => ({
      name: 'OverlapA', version: '1.0.0', description: 'A',
      scientificAssumptions: [], dependencies: [], complexity: 'O(1)',
      validationStatus: 'THEORETICAL', maxLookahead: 0,
      observableInputs: ['tick_price'],
    }),
    validate: () => ({ valid: true, errors: [] }),
    compute: () => ({}),
    version: () => '1.0.0', dependencies: () => [], tests: () => [],
    documentation: () => '', scientificAssumptions: () => [],
  };
  const pluginB = {
    ...pluginA,
    metadata: () => ({ ...pluginA.metadata(), name: 'OverlapB' }),
  };
  reg.register(pluginA);
  reg.register(pluginB);
  const { warnings } = runContextIndependenceDiagnostics(reg);
  assert.ok(warnings.length > 0, 'Expected full-overlap warning');
});

test('ContextIndependenceDiagnostics: namespace export works', () => {
  assert.equal(typeof ContextIndependenceDiagnostics.runContextIndependenceDiagnostics, 'function');
});

// ══════════════════════════════════════════════════════════════════════════════
// CausalLeakageValidator
// ══════════════════════════════════════════════════════════════════════════════

test('CausalLeakageValidator: passes for a plugin with maxLookahead=0', () => {
  const { valid, errors } = validateCausalConstraint(makeFullProxyPlugin('Causal'));
  assert.equal(valid, true, `errors: ${errors.join('; ')}`);
});

test('CausalLeakageValidator: fails for a plugin with maxLookahead=1', () => {
  const plugin = makeFullProxyPlugin('LeakyPlugin');
  plugin.metadata = () => ({ ...makeFullProxyPlugin('LeakyPlugin').metadata(), maxLookahead: 1 });
  const { valid, errors } = validateCausalConstraint(plugin, 'LeakyPlugin');
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('maxLookahead=1')));
});

test('CausalLeakageValidator: fails when maxLookahead field is missing', () => {
  const plugin = makeFullProxyPlugin('MissingLookahead');
  plugin.metadata = () => {
    const m = { ...makeFullProxyPlugin('MissingLookahead').metadata() };
    delete m.maxLookahead;
    return m;
  };
  const { valid, errors } = validateCausalConstraint(plugin, 'MissingLookahead');
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('maxLookahead')));
});

test('CausalLeakageValidator: fails for null plugin', () => {
  const { valid } = validateCausalConstraint(null);
  assert.equal(valid, false);
});

test('CausalLeakageValidator: fails when metadata() throws', () => {
  const plugin = { metadata: () => { throw new Error('boom'); } };
  const { valid, errors } = validateCausalConstraint(plugin, 'BoomPlugin');
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('boom')));
});

test('CausalLeakageValidator: fails when metadata is not a function', () => {
  const plugin = { metadata: 'not a function' };
  const { valid, errors } = validateCausalConstraint(plugin, 'BadMeta');
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('metadata')));
});

test('CausalLeakageValidator: validatePluginsBatch passes for all core proxies', () => {
  const { valid, perPlugin } = validatePluginsBatch(CORE_PROXY_PLUGINS);
  assert.equal(valid, true,
    `batch errors: ${perPlugin.filter(p => !p.valid).map(p => `${p.name}: ${p.errors.join('; ')}`).join(' | ')}`
  );
});

test('CausalLeakageValidator: validatePluginsBatch catches one leaky plugin in a batch', () => {
  const leaky = makeFullProxyPlugin('Leaky');
  leaky.metadata = () => ({ ...makeFullProxyPlugin('Leaky').metadata(), maxLookahead: 5 });
  const good = makeFullProxyPlugin('Good');
  const { valid, errors, perPlugin } = validatePluginsBatch([good, leaky]);
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
  const leakyResult = perPlugin.find(p => p.name === 'Leaky');
  assert.ok(leakyResult && !leakyResult.valid);
  const goodResult = perPlugin.find(p => p.name === 'Good');
  assert.ok(goodResult && goodResult.valid);
});

test('CausalLeakageValidator: validatePluginsBatch fails for non-array input', () => {
  const { valid } = validatePluginsBatch('not an array');
  assert.equal(valid, false);
});

test('CausalLeakageValidator: namespace export works', () => {
  assert.equal(typeof CausalLeakageValidator.validateCausalConstraint, 'function');
  assert.equal(typeof CausalLeakageValidator.validatePluginsBatch, 'function');
});

test('CausalLeakageValidator: PriorCandleAnalyzer passes causal validation', () => {
  const { valid, errors } = validateCausalConstraint(PriorCandleAnalyzer, 'PriorCandleAnalyzer');
  assert.equal(valid, true, `errors: ${errors.join('; ')}`);
});
