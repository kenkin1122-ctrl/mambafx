import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import { registerHypothesis } from '../../research/src/governance/hypothesisRegistry.js';
import {
  NODE_TYPES,
  EDGE_TYPES,
  InvalidKnowledgeGraphInputError,
  UnknownNodeReferenceError,
  REPRESENTATION_FAMILY_STATUSES,
  REPRESENTATION_FAMILY_JUSTIFICATION_TYPES,
  InvalidRepresentationFamilyTransitionError,
  registerRepresentationFamily,
  listRepresentationFamilyStatusHistory,
  getRepresentationFamilyStatus,
  transitionRepresentationFamilyStatus,
  linkHypothesisToRepresentationFamily,
  registerSearchSpaceVersion,
  linkHypothesisToSearchSpaceVersion,
  registerDiscoveryCampaign,
  registerReplicationCampaign,
  linkHypothesisToCampaign,
  recordCampaignRoundMetric,
  listCampaignRoundMetrics,
  recordScreenedNotPromoted,
  registerEvidenceSummary,
  queryFailedRepresentationFamilies,
  queryActiveRepresentationFamilies,
  queryFeatureFamilyOutcomeStats,
  querySurvivingTransformations,
  queryUnexploredSearchSpaceVersions,
  queryComputationalCostByRepresentationFamily,
  queryReplicationHistory,
  queryEvidenceLineage,
  registerFeatureNode,
  registerCandidateMeasurement,
} from '../../research/src/governance/knowledgeGraph.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

function validHypothesisSpec(overrides = {}) {
  return {
    hypothesisId: 'h1',
    lineageId: 'L1',
    generationId: 1,
    parentIds: [],
    familyKey: 'F1',
    lineageDeclaration: { isContinuation: false },
    dataAccessAttestation: { attested: true },
    missingValueHandlingPolicy: 'forward-fill',
    outlierHandlingPolicy: 'winsorize-3sigma',
    analyticalChoiceSet: ['pipelineA'],
    reasonForCreation: 'testing Phase 9 knowledge graph extension',
    ...overrides,
  };
}

// ── Representation Family lifecycle ─────────────────────────────────────

test('registerRepresentationFamily validates required fields and starts Active', async () => {
  const teardown = setup();
  try {
    await assert.rejects(() => registerRepresentationFamily({ label: 'x' }), InvalidKnowledgeGraphInputError);
    await assert.rejects(() => registerRepresentationFamily({ familyId: 'rf1' }), InvalidKnowledgeGraphInputError);
    const node = await registerRepresentationFamily({ familyId: 'rf1', label: 'Simple MI vs 5-tick rise' });
    assert.equal(node.nodeType, NODE_TYPES.REPRESENTATION_FAMILY);
    assert.equal(await getRepresentationFamilyStatus('rf1'), REPRESENTATION_FAMILY_STATUSES.ACTIVE);
    const history = await listRepresentationFamilyStatusHistory('rf1');
    assert.equal(history.length, 1);
    assert.equal(history[0].previousStatus, null);
  } finally { await teardown(); }
});

test('registerRepresentationFamily is idempotent and does not duplicate the initial transition', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A duplicate call' });
    const history = await listRepresentationFamilyStatusHistory('rf1');
    assert.equal(history.length, 1);
  } finally { await teardown(); }
});

test('transitionRepresentationFamilyStatus enforces the whitelist graph (Active -> Rejected allowed, Rejected -> Replicated NOT allowed)', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.REJECTED, reason: 'zero BH-significant discoveries' });
    assert.equal(await getRepresentationFamilyStatus('rf1'), REPRESENTATION_FAMILY_STATUSES.REJECTED);
    await assert.rejects(
      () => transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.REPLICATED }),
      InvalidRepresentationFamilyTransitionError
    );
  } finally { await teardown(); }
});

