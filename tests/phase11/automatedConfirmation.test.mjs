/**
 * tests/phase11/automatedConfirmation.test.mjs
 *
 * Tests for research/src/bridge/Phase11AutomatedConfirmation.js — verifies
 * the fully automated statistical pipeline (no manual p-value entry):
 * indicator computation, outcome computation, the permutation test +
 * bootstrap CI composition, graceful failure on insufficient data, and
 * full integration with the existing Phase11ConfirmationBridge.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  openExistingDbExtended,
  _resetConnectionCacheForTesting as _resetExistingDbCacheForTesting,
} from '../../research/src/storage/existingDbExtensions.js';
import { _resetKnownFamiliesForTesting } from '../../research/src/governance/family.js';

import {
  computeIndicatorSeries,
  computeOutcomeSeries,
  runAutomatedConfirmationTest,
  confirmPhase11CandidateAutomatically,
  Phase11InsufficientDataError,
} from '../../research/src/bridge/Phase11AutomatedConfirmation.js';
import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { listWealthHistory } from '../../research/src/governance/onlineFdr.js';

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

import { createSeededRng } from '../../research/src/statistics/uncertaintyEstimation.js';

// A price series with a real, aperiodic trending structure: rising/falling
// legs of RANDOMISED length (via a seeded RNG), so the pattern isn't
// reducible to phase-shift/periodicity alone -- an exactly-periodic
// sawtooth would (correctly) survive a circular-shift null just as well at
// many shift amounts, since the null model is specifically designed to
// catch cyclical/seasonal confounds. Randomised leg lengths give RSI a
// genuine, non-cyclical relationship to detect.
function makeTrendingPrices(cycles = 20, seed = 1) {
  const rng = createSeededRng(seed);
  const prices = [100];
  for (let c = 0; c < cycles; c++) {
    const upLen = 15 + Math.floor(rng() * 15);   // 15-29 ticks
    const downLen = 15 + Math.floor(rng() * 15); // 15-29 ticks
    for (let i = 0; i < upLen; i++) prices.push(prices[prices.length - 1] + 1);
    for (let i = 0; i < downLen; i++) prices.push(prices[prices.length - 1] - 1);
  }
  return prices;
}

// A price series that alternates up/down every single tick -- no
// persistent trend for RSI to track, and forward 3-tick pure-rise runs
// never occur at all (every other tick is a fall) -- a genuine null case.
function makeAlternatingPrices(n = 500) {
  const prices = [100];
  for (let i = 0; i < n; i++) prices.push(prices[prices.length - 1] + (i % 2 === 0 ? 1 : -1));
  return prices;
}

// ═══════════════════════════════════════════════════════════════════════════
// Indicator / outcome computation
// ═══════════════════════════════════════════════════════════════════════════

test('computeIndicatorSeries: RSI produces values in [0, 100] after the lookback period', () => {
  const prices = makeTrendingPrices(5);
  const rsi = computeIndicatorSeries('RSI', 14, prices);
  const valid = rsi.filter(Number.isFinite);
  assert.ok(valid.length > 0);
  for (const v of valid) assert.ok(v >= 0 && v <= 100);
});

test('computeIndicatorSeries: EMA_SLOPE is positive during the rising leg and negative during the falling leg', () => {
  const prices = makeTrendingPrices(1);
  const slope = computeIndicatorSeries('EMA_SLOPE', 5, prices);
  assert.ok(slope[10] > 0);  // well into the rising leg
  assert.ok(slope[30] < 0);  // well into the falling leg
});

test('computeIndicatorSeries: CCI produces finite numeric values after the lookback period', () => {
  const prices = makeTrendingPrices(5);
  const cci = computeIndicatorSeries('CCI', 20, prices);
  const valid = cci.filter(Number.isFinite);
  assert.ok(valid.length > 0);
});

test('computeIndicatorSeries: throws for an unrecognised indicator name', () => {
  assert.throws(() => computeIndicatorSeries('NOT_REAL', 14, [1, 2, 3]), Phase11InsufficientDataError);
});

test('computeOutcomeSeries: correctly identifies a 3-tick pure rise run', () => {
  const prices = [10, 11, 12, 13, 12, 11, 10];
  const outcome = computeOutcomeSeries(prices, { direction: 'Rise', runLength: 3 });
  assert.equal(outcome[0], 1); // 10->11->12->13, all rises
  assert.equal(outcome[3], 0); // 13->12->11->10, all falls, not a rise run
});

// ═══════════════════════════════════════════════════════════════════════════
// runAutomatedConfirmationTest
// ═══════════════════════════════════════════════════════════════════════════

test('runAutomatedConfirmationTest: throws Phase11InsufficientDataError for a too-short price series, with a specific explanation', () => {
  const candidate = { indicatorName: 'RSI', period: 14 };
  assert.throws(
    () => runAutomatedConfirmationTest({
      candidate, prices: makeTrendingPrices(1).slice(0, 20), // far too short
      targetDefinition: { direction: 'Rise', runLength: 5 }, seed: 42,
    }),
    (err) => err instanceof Phase11InsufficientDataError && /valid \(indicator, outcome\) pairs/.test(err.message)
  );
});

test('runAutomatedConfirmationTest: returns a complete statistical report with all required fields', () => {
  const candidate = { indicatorName: 'RSI', period: 14 };
  const report = runAutomatedConfirmationTest({
    candidate, prices: makeTrendingPrices(20),
    targetDefinition: { direction: 'Rise', runLength: 3 }, seed: 42, permutations: 200, bootstrapResamples: 200,
  });
  assert.equal(typeof report.observedStatistic, 'number');
  assert.equal(typeof report.effectSize, 'number');
  assert.equal(typeof report.standardError, 'number');
  assert.equal(report.ci95.length, 2);
  assert.ok(typeof report.pValue === 'number' && report.pValue >= 0 && report.pValue <= 1);
  assert.ok(report.sampleSize >= 60);
  assert.equal(report.nullModel, 'circular_shift');
  assert.equal(report.seed, 42);
});

test('runAutomatedConfirmationTest: a genuinely trending series produces a lower p-value than a null-like alternating series', () => {
  const candidate = { indicatorName: 'RSI', period: 14 };
  const trendingReport = runAutomatedConfirmationTest({
    candidate, prices: makeTrendingPrices(40, 7),
    targetDefinition: { direction: 'Rise', runLength: 3 }, seed: 7, permutations: 1000,
  });
  const nullReport = runAutomatedConfirmationTest({
    candidate, prices: makeAlternatingPrices(1200),
    targetDefinition: { direction: 'Rise', runLength: 3 }, seed: 7, permutations: 1000,
  });
  assert.ok(trendingReport.pValue < nullReport.pValue,
    `expected trending p=${trendingReport.pValue} < null-like p=${nullReport.pValue}`);
  assert.ok(trendingReport.pValue < 0.2, `expected a clearly low p-value for the trending series, got ${trendingReport.pValue}`);
  assert.ok(nullReport.pValue > 0.3, `expected a clearly high p-value for the null-like alternating series, got ${nullReport.pValue}`);
});

test('runAutomatedConfirmationTest: reports permutation and bootstrap diagnostics derived from the real null distribution', () => {
  const candidate = { indicatorName: 'RSI', period: 14 };
  const report = runAutomatedConfirmationTest({
    candidate, prices: makeTrendingPrices(20, 3),
    targetDefinition: { direction: 'Rise', runLength: 3 }, seed: 5, permutations: 300, bootstrapResamples: 300,
  });
  assert.equal(typeof report.nullMean, 'number');
  assert.ok(report.nullVariance >= 0);
  assert.equal(typeof report.monteCarloStandardError, 'number');
  assert.equal(report.minAttainablePValue, 1 / 301);
  assert.ok(report.bootstrapCiWidth >= 0);
  assert.equal(typeof report.bootstrapSkewness, 'number');
  assert.ok(report.instabilityWarning === null || typeof report.instabilityWarning === 'string');
});

test('runAutomatedConfirmationTest: accepts pre-computed featureValues/outcomeValues directly, bypassing price-derived computation', () => {
  const featureValues = Array.from({ length: 100 }, (_, i) => Math.sin(i));
  const outcomeValues = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const report = runAutomatedConfirmationTest({
    featureValues, outcomeValues, seed: 11, permutations: 200,
  });
  assert.equal(report.sampleSize, 100);
  assert.ok(typeof report.pValue === 'number');
});

test('runAutomatedConfirmationTest: throws for mismatched injected featureValues/outcomeValues lengths', () => {
  assert.throws(() => runAutomatedConfirmationTest({
    featureValues: [1, 2, 3], outcomeValues: [1, 0], seed: 1,
  }), Phase11InsufficientDataError);
});

test('runAutomatedConfirmationTest: is deterministic for a fixed seed (no hidden randomness)', () => {
  const candidate = { indicatorName: 'RSI', period: 14 };
  const params = {
    candidate, prices: makeTrendingPrices(20),
    targetDefinition: { direction: 'Rise', runLength: 3 }, seed: 99, permutations: 200,
  };
  const a = runAutomatedConfirmationTest(params);
  const b = runAutomatedConfirmationTest(params);
  assert.deepEqual(a, b);
});

// ═══════════════════════════════════════════════════════════════════════════
// Full integration: confirmPhase11CandidateAutomatically
// ═══════════════════════════════════════════════════════════════════════════

test('confirmPhase11CandidateAutomatically: computes a real p-value and submits it through the unmodified confirmation bridge, spending alpha exactly once', async () => {
  const teardown = await setup();
  try {
    const rc = await ResearchConfiguration.create({
      id: 'rc-autoconf-001', name: 'test', description: 'test',
      grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
      proxyVersions: { msd: '1.0.0' },
    });
    const sap = await StatisticalAnalysisPlan.create({
      sapId: 'sap-autoconf-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
      promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
      publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
    });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const freeze = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
      candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const [{ candidate: draft, provenance }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'autoconf-cand-1', family: 'momentum', parameters: { threshold: 0.5, period: 14 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });
    const triaged = withPhase11Lifecycle(withPhase11Lifecycle(draft, PHASE11_LIFECYCLE_STAGES.SCREENED), PHASE11_LIFECYCLE_STAGES.TRIAGED);

    const result = await confirmPhase11CandidateAutomatically({
      candidate: triaged, researchFreeze: freeze, sap, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-autoconf-001' }, provenance, familyRegistry,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 3 },
      prices: makeTrendingPrices(20), seed: 123, permutations: 300,
    });

    assert.ok(['confirmed', 'rejected'].includes(result.outcome));
    assert.ok(result.statisticalReport);
    assert.ok(typeof result.statisticalReport.pValue === 'number');

    // Alpha spent exactly once, using the COMPUTED p-value (not a manual one).
    const wealthHistory = await listWealthHistory(result.familyKey);
    assert.equal(wealthHistory.length, 1);
    assert.equal(wealthHistory[0].pValue, result.statisticalReport.pValue);

    const legacyStage = await getCurrentLifecycleStage(result.hypothesisId);
    assert.ok([LIFECYCLE_STAGES.FEATURE_GENERATION, LIFECYCLE_STAGES.DISCOVERY].includes(legacyStage));
  } finally {
    teardown();
  }
});

test('confirmPhase11CandidateAutomatically: propagates Phase11InsufficientDataError before touching the legacy pipeline at all', async () => {
  const teardown = await setup();
  try {
    const rc = await ResearchConfiguration.create({
      id: 'rc-autoconf-002', name: 'test', description: 'test',
      grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
      proxyVersions: { msd: '1.0.0' },
    });
    const sap = await StatisticalAnalysisPlan.create({
      sapId: 'sap-autoconf-002', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
      promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
      publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
    });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const freeze = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
      candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const [{ candidate: draft, provenance }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'autoconf-cand-2', family: 'momentum', parameters: { threshold: 0.5, period: 14 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });
    const triaged = withPhase11Lifecycle(withPhase11Lifecycle(draft, PHASE11_LIFECYCLE_STAGES.SCREENED), PHASE11_LIFECYCLE_STAGES.TRIAGED);

    await assert.rejects(confirmPhase11CandidateAutomatically({
      candidate: triaged, researchFreeze: freeze, sap, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-autoconf-002' }, provenance, familyRegistry,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 3 },
      prices: [100, 101, 102], seed: 1, // far too short
    }), Phase11InsufficientDataError);

    assert.equal(await getCurrentLifecycleStage(`ph11_${triaged.fingerprint}`), null);
  } finally {
    teardown();
  }
});

test('never implements its own alpha spending or duplicates Online FDR logic', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11AutomatedConfirmation.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
  assert.match(src, /import\s*\{\s*confirmPhase11Candidate\s*\}\s*from\s*'\.\/Phase11ConfirmationBridge\.js'/);
});
