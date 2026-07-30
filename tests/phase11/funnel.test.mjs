/**
 * tests/phase11/funnel.test.mjs
 *
 * Unit tests for Phase 11 Phase C discovery-layer additions:
 *   - discovery/candidateGenerator.js
 *   - discovery/phase11FunnelBridge.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateCandidate,
  GeneratorPreconditionError,
} from '../../research/src/discovery/candidateGenerator.js';
import {
  runPhase11Screening,
  runPhase11Triage,
  recordFunnelIntegrationDebt,
} from '../../research/src/discovery/phase11FunnelBridge.js';
import { PromotionPolicy } from '../../research/src/governance/PromotionPolicy.js';
import { DecisionAuditLog, DECISION_TYPES } from '../../research/src/governance/DecisionAuditLog.js';
import { NegativeEvidenceRegistry } from '../../research/src/governance/NegativeEvidenceRegistry.js';
import { ScientificDebtLog, DEBT_STATUS } from '../../research/src/governance/ScientificDebtLog.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-funnel-001',
    name: 'Phase C funnel test campaign',
    description: 'Unit test research configuration',
    grammarVersion: '11.0.0',
    ontologyVersion: '11.0.0',
    generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
    ...overrides,
  });
}

async function makeFreeze(rc, overrides = {}) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id,
    configHash: rc.configHash,
    ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion,
    proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [],
    researchConfigurationHash: 'b'.repeat(64),
    ...overrides,
  });
}

async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-funnel-001',
    hypothesisFamilies: ['momentum'],
    alphaAllocation: { momentum: 0.03 },
    promotionPolicies: { minRound1Score: 0.6 },
    stoppingRules: [{ maxCandidates: 500 }],
    replicationCriteria: { minReplicationBlocks: 3 },
    publicationCriteria: { minReproducibilityLevel: 3 },
    effectSizeThresholds: { default: 0.1 },
    minimumSampleSizes: { default: 200 },
    requiredDiagnostics: ['stationarity'],
    ...overrides,
  });
}

const BASE_CANDIDATE_FIELDS = {
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-funnel-001',
};

// ═══════════════════════════════════════════════════════════════════════════
// candidateGenerator
// ═══════════════════════════════════════════════════════════════════════════

test('generateCandidate: throws GeneratorPreconditionError without a ResearchFreeze', async () => {
  const sap = await makeSap();
  await assert.rejects(
    generateCandidate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParams: { ...BASE_CANDIDATE_FIELDS, id: 'g-1', indicatorName: 'RSI', period: 14, inputObservables: [] },
      researchFreeze: null,
      sap,
    }),
    GeneratorPreconditionError
  );
});

test('generateCandidate: throws GeneratorPreconditionError without a SAP', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  await assert.rejects(
    generateCandidate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParams: { ...BASE_CANDIDATE_FIELDS, id: 'g-2', indicatorName: 'RSI', period: 14, inputObservables: [] },
      researchFreeze: freeze,
      sap: null,
    }),
    GeneratorPreconditionError
  );
});

test('generateCandidate: produces a candidate attached to the given freeze/SAP with provenance', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const auditLog = new DecisionAuditLog();

  const { candidate, provenance } = await generateCandidate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParams: { ...BASE_CANDIDATE_FIELDS, id: 'g-3', indicatorName: 'RSI', period: 14, inputObservables: [] },
    researchFreeze: freeze,
    sap,
    decisionAuditLog: auditLog,
  });

  assert.equal(candidate.researchFreezeId, freeze.id);
  assert.equal(candidate.sapId, sap.sapId);
  assert.ok(provenance.hasNode(candidate.id));
  assert.ok(provenance.hasNode(freeze.id));
  assert.ok(provenance.hasNode(sap.sapId));

  const generatedEntries = auditLog.forCandidate(candidate.id).filter(e => e.decisionType === DECISION_TYPES.GENERATED);
  assert.equal(generatedEntries.length, 1);
});

test('generateCandidate: overrides any caller-supplied researchFreezeId/sapId with the active ones', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();

  const { candidate } = await generateCandidate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParams: {
      ...BASE_CANDIDATE_FIELDS, id: 'g-4', indicatorName: 'RSI', period: 14, inputObservables: [],
      researchFreezeId: 'some-other-freeze', sapId: 'some-other-sap',
    },
    researchFreeze: freeze,
    sap,
  });

  assert.equal(candidate.researchFreezeId, freeze.id);
  assert.equal(candidate.sapId, sap.sapId);
});

test('generateCandidate: throws GeneratorPreconditionError for a FamilyRegistry-incompatible candidate', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({
    familyName: 'momentum',
    version: '1.0.0',
    allowedCandidateTypes: [CANDIDATE_TYPES.MARKET_STATE], // IndicatorFeature not allowed
  });

  await assert.rejects(
    generateCandidate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParams: { ...BASE_CANDIDATE_FIELDS, id: 'g-5', indicatorName: 'RSI', period: 14, inputObservables: [] },
      researchFreeze: freeze,
      sap,
      familyRegistry,
    }),
    GeneratorPreconditionError
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// phase11FunnelBridge
// ═══════════════════════════════════════════════════════════════════════════

async function makeIndicatorFeatures(rc, freeze, sap, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { candidate } = await generateCandidate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParams: {
        ...BASE_CANDIDATE_FIELDS, id: `fb-${i}`, parameters: { threshold: i },
        indicatorName: 'RSI', period: 14, inputObservables: [],
      },
      researchFreeze: freeze,
      sap,
    });
    out.push(candidate);
  }
  return out;
}

test('runPhase11Screening: excludes family-incompatible candidates before ranking', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const candidates = await makeIndicatorFeatures(rc, freeze, sap, 5);

  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({
    familyName: 'momentum',
    version: '1.0.0',
    allowedCandidateTypes: [CANDIDATE_TYPES.MARKET_STATE], // excludes all IndicatorFeatures
  });

  const policy = new PromotionPolicy(sap, new DecisionAuditLog(), new NegativeEvidenceRegistry());
  const { promoted, excludedIncompatible } = runPhase11Screening({
    candidates,
    scoreFn: (c) => candidates.indexOf(c),
    promotionPolicy: policy,
    familyRegistry,
    promotionQuantile: 0.5,
  });

  assert.equal(excludedIncompatible.length, 5);
  assert.equal(promoted.length, 0);
});

test('runPhase11Screening: ranks and promotes compatible candidates', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const candidates = await makeIndicatorFeatures(rc, freeze, sap, 6);

  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({
    familyName: 'momentum',
    version: '1.0.0',
    allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE],
  });

  const policy = new PromotionPolicy(sap, new DecisionAuditLog(), new NegativeEvidenceRegistry());
  const { promoted, rejected, excludedIncompatible } = runPhase11Screening({
    candidates,
    scoreFn: (c) => candidates.indexOf(c),
    promotionPolicy: policy,
    familyRegistry,
    promotionQuantile: (1 / 3),
  });

  assert.equal(excludedIncompatible.length, 0);
  assert.equal(promoted.length, 2);
  assert.equal(rejected.length, 4);
  for (const c of promoted) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.SCREENED);
});

test('runPhase11Triage: thin pass-through to PromotionPolicy.evaluateTriage', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const [screened] = await makeIndicatorFeatures(rc, freeze, sap, 1);
  const advanced = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.SCREENED);

  const policy = new PromotionPolicy(sap, new DecisionAuditLog(), new NegativeEvidenceRegistry());
  const { promoted } = runPhase11Triage({
    promotionPolicy: policy,
    candidates: [advanced],
    diagnosticsByCandidateId: { [advanced.id]: { effectSize: 0.5, diagnosticsPassed: ['stationarity'] } },
  });

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].lifecycle, PHASE11_LIFECYCLE_STAGES.TRIAGED);
});

test('recordFunnelIntegrationDebt: records exactly one OPEN debt item, idempotently', () => {
  const debtLog = new ScientificDebtLog();
  const first = recordFunnelIntegrationDebt(debtLog);
  const second = recordFunnelIntegrationDebt(debtLog); // second call: already exists
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(debtLog.listOpen().filter(i => i.id === 'phase11-funnel-db-integration').length, 1);
  assert.equal(debtLog.listOpen()[0].status, DEBT_STATUS.OPEN);
});
