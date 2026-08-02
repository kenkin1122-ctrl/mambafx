/**
 * tests/phase12/hmmTest.test.mjs
 *
 * Tests for statistics/hmmTest.js -- Stage H (final stage) of the Null
 * Model Hierarchy: 2-state HMM vs. 1-state exponential likelihood-ratio
 * test, Monte Carlo calibrated. Includes both validation layers this
 * module's own header describes: Type I error calibration and power --
 * each against real synthetic ground truth with a known generative
 * process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forwardBackward, fitHMM2, fitExponentialForHMM, simulateHMM2,
  simulateExponentialSequence, testHMMStage, HMMTestError,
} from '../../research/src/statistics/hmmTest.js';

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
// Building blocks
// ═══════════════════════════════════════════════════════════════════════════

test('fitExponentialForHMM: closed-form rate_hat = 1/mean, real finite log-likelihood', () => {
  const { rate, logLikelihood } = fitExponentialForHMM([1, 2, 3, 4]);
  assert.equal(rate, 1 / 2.5);
  assert.ok(Number.isFinite(logLikelihood));
});

test('forwardBackward: produces a real, finite log-likelihood for a small real example', () => {
  const { logLikelihood } = forwardBackward([1, 2, 1.5, 3], [0.5, 0.5], [[0.8, 0.2], [0.2, 0.8]], [1, 0.5]);
  assert.ok(Number.isFinite(logLikelihood));
});

test('simulateHMM2/simulateExponentialSequence: produce real, finite, strictly positive gap sequences of the requested length', () => {
  const rng = seededRng(1);
  const hmmGaps = simulateHMM2([0.5, 0.5], [[0.9, 0.1], [0.1, 0.9]], [2, 0.5], 50, rng);
  const expGaps = simulateExponentialSequence(1.5, 50, rng);
  for (const gaps of [hmmGaps, expGaps]) {
    assert.equal(gaps.length, 50);
    assert.ok(gaps.every((g) => Number.isFinite(g) && g > 0));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Parameter recovery (accounting for expected label-switching)
// ═══════════════════════════════════════════════════════════════════════════

test('fitHMM2: recovers the two true rates (in either label order -- HMM label-switching is expected, not a bug) within a reasonable tolerance', () => {
  const rng = seededRng(42);
  const trueRates = [2.0, 0.5];
  const gaps = simulateHMM2([0.6, 0.4], [[0.9, 0.1], [0.15, 0.85]], trueRates, 500, rng);
  const fit = fitHMM2(gaps);
  const fittedSorted = [...fit.rates].sort((a, b) => a - b);
  const trueSorted = [...trueRates].sort((a, b) => a - b);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(fittedSorted[i] - trueSorted[i]) / trueSorted[i] < 0.3, `rate recovery off by more than 30%: fitted ${fittedSorted[i]}, true ${trueSorted[i]}`);
  }
});

test('fitHMM2: deterministic (no randomness) -- identical input produces identical fit', () => {
  const rng = seededRng(7);
  const gaps = simulateHMM2([0.5, 0.5], [[0.9, 0.1], [0.1, 0.9]], [1.5, 0.4], 300, rng);
  const a = fitHMM2(gaps);
  const b = fitHMM2(gaps);
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Type I error calibration
// ═══════════════════════════════════════════════════════════════════════════

test('Type I error rate on TRUE single-state exponential data (no real hidden state) is close to nominal alpha', () => {
  let falseRejections = 0;
  const trials = 20;
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(1000 + t);
    const gaps = simulateExponentialSequence(1.0, 150, rng);
    const result = testHMMStage(gaps, { seed: 5000 + t, numSimulations: 20 });
    if (result.hiddenStateDetected) falseRejections++;
  }
  const rate = falseRejections / trials;
  assert.ok(rate <= 0.25, `Type I error rate ${rate} is implausibly high for alpha=0.05 over ${trials} trials`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Power on genuine hidden-state structure
// ═══════════════════════════════════════════════════════════════════════════

test('correctly DETECTS genuine, well-separated 2-state hidden structure in synthetic HMM data', () => {
  const rng = seededRng(42);
  const gaps = simulateHMM2([0.5, 0.5], [[0.95, 0.05], [0.05, 0.95]], [3.0, 0.3], 300, rng);
  const result = testHMMStage(gaps, { seed: 77, numSimulations: 30 });
  assert.equal(result.hiddenStateDetected, true);
  assert.ok(result.pValue < 0.05);
  assert.ok(result.likelihoodRatio > 0);
});

test('testHMMStage: deterministic for a fixed seed', () => {
  const rng = seededRng(42);
  const gaps = simulateHMM2([0.5, 0.5], [[0.95, 0.05], [0.05, 0.95]], [3.0, 0.3], 200, rng);
  const a = testHMMStage(gaps, { seed: 99, numSimulations: 15 });
  const b = testHMMStage(gaps, { seed: 99, numSimulations: 15 });
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Precondition checks
// ═══════════════════════════════════════════════════════════════════════════

test('testHMMStage: requires an explicit seed, at least 10 gaps, and all-positive-finite values', () => {
  assert.throws(() => testHMMStage(Array.from({ length: 15 }, () => 1)), HMMTestError);
  assert.throws(() => testHMMStage([1, 2, 3], { seed: 1 }), HMMTestError);
  assert.throws(() => testHMMStage(Array.from({ length: 15 }, (_, i) => (i === 3 ? -1 : 1)), { seed: 1 }), HMMTestError);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/statistics/hmmTest.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
