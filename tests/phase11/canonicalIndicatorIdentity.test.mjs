/**
 * tests/phase11/canonicalIndicatorIdentity.test.mjs
 *
 * Regression tests for the "Architectural Repair" directive: proves that
 * demo-generated candidates AND registry-generated candidates resolve
 * indicator identity through the EXACT SAME canonical mechanism
 * (indicator/IndicatorRegistry.js) at every pipeline stage this bug
 * touched -- Readiness and Confirmation -- using a single shared
 * IndicatorRegistry instance passed to both.
 *
 * Root cause this guards against: bridge/Phase11AutomatedConfirmation.js
 * used to contain its own hardcoded RSI/EMA_SLOPE/CCI formulas, entirely
 * disconnected from the Indicator Registry that discovery/
 * registryDrivenCandidateGenerator.js already used for candidate
 * generation. A registry-generated candidate with indicatorName="EMA" (a
 * real, valid, registered indicator) crashed with
 * "unrecognised indicatorName 'EMA'" the moment it reached Readiness or
 * Confirmation, because those functions had never heard of the registry
 * at all -- only their own three-name hardcoded list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators, CORE_INDICATOR_PLUGINS } from '../../research/src/indicator/coreIndicators.js';
import { computeCandidateReadiness } from '../../research/src/bridge/Phase11ConfirmationReadiness.js';
import { runAutomatedConfirmationTest } from '../../research/src/bridge/Phase11AutomatedConfirmation.js';
import { startPhase11Campaign, startRegistryDrivenCampaign } from '../../research/src/orchestration/startPhase11Campaign.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

function makeWalkPrices(length, seed = 7) {
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < length; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));
  return prices;
}

/** Clones a frozen candidate with one field overridden. */
function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

test('THE BUG, reproduced then fixed: a registry-driven candidate with indicatorName "EMA" no longer throws "unrecognised indicatorName" at Readiness or Confirmation', () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const prices = makeWalkPrices(300);

  const emaCandidate = { id: 'ind-EMA-14', indicatorName: 'EMA', period: 14 };

  const readiness = computeCandidateReadiness({
    candidate: emaCandidate, indicatorRegistry, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
  });
  assert.equal(readiness.ready, true);

  const report = runAutomatedConfirmationTest({
    candidate: emaCandidate, indicatorRegistry, prices,
    targetDefinition: { direction: 'Rise', runLength: 5 }, seed: 1, permutations: 200, bootstrapResamples: 200,
  });
  assert.ok(typeof report.pValue === 'number');
});

test('the demo campaign\'s EMA_SLOPE identifier and the registry\'s EMA identifier are both real, distinct, registered plugins -- not aliases of each other', () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);

  const ema = indicatorRegistry.lookup('EMA');
  const emaSlope = indicatorRegistry.lookup('EMA_SLOPE');
  assert.ok(ema && emaSlope, 'both EMA and EMA_SLOPE must be independently registered');
  assert.notEqual(ema, emaSlope);

  const prices = makeWalkPrices(300);
  const emaSignal = ema.compute({ prices, period: 14 }).signal;
  const slopeSignal = emaSlope.compute({ prices, period: 14 }).signal;
  assert.notDeepEqual(emaSignal.filter(Number.isFinite), slopeSignal.filter(Number.isFinite));
});

test('REGRESSION: both demo-generated AND registry-generated candidates resolve indicator readiness through the exact same shared IndicatorRegistry instance', async () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const prices = makeWalkPrices(300);
  const targetDefinition = { direction: 'Rise', runLength: 5 };

  const { generated: demoGenerated } = await startPhase11Campaign({});
  const demoCandidates = demoGenerated.map((g) => g.candidate);
  assert.ok(demoCandidates.some((c) => c.indicatorName === 'EMA_SLOPE'));

  const { orchestrator: registryOrchestrator } = await startRegistryDrivenCampaign({ indicatorPeriods: [14], includeMarketStates: false });
  const registryCandidates = registryOrchestrator.listCandidates();
  assert.ok(registryCandidates.some((c) => c.indicatorName === 'EMA'));

  for (const candidate of [...demoCandidates, ...registryCandidates]) {
    const readiness = computeCandidateReadiness({ candidate, indicatorRegistry, prices, targetDefinition });
    assert.equal(typeof readiness.usableObservations, 'number');
    assert.equal(typeof readiness.ready, 'boolean');
  }
});

