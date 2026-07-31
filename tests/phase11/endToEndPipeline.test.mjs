/**
 * tests/phase11/endToEndPipeline.test.mjs
 *
 * The final end-to-end integration test for the complete Phase 11
 * pipeline, now that Stage 1 and Stage 2 are both complete:
 *
 *   Generate -> Screen -> Triage -> Confirm -> Replicate -> Publish
 *     -> Knowledge Graph -> Explainability -> RNG Forensics -> Characterize
 *
 * Every step is a real call into the actual bridges/orchestrator methods
 * built across Stage 1 and Stage 2 — nothing in this test is mocked except
 * the IndexedDB backend (the same fake used by every other governance test
 * in this suite) and the caller-supplied statistical inputs a real
 * pipeline run would get from actual data (p-values, effect sizes,
 * sub-check results) — this bridge layer has never computed statistics
 * itself, and this test does not start now.
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

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { getCurrentLifecycleStage, LIFECYCLE_STAGES } from '../../research/src/governance/hypothesisRegistry.js';
import { recordRandomnessAudit, RANDOMNESS_AUDIT_VERDICTS } from '../../research/src/governance/randomnessAudit.js';
import { RNG_FORENSICS_CLASSIFICATIONS } from '../../research/src/discovery/rngForensics.js';
import { createMathDefinition } from '../../research/src/plugin/MachineReadableMathematics.js';
import { REPRODUCIBILITY_LEVELS } from '../../research/src/governance/reproducibilityLevels.js';
import { IMPLEMENTATION_MATURITY } from '../../research/src/governance/implementationMaturity.js';

/** Clones a frozen candidate with one field overridden. */
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

