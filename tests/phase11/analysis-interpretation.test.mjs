/**
 * tests/phase11/analysis-interpretation.test.mjs
 *
 * Unit tests for Phase 11 Phase D analysis/interpretation layer:
 *   - analysis/DiscoveryStabilityAnalysis.js
 *   - analysis/ImportanceScorer.js
 *   - interpretation/ExplainabilityEngine.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDiscoveryStabilityIndex,
  InvalidStabilityInputError,
} from '../../research/src/analysis/DiscoveryStabilityAnalysis.js';
import {
  scoreImportance,
  ImportanceScoringPreconditionError,
  InvalidImportanceInputError,
} from '../../research/src/analysis/ImportanceScorer.js';
import {
  explainCandidate,
  InvalidExplanationInputError,
} from '../../research/src/interpretation/ExplainabilityEngine.js';
import { createMathDefinition } from '../../research/src/plugin/MachineReadableMathematics.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { IndicatorFeature } from '../../research/src/candidate/IndicatorFeature.js';
import { PRIMITIVE_OBSERVABLES } from '../../research/src/candidate/MeasurementRegistry.js';

const BASE_FIELDS = {
  id: 'stab-cand-001',
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-001',
};

async function makeConfirmedCandidate() {
  const c = await IndicatorFeature.create({
    ...BASE_FIELDS,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
  });
  const screened = withPhase11Lifecycle(c, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  return withPhase11Lifecycle(triaged, PHASE11_LIFECYCLE_STAGES.CONFIRMED);
}

// ═══════════════════════════════════════════════════════════════════════════
// DiscoveryStabilityAnalysis
// ═══════════════════════════════════════════════════════════════════════════

test('computeDiscoveryStabilityIndex: perfect agreement gives stabilityIndex of 1', () => {
  const result = computeDiscoveryStabilityIndex([0.1, 0.1, 0.1, 0.1], 0.1);
  assert.equal(result.stabilityIndex, 1);
  assert.equal(result.signAgreementFraction, 1);
  assert.equal(result.majoritySign, 1);
});

test('computeDiscoveryStabilityIndex: sign flips reduce stability', () => {
  const result = computeDiscoveryStabilityIndex([0.1, -0.1, 0.1, -0.1], 0.05);
  assert.ok(result.stabilityIndex < 1);
  assert.equal(result.signAgreementFraction, 0.5);
});

test('computeDiscoveryStabilityIndex: wildly inconsistent magnitude reduces stability even with consistent sign', () => {
  const result = computeDiscoveryStabilityIndex([0.01, 5.0, 0.02, 4.5], 0.02);
  assert.equal(result.signAgreementFraction, 1);
  assert.ok(result.magnitudeConsistency < 1);
  assert.ok(result.stabilityIndex < 1);
});

test('computeDiscoveryStabilityIndex: throws on fewer than 2 partitions', () => {
  assert.throws(() => computeDiscoveryStabilityIndex([0.1], 0.1), InvalidStabilityInputError);
});

test('computeDiscoveryStabilityIndex: throws on non-finite input', () => {
  assert.throws(() => computeDiscoveryStabilityIndex([0.1, NaN], 0.1), InvalidStabilityInputError);
  assert.throws(() => computeDiscoveryStabilityIndex([0.1, 0.2], NaN), InvalidStabilityInputError);
});

test('computeDiscoveryStabilityIndex: result is always within [0, 1]', () => {
  const cases = [
    [[1, 2, 3, 100], 1],
    [[-1, -2, -3], -2],
    [[0, 0, 0], 0],
  ];
  for (const [partitions, pooled] of cases) {
    const { stabilityIndex } = computeDiscoveryStabilityIndex(partitions, pooled);
    assert.ok(stabilityIndex >= 0 && stabilityIndex <= 1, `stabilityIndex ${stabilityIndex} out of range`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ImportanceScorer
// ═══════════════════════════════════════════════════════════════════════════

test('scoreImportance: throws ImportanceScoringPreconditionError for a Generated candidate', async () => {
  const c = await IndicatorFeature.create({
    ...BASE_FIELDS, id: 'unconfirmed-1',
    indicatorName: 'RSI', period: 14, inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
  });
  assert.throws(
    () => scoreImportance(c, { noveltyScore: 0.5, effectSize: 0.1, discoveryStabilityIndex: 0.5, evidenceTierWeight: 0.5 }),
    ImportanceScoringPreconditionError
  );
});

test('scoreImportance: throws for Screened and Triaged (still before Confirmed)', async () => {
  const c = await IndicatorFeature.create({
    ...BASE_FIELDS, id: 'partial-1',
    indicatorName: 'RSI', period: 14, inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
  });
  const screened = withPhase11Lifecycle(c, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  const inputs = { noveltyScore: 0.5, effectSize: 0.1, discoveryStabilityIndex: 0.5, evidenceTierWeight: 0.5 };
  assert.throws(() => scoreImportance(screened, inputs), ImportanceScoringPreconditionError);
  assert.throws(() => scoreImportance(triaged, inputs), ImportanceScoringPreconditionError);
});

test('scoreImportance: succeeds for a Confirmed candidate and returns scores in [0,1]', async () => {
  const confirmed = await makeConfirmedCandidate();
  const { scientificImportance, tradingImportance } = scoreImportance(confirmed, {
    noveltyScore: 0.8, effectSize: 0.3, discoveryStabilityIndex: 0.9, evidenceTierWeight: 0.6,
  });
  assert.ok(scientificImportance >= 0 && scientificImportance <= 1);
  assert.ok(tradingImportance >= 0 && tradingImportance <= 1);
});

test('scoreImportance: succeeds for Replicated/Published (later than Confirmed)', async () => {
  const confirmed = await makeConfirmedCandidate();
  const replicated = withPhase11Lifecycle(confirmed, PHASE11_LIFECYCLE_STAGES.REPLICATED);
  const published = withPhase11Lifecycle(replicated, PHASE11_LIFECYCLE_STAGES.PUBLISHED);
  const inputs = { noveltyScore: 0.5, effectSize: 0.2, discoveryStabilityIndex: 0.7, evidenceTierWeight: 0.5 };
  assert.doesNotThrow(() => scoreImportance(replicated, inputs));
  assert.doesNotThrow(() => scoreImportance(published, inputs));
});

test('scoreImportance: throws on out-of-range input scores', async () => {
  const confirmed = await makeConfirmedCandidate();
  assert.throws(
    () => scoreImportance(confirmed, { noveltyScore: 1.5, effectSize: 0.1, discoveryStabilityIndex: 0.5, evidenceTierWeight: 0.5 }),
    InvalidImportanceInputError
  );
});

test('scoreImportance: never imports onlineFdr.js or discoveryDecision.js (static check)', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/analysis/ImportanceScorer.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});

// ═══════════════════════════════════════════════════════════════════════════
// ExplainabilityEngine
// ═══════════════════════════════════════════════════════════════════════════

function makeMathDef() {
  return createMathDefinition({
    humanReadable: 'normalizedPosition = (close - low) / (high - low)',
    symbolicExpression: '\\frac{close - low}{high - low}',
    executableFormula: (input) => (input.close - input.low) / (input.high - input.low),
    units: 'dimensionless',
    domain: 'close, high, low as real-valued prices with high >= low',
    range: '[0, 1]',
  });
}

test('explainCandidate: builds a full explanation with disclaimer and all required sections', async () => {
  const candidate = await makeConfirmedCandidate();
  const explanation = explainCandidate({
    candidate,
    plainEnglishSummary: 'RSI-14 shows elevated readings before 5-tick up-runs. This holds across the sample. Effect size is modest.',
    mathDefinition: makeMathDef(),
    contextDescription: 'High-volatility regime, prior candle bearish.',
    interpretation: 'This is a statistical association in a PRNG-driven series, not evidence of market structure.',
    knownLimitations: ['Small out-of-sample size', 'Not yet independently replicated'],
    uncertainty: { estimate: 0.12, se: 0.03, ci95: [0.06, 0.18], sampleSize: 500, replicationCount: 0 },
    scientificImportance: 0.4,
    tradingImportance: 0.2,
    discoveryStabilityIndex: 0.7,
    operationalTradingNote: 'Consider as one confluence factor only.',
    decisionAuditTrailRef: [{ decisionType: 'CONFIRMED' }],
  });

  assert.equal(explanation.candidateId, candidate.id);
  assert.match(explanation.disclaimer, /PRNG/);
  assert.match(explanation.operationalTradingNote, /OPERATIONAL \/ NON-SCIENTIFIC \/ DEMO ONLY/);
  assert.equal(explanation.uncertainty.sampleSize, 500);
  assert.equal(explanation.mathematics.units, 'dimensionless');
});

test('explainCandidate: throws when plainEnglishSummary exceeds 3 sentences', async () => {
  const candidate = await makeConfirmedCandidate();
  assert.throws(() => explainCandidate({
    candidate,
    plainEnglishSummary: 'One. Two. Three. Four.',
    mathDefinition: makeMathDef(),
    contextDescription: 'ctx',
    interpretation: 'interp',
    knownLimitations: ['a'],
    uncertainty: { estimate: 0.1, se: 0.01, ci95: [0.08, 0.12], sampleSize: 100, replicationCount: 0 },
  }), InvalidExplanationInputError);
});

test('explainCandidate: throws on missing uncertainty fields', async () => {
  const candidate = await makeConfirmedCandidate();
  assert.throws(() => explainCandidate({
    candidate,
    plainEnglishSummary: 'A short summary.',
    mathDefinition: makeMathDef(),
    contextDescription: 'ctx',
    interpretation: 'interp',
    knownLimitations: ['a'],
    uncertainty: { estimate: 0.1 }, // missing se, ci95, sampleSize, replicationCount
  }), InvalidExplanationInputError);
});

test('explainCandidate: throws on invalid mathDefinition', async () => {
  const candidate = await makeConfirmedCandidate();
  assert.throws(() => explainCandidate({
    candidate,
    plainEnglishSummary: 'A short summary.',
    mathDefinition: { humanReadable: 'x' }, // missing required fields
    contextDescription: 'ctx',
    interpretation: 'interp',
    knownLimitations: ['a'],
    uncertainty: { estimate: 0.1, se: 0.01, ci95: [0.08, 0.12], sampleSize: 100, replicationCount: 0 },
  }), InvalidExplanationInputError);
});

test('explainCandidate: accepts null scientificImportance/tradingImportance (pre-scoring candidates)', async () => {
  const candidate = await makeConfirmedCandidate();
  const explanation = explainCandidate({
    candidate,
    plainEnglishSummary: 'A short summary.',
    mathDefinition: makeMathDef(),
    contextDescription: 'ctx',
    interpretation: 'interp',
    knownLimitations: ['a'],
    uncertainty: { estimate: 0.1, se: 0.01, ci95: [0.08, 0.12], sampleSize: 100, replicationCount: 0 },
  });
  assert.equal(explanation.scientificImportance, null);
  assert.equal(explanation.operationalTradingNote, null);
});
