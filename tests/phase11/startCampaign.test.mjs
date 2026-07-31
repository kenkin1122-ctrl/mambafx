/**
 * tests/phase11/startCampaign.test.mjs
 *
 * Verifies the "Start Phase 11 Campaign" bootstrap: builds a real, locked
 * research cycle and generates real candidates from it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startPhase11Campaign,
  DEFAULT_INDICATOR_CANDIDATES,
  runPhase11Screening,
  runPhase11Triage,
} from '../../research/src/orchestration/startPhase11Campaign.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

test('startPhase11Campaign: builds a real research cycle and generates the default candidates', async () => {
  const { orchestrator, researchConfiguration, researchFreeze, sap, familyRegistry, generated } =
    await startPhase11Campaign();

  assert.ok(researchConfiguration.configHash);
  assert.equal(researchFreeze.researchConfigurationId, researchConfiguration.id);
  assert.ok(sap.sapId);
  assert.ok(familyRegistry.isRegistered('momentum'));
  assert.equal(generated.length, DEFAULT_INDICATOR_CANDIDATES.length);

  for (const { candidate, provenance } of generated) {
    assert.equal(candidate.type, CANDIDATE_TYPES.INDICATOR_FEATURE);
    assert.equal(candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
    assert.equal(candidate.researchFreezeId, researchFreeze.id);
    assert.equal(candidate.sapId, sap.sapId);
    assert.ok(candidate.fingerprint);
    assert.ok(provenance.hasNode(candidate.id));
  }

  assert.equal(orchestrator.listCandidates().length, DEFAULT_INDICATOR_CANDIDATES.length);
  assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, DEFAULT_INDICATOR_CANDIDATES.length);
});

test('startPhase11Campaign: accepts a custom indicator candidate list', async () => {
  const custom = [
    { id: 'rsi-7-close', indicatorName: 'RSI', period: 7, signalLine: null, inputField: 'close', description: 'RSI-7 on close' },
  ];
  const { generated } = await startPhase11Campaign({ indicatorCandidates: custom });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].candidate.id, 'rsi-7-close');
});

test('startPhase11Campaign: rebuilds the freeze to include generated candidates\' fingerprints (ReproducibilityGate precondition)', async () => {
  const { researchFreeze, generated, orchestrator } = await startPhase11Campaign();
  for (const { candidate } of generated) {
    assert.ok(researchFreeze.candidateFingerprints.includes(candidate.fingerprint));
    assert.equal(candidate.researchFreezeId, researchFreeze.id);
    // The orchestrator's own registry was updated to match, not left stale.
    assert.equal(orchestrator.getCandidate(candidate.id).researchFreezeId, researchFreeze.id);
  }
  assert.equal(orchestrator.researchFreeze.id, researchFreeze.id);
});

test('startPhase11Campaign + runPhase11Screening/Triage: full pipeline with a real, caller-supplied scoreFn', async () => {
  const { orchestrator, generated } = await startPhase11Campaign();
  const candidates = generated.map((g) => g.candidate);

  // A real (if simple) scoreFn: prefer candidates with a smaller period,
  // just to exercise real ranking logic rather than a constant.
  const scoreFn = (c) => -(c.parameters.period ?? 0);

  const { promoted } = runPhase11Screening({
    candidates, scoreFn, promotionPolicy: orchestrator.promotionPolicy,
    familyRegistry: orchestrator.familyRegistry, promotionQuantile: 1,
  });
  assert.equal(promoted.length, candidates.length); // quantile 1 promotes everyone
  for (const c of promoted) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.SCREENED);

  const diagnosticsByCandidateId = {};
  for (const c of promoted) diagnosticsByCandidateId[c.id] = { effectSize: 0.01, diagnosticsPassed: [] };
  const { promoted: triaged } = runPhase11Triage({
    promotionPolicy: orchestrator.promotionPolicy, candidates: promoted, diagnosticsByCandidateId,
  });
  assert.equal(triaged.length, candidates.length);
  for (const c of triaged) assert.equal(c.lifecycle, PHASE11_LIFECYCLE_STAGES.TRIAGED);
});
