/**
 * tests/phase11/indicators.test.mjs
 *
 * Test suite for Phase 11B indicators layer:
 *   - MachineReadableMathematics
 *   - PluginContract (validatePlugin)
 *   - RawObservationExtractor
 *   - DerivedFeatureCalculator (all 5 factory plugins)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMathDefinition,
  validateMathDefinition,
  MachineReadableMathematicsError,
} from '../../research/src/plugin/MachineReadableMathematics.js';

import {
  validatePlugin,
  REQUIRED_METHODS,
  VALID_VALIDATION_STATUSES,
  ScientificPlugin,
  PluginContractError,
} from '../../research/src/plugin/PluginContract.js';

import {
  RawObservationExtractor,
  EXTRACTABLE_FIELDS,
} from '../../research/src/features/RawObservationExtractor.js';

import {
  createRollingVariancePlugin,
  createEntropyPlugin,
  createSlopePlugin,
  createAccelerationPlugin,
  createNormalizedCandlePositionPlugin,
  DERIVED_FEATURE_FACTORIES,
} from '../../research/src/features/DerivedFeatureCalculator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMathDef(overrides = {}) {
  return {
    humanReadable: 'Test formula: identity',
    symbolicExpression: String.raw`f(x) = x`,
    executableFormula: (x) => x,
    units: 'dimensionless',
    domain: 'x ∈ ℝ',
    range: 'ℝ',
    ...overrides,
  };
}

function makeValidPlugin(overrides = {}) {
  return {
    metadata: () => ({
      name: 'TestPlugin',
      version: '1.0.0',
      description: 'A test plugin',
      scientificAssumptions: ['None'],
      dependencies: [],
      complexity: 'O(1)',
      validationStatus: 'THEORETICAL',
      maxLookahead: 0,
    }),
    validate: () => ({ valid: true, errors: [] }),
    compute: () => ({}),
    version: () => '1.0.0',
    dependencies: () => [],
    tests: () => [],
    documentation: () => 'Test plugin docs',
    scientificAssumptions: () => ['None'],
    ...overrides,
  };
}

function makeStates(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    tick_price:     100 + i,
    tick_direction: i % 2 === 0 ? 1 : -1,
    tick_size:      0.25,
    tick_timestamp: 1_000_000 + i * 1000,
    candle_open:    100,
    candle_high:    110,
    candle_low:     99,
    candle_close:   105,
    candle_start:   1000,
    candle_end:     2000,
    tick_interval:  0.25,
    ...overrides,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// MachineReadableMathematics
// ══════════════════════════════════════════════════════════════════════════════

test('MachineReadableMathematics: createMathDefinition returns frozen object', () => {
  const def = createMathDefinition(makeMathDef());
  assert.ok(Object.isFrozen(def));
});

test('MachineReadableMathematics: createMathDefinition preserves all 6 fields', () => {
  const raw = makeMathDef();
  const def = createMathDefinition(raw);
  assert.equal(def.humanReadable, raw.humanReadable);
  assert.equal(def.symbolicExpression, raw.symbolicExpression);
  assert.equal(typeof def.executableFormula, 'function');
  assert.equal(def.units, raw.units);
  assert.equal(def.domain, raw.domain);
  assert.equal(def.range, raw.range);
});

test('MachineReadableMathematics: executableFormula is callable after freeze', () => {
  const def = createMathDefinition(makeMathDef());
  assert.equal(def.executableFormula(42), 42);
});

test('MachineReadableMathematics: throws on missing humanReadable', () => {
  assert.throws(
    () => createMathDefinition(makeMathDef({ humanReadable: '' })),
    MachineReadableMathematicsError
  );
});

test('MachineReadableMathematics: throws on missing symbolicExpression', () => {
  assert.throws(
    () => createMathDefinition(makeMathDef({ symbolicExpression: null })),
    MachineReadableMathematicsError
  );
});

test('MachineReadableMathematics: throws on non-function executableFormula', () => {
  assert.throws(
    () => createMathDefinition(makeMathDef({ executableFormula: 'not a function' })),
    MachineReadableMathematicsError
  );
});

test('MachineReadableMathematics: validateMathDefinition returns { valid, errors }', () => {
  const result = validateMathDefinition(makeMathDef());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('MachineReadableMathematics: validateMathDefinition returns errors for null input', () => {
  const result = validateMathDefinition(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('MachineReadableMathematics: validateMathDefinition lists all missing fields', () => {
  const result = validateMathDefinition({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 5);
});

// ══════════════════════════════════════════════════════════════════════════════
// PluginContract
// ══════════════════════════════════════════════════════════════════════════════

test('PluginContract: REQUIRED_METHODS contains all 8 method names', () => {
  assert.equal(REQUIRED_METHODS.length, 8);
  assert.ok(REQUIRED_METHODS.includes('metadata'));
  assert.ok(REQUIRED_METHODS.includes('compute'));
  assert.ok(REQUIRED_METHODS.includes('validate'));
  assert.ok(REQUIRED_METHODS.includes('tests'));
});

test('PluginContract: VALID_VALIDATION_STATUSES includes THEORETICAL and REPLICATED', () => {
  assert.ok(VALID_VALIDATION_STATUSES.includes('THEORETICAL'));
  assert.ok(VALID_VALIDATION_STATUSES.includes('REPLICATED'));
});

test('PluginContract: validatePlugin passes for fully conforming plugin', () => {
  const { valid, errors } = validatePlugin(makeValidPlugin());
  assert.equal(valid, true, `unexpected errors: ${errors.join('; ')}`);
});

test('PluginContract: validatePlugin fails for null', () => {
  const { valid } = validatePlugin(null);
  assert.equal(valid, false);
});

test('PluginContract: validatePlugin reports missing methods', () => {
  const plugin = makeValidPlugin();
  delete plugin.compute;
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('compute')));
});

test('PluginContract: validatePlugin fails when maxLookahead is not 0', () => {
  const plugin = makeValidPlugin();
  plugin.metadata = () => ({ ...makeValidPlugin().metadata(), maxLookahead: 1 });
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('maxLookahead')));
});

test('PluginContract: validatePlugin fails for invalid validationStatus', () => {
  const plugin = makeValidPlugin();
  plugin.metadata = () => ({ ...makeValidPlugin().metadata(), validationStatus: 'MADE_UP' });
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('validationStatus')));
});

test('PluginContract: validatePlugin fails when metadata() throws', () => {
  const plugin = makeValidPlugin();
  plugin.metadata = () => { throw new Error('boom'); };
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.includes('boom')));
});

test('PluginContract: ScientificPlugin base class throws PluginContractError on all methods', () => {
  const p = new ScientificPlugin();
  for (const method of ['metadata', 'validate', 'compute', 'version', 'dependencies', 'tests', 'documentation', 'scientificAssumptions']) {
    assert.throws(() => p[method](), PluginContractError, `${method} should throw`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// RawObservationExtractor
// ══════════════════════════════════════════════════════════════════════════════

test('RawObservationExtractor: conforms to PluginContract', () => {
  const { valid, errors } = validatePlugin(RawObservationExtractor);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('RawObservationExtractor: metadata().maxLookahead is 0', () => {
  assert.equal(RawObservationExtractor.metadata().maxLookahead, 0);
});

test('RawObservationExtractor: EXTRACTABLE_FIELDS has 11 entries', () => {
  assert.equal(EXTRACTABLE_FIELDS.length, 11);
});

test('RawObservationExtractor: compute extracts tick_price correctly', () => {
  const states = makeStates(3);
  const result = RawObservationExtractor.compute({ states, fields: ['tick_price'] });
  assert.deepEqual(result.tick_price, [100, 101, 102]);
});

test('RawObservationExtractor: compute coerces missing field to NaN', () => {
  const states = [{}];
  const result = RawObservationExtractor.compute({ states, fields: ['tick_price'] });
  assert.ok(Number.isNaN(result.tick_price[0]));
});

test('RawObservationExtractor: compute returns metadata.stateCount', () => {
  const states = makeStates(5);
  const result = RawObservationExtractor.compute({ states });
  assert.equal(result.metadata.stateCount, 5);
});

test('RawObservationExtractor: compute ignores unknown requested fields', () => {
  const states = makeStates(2);
  const result = RawObservationExtractor.compute({ states, fields: ['tick_price', 'NOT_REAL'] });
  assert.ok('tick_price' in result);
  assert.ok(!('NOT_REAL' in result));
});

test('RawObservationExtractor: compute extracts all 11 fields by default', () => {
  const states = makeStates(2);
  const result = RawObservationExtractor.compute({ states });
  assert.deepEqual(result.metadata.fieldsExtracted.sort(), [...EXTRACTABLE_FIELDS].sort());
});

test('RawObservationExtractor: compute handles empty states array', () => {
  const result = RawObservationExtractor.compute({ states: [], fields: ['tick_price'] });
  assert.deepEqual(result.tick_price, []);
});

test('RawObservationExtractor: compute returns error for non-array states', () => {
  const result = RawObservationExtractor.compute({ states: 'not an array' });
  assert.ok(result.error);
});

// ══════════════════════════════════════════════════════════════════════════════
// DerivedFeatureCalculator: RollingVariance
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: createRollingVariancePlugin returns a conforming plugin', () => {
  const plugin = createRollingVariancePlugin(5);
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('DerivedFeatureCalculator: RollingVariance — constant series has variance 0', () => {
  const plugin = createRollingVariancePlugin(3);
  const { variance } = plugin.compute({ values: [5, 5, 5, 5, 5], windowSize: 3 });
  assert.ok(variance.every(v => Math.abs(v) < 1e-12));
});

test('DerivedFeatureCalculator: RollingVariance — output length = input - w + 1', () => {
  const plugin = createRollingVariancePlugin(3);
  const { variance } = plugin.compute({ values: [1, 2, 3, 4, 5], windowSize: 3 });
  assert.equal(variance.length, 3); // 5 - 3 + 1
});

test('DerivedFeatureCalculator: createRollingVariancePlugin throws on windowSize < 2', () => {
  assert.throws(() => createRollingVariancePlugin(1), RangeError);
});

// ══════════════════════════════════════════════════════════════════════════════
// DerivedFeatureCalculator: Entropy
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: createEntropyPlugin returns a conforming plugin', () => {
  const plugin = createEntropyPlugin(5, 3);
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('DerivedFeatureCalculator: Entropy — constant series has entropy 0', () => {
  const plugin = createEntropyPlugin(4, 3);
  const { entropy } = plugin.compute({ values: [7, 7, 7, 7, 7], windowSize: 4, bins: 3 });
  assert.ok(entropy.every(h => Math.abs(h) < 1e-12));
});

test('DerivedFeatureCalculator: createEntropyPlugin throws on bins < 2', () => {
  assert.throws(() => createEntropyPlugin(5, 1), RangeError);
});

// ══════════════════════════════════════════════════════════════════════════════
// DerivedFeatureCalculator: Slope
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: createSlopePlugin returns a conforming plugin', () => {
  const plugin = createSlopePlugin(4);
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('DerivedFeatureCalculator: Slope — perfectly linear series has slope = step size', () => {
  const plugin = createSlopePlugin(4);
  // Series: 0, 2, 4, 6, 8  — slope should be exactly 2.
  const { slope } = plugin.compute({ values: [0, 2, 4, 6, 8], windowSize: 4 });
  assert.ok(slope.every(s => Math.abs(s - 2) < 1e-10), `slope values: ${slope}`);
});

test('DerivedFeatureCalculator: Slope — constant series has slope 0', () => {
  const plugin = createSlopePlugin(3);
  const { slope } = plugin.compute({ values: [5, 5, 5, 5], windowSize: 3 });
  assert.ok(slope.every(s => Math.abs(s) < 1e-12));
});

test('DerivedFeatureCalculator: createSlopePlugin throws on windowSize < 2', () => {
  assert.throws(() => createSlopePlugin(1), RangeError);
});

// ══════════════════════════════════════════════════════════════════════════════
// DerivedFeatureCalculator: Acceleration
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: createAccelerationPlugin returns a conforming plugin', () => {
  const plugin = createAccelerationPlugin(4);
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('DerivedFeatureCalculator: Acceleration — constant-slope series has acceleration ≈ 0', () => {
  const plugin = createAccelerationPlugin(4);
  const { acceleration } = plugin.compute({ values: [0, 1, 2, 3, 4, 5], windowSize: 4 });
  assert.ok(acceleration.every(a => Math.abs(a) < 1e-12), `accel: ${acceleration}`);
});

test('DerivedFeatureCalculator: createAccelerationPlugin throws on windowSize < 3', () => {
  assert.throws(() => createAccelerationPlugin(2), RangeError);
});

// ══════════════════════════════════════════════════════════════════════════════
// DerivedFeatureCalculator: NormalizedCandlePosition
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: createNormalizedCandlePositionPlugin returns a conforming plugin', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const { valid, errors } = validatePlugin(plugin);
  assert.equal(valid, true, `contract errors: ${errors.join('; ')}`);
});

test('DerivedFeatureCalculator: NormalizedCandlePosition — close at midpoint → 0.5', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const { normalizedPosition } = plugin.compute({
    candle_close: [105], candle_high: [110], candle_low: [100],
  });
  assert.ok(Math.abs(normalizedPosition[0] - 0.5) < 1e-12, `expected 0.5, got ${normalizedPosition[0]}`);
});

test('DerivedFeatureCalculator: NormalizedCandlePosition — close at low → 0', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const { normalizedPosition } = plugin.compute({
    candle_close: [100], candle_high: [110], candle_low: [100],
  });
  assert.ok(Math.abs(normalizedPosition[0] - 0) < 1e-12);
});

test('DerivedFeatureCalculator: NormalizedCandlePosition — close at high → 1', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const { normalizedPosition } = plugin.compute({
    candle_close: [110], candle_high: [110], candle_low: [100],
  });
  assert.ok(Math.abs(normalizedPosition[0] - 1) < 1e-12);
});

test('DerivedFeatureCalculator: NormalizedCandlePosition — zero-range candle → NaN', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const { normalizedPosition } = plugin.compute({
    candle_close: [100], candle_high: [100], candle_low: [100],
  });
  assert.ok(Number.isNaN(normalizedPosition[0]));
});

test('DerivedFeatureCalculator: NormalizedCandlePosition — returns error for non-array inputs', () => {
  const plugin = createNormalizedCandlePositionPlugin();
  const result = plugin.compute({ candle_close: 'x', candle_high: [], candle_low: [] });
  assert.ok(result.error);
});

// ══════════════════════════════════════════════════════════════════════════════
// DERIVED_FEATURE_FACTORIES map
// ══════════════════════════════════════════════════════════════════════════════

test('DerivedFeatureCalculator: DERIVED_FEATURE_FACTORIES has 5 entries', () => {
  assert.equal(Object.keys(DERIVED_FEATURE_FACTORIES).length, 5);
});

test('DerivedFeatureCalculator: all factory entries are callable', () => {
  for (const [name, fn] of Object.entries(DERIVED_FEATURE_FACTORIES)) {
    assert.equal(typeof fn, 'function', `${name} should be a function`);
  }
});
