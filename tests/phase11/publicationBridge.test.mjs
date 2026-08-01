/**
 * tests/phase11/publicationBridge.test.mjs
 *
 * Integration tests for research/src/bridge/Phase11PublicationBridge.js —
 * bridges a Replicated Phase 11 candidate into the existing legacy
 * Publication lifecycle stage, reusing (not duplicating)
 * Phase11Orchestrator.checkPublicationEligibility() (Phase D).
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
  publishPhase11Candidate,
  Phase11PublicationValidationError,
} from '../../research/src/bridge/Phase11PublicationBridge.js';
import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { getNode } from '../../research/src/governance/knowledgeGraph.js';
import { PHASE11_NODE_TYPES } from '../../research/src/governance/phase11KnowledgeGraphBridge.js';
import { REPRODUCIBILITY_LEVELS } from '../../research/src/governance/reproducibilityLevels.js';
import { IMPLEMENTATION_MATURITY } from '../../research/src/governance/implementationMaturity.js';

/** Clones a frozen candidate with one field overridden (same technique as candidateLifecycleTransition.js). */
function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-pub-bridge-001', name: 'Publication bridge test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' }, ...overrides,
  });
}
async function makeFreeze(rc, overrides = {}) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64), ...overrides,
  });
}
async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-pub-bridge-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }],
    replicationCriteria: { minStabilityIndex: 0.5 }, publicationCriteria: {},
    effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [], ...overrides,
  });
}

/** Builds a fully Replicated candidate, ready for publication, satisfying ReproducibilityGate's requirements. */
async function buildReplicatedCandidate(orchestrator, rc, freeze, id) {
  const [{ candidate: draft, provenance }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id, family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });

  // ReproducibilityGate requires the candidate's fingerprint to already be
  // in the freeze's candidateFingerprints -- rebuild the freeze now that
  // the fingerprint is known (fingerprint doesn't depend on freeze id),
  // and swap it into the orchestrator in place.
  const freezeWithFp = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [draft.fingerprint], researchConfigurationHash: 'b'.repeat(64),
  });
  orchestrator.researchFreeze = freezeWithFp;

  let candidate = withField(draft, 'researchFreezeId', freezeWithFp.id);
  candidate = withField(candidate, 'reproducibilityLevel', REPRODUCIBILITY_LEVELS.CROSS_REGIME ?? 3);
  candidate = withField(candidate, 'implementationMaturity', IMPLEMENTATION_MATURITY.STABLE);

  const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  const confirmResult = await orchestrator.confirm({
    candidate: triaged, researchConfiguration: rc,
    datasetManifest: { datasetId: `ds-${id}` }, provenance,
    market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
    pValue: 0.0001,
  });
  const replicateResult = await orchestrator.replicate({
    candidate: confirmResult.candidate, hypothesisId: confirmResult.hypothesisId, familyKey: confirmResult.familyKey,
    featureKey: `${id}-feature`, generation: 0, holdoutRange: { startTick: 1000, endTick: 2000 },
    partitionEffectSizes: [0.12, 0.11, 0.13, 0.12], pooledEffectSize: 0.12,
  });
  return { replicated: replicateResult.candidate, hypothesisId: confirmResult.hypothesisId, freezeWithFp };
}

test('successful publication: eligible candidate -> Published, legacy hypothesis advances to Publication stage', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { replicated, hypothesisId } = await buildReplicatedCandidate(orchestrator, rc, freeze, 'pub-cand-1');
    await orchestrator.syncKnowledgeGraph(replicated);

    const result = await orchestrator.publish({
      candidate: replicated, hypothesisId, publishTimeConfig: rc,
    });

    assert.equal(result.outcome, 'published');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.PUBLISHED);
    assert.equal(result.publicationId, `pub_${hypothesisId}`);
    assert.equal(result.gateResult.passed, true);

    const legacyStage = await getCurrentLifecycleStage(hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.PUBLICATION);

    const auditEntries = orchestrator.decisionAuditLog.forCandidate('pub-cand-1');
    assert.ok(auditEntries.some(e => e.decisionType === 'PUBLISHED'));

    const publicationNode = await getNode(PHASE11_NODE_TYPES.PUBLICATION, result.publicationId);
    assert.ok(publicationNode);
  } finally {
    teardown();
  }
});

