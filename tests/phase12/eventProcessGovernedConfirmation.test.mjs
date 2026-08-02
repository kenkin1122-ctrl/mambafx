/**
 * tests/phase12/eventProcessGovernedConfirmation.test.mjs
 *
 * The real end-to-end test for this slice: an EventProcessFeature
 * candidate reaching a genuine, alpha-spent Confirmed (or rejected)
 * state through the exact same legacy hypothesisRegistry/onlineFdr/
 * discoveryDecision/knowledgeGraph path the indicator campaign already
 * uses -- mirroring tests/phase11/confirmationBridge.test.mjs's own
 * setup and assertions exactly, substituting only the candidate type and
 * the new confirmEventProcessFeatureAutomatically() orchestrator method.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

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

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

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

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: `rc-eventproc-${Date.now()}-${Math.random()}`, name: 'Event process governed confirmation test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '12.0.0',
    proxyVersions: {}, ...overrides,
  });
}
async function makeFreeze(rc, overrides = {}) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {},
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64), ...overrides,
  });
}
async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: `sap-eventproc-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['eventProcess'], alphaAllocation: { eventProcess: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 10 },
    requiredDiagnostics: [], ...overrides,
  });
}

async function buildTriagedEventProcessCandidate(orchestrator, rc, featureName, id) {
  const [{ candidate, provenance }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE,
    candidateParamsList: [{
      id, family: 'eventProcess', parameters: {},
      description: `${featureName} test candidate`, generatorVersion: '12.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      featureName, protocolVersion: 'P12-GAP-v1.1.0', extractorVersion: '1.0.0', schemaVersion: '2.0.0',
    }],
  });
  const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  return { triaged, provenance };
}

test('full pipeline: Generate -> Screen -> Triage -> confirmEventProcessFeatureAutomatically -> legacy Discovery -- a genuinely non-Poisson gap series reaches a real, alpha-spent Confirmed state', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedEventProcessCandidate(orchestrator, rc, 'TimeGap', 'eventproc-cand-1');

    assert.equal((await getCurrentLifecycleStage(`ph11_${triaged.fingerprint}`)), null);

    const rng = seededRng(42);
    const gaps = Array.from({ length: 300 }, () => 0.5 + rng()); // uniform, not exponential

    const result = await orchestrator.confirmEventProcessFeatureAutomatically({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-eventproc-001' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      gaps, seed: 999, numSimulations: 500,
    });

    assert.equal(result.hierarchyResult.stagesRun[0].stage, 'Poisson');
    assert.equal(result.pValue, result.hierarchyResult.stagesRun[0].pValue);
    assert.ok(result.pValue < 0.05, 'Stage C should have rejected Poisson for this genuinely non-exponential fixture');
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.CONFIRMED);

    const legacyStage = await getCurrentLifecycleStage(result.hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.DISCOVERY);

    const wealthHistory = await listWealthHistory(result.familyKey);
    assert.equal(wealthHistory.length, 1);
    assert.equal(wealthHistory[0].hypothesisId, result.hypothesisId);

    const auditEntries = orchestrator.decisionAuditLog.forCandidate(triaged.id);
    assert.ok(auditEntries.some((e) => e.decisionType === 'CONFIRMED'));
  } finally {
    teardown();
  }
});

test('a genuinely Poisson-consistent gap series correctly does NOT reach Confirmed -- large p-value, no discovery, alpha still spent exactly once (Online FDR tracks every test, not just significant ones)', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedEventProcessCandidate(orchestrator, rc, 'TimeGap', 'eventproc-cand-2');

    const rng = seededRng(9);
    const gaps = trueExponentialGaps(rng, 200, 1.5);

    const result = await orchestrator.confirmEventProcessFeatureAutomatically({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-eventproc-002' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      gaps, seed: 42, numSimulations: 500,
    });

    assert.ok(result.pValue >= 0.05, 'Stage C should not have rejected Poisson for this genuinely exponential fixture');
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.DEPRECATED);

    const wealthHistory = await listWealthHistory(result.familyKey);
    assert.equal(wealthHistory.length, 1);
    assert.equal(wealthHistory[0].rejected, false);
  } finally {
    teardown();
  }
});

test('candidate registry is updated correctly by confirmEventProcessFeatureAutomatically, same as confirmAutomatically', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { triaged, provenance } = await buildTriagedEventProcessCandidate(orchestrator, rc, 'TickGap', 'eventproc-cand-3');
    const rng = seededRng(42);
    const gaps = Array.from({ length: 300 }, () => 0.5 + rng());

    const result = await orchestrator.confirmEventProcessFeatureAutomatically({
      candidate: triaged, researchConfiguration: rc,
      datasetManifest: { datasetId: 'ds-eventproc-003' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
      gaps, seed: 5, numSimulations: 300,
    });

    const summary = orchestrator.getCampaignSummary();
    assert.ok(summary.countsByStage.Confirmed >= 1 || summary.countsByStage.Deprecated >= 1);
    assert.equal(result.candidate.id, triaged.id);
  } finally {
    teardown();
  }
});
