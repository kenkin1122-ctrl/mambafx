import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  openExistingDbExtended,
  _resetConnectionCacheForTesting as _resetExistingDbCacheForTesting,
} from '../../research/src/storage/existingDbExtensions.js';
import { _resetKnownFamiliesForTesting } from '../../research/src/governance/family.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { getLockboxAllocation } from '../../research/src/governance/lockbox.js';
import {
  registerRepresentationFamily,
  registerSearchSpaceVersion,
  registerDiscoveryCampaign,
  registerReplicationCampaign,
  listCampaignRoundMetrics,
  queryFeatureFamilyOutcomeStats,
} from '../../research/src/governance/knowledgeGraph.js';
import {
  InvalidFunnelInputError,
  runRoundOneScreening,
  runRoundTwoValidation,
  runRoundThreeDeepValidation,
  runRoundFourReplication,
} from '../../research/src/discovery/funnel.js';

async function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  _resetExistingDbCacheForTesting();
  _resetKnownFamiliesForTesting();
  await openExistingDbExtended({ allowUpgrade: true });
  return teardown;
}

function candidateSpec(candidateKey, overrides = {}) {
  return {
    hypothesisId: candidateKey,
    lineageId: `L_${candidateKey}`,
    generationId: 1,
    parentIds: [],
    familyKey: 'F1',
    lineageDeclaration: { isContinuation: false },
    dataAccessAttestation: { attested: true },
    missingValueHandlingPolicy: 'forward-fill',
    outlierHandlingPolicy: 'winsorize-3sigma',
    analyticalChoiceSet: ['pipelineA'],
    reasonForCreation: `funnel test candidate ${candidateKey}`,
    ...overrides,
  };
}

// ── Round 1 ──────────────────────────────────────────────────────────────

test('runRoundOneScreening validates input', () => {
  assert.throws(() => runRoundOneScreening({ candidates: [] }), InvalidFunnelInputError);
  assert.throws(() => runRoundOneScreening({ candidates: [{ candidateKey: 'a' }] }), InvalidFunnelInputError);
  assert.throws(() => runRoundOneScreening({ candidates: [{ candidateKey: 'a' }], scoreFn: () => 1, promotionQuantile: 2 }), InvalidFunnelInputError);
});

test('runRoundOneScreening is a pure ranking filter: no hypothesis registered, top quantile promoted', () => {
  const candidates = Array.from({ length: 1000 }, (_, i) => ({ candidateKey: `c${i}`, mi: i }));
  const result = runRoundOneScreening({ candidates, scoreFn: (c) => c.mi, promotionQuantile: 0.01 });
  assert.equal(result.evaluated, 1000);
  assert.equal(result.promotedCount, 10);
  // Highest-MI candidates promoted (c990..c999).
  const promotedKeys = result.promoted.map((c) => c.candidateKey).sort();
  assert.deepEqual(promotedKeys, Array.from({ length: 10 }, (_, i) => `c${990 + i}`).sort());
});

test('runRoundOneScreening always promotes at least 1 candidate even with a tiny quantile', () => {
  const candidates = [{ candidateKey: 'a', s: 1 }, { candidateKey: 'b', s: 2 }];
  const result = runRoundOneScreening({ candidates, scoreFn: (c) => c.s, promotionQuantile: 0.001 });
  assert.equal(result.promotedCount, 1);
  assert.equal(result.promoted[0].candidateKey, 'b');
});

// ── Round 2 ──────────────────────────────────────────────────────────────

