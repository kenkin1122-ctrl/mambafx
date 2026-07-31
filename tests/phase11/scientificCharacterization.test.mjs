/**
 * tests/phase11/scientificCharacterization.test.mjs
 *
 * Integration tests for research/src/bridge/Phase11ScientificCharacterization.js —
 * post-confirmation-only RNG Forensics integration and the Discovery
 * Stability / Importance / Explainability composition.
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
  characterizeConfirmedCandidate,
  Phase11CharacterizationPreconditionError,
} from '../../research/src/bridge/Phase11ScientificCharacterization.js';
import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { FamilyRegistry } from '../../research/src/governance/FamilyRegistry.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { withPhase11Lifecycle } from '../../research/src/governance/candidateLifecycleTransition.js';
import { recordRandomnessAudit, RANDOMNESS_AUDIT_VERDICTS } from '../../research/src/governance/randomnessAudit.js';
import { RNG_FORENSICS_CLASSIFICATIONS } from '../../research/src/discovery/rngForensics.js';
import { createMathDefinition } from '../../research/src/plugin/MachineReadableMathematics.js';
import { getNode, listEdgesFrom } from '../../research/src/governance/knowledgeGraph.js';
import {
  PHASE11_NODE_TYPES, PHASE11_EDGE_TYPES,
  registerPhase11DiscoveryInKnowledgeGraph, registerPhase11CandidateInKnowledgeGraph,
} from '../../research/src/governance/phase11KnowledgeGraphBridge.js';

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
    id: 'rc-sci-001', name: 'Scientific characterization test', description: 'test',
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
    sapId: 'sap-sci-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.05 },
    promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100 }], replicationCriteria: {},
    publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [], ...overrides,
  });
}

async function buildConfirmedCandidate(orchestrator, rc, id) {
  const [{ candidate, provenance }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id, family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });
  const screened = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
  const triaged = withPhase11Lifecycle(screened, PHASE11_LIFECYCLE_STAGES.TRIAGED);
  const confirmResult = await orchestrator.confirm({
    candidate: triaged, researchConfiguration: rc,
    datasetManifest: { datasetId: `ds-${id}` }, provenance,
    market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 },
    pValue: 0.0001,
  });
  return { confirmed: confirmResult.candidate, hypothesisId: confirmResult.hypothesisId };
}

function makeMathDef() {
  return createMathDefinition({
    humanReadable: 'normalizedPosition = (close - low) / (high - low)',
    symbolicExpression: '\\frac{close - low}{high - low}',
    executableFormula: (input) => (input.close - input.low) / (input.high - input.low),
    units: 'dimensionless',
    domain: 'real-valued prices with high >= low',
    range: '[0, 1]',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RNG Forensics
// ═══════════════════════════════════════════════════════════════════════════

test('runRngForensicsForCandidate: refuses a non-Confirmed candidate before touching rngForensics.js', async () => {
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
        id: 'sci-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });

    await assert.rejects(
      orchestrator.runRngForensics(candidate, 'ph11_fake', {}),
      Phase11CharacterizationPreconditionError
    );
  } finally {
    teardown();
  }
});

test('runRngForensicsForCandidate: runs and records a classification for a Confirmed candidate with a survived randomness audit', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { confirmed, hypothesisId } = await buildConfirmedCandidate(orchestrator, rc, 'sci-cand-2');

    // Precondition: a randomness audit must already have survived for this hypothesis.
    await recordRandomnessAudit({
      hypothesisId, familyKey: 'family:test', verdict: RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE,
      reason: 'test setup', checksPerformed: ['test'], signals: null,
    });

    const result = await orchestrator.runRngForensics(confirmed, hypothesisId, {
      reseedWindowResults: [{ pValue: 0.01 }, { pValue: 0.02 }, { pValue: 0.03 }],
      alpha: 0.05,
    });

    assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
    assert.equal(result.hypothesisId, hypothesisId);
  } finally {
    teardown();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Stability / Importance / Explainability composition
// ═══════════════════════════════════════════════════════════════════════════

test('characterizeConfirmedCandidate: refuses a non-Confirmed candidate', async () => {
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
        id: 'sci-cand-3', family: 'momentum', parameters: { threshold: 0.5 },
        description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
        configHash: rc.configHash, researchConfigurationId: rc.id,
        indicatorName: 'RSI', period: 14, inputObservables: [],
      }],
    });

    await assert.rejects(orchestrator.characterize({
      candidate, partitionEffectSizes: [0.1, 0.1], pooledEffectSize: 0.1,
      noveltyScore: 0.5, evidenceTierWeight: 0.5, explainInputs: {},
    }), Phase11CharacterizationPreconditionError);
  } finally {
    teardown();
  }
});

test('characterizeConfirmedCandidate: composes stability + importance + explanation, and records a Knowledge Graph Characterization node', async () => {
  const teardown = await setup();
  try {
    const rc = await makeRc();
    const freeze = await makeFreeze(rc);
    const sap = await makeSap();
    const familyRegistry = new FamilyRegistry();
    familyRegistry.registerFamily({ familyName: 'momentum', version: '1.0.0', allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE] });
    const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap, familyRegistry });

    const { confirmed, hypothesisId } = await buildConfirmedCandidate(orchestrator, rc, 'sci-cand-4');

    const candidateNode = await registerPhase11CandidateInKnowledgeGraph(confirmed);
    const discoveryNode = await registerPhase11DiscoveryInKnowledgeGraph(candidateNode, { hypothesisId, familyKey: 'family:test' });

    const result = await orchestrator.characterize({
      candidate: confirmed,
      partitionEffectSizes: [0.12, 0.11, 0.13, 0.12], pooledEffectSize: 0.12,
      noveltyScore: 0.6, evidenceTierWeight: 0.5,
      explainInputs: {
        plainEnglishSummary: 'RSI-14 shows elevated readings before up-runs. Effect is modest but consistent.',
        mathDefinition: makeMathDef(),
        contextDescription: 'High-volatility regime.',
        interpretation: 'A PRNG-driven statistical association, not market-structure evidence.',
        knownLimitations: ['Small sample'],
        uncertainty: { estimate: 0.12, se: 0.02, ci95: [0.08, 0.16], sampleSize: 400, replicationCount: 1 },
      },
      discoveryNode,
      rngForensicsClassification: RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE,
    });

    assert.ok(result.stability.stabilityIndex > 0);
    assert.ok(result.scientificImportance >= 0 && result.scientificImportance <= 1);
    assert.ok(result.tradingImportance >= 0 && result.tradingImportance <= 1);
    assert.match(result.explanation.disclaimer, /PRNG/);
    assert.ok(result.characterizationNode);

    const edges = await listEdgesFrom(discoveryNode.id, { edgeType: PHASE11_EDGE_TYPES.CHARACTERIZED_BY });
    assert.equal(edges.length, 1);
    const characterizationNode = await getNode(PHASE11_NODE_TYPES.CHARACTERIZATION, result.characterizationNode.refId);
    assert.equal(characterizationNode.metadata.rngForensicsClassification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
  } finally {
    teardown();
  }
});

test('characterization never spends alpha and never imports onlineFdr/discoveryDecision', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/bridge/Phase11ScientificCharacterization.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
