/**
 * tests/phase11/governance-phaseC.test.mjs
 *
 * Unit tests for Phase 11 Phase C governance additions:
 *   - governance/FamilyRegistry.js
 *   - governance/PromotionPolicy.js
 *   - governance/NegativeEvidenceRegistry.js
 *   - governance/CausalAssumptionRegistry.js
 *
 * These are additive to tests/phase11/governance.test.mjs (Phase A/B),
 * kept in a separate file so the existing, already-passing governance
 * suite is never touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FamilyRegistry,
  InvalidFamilyRegistrationError,
  UnregisteredFamilyError,
  IncompatibleCandidateError,
} from '../../research/src/governance/FamilyRegistry.js';
import {
  PromotionPolicy,
  InvalidPromotionInputError,
} from '../../research/src/governance/PromotionPolicy.js';
import {
  NegativeEvidenceRegistry,
  REJECTION_STAGES,
  InvalidNegativeEvidenceError,
} from '../../research/src/governance/NegativeEvidenceRegistry.js';
import {
  CausalAssumptionRegistry,
  COMPONENT_TYPES,
  InvalidCausalAssumptionError,
} from '../../research/src/governance/CausalAssumptionRegistry.js';
import { DecisionAuditLog, DECISION_TYPES } from '../../research/src/governance/DecisionAuditLog.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { IndicatorFeature, INDICATOR_INPUT_FIELDS } from '../../research/src/candidate/IndicatorFeature.js';
import { PRIMITIVE_OBSERVABLES } from '../../research/src/candidate/MeasurementRegistry.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { _resetKnownFamiliesForTesting } from '../../research/src/governance/family.js';

const BASE_FIELDS = {
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-001',
};

async function makeIF(overrides = {}) {
  return IndicatorFeature.create({
    ...BASE_FIELDS,
    id: overrides.id ?? `if-${Math.random().toString(36).slice(2)}`,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    ...overrides,
  });
}

async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-phaseC-001',
    hypothesisFamilies: ['momentum'],
    alphaAllocation: { momentum: 0.03 },
    promotionPolicies: { minRound1Score: 0.6 },
    stoppingRules: [{ maxCandidates: 500 }],
    replicationCriteria: { minReplicationBlocks: 3 },
    publicationCriteria: { minReproducibilityLevel: 3 },
    effectSizeThresholds: { default: 0.1 },
    minimumSampleSizes: { default: 200 },
    requiredDiagnostics: ['stationarity'],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FamilyRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('FamilyRegistry.registerFamily: registers and retrieves a family', () => {
  const reg = new FamilyRegistry();
  const record = reg.registerFamily({
    familyName: 'momentum',
    version: '1.0.0',
    allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE],
  });
  assert.equal(record.familyName, 'momentum');
  assert.ok(reg.isRegistered('momentum'));
  assert.equal(reg.getFamily('momentum').version, '1.0.0');
});

test('FamilyRegistry.registerFamily: throws on invalid candidate type', () => {
  const reg = new FamilyRegistry();
  assert.throws(
    () => reg.registerFamily({ familyName: 'x', version: '1.0.0', allowedCandidateTypes: ['NotAType'] }),
    InvalidFamilyRegistrationError
  );
});

test('FamilyRegistry.registerFamily: rejects re-registration at same or lower version', () => {
  const reg = new FamilyRegistry();
  reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  assert.throws(
    () => reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] }),
    InvalidFamilyRegistrationError
  );
  assert.throws(
    () => reg.registerFamily({ familyName: 'momentum', version: '0.9.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] }),
    InvalidFamilyRegistrationError
  );
});

test('FamilyRegistry.registerFamily: accepts a strictly higher version and preserves history', () => {
  const reg = new FamilyRegistry();
  reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  reg.registerFamily({ familyName: 'momentum', version: '1.1.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.MARKET_STATE] });
  assert.equal(reg.getFamily('momentum').version, '1.1.0');
  assert.equal(reg.versionHistory('momentum').length, 2);
});

test('FamilyRegistry.getFamily: throws UnregisteredFamilyError for unknown family', () => {
  const reg = new FamilyRegistry();
  assert.throws(() => reg.getFamily('ghost'), UnregisteredFamilyError);
});

test('FamilyRegistry.isCandidateCompatible: true for a matching, registered family/type', async () => {
  const reg = new FamilyRegistry();
  reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  const candidate = await makeIF();
  const result = reg.isCandidateCompatible(candidate);
  assert.equal(result.compatible, true);
  assert.deepEqual(result.reasons, []);
});

test('FamilyRegistry.isCandidateCompatible: false (not thrown) for unregistered family', async () => {
  const reg = new FamilyRegistry();
  const candidate = await makeIF({ family: 'unregistered_family' });
  const result = reg.isCandidateCompatible(candidate);
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.length > 0);
});

test('FamilyRegistry.isCandidateCompatible: false for a disallowed candidate type', async () => {
  const reg = new FamilyRegistry();
  reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.MARKET_STATE] });
  const candidate = await makeIF(); // IndicatorFeature, not MarketState
  const result = reg.isCandidateCompatible(candidate);
  assert.equal(result.compatible, false);
});

test('FamilyRegistry.routeToLegacyFamilyKey: resolves via legacy family.js for a compatible candidate', async () => {
  _resetKnownFamiliesForTesting();
  const reg = new FamilyRegistry();
  reg.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
  const candidate = await makeIF();
  const key = reg.routeToLegacyFamilyKey(candidate, {
    market: 'R_100',
    targetDefinition: { direction: 'Rise', runLength: 5 },
  });
  assert.equal(typeof key, 'string');
  assert.match(key, /^family:R_100:/);
});

test('FamilyRegistry.routeToLegacyFamilyKey: throws IncompatibleCandidateError for an incompatible candidate', async () => {
  const reg = new FamilyRegistry();
  const candidate = await makeIF({ family: 'unregistered' });
  assert.throws(
    () => reg.routeToLegacyFamilyKey(candidate, { market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 } }),
    IncompatibleCandidateError
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// PromotionPolicy
// ═══════════════════════════════════════════════════════════════════════════

test('PromotionPolicy constructor: throws without a valid, locked SAP', () => {
  assert.throws(
    () => new PromotionPolicy(null, new DecisionAuditLog(), new NegativeEvidenceRegistry()),
    InvalidPromotionInputError
  );
});

test('PromotionPolicy.evaluateScreening: promotes top-quantile candidates and rejects the rest', async () => {
  const sap = await makeSap();
  const log = new DecisionAuditLog();
  const negReg = new NegativeEvidenceRegistry();
  const policy = new PromotionPolicy(sap, log, negReg);

  const candidates = await Promise.all(
    Array.from({ length: 10 }, (_, i) => makeIF({ id: `if-${i}`, parameters: { threshold: i } }))
  );
  const scores = new Map(candidates.map((c, i) => [c.id, i])); // higher index = higher score
  const scoreFn = (c) => scores.get(c.id);

  const { promoted, rejected } = policy.evaluateScreening({ candidates, scoreFn, promotionQuantile: 0.3 });
  assert.equal(promoted.length, 3);
  assert.equal(rejected.length, 7);
  for (const c of promoted) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.SCREENED);
  for (const c of rejected) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
});

test('PromotionPolicy.evaluateScreening: writes SCREENED_PROMOTED/REJECTED decisions and negative evidence', async () => {
  const sap = await makeSap();
  const log = new DecisionAuditLog();
  const negReg = new NegativeEvidenceRegistry();
  const policy = new PromotionPolicy(sap, log, negReg);

  const candidates = await Promise.all(
    Array.from({ length: 4 }, (_, i) => makeIF({ id: `if-b-${i}` }))
  );
  const scoreFn = (c) => candidates.indexOf(c);
  policy.evaluateScreening({ candidates, scoreFn, promotionQuantile: 0.25, dataset: 'ds-1' });

  const promotedEntries = log.toArray().filter(e => e.decisionType === DECISION_TYPES.SCREENED_PROMOTED);
  const rejectedEntries = log.toArray().filter(e => e.decisionType === DECISION_TYPES.SCREENED_REJECTED);
  assert.equal(promotedEntries.length, 1);
  assert.equal(rejectedEntries.length, 3);
  assert.equal(negReg.byStage(REJECTION_STAGES.SCREENING).length, 3);
});

test('PromotionPolicy.evaluateTriage: promotes candidates meeting effect size and diagnostics', async () => {
  const sap = await makeSap({ effectSizeThresholds: { default: 0.1 }, requiredDiagnostics: ['stationarity'] });
  const log = new DecisionAuditLog();
  const negReg = new NegativeEvidenceRegistry();
  const policy = new PromotionPolicy(sap, log, negReg);

  const good = withPhase11Lifecycle(await makeIF({ id: 'good-1' }), PHASE11_LIFECYCLE_STAGES.SCREENED);
  const bad = withPhase11Lifecycle(await makeIF({ id: 'bad-1' }), PHASE11_LIFECYCLE_STAGES.SCREENED);

  const { promoted, rejected } = policy.evaluateTriage({
    candidates: [good, bad],
    diagnosticsByCandidateId: {
      'good-1': { effectSize: 0.2, diagnosticsPassed: ['stationarity'] },
      'bad-1': { effectSize: 0.01, diagnosticsPassed: [] },
    },
  });

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].id, 'good-1');
  assert.equal(promoted[0].lifecycle, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, 'bad-1');
});

test('PromotionPolicy.evaluateTriage: throws if a candidate is not in Screened stage', async () => {
  const sap = await makeSap();
  const policy = new PromotionPolicy(sap, new DecisionAuditLog(), new NegativeEvidenceRegistry());
  const candidate = await makeIF(); // still Generated
  assert.throws(
    () => policy.evaluateTriage({ candidates: [candidate], diagnosticsByCandidateId: {} }),
    InvalidPromotionInputError
  );
});

test('PromotionPolicy: never imports onlineFdr.js (module-level static check)', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/governance/PromotionPolicy.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src), 'PromotionPolicy must never import onlineFdr.js');
});

// ═══════════════════════════════════════════════════════════════════════════
// NegativeEvidenceRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('NegativeEvidenceRegistry.record: stores a full rejection record', () => {
  const reg = new NegativeEvidenceRegistry();
  const entry = reg.record({
    candidateFingerprint: 'fp-abc',
    stageRejected: REJECTION_STAGES.TRIAGE,
    reason: 'effect size too small',
    dataset: 'ds-1',
    effectSize: 0.01,
    confidenceInterval: { lower: -0.02, upper: 0.04, level: 0.95 },
    replicationStatus: 'not_attempted',
  });
  assert.equal(entry.candidateFingerprint, 'fp-abc');
  assert.equal(entry.stageRejected, REJECTION_STAGES.TRIAGE);
  assert.equal(reg.size, 1);
});

test('NegativeEvidenceRegistry.record: throws on invalid stageRejected', () => {
  const reg = new NegativeEvidenceRegistry();
  assert.throws(
    () => reg.record({ candidateFingerprint: 'fp', stageRejected: 'NOT_A_STAGE', reason: 'x' }),
    InvalidNegativeEvidenceError
  );
});

test('NegativeEvidenceRegistry: is append-only and preserves full rejection history', () => {
  const reg = new NegativeEvidenceRegistry();
  reg.record({ candidateFingerprint: 'fp-1', stageRejected: REJECTION_STAGES.SCREENING, reason: 'r1' });
  reg.record({ candidateFingerprint: 'fp-1', stageRejected: REJECTION_STAGES.TRIAGE, reason: 'r2' });
  assert.equal(reg.rejectionCount('fp-1'), 2);
  assert.equal(reg.byFingerprint('fp-1').length, 2);
});

test('NegativeEvidenceRegistry.byStage: filters correctly', () => {
  const reg = new NegativeEvidenceRegistry();
  reg.record({ candidateFingerprint: 'fp-1', stageRejected: REJECTION_STAGES.SCREENING, reason: 'r1' });
  reg.record({ candidateFingerprint: 'fp-2', stageRejected: REJECTION_STAGES.CONFIRMATION, reason: 'r2' });
  assert.equal(reg.byStage(REJECTION_STAGES.SCREENING).length, 1);
  assert.equal(reg.byStage(REJECTION_STAGES.CONFIRMATION).length, 1);
  assert.equal(reg.byStage(REJECTION_STAGES.REPLICATION).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CausalAssumptionRegistry
// ═══════════════════════════════════════════════════════════════════════════

test('CausalAssumptionRegistry.registerAssumptions: stores a declaration', () => {
  const reg = new CausalAssumptionRegistry();
  const entry = reg.registerAssumptions({
    componentId: 'ConsecutiveUpTickClusterProxy',
    componentType: COMPONENT_TYPES.PROXY,
    assumptions: ['Recent tick-direction persistence reflects order-flow imbalance, not merely PRNG autocorrelation'],
  });
  assert.equal(entry.componentId, 'ConsecutiveUpTickClusterProxy');
  assert.equal(entry.maxLookahead, 0);
  assert.ok(reg.isRegistered('ConsecutiveUpTickClusterProxy'));
});

test('CausalAssumptionRegistry.registerAssumptions: throws on empty assumptions array', () => {
  const reg = new CausalAssumptionRegistry();
  assert.throws(
    () => reg.registerAssumptions({ componentId: 'x', componentType: COMPONENT_TYPES.CONTEXT, assumptions: [] }),
    InvalidCausalAssumptionError
  );
});

test('CausalAssumptionRegistry.registerAssumptions: throws on invalid componentType', () => {
  const reg = new CausalAssumptionRegistry();
  assert.throws(
    () => reg.registerAssumptions({ componentId: 'x', componentType: 'NOT_A_TYPE', assumptions: ['a'] }),
    InvalidCausalAssumptionError
  );
});

test('CausalAssumptionRegistry.registerAssumptions: re-registration preserves version history', () => {
  const reg = new CausalAssumptionRegistry();
  reg.registerAssumptions({ componentId: 'x', componentType: COMPONENT_TYPES.DETECTOR, assumptions: ['v1 assumption'] });
  reg.registerAssumptions({ componentId: 'x', componentType: COMPONENT_TYPES.DETECTOR, assumptions: ['v2 refined assumption'] });
  assert.equal(reg.history('x').length, 2);
  assert.deepEqual(reg.get('x').assumptions, ['v2 refined assumption']);
});

test('CausalAssumptionRegistry.registerAssumptions: cross-checks maxLookahead via a supplied pluginRef', () => {
  const reg = new CausalAssumptionRegistry();
  const goodPlugin = { metadata: () => ({ maxLookahead: 0 }) };
  const badPlugin = { metadata: () => ({ maxLookahead: 3 }) };

  const goodEntry = reg.registerAssumptions({
    componentId: 'good', componentType: COMPONENT_TYPES.PROXY, assumptions: ['a'], pluginRef: goodPlugin,
  });
  assert.equal(goodEntry.causalLeakageCheck.valid, true);

  const badEntry = reg.registerAssumptions({
    componentId: 'bad', componentType: COMPONENT_TYPES.PROXY, assumptions: ['a'], pluginRef: badPlugin,
  });
  assert.equal(badEntry.causalLeakageCheck.valid, false);
  assert.ok(badEntry.causalLeakageCheck.errors.length > 0);
});

test('CausalAssumptionRegistry.listByType: filters by component type', () => {
  const reg = new CausalAssumptionRegistry();
  reg.registerAssumptions({ componentId: 'p1', componentType: COMPONENT_TYPES.PROXY, assumptions: ['a'] });
  reg.registerAssumptions({ componentId: 'c1', componentType: COMPONENT_TYPES.CONTEXT, assumptions: ['b'] });
  assert.equal(reg.listByType(COMPONENT_TYPES.PROXY).length, 1);
  assert.equal(reg.listByType(COMPONENT_TYPES.CONTEXT).length, 1);
});
