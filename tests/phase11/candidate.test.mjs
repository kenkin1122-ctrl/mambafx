/**
 * tests/phase11/candidate.test.mjs
 *
 * Unit tests for Phase 11 candidate layer:
 *   - candidate/MeasurementRegistry.js
 *   - candidate/DatasetManifest.js
 *   - candidate/Candidate.js (abstract — tested via subclasses)
 *   - candidate/IndicatorFeature.js
 *   - candidate/MarketState.js
 *   - candidate/CompositeCandidate.js
 *   - candidate/ConditionalHypothesis.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIMITIVE_OBSERVABLES,
  MeasurementRegistry,
  MeasurementRegistryError,
} from '../../research/src/candidate/MeasurementRegistry.js';
import {
  DatasetManifest,
  InvalidDatasetManifestError,
  DUPLICATE_POLICIES,
  REPAIR_POLICIES,
} from '../../research/src/candidate/DatasetManifest.js';
import {
  Candidate,
  CandidateValidationError,
  CANDIDATE_TYPES,
} from '../../research/src/candidate/Candidate.js';
import {
  IndicatorFeature,
  INDICATOR_INPUT_FIELDS,
} from '../../research/src/candidate/IndicatorFeature.js';
import { MarketState } from '../../research/src/candidate/MarketState.js';
import {
  CompositeCandidate,
  COMBINATORS,
} from '../../research/src/candidate/CompositeCandidate.js';
import {
  ConditionalHypothesis,
  MAX_CONTEXT_CONDITIONS,
  CONDITION_COMBINATORS,
} from '../../research/src/candidate/ConditionalHypothesis.js';

// ── shared helpers ──────────────────────────────────────────────────────────

const BASE_FIELDS = {
  id: 'cand-001',
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-001',
};

// ═══════════════════════════════════════════════════════════════════════════
// MeasurementRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('MeasurementRegistry: all PRIMITIVE_OBSERVABLES are pre-registered', () => {
  const reg = new MeasurementRegistry();
  for (const name of Object.values(PRIMITIVE_OBSERVABLES)) {
    assert.equal(reg.isRegistered(name), true, `${name} should be pre-registered`);
    assert.equal(reg.isPrimitive(name), true, `${name} should be a primitive`);
  }
});

test('MeasurementRegistry.listPrimitives: returns all 11 primitive observable names', () => {
  const reg = new MeasurementRegistry();
  const prims = reg.listPrimitives();
  assert.equal(prims.length, Object.keys(PRIMITIVE_OBSERVABLES).length);
});

test('MeasurementRegistry.register: derived observable becomes registered but not primitive', () => {
  const reg = new MeasurementRegistry();
  reg.register('close_sma_14', 'Simple moving average of close, period 14', [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE]);
  assert.equal(reg.isRegistered('close_sma_14'), true);
  assert.equal(reg.isPrimitive('close_sma_14'), false);
});

test('MeasurementRegistry.register: throws on unregistered dependency', () => {
  const reg = new MeasurementRegistry();
  assert.throws(
    () => reg.register('derived_x', 'desc', ['nonexistent_dep']),
    MeasurementRegistryError
  );
});

test('MeasurementRegistry.register: throws on duplicate name', () => {
  const reg = new MeasurementRegistry();
  assert.throws(
    () => reg.register(PRIMITIVE_OBSERVABLES.TICK_PRICE, 'duplicate', []),
    MeasurementRegistryError
  );
});

test('MeasurementRegistry.get: returns spec object for registered observable', () => {
  const reg = new MeasurementRegistry();
  const spec = reg.get(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE);
  assert.ok(spec);
  assert.equal(spec.name, PRIMITIVE_OBSERVABLES.CANDLE_CLOSE);
  assert.equal(spec.isPrimitive, true);
  assert.deepEqual(spec.derivedFrom, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// DatasetManifest
// ═══════════════════════════════════════════════════════════════════════════

async function makeManifest(overrides = {}) {
  return DatasetManifest.create({
    datasetId: 'ds-001',
    sessionIds: ['s1', 's2', 's3'],
    duplicatePolicy: DUPLICATE_POLICIES.KEEP_FIRST,
    repairPolicy: REPAIR_POLICIES.FORWARD_FILL,
    ...overrides,
  });
}

test('DatasetManifest.create: returns frozen instance with datasetHash', async () => {
  const m = await makeManifest();
  assert.equal(typeof m.datasetHash, 'string');
  assert.equal(m.datasetHash.length, 64);
  assert.throws(() => { m.datasetId = 'changed'; }, TypeError);
});

test('DatasetManifest.create: sessionIds are sorted for determinism', async () => {
  const a = await makeManifest({ sessionIds: ['s3', 's1', 's2'] });
  const b = await makeManifest({ sessionIds: ['s1', 's2', 's3'] });
  assert.equal(a.datasetHash, b.datasetHash, 'session order should not affect hash');
  assert.deepEqual([...a.sessionIds], ['s1', 's2', 's3']);
});

test('DatasetManifest.create: throws on session in both sessionIds and excludedSessions', async () => {
  await assert.rejects(
    makeManifest({ sessionIds: ['s1', 's2'], excludedSessions: ['s2'] }),
    InvalidDatasetManifestError
  );
});

test('DatasetManifest.create: throws on invalid duplicatePolicy', async () => {
  await assert.rejects(
    makeManifest({ duplicatePolicy: 'bogus_policy' }),
    InvalidDatasetManifestError
  );
});

test('DatasetManifest.create: throws on empty sessionIds', async () => {
  await assert.rejects(
    makeManifest({ sessionIds: [] }),
    InvalidDatasetManifestError
  );
});

test('DatasetManifest.toJSON: round-trips cleanly', async () => {
  const m = await makeManifest();
  const j = m.toJSON();
  assert.equal(j.datasetId, 'ds-001');
  assert.equal(j.datasetHash, m.datasetHash);
  assert.deepEqual(j.sessionIds, ['s1', 's2', 's3']);
});

// ═══════════════════════════════════════════════════════════════════════════
// Candidate (abstract class guard)
// ═══════════════════════════════════════════════════════════════════════════

test('Candidate cannot be instantiated directly', () => {
  assert.throws(
    () => new Candidate({ ...BASE_FIELDS, type: CANDIDATE_TYPES.INDICATOR_FEATURE, fingerprint: 'x' }),
    CandidateValidationError
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// IndicatorFeature
// ═══════════════════════════════════════════════════════════════════════════

async function makeIF(overrides = {}) {
  return IndicatorFeature.create({
    ...BASE_FIELDS,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    ...overrides,
  });
}

test('IndicatorFeature.create: returns frozen instance with correct type', async () => {
  const f = await makeIF();
  assert.equal(f.type, CANDIDATE_TYPES.INDICATOR_FEATURE);
  assert.equal(f.indicatorName, 'RSI');
  assert.equal(f.period, 14);
  assert.equal(f.signalLine, null);
  assert.equal(f.inputField, INDICATOR_INPUT_FIELDS.CLOSE);
  assert.throws(() => { f.period = 0; }, TypeError);
});

test('IndicatorFeature.create: fingerprint is a 64-char hex string', async () => {
  const f = await makeIF();
  assert.equal(typeof f.fingerprint, 'string');
  assert.equal(f.fingerprint.length, 64);
  assert.match(f.fingerprint, /^[0-9a-f]+$/);
});

test('IndicatorFeature.create: same scientific identity → same fingerprint', async () => {
  const a = await makeIF({ id: 'cand-001' });
  const b = await makeIF({ id: 'cand-002' }); // different id, same scientific definition
  assert.equal(a.fingerprint, b.fingerprint, 'fingerprint should not include id');
});

test('IndicatorFeature.create: different period → different fingerprint', async () => {
  const a = await makeIF({ period: 14 });
  const b = await makeIF({ period: 20 });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('IndicatorFeature.create: throws on period < 2', async () => {
  await assert.rejects(makeIF({ period: 1 }), CandidateValidationError);
});

test('IndicatorFeature.create: throws on missing indicatorName', async () => {
  await assert.rejects(makeIF({ indicatorName: '' }), CandidateValidationError);
});

test('IndicatorFeature.create: throws on invalid inputField', async () => {
  await assert.rejects(makeIF({ inputField: 'bogus' }), CandidateValidationError);
});

test('IndicatorFeature.create: throws on invalid signalLine', async () => {
  await assert.rejects(makeIF({ signalLine: 0 }), CandidateValidationError);
});

test('IndicatorFeature.create: accepts null signalLine (no secondary line)', async () => {
  const f = await makeIF({ signalLine: null });
  assert.equal(f.signalLine, null);
});

test('IndicatorFeature.create: lifecycle defaults to Generated', async () => {
  const f = await makeIF();
  assert.equal(f.lifecycle, 'Generated');
});

test('IndicatorFeature.create: evidenceTier defaults to E0', async () => {
  const f = await makeIF();
  assert.equal(f.evidenceTier, 'E0');
});

test('IndicatorFeature.toJSON: round-trips all fields', async () => {
  const f = await makeIF({ period: 21, signalLine: 9 });
  const j = f.toJSON();
  assert.equal(j.indicatorName, 'RSI');
  assert.equal(j.period, 21);
  assert.equal(j.signalLine, 9);
  assert.equal(j.type, CANDIDATE_TYPES.INDICATOR_FEATURE);
});

// ═══════════════════════════════════════════════════════════════════════════
// MarketState
// ═══════════════════════════════════════════════════════════════════════════

async function makeMS(overrides = {}) {
  return MarketState.create({
    ...BASE_FIELDS,
    stateLabel: 'TrendingUp',
    detectionCriteria: { indicator: 'ADX', threshold: 25, direction: 'above' },
    ...overrides,
  });
}

test('MarketState.create: returns frozen instance with correct type', async () => {
  const s = await makeMS();
  assert.equal(s.type, CANDIDATE_TYPES.MARKET_STATE);
  assert.equal(s.stateLabel, 'TrendingUp');
  assert.equal(s.minimumDurationTicks, 1);
});

test('MarketState.create: custom minimumDurationTicks stored correctly', async () => {
  const s = await makeMS({ minimumDurationTicks: 5 });
  assert.equal(s.minimumDurationTicks, 5);
});

test('MarketState.create: throws on minimumDurationTicks < 1', async () => {
  await assert.rejects(makeMS({ minimumDurationTicks: 0 }), CandidateValidationError);
});

test('MarketState.create: throws on missing stateLabel', async () => {
  await assert.rejects(makeMS({ stateLabel: '' }), CandidateValidationError);
});

test('MarketState.create: throws on missing detectionCriteria', async () => {
  await assert.rejects(makeMS({ detectionCriteria: null }), CandidateValidationError);
});

test('MarketState.toJSON: round-trips detectionCriteria', async () => {
  const s = await makeMS();
  const j = s.toJSON();
  assert.deepEqual(j.detectionCriteria, { indicator: 'ADX', threshold: 25, direction: 'above' });
});

// ═══════════════════════════════════════════════════════════════════════════
// CompositeCandidate
// ═══════════════════════════════════════════════════════════════════════════

async function makeCC(overrides = {}) {
  return CompositeCandidate.create({
    ...BASE_FIELDS,
    componentIds: ['cand-a', 'cand-b'],
    combinator: COMBINATORS.CONJUNCTION,
    ...overrides,
  });
}

test('CompositeCandidate.create: returns frozen instance with correct type', async () => {
  const c = await makeCC();
  assert.equal(c.type, CANDIDATE_TYPES.COMPOSITE_CANDIDATE);
  assert.deepEqual([...c.componentIds], ['cand-a', 'cand-b']);
  assert.equal(c.combinator, COMBINATORS.CONJUNCTION);
  assert.equal(c.weights, null);
});

test('CompositeCandidate.create: throws on < 2 componentIds', async () => {
  await assert.rejects(makeCC({ componentIds: ['cand-a'] }), CandidateValidationError);
});

test('CompositeCandidate.create: throws on invalid combinator', async () => {
  await assert.rejects(makeCC({ combinator: 'nand' }), CandidateValidationError);
});

test('CompositeCandidate.create: WEIGHTED combinator requires weights summing to 1.0', async () => {
  const c = await makeCC({
    combinator: COMBINATORS.WEIGHTED,
    weights: [0.6, 0.4],
  });
  assert.deepEqual([...c.weights], [0.6, 0.4]);
});

test('CompositeCandidate.create: WEIGHTED combinator rejects weights not summing to 1.0', async () => {
  await assert.rejects(
    makeCC({ combinator: COMBINATORS.WEIGHTED, weights: [0.5, 0.3] }),
    CandidateValidationError
  );
});

test('CompositeCandidate.create: non-WEIGHTED combinator rejects explicit weights', async () => {
  await assert.rejects(
    makeCC({ combinator: COMBINATORS.CONJUNCTION, weights: [0.5, 0.5] }),
    CandidateValidationError
  );
});

test('CompositeCandidate.toJSON: round-trips componentIds and combinator', async () => {
  const c = await makeCC();
  const j = c.toJSON();
  assert.deepEqual(j.componentIds, ['cand-a', 'cand-b']);
  assert.equal(j.combinator, COMBINATORS.CONJUNCTION);
  assert.equal(j.weights, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// ConditionalHypothesis
// ═══════════════════════════════════════════════════════════════════════════

async function makeCH(overrides = {}) {
  return ConditionalHypothesis.create({
    ...BASE_FIELDS,
    contextConditions: [
      { type: 'market_state', stateLabel: 'TrendingUp' },
    ],
    baseHypothesis: { feature: 'RSI-14', threshold: 30, direction: 'below', predictedOutcome: 'rise' },
    conditionCombinator: CONDITION_COMBINATORS.ALL,
    ...overrides,
  });
}

test('ConditionalHypothesis.create: returns frozen instance with correct type', async () => {
  const h = await makeCH();
  assert.equal(h.type, CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS);
  assert.equal(h.contextConditions.length, 1);
  assert.equal(h.conditionCombinator, CONDITION_COMBINATORS.ALL);
});

test(`ConditionalHypothesis.create: enforces hard cap of ${MAX_CONTEXT_CONDITIONS} context conditions`, async () => {
  const tooMany = [
    { type: 'c1' }, { type: 'c2' }, { type: 'c3' }, { type: 'c4' }, // 4 conditions
  ];
  await assert.rejects(
    makeCH({ contextConditions: tooMany }),
    CandidateValidationError
  );
});

test('ConditionalHypothesis.create: accepts empty contextConditions (unconditional)', async () => {
  const h = await makeCH({ contextConditions: [] });
  assert.equal(h.contextConditions.length, 0);
});

test('ConditionalHypothesis.create: accepts exactly MAX_CONTEXT_CONDITIONS conditions', async () => {
  const exactly = Array.from({ length: MAX_CONTEXT_CONDITIONS }, (_, i) => ({ type: `c${i}` }));
  const h = await makeCH({ contextConditions: exactly });
  assert.equal(h.contextConditions.length, MAX_CONTEXT_CONDITIONS);
});

test('ConditionalHypothesis.create: throws on missing baseHypothesis', async () => {
  await assert.rejects(makeCH({ baseHypothesis: null }), CandidateValidationError);
});

test('ConditionalHypothesis.create: throws on invalid conditionCombinator', async () => {
  await assert.rejects(makeCH({ conditionCombinator: 'xor' }), CandidateValidationError);
});

test('ConditionalHypothesis.toJSON: round-trips all fields', async () => {
  const h = await makeCH();
  const j = h.toJSON();
  assert.equal(j.contextConditions.length, 1);
  assert.deepEqual(j.baseHypothesis, { feature: 'RSI-14', threshold: 30, direction: 'below', predictedOutcome: 'rise' });
});
