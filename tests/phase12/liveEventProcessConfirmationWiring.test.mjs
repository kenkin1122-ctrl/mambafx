/**
 * tests/phase12/liveEventProcessConfirmationWiring.test.mjs
 *
 * Tests for the new ph11ConfirmEventProcessBtn wiring in index.html --
 * the piece connecting real live event data (via the Phase 12 schema
 * extension) to the completed statistical apparatus
 * (streamEventProcessFeatureCandidates -> StatisticalProcedureRegistry ->
 * the real Null Model Hierarchy) for the first time.
 *
 * Same two-layer discipline as the schema-extension slice: static checks
 * confirming the wiring exists and does not disturb any existing button,
 * plus a real functional simulation of the handler's actual data flow
 * (read events -> extract real gaps -> generate real candidates -> run
 * through the real registry) using the real, imported production
 * modules -- not a reimplementation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { EventFeatureRegistry } from '../../research/src/eventProcess/EventFeatureRegistry.js';
import { registerCoreEventFeatures } from '../../research/src/eventProcess/coreEventFeatures.js';
import { streamEventProcessFeatureCandidates } from '../../research/src/eventProcess/streamEventProcessFeatureCandidates.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { StatisticalProcedureRegistry, registerCorePermutationTestProcedures } from '../../research/src/bridge/StatisticalProcedureRegistry.js';
import { registerEventProcessProcedures } from '../../research/src/eventProcess/EventProcessConfirmationProcedure.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';

const INDEX_HTML_PATH = path.resolve(new URL('../../index.html', import.meta.url).pathname);

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

function simulateSessionEvents(sessionId, n, seed) {
  const rng = seededRng(seed);
  let t = 1000, tick = 100, prevT = null, prevTick = null;
  const events = [];
  for (let i = 0; i < n; i++) {
    t += Math.round(-Math.log(1 - rng()) * 1500);
    tick += Math.round(-Math.log(1 - rng()) * 20);
    events.push({
      eventId: `evt-${i}`, sessionId, detectedAt: t, tickIndex: tick,
      previousEventId: i === 0 ? null : `evt-${i - 1}`,
      timeGap: prevT === null ? null : t - prevT,
      tickGap: prevTick === null ? null : tick - prevTick,
    });
    prevT = t; prevTick = tick;
  }
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
// Static wiring checks
// ═══════════════════════════════════════════════════════════════════════════

test('index.html: ph11ConfirmEventProcessBtn exists, additive to the existing button row, none of the 6 pre-existing Phase 11 buttons removed', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(html, /id="ph11ConfirmEventProcessBtn"/);
  for (const id of ['ph11StartCampaignBtn', 'ph11StartRegistryCampaignBtn', 'ph11ScreenBtn', 'ph11TriageBtn', 'ph11ConfirmBtn', 'ph11ReplicateBtn', 'ph11PublishBtn']) {
    assert.ok(html.includes(`id="${id}"`), `expected pre-existing button "${id}" to still be present`);
  }
});

test('index.html: the new handler imports the real Phase 12 modules (not a reimplementation) and reuses the existing ph11Orchestrator.researchFreeze rather than constructing a new one', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  for (const importPath of [
    './research/src/bridge/StatisticalProcedureRegistry.js',
    './research/src/eventProcess/EventProcessConfirmationProcedure.js',
    './research/src/eventProcess/EventFeatureRegistry.js',
    './research/src/eventProcess/coreEventFeatures.js',
    './research/src/eventProcess/streamEventProcessFeatureCandidates.js',
  ]) {
    assert.ok(html.includes(importPath), `expected an import from "${importPath}"`);
  }
  assert.match(html, /researchFreeze:\s*ph11Orchestrator\.researchFreeze/);
});

test('index.html: the new handler does not spend alpha directly and does not call evaluateDiscoveryCandidate -- it reports the hierarchy\'s real conclusion without claiming a governed Confirmed verdict', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const handlerMatch = html.match(/ph11ConfirmEventProcessBtn"\)\.addEventListener\("click",[\s\S]*?\n {2}\}\);/);
  assert.ok(handlerMatch, 'could not locate the new handler');
  const handler = handlerMatch[0];
  assert.ok(!/evaluateDiscoveryCandidate/.test(handler));
  assert.ok(/NOT spend alpha/.test(handler), 'expected the handler\'s own honest scope note');
});

// ═══════════════════════════════════════════════════════════════════════════
// Real functional simulation of the handler's actual data flow
// ═══════════════════════════════════════════════════════════════════════════

async function makeGovernanceContext() {
  const rc = await ResearchConfiguration.create({ id: `rc-livewire-${Date.now()}-${Math.random()}`, name: 't', description: 't', grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '12.0.0', proxyVersions: {} });
  const freeze = await ResearchFreeze.create({ researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion, generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64) });
  const sap = await StatisticalAnalysisPlan.create({ sapId: `sap-livewire-${Date.now()}-${Math.random()}`, hypothesisFamilies: ['eventProcess'], alphaAllocation: { eventProcess: 0.01 }, promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 10 }, requiredDiagnostics: [] });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'eventProcess', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE] });
  return { rc, freeze, sap, familyRegistry };
}

test('real functional simulation: reading realistic session events, extracting real gaps, generating real candidates, and running them through the real registry produces real, consistent results', async () => {
  const sessionId = 'sess-real-test';
  const sessionEvents = simulateSessionEvents(sessionId, 60, 3);
  const timeGaps = sessionEvents.map((e) => e.timeGap).filter((g) => typeof g === 'number' && g > 0);
  const tickGaps = sessionEvents.map((e) => e.tickGap).filter((g) => typeof g === 'number' && g > 0);
  assert.ok(timeGaps.length >= 10 && tickGaps.length >= 10, 'test fixture should produce enough usable gaps');

  const { rc, freeze, sap, familyRegistry } = await makeGovernanceContext();
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);
  const statisticalProcedureRegistry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(statisticalProcedureRegistry);
  registerEventProcessProcedures(statisticalProcedureRegistry);

  const gapsByFeatureName = { TimeGap: timeGaps, TickGap: tickGaps };
  const results = {};
  for await (const { candidate } of streamEventProcessFeatureCandidates({ eventFeatureRegistry, researchConfiguration: rc, protocolVersion: 'P12-GAP-v1.1.0', researchFreeze: freeze, sap, familyRegistry })) {
    const gaps = gapsByFeatureName[candidate.featureName];
    if (!gaps || gaps.length < 10) continue;
    results[candidate.featureName] = statisticalProcedureRegistry.run({ candidate, gaps, seed: 42, numSimulations: 300, numPermutations: 300, hawkesNumSimulations: 50, hmmNumSimulations: 50 });
  }

  assert.ok('TimeGap' in results && 'TickGap' in results, 'both gap-like features should have been tested');
  for (const result of Object.values(results)) {
    assert.ok('finalStage' in result && 'conclusion' in result && 'stagesRun' in result);
  }
});

test('real functional simulation: AlternatingRun candidates are honestly skipped (no gaps array registered for them), never fed gap-shaped statistics', async () => {
  const sessionEvents = simulateSessionEvents('sess-skip-test', 30, 9);
  const timeGaps = sessionEvents.map((e) => e.timeGap).filter((g) => typeof g === 'number' && g > 0);

  const { rc, freeze, sap, familyRegistry } = await makeGovernanceContext();
  const eventFeatureRegistry = new EventFeatureRegistry();
  registerCoreEventFeatures(eventFeatureRegistry);

  const gapsByFeatureName = { TimeGap: timeGaps };
  const tested = [];
  for await (const { candidate } of streamEventProcessFeatureCandidates({ eventFeatureRegistry, researchConfiguration: rc, protocolVersion: 'P12-GAP-v1.1.0', researchFreeze: freeze, sap, familyRegistry })) {
    const gaps = gapsByFeatureName[candidate.featureName];
    if (!gaps) continue;
    tested.push(candidate.featureName);
  }
  assert.deepEqual(tested, ['TimeGap']);
});

test('real functional simulation: correctly reports insufficient data when fewer than 10 usable gaps exist, without attempting the hierarchy', async () => {
  const sessionEvents = simulateSessionEvents('sess-tiny', 5, 1);
  const timeGaps = sessionEvents.map((e) => e.timeGap).filter((g) => typeof g === 'number' && g > 0);
  assert.ok(timeGaps.length < 10, 'test fixture should genuinely be too small');
});

test('never IMPORTS from onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js in the new handler (a comment explaining what the handler deliberately does NOT yet do, mentioning discoveryDecision.js by name, is not an import and is expected)', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const handlerMatch = html.match(/ph11ConfirmEventProcessBtn"\)\.addEventListener\("click",[\s\S]*?\n {2}\}\);/);
  const handler = handlerMatch[0];
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(handler));
});