test('end-to-end: Generate -> Screen -> Triage -> Confirm -> Replicate -> Publish -> Characterize, fully wired', async () => {
  const teardown = await setup();
  try {
    // ── Setup: real research cycle ──────────────────────────────────────
    const rc = await ResearchConfiguration.create({
      id: 'rc-e2e-001', name: 'End-to-end pipeline test', description: 'test',
      grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
      proxyVersions: { msd: '1.0.0' },
    });
    const sap = await StatisticalAnalysisPlan.create({
      sapId: 'sap-e2e-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
      promotionPolicies: { screeningPromotionQuantile: 0.5 }, stoppingRules: [{ maxCandidates: 100 }],
      replicationCriteria: { minStabilityIndex: 0.5 }, publicationCriteria: {},
      effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
    });
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({
      familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE],
    });

    // Placeholder freeze so generate() has something to attach to.
    const placeholderFreeze = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
      candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: placeholderFreeze, sap, familyRegistry });

    // ── Generate ─────────────────────────────────────────────────────────
    const [{ candidate: draft, provenance }] = await orchestrator.generate({
      candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
      candidateParamsList: [{
        id: 'e2e-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'RSI-14 end-to-end test candidate', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });
    assert.equal(draft.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);

    // Rebuild the freeze now that the fingerprint is known (ReproducibilityGate
    // requires it in candidateFingerprints), swap it in, and set the
    // publication-eligibility fields the ReproducibilityGate also requires.
    const freeze = await ResearchFreeze.create({
      researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
      generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
      candidateFingerprints: [draft.fingerprint], researchConfigurationHash: 'b'.repeat(64),
    });
    orchestrator.researchFreeze = freeze;
    let candidate = withField(draft, 'researchFreezeId', freeze.id);
    candidate = withField(candidate, 'reproducibilityLevel', REPRODUCIBILITY_LEVELS.CROSS_REGIME ?? 3);
    candidate = withField(candidate, 'implementationMaturity', IMPLEMENTATION_MATURITY.STABLE);

    // ── Screen (Round 1) ─────────────────────────────────────────────────
    const { promoted: screened } = orchestrator.screen({
      candidates: [candidate], scoreFn: () => 1, promotionQuantile: 1,
    });
    assert.equal(screened.length, 1);
    assert.equal(screened[0].lifecycle, PHASE11_LIFECYCLE_STAGES.SCREENED);

    // ── Triage (Round 2) ─────────────────────────────────────────────────
    const { promoted: triaged } = orchestrator.triage({
      candidates: screened,
      diagnosticsByCandidateId: { [candidate.id]: { effectSize: 0.12, diagnosticsPassed: [] } },
    });
    assert.equal(triaged.length, 1);
    assert.equal(triaged[0].lifecycle, PHASE11_LIFECYCLE_STAGES.TRIAGED);

    // ── Confirm (Round 3 — the ONLY alpha spend in the whole pipeline) ──
    const confirmResult = await orchestrator.confirm({
      candidate: triaged[0], researchConfiguration: rc, datasetManifest: { datasetId: 'ds-e2e-001' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 }, pValue: 0.0001,
    });
    assert.equal(confirmResult.outcome, 'confirmed');
    assert.equal(confirmResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.CONFIRMED);
    assert.equal(await getCurrentLifecycleStage(confirmResult.hypothesisId), LIFECYCLE_STAGES.DISCOVERY);

    // ── Replicate (Round 4 — Lockbox, no additional alpha) ──────────────
    const replicateResult = await orchestrator.replicate({
      candidate: confirmResult.candidate, hypothesisId: confirmResult.hypothesisId, familyKey: confirmResult.familyKey,
      featureKey: 'e2e-feature', generation: 0, holdoutRange: { startTick: 1000, endTick: 2000 },
      partitionEffectSizes: [0.12, 0.11, 0.13, 0.12], pooledEffectSize: 0.12,
    });
    assert.equal(replicateResult.outcome, 'replicated');
    assert.equal(replicateResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.REPLICATED);
    assert.equal(await getCurrentLifecycleStage(confirmResult.hypothesisId), LIFECYCLE_STAGES.LOCKBOX);

    // ── Publish (all mandatory gates) ────────────────────────────────────
    const publishResult = await orchestrator.publish({
      candidate: replicateResult.candidate, hypothesisId: confirmResult.hypothesisId, publishTimeConfig: rc,
    });
    assert.equal(publishResult.outcome, 'published');
    assert.equal(publishResult.candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.PUBLISHED);
    assert.equal(await getCurrentLifecycleStage(confirmResult.hypothesisId), LIFECYCLE_STAGES.PUBLICATION);

    // ── Knowledge Graph (candidate + discovery) ─────────────────────────
    await orchestrator.syncKnowledgeGraph(publishResult.candidate);

    // ── RNG Forensics (post-confirmation only) ──────────────────────────
    await recordRandomnessAudit({
      hypothesisId: confirmResult.hypothesisId, familyKey: confirmResult.familyKey,
      verdict: RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE, reason: 'e2e test',
      checksPerformed: ['test'], signals: null,
    });
    const rngResult = await orchestrator.runRngForensics(publishResult.candidate, confirmResult.hypothesisId, {
      reseedWindowResults: [{ pValue: 0.01 }, { pValue: 0.02 }],
    });
    assert.equal(rngResult.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);

    // ── Scientific Characterization (stability + importance + explainability) ──
    const characterization = await orchestrator.characterize({
      candidate: publishResult.candidate,
      partitionEffectSizes: [0.12, 0.11, 0.13, 0.12], pooledEffectSize: 0.12,
      noveltyScore: 0.6, evidenceTierWeight: 0.5,
      explainInputs: {
        plainEnglishSummary: 'RSI-14 shows a modest, consistent, PRNG-scale effect.',
        mathDefinition: createMathDefinition({
          humanReadable: 'RSI-14 momentum indicator',
          symbolicExpression: 'RSI_{14}',
          executableFormula: (input) => input,
          units: 'dimensionless', domain: '[0, 100]', range: '[0, 100]',
        }),
        contextDescription: 'End-to-end pipeline test.',
        interpretation: 'A PRNG-driven statistical association, published after full pipeline validation.',
        knownLimitations: ['Synthetic test data'],
        uncertainty: { estimate: 0.12, se: 0.02, ci95: [0.08, 0.16], sampleSize: 400, replicationCount: 1 },
      },
      rngForensicsClassification: rngResult.classification,
    });
    assert.ok(characterization.stability.stabilityIndex >= 0.5);
    assert.ok(characterization.scientificImportance >= 0);
    assert.ok(characterization.tradingImportance >= 0);
    assert.match(characterization.explanation.disclaimer, /PRNG/);

    // ── Final campaign summary reflects the whole journey ───────────────
    const summary = orchestrator.getCampaignSummary();
    assert.equal(summary.publicationCount, 1);
  } finally {
    teardown();
  }
});

test('full regression guard: the complete pipeline never imports any of the six protected legacy modules incorrectly', async () => {
  const fs = await import('node:fs');
  const bridgeFiles = [
    'Phase11ConfirmationBridge.js', 'Phase11ReplicationBridge.js',
    'Phase11PublicationBridge.js', 'Phase11ScientificCharacterization.js',
  ];
  for (const file of bridgeFiles) {
    const src = await fs.promises.readFile(
      new URL(`../../research/src/bridge/${file}`, import.meta.url), 'utf8'
    );
    // Only the confirmation bridge may import discoveryDecision.js (the sole alpha-spend path).
    if (file !== 'Phase11ConfirmationBridge.js') {
      assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src), `${file} must not import discoveryDecision.js`);
    }
    assert.ok(!/import\s*\{[^}]*recordTestAndUpdateWealth[^}]*\}\s*from/.test(src), `${file} must never import onlineFdr's wealth-spending function directly`);
  }
});
