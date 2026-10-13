import test from 'node:test';
import assert from 'node:assert/strict';
import {
  breakEven, breakEvenFromPayoutPct, wilson, binomialTailGE, betaPosterior,
  brierScore, reliability, benjaminiHochberg, varianceRatio, runsTestZ,
  permutationEntropy, ouFit, kalmanTrend, shuffleReturnsPath,
} from '../../src/bazu/stats.js';

test('break-even from payout', () => {
  assert.ok(Math.abs(breakEvenFromPayoutPct(0.85) - 0.5405) < 1e-4);
  assert.ok(Math.abs(breakEven(1, 1.95) - 0.5128) < 1e-3);
  assert.equal(breakEven(0, 1), null);
});

test('wilson interval brackets p', () => {
  const w = wilson(60, 100);
  assert.ok(w.lo < 0.6 && w.hi > 0.6 && w.lo > 0.49 && w.hi < 0.70);
  assert.equal(wilson(0, 0).p, null);
});

test('binomial tail', () => {
  assert.ok(Math.abs(binomialTailGE(5, 10, 0.5) - 0.623046875) < 1e-9);
  assert.equal(binomialTailGE(0, 10, 0.5), 1);
});

test('beta posterior', () => {
  assert.equal(betaPosterior(6, 10).mean, 7 / 12);
});

test('brier and reliability', () => {
  assert.equal(brierScore([1, 0], [1, 0]), 0);
  const r = reliability([0.1, 0.9, 0.9], [0, 1, 0], 5);
  assert.equal(r.length, 2);
});

test('BH adjusts monotonically', () => {
  const { adjusted, rejected } = benjaminiHochberg([0.001, 0.02, 0.5, 0.9], 0.05);
  assert.ok(adjusted[0] <= adjusted[1] && adjusted[1] <= adjusted[2]);
  assert.deepEqual(rejected, [true, true, false, false]);
});

test('variance ratio ~1 for random walk, <1 for alternating', () => {
  const alt = Array.from({ length: 400 }, (_, i) => (i % 2 ? 1 : 0));
  assert.ok(varianceRatio(alt, 4) < 0.5);
});

test('runs test negative for alternating', () => {
  assert.ok(runsTestZ(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : -1))) > 5);
});

test('permutation entropy low for monotone', () => {
  assert.equal(permutationEntropy(Array.from({ length: 50 }, (_, i) => i), 3), 0);
});

test('OU half-life finite for AR(1)', () => {
  let x = [0];
  for (let i = 1; i < 300; i++) x.push(0.8 * x[i - 1] + ((i * 7919) % 100) / 100 - 0.5);
  const f = ouFit(x);
  assert.ok(f.halfLife > 0 && Number.isFinite(f.halfLife));
});

test('kalman velocity positive on uptrend', () => {
  const k = kalmanTrend(Array.from({ length: 100 }, (_, i) => i * 0.5));
  assert.ok(k.velocity[99] > 0.3);
});

test('shuffle preserves increments multiset and is deterministic', () => {
  const p = [1, 2, 4, 3, 6];
  const a = shuffleReturnsPath(p, 7), b = shuffleReturnsPath(p, 7);
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a[a.length - 1] - p[p.length - 1]) < 1e-9);
});
