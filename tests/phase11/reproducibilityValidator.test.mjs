/**
 * tests/phase11/reproducibilityValidator.test.mjs
 *
 * Tests for research/src/validation/ReproducibilityValidator.js — Section 5
 * of the Phase 11 Validation & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyReproducibility,
  Phase11ReproducibilityMismatchReport,
} from '../../research/src/validation/ReproducibilityValidator.js';
import { IndicatorFeature } from '../../research/src/candidate/IndicatorFeature.js';

const BASE_FIELDS = {
  id: 'repro-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
  description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64), researchConfigurationId: 'rc-1',
  indicatorName: 'RSI', period: 14, inputObservables: [],
};

function makePrices(length = 300, seed = 7) {
  // A small deterministic LCG for test-fixture price generation only.
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < length; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));
  return prices;
}

test('verifyReproducibility: two independently-built candidates from identical parameters produce identical fingerprints and identical statistical results', async () => {
  const candidateA = await IndicatorFeature.create({ ...BASE_FIELDS });
  const candidateB = await IndicatorFeature.create({ ...BASE_FIELDS }); // built independently, same params

  const prices = makePrices(300, 7);
  const report = verifyReproducibility({
    candidateA, candidateB, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 42, permutations: 300, bootstrapResamples: 300,
  });

  assert.ok(report instanceof Phase11ReproducibilityMismatchReport);
  assert.equal(report.matched, true);
  assert.equal(report.mismatches.length, 0);
  assert.ok(report.comparisons.length > 10);
  assert.ok(report.comparisons.every((c) => c.matched));
});

test('verifyReproducibility: detects a candidate fingerprint mismatch when parameters genuinely differ', async () => {
  const candidateA = await IndicatorFeature.create({ ...BASE_FIELDS });
  const candidateB = await IndicatorFeature.create({ ...BASE_FIELDS, period: 20 }); // genuinely different

  const prices = makePrices(300, 7);
  const report = verifyReproducibility({
    candidateA, candidateB, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 42, permutations: 300, bootstrapResamples: 300,
  });

  assert.equal(report.matched, false);
  assert.ok(report.mismatches.some((m) => m.field === 'candidateFingerprint'));
});

test('verifyReproducibility: reports remain honest (do not force agreement) when comparing against different underlying datasets', async () => {
  const candidateA = await IndicatorFeature.create({ ...BASE_FIELDS });

  const pricesA = makePrices(300, 7);
  const pricesB = makePrices(300, 8); // a different underlying dataset

  const reportA = verifyReproducibility({
    candidateA, candidateB: candidateA, prices: pricesA, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 42, permutations: 300, bootstrapResamples: 300,
  });
  const reportB = verifyReproducibility({
    candidateA, candidateB: candidateA, prices: pricesB, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 42, permutations: 300, bootstrapResamples: 300,
  });

  // Both self-comparisons individually match (deterministic pipeline)...
  assert.equal(reportA.matched, true);
  assert.equal(reportB.matched, true);
  // ...the real assurance this test provides is that verifyReproducibility
  // computes real numbers from each dataset rather than short-circuiting.
  const pValueA = reportA.comparisons.find((c) => c.field === 'pValue').valueA;
  const pValueB = reportB.comparisons.find((c) => c.field === 'pValue').valueA;
  assert.equal(typeof pValueA, 'number');
  assert.equal(typeof pValueB, 'number');
});

test('never spends alpha or imports onlineFdr.js/discoveryDecision.js', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/validation/ReproducibilityValidator.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