test('transitionRepresentationFamilyStatus: Retired is terminal', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.RETIRED });
    await assert.rejects(
      () => transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.ACTIVE, justificationType: REPRESENTATION_FAMILY_JUSTIFICATION_TYPES.NEW_DATA }),
      InvalidRepresentationFamilyTransitionError
    );
  } finally { await teardown(); }
});

test('transitionRepresentationFamilyStatus: reviving a Rejected family requires a qualifying justificationType', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.REJECTED });
    await assert.rejects(
      () => transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.ACTIVE }),
      InvalidRepresentationFamilyTransitionError
    );
    await assert.rejects(
      () => transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.ACTIVE, justificationType: 'NotARealJustification' }),
      InvalidRepresentationFamilyTransitionError
    );
    const revived = await transitionRepresentationFamilyStatus({
      familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.ACTIVE,
      justificationType: REPRESENTATION_FAMILY_JUSTIFICATION_TYPES.NEW_SEARCH_SPACE_VERSION,
      reason: 'New feature-family grammar version 2 introduced interaction terms.',
    });
    assert.equal(revived.metadata.status, REPRESENTATION_FAMILY_STATUSES.ACTIVE);
    assert.equal(await getRepresentationFamilyStatus('rf1'), REPRESENTATION_FAMILY_STATUSES.ACTIVE);
  } finally { await teardown(); }
});

test('transitionRepresentationFamilyStatus rejects an unregistered family', async () => {
  const teardown = setup();
  try {
    await assert.rejects(
      () => transitionRepresentationFamilyStatus({ familyId: 'ghost', to: REPRESENTATION_FAMILY_STATUSES.REJECTED }),
      UnknownNodeReferenceError
    );
  } finally { await teardown(); }
});

test('linkHypothesisToRepresentationFamily requires a real hypothesis and a real family; feeds queryFailedRepresentationFamilies/queryActiveRepresentationFamilies', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await assert.rejects(() => linkHypothesisToRepresentationFamily('ghost', 'rf1'), UnknownNodeReferenceError);
    await assert.rejects(() => linkHypothesisToRepresentationFamily('h1', 'ghostFamily'), UnknownNodeReferenceError);

    const edge = await linkHypothesisToRepresentationFamily('h1', 'rf1');
    assert.equal(edge.edgeType, EDGE_TYPES.INSTANCE_OF_FAMILY);

    let active = await queryActiveRepresentationFamilies();
    assert.equal(active.length, 1);
    assert.equal(active[0].familyId, 'rf1');

    await transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.REJECTED });
    const failed = await queryFailedRepresentationFamilies();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].familyId, 'rf1');
    active = await queryActiveRepresentationFamilies();
    assert.equal(active.length, 0);
  } finally { await teardown(); }
});

// ── Search Space Version ────────────────────────────────────────────────

test('registerSearchSpaceVersion + linkHypothesisToSearchSpaceVersion + queryUnexploredSearchSpaceVersions', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await registerSearchSpaceVersion({ versionId: 'v1', label: 'Generator v1' });
    await registerSearchSpaceVersion({ versionId: 'v2', label: 'Generator v2 (unused)' });

    let unexplored = await queryUnexploredSearchSpaceVersions();
    assert.equal(unexplored.length, 2);

    const edge = await linkHypothesisToSearchSpaceVersion('h1', 'v1');
    assert.equal(edge.edgeType, EDGE_TYPES.GENERATED_FROM);

    unexplored = await queryUnexploredSearchSpaceVersions();
    assert.equal(unexplored.length, 1);
    assert.equal(unexplored[0].versionId, 'v2');
  } finally { await teardown(); }
});

// ── Campaigns ────────────────────────────────────────────────────────────