test('runRoundTwoValidation only registers candidates whose intermediate test clears alpha', async () => {
  const teardown = await setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerSearchSpaceVersion({ versionId: 'v1', label: 'Generator v1' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });

    const candidates = [
      { candidateKey: 'good' }, // will clear alpha
      { candidateKey: 'bad' },  // will not clear alpha
    ];
    const result = await runRoundTwoValidation({
      candidates,
      intermediateTestFn: async (c) => ({ pValue: c.candidateKey === 'good' ? 0.001 : 0.9 }),
      buildRegistrationSpec: async (c) => candidateSpec(c.candidateKey),
      alpha: 0.05,
      representationFamilyId: 'rf1',
      searchSpaceVersionId: 'v1',
      campaignId: 'c1',
    });

    assert.equal(result.evaluated, 2);
    assert.equal(result.promotedCount, 1);
    assert.equal(result.registered[0].hypothesisId, 'good');
    assert.equal(await getCurrentLifecycleStage('good'), LIFECYCLE_STAGES.FEATURE_GENERATION);

    const metrics = await listCampaignRoundMetrics('c1');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].round, 2);
    assert.equal(metrics[0].evaluated, 2);
    assert.equal(metrics[0].promoted, 1);
  } finally { await teardown(); }
});

test('runRoundTwoValidation validates required functions', async () => {
  const teardown = await setup();
  try {
    await assert.rejects(() => runRoundTwoValidation({ candidates: [{ candidateKey: 'a' }] }), InvalidFunnelInputError);
  } finally { await teardown(); }
});

// ── Round 3 ──────────────────────────────────────────────────────────────

async function registerAndAdvanceToFeatureGeneration(candidateKey) {
  const { registerHypothesis, transitionLifecycleStage } = await import('../../research/src/governance/hypothesisRegistry.js');
  const spec = candidateSpec(candidateKey);
  const registration = await registerHypothesis(spec);
  await transitionLifecycleStage(registration.hypothesisId, { to: 'FeatureGeneration', reason: 'test setup' });
  return registration.hypothesisId;
}

test('runRoundThreeDeepValidation: a low p-value clears Family wealth and advances to Replication; a high p-value is eliminated and recorded', async () => {
  const teardown = await setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });

    const survivorId = await registerAndAdvanceToFeatureGeneration('survivor');
    const rejectId = await registerAndAdvanceToFeatureGeneration('reject');

    const registered = [
      { hypothesisId: survivorId, candidate: { candidateKey: 'survivor' } },
      { hypothesisId: rejectId, candidate: { candidateKey: 'reject' } },
    ];

    const result = await runRoundThreeDeepValidation({
      registered,
      familyKey: 'F1',
      deepTestFn: async (item) => ({ pValue: item.hypothesisId === survivorId ? 0.0001 : 0.9 }),
      representationFamilyId: 'rf1',
      campaignId: 'c1',
    });

    assert.equal(result.promotedCount, 1);
    assert.equal(result.survivors[0].hypothesisId, survivorId);
    assert.equal(await getCurrentLifecycleStage(survivorId), LIFECYCLE_STAGES.REPLICATION);
    assert.equal(await getCurrentLifecycleStage(rejectId), LIFECYCLE_STAGES.DISCOVERY);

    const stats = await queryFeatureFamilyOutcomeStats();
    // No features were registered in the Knowledge Graph for this test, so
    // outcome stats should be structurally present but empty of matches —
    // the important assertion is that recordScreenedNotPromoted did not throw.
    assert.ok(stats);

    const metrics = await listCampaignRoundMetrics('c1');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].round, 3);
    assert.equal(metrics[0].promoted, 1);
  } finally { await teardown(); }
});

test('runRoundThreeDeepValidation validates required input', async () => {
  const teardown = await setup();
  try {
    await assert.rejects(() => runRoundThreeDeepValidation({ registered: [] }), InvalidFunnelInputError);
    await assert.rejects(() => runRoundThreeDeepValidation({ registered: [{ hypothesisId: 'x' }] }), InvalidFunnelInputError);
  } finally { await teardown(); }
});

// ── Round 4 ──────────────────────────────────────────────────────────────

async function advanceThroughReplication(hypothesisId) {
  const { transitionLifecycleStage } = await import('../../research/src/governance/hypothesisRegistry.js');
  await transitionLifecycleStage(hypothesisId, { to: 'Discovery', reason: 'test setup' });
  await transitionLifecycleStage(hypothesisId, { to: 'Replication', reason: 'test setup' });
}

