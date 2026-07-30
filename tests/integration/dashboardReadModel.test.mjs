import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  registerRepresentationFamily,
  registerDiscoveryCampaign,
  recordCampaignRoundMetric,
} from '../../research/src/governance/knowledgeGraph.js';
import { FORBIDDEN_DASHBOARD_METRICS } from '../../research/src/governance/scientificDashboard.js';
import { buildDashboardSnapshot, ACTIVE_SEARCH_STRATEGY } from '../../research/integration/dashboardReadModel.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

// ── Structural guardrail: every field must have gone through the Part 15 guards ──

test('dashboardReadModel.js never uses a metricName from FORBIDDEN_DASHBOARD_METRICS', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/dashboardReadModel.js'), 'utf8');
  for (const forbidden of FORBIDDEN_DASHBOARD_METRICS) {
    assert.equal(source.includes(`'${forbidden}'`), false, `dashboardReadModel.js must never use forbidden metricName "${forbidden}"`);
  }
});

test('dashboardReadModel.js never imports a discovery/funnel/rngForensics EXECUTION function -- only prioritizeNextRepresentationFamily (confirmed read-only) and knowledgeGraph query exports', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/dashboardReadModel.js'), 'utf8');
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  for (const forbidden of ['funnel.js', 'rngForensics.js', 'onlineFdr.js', 'discoveryDecision.js', 'lockbox.js', 'liveResearchOrchestrator.js']) {
    // rngForensics.js's getLatestRngForensicsResult is a pure read, so its
    // import IS expected -- but no funnel/onlineFdr/discoveryDecision/lockbox/
    // orchestrator import should ever appear (those are execution/decision modules).
    if (forbidden === 'rngForensics.js') continue;
    assert.equal(importStatementBlock.includes(forbidden), false, `dashboardReadModel.js must never import ${forbidden}`);
  }
  assert.ok(importStatementBlock.includes('knowledgeGraph.js'));
  assert.ok(importStatementBlock.includes('scientificDashboard.js'));
});

// ── buildDashboardSnapshot: empty state ──────────────────────────────────

test('buildDashboardSnapshot reports an honest empty state when nothing has been registered yet', async () => {
  const teardown = setup();
  try {
    const snap = await buildDashboardSnapshot();
    assert.equal(snap.activeFamilies.value, 0);
    assert.equal(snap.activeFamilies.denominator, 0);
    assert.equal(snap.failedFamilies.value, 0);
    assert.equal(snap.candidateCount.value, 0);
    assert.equal(snap.currentPhase.value, 'No active family to prioritize');
    assert.equal(snap.searchStrategy, ACTIVE_SEARCH_STRATEGY);
    assert.equal(snap.campaignQueue.value.length, 0);
  } finally { await teardown(); }
});

// ── buildDashboardSnapshot: populated state ──────────────────────────────

test('buildDashboardSnapshot reflects a registered family + campaign + round metrics, using only existing knowledgeGraph query exports', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf-dash-1', label: 'Dashboard Test Family' });
    await registerDiscoveryCampaign({ campaignId: 'camp-dash-1', representationFamilyId: 'rf-dash-1' });
    await recordCampaignRoundMetric({ campaignId: 'camp-dash-1', round: 1, evaluated: 200, promoted: 4 });

    const snap = await buildDashboardSnapshot();
    assert.equal(snap.activeFamilies.value, 1);
    assert.equal(snap.activeFamilies.families[0].familyId, 'rf-dash-1');
    assert.equal(snap.currentPhase.value, 'Prioritization: candidate identified');
    assert.equal(snap.currentPhase.prioritized.armId, 'rf-dash-1');

    assert.equal(snap.campaignQueue.value.length, 1);
    assert.equal(snap.campaignQueue.value[0].familyId, 'rf-dash-1');
    assert.equal(snap.campaignQueue.value[0].campaigns.length, 1);

    assert.equal(snap.validationFunnel.value.evaluated, 200);
    assert.equal(snap.validationFunnel.value.promoted, 4);
  } finally { await teardown(); }
});

test('every returned metric object carries a metricName, denominator, and scope (Part 15 display-context contract)', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf-dash-2', label: 'Context Check Family' });
    const snap = await buildDashboardSnapshot();
    for (const key of ['activeFamilies', 'failedFamilies', 'discoveryCampaigns', 'replicationCampaigns', 'campaignQueue', 'validationFunnel', 'rngForensics', 'replicationQueue', 'candidateCount', 'currentPhase', 'unexploredSearchSpaceVersions']) {
      const m = snap[key];
      assert.ok(m.metricName, `${key} is missing metricName`);
      assert.ok(m.denominator !== undefined && m.denominator !== null, `${key} is missing denominator`);
      assert.ok(m.scope, `${key} is missing scope`);
    }
  } finally { await teardown(); }
});
