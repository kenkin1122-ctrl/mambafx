/**
 * tests/phase12/eventProcessPartitionStatistics.test.mjs
 *
 * Tests for eventProcess/EventProcessConfirmationProcedure.js's
 * computeEventProcessPartitionStatistics() -- real per-partition Stage C
 * KS statistics for replication, and the disclosed sign-agreement
 * vacuity finding this function's own header documents.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeEventProcessPartitionStatistics, EventProcessConfirmationError } from '../../research/src/eventProcess/EventProcessConfirmationProcedure.js';
import { computeDiscoveryStabilityIndex } from '../../research/src/analysis/DiscoveryStabilityAnalysis.js';

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

test('computeEventProcessPartitionStatistics: returns the requested number of partition effect sizes, all real, finite, non-negative numbers, plus a real pooled effect size', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 400, 1.5);
  const { partitionEffectSizes, pooledEffectSize } = computeEventProcessPartitionStatistics(gaps, 4);
  assert.equal(partitionEffectSizes.length, 4);
  assert.ok(partitionEffectSizes.every((v) => Number.isFinite(v) && v >= 0));
  assert.ok(Number.isFinite(pooledEffectSize) && pooledEffectSize >= 0);
});

test('regression/disclosed-limitation test: KS statistics are always non-negative, so computeDiscoveryStabilityIndex\'s sign-agreement component is trivially 1.0 and the stability index reduces exactly to magnitudeConsistency', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 400, 1.5);
  const { partitionEffectSizes, pooledEffectSize } = computeEventProcessPartitionStatistics(gaps, 4);
  const stability = computeDiscoveryStabilityIndex(partitionEffectSizes, pooledEffectSize);
  assert.equal(stability.signAgreementFraction, 1, 'sign agreement is vacuously always 1.0 for non-negative KS statistics');
  assert.equal(stability.stabilityIndex, stability.magnitudeConsistency, 'the stability index must reduce exactly to magnitudeConsistency when sign agreement is trivial');
});

test('computeEventProcessPartitionStatistics: rejects invalid inputs (empty gaps, partitionCount < 2, non-integer partitionCount, too few gaps for the requested partitions)', () => {
  assert.throws(() => computeEventProcessPartitionStatistics([], 4), EventProcessConfirmationError);
  assert.throws(() => computeEventProcessPartitionStatistics([1, 2, 3], 1), EventProcessConfirmationError);
  assert.throws(() => computeEventProcessPartitionStatistics([1, 2, 3], 2.5), EventProcessConfirmationError);
  assert.throws(() => computeEventProcessPartitionStatistics(Array.from({ length: 20 }, () => 1), 4), EventProcessConfirmationError);
});

test('computeEventProcessPartitionStatistics: the last partition absorbs any remainder, and produces exactly the requested partition count', () => {
  const gaps = Array.from({ length: 43 }, (_, i) => i + 1);
  const { partitionEffectSizes } = computeEventProcessPartitionStatistics(gaps, 4);
  assert.equal(partitionEffectSizes.length, 4);
});
