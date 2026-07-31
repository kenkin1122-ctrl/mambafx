/**
 * tests/phase11/confirmationReadiness.test.mjs
 *
 * Tests for research/src/bridge/Phase11ConfirmationReadiness.js — a pure
 * usability layer computed before Round 3 confirmation, changing no
 * statistical logic or thresholds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCandidateReadiness,
  computeOverallReadiness,
} from '../../research/src/bridge/Phase11ConfirmationReadiness.js';
import { MIN_ALIGNED_PAIRS, runAutomatedConfirmationTest } from '../../research/src/bridge/Phase11AutomatedConfirmation.js';

function makeWalkPrices(length, seed = 7) {
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < length; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));
  return prices;
}

const RSI14 = { id: 'cand-rsi', indicatorName: 'RSI', period: 14 };

test('computeCandidateReadiness: reports not-ready with a specific scientific reason when there is too little data', () => {
  const readiness = computeCandidateReadiness({
    candidate: RSI14, prices: makeWalkPrices(20), targetDefinition: { direction: 'Rise', runLength: 5 },
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.usableObservations < MIN_ALIGNED_PAIRS);
  assert.match(readiness.reason, /aligned \(indicator, outcome\) pairs available/);
  assert.match(readiness.reason, /14-tick RSI lookback/);
  assert.match(readiness.reason, /5-tick forward outcome window/);
  assert.ok(readiness.remainingTicksNeeded > 0);
  assert.ok(readiness.readinessPercentage < 100);
});

test('computeCandidateReadiness: reports ready once enough real data exists, matching the real test\'s own MIN_ALIGNED_PAIRS threshold exactly', () => {
  const prices = makeWalkPrices(300);
  const readiness = computeCandidateReadiness({
    candidate: RSI14, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.equal(readiness.remainingTicksNeeded, 0);
  assert.equal(readiness.readinessPercentage, 100);
  assert.ok(readiness.usableObservations >= MIN_ALIGNED_PAIRS);
});

test('computeCandidateReadiness: usableObservations exactly matches the real confirmation test\'s own sampleSize for the identical inputs', () => {
  const prices = makeWalkPrices(300);
  const targetDefinition = { direction: 'Rise', runLength: 5 };
  const readiness = computeCandidateReadiness({ candidate: RSI14, prices, targetDefinition });
  const realReport = runAutomatedConfirmationTest({ candidate: RSI14, prices, targetDefinition, seed: 1, permutations: 100, bootstrapResamples: 100 });
  assert.equal(readiness.usableObservations, realReport.sampleSize);
});

test('computeCandidateReadiness: works across RSI, EMA_SLOPE, and CCI indicator types', () => {
  const prices = makeWalkPrices(300);
  const targetDefinition = { direction: 'Rise', runLength: 5 };
  for (const spec of [
    { id: 'a', indicatorName: 'RSI', period: 14 },
    { id: 'b', indicatorName: 'EMA_SLOPE', period: 10 },
    { id: 'c', indicatorName: 'CCI', period: 20 },
  ]) {
    const readiness = computeCandidateReadiness({ candidate: spec, prices, targetDefinition });
    assert.equal(readiness.indicatorName, spec.indicatorName);
    assert.equal(readiness.ready, true);
  }
});

test('computeCandidateReadiness: with zero prices, reports zero usable observations and a full remaining-ticks estimate', () => {
  const readiness = computeCandidateReadiness({ candidate: RSI14, prices: [], targetDefinition: { direction: 'Rise', runLength: 5 } });
  assert.equal(readiness.currentTickCount, 0);
  assert.equal(readiness.usableObservations, 0);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.minTicksRequired, 14 + 5 + MIN_ALIGNED_PAIRS);
});

test('computeOverallReadiness: overallReady is true once at least one candidate is ready, even if others are not', () => {
  const prices = makeWalkPrices(300);
  const targetDefinition = { direction: 'Rise', runLength: 5 };
  const readyCandidate = { id: 'ready-1', indicatorName: 'RSI', period: 14 };
  // A deliberately huge period pushes this candidate's lookback past the
  // available data, keeping it genuinely not-ready with the same price series.
  const notReadyCandidate = { id: 'not-ready-1', indicatorName: 'RSI', period: 280 };

  const overall = computeOverallReadiness({ candidates: [readyCandidate, notReadyCandidate], prices, targetDefinition });
  assert.equal(overall.totalCount, 2);
  assert.equal(overall.readyCount, 1);
  assert.equal(overall.overallReady, true);
  assert.ok(overall.overallReadinessPercentage > 0 && overall.overallReadinessPercentage < 100);
  assert.equal(overall.perCandidate.length, 2);
});

test('computeOverallReadiness: overallReady is false when no candidate has enough data', () => {
  const prices = makeWalkPrices(15);
  const targetDefinition = { direction: 'Rise', runLength: 5 };
  const overall = computeOverallReadiness({ candidates: [RSI14], prices, targetDefinition });
  assert.equal(overall.overallReady, false);
  assert.equal(overall.readyCount, 0);
});

test('computeOverallReadiness: handles an empty candidate list gracefully', () => {
  const overall = computeOverallReadiness({ candidates: [], prices: makeWalkPrices(300), targetDefinition: { direction: 'Rise', runLength: 5 } });
  assert.equal(overall.totalCount, 0);
  assert.equal(overall.overallReady, false);
  assert.equal(overall.overallReadinessPercentage, 0);
});

test('does not modify any statistical logic: never imports the permutation test, bootstrap, or Online FDR modules', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11ConfirmationReadiness.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*permutationTest\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*uncertaintyEstimation\.js['"]/.test(src));
  assert.match(src, /import\s*\{\s*computeIndicatorSeries,\s*computeOutcomeSeries,\s*MIN_ALIGNED_PAIRS\s*\}\s*from\s*'\.\/Phase11AutomatedConfirmation\.js'/);
});
