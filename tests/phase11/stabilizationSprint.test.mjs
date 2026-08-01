/**
 * tests/phase11/stabilizationSprint.test.mjs
 *
 * Regression tests for the Phase 11 Stabilization Sprint (State
 * Consistency & Persistence). Covers all five audited issues:
 *   1. hypothesisRegistry's unique (lineageId, generationId) index no
 *      longer collides across candidates sharing the same broad family.
 *   2. getCampaignSummary() distinguishes confirmation attempts, confirmed
 *      discoveries, rejected confirmations, and archived negative evidence
 *      -- not just "candidates currently at the Confirmed stage".
 *   3. Lifecycle stays synchronized across Phase 11 state, the legacy
 *      hypothesis registry, DecisionAuditLog, and NegativeEvidenceRegistry
 *      for a MIX of confirmed and rejected candidates in one cycle.
 *   4. index.html's Screen/Triage buttons call the orchestrator's own
 *      screen()/triage() methods (which persist into its registry), not
 *      the standalone funnel functions directly (which silently didn't).
 *   5. Every dashboard-relevant count is derived from the orchestrator's
 *      persisted state (its _candidates registry, DecisionAuditLog,
 *      NegativeEvidenceRegistry), verified consistent end to end.
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
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-stab-001', name: 'stabilization sprint test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
  });
}
async function makeFreeze(rc) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
}
async function makeSap() {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-stab-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [],
  });
}

test('MASTER REGRESSION: multiple same-family candidates, mixed confirm/reject outcomes, in one research cycle -- dashboard counts stay consistent with persisted state end to end', async () => {
  const teardown = setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    // ── Generate: same real-world shape as the reported bug -- three
    //    different indicators, all in the SAME broad family. ──────────────
    const generated = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [
        { id: 'stab-rsi', family: 'momentum', parameters: { period: 14 }, description: 'RSI', generatorVersion: '11.0.0', grammarVersion: '11.0.0', configHash: rc.configHash, researchConfigurationId: rc.id, indicatorName: 'RSI', period: 14, inputObservables: [] },
        { id: 'stab-ema', family: 'momentum', parameters: { period: 10 }, description: 'EMA', generatorVersion: '11.0.0', grammarVersion: '11.0.0', configHash: rc.configHash, researchConfigurationId: rc.id, indicatorName: 'EMA_SLOPE', period: 10, inputObservables: [] },
        { id: 'stab-cci', family: 'momentum', parameters: { period: 20 }, description: 'CCI', generatorVersion: '11.0.0', grammarVersion: '11.0.0', configHash: rc.configHash, researchConfigurationId: rc.id, indicatorName: 'CCI', period: 20, inputObservables: [] },
      ],
    });
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Generated, 3);
    assert.equal(orchestrator.getCampaignSummary().candidateCount, 3);

    // ── Screen (via the orchestrator's own method -- the Bug #4 fix path) ──
    const candidates = generated.map((g) => g.candidate);
    const { promoted: screened } = orchestrator.screen({
      candidates, scoreFn: () => 1, promotionQuantile: 1, // promote all three
    });
    assert.equal(screened.length, 3);
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Screened, 3, 'Bug #4 regression: Screened count must reflect real screening results');

    // ── Triage (same fix path) ──
    const diagnosticsByCandidateId = {};
    for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.1, diagnosticsPassed: [] };
    const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });
    assert.equal(triaged.length, 3);
    assert.equal(orchestrator.getCampaignSummary().countsByStage.Triaged, 3, 'Bug #4 regression: Triaged count must reflect real triage results');

    // ── Confirm all three -- exactly the scenario that previously hit the
    //    by_lineage_generation uniqueness collision (Bug #1) on the second
    //    and third candidate. Mix outcomes: RSI+EMA confirmed, CCI rejected. ──
    const provenanceById = {};
    for (const g of generated) provenanceById[g.candidate.id] = g.provenance;

    const confirmResults = [];
    for (const candidate of triaged) {
      const pValue = candidate.id === 'stab-cci' ? 0.99 : 0.0001; // CCI deliberately rejected
      const result = await orchestrator.confirm({
        candidate, researchConfiguration: rc,
        datasetManifest: { datasetId: `ds-${candidate.id}` }, provenance: provenanceById[candidate.id],
        market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 }, pValue,
      });
      confirmResults.push(result);
    }

    // Bug #1 regression: none of the three confirmations threw a
    // uniqueness error -- all three completed with a real outcome.
    assert.equal(confirmResults.length, 3);
    assert.equal(confirmResults.filter((r) => r.outcome === 'confirmed').length, 2);
    assert.equal(confirmResults.filter((r) => r.outcome === 'rejected').length, 1);

    // ── Bug #2/#5 regression: getCampaignSummary() now distinguishes
    //    attempts / confirmed / rejected / archived negative evidence, all
    //    consistent with what actually happened. ──────────────────────────
    const summary = orchestrator.getCampaignSummary();
    assert.equal(summary.confirmationAttempts, 3, 'all three candidates attempted confirmation');
    assert.equal(summary.confirmedDiscoveries, 2, 'RSI and EMA were genuinely confirmed');
    assert.equal(summary.rejectedConfirmations, 1, 'CCI was genuinely rejected -- this must NOT show as 0');
    assert.equal(summary.archivedNegativeEvidenceCount, 1, 'CCI\'s rejection must be archived, not discarded');
    assert.equal(summary.countsByStage.Confirmed, 2);
    assert.equal(summary.countsByStage.Deprecated, 1);
    assert.equal(summary.confirmedCount, 2); // backward-compatible current-lifecycle-state count

    // ── Bug #3 regression: lifecycle stays synchronized across every
    //    system of record for BOTH the confirmed and the rejected candidate. ──
    for (const result of confirmResults) {
      const legacyStage = await getCurrentLifecycleStage(result.hypothesisId);
      if (result.outcome === 'confirmed') {
        assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.CONFIRMED);
        assert.equal(legacyStage, LIFECYCLE_STAGES.DISCOVERY);
        const auditEntries = orchestrator.decisionAuditLog.forCandidate(result.candidate.id);
        assert.ok(auditEntries.some((e) => e.decisionType === 'CONFIRMED'));
      } else {
        assert.equal(result.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.DEPRECATED);
        assert.equal(legacyStage, LIFECYCLE_STAGES.FEATURE_GENERATION); // never advanced to Discovery
        const auditEntries = orchestrator.decisionAuditLog.forCandidate(result.candidate.id);
        assert.ok(auditEntries.some((e) => e.decisionType === 'CONFIRMED_REJECTED'));
        const negEntries = orchestrator.negativeEvidenceRegistry.byFingerprint(result.candidate.fingerprint);
        assert.equal(negEntries.length, 1);
      }
      // The orchestrator's OWN registry (what the dashboard reads) reflects
      // the exact same lifecycle the candidate object itself carries.
      assert.equal(orchestrator.getCandidate(result.candidate.id).lifecycle, result.candidate.lifecycle);
    }

    // ── Bug #1 regression, explicit: each candidate landed in its own
    //    lineage (fingerprint-derived), not one shared, colliding lineage. ──
    const hypothesisIds = confirmResults.map((r) => r.hypothesisId);
    assert.equal(new Set(hypothesisIds).size, 3, 'all three hypothesis IDs must be distinct');
  } finally {
    teardown();
  }
});

test('index.html wiring: readiness and confirmation both resolve indicators through the SAME canonical Indicator Registry instance, for both demo and registry-driven candidates', async () => {
  const fs = await import('node:fs');
  const html = await fs.promises.readFile(new URL('../../index.html', import.meta.url), 'utf8');

  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const ph11Script = scriptMatches.map((m) => m[1]).find((s) => s.includes('ph11StartRegistryCampaignBtn'));
  assert.ok(ph11Script, 'could not locate the Phase 11 campaign script block');

  // Exactly one IndicatorRegistry construction in this script -- not one
  // per call site, not a second lookup table.
  const registryConstructions = (ph11Script.match(/new IndicatorRegistry\(\)/g) || []).length;
  assert.equal(registryConstructions, 1, 'exactly one canonical IndicatorRegistry instance must be constructed, shared by readiness and confirmation alike');

  // Readiness and Confirmation both reference that SAME instance.
  assert.match(ph11Script, /computeOverallReadiness\(\{[\s\S]{0,200}indicatorRegistry:\s*ph11IndicatorRegistry/);
  assert.match(ph11Script, /confirmAutomatically\(\{[\s\S]{0,200}indicatorRegistry:\s*ph11IndicatorRegistry/);

  // The Validation Dashboard script (a separate module scope) constructs
  // its own instance from the SAME canonical source, not a duplicate
  // definition of the indicator math itself.
  const valScript = scriptMatches.map((m) => m[1]).find((s) => s.includes('ph11ValRunBtn'));
  assert.ok(valScript, 'could not locate the Phase 11 Validation Dashboard script block');
  assert.match(valScript, /import\s*\{\s*IndicatorRegistry\s*\}\s*from\s*"\.\/research\/src\/indicator\/IndicatorRegistry\.js"/);
  assert.match(valScript, /verifyReproducibility\(\{[\s\S]{0,200}indicatorRegistry:/);
});

test('index.html wiring: the registry-driven campaign button calls startRegistryDrivenCampaign() and is wired alongside the demo campaign path', async () => {
  const fs = await import('node:fs');
  const html = await fs.promises.readFile(new URL('../../index.html', import.meta.url), 'utf8');

  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const ph11Script = scriptMatches.map((m) => m[1]).find((s) => s.includes('ph11StartRegistryCampaignBtn'));
  assert.ok(ph11Script, 'could not locate the Phase 11 campaign script block containing ph11StartRegistryCampaignBtn');

  assert.match(ph11Script, /import\s*\{\s*startPhase11Campaign,\s*startRegistryDrivenCampaign\s*\}/);
  assert.match(ph11Script, /startRegistryDrivenCampaign\(\{/);
  assert.match(html, /id="ph11StartRegistryCampaignBtn"/);
});

test('index.html wiring: Screen and Triage buttons call the orchestrator\'s own screen()/triage() methods, not the standalone funnel functions directly', async () => {
  const fs = await import('node:fs');
  const html = await fs.promises.readFile(new URL('../../index.html', import.meta.url), 'utf8');

  // Extract just the Phase 11 campaign module script for a precise check.
  const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const ph11Script = scriptMatches.map((m) => m[1]).find((s) => s.includes('ph11ScreenBtn') && s.includes('ph11TriageBtn'));
  assert.ok(ph11Script, 'could not locate the Phase 11 campaign script block in index.html');

  assert.match(ph11Script, /ph11Orchestrator\.screen\(\{/, 'Screen button must call ph11Orchestrator.screen(), not the standalone function');
  assert.match(ph11Script, /ph11Orchestrator\.triage\(\{/, 'Triage button must call ph11Orchestrator.triage(), not the standalone function');
  // The standalone functions should no longer be imported into this script at all.
  assert.ok(!/import\s*\{[^}]*runPhase11Screening[^}]*\}/.test(ph11Script), 'runPhase11Screening should no longer be imported directly');
  assert.ok(!/import\s*\{[^}]*runPhase11Triage[^}]*\}/.test(ph11Script), 'runPhase11Triage should no longer be imported directly');
});
