/**
 * tests/phase11/replicationValidator.test.mjs
 *
 * Tests for research/src/validation/ReplicationValidator.js — Section 6
 * of the Phase 11 Validation & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyReplicationIndependence,
  Phase11ReplicationValidationInputError,
} from '../../research/src/validation/ReplicationValidator.js';

test('verifyReplicationIndependence: throws for malformed range inputs', () => {
  assert.throws(() => verifyReplicationIndependence({
    originalRange: null, replicationRange: { startTick: 0, endTick: 10 },
    originalEffectSize: 0.1, replicationPooledEffectSize: 0.1,
  }), Phase11ReplicationValidationInputError);
});

test('verifyReplicationIndependence: a genuinely disjoint replication reports 0% overlap and verdict "independent"', () => {
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 1000, endTick: 2000 },
    originalEffectSize: 0.12, replicationPooledEffectSize: 0.11,
  });
  assert.equal(result.overlapPercentage, 0);
  assert.equal(result.verdict, 'independent');
  assert.equal(result.signConsistent, true);
});

test('verifyReplicationIndependence: an overlapping replication range is caught and reported as CONTAMINATED', () => {
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 500, endTick: 1500 }, // 500 ticks overlap out of 1000 span = 50%
    originalEffectSize: 0.12, replicationPooledEffectSize: 0.11,
  });
  assert.equal(result.overlapPercentage, 50);
  assert.equal(result.verdict, 'CONTAMINATED');
});

test('verifyReplicationIndependence: detects overlapping internal replication partitions', () => {
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 1000, endTick: 2000 },
    partitionRanges: [
      { startTick: 1000, endTick: 1300 },
      { startTick: 1250, endTick: 1600 }, // overlaps the previous partition
      { startTick: 1600, endTick: 2000 },
    ],
    originalEffectSize: 0.12, replicationPooledEffectSize: 0.11,
  });
  assert.equal(result.partitionIntegrityOk, false);
  assert.equal(result.partitionOverlaps.length, 1);
  assert.equal(result.verdict, 'CONTAMINATED');
});

test('verifyReplicationIndependence: non-overlapping internal partitions pass integrity check', () => {
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 1000, endTick: 2000 },
    partitionRanges: [
      { startTick: 1000, endTick: 1250 },
      { startTick: 1250, endTick: 1500 },
      { startTick: 1500, endTick: 1750 },
      { startTick: 1750, endTick: 2000 },
    ],
    originalEffectSize: 0.12, replicationPooledEffectSize: 0.11,
  });
  assert.equal(result.partitionIntegrityOk, true);
  assert.equal(result.partitionOverlaps.length, 0);
  assert.equal(result.verdict, 'independent');
});

test('verifyReplicationIndependence: detects a sign flip between original and replication effect sizes', () => {
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 1000, endTick: 2000 },
    originalEffectSize: 0.12, replicationPooledEffectSize: -0.10,
  });
  assert.equal(result.signConsistent, false);
  // Sign inconsistency doesn't by itself flip the independence verdict --
  // that's a separate, scientific concern (the replication legitimately
  // failed to replicate), not a data-contamination concern.
  assert.equal(result.verdict, 'independent');
});

test('verifyReplicationIndependence: re-surfaces an already-computed stability result without recomputing it', () => {
  const stability = { stabilityIndex: 0.8, signAgreementFraction: 1, magnitudeConsistency: 0.9 };
  const result = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 1000 },
    replicationRange: { startTick: 1000, endTick: 2000 },
    originalEffectSize: 0.12, replicationPooledEffectSize: 0.11, stability,
  });
  assert.equal(result.stability, stability);
});

test('never spends alpha or imports onlineFdr.js/discoveryDecision.js', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/validation/ReplicationValidator.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
