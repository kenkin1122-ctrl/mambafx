/**
 * tests/phase12/renewalProcessTests.test.mjs
 *
 * Tests for statistics/renewalProcessTests.js -- Stages C/D/E of the Null
 * Model Hierarchy. Includes synthetic ground-truth calibration checks
 * (Type I error rate near nominal alpha on true-null data), the specific
 * regression tests for the two real bugs found and fixed during this
 * slice's own validation (the Lilliefors bias in Stage C's p-value, and
 * the multiple-lag inflation in Stage D without Bonferroni correction).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fitExponentialMLE, exponentialCDF, kolmogorovSmirnovStatistic, kolmogorovSmirnovPValue,
  testPoissonStage, lagKAutocorrelation, testRenewalStage,
  computeCoefficientOfVariation, testRenewalDistributionStage, RenewalProcessTestError,
} from '../../research/src/statistics/renewalProcessTests.js';

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
// Basic building blocks
// ═══════════════════════════════════════════════════════════════════════════

test('fitExponentialMLE: lambda_hat = 1/mean, and rejects invalid samples', () => {
  const { lambda, mean } = fitExponentialMLE([1, 2, 3, 4]);
  assert.equal(mean, 2.5);
  assert.equal(lambda, 1 / 2.5);
  assert.throws(() => fitExponentialMLE([]), RenewalProcessTestError);
  assert.throws(() => fitExponentialMLE([1, 0, 2]), RenewalProcessTestError);
  assert.throws(() => fitExponentialMLE([1, -1, 2]), RenewalProcessTestError);
  assert.throws(() => fitExponentialMLE([1, NaN, 2]), RenewalProcessTestError);
});

test('kolmogorovSmirnovStatistic: computes a real, non-negative statistic', () => {
  const D = kolmogorovSmirnovStatistic([1, 2, 3], (x) => x / 3);
  assert.ok(D >= 0);
});

test('kolmogorovSmirnovPValue: regression test for the D~0 bug found during this slice\'s own validation -- must return exactly 1, not an artifact of the non-convergent alternating series at lambda=0', () => {
  assert.equal(kolmogorovSmirnovPValue(0, 100), 1);
  assert.equal(kolmogorovSmirnovPValue(1e-10, 100), 1);
});

test('kolmogorovSmirnovPValue: larger D produces a smaller p-value (monotonic)', () => {
  const pSmall = kolmogorovSmirnovPValue(0.05, 100);
  const pLarge = kolmogorovSmirnovPValue(0.3, 100);
  assert.ok(pLarge < pSmall);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage C (Poisson) -- Monte Carlo calibration, the Lilliefors fix
// ═══════════════════════════════════════════════════════════════════════════

test('testPoissonStage: requires an explicit seed (no hidden randomness)', () => {
  assert.throws(() => testPoissonStage([1, 2, 3]), RenewalProcessTestError);
});

test('regression test: Type I error rate on TRUE exponential data is close to nominal alpha (this is the Lilliefors-bias bug found and fixed during this slice -- the naive asymptotic formula produced 0% instead of ~5%)', () => {
  let falseRejections = 0;
  const trials = 150;
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(1000 + t);
    const gaps = trueExponentialSample(rng, 100, 2.0);
    const result = testPoissonStage(gaps, { seed: 5000 + t, numSimulations: 300 });
    if (!result.consistentWithPoisson) falseRejections++;
  }
  const rate = falseRejections / trials;
  assert.ok(rate > 0.01 && rate < 0.15, `Type I error rate ${rate} is outside the plausible range around alpha=0.05 -- possible recurrence of the Lilliefors bias`);
});

test('testPoissonStage: correctly REJECTS clearly non-exponential (uniform) i.i.d. gaps', () => {
  const rng = seededRng(42);
  const uniformGaps = Array.from({ length: 300 }, () => 0.5 + rng() * 1.0);
  const result = testPoissonStage(uniformGaps, { seed: 999, numSimulations: 500 });
  assert.equal(result.consistentWithPoisson, false);
  assert.ok(result.pValue < 0.01);
});

test('testPoissonStage: correctly ACCEPTS true exponential data as consistent with Poisson', () => {
  const rng = seededRng(123);
  const gaps = trueExponentialSample(rng, 200, 1.5);
  const result = testPoissonStage(gaps, { seed: 55, numSimulations: 500 });
  assert.equal(result.consistentWithPoisson, true);
});

test('testPoissonStage: deterministic for a fixed seed', () => {
  const rng = seededRng(1);
  const gaps = trueExponentialSample(rng, 50, 1);
  const a = testPoissonStage(gaps, { seed: 7, numSimulations: 200 });
  const b = testPoissonStage(gaps, { seed: 7, numSimulations: 200 });
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage D (Renewal / independence) -- the Bonferroni-correction fix
// ═══════════════════════════════════════════════════════════════════════════

test('lagKAutocorrelation: NaN for k >= series length, real value otherwise', () => {
  assert.ok(Number.isNaN(lagKAutocorrelation([1, 2, 3], 5)));
  const r = lagKAutocorrelation([1, 2, 1, 2, 1, 2], 1);
  assert.ok(Number.isFinite(r));
});

test('regression test: Stage D Type I error rate on genuinely i.i.d. data is close to nominal alpha (this is the multi-lag inflation bug found and fixed -- uncorrected, 5-lag testing gave ~23% false rejections instead of ~5%)', () => {
  let falseRejections = 0;
  const trials = 200;
  for (let t = 0; t < trials; t++) {
    const rng = seededRng(2000 + t);
    const gaps = Array.from({ length: 150 }, () => 0.5 + rng());
    const r = testRenewalStage(gaps);
    if (!r.consistentWithIndependence) falseRejections++;
  }
  const rate = falseRejections / trials;
  assert.ok(rate < 0.12, `Type I error rate ${rate} is too high -- possible recurrence of the uncorrected multi-lag inflation bug`);
});

test('testRenewalStage: correctly detects genuine dependence in AR(1)-style gaps', () => {
  const rng = seededRng(7);
  const arGaps = [1.0];
  for (let i = 1; i < 300; i++) arGaps.push(0.7 * arGaps[i - 1] + 0.3 * (0.5 + rng()));
  const result = testRenewalStage(arGaps);
  assert.equal(result.consistentWithIndependence, false);
  assert.ok(result.maxAbsZScore > 5);
});

test('testRenewalStage: bonferroniCorrectedAlpha = alpha / effectiveMaxLag', () => {
  const result = testRenewalStage(Array.from({ length: 100 }, (_, i) => i + 1), { maxLag: 5, alpha: 0.05 });
  assert.equal(result.bonferroniCorrectedAlpha, 0.01);
});

test('testRenewalStage: throws for a sample too small to test even lag-1', () => {
  assert.throws(() => testRenewalStage([1, 2]), RenewalProcessTestError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Stage E (Renewal Distribution characterization)
// ═══════════════════════════════════════════════════════════════════════════

test('computeCoefficientOfVariation: zero for perfectly regular (zero-variance) data', () => {
  const cv = computeCoefficientOfVariation([1, 1, 1, 1]);
  assert.equal(cv, 0);
});

test('testRenewalDistributionStage: classifies exponential-like/sub-exponential correctly on real synthetic data', () => {
  const rngExp = seededRng(11);
  const expGaps = trueExponentialSample(rngExp, 300, 1);
  const expResult = testRenewalDistributionStage(expGaps);
  assert.equal(expResult.classification, 'exponential-like');

  const rngUniform = seededRng(42);
  const uniformGaps = Array.from({ length: 300 }, () => 0.5 + rngUniform());
  const uniformResult = testRenewalDistributionStage(uniformGaps);
  assert.equal(uniformResult.classification, 'sub-exponential');
  assert.ok(uniformResult.coefficientOfVariation < 1);
});

test('testRenewalDistributionStage: rejects invalid input the same way every other stage does', () => {
  assert.throws(() => testRenewalDistributionStage([]), RenewalProcessTestError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Governance
// ═══════════════════════════════════════════════════════════════════════════

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/statistics/renewalProcessTests.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
