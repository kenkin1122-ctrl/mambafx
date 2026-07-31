/**
 * tests/phase11/knowledgeGraphIntegration.test.mjs
 *
 * Verifies Part 1 §1: the Phase 11 Knowledge Graph bridge registers new
 * entity types and the Measurement -> Feature -> Context -> Proxy ->
 * Candidate chain through knowledgeGraph.js's existing generic
 * registerNode/registerEdge API, with zero modification to that file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import { getNode, listEdgesFrom } from '../../research/src/governance/knowledgeGraph.js';
import {
  PHASE11_NODE_TYPES,
  PHASE11_EDGE_TYPES,
  registerPhase11CandidateInKnowledgeGraph,
  registerPhase11ChainLink,
  recordPhase11NegativeEvidenceInKnowledgeGraph,
} from '../../research/src/governance/phase11KnowledgeGraphBridge.js';
import { IndicatorFeature } from '../../research/src/candidate/IndicatorFeature.js';
import { PRIMITIVE_OBSERVABLES } from '../../research/src/candidate/MeasurementRegistry.js';
import { NegativeEvidenceRegistry, REJECTION_STAGES } from '../../research/src/governance/NegativeEvidenceRegistry.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function makeCandidate(overrides = {}) {
  return IndicatorFeature.create({
    id: 'kgi-cand-001',
    family: 'momentum',
    parameters: { threshold: 0.5 },
    description: 'Test candidate',
    generatorVersion: '11.0.0',
    grammarVersion: '11.0.0',
    configHash: 'a'.repeat(64),
    researchConfigurationId: 'rc-kgi-001',
    researchFreezeId: 'freeze-kgi-001',
    sapId: 'sap-kgi-001',
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    ...overrides,
  });
}

test('registerPhase11CandidateInKnowledgeGraph: registers the candidate node and its governance edges', async () => {
  const teardown = setup();
  try {
    const candidate = await makeCandidate();
    const node = await registerPhase11CandidateInKnowledgeGraph(candidate, {
      contextIds: ['ctx-1'], proxyIds: ['proxy-1'], datasetManifestId: 'dm-1',
    });

    const fetched = await getNode(PHASE11_NODE_TYPES.INDICATOR_FEATURE, candidate.id);
    assert.ok(fetched);
    assert.equal(fetched.metadata.fingerprint, candidate.fingerprint);

    const edges = await listEdgesFrom(node.id);
    const edgeTypes = edges.map(e => e.edgeType).sort();
    assert.deepEqual(edgeTypes, [
      PHASE11_EDGE_TYPES.CONDITIONED_ON,
      PHASE11_EDGE_TYPES.ESTIMATES,
      PHASE11_EDGE_TYPES.PRODUCED_UNDER,
      PHASE11_EDGE_TYPES.PRODUCED_UNDER,
      PHASE11_EDGE_TYPES.PRODUCED_UNDER,
      PHASE11_EDGE_TYPES.PRODUCED_UNDER,
    ].sort());
  } finally {
    teardown();
  }
});

test('registerPhase11ChainLink: registers Measurement -> Feature edge', async () => {
  const teardown = setup();
  try {
    const { featureNode, measurementNode } = await registerPhase11ChainLink('feat-1', 'meas-1');
    const edges = await listEdgesFrom(featureNode.id, { edgeType: PHASE11_EDGE_TYPES.DERIVED_FROM });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toNodeId, measurementNode.id);
  } finally {
    teardown();
  }
});

test('recordPhase11NegativeEvidenceInKnowledgeGraph: links a rejection to the candidate node and is queryable', async () => {
  const teardown = setup();
  try {
    const candidate = await makeCandidate({ id: 'kgi-cand-002' });
    const candidateNode = await registerPhase11CandidateInKnowledgeGraph(candidate);

    const negReg = new NegativeEvidenceRegistry();
    const entry = negReg.record({
      candidateFingerprint: candidate.fingerprint,
      stageRejected: REJECTION_STAGES.SCREENING,
      reason: 'did not survive quantile cut',
    });

    const neNode = await recordPhase11NegativeEvidenceInKnowledgeGraph(candidateNode, entry);
    assert.equal(neNode.nodeType, PHASE11_NODE_TYPES.NEGATIVE_EVIDENCE);

    const edges = await listEdgesFrom(candidateNode.id, { edgeType: PHASE11_EDGE_TYPES.REJECTED_AS });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toNodeId, neNode.id);
  } finally {
    teardown();
  }
});

test('Phase 11 KG bridge uses only knowledgeGraph.js\'s existing generic registerNode/registerEdge (no direct storage access)', async () => {
  const src = await import('node:fs').then(fs => fs.promises.readFile(
    new URL('../../research/src/governance/phase11KnowledgeGraphBridge.js', import.meta.url), 'utf8'
  ));
  assert.match(src, /import\s*\{\s*registerNode,\s*registerEdge\s*\}\s*from\s*'\.\/knowledgeGraph\.js'/);
  assert.ok(!/getKnowledgeGraphNodesAdapter|getKnowledgeGraphEdgesAdapter/.test(src), 'bridge must not bypass knowledgeGraph.js\'s public API');
});