test('registerDiscoveryCampaign / registerReplicationCampaign validate representationFamilyId when supplied', async () => {
  const teardown = setup();
  try {
    await assert.rejects(() => registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'ghost' }), UnknownNodeReferenceError);
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    const campaign = await registerDiscoveryCampaign({ campaignId: 'c1', label: 'Campaign 1', representationFamilyId: 'rf1' });
    assert.equal(campaign.metadata.representationFamilyId, 'rf1');
    const replication = await registerReplicationCampaign({ campaignId: 'rc1', representationFamilyId: 'rf1' });
    assert.equal(replication.nodeType, NODE_TYPES.REPLICATION_CAMPAIGN);
  } finally { await teardown(); }
});

test('linkHypothesisToCampaign: discovery membership vs replication are distinct edge types', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await registerDiscoveryCampaign({ campaignId: 'c1', label: 'Campaign 1' });
    await registerReplicationCampaign({ campaignId: 'rc1', label: 'Replication 1' });

    const memberEdge = await linkHypothesisToCampaign('h1', 'c1');
    assert.equal(memberEdge.edgeType, EDGE_TYPES.MEMBER_OF_CAMPAIGN);
    const replicatedEdge = await linkHypothesisToCampaign('h1', 'rc1', { replication: true });
    assert.equal(replicatedEdge.edgeType, EDGE_TYPES.REPLICATED_IN);

    const history = await queryReplicationHistory('h1');
    assert.equal(history.length, 1);
    assert.equal(history[0].campaignId, 'rc1');
  } finally { await teardown(); }
});

test('recordCampaignRoundMetric validates round range and accumulates a queryable history', async () => {
  const teardown = setup();
  try {
    await registerDiscoveryCampaign({ campaignId: 'c1', label: 'Campaign 1' });
    await assert.rejects(() => recordCampaignRoundMetric({ campaignId: 'c1', round: 0 }), InvalidKnowledgeGraphInputError);
    await assert.rejects(() => recordCampaignRoundMetric({ campaignId: 'c1', round: 5 }), InvalidKnowledgeGraphInputError);
    await assert.rejects(() => recordCampaignRoundMetric({ campaignId: 'ghost', round: 1 }), UnknownNodeReferenceError);

    await recordCampaignRoundMetric({ campaignId: 'c1', round: 1, evaluated: 1000000, promoted: 1000, computationalCost: 50 });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 2, evaluated: 1000, promoted: 80, computationalCost: 200 });

    const metrics = await listCampaignRoundMetrics('c1');
    assert.equal(metrics.length, 2);
    assert.equal(metrics[0].round, 1);
    assert.equal(metrics[0].hitRate, 1000 / 1000000);
    assert.equal(metrics[1].round, 2);
  } finally { await teardown(); }
});

test('queryComputationalCostByRepresentationFamily sums across every campaign scoped to that family', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });
    await registerReplicationCampaign({ campaignId: 'rc1', representationFamilyId: 'rf1' });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 1, computationalCost: 100 });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 3, computationalCost: 300 });
    await recordCampaignRoundMetric({ campaignId: 'rc1', round: 4, computationalCost: 50 });

    const result = await queryComputationalCostByRepresentationFamily('rf1');
    assert.equal(result.campaignsScoped, 2);
    assert.equal(result.totalComputationalCost, 450);
  } finally { await teardown(); }
});

// ── Screened-not-promoted (individual elimination record) ────────────────

test('recordScreenedNotPromoted requires a real hypothesis and a representationFamilyId; feeds queryFeatureFamilyOutcomeStats', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await assert.rejects(() => recordScreenedNotPromoted({ hypothesisId: 'ghost', representationFamilyId: 'rf1' }), UnknownNodeReferenceError);
    await assert.rejects(() => recordScreenedNotPromoted({ hypothesisId: 'h1' }), InvalidKnowledgeGraphInputError);

    const candidate = await registerCandidateMeasurement({
      candidateId: 'cm1', label: 'MI of feature vs outcome', parentHypothesisId: 'h1',
    });
    assert.ok(candidate);
    const feature = await registerFeatureNode({
      featureKey: 'f1', family: 'Entropy', parentCandidateMeasurementId: 'cm1',
    });
    assert.ok(feature);

    const edge = await recordScreenedNotPromoted({ hypothesisId: 'h1', round: 3, reason: 'Failed Round 3 permutation test', representationFamilyId: 'rf1' });
    assert.equal(edge.edgeType, EDGE_TYPES.SCREENED_NOT_PROMOTED);
    assert.equal(edge.metadata.round, 3);

    const stats = await queryFeatureFamilyOutcomeStats();
    assert.equal(stats['Entropy'].featuresObserved, 1);
    assert.equal(stats['Entropy'].featuresWithEliminatedHypothesis, 1);
    assert.equal(stats['Entropy'].eliminationRate, 1);
    assert.equal(stats['Persistence'].featuresObserved, 0);
    assert.equal(stats['Persistence'].eliminationRate, null);
  } finally { await teardown(); }
});

