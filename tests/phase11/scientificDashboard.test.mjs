/**
 * tests/phase11/scientificDashboard.test.mjs
 *
 * Tests for dashboard/Phase11ScientificDashboard.js -- Stage 9: pure
 * aggregation of existing orchestrator state, no new computation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { MarketStateRegistry } from '../../research/src/plugin/MarketStateRegistry.js';
import { registerCoreMarketStates } from '../../research/src/plugin/coreMarketStates.js';
import { MarketConstructProxyRegistry } from '../../research/src/proxy/MarketConstructProxyRegistry.js';
import { registerCoreProxies } from '../../research/src/proxy/coreProxies.js';
import { ContextRegistry } from '../../research/src/context/ContextRegistry.js';
import { registerCoreContexts } from '../../research/src/context/coreContexts.js';
import {
  streamMarketStateCandidates, streamProxyCandidates, streamConditionalHypothesisCandidates,
} from '../../research/src/discovery/registryDrivenCandidateGenerator.js';
import { buildPhase11ScientificDashboard } from '../../research/src/dashboard/Phase11ScientificDashboard.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

const FAMILIES = ['marketState', 'proxy', 'conditional'];

async function makeMixedCampaign() {
  const rc = await ResearchConfiguration.create({
    id: `rc-dash-${Date.now()}-${Math.random()}`, name: 't', description: 't',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {},
  });
  const freeze = await ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-dash-${Date.now()}-${Math.random()}`, hypothesisFamilies: FAMILIES,
    alphaAllocation: Object.fromEntries(FAMILIES.map((f) => [f, 0.01])),
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100000 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });
  const familyRegistry = new FamilyRegistry();
  for (const f of FAMILIES) familyRegistry.registerFamily({ familyName: f, version: '1.0.0', allowedCandidateTypes: Object.values(CANDIDATE_TYPES) });
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const proxyRegistry = new MarketConstructProxyRegistry(); registerCoreProxies(proxyRegistry);
  const contextRegistry = new ContextRegistry(); registerCoreContexts(contextRegistry);

  const baseCandidates = [];
  for await (const { candidate } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog })) {
    orchestrator.updateCandidate(candidate); baseCandidates.push(candidate);
  }
  for await (const { candidate } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog })) {
    orchestrator.updateCandidate(candidate);
  }
  for await (const { candidate } of streamConditionalHypothesisCandidates({ baseCandidates, contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry, decisionAuditLog: orchestrator.decisionAuditLog, contextsPerHypothesis: 2 })) {
    orchestrator.updateCandidate(candidate);
  }
  return orchestrator;
}

test('buildPhase11ScientificDashboard: includes the existing getCampaignSummary() verbatim, not a duplicate/competing summary', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.deepEqual(dashboard.campaignSummary, orchestrator.getCampaignSummary());
});

test('buildPhase11ScientificDashboard: candidateCountsByType/Family reflect real, exact counts from a real mixed campaign', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(dashboard.candidateCountsByType[CANDIDATE_TYPES.MARKET_STATE], 15);
  assert.equal(dashboard.candidateCountsByType[CANDIDATE_TYPES.PROXY_CANDIDATE], 10);
  assert.equal(dashboard.candidateCountsByType[CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS], 15);
  const totalByType = Object.values(dashboard.candidateCountsByType).reduce((a, b) => a + b, 0);
  assert.equal(totalByType, orchestrator.listCandidates().length);
});

test('buildPhase11ScientificDashboard: proxyUsage tallies every registered proxy exactly once each (one ProxyCandidate per proxy in this campaign)', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(Object.keys(dashboard.proxyUsage).length, 10);
  assert.ok(Object.values(dashboard.proxyUsage).every((n) => n === 1));
  assert.equal(dashboard.proxyUsage.RecentLocalMinimumProxy, 1);
});

test('buildPhase11ScientificDashboard: contextUsage tallies real contextNames from real ConditionalHypothesis candidates, summing to 2x the conditional count (contextsPerHypothesis=2)', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(dashboard.conditionalHypothesisCount, 15);
  const totalContextUsage = Object.values(dashboard.contextUsage).reduce((a, b) => a + b, 0);
  assert.equal(totalContextUsage, 30); // 15 hypotheses x 2 contexts each
});

test('buildPhase11ScientificDashboard: evidenceTier/implementationMaturity/reproducibilityLevel reflect real Candidate.js default field values, not fabricated ones', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(dashboard.evidenceTierBreakdown.E0, orchestrator.listCandidates().length);
  assert.equal(dashboard.implementationMaturityBreakdown.Prototype, orchestrator.listCandidates().length);
  assert.equal(dashboard.reproducibilityLevelSummary.count, orchestrator.listCandidates().length);
  assert.equal(dashboard.reproducibilityLevelSummary.mean, 0);
});

test('buildPhase11ScientificDashboard: decisionAuditSummary reflects real DecisionAuditLog entries (one GENERATED per candidate actually generated)', async () => {
  const orchestrator = await makeMixedCampaign();
  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(dashboard.decisionAuditSummary.GENERATED, orchestrator.listCandidates().length);
});

test('buildPhase11ScientificDashboard: handles an empty campaign gracefully (no candidates yet)', async () => {
  const rc = await ResearchConfiguration.create({ id: 'rc-empty', name: 't', description: 't', grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {} });
  const freeze = await ResearchFreeze.create({ researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion, generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64) });
  const sap = await StatisticalAnalysisPlan.create({ sapId: 'sap-empty', hypothesisFamilies: ['x'], alphaAllocation: { x: 0.01 }, promotionPolicies: {}, stoppingRules: [{ maxCandidates: 10 }], replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [] });
  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({ familyName: 'x', version: '1.0.0', allowedCandidateTypes: Object.values(CANDIDATE_TYPES) });
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

  const dashboard = buildPhase11ScientificDashboard(orchestrator);
  assert.equal(dashboard.campaignSummary.candidateCount, 0);
  assert.deepEqual(dashboard.candidateCountsByType, {});
  assert.equal(dashboard.conditionalHypothesisCount, 0);
  assert.equal(dashboard.reproducibilityLevelSummary.count, 0);
  assert.equal(dashboard.reproducibilityLevelSummary.mean, null);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js, and computes no new statistics of its own', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/dashboard/Phase11ScientificDashboard.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
  assert.ok(!/stabilityIndex\s*=/.test(src));
  assert.ok(!/computeBootstrapCI|createSeededRng/.test(src));
});
