/**
 * tests/phase11/governance.test.mjs
 *
 * Unit tests for Phase 11 governance layer:
 *   - governance/phase11LifecycleStates.js
 *   - governance/scientificEvidenceTiers.js
 *   - governance/implementationMaturity.js
 *   - governance/reproducibilityLevels.js  (also tests ReproducibilityGate)
 *   - governance/DecisionAuditLog.js
 *   - governance/ScientificDebtLog.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE11_LIFECYCLE_STAGES,
  PHASE11_ALLOWED_TRANSITIONS,
  transitionPhase11Stage,
  isTerminalPhase11Stage,
  isValidPhase11Stage,
  Phase11TransitionError,
} from '../../research/src/governance/phase11LifecycleStates.js';
import {
  E_TIERS,
  E_TIER_RANK,
  legacyTierToE,
  eToLegacyTier,
  eIsAtLeast,
  InvalidETierError,
  UnmappableETierError,
} from '../../research/src/governance/scientificEvidenceTiers.js';
import { EVIDENCE_TIERS } from '../../research/src/governance/evidenceStandards.js';
import {
  IMPLEMENTATION_MATURITY,
  MATURITY_RANK,
  isAtLeastMaturity,
  nextMaturityLevel,
  InvalidMaturityError,
} from '../../research/src/governance/implementationMaturity.js';
import {
  REPRODUCIBILITY_LEVELS,
  REPRODUCIBILITY_DESCRIPTIONS,
  MIN_PUBLICATION_REPRODUCIBILITY_LEVEL,
  ReproducibilityGate,
} from '../../research/src/governance/reproducibilityLevels.js';
import {
  DECISION_TYPES,
  DecisionAuditLog,
  DecisionAuditEntry,
  InvalidDecisionError,
} from '../../research/src/governance/DecisionAuditLog.js';
import {
  DEBT_TYPE,
  DEBT_STATUS,
  DEBT_PRIORITY,
  ScientificDebtLog,
  InvalidDebtError,
} from '../../research/src/governance/ScientificDebtLog.js';

// ═══════════════════════════════════════════════════════════════════════════
// phase11LifecycleStates
// ═══════════════════════════════════════════════════════════════════════════

test('PHASE11_LIFECYCLE_STAGES: contains all 7 defined stages', () => {
  const stages = Object.values(PHASE11_LIFECYCLE_STAGES);
  assert.equal(stages.length, 7);
  for (const s of ['Generated', 'Screened', 'Triaged', 'Confirmed', 'Replicated', 'Published', 'Deprecated']) {
    assert.ok(stages.includes(s), `missing stage: ${s}`);
  }
});

test('PHASE11_ALLOWED_TRANSITIONS: every stage has an entry', () => {
  for (const stage of Object.values(PHASE11_LIFECYCLE_STAGES)) {
    assert.ok(Array.isArray(PHASE11_ALLOWED_TRANSITIONS[stage]), `no transition entry for stage ${stage}`);
  }
});

test('isTerminalPhase11Stage: only Deprecated is terminal', () => {
  for (const stage of Object.values(PHASE11_LIFECYCLE_STAGES)) {
    const expected = stage === PHASE11_LIFECYCLE_STAGES.DEPRECATED;
    assert.equal(isTerminalPhase11Stage(stage), expected, `terminal check wrong for ${stage}`);
  }
});

test('isValidPhase11Stage: recognises valid stages, rejects garbage', () => {
  assert.equal(isValidPhase11Stage('Generated'), true);
  assert.equal(isValidPhase11Stage('Deprecated'), true);
  assert.equal(isValidPhase11Stage('Expired'), false);
  assert.equal(isValidPhase11Stage(''), false);
});

test('transitionPhase11Stage: allows Generated → Screened', () => {
  const to = transitionPhase11Stage('Generated', 'Screened');
  assert.equal(to, 'Screened');
});

test('transitionPhase11Stage: allows any stage → Deprecated', () => {
  for (const stage of Object.values(PHASE11_LIFECYCLE_STAGES)) {
    if (stage === PHASE11_LIFECYCLE_STAGES.DEPRECATED) continue;
    assert.doesNotThrow(() => transitionPhase11Stage(stage, 'Deprecated'));
  }
});

test('transitionPhase11Stage: rejects skipping stages (Generated → Confirmed)', () => {
  assert.throws(
    () => transitionPhase11Stage('Generated', 'Confirmed'),
    Phase11TransitionError
  );
});

test('transitionPhase11Stage: rejects backward transition (Confirmed → Screened)', () => {
  assert.throws(
    () => transitionPhase11Stage('Confirmed', 'Screened'),
    Phase11TransitionError
  );
});

test('transitionPhase11Stage: rejects any transition from terminal Deprecated', () => {
  assert.throws(
    () => transitionPhase11Stage('Deprecated', 'Generated'),
    Phase11TransitionError
  );
});

test('Phase11TransitionError: message includes from, to, and allowed list', () => {
  let err;
  try { transitionPhase11Stage('Generated', 'Published'); } catch (e) { err = e; }
  assert.ok(err instanceof Phase11TransitionError);
  assert.ok(err.message.includes('Generated'));
  assert.ok(err.message.includes('Published'));
});

// ═══════════════════════════════════════════════════════════════════════════
// scientificEvidenceTiers
// ═══════════════════════════════════════════════════════════════════════════

test('E_TIERS: contains E0–E5', () => {
  for (const t of ['E0', 'E1', 'E2', 'E3', 'E4', 'E5']) {
    assert.ok(Object.values(E_TIERS).includes(t), `missing tier ${t}`);
  }
});

test('E_TIER_RANK: E0 < E1 < E2 < E3 < E4 < E5 (monotonic)', () => {
  const tiers = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5'];
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(E_TIER_RANK[tiers[i]] > E_TIER_RANK[tiers[i - 1]], `rank not monotonic at ${tiers[i]}`);
  }
});

test('legacyTierToE: maps all 5 legacy tiers monotonically to E0–E4', () => {
  const mapping = [
    [EVIDENCE_TIERS.NONE,          E_TIERS.E0],
    [EVIDENCE_TIERS.WEAK,          E_TIERS.E1],
    [EVIDENCE_TIERS.MODERATE,      E_TIERS.E2],
    [EVIDENCE_TIERS.STRONG,        E_TIERS.E3],
    [EVIDENCE_TIERS.EXTRAORDINARY, E_TIERS.E4],
  ];
  for (const [legacy, expected] of mapping) {
    assert.equal(legacyTierToE(legacy), expected, `wrong mapping for legacy tier ${legacy}`);
  }
});

test('legacyTierToE: throws on unrecognised legacy tier', () => {
  assert.throws(() => legacyTierToE('Magic'), Error);
});

test('legacyTierToE: mapping is strictly monotonic (higher legacy → higher E rank)', () => {
  const legacyTiers = Object.values(EVIDENCE_TIERS);
  const eTiers = legacyTiers.map(t => legacyTierToE(t));
  for (let i = 1; i < eTiers.length; i++) {
    assert.ok(
      E_TIER_RANK[eTiers[i]] > E_TIER_RANK[eTiers[i - 1]],
      `mapping not monotonic at index ${i}`
    );
  }
});

test('eToLegacyTier: round-trips E0–E4 back to legacy tiers', () => {
  for (const legacy of Object.values(EVIDENCE_TIERS)) {
    const eTier = legacyTierToE(legacy);
    const back = eToLegacyTier(eTier);
    assert.equal(back, legacy, `round-trip failed for ${legacy}`);
  }
});

test('eToLegacyTier: throws UnmappableETierError for E5', () => {
  assert.throws(() => eToLegacyTier(E_TIERS.E5), UnmappableETierError);
});

test('eToLegacyTier: throws InvalidETierError for garbage', () => {
  assert.throws(() => eToLegacyTier('Z9'), InvalidETierError);
});

test('eIsAtLeast: correct comparisons', () => {
  assert.equal(eIsAtLeast(E_TIERS.E3, E_TIERS.E2), true);
  assert.equal(eIsAtLeast(E_TIERS.E0, E_TIERS.E0), true);
  assert.equal(eIsAtLeast(E_TIERS.E1, E_TIERS.E2), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// implementationMaturity
// ═══════════════════════════════════════════════════════════════════════════

test('IMPLEMENTATION_MATURITY: contains all 5 levels', () => {
  const levels = Object.values(IMPLEMENTATION_MATURITY);
  for (const l of ['Prototype', 'Experimental', 'Stable', 'Validated', 'Production']) {
    assert.ok(levels.includes(l), `missing level ${l}`);
  }
});

test('MATURITY_RANK: Prototype < Experimental < Stable < Validated < Production', () => {
  const levels = ['Prototype', 'Experimental', 'Stable', 'Validated', 'Production'];
  for (let i = 1; i < levels.length; i++) {
    assert.ok(
      MATURITY_RANK[levels[i]] > MATURITY_RANK[levels[i - 1]],
      `rank not monotonic at ${levels[i]}`
    );
  }
});

test('isAtLeastMaturity: correct comparisons', () => {
  assert.equal(isAtLeastMaturity('Stable', 'Prototype'), true);
  assert.equal(isAtLeastMaturity('Stable', 'Stable'), true);
  assert.equal(isAtLeastMaturity('Prototype', 'Stable'), false);
});

test('isAtLeastMaturity: throws InvalidMaturityError on unrecognised level', () => {
  assert.throws(() => isAtLeastMaturity('SuperAdvanced', 'Stable'), InvalidMaturityError);
});

test('nextMaturityLevel: traverses the progression correctly', () => {
  assert.equal(nextMaturityLevel('Prototype'), 'Experimental');
  assert.equal(nextMaturityLevel('Experimental'), 'Stable');
  assert.equal(nextMaturityLevel('Stable'), 'Validated');
  assert.equal(nextMaturityLevel('Validated'), 'Production');
  assert.equal(nextMaturityLevel('Production'), null); // terminal
});

// ═══════════════════════════════════════════════════════════════════════════
// ReproducibilityGate
// ═══════════════════════════════════════════════════════════════════════════

const GOOD_CONFIG = {
  configHash: 'a'.repeat(64),
  ontologyVersion: '11.0.0',
  generatorVersion: '11.0.0',
  proxyVersions: { msd: '1.0.0' },
};

const GOOD_FREEZE = {
  configHash: 'a'.repeat(64),
  ontologyVersion: '11.0.0',
  generatorVersion: '11.0.0',
  proxyVersions: { msd: '1.0.0' },
  candidateFingerprints: ['fp_test_001'],
};

const GOOD_CANDIDATE = {
  fingerprint: 'fp_test_001',
  configHash: 'a'.repeat(64),
  reproducibilityLevel: 3,
  implementationMaturity: IMPLEMENTATION_MATURITY.STABLE,
};

test('ReproducibilityGate.check: passes with all good inputs', () => {
  const result = ReproducibilityGate.check(GOOD_CANDIDATE, GOOD_CONFIG, GOOD_FREEZE);
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
});

test('ReproducibilityGate.check: fails when configHash mismatches', () => {
  const config = { ...GOOD_CONFIG, configHash: 'b'.repeat(64) };
  const result = ReproducibilityGate.check(GOOD_CANDIDATE, config, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /configHash/i.test(f)));
});

test('ReproducibilityGate.check: fails when ontologyVersion mismatches', () => {
  const config = { ...GOOD_CONFIG, ontologyVersion: '12.0.0' };
  const result = ReproducibilityGate.check(GOOD_CANDIDATE, config, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /ontologyVersion/i.test(f)));
});

test('ReproducibilityGate.check: fails when generatorVersion mismatches', () => {
  const config = { ...GOOD_CONFIG, generatorVersion: '12.0.0' };
  const result = ReproducibilityGate.check(GOOD_CANDIDATE, config, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /generatorVersion/i.test(f)));
});

test('ReproducibilityGate.check: fails when proxy version changes', () => {
  const config = { ...GOOD_CONFIG, proxyVersions: { msd: '2.0.0' } };
  const result = ReproducibilityGate.check(GOOD_CANDIDATE, config, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /proxyVersions/i.test(f)));
});

test('ReproducibilityGate.check: fails when fingerprint not in freeze', () => {
  const candidate = { ...GOOD_CANDIDATE, fingerprint: 'not_in_freeze' };
  const result = ReproducibilityGate.check(candidate, GOOD_CONFIG, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /fingerprint/i.test(f)));
});

test('ReproducibilityGate.check: fails when reproducibilityLevel < 3', () => {
  const candidate = { ...GOOD_CANDIDATE, reproducibilityLevel: 2 };
  const result = ReproducibilityGate.check(candidate, GOOD_CONFIG, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /reproducibilityLevel/i.test(f)));
});

test('ReproducibilityGate.check: fails when implementationMaturity < Stable', () => {
  const candidate = { ...GOOD_CANDIDATE, implementationMaturity: IMPLEMENTATION_MATURITY.EXPERIMENTAL };
  const result = ReproducibilityGate.check(candidate, GOOD_CONFIG, GOOD_FREEZE);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /implementationMaturity/i.test(f)));
});

test('ReproducibilityGate.check: never throws (returns failures instead)', () => {
  // Deliberately bad inputs — should return { passed: false } without throwing.
  assert.doesNotThrow(() => ReproducibilityGate.check(null, null, null));
  const result = ReproducibilityGate.check(null, null, null);
  assert.equal(result.passed, false);
});

test('ReproducibilityGate.check: checks datasetSnapshotId when freeze has one', () => {
  const freeze = { ...GOOD_FREEZE, datasetSnapshotId: 'snap-001' };
  const badResult = ReproducibilityGate.check(GOOD_CANDIDATE, GOOD_CONFIG, freeze, { currentDatasetSnapshotId: 'snap-002' });
  assert.equal(badResult.passed, false);
  assert.ok(badResult.failures.some(f => /datasetSnapshotId/i.test(f)));

  const goodResult = ReproducibilityGate.check(GOOD_CANDIDATE, GOOD_CONFIG, freeze, { currentDatasetSnapshotId: 'snap-001' });
  assert.equal(goodResult.passed, true);
});

test('MIN_PUBLICATION_REPRODUCIBILITY_LEVEL is 3', () => {
  assert.equal(MIN_PUBLICATION_REPRODUCIBILITY_LEVEL, 3);
});

test('REPRODUCIBILITY_DESCRIPTIONS: all levels 0–5 have descriptions', () => {
  for (let i = 0; i <= 5; i++) {
    assert.ok(typeof REPRODUCIBILITY_DESCRIPTIONS[i] === 'string' && REPRODUCIBILITY_DESCRIPTIONS[i].length > 0,
              `missing description for level ${i}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DecisionAuditLog
// ═══════════════════════════════════════════════════════════════════════════

test('DecisionAuditLog.append: records a valid entry', () => {
  const log = new DecisionAuditLog();
  const entry = log.append({
    candidateId: 'cand-001',
    decisionType: DECISION_TYPES.GENERATED,
    reason: 'Created by generator round 1',
  });
  assert.ok(entry instanceof DecisionAuditEntry);
  assert.equal(entry.candidateId, 'cand-001');
  assert.equal(entry.decisionType, DECISION_TYPES.GENERATED);
  assert.equal(entry.actor, 'system');
  assert.equal(log.size, 1);
});

test('DecisionAuditLog.append: throws on invalid decisionType', () => {
  const log = new DecisionAuditLog();
  assert.throws(() => log.append({ candidateId: 'c1', decisionType: 'INVENTED', reason: 'x' }), InvalidDecisionError);
});

test('DecisionAuditLog.append: throws on missing reason', () => {
  const log = new DecisionAuditLog();
  assert.throws(() => log.append({ candidateId: 'c1', decisionType: DECISION_TYPES.GENERATED, reason: '' }), InvalidDecisionError);
});

test('DecisionAuditLog.forCandidate: returns only entries for that candidate', () => {
  const log = new DecisionAuditLog();
  log.append({ candidateId: 'c1', decisionType: DECISION_TYPES.GENERATED, reason: 'r1' });
  log.append({ candidateId: 'c2', decisionType: DECISION_TYPES.GENERATED, reason: 'r2' });
  log.append({ candidateId: 'c1', decisionType: DECISION_TYPES.SCREENED_PROMOTED, reason: 'r3' });

  const c1Entries = log.forCandidate('c1');
  assert.equal(c1Entries.length, 2);
  assert.ok(c1Entries.every(e => e.candidateId === 'c1'));
});

test('DecisionAuditLog.toArray: returns plain objects', () => {
  const log = new DecisionAuditLog();
  log.append({ candidateId: 'c1', decisionType: DECISION_TYPES.PUBLISHED, reason: 'pub' });
  const arr = log.toArray();
  assert.equal(Array.isArray(arr), true);
  assert.equal(arr[0].candidateId, 'c1');
  assert.equal(typeof arr[0].timestamp, 'number');
});

test('DecisionAuditLog: entries are frozen (immutable)', () => {
  const log = new DecisionAuditLog();
  const entry = log.append({ candidateId: 'c1', decisionType: DECISION_TYPES.DEPRECATED, reason: 'done' });
  assert.throws(() => { entry.reason = 'mutated'; }, TypeError);
});

test('DECISION_TYPES: contains all 11 defined types', () => {
  const expectedTypes = [
    'GENERATED', 'SCREENED_PROMOTED', 'SCREENED_REJECTED', 'TRIAGED_PROMOTED',
    'TRIAGED_REJECTED', 'CONFIRMED', 'CONFIRMED_REJECTED', 'REPLICATED',
    'REPLICATION_FAILED', 'PUBLISHED', 'DEPRECATED',
  ];
  for (const t of expectedTypes) {
    assert.ok(Object.values(DECISION_TYPES).includes(t), `missing DECISION_TYPE: ${t}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ScientificDebtLog
// ═══════════════════════════════════════════════════════════════════════════

test('ScientificDebtLog.create: creates and returns a debt item', () => {
  const log = new ScientificDebtLog();
  const item = log.create({
    id: 'debt-001',
    type: DEBT_TYPE.STALE_HYPOTHESIS,
    description: 'Candidate stuck in Confirmed for > 30 days',
    priority: DEBT_PRIORITY.HIGH,
  });
  assert.equal(item.id, 'debt-001');
  assert.equal(item.status, DEBT_STATUS.OPEN);
  assert.equal(item.type, DEBT_TYPE.STALE_HYPOTHESIS);
  assert.equal(log.size, 1);
});

test('ScientificDebtLog.create: throws on invalid type', () => {
  const log = new ScientificDebtLog();
  assert.throws(() => log.create({ id: 'd1', type: 'INVENTED_DEBT', description: 'x', priority: DEBT_PRIORITY.LOW }),
    InvalidDebtError);
});

test('ScientificDebtLog.create: throws on duplicate id', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'd1', type: DEBT_TYPE.CAUSAL_LEAKAGE_RISK, description: 'x', priority: DEBT_PRIORITY.CRITICAL });
  assert.throws(() => log.create({ id: 'd1', type: DEBT_TYPE.CAUSAL_LEAKAGE_RISK, description: 'y', priority: DEBT_PRIORITY.LOW }),
    InvalidDebtError);
});

test('ScientificDebtLog.updateStatus: promotes to IN_PROGRESS', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'd2', type: DEBT_TYPE.MISSING_DIAGNOSTIC, description: 'x', priority: DEBT_PRIORITY.MEDIUM });
  const updated = log.updateStatus('d2', DEBT_STATUS.IN_PROGRESS);
  assert.equal(updated.status, DEBT_STATUS.IN_PROGRESS);
  assert.equal(log.get('d2').status, DEBT_STATUS.IN_PROGRESS);
});

test('ScientificDebtLog.updateStatus: requires resolution for RESOLVED', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'd3', type: DEBT_TYPE.VALIDATION_DEBT, description: 'x', priority: DEBT_PRIORITY.LOW });
  assert.throws(
    () => log.updateStatus('d3', DEBT_STATUS.RESOLVED),  // no resolution provided
    InvalidDebtError
  );
});

test('ScientificDebtLog.updateStatus: resolves with resolution rationale', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'd4', type: DEBT_TYPE.IMPLEMENTATION_GAP, description: 'x', priority: DEBT_PRIORITY.HIGH });
  const resolved = log.updateStatus('d4', DEBT_STATUS.RESOLVED, { resolution: 'Implemented in v2' });
  assert.equal(resolved.status, DEBT_STATUS.RESOLVED);
  assert.equal(resolved.resolution, 'Implemented in v2');
  assert.ok(typeof resolved.resolutionDate === 'number');
});

test('ScientificDebtLog.listOpen: returns only non-resolved items, sorted by priority', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'low',  type: DEBT_TYPE.PROXY_VERSION_DRIFT,  description: 'x', priority: DEBT_PRIORITY.LOW });
  log.create({ id: 'crit', type: DEBT_TYPE.CAUSAL_LEAKAGE_RISK,  description: 'x', priority: DEBT_PRIORITY.CRITICAL });
  log.create({ id: 'med',  type: DEBT_TYPE.UNDERPOWERED_STUDY,   description: 'x', priority: DEBT_PRIORITY.MEDIUM });
  log.updateStatus('low', DEBT_STATUS.RESOLVED, { resolution: 'fixed' });

  const open = log.listOpen();
  assert.equal(open.length, 2);
  assert.equal(open[0].id, 'crit', 'CRITICAL should come first');
  assert.equal(open[1].id, 'med');
});

test('ScientificDebtLog.toArray: returns plain objects', () => {
  const log = new ScientificDebtLog();
  log.create({ id: 'x', type: DEBT_TYPE.STALE_HYPOTHESIS, description: 'y', priority: DEBT_PRIORITY.LOW });
  const arr = log.toArray();
  assert.equal(arr[0].id, 'x');
  assert.equal(typeof arr[0].dateCreated, 'number');
});

test('ScientificDebtItem: is immutable', () => {
  const log = new ScientificDebtLog();
  const item = log.create({ id: 'y', type: DEBT_TYPE.MISSING_REPLICATION, description: 'x', priority: DEBT_PRIORITY.HIGH });
  assert.throws(() => { item.status = 'mutated'; }, TypeError);
});
