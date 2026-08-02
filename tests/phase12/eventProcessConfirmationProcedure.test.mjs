/**
 * tests/phase12/eventProcessConfirmationProcedure.test.mjs
 *
 * Tests for eventProcess/EventProcessConfirmationProcedure.js -- the
 * adapter connecting the completed Null Model Hierarchy to
 * bridge/StatisticalProcedureRegistry.js as EventProcessFeature's real,
 * callable statistical procedure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAP_LIKE_FEATURES, runEventProcessFeatureConfirmation, registerEventProcessProcedures,
  EventProcessConfirmationError, HIERARCHY_CONCLUSIONS,
} from '../../research/src/eventProcess/EventProcessConfirmationProcedure.js';
import { StatisticalProcedureRegistry, registerCorePermutationTestProcedures } from '../../research/src/bridge/StatisticalProcedureRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function trueExponentialGaps(rng, n, lambda) {
  return Array.from({ length: n }, () => -Math.log(1 - rng()) / lambda);
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP_LIKE_FEATURES scoping -- the real design decision this module resolves
// ═══════════════════════════════════════════════════════════════════════════

test('GAP_LIKE_FEATURES: exactly TimeGap and TickGap -- the only two EventFeatureRegistry plugins that emit strictly positive waiting-time values', () => {
  assert.deepEqual([...GAP_LIKE_FEATURES].sort(), ['TickGap', 'TimeGap']);
});

test('runEventProcessFeatureConfirmation: throws a clear, honest error for a non-gap-like feature (AlternatingRun) rather than silently misapplying gap-shaped statistics', () => {
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'AlternatingRun' };
  assert.throws(
    () => runEventProcessFeatureConfirmation({ candidate, gaps: [0, 1, 1, 0, 1], seed: 1 }),
    EventProcessConfirmationError
  );
});

test('runEventProcessFeatureConfirmation: throws for a wrong candidate type, or missing/empty gaps', () => {
  const rng = seededRng(1);
  const gaps = trueExponentialGaps(rng, 20, 1);
  assert.throws(() => runEventProcessFeatureConfirmation({ candidate: { type: CANDIDATE_TYPES.INDICATOR_FEATURE, featureName: 'TimeGap' }, gaps, seed: 1 }), EventProcessConfirmationError);
  assert.throws(() => runEventProcessFeatureConfirmation({ candidate: { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TimeGap' }, seed: 1 }), EventProcessConfirmationError);
  assert.throws(() => runEventProcessFeatureConfirmation({ candidate: { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TimeGap' }, gaps: [], seed: 1 }), EventProcessConfirmationError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Real end-to-end confirmation for gap-like features
// ═══════════════════════════════════════════════════════════════════════════

test('runEventProcessFeatureConfirmation: runs the real Null Model Hierarchy for a TimeGap candidate on real exponential data, correctly stopping at Stage C', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 200, 1.5);
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TimeGap' };
  const result = runEventProcessFeatureConfirmation({ candidate, gaps, seed: 42, numSimulations: 300 });
  assert.equal(result.finalStage, 'Poisson');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_POISSON);
});

test('runEventProcessFeatureConfirmation: works identically for TickGap featureName (both are valid gap-like features)', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 200, 1.5);
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TickGap' };
  const result = runEventProcessFeatureConfirmation({ candidate, gaps, seed: 42, numSimulations: 300 });
  assert.equal(result.finalStage, 'Poisson');
});

test('runEventProcessFeatureConfirmation: returns the hierarchy\'s own natural result shape, not forced into a p-value-centric report', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 150, 1);
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TimeGap' };
  const result = runEventProcessFeatureConfirmation({ candidate, gaps, seed: 1, numSimulations: 200 });
  assert.ok('stagesRun' in result && 'finalStage' in result && 'conclusion' in result && 'summary' in result);
  assert.ok(!('pValue' in result), 'must not be reshaped into the permutation-test report format');
});

// ═══════════════════════════════════════════════════════════════════════════
// Full registry integration
// ═══════════════════════════════════════════════════════════════════════════

test('registerEventProcessProcedures: registers EVENT_PROCESS_FEATURE alongside the 5 pre-Phase-12 types without disturbing them', () => {
  const registry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(registry);
  registerEventProcessProcedures(registry);
  assert.equal(registry.size, 6);
  assert.ok(registry.has(CANDIDATE_TYPES.EVENT_PROCESS_FEATURE));
  assert.ok(registry.has(CANDIDATE_TYPES.INDICATOR_FEATURE)); // unaffected
});

test('full integration: StatisticalProcedureRegistry.run() correctly dispatches a real EventProcessFeature candidate through the real Null Model Hierarchy', () => {
  const registry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(registry);
  registerEventProcessProcedures(registry);

  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 200, 1.5);
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'TimeGap' };
  const result = registry.run({ candidate, gaps, seed: 42, numSimulations: 300 });
  assert.equal(result.finalStage, 'Poisson');
});

test('full integration: an unregistered/unsupported featureName correctly throws through the FULL registry.run() call, not just the direct function call', () => {
  const registry = new StatisticalProcedureRegistry();
  registerEventProcessProcedures(registry);
  const candidate = { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE, featureName: 'AlternatingRun' };
  assert.throws(() => registry.run({ candidate, gaps: [0, 1, 1], seed: 1 }), EventProcessConfirmationError);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/eventProcess/EventProcessConfirmationProcedure.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
