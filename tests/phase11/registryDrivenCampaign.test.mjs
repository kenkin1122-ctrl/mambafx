/**
 * tests/phase11/registryDrivenCampaign.test.mjs
 *
 * Integration tests for startRegistryDrivenCampaign() (Stage 9: automatic
 * registration into Generated -> Screened -> Triaged -> Confirmed, without
 * altering confirmation itself).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';

import { startRegistryDrivenCampaign } from '../../research/src/orchestration/startPhase11Campaign.js';
import { PHASE11_LIFECYCLE_STAGES } from '../../research/src/governance/phase11LifecycleStates.js';
import { REPRODUCIBILITY_LEVELS } from '../../research/src/governance/reproducibilityLevels.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

/** Clones a frozen candidate with one field overridden. */
function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

test('startRegistryDrivenCampaign: generates far more than the old 3-candidate demo, with a real freeze/fingerprint match for every candidate', async () => {
  const { orchestrator, researchFreeze, generatedCount, countsByType } = await startRegistryDrivenCampaign({
    indicatorPeriods: [10, 14, 20, 50], includeMarketStates: true,
  });

  assert.ok(generatedCount > 40, `expected a much larger candidate space than the old 3-candidate demo, got ${generatedCount}`);
  assert.equal(countsByType.indicator, 11 * 4); // 11 core indicators x 4 periods
  assert.equal(countsByType.marketState, 8);
  assert.equal(orchestrator.listCandidates().length, generatedCount);

  for (const candidate of orchestrator.listCandidates()) {
    assert.equal(candidate.lifecycle, PHASE11_LIFECYCLE_STAGES.GENERATED);
    assert.equal(candidate.researchFreezeId, researchFreeze.id);
    assert.ok(researchFreeze.candidateFingerprints.includes(candidate.fingerprint));
  }

  // No duplicate fingerprints anywhere in the generated set (Stage 8).
  const fingerprints = orchestrator.listCandidates().map((c) => c.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test('startRegistryDrivenCampaign: with composites enabled, produces real CompositeCandidate instances too', async () => {
  const { countsByType, generatedCount } = await startRegistryDrivenCampaign({
    indicatorPeriods: [14], includeMarketStates: true, includeComposites: true,
  });
  assert.ok(countsByType.composite > 0);
  assert.equal(generatedCount, countsByType.indicator + countsByType.marketState + countsByType.composite);
});

test('startRegistryDrivenCampaign -> Screen -> Triage -> Confirm: a registry-generated candidate flows through the EXACT SAME unmodified confirmation pipeline as the demo generator', async () => {
  const teardown = setup();
  try {
    const { orchestrator, researchConfiguration } = await startRegistryDrivenCampaign({
      indicatorPeriods: [14], includeMarketStates: false,
    });

    const candidates = orchestrator.listCandidates();
    assert.ok(candidates.length >= 11);

    const { promoted: screened } = orchestrator.screen({
      candidates, scoreFn: () => 1, promotionQuantile: 1,
    });
    assert.equal(screened.length, candidates.length);

    const diagnosticsByCandidateId = {};
    for (const c of screened) diagnosticsByCandidateId[c.id] = { effectSize: 0.1, diagnosticsPassed: [] };
    const { promoted: triaged } = orchestrator.triage({ candidates: screened, diagnosticsByCandidateId });
    assert.equal(triaged.length, candidates.length);

    // Confirm just one, to prove the wiring works end to end without
    // running the whole set through the real statistical pipeline.
    const target = withField(triaged[0], 'reproducibilityLevel', REPRODUCIBILITY_LEVELS.CROSS_REGIME ?? 3);
    const provenance = { hasNode: () => true }; // minimal stub satisfying confirmPhase11Candidate's provenance check
    const result = await orchestrator.confirm({
      candidate: target, researchConfiguration, datasetManifest: { datasetId: 'ds-registry-test' }, provenance,
      market: 'R_100', targetDefinition: { direction: 'Rise', runLength: 5 }, pValue: 0.0001,
    });
    assert.ok(['confirmed', 'rejected'].includes(result.outcome));
  } finally {
    teardown();
  }
});
