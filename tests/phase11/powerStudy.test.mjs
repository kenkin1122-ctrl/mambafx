/**
 * tests/phase11/powerStudy.test.mjs
 *
 * Tests for research/src/validation/PowerStudy.js — Section 2 of the
 * Phase 11 Validation & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  injectSyntheticEffect,
  runPowerCurve,
  Phase11PowerStudyInputError,
} from '../../research/src/validation/PowerStudy.js';

test('injectSyntheticEffect: throws for an out-of-range trueEffectSize', () => {
  assert.throws(() => injectSyntheticEffect({ length: 100, trueEffectSize: 1.5, seed: 1 }), Phase11PowerStudyInputError);
});

test('injectSyntheticEffect: produces equal-length feature/outcome arrays with a binary outcome', () => {
  const { featureValues, outcomeValues } = injectSyntheticEffect({ length: 200, trueEffectSize: 0.3, seed: 5 });
  assert.equal(featureValues.length, 200);
  assert.equal(outcomeValues.length, 200);
  for (const v of outcomeValues) assert.ok(v === 0 || v === 1);
});

test('injectSyntheticEffect: a larger trueEffectSize produces a larger empirical point-biserial correlation, on average', () => {
  function correlation(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
    return cov / Math.sqrt(vx * vy);
  }
  const low = injectSyntheticEffect({ length: 2000, trueEffectSize: 0.05, seed: 10 });
  const high = injectSyntheticEffect({ length: 2000, trueEffectSize: 0.6, seed: 10 });
  assert.ok(Math.abs(correlation(high.featureValues, high.outcomeValues)) > Math.abs(correlation(low.featureValues, low.outcomeValues)));
});

test('injectSyntheticEffect: is deterministic for a fixed seed', () => {
  const a = injectSyntheticEffect({ length: 100, trueEffectSize: 0.3, seed: 42 });
  const b = injectSyntheticEffect({ length: 100, trueEffectSize: 0.3, seed: 42 });
  assert.deepEqual(a, b);
});

test('runPowerCurve: throws for an empty effectSizes array or non-positive trial count', async () => {
  assert.throws(() => runPowerCurve({ effectSizes: [], trialsPerEffectSize: 5, seed: 1 }), Phase11PowerStudyInputError);
  assert.throws(() => runPowerCurve({ effectSizes: [0.3], trialsPerEffectSize: 0, seed: 1 }), Phase11PowerStudyInputError);
});

test('runPowerCurve: detection probability increases with true effect size, and a strong effect is reliably detected', () => {
  const result = runPowerCurve({
    effectSizes: [0.0, 0.5], trialsPerEffectSize: 15, seed: 77,
    datasetLength: 300, permutations: 300, bootstrapResamples: 300,
  });
  const nullPoint = result.points.find((p) => p.trueEffectSize === 0.0);
  const strongPoint = result.points.find((p) => p.trueEffectSize === 0.5);

  assert.ok(strongPoint.detectionProbability > nullPoint.detectionProbability,
    `expected higher detection at effect=0.5 (${strongPoint.detectionProbability}) than at effect=0 (${nullPoint.detectionProbability})`);
  assert.ok(strongPoint.detectionProbability >= 0.5, `expected reasonably high detection for a strong effect, got ${strongPoint.detectionProbability}`);
});

test('runPowerCurve: reports meanRecoveredEffectSize, meanAbsoluteBias, CI coverage/width, and theoretical power for every point', () => {
  const result = runPowerCurve({
    effectSizes: [0.2, 0.4], trialsPerEffectSize: 10, seed: 33,
    datasetLength: 200, permutations: 200, bootstrapResamples: 200,
  });
  assert.equal(result.points.length, 2);
  for (const point of result.points) {
    assert.equal(typeof point.detectionProbability, 'number');
    assert.equal(typeof point.meanRecoveredEffectSize, 'number');
    assert.ok(point.meanAbsoluteBias >= 0);
    assert.ok(point.meanCiWidth >= 0);
    assert.ok(point.ciCoverage >= 0 && point.ciCoverage <= 1);
    assert.ok(point.theoreticalPower === null || (point.theoreticalPower >= 0 && point.theoreticalPower <= 1));
  }
});

test('runPowerCurve: minimumDetectableEffect is null when no effect size reaches the power threshold', () => {
  const result = runPowerCurve({
    effectSizes: [0.01], trialsPerEffectSize: 5, seed: 1,
    datasetLength: 100, permutations: 100, bootstrapResamples: 100, powerThreshold: 0.99,
  });
  assert.equal(result.minimumDetectableEffect, null);
});

test('never spends alpha or imports onlineFdr.js/discoveryDecision.js', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/validation/PowerStudy.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