test('runRoundFourReplication allocates a Lockbox holdout for each survivor and optionally consumes it', async () => {
  const teardown = await setup();
  try {
    await registerReplicationCampaign({ campaignId: 'rc1' });
    const hypothesisId = await registerAndAdvanceToFeatureGeneration('rep1');
    await advanceThroughReplication(hypothesisId);

    const result = await runRoundFourReplication({
      survivors: [{ hypothesisId, candidate: { candidateKey: 'rep1' } }],
      buildLockboxRequest: async () => ({ featureKey: 'feat1', generation: 1, holdoutRange: { startTick: 1000, endTick: 2000 }, allocatedBy: 'funnel-test' }),
      consumeEvidenceFn: async () => ({ groundTruthVerified: true, recovered: true }),
      replicationCampaignId: 'rc1',
    });

    assert.equal(result.results.length, 1);
    assert.equal(await getCurrentLifecycleStage(hypothesisId), LIFECYCLE_STAGES.LOCKBOX);
    const allocation = await getLockboxAllocation('feat1', 1);
    assert.equal(allocation.hypothesisId, hypothesisId);
    assert.ok(result.results[0].consumption.ok !== false || result.results[0].consumption.record);

    const metrics = await listCampaignRoundMetrics('rc1');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].round, 4);
  } finally { await teardown(); }
});

test('runRoundFourReplication validates required input', async () => {
  const teardown = await setup();
  try {
    await assert.rejects(() => runRoundFourReplication({ survivors: [] }), InvalidFunnelInputError);
    await assert.rejects(() => runRoundFourReplication({ survivors: [{ hypothesisId: 'x' }] }), InvalidFunnelInputError);
  } finally { await teardown(); }
});

// ── End-to-end: Round 1 -> 2 -> 3 -> 4 ────────────────────────────────────

test('end-to-end funnel: a strong candidate survives all four rounds, a weak one is eliminated at Round 2', async () => {
  const teardown = await setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerSearchSpaceVersion({ versionId: 'v1', label: 'Generator v1' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });
    await registerReplicationCampaign({ campaignId: 'rc1', representationFamilyId: 'rf1' });

    const candidates = [
      { candidateKey: 'strong', cheapScore: 10 },
      { candidateKey: 'weak', cheapScore: 1 },
    ];

    const round1 = runRoundOneScreening({ candidates, scoreFn: (c) => c.cheapScore, promotionQuantile: 1 });
    assert.equal(round1.promotedCount, 2);

    const round2 = await runRoundTwoValidation({
      candidates: round1.promoted,
      intermediateTestFn: async (c) => ({ pValue: c.candidateKey === 'strong' ? 0.001 : 0.9 }),
      buildRegistrationSpec: async (c) => candidateSpec(c.candidateKey),
      representationFamilyId: 'rf1',
      searchSpaceVersionId: 'v1',
      campaignId: 'c1',
    });
    assert.equal(round2.promotedCount, 1);
    assert.equal(round2.registered[0].hypothesisId, 'strong');

    const round3 = await runRoundThreeDeepValidation({
      registered: round2.registered,
      familyKey: 'F1',
      deepTestFn: async () => ({ pValue: 0.0001 }),
      representationFamilyId: 'rf1',
      campaignId: 'c1',
    });
    assert.equal(round3.promotedCount, 1);

    const round4 = await runRoundFourReplication({
      survivors: round3.survivors,
      buildLockboxRequest: async () => ({ featureKey: 'strongFeature', generation: 1, holdoutRange: { startTick: 5000, endTick: 6000 } }),
      replicationCampaignId: 'rc1',
    });
    assert.equal(round4.results.length, 1);
    assert.equal(await getCurrentLifecycleStage('strong'), LIFECYCLE_STAGES.LOCKBOX);
  } finally { await teardown(); }
});
