/**
 * tests/phase12/nullModelHierarchy.test.mjs
 *
 * Tests for statistics/nullModelHierarchy.js -- the advancement-gate
 * orchestrator sequencing Stages C/D/E, verified against synthetic
 * ground truth for all three termination branches, plus structural
 * verification that no stage ever runs before its predecessor's
 * advancement criterion is satisfied.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runNullModelHierarchy, HIERARCHY_CONCLUSIONS, NullModelHierarchyError } from '../../research/src/statistics/nullModelHierarchy.js';
import * as renewalProcessTests from '../../research/src/statistics/renewalProcessTests.js';

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
function trueExponentialSample(rng, n, lambda) {
  return Array.from({ length: n }, () => -Math.log(1 - rng()) / lambda);
}

// ═══════════════════════════════════════════════════════════════════════════
// Precondition checks
// ═══════════════════════════════════════════════════════════════════════════

test('runNullModelHierarchy: requires an explicit seed and a non-empty gap array', () => {
  assert.throws(() => runNullModelHierarchy([1, 2, 3]), NullModelHierarchyError);
  assert.throws(() => runNullModelHierarchy([], { seed: 1 }), NullModelHierarchyError);
  assert.throws(() => runNullModelHierarchy(null, { seed: 1 }), NullModelHierarchyError);
});

// ═══════════════════════════════════════════════════════════════════════════
// All three termination branches, against real synthetic ground truth
// ═══════════════════════════════════════════════════════════════════════════

test('true exponential data stops at Stage C (Poisson) -- only 1 stage runs', () => {
  const rng = seededRng(123);
  const gaps = trueExponentialSample(rng, 200, 1.5);
  const result = runNullModelHierarchy(gaps, { seed: 55, numSimulations: 500 });
  assert.equal(result.finalStage, 'Poisson');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_POISSON);
  assert.equal(result.stagesRun.length, 1);
  assert.equal(result.stagesRun[0].stage, 'Poisson');
});

test('true uniform i.i.d. (non-exponential, independent) data stops at Stage E (RenewalDistribution) -- all 3 stages run in order', () => {
  const rng = seededRng(42);
  const gaps = Array.from({ length: 300 }, () => 0.5 + rng() * 1.0);
  const result = runNullModelHierarchy(gaps, { seed: 999, numSimulations: 500 });
  assert.equal(result.finalStage, 'RenewalDistribution');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_RENEWAL_NON_EXPONENTIAL);
  assert.deepEqual(result.stagesRun.map((s) => s.stage), ['Poisson', 'Renewal', 'RenewalDistribution']);
  assert.equal(result.stagesRun[2].classification, 'sub-exponential');
});

test('true AR(1)-dependent data stops at Stage D (Renewal) -- only 2 stages run, Stage E never reached', () => {
  const rng = seededRng(7);
  const gaps = [1.0];
  for (let i = 1; i < 300; i++) gaps.push(0.7 * gaps[i - 1] + 0.3 * (0.5 + rng()));
  const result = runNullModelHierarchy(gaps, { seed: 321, numSimulations: 500 });
  assert.equal(result.finalStage, 'Renewal');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED);
  assert.deepEqual(result.stagesRun.map((s) => s.stage), ['Poisson', 'Renewal']);
});

// ═══════════════════════════════════════════════════════════════════════════
// Structural verification: no stage runs before its predecessor's
// advancement criterion is satisfied.
// ═══════════════════════════════════════════════════════════════════════════

test('structural: Stage D/E never run when Stage C is consistent (verified via the authoritative stagesRun record, not just the branch logic)', () => {
  const rng = seededRng(123);
  const gaps = trueExponentialSample(rng, 200, 1.5);
  const result = runNullModelHierarchy(gaps, { seed: 55, numSimulations: 500 });
  assert.equal(result.stagesRun.length, 1, 'Stage D/E must not have run when Stage C was consistent');
  assert.ok(!result.stagesRun.some((s) => s.stage === 'Renewal' || s.stage === 'RenewalDistribution'));
});

test('structural: Stage E never runs when Stage D rejects independence', () => {
  const rng = seededRng(7);
  const gaps = [1.0];
  for (let i = 1; i < 300; i++) gaps.push(0.7 * gaps[i - 1] + 0.3 * (0.5 + rng()));
  const result = runNullModelHierarchy(gaps, { seed: 321, numSimulations: 500 });
  assert.ok(!result.stagesRun.some((s) => s.stage === 'RenewalDistribution'), 'Stage E must not run when Stage D rejected independence');
});

test('every returned stage result matches exactly what the corresponding standalone stage function would produce (no reimplementation, pure sequencing)', () => {
  const rng = seededRng(42);
  const gaps = Array.from({ length: 300 }, () => 0.5 + rng() * 1.0);
  const hierarchyResult = runNullModelHierarchy(gaps, { seed: 999, numSimulations: 500 });

  const directStageC = renewalProcessTests.testPoissonStage(gaps, { seed: 999, numSimulations: 500 });
  assert.deepEqual(hierarchyResult.stagesRun[0], directStageC);

  const directStageD = renewalProcessTests.testRenewalStage(gaps, {});
  assert.deepEqual(hierarchyResult.stagesRun[1], directStageD);

  const directStageE = renewalProcessTests.testRenewalDistributionStage(gaps, {});
  assert.deepEqual(hierarchyResult.stagesRun[2], directStageE);
});

test('deterministic for a fixed seed across the whole hierarchy', () => {
  const rng = seededRng(9);
  const gaps = Array.from({ length: 300 }, () => 0.5 + rng() * 1.0);
  const a = runNullModelHierarchy(gaps, { seed: 44, numSimulations: 300 });
  const b = runNullModelHierarchy(gaps, { seed: 44, numSimulations: 300 });
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage F wiring (states parameter) -- extends the C/D/E hierarchy above
// ═══════════════════════════════════════════════════════════════════════════

test('without a states array, dependence found at Stage D still correctly stops at Renewal (unchanged, pre-existing behavior)', () => {
  const rng = seededRng(7);
  const gaps = [1.0];
  for (let i = 1; i < 300; i++) gaps.push(0.7 * gaps[i - 1] + 0.3 * (0.5 + rng()));
  const result = runNullModelHierarchy(gaps, { seed: 321, numSimulations: 500 });
  assert.equal(result.finalStage, 'Renewal');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED);
  assert.ok(!result.stagesRun.some((s) => s.stage === 'SemiMarkov'), 'Stage F must not run without a states array');
});

test('with a states array and a strong genuine semi-Markov effect (persistent, autocorrelated states with real state-conditional gap distributions), the hierarchy correctly cascades C -> D -> F and terminates at consistent-with-semi-markov', () => {
  const rng = seededRng(50);
  const n = 800;
  const states = ['RISE'];
  for (let i = 1; i < n; i++) {
    const stay = rng() < 0.92; // real persistence -- a degenerate i.i.d. state assignment would NOT reliably trigger Stage D's rejection (see this module's own commit history for why)
    states.push(stay ? states[i - 1] : (states[i - 1] === 'RISE' ? 'FALL' : 'RISE'));
  }
  const gaps = states.map((s) => (s === 'RISE' ? -Math.log(1 - rng()) * 5 : -Math.log(1 - rng()) * 0.3));
  const result = runNullModelHierarchy(gaps, { seed: 77, numSimulations: 500, states, numPermutations: 500 });
  assert.equal(result.finalStage, 'SemiMarkov');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.CONSISTENT_WITH_SEMI_MARKOV);
  assert.deepEqual(result.stagesRun.map((s) => s.stage), ['Poisson', 'Renewal', 'SemiMarkov']);
});

test('with a states array but dependence unrelated to state, Stage F correctly finds no state-dependence and reports advancement-required at SemiMarkov (Stage E never runs, since Stage D already rejected independence)', () => {
  const rng = seededRng(9);
  const n = 300;
  const gaps = [1.0];
  const states = [];
  for (let i = 0; i < n; i++) {
    states.push(rng() < 0.5 ? 'RISE' : 'FALL'); // state is i.i.d., unrelated to the AR(1) dependence below
    if (i > 0) gaps.push(0.75 * gaps[i - 1] + 0.25 * (0.5 + rng()));
  }
  const result = runNullModelHierarchy(gaps, { seed: 654, numSimulations: 500, states, numPermutations: 500 });
  assert.equal(result.finalStage, 'SemiMarkov');
  assert.equal(result.conclusion, HIERARCHY_CONCLUSIONS.DEPENDENCE_DETECTED_ADVANCEMENT_REQUIRED);
  assert.ok(!result.stagesRun.some((s) => s.stage === 'RenewalDistribution'), 'Stage E must not run when Stage D already rejected independence');
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js, and reimplements no statistical logic of its own', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/statistics/nullModelHierarchy.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
  assert.ok(!/kolmogorovSmirnov|lagKAutocorrelation|fitExponentialMLE/.test(src), 'must not reimplement any statistical primitive already in renewalProcessTests.js');
});