test('ineligible publication: configuration drift blocks publication, candidate stays Replicated, legacy stage unchanged', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { replicated, hypothesisId } = await buildReplicatedCandidate(orchestrator, rc, freeze, 'pub-cand-2');

    // A drifted configuration (different proxyVersions -> different configHash).
    const driftedRc = await makeRc({ id: 'rc-pub-bridge-drift', proxyVersions: { msd: '2.0.0' } });

    const result = await orchestrator.publish({
      candidate: replicated, hypothesisId, publishTimeConfig: driftedRc,
    });

    assert.equal(result.outcome, 'ineligible');
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.REPLICATED); // not deprecated
    assert.equal(result.gateResult.passed, false);
    assert.ok(result.gateResult.failures.some(f => f.includes('configHash')));

    const legacyStage = await getCurrentLifecycleStage(hypothesisId);
    assert.equal(legacyStage, LIFECYCLE_STAGES.LOCKBOX); // unchanged -- no publication transition attempted
  } finally {
    teardown();
  }
});

test('Stage 8 fix: sap.publicationCriteria.minReproducibilityLevel is now genuinely enforced (was previously declared but silently ignored)', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    // Request a STRICTER reproducibility level than the candidate has (3) --
    // this must now genuinely block publication, where before this fix it
    // would have been silently ignored.
    const sap = await makeSap({ publicationCriteria: { minReproducibilityLevel: 4 } });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { replicated, hypothesisId } = await buildReplicatedCandidate(orchestrator, rc, freeze, 'pub-cand-sap-repro');
    await orchestrator.syncKnowledgeGraph(replicated);

    const result = await orchestrator.publish({ candidate: replicated, hypothesisId, publishTimeConfig: rc });

    assert.equal(result.outcome, 'ineligible');
    assert.ok(result.gateResult.failures.some((f) => f.includes('SAP-required minimum 4')));
    assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.REPLICATED, 'ineligible publication is administrative, not a scientific rejection -- candidate stays Replicated');
  } finally {
    teardown();
  }
});

test('Stage 8 fix: sap.publicationCriteria.minEvidenceTier is now genuinely enforced', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    // A fresh candidate defaults to evidenceTier E0 -- requiring E1 must
    // genuinely block publication.
    const sap = await makeSap({ publicationCriteria: { minEvidenceTier: 'E1' } });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { replicated, hypothesisId } = await buildReplicatedCandidate(orchestrator, rc, freeze, 'pub-cand-sap-evidence');
    await orchestrator.syncKnowledgeGraph(replicated);

    const result = await orchestrator.publish({ candidate: replicated, hypothesisId, publishTimeConfig: rc });

    assert.equal(result.outcome, 'ineligible');
    assert.ok(result.gateResult.failures.some((f) => f.includes('SAP-required minimum "E1"')));
  } finally {
    teardown();
  }
});

test('Stage 8 fix: a SAP requesting a WEAKER reproducibility level than the existing hardcoded floor never weakens governance -- the floor still applies', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    // minReproducibilityLevel: 1 is weaker than the hardcoded floor of 3
    // (ReproducibilityGate.MIN_PUBLICATION_REPRODUCIBILITY_LEVEL) -- this
    // must NOT let a candidate with reproducibilityLevel < 3 through.
    const sap = await makeSap({ publicationCriteria: { minReproducibilityLevel: 1 } });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { replicated, hypothesisId } = await buildReplicatedCandidate(orchestrator, rc, freeze, 'pub-cand-sap-weak');
    // Deliberately weaken the candidate's own reproducibilityLevel below
    // the hardcoded floor.
    const weakened = withField(replicated, 'reproducibilityLevel', 1);
    await orchestrator.syncKnowledgeGraph(weakened);

    const result = await orchestrator.publish({ candidate: weakened, hypothesisId, publishTimeConfig: rc });

    assert.equal(result.outcome, 'ineligible', 'the hardcoded reproducibility floor must still block this, regardless of the SAP requesting a weaker minimum');
  } finally {
    teardown();
  }
});

test('validation: refuses a candidate that is not Replicated', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const [{ candidate }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'pub-cand-3', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });

    await assert.rejects(publishPhase11Candidate({
      candidate, hypothesisId: 'ph11_fake', orchestrator, publishTimeConfig: rc,
    }), Phase11PublicationValidationError);
  } finally {
    teardown();
  }
});

test('publication does not duplicate ReproducibilityGate or checkPublicationEligibility logic', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11PublicationBridge.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/import\s*\{[^}]*ReproducibilityGate[^}]*\}\s*from/.test(src), 'bridge must call orchestrator.checkPublicationEligibility(), not ReproducibilityGate directly');
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
});
