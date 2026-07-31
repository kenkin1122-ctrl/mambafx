/**
 * tests/phase11/publicationGate.test.mjs
 *
 * Verifies Part 1 §4: publication cannot proceed unless ResearchFreeze,
 * DatasetManifest, GeneratorVersion, OntologyVersion, ConfigurationHash,
 * ProxyVersions, ContextVersions, Candidate fingerprint, and SAP all match.
 * Phase11Orchestrator.checkPublicationEligibility composes the existing
 * ReproducibilityGate (Phase A) with the additional freeze/SAP/dataset-
 * manifest/context-version checks it does not itself cover.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { IndicatorFeature } from '../../research/src/candidate/IndicatorFeature.js';
import { PRIMITIVE_OBSERVABLES } from '../../research/src/candidate/MeasurementRegistry.js';
import { REPRODUCIBILITY_LEVELS } from '../../research/src/governance/reproducibilityLevels.js';
import { IMPLEMENTATION_MATURITY } from '../../research/src/governance/implementationMaturity.js';

/** Clones a frozen candidate with one field overridden (same technique as candidateLifecycleTransition.js). */
function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-pub-001', name: 'Publication gate test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
    ...overrides,
  });
}

async function makeFreeze(rc, overrides = {}) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
    ...overrides,
  });
}

async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-pub-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.03 },
    promotionPolicies: {}, stoppingRules: [], replicationCriteria: {}, publicationCriteria: {},
    effectSizeThresholds: { default: 0.1 }, minimumSampleSizes: { default: 200 }, requiredDiagnostics: [],
    ...overrides,
  });
}

/** Builds a candidate that already carries a plausible-passing set of publication fields. */
async function makeCandidate(rc, freezeIdPlaceholder, sapId, overrides = {}) {
  return IndicatorFeature.create({
    id: 'pub-cand-001', family: 'momentum', parameters: { threshold: 0.5 },
    description: 'Test candidate', generatorVersion: rc.generatorVersion, grammarVersion: '11.0.0',
    configHash: rc.configHash, researchConfigurationId: rc.id,
    researchFreezeId: freezeIdPlaceholder, sapId,
    indicatorName: 'RSI', period: 14, inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    reproducibilityLevel: REPRODUCIBILITY_LEVELS.CROSS_REGIME ?? 3,
    implementationMaturity: IMPLEMENTATION_MATURITY.STABLE,
    ...overrides,
  });
}

test('checkPublicationEligibility: passes when everything matches', async () => {
  const rc = await makeRc();
  const sap = await makeSap();
  // Fingerprint doesn't depend on researchFreezeId, so build the candidate first
  // with a placeholder, then patch researchFreezeId once the real freeze exists.
  const draft = await makeCandidate(rc, 'placeholder', sap.sapId);
  const freeze = await makeFreeze(rc, { candidateFingerprints: [draft.fingerprint] });
  const candidate = withField(draft, 'researchFreezeId', freeze.id);

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, rc);
  assert.equal(result.passed, true, result.failures.join('; '));
});

test('checkPublicationEligibility: fails when candidate.sapId does not match the active SAP', async () => {
  const rc = await makeRc();
  const sap = await makeSap();
  const otherSap = await makeSap({ sapId: 'sap-other-001' });
  const draft = await makeCandidate(rc, 'placeholder', otherSap.sapId);
  const freeze = await makeFreeze(rc, { candidateFingerprints: [draft.fingerprint] });
  const candidate = withField(draft, 'researchFreezeId', freeze.id);

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, rc);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('sapId mismatch')));
});

test('checkPublicationEligibility: fails when candidate.researchFreezeId does not match the active freeze', async () => {
  const rc = await makeRc();
  const sap = await makeSap();
  const candidate = await makeCandidate(rc, 'some-other-freeze-id', sap.sapId);
  const freeze = await makeFreeze(rc, { candidateFingerprints: [candidate.fingerprint] });

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, rc);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('researchFreezeId mismatch')));
});

test('checkPublicationEligibility: fails when configHash has drifted (ReproducibilityGate base check)', async () => {
  const rc = await makeRc();
  const driftedRc = await makeRc({ id: 'rc-pub-drift', proxyVersions: { msd: '2.0.0' } }); // different configHash
  const sap = await makeSap();
  const draft = await makeCandidate(rc, 'placeholder', sap.sapId);
  const freeze = await makeFreeze(rc, { candidateFingerprints: [draft.fingerprint] });
  const candidate = withField(draft, 'researchFreezeId', freeze.id);

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, driftedRc);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('configHash mismatch')));
});

test('checkPublicationEligibility: fails when datasetManifest does not match the frozen dataset snapshot', async () => {
  const rc = await makeRc();
  const sap = await makeSap();
  const draft = await makeCandidate(rc, 'placeholder', sap.sapId);
  const freeze = await makeFreeze(rc, { datasetSnapshotId: 'ds-frozen-001', candidateFingerprints: [draft.fingerprint] });
  const candidate = withField(draft, 'researchFreezeId', freeze.id);

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, rc, {
    currentDatasetSnapshotId: 'ds-frozen-001',
    datasetManifest: { datasetId: 'ds-DIFFERENT-002' },
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('datasetManifest mismatch')));
});

test('checkPublicationEligibility: fails when contextVersions have drifted', async () => {
  const rc = await makeRc();
  const sap = await makeSap();
  const draft = await makeCandidate(rc, 'placeholder', sap.sapId);
  const freeze = await makeFreeze(rc, { candidateFingerprints: [draft.fingerprint] });
  const candidate = withField(draft, 'researchFreezeId', freeze.id);

  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const result = orchestrator.checkPublicationEligibility(candidate, rc, {
    expectedContextVersions: { candleTiming: '1.0.0' },
    actualContextVersions: { candleTiming: '2.0.0' },
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('contextVersions')));
});

test('checkPublicationEligibility: never spends alpha (no import of onlineFdr.js/discoveryDecision.js)', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/orchestration/Phase11Orchestrator.js', import.meta.url), 'utf8'
  ));
  assert.ok(!/from\s+['"][^'"]*onlineFdr\.js['"]/.test(src));
  assert.ok(!/from\s+['"][^'"]*discoveryDecision\.js['"]/.test(src));
});
