/**
 * tests/phase11/orchestrator.test.mjs
 *
 * Unit tests for Phase 11 Phase D orchestration layer:
 *   - orchestration/Phase11Orchestrator.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Phase11Orchestrator,
  NotYetIntegratedError,
} from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ScientificDebtLog, DEBT_STATUS } from '../../research/src/governance/ScientificDebtLog.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-orch-001',
    name: 'Orchestrator test campaign',
    description: 'test',
    grammarVersion: '11.0.0',
    ontologyVersion: '11.0.0',
    generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
  });
}

async function makeFreeze(rc) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id,
    configHash: rc.configHash,
    ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion,
    proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [],
    researchConfigurationHash: 'b'.repeat(64),
  });
}

async function makeSap() {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-orch-001',
    hypothesisFamilies: ['momentum'],
    alphaAllocation: { momentum: 0.03 },
    promotionPolicies: { minRound1Score: 0.6 },
    stoppingRules: [{ maxCandidates: 500 }],
    replicationCriteria: { minReplicationBlocks: 3 },
    publicationCriteria: { minReproducibilityLevel: 3 },
    effectSizeThresholds: { default: 0.1 },
    minimumSampleSizes: { default: 200 },
    requiredDiagnostics: ['stationarity'],
  });
}

const BASE_CANDIDATE_FIELDS = {
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-orch-001',
};

test('Phase11Orchestrator: throws without ResearchFreeze', async () => {
  const sap = await makeSap();
  assert.throws(() => new Phase11Orchestrator({ researchFreeze: null, sap }), NotYetIntegratedError);
});

test('Phase11Orchestrator: throws without SAP', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  assert.throws(() => new Phase11Orchestrator({ researchFreeze: freeze, sap: null }), NotYetIntegratedError);
});

test('Phase11Orchestrator: records the funnel integration debt item once at construction', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const debtLog = new ScientificDebtLog();

  new Phase11Orchestrator({ researchFreeze: freeze, sap, debtLog });
  new Phase11Orchestrator({ researchFreeze: freeze, sap, debtLog }); // second instance: idempotent

  const items = debtLog.listOpen().filter(i => i.id === 'phase11-funnel-db-integration');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, DEBT_STATUS.OPEN);
});

test('Phase11Orchestrator: full pipeline — generate, screen, triage', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({
    familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE],
  });

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

  const candidateParamsList = Array.from({ length: 6 }, (_, i) => ({
    ...BASE_CANDIDATE_FIELDS, id: `orch-${i}`, parameters: { threshold: i },
    indicatorName: 'RSI', period: 14, inputObservables: [],
  }));

  const generated = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList,
  });
  assert.equal(generated.length, 6);
  const candidates = generated.map(g => g.candidate);
  for (const c of candidates) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);

  const { promoted: screened, rejected } = orchestrator.screen({
    candidates,
    scoreFn: (c) => candidates.indexOf(c),
    promotionQuantile: 1 / 3,
  });
  assert.equal(screened.length, 2);
  assert.equal(rejected.length, 4);
  for (const c of screened) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.SCREENED);

  const diagnosticsByCandidateId = {};
  for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.5, diagnosticsPassed: ['stationarity'] };
  const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });
  assert.equal(triaged.length, 2);
  for (const c of triaged) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.TRIAGED);
});
