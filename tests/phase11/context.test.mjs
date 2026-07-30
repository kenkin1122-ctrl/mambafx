/**
 * tests/phase11/context.test.mjs
 *
 * Test suite for Phase 11B context layer:
 *   - ContextRegistry
 *   - CandleTimingDetector
 *   - CandlePositionDetector
 *   - PriorCandleAnalyzer
 *   - ObservableContextDetector (generic iteration)
 *   - EXTENSIBILITY TEST: proves a brand-new plugin flows through
 *     ObservableContextDetector with ZERO modifications to that class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ContextRegistry, ContextRegistryError } from '../../research/src/context/ContextRegistry.js';
import { CandleTimingDetector, TIMING_PHASES } from '../../research/src/context/CandleTimingDetector.js';
import { CandlePositionDetector, POSITION_ZONES } from '../../research/src/context/CandlePositionDetector.js';
import { PriorCandleAnalyzer, PRIOR_CANDLE_DIRECTIONS } from '../../research/src/context/PriorCandleAnalyzer.js';
import { ObservableContextDetector } from '../../research/src/context/ObservableContextDetector.js';
import { validatePlugin } from '../../research/src/plugin/PluginContract.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeValidPlugin(name = 'TestContextPlugin', observableInputs = ['tick_price']) {
  return {
    metadata: () => ({
      name,
      version: '1.0.0',
      description: `Context plugin: ${name}`,
      scientificAssumptions: [],
      dependencies: [],
      complexity: 'O(n)',
      validationStatus: 'THEORETICAL',
      maxLookahead: 0,
      observableInputs,
    }),
    validate: () => ({ valid: true, errors: [] }),
    compute: (inputs) => ({ pluginName: name, stateCount: inputs?.states?.length ?? 0 }),
    version: () => '1.0.0',
    dependencies: () => [],
    tests: () => [],
    documentation: () => `${name} docs`,
    scientificAssumptions: () => [],
  };
}

/** Builds an array of state records spanning two candles. */
function makeTwoCandleStates() {
  const candle1 = Array.from({ length: 3 }, (_, i) => ({
    tick_price:     100 + i,
    tick_direction: 1,
    tick_size:      0.25,
    tick_timestamp: 1_000_000 + i * 1000,
    candle_open:    100,
    candle_high:    105,
    candle_low:     99,
    candle_close:   104,
    candle_start:   1000,   // epoch seconds
    candle_end:     2000,
    tick_interval:  0.25,
  }));
  const candle2 = Array.from({ length: 3 }, (_, i) => ({
    tick_price:     104 + i,
    tick_direction: 1,
    tick_size:      0.25,
    tick_timestamp: 2_000_000 + i * 1000,
    candle_open:    104,
    candle_high:    110,
    candle_low:     103,
    candle_close:   108,
    candle_start:   2000,
    candle_end:     3000,
    tick_interval:  0.25,
  }));
  return [...candle1, ...candle2];
}

// ══════════════════════════════════════════════════════════════════════════════
// ContextRegistry
// ══════════════════════════════════════════════════════════════════════════════

test('ContextRegistry: register accepts a conforming plugin', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('A'));
  assert.equal(reg.size, 1);
});

test('ContextRegistry: register returns this for chaining', () => {
  const reg = new ContextRegistry();
  const ret = reg.register(makeValidPlugin('A'));
  assert.equal(ret, reg);
});

test('ContextRegistry: throws ContextRegistryError for non-conforming plugin', () => {
  const reg = new ContextRegistry();
  assert.throws(() => reg.register({}), ContextRegistryError);
});

test('ContextRegistry: throws on duplicate plugin name', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('Dupe'));
  assert.throws(() => reg.register(makeValidPlugin('Dupe')), ContextRegistryError);
});

test('ContextRegistry: lookup returns the registered plugin', () => {
  const reg = new ContextRegistry();
  const p = makeValidPlugin('MyPlugin');
  reg.register(p);
  assert.equal(reg.lookup('MyPlugin'), p);
});

test('ContextRegistry: lookup returns undefined for unknown name', () => {
  const reg = new ContextRegistry();
  assert.equal(reg.lookup('Ghost'), undefined);
});

test('ContextRegistry: has returns true for registered name', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('X'));
  assert.equal(reg.has('X'), true);
});

test('ContextRegistry: has returns false for unregistered name', () => {
  const reg = new ContextRegistry();
  assert.equal(reg.has('X'), false);
});

test('ContextRegistry: list returns all registered plugins', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('A'));
  reg.register(makeValidPlugin('B'));
  assert.equal(reg.list().length, 2);
});

test('ContextRegistry: listNames returns all plugin names', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('A'));
  reg.register(makeValidPlugin('B'));
  assert.deepEqual(reg.listNames().sort(), ['A', 'B']);
});

