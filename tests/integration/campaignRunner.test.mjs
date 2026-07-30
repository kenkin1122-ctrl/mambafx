import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import { registerRepresentationFamily } from '../../research/src/governance/knowledgeGraph.js';
import { runResearchCampaignStep } from '../../research/integration/campaignRunner.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

// ── Structural guardrail: manual-only, no execution/decision imports ────

test('campaignRunner.js never imports Online FDR / Discovery Decision / Lockbox / Publication Status / Funnel round-execution functions directly', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/campaignRunner.js'), 'utf8');
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  for (const forbidden of ['onlineFdr.js', 'discoveryDecision.js', 'lockbox.js', 'publicationStatus.js', 'funnel.js', 'liveResearchOrchestrator.js']) {
    assert.equal(importStatementBlock.includes(forbidden), false, `campaignRunner.js must never import ${forbidden}`);
  }
  assert.ok(importStatementBlock.includes('campaignPrioritization.js'));
});

test('campaignRunner.js does not reference setInterval/setTimeout anywhere (manual-only, no automatic cadence per the approved rollout decision)', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/campaignRunner.js'), 'utf8');
  assert.equal(/setInterval|setTimeout/.test(source), false);
});

// ── runResearchCampaignStep behavior ─────────────────────────────────────

test('runResearchCampaignStep reports ok:false with an honest message when no Active Representation Family exists yet (does not fabricate one)', async () => {
  const teardown = setup();
  try {
    const result = await runResearchCampaignStep();
    assert.equal(result.ok, false);
    assert.match(result.message, /no Active Representation Family exists/);
    assert.equal(result.prioritization, null);
    assert.ok(result.snapshot); // dashboard still rebuilt even on the "nothing to do" path
  } finally { await teardown(); }
});

test('runResearchCampaignStep reports ok:true with a real prioritization result when an Active Representation Family exists, and explicitly discloses it does not fabricate downstream funnel/evidence input', async () => {
  const teardown = setup();
  try {
    await registerRepresentationFamily({ familyId: 'rf-runner-1', label: 'Runner Test Family' });
    const result = await runResearchCampaignStep();
    assert.equal(result.ok, true);
    assert.equal(result.prioritization.armId, 'rf-runner-1');
    assert.match(result.message, /human-supplied/);
    assert.ok(result.snapshot);
  } finally { await teardown(); }
});
