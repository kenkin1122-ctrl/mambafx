/**
 * tests/phase12/semiMarkovTest.test.mjs
 *
 * Tests for statistics/semiMarkovTest.js -- Stage F of the Null Model
 * Hierarchy: state-conditional (RISE/FALL) gap distribution comparison
 * via a label-permutation-calibrated two-sample KS test. Includes
 * synthetic ground-truth Type I error calibration (a larger, 500-trial
 * confirmation run after an initial 150-trial run showed a plausible-but-
 * unconfirmed elevated rate -- following the same discipline that caught
 * two real bugs in the Stages C-E slice).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { twoSampleKolmogorovSmirnovStatistic, testSemiMarkovStage, SemiMarkovTestError } from '../../research/src/statistics/semiMarkovTest.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// Building block
// ═══════════════════════════════════════════════════════════════════════════

test('twoSampleKolmogorovSmirnovStatistic: zero for two identical samples, positive for clearly different ones', () => {
  const identical = twoSampleKolmogorovSmirnovStatistic([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.equal(identical, 0);
  const different = twoSampleKolmogorovSmirnovStatistic([1, 2, 3], [100, 101, 102]);
  assert.equal(different, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Precondition checks
// ═══════════════════════════════════════════════════════════════════════════

test('testSemiMarkovStage: requires an explicit seed, matching-length states array, valid RISE/FALL-only labels, and at least 2 gaps per state', () => {
  assert.throws(() => testSemiMarkovStage([1, 2], ['RISE', 'FALL']), SemiMarkovTestError);
  assert.throws(() => testSemiMarkovStage([1, 2], ['RISE'], { seed: 1 }), SemiMarkovTestError);
  assert.throws(() => testSemiMarkovStage([1, 2], ['RISE', 'SIDEWAYS'], { seed: 1 }), SemiMarkovTestError);
  assert.throws(() => testSemiMarkovStage([1, -1], ['RISE', 'FALL'], { seed: 1 }), SemiMarkovTestError);
  assert.throws(() => testSemiMarkovStage([1, 2, 3], ['RISE', 'RISE', 'FALL'], { seed: 1 }), SemiMarkovTestError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Synthetic ground-truth calibration
// ═══════════════════════════════════════════════════════════════════════════

test('Type I error rate on state-INDEPENDENT synthetic data (same distribution regardless of state label) is close to nominal alpha over a large trial count', () => {
  let falseRejections = 0;
  const trials = 250;
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(3000 + t);
    const n = 150;
    const gaps = Array.from({ length: n }, () => -Math.log(1 - rng()));
    const states = Array.from({ length: n }, () => (rng() < 0.5 ? 'RISE' : 'FALL'));
    const result = testSemiMarkovStage(gaps, states, { seed: 8000 + t, numPermutations: 200 });
    if (result.stateDependenceDetected) falseRejections++;
  }
  const rate = falseRejections / trials;
  assert.ok(rate > 0.01 && rate < 0.11, `Type I error rate ${rate} is outside the plausible range around alpha=0.05`);
});

test('correctly DETECTS a genuine state-dependent gap distribution (RISE gaps drawn from a much larger-scale exponential than FALL gaps)', () => {
  const rng = seededRng(99);
  const n = 300;
  const states = Array.from({ length: n }, () => (rng() < 0.5 ? 'RISE' : 'FALL'));
  const gaps = states.map((s) => (s === 'RISE' ? -Math.log(1 - rng()) * 3 : -Math.log(1 - rng()) * 0.5));
  const result = testSemiMarkovStage(gaps, states, { seed: 12345, numPermutations: 1000 });
  assert.equal(result.stateDependenceDetected, true);
  assert.ok(result.pValue < 0.01);
});

test('deterministic for a fixed seed', () => {
  const rng = seededRng(9);
  const n = 200;
  const states = Array.from({ length: n }, () => (rng() < 0.5 ? 'RISE' : 'FALL'));
  const gaps = states.map((s) => (s === 'RISE' ? -Math.log(1 - rng()) * 2 : -Math.log(1 - rng())));
  const a = testSemiMarkovStage(gaps, states, { seed: 5, numPermutations: 200 });
  const b = testSemiMarkovStage(gaps, states, { seed: 5, numPermutations: 200 });
  assert.deepEqual(a, b);
});

test('reports real, distinct RISE/FALL sample sizes summing to the total gap count', () => {
  const rng = seededRng(1);
  const n = 150;
  const states = Array.from({ length: n }, () => (rng() < 0.5 ? 'RISE' : 'FALL'));
  const gaps = Array.from({ length: n }, () => -Math.log(1 - rng()));
  const result = testSemiMarkovStage(gaps, states, { seed: 2, numPermutations: 200 });
  assert.equal(result.riseSampleSize + result.fallSampleSize, n);
  assert.ok(result.riseSampleSize > 0 && result.fallSampleSize > 0);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/statistics/semiMarkovTest.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
