/**
 * tests/phase12/hawkesTest.test.mjs
 *
 * Tests for statistics/hawkesTest.js -- Stage G of the Null Model
 * Hierarchy: Hawkes-vs-Poisson likelihood-ratio test, Monte Carlo
 * calibrated. Includes the three independent validation layers this
 * module's own header describes: parameter recovery, Type I error
 * calibration, and power -- each against real synthetic ground truth
 * with a known generative process, not just "does it run."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hawkesLogLikelihood, fitHawkesMLE, fitPoissonMLE, simulateHawkesProcess,
  simulatePoissonProcess, gapsToEventTimes, testHawkesStage, HawkesTestError,
} from '../../research/src/statistics/hawkesTest.js';

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

test('gapsToEventTimes: cumulative sum, first event at gaps[0] not 0', () => {
  assert.deepEqual(gapsToEventTimes([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(gapsToEventTimes([]), []);
});

test('fitPoissonMLE: mu_hat = n / T, closed form', () => {
  const { mu } = fitPoissonMLE([1, 2, 3, 4], 10);
  assert.equal(mu, 4 / 10);
});

test('hawkesLogLikelihood: real, finite value for a small real example; -mu*T for zero events', () => {
  assert.equal(hawkesLogLikelihood([], 1, 0.5, 2, 10), -10);
  const ll = hawkesLogLikelihood([1, 2, 5], 0.5, 0.3, 1.5, 10);
  assert.ok(Number.isFinite(ll));
});

test('simulateHawkesProcess/simulatePoissonProcess: produce real, strictly increasing event times within [0, T]', () => {
  const rng = seededRng(1);
  const hawkesEvents = simulateHawkesProcess(0.5, 0.3, 2, 50, rng);
  const poissonEvents = simulatePoissonProcess(0.5, 50, rng);
  for (const events of [hawkesEvents, poissonEvents]) {
    assert.ok(events.every((t) => t > 0 && t <= 50));
    for (let i = 1; i < events.length; i++) assert.ok(events[i] > events[i - 1]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: parameter recovery against known ground truth
// ═══════════════════════════════════════════════════════════════════════════

test('fitHawkesMLE: recovers known true parameters within a reasonable tolerance from simulated data', () => {
  const rng = seededRng(42);
  const trueMu = 0.5, trueAlpha = 0.8, trueBeta = 2.0, T = 1000;
  const events = simulateHawkesProcess(trueMu, trueAlpha, trueBeta, T, rng);
  const fit = fitHawkesMLE(events, T);
  assert.ok(Math.abs(fit.mu - trueMu) / trueMu < 0.3, `mu recovery off by more than 30%: fitted ${fit.mu}, true ${trueMu}`);
  assert.ok(Math.abs(fit.alpha - trueAlpha) / trueAlpha < 0.3, `alpha recovery off by more than 30%: fitted ${fit.alpha}, true ${trueAlpha}`);
  assert.ok(Math.abs(fit.beta - trueBeta) / trueBeta < 0.3, `beta recovery off by more than 30%: fitted ${fit.beta}, true ${trueBeta}`);
});

test('fitHawkesMLE: deterministic (no randomness) -- identical input produces identical fit', () => {
  const rng = seededRng(7);
  const events = simulateHawkesProcess(0.4, 0.5, 1.5, 300, rng);
  const a = fitHawkesMLE(events, 300);
  const b = fitHawkesMLE(events, 300);
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Type I error calibration
// ═══════════════════════════════════════════════════════════════════════════

test('Type I error rate on TRUE Poisson data (no real self-excitation) is close to nominal alpha', () => {
  let falseRejections = 0;
  const trials = 15;
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(1000 + t);
    const events = simulatePoissonProcess(1.0, 250, rng);
    const result = testHawkesStage(events, 250, { seed: 5000 + t, numSimulations: 20 });
    if (result.selfExcitationDetected) falseRejections++;
  }
  const rate = falseRejections / trials;
  assert.ok(rate <= 0.27, `Type I error rate ${rate} is implausibly high for alpha=0.05 over ${trials} trials`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3: power on genuine self-excitation
// ═══════════════════════════════════════════════════════════════════════════

test('correctly DETECTS genuine, strong self-excitation in synthetic Hawkes data', () => {
  const rng = seededRng(42);
  const events = simulateHawkesProcess(0.3, 1.5, 2.0, 400, rng);
  const result = testHawkesStage(events, 400, { seed: 77, numSimulations: 30 });
  assert.equal(result.selfExcitationDetected, true);
  assert.ok(result.pValue < 0.05);
  assert.ok(result.likelihoodRatio > 0);
});

test('testHawkesStage: deterministic for a fixed seed', () => {
  const rng = seededRng(42);
  const events = simulateHawkesProcess(0.3, 1.5, 2.0, 250, rng);
  const a = testHawkesStage(events, 250, { seed: 99, numSimulations: 15 });
  const b = testHawkesStage(events, 250, { seed: 99, numSimulations: 15 });
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Precondition checks
// ═══════════════════════════════════════════════════════════════════════════

test('testHawkesStage: requires an explicit seed, at least 5 events, strictly increasing times, and a valid T', () => {
  assert.throws(() => testHawkesStage([1, 2, 3, 4, 5], 10), HawkesTestError);
  assert.throws(() => testHawkesStage([1, 2], 10, { seed: 1 }), HawkesTestError);
  assert.throws(() => testHawkesStage([1, 2, 3, 2, 5], 10, { seed: 1 }), HawkesTestError);
  assert.throws(() => testHawkesStage([1, 2, 3, 4, 5], 3, { seed: 1 }), HawkesTestError);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/statistics/hawkesTest.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
