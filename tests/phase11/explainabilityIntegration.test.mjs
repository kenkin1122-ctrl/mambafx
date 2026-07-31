/**
 * tests/phase11/explainabilityIntegration.test.mjs
 *
 * Verifies Part 1 §2: ExplainabilityEngine, wired through
 * Phase11Orchestrator.explain(), consumes evidence tier, implementation
 * maturity, importance scores, confidence interval, discovery stability,
 * ResearchFreeze/SAP identity, and the DecisionAuditLog trail -- without
 * duplicating any of that logic itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { createMathDefinition } from '../../research/src/plugin/MachineReadableMathematics.js';
import { scoreImportance } from '../../research/src/analysis/ImportanceScorer.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-explain-001', name: 'Explainability test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
  });
}
async function makeFreeze(rc) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
}
async function makeSap() {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-explain-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.03 },
    promotionPolicies: {}, stoppingRules: [], replicationCriteria: {}, publicationCriteria: {},
    effectSizeThresholds: { default: 0.1 }, minimumSampleSizes: { default: 200 }, requiredDiagnostics: [],
  });
}

function makeMathDef() {
  return createMathDefinition({
    humanReadable: 'normalizedPosition = (close - low) / (high - low)',
    symbolicExpression: '\\frac{close - low}{high - low}',
    executableFormula: (input) => (input.close - input.low) / (input.high - input.low),
    units: 'dimensionless',
    domain: 'close, high, low real-valued with high >= low',
    range: '[0, 1]',
  });
}

test('Phase11Orchestrator.explain: pulls in the DecisionAuditLog trail and assembles a full explanation', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });

  const [{ candidate }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id: 'expl-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
      description: 'RSI-14 test candidate', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });

  // Advance to Confirmed so ImportanceScorer will accept it.
  const confirmed = withPhase11Lifecycle(
    withPhase11Lifecycle(withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED), PHASE11_LIFECYCLE_STAGES.TRIAGED),
    PHASE11_LIFECYCLE_STAGES.CONFIRMED
  );

  const stability = orchestrator.computeStability([0.1, 0.12, 0.09, 0.11], 0.1);
  const { scientificImportance, tradingImportance } = scoreImportance(confirmed, {
    noveltyScore: 0.6, effectSize: 0.1, discoveryStabilityIndex: stability.stabilityIndex, evidenceTierWeight: 0.5,
  });

  const explanation = orchestrator.explain(confirmed, {
    plainEnglishSummary: 'RSI-14 shows elevated readings before up-runs. This is a modest, stable effect.',
    mathDefinition: makeMathDef(),
    contextDescription: 'High-volatility regime.',
    interpretation: 'A PRNG-driven statistical association, not market-structure evidence.',
    knownLimitations: ['Small sample'],
    uncertainty: { estimate: 0.1, se: 0.02, ci95: [0.06, 0.14], sampleSize: 400, replicationCount: 0 },
    scientificImportance,
    tradingImportance,
    discoveryStabilityIndex: stability.stabilityIndex,
  });

  assert.equal(explanation.candidateId, confirmed.id);
  assert.equal(explanation.evidenceTier, confirmed.evidenceTier);
  assert.equal(explanation.implementationMaturity, confirmed.implementationMaturity);
  assert.equal(explanation.scientificImportance, scientificImportance);
  assert.equal(explanation.tradingImportance, tradingImportance);
  assert.equal(explanation.discoveryStabilityIndex, stability.stabilityIndex);
  assert.match(explanation.disclaimer, /PRNG/);
  // decisionAuditTrailRef should include the GENERATED entry recorded during orchestrator.generate().
  assert.ok(explanation.decisionAuditTrailRef.some(e => e.decisionType === 'GENERATED'));
});

test('Phase11Orchestrator.explain: does not duplicate ExplainabilityEngine validation logic (delegates entirely)', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/orchestration/Phase11Orchestrator.js', import.meta.url), 'utf8'
  ));
  assert.match(src, /import\s*\{\s*explainCandidate\s*\}\s*from\s*'\.\.\/interpretation\/ExplainabilityEngine\.js'/);
  // No inline math/uncertainty validation reimplemented in the orchestrator itself.
  assert.ok(!/humanReadable/.test(src), 'orchestrator must not reimplement math-definition validation');
});