// ── Evidence Summary ───────────────────────────────────────────────────

test('registerEvidenceSummary requires a real hypothesis; feeds querySurvivingTransformations', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await assert.rejects(
      () => registerEvidenceSummary({ summaryId: 'es1', hypothesisId: 'ghost' }),
      UnknownNodeReferenceError
    );
    const candidate = await registerCandidateMeasurement({ candidateId: 'cm1', label: 'MI', parentHypothesisId: 'h1' });
    assert.ok(candidate);
    await registerFeatureNode({ featureKey: 'f1', family: 'Persistence', parentCandidateMeasurementId: 'cm1' });

    const summary = await registerEvidenceSummary({
      summaryId: 'es1', hypothesisId: 'h1', evidenceTier: 'Strong',
      uncertaintyClassification: 'Validation', confidenceProfile: { statisticalEvidence: 'Strong', replication: 'Replicated' },
    });
    assert.equal(summary.nodeType, NODE_TYPES.EVIDENCE_SUMMARY);

    const survivors = await querySurvivingTransformations({});
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].featureKey, 'f1');
    assert.equal(survivors[0].family, 'Persistence');

    const filteredOut = await querySurvivingTransformations({ survivingTiers: ['Extraordinary'] });
    assert.equal(filteredOut.length, 0);
  } finally { await teardown(); }
});

// ── Composite evidence lineage ───────────────────────────────────────────

test('queryEvidenceLineage composes representation family, search space version, campaigns, eliminations, and summaries', async () => {
  const teardown = setup();
  try {
    await registerHypothesis(validHypothesisSpec());
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerSearchSpaceVersion({ versionId: 'v1', label: 'Generator v1' });
    await registerDiscoveryCampaign({ campaignId: 'c1', label: 'Campaign 1', representationFamilyId: 'rf1' });

    await linkHypothesisToRepresentationFamily('h1', 'rf1');
    await linkHypothesisToSearchSpaceVersion('h1', 'v1');
    await linkHypothesisToCampaign('h1', 'c1');
    await recordScreenedNotPromoted({ hypothesisId: 'h1', round: 3, reason: 'FDR wealth exhausted', representationFamilyId: 'rf1' });
    await registerEvidenceSummary({ summaryId: 'es1', hypothesisId: 'h1', evidenceTier: 'None' });

    const lineage = await queryEvidenceLineage('h1');
    assert.equal(lineage.hypothesisId, 'h1');
    assert.equal(lineage.representationFamily.familyId, 'rf1');
    assert.equal(lineage.searchSpaceVersion.versionId, 'v1');
    assert.equal(lineage.discoveryCampaigns.length, 1);
    assert.equal(lineage.eliminationHistory.length, 1);
    assert.equal(lineage.evidenceSummaries.length, 1);
    assert.equal(lineage.replicationHistory.length, 0);
  } finally { await teardown(); }
});

test('queryEvidenceLineage on an unregistered hypothesis returns an error object, not a throw', async () => {
  const teardown = setup();
  try {
    const lineage = await queryEvidenceLineage('ghost');
    assert.ok(lineage.error);
  } finally { await teardown(); }
});