test('REGRESSION: both demo-generated AND registry-generated candidates pass through Confirmation (orchestrator.confirmAutomatically) using the exact same shared IndicatorRegistry instance', async () => {
  const teardown = setup();
  try {
    const indicatorRegistry = new IndicatorRegistry();
    registerCoreIndicators(indicatorRegistry);
    const prices = makeWalkPrices(300);

    const { orchestrator: demoOrchestrator, researchConfiguration: demoRc, generated: demoGenerated } = await startPhase11Campaign({});
    const demoCandidate = demoGenerated[0].candidate;
    const demoTriaged = withField(withField(demoCandidate, 'lifecycle', 'Screened'), 'lifecycle', 'Triaged');
    const demoResult = await demoOrchestrator.confirmAutomatically({
      candidate: demoTriaged, researchConfiguration: demoRc, indicatorRegistry,
      datasetManifest: { datasetId: 'ds-demo' }, provenance: demoGenerated[0].provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      prices, seed: 1, permutations: 200, bootstrapResamples: 200,
    });
    assert.ok(['confirmed', 'rejected'].includes(demoResult.outcome), `demo candidate (indicatorName=${demoCandidate.indicatorName}) must resolve, not throw`);

    const { orchestrator: regOrchestrator, researchConfiguration: regRc, provenanceById } = await startRegistryDrivenCampaign({
      indicatorPeriods: [14], includeMarketStates: false,
    });
    const regCandidate = regOrchestrator.listCandidates().find((c) => c.indicatorName === 'EMA');
    assert.ok(regCandidate, 'expected a real EMA candidate from the registry-driven campaign');
    const regTriaged = withField(withField(regCandidate, 'lifecycle', 'Screened'), 'lifecycle', 'Triaged');
    const regResult = await regOrchestrator.confirmAutomatically({
      candidate: regTriaged, researchConfiguration: regRc, indicatorRegistry,
      datasetManifest: { datasetId: 'ds-registry' }, provenance: provenanceById[regCandidate.id],
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      prices, seed: 1, permutations: 200, bootstrapResamples: 200,
    });
    assert.ok(['confirmed', 'rejected'].includes(regResult.outcome), `registry candidate (indicatorName=${regCandidate.indicatorName}) must resolve, not throw`);
  } finally {
    teardown();
  }
});

test('no candidate\'s indicatorName is EVER resolved outside the canonical registry: Phase11AutomatedConfirmation.js contains no hardcoded per-indicator formulas', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/bridge/Phase11AutomatedConfirmation.js', import.meta.url), 'utf8');
  assert.ok(!/indicatorName === 'RSI'/.test(src), 'no hardcoded RSI branch may remain');
  assert.ok(!/indicatorName === 'EMA_SLOPE'/.test(src), 'no hardcoded EMA_SLOPE branch may remain');
  assert.ok(!/indicatorName === 'CCI'/.test(src), 'no hardcoded CCI branch may remain');
  assert.match(src, /indicatorRegistry\.lookup\(indicatorName\)/, 'computeIndicatorSeries must delegate to the canonical registry');
});

test('every core indicator plugin remains reachable from the canonical registry (27+, including EMA_SLOPE)', () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  assert.ok(CORE_INDICATOR_PLUGINS.length >= 27);
  assert.ok(indicatorRegistry.has('EMA_SLOPE'));
  assert.ok(indicatorRegistry.has('EMA'));
  assert.ok(indicatorRegistry.has('RSI'));
  assert.ok(indicatorRegistry.has('CCI'));
});
