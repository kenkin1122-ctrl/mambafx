/**
 * tests/phase12/extractConfirmationPValue.test.mjs
 *
 * Tests for eventProcess/EventProcessConfirmationProcedure.js's
 * extractConfirmationPValue() -- the resolution of a real design
 * question (which of a 6-stage hierarchy's several p-values gets
 * submitted to alpha-spending): always Stage C's, for the reasons
 * documented in the function's own header.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractConfirmationPValue, EventProcessConfirmationError } from '../../research/src/eventProcess/EventProcessConfirmationProcedure.js';
import { runNullModelHierarchy } from '../../research/src/statistics/nullModelHierarchy.js';

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

test('extractConfirmationPValue: for a Poisson-consistent result (only Stage C ran), returns Stage C\'s own pValue', () => {
  const rng = seededRng(9);
  const gaps = trueExponentialGaps(rng, 200, 1.5);
  const result = runNullModelHierarchy(gaps, { seed: 42, numSimulations: 300 });
  assert.equal(result.stagesRun.length, 1);
  const extracted = extractConfirmationPValue(result);
  assert.equal(extracted, result.stagesRun[0].pValue);
  assert.equal(result.stagesRun[0].stage, 'Poisson');
});

test('extractConfirmationPValue: for a MUCH LONGER cascade (many stages ran), STILL returns Stage C\'s pValue, not the final stage\'s', () => {
  const rng = seededRng(42);
  const gaps = Array.from({ length: 300 }, () => 0.5 + rng()); // uniform: rejects Poisson, passes Renewal, characterized at Stage E
  const result = runNullModelHierarchy(gaps, { seed: 999, numSimulations: 500 });
  assert.ok(result.stagesRun.length > 1, 'test fixture should genuinely cascade past Stage C');
  const extracted = extractConfirmationPValue(result);
  assert.equal(extracted, result.stagesRun[0].pValue);
  assert.notEqual(result.stagesRun[0].stage, result.finalStage, 'sanity: the cascade really did move past Stage C');
});

test('extractConfirmationPValue: throws for a malformed or foreign result object -- never silently returns undefined or NaN', () => {
  assert.throws(() => extractConfirmationPValue(null), EventProcessConfirmationError);
  assert.throws(() => extractConfirmationPValue({}), EventProcessConfirmationError);
  assert.throws(() => extractConfirmationPValue({ stagesRun: [] }), EventProcessConfirmationError);
  assert.throws(() => extractConfirmationPValue({ stagesRun: [{ stage: 'Renewal', pValue: 0.5 }] }), EventProcessConfirmationError);
  assert.throws(() => extractConfirmationPValue({ stagesRun: [{ stage: 'Poisson' }] }), EventProcessConfirmationError);
});
