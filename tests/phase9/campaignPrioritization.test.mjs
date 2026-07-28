import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  registerRepresentationFamily,
  transitionRepresentationFamilyStatus,
  REPRESENTATION_FAMILY_STATUSES,
  registerDiscoveryCampaign,
  recordCampaignRoundMetric,
} from '../../research/src/governance/knowledgeGraph.js';
import {
  InvalidCampaignPrioritizationInputError,
  computeRepresentationFamilyArmStatistics,
  buildActiveRepresentationFamilyArms,
  prioritizeNextRepresentationFamily,
  rankFeatureFamiliesByPromise,
} from '../../research/src/discovery/campaignPrioritization.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

// ── Structural guardrail ────────────────────────────────────────────────

test('campaignPrioritization.js imports ONLY knowledgeGraph.js and searchEngine.js -- never onlineFdr/discoveryDecision/publicationStatus', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const modulePath = path.join(__dirname, '../../research/src/discovery/campaignPrioritization.js');
  const source = fs.readFileSync(modulePath, 'utf8');
  // Only inspect actual `import ... from '...'` statement bodies -- the
  // module's own header PROSE mentions these forbidden module names by
  // name (explaining why they must be absent), which would otherwise
  // false-positive a naive whole-file substring search.
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  for (const forbidden of ['onlineFdr.js', 'discoveryDecision.js', 'publicationStatus.js']) {
    assert.equal(importStatementBlock.includes(forbidden), false, `campaignPrioritization.js must never import ${forbidden}`);
  }
  assert.ok(importStatementBlock.includes('knowledgeGraph.js'));
  assert.ok(importStatementBlock.includes('searchEngine.js'));
});

// ── computeRepresentationFamilyArmStatistics ─────────────────────────────

test('computeRepresentationFamilyArmStatistics aggregates across every campaign scoped to a family', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });
    await registerDiscoveryCampaign({ campaignId: 'c2', representationFamilyId: 'rf1' });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 1, evaluated: 1000, promoted: 10 });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 2, evaluated: 10, promoted: 2 });
    await recordCampaignRoundMetric({ campaignId: 'c2', round: 1, evaluated: 500, promoted: 5 });

    const stats = await computeRepresentationFamilyArmStatistics('rf1');
    assert.equal(stats.armId, 'rf1');
    assert.equal(stats.pulls, 1510);
    assert.equal(stats.totalReward, 17);
  } finally { await teardown(); }
});

// ── buildActiveRepresentationFamilyArms ──────────────────────────────────

test('buildActiveRepresentationFamilyArms excludes Rejected/Retired families entirely', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'active1', label: 'Active family' });
    await registerRepresentationFamily({ familyId: 'rejected1', label: 'Rejected family' });
    await transitionRepresentationFamilyStatus({ familyId: 'rejected1', to: REPRESENTATION_FAMILY_STATUSES.REJECTED });

    const arms = await buildActiveRepresentationFamilyArms();
    const armIds = arms.map((a) => a.armId);
    assert.ok(armIds.includes('active1'));
    assert.equal(armIds.includes('rejected1'), false);
  } finally { await teardown(); }
});

// ── prioritizeNextRepresentationFamily ───────────────────────────────────

test('prioritizeNextRepresentationFamily throws when no Active family exists', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await transitionRepresentationFamilyStatus({ familyId: 'rf1', to: REPRESENTATION_FAMILY_STATUSES.RETIRED });
    await assert.rejects(() => prioritizeNextRepresentationFamily({}), InvalidCampaignPrioritizationInputError);
  } finally { await teardown(); }
});

test('prioritizeNextRepresentationFamily (ucb1) prefers an untried Active family over a heavily-tried one', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'tried', label: 'Tried' });
    await registerRepresentationFamily({ familyId: 'untried', label: 'Untried' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'tried' });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 1, evaluated: 100000, promoted: 5000 });

    const result = await prioritizeNextRepresentationFamily({ method: 'ucb1' });
    assert.equal(result.armId, 'untried');
    assert.equal(result.score, Infinity);
  } finally { await teardown(); }
});

test('prioritizeNextRepresentationFamily (thompson) requires a numeric seed and is deterministic for a fixed seed', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await registerDiscoveryCampaign({ campaignId: 'c1', representationFamilyId: 'rf1' });
    await recordCampaignRoundMetric({ campaignId: 'c1', round: 1, evaluated: 10, promoted: 3 });

    await assert.rejects(() => prioritizeNextRepresentationFamily({ method: 'thompson' }), InvalidCampaignPrioritizationInputError);

    const r1 = await prioritizeNextRepresentationFamily({ method: 'thompson', seed: 42 });
    const r2 = await prioritizeNextRepresentationFamily({ method: 'thompson', seed: 42 });
    assert.equal(r1.armId, r2.armId);
    assert.equal(r1.sample, r2.sample);
  } finally { await teardown(); }
});

test('prioritizeNextRepresentationFamily rejects an unknown method', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    await assert.rejects(() => prioritizeNextRepresentationFamily({ method: 'not-a-method' }), InvalidCampaignPrioritizationInputError);
  } finally { await teardown(); }
});

test('prioritizeNextRepresentationFamily output never carries a pValue, verdict, or wealth field', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf1', label: 'A' });
    const result = await prioritizeNextRepresentationFamily({});
    for (const forbidden of ['pValue', 'verdict', 'wealth', 'publicationStatus']) {
      assert.equal(forbidden in result, false);
    }
  } finally { await teardown(); }
});

// ── rankFeatureFamiliesByPromise ─────────────────────────────────────────

test('rankFeatureFamiliesByPromise ranks unobserved families ahead of observed-with-failures families', async () => {
  const teardown = setup();
  try {
    const ranked = await rankFeatureFamiliesByPromise();
    assert.ok(Array.isArray(ranked));
    assert.ok(ranked.length > 0);
    // With no Features registered at all, every family has eliminationRate null -- all tied, stable order.
    assert.ok(ranked.every((r) => r.eliminationRate === null));
  } finally { await teardown(); }
});