test('ContextRegistry: unregister removes a plugin and returns true', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('ToRemove'));
  const removed = reg.unregister('ToRemove');
  assert.equal(removed, true);
  assert.equal(reg.size, 0);
});

test('ContextRegistry: unregister returns false for unknown name', () => {
  const reg = new ContextRegistry();
  assert.equal(reg.unregister('Ghost'), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// CandleTimingDetector
// ══════════════════════════════════════════════════════════════════════════════

test('CandleTimingDetector: conforms to PluginContract', () => {
  const { valid, errors } = validatePlugin(CandleTimingDetector);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('CandleTimingDetector: metadata().maxLookahead is 0', () => {
  assert.equal(CandleTimingDetector.metadata().maxLookahead, 0);
});

test('CandleTimingDetector: tick at candle open → normalizedTime=0, phase=EARLY', () => {
  // tick_timestamp = 1000000ms, candle_start=1000s, candle_end=2000s → onset
  const result = CandleTimingDetector.compute({
    states: [{ tick_timestamp: 1_000_000, candle_start: 1000, candle_end: 2000 }],
  });
  assert.ok(Math.abs(result.normalizedTime[0] - 0) < 1e-9);
  assert.equal(result.phase[0], TIMING_PHASES.EARLY);
});

test('CandleTimingDetector: tick at candle midpoint → normalizedTime=0.5, phase=MID', () => {
  const result = CandleTimingDetector.compute({
    states: [{ tick_timestamp: 1_500_000, candle_start: 1000, candle_end: 2000 }],
  });
  assert.ok(Math.abs(result.normalizedTime[0] - 0.5) < 1e-9, `got ${result.normalizedTime[0]}`);
  assert.equal(result.phase[0], TIMING_PHASES.MID);
});

test('CandleTimingDetector: tick at candle close → normalizedTime=1, phase=LATE', () => {
  const result = CandleTimingDetector.compute({
    states: [{ tick_timestamp: 2_000_000, candle_start: 1000, candle_end: 2000 }],
  });
  assert.ok(Math.abs(result.normalizedTime[0] - 1) < 1e-9);
  assert.equal(result.phase[0], TIMING_PHASES.LATE);
});

test('CandleTimingDetector: degenerate candle (duration=0) → NaN, UNKNOWN', () => {
  const result = CandleTimingDetector.compute({
    states: [{ tick_timestamp: 1_000_000, candle_start: 1000, candle_end: 1000 }],
  });
  assert.ok(Number.isNaN(result.normalizedTime[0]));
  assert.equal(result.phase[0], TIMING_PHASES.UNKNOWN);
});

test('CandleTimingDetector: compute returns error for non-array states', () => {
  const result = CandleTimingDetector.compute({ states: 'bad' });
  assert.ok(result.error);
});

test('CandleTimingDetector: TIMING_PHASES has EARLY, MID, LATE, UNKNOWN', () => {
  assert.ok('EARLY' in TIMING_PHASES);
  assert.ok('MID' in TIMING_PHASES);
  assert.ok('LATE' in TIMING_PHASES);
  assert.ok('UNKNOWN' in TIMING_PHASES);
});

// ══════════════════════════════════════════════════════════════════════════════
// CandlePositionDetector
// ══════════════════════════════════════════════════════════════════════════════

test('CandlePositionDetector: conforms to PluginContract', () => {
  const { valid, errors } = validatePlugin(CandlePositionDetector);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('CandlePositionDetector: metadata().maxLookahead is 0', () => {
  assert.equal(CandlePositionDetector.metadata().maxLookahead, 0);
});

test('CandlePositionDetector: price at low → normalizedPosition=0, zone=LOWER_THIRD', () => {
  const result = CandlePositionDetector.compute({
    states: [{ tick_price: 100, candle_high: 110, candle_low: 100 }],
  });
  assert.ok(Math.abs(result.normalizedPosition[0] - 0) < 1e-12);
  assert.equal(result.zone[0], POSITION_ZONES.LOWER_THIRD);
});

test('CandlePositionDetector: price at midpoint → normalizedPosition=0.5, zone=MIDDLE_THIRD', () => {
  const result = CandlePositionDetector.compute({
    states: [{ tick_price: 105, candle_high: 110, candle_low: 100 }],
  });
  assert.ok(Math.abs(result.normalizedPosition[0] - 0.5) < 1e-12);
  assert.equal(result.zone[0], POSITION_ZONES.MIDDLE_THIRD);
});

test('CandlePositionDetector: price at high → normalizedPosition=1, zone=UPPER_THIRD', () => {
  const result = CandlePositionDetector.compute({
    states: [{ tick_price: 110, candle_high: 110, candle_low: 100 }],
  });
  assert.ok(Math.abs(result.normalizedPosition[0] - 1) < 1e-12);
  assert.equal(result.zone[0], POSITION_ZONES.UPPER_THIRD);
});

test('CandlePositionDetector: zero-range candle → NaN, UNKNOWN', () => {
  const result = CandlePositionDetector.compute({
    states: [{ tick_price: 100, candle_high: 100, candle_low: 100 }],
  });
  assert.ok(Number.isNaN(result.normalizedPosition[0]));
  assert.equal(result.zone[0], POSITION_ZONES.UNKNOWN);
});

test('CandlePositionDetector: POSITION_ZONES has all 4 values', () => {
  assert.ok('LOWER_THIRD'  in POSITION_ZONES);
  assert.ok('MIDDLE_THIRD' in POSITION_ZONES);
  assert.ok('UPPER_THIRD'  in POSITION_ZONES);
  assert.ok('UNKNOWN'      in POSITION_ZONES);
});

// ══════════════════════════════════════════════════════════════════════════════
// PriorCandleAnalyzer
// ══════════════════════════════════════════════════════════════════════════════

test('PriorCandleAnalyzer: conforms to PluginContract', () => {
  const { valid, errors } = validatePlugin(PriorCandleAnalyzer);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('PriorCandleAnalyzer: metadata().maxLookahead is 0', () => {
  assert.equal(PriorCandleAnalyzer.metadata().maxLookahead, 0);
});

test('PriorCandleAnalyzer: first candle records receive UNKNOWN direction', () => {
  const states = makeTwoCandleStates().slice(0, 3); // first candle only
  const result = PriorCandleAnalyzer.compute({ states });
  assert.ok(result.priorDirection.every(d => d === PRIOR_CANDLE_DIRECTIONS.UNKNOWN));
});

test('PriorCandleAnalyzer: second candle records receive prior candle direction', () => {
  const states = makeTwoCandleStates();
  const result = PriorCandleAnalyzer.compute({ states });
  // First candle (open=100, close=104) is BULLISH.
  const candle2Records = result.priorDirection.slice(3);
  assert.ok(candle2Records.every(d => d === PRIOR_CANDLE_DIRECTIONS.BULLISH),
    `got: ${candle2Records}`);
});

test('PriorCandleAnalyzer: priorRange equals candle_high - candle_low of prior candle', () => {
  const states = makeTwoCandleStates();
  const result = PriorCandleAnalyzer.compute({ states });
  // Prior candle (candle 1): high=105, low=99 → range=6.
  const candle2Ranges = result.priorRange.slice(3);
  assert.ok(candle2Ranges.every(r => Math.abs(r - 6) < 1e-10), `got: ${candle2Ranges}`);
});

test('PriorCandleAnalyzer: priorBodyRatio is in [0, 1] for valid candles', () => {
  const states = makeTwoCandleStates();
  const result = PriorCandleAnalyzer.compute({ states });
  const candle2Ratios = result.priorBodyRatio.slice(3);
  assert.ok(candle2Ratios.every(r => r >= 0 && r <= 1), `got: ${candle2Ratios}`);
});

test('PriorCandleAnalyzer: metadata candleCount reflects number of distinct candle_start values', () => {
  const states = makeTwoCandleStates();
  const result = PriorCandleAnalyzer.compute({ states });
  assert.equal(result.metadata.candleCount, 2);
});

test('PriorCandleAnalyzer: compute handles empty states array', () => {
  const result = PriorCandleAnalyzer.compute({ states: [] });
  assert.deepEqual(result.priorDirection, []);
  assert.equal(result.metadata.stateCount, 0);
});

test('PriorCandleAnalyzer: PRIOR_CANDLE_DIRECTIONS has BULLISH, BEARISH, DOJI, UNKNOWN', () => {
  assert.ok('BULLISH' in PRIOR_CANDLE_DIRECTIONS);
  assert.ok('BEARISH' in PRIOR_CANDLE_DIRECTIONS);
  assert.ok('DOJI'    in PRIOR_CANDLE_DIRECTIONS);
  assert.ok('UNKNOWN' in PRIOR_CANDLE_DIRECTIONS);
});

// ══════════════════════════════════════════════════════════════════════════════
// ObservableContextDetector
// ══════════════════════════════════════════════════════════════════════════════

test('ObservableContextDetector: constructor throws TypeError for invalid registry', () => {
  assert.throws(() => new ObservableContextDetector(null), TypeError);
  assert.throws(() => new ObservableContextDetector({}), TypeError);
});

test('ObservableContextDetector: detect returns results keyed by plugin name', () => {
  const reg = new ContextRegistry();
  reg.register(CandleTimingDetector);
  const detector = new ObservableContextDetector(reg);
  const states = makeTwoCandleStates();
  const { results } = detector.detect({ states });
  assert.ok('CandleTimingDetector' in results);
});

test('ObservableContextDetector: detect runs all registered plugins', () => {
  const reg = new ContextRegistry();
  reg.register(CandleTimingDetector);
  reg.register(CandlePositionDetector);
  const detector = new ObservableContextDetector(reg);
  const states = makeTwoCandleStates();
  const { results, pluginCount } = detector.detect({ states });
  assert.equal(pluginCount, 2);
  assert.ok('CandleTimingDetector'  in results);
  assert.ok('CandlePositionDetector' in results);
});

test('ObservableContextDetector: detect isolates a failing plugin (others still run)', () => {
  const reg = new ContextRegistry();
  const badPlugin = makeValidPlugin('BadPlugin');
  badPlugin.compute = () => { throw new Error('intentional failure'); };
  reg.register(badPlugin);
  reg.register(CandlePositionDetector);
  const detector = new ObservableContextDetector(reg);
  const { results, errors } = detector.detect({ states: makeTwoCandleStates() });
  assert.ok(results.BadPlugin.error);
  assert.equal(errors.length, 1);
  assert.ok('CandlePositionDetector' in results);
  assert.ok(!results.CandlePositionDetector.error);
});

test('ObservableContextDetector: registeredPluginNames returns list of plugin names', () => {
  const reg = new ContextRegistry();
  reg.register(makeValidPlugin('Alpha'));
  reg.register(makeValidPlugin('Beta', []));
  const detector = new ObservableContextDetector(reg);
  assert.deepEqual(detector.registeredPluginNames().sort(), ['Alpha', 'Beta']);
});

// ══════════════════════════════════════════════════════════════════════════════
// EXTENSIBILITY TEST
// Proves that a brand-new plugin flows through ObservableContextDetector
// with ZERO modifications to that file or any orchestration code.
// ══════════════════════════════════════════════════════════════════════════════

test('EXTENSIBILITY: new context plugin flows through ObservableContextDetector with no pipeline changes', () => {
  // 1. Define a completely new plugin object that did not exist when
  //    ObservableContextDetector.js was written.
  const FutureResearchPlugin = {
    metadata: () => ({
      name: 'FutureResearchPlugin_TestOnly',
      version: '0.1.0',
      description: 'A hypothetical future context plugin registered at test time.',
      scientificAssumptions: ['Purely for extensibility testing.'],
      dependencies: [],
      complexity: 'O(n)',
      validationStatus: 'THEORETICAL',
      maxLookahead: 0,
      observableInputs: ['tick_price', 'candle_close'],
    }),
    validate:             () => ({ valid: true, errors: [] }),
    compute:              ({ states }) => ({ customContextResult: states.length * 42 }),
    version:              () => '0.1.0',
    dependencies:         () => [],
    tests:                () => [],
    documentation:        () => 'Future plugin documentation.',
    scientificAssumptions:() => ['Purely for extensibility testing.'],
  };

  // 2. Verify it is PluginContract-conforming.
  const { valid, errors } = validatePlugin(FutureResearchPlugin);
  assert.equal(valid, true, `new plugin contract errors: ${errors.join('; ')}`);

  // 3. Register it in a fresh registry — the only action required to "add" it.
  const reg = new ContextRegistry();
  reg.register(FutureResearchPlugin);

  // 4. Run detect() — ObservableContextDetector.js source file is NOT changed.
  const detector = new ObservableContextDetector(reg);
  const states = makeTwoCandleStates();
  const { results, errors: detectErrors, pluginCount } = detector.detect({ states });

  // 5. The new plugin's results appear in the output map, keyed by its name.
  assert.equal(pluginCount, 1);
  assert.ok('FutureResearchPlugin_TestOnly' in results, 'new plugin result should be in output');
  assert.equal(results.FutureResearchPlugin_TestOnly.customContextResult, states.length * 42);
  assert.equal(detectErrors.length, 0);

  // 6. Adding a SECOND new plugin also works — still no pipeline changes.
  const AnotherFuturePlugin = {
    ...FutureResearchPlugin,
    metadata: () => ({
      ...FutureResearchPlugin.metadata(),
      name: 'AnotherFuturePlugin_TestOnly',
    }),
    compute: ({ states }) => ({ anotherResult: states.length + 99 }),
  };
  reg.register(AnotherFuturePlugin);
  const { results: results2, pluginCount: pc2 } = detector.detect({ states });
  assert.equal(pc2, 2);
  assert.ok('FutureResearchPlugin_TestOnly' in results2);
  assert.ok('AnotherFuturePlugin_TestOnly'  in results2);
  assert.equal(results2.AnotherFuturePlugin_TestOnly.anotherResult, states.length + 99);
});
