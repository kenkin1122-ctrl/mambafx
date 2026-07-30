/**
 * tests/phase11/provenance.test.mjs
 *
 * Unit tests for Phase 11 Phase C provenance layer:
 *   - provenance/ProvenanceDAG.js
 *   - provenance/FeatureProvenanceDAG.js
 *   - provenance/CandidateProvenance.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProvenanceDAG,
  NODE_TYPES,
  ProvenanceCycleError,
  UnknownProvenanceNodeError,
  InvalidProvenanceNodeError,
} from '../../research/src/provenance/ProvenanceDAG.js';
import { buildFeatureProvenanceDAG } from '../../research/src/provenance/FeatureProvenanceDAG.js';
import {
  buildCandidateProvenance,
  CandidateProvenanceError,
} from '../../research/src/provenance/CandidateProvenance.js';
import {
  PRIMITIVE_OBSERVABLES,
  MeasurementRegistry,
} from '../../research/src/candidate/MeasurementRegistry.js';
import { IndicatorFeature, INDICATOR_INPUT_FIELDS } from '../../research/src/candidate/IndicatorFeature.js';
import { CompositeCandidate, COMBINATORS } from '../../research/src/candidate/CompositeCandidate.js';

const BASE_FIELDS = {
  id: 'cand-001',
  family: 'momentum',
  parameters: { threshold: 0.5 },
  description: 'Test candidate',
  generatorVersion: '11.0.0',
  grammarVersion: '11.0.0',
  configHash: 'a'.repeat(64),
  researchConfigurationId: 'rc-001',
};

// ═══════════════════════════════════════════════════════════════════════════
// ProvenanceDAG
// ═══════════════════════════════════════════════════════════════════════════

test('ProvenanceDAG.addNode: registers a node and is idempotent for identical re-add', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.MEASUREMENT, label: 'A' });
  dag.addNode('a', { type: NODE_TYPES.MEASUREMENT, label: 'A again' }); // no throw
  assert.equal(dag.nodeCount, 1);
});

test('ProvenanceDAG.addNode: throws on conflicting re-add with a different type', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.MEASUREMENT });
  assert.throws(() => dag.addNode('a', { type: NODE_TYPES.FEATURE }), InvalidProvenanceNodeError);
});

test('ProvenanceDAG.addNode: throws on unrecognised type', () => {
  const dag = new ProvenanceDAG();
  assert.throws(() => dag.addNode('a', { type: 'NOT_A_TYPE' }), InvalidProvenanceNodeError);
});

test('ProvenanceDAG.addEdge: throws UnknownProvenanceNodeError for unregistered endpoints', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.FEATURE });
  assert.throws(() => dag.addEdge('a', 'ghost'), UnknownProvenanceNodeError);
  assert.throws(() => dag.addEdge('ghost', 'a'), UnknownProvenanceNodeError);
});

test('ProvenanceDAG.addEdge: throws ProvenanceCycleError for a self-loop', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.FEATURE });
  assert.throws(() => dag.addEdge('a', 'a'), ProvenanceCycleError);
});

test('ProvenanceDAG.addEdge: throws ProvenanceCycleError for a multi-hop cycle', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.FEATURE });
  dag.addNode('b', { type: NODE_TYPES.FEATURE });
  dag.addNode('c', { type: NODE_TYPES.FEATURE });
  dag.addEdge('b', 'a'); // b derivedFrom a
  dag.addEdge('c', 'b'); // c derivedFrom b
  // a derivedFrom c would close the loop a→c→b→a
  assert.throws(() => dag.addEdge('a', 'c'), ProvenanceCycleError);
});

test('ProvenanceDAG.ancestorsOf / descendantsOf: correct transitive closure', () => {
  const dag = new ProvenanceDAG();
  for (const id of ['m', 'f1', 'f2', 'cand']) dag.addNode(id, { type: NODE_TYPES.FEATURE });
  dag.addEdge('f1', 'm');    // f1 derivedFrom m
  dag.addEdge('f2', 'f1');   // f2 derivedFrom f1
  dag.addEdge('cand', 'f2'); // cand derivedFrom f2

  assert.deepEqual(new Set(dag.ancestorsOf('cand')), new Set(['f2', 'f1', 'm']));
  assert.deepEqual(new Set(dag.descendantsOf('m')), new Set(['f1', 'f2', 'cand']));
  assert.deepEqual(dag.ancestorsOf('m'), []);
  assert.deepEqual(dag.descendantsOf('cand'), []);
});

test('ProvenanceDAG.directParentsOf / directChildrenOf: one-hop only', () => {
  const dag = new ProvenanceDAG();
  for (const id of ['m', 'f1', 'f2']) dag.addNode(id, { type: NODE_TYPES.FEATURE });
  dag.addEdge('f1', 'm');
  dag.addEdge('f2', 'f1');
  assert.deepEqual(dag.directParentsOf('f2'), ['f1']);
  assert.deepEqual(dag.directChildrenOf('m'), ['f1']);
});

test('ProvenanceDAG.toJSON: serializes nodes and edges', () => {
  const dag = new ProvenanceDAG();
  dag.addNode('a', { type: NODE_TYPES.FEATURE });
  dag.addNode('b', { type: NODE_TYPES.MEASUREMENT });
  dag.addEdge('a', 'b');
  const json = dag.toJSON();
  assert.equal(json.nodes.length, 2);
  assert.deepEqual(json.edges, [{ child: 'a', parent: 'b' }]);
});

test('ProvenanceDAG.edgeCount: counts all edges', () => {
  const dag = new ProvenanceDAG();
  for (const id of ['a', 'b', 'c']) dag.addNode(id, { type: NODE_TYPES.FEATURE });
  dag.addEdge('b', 'a');
  dag.addEdge('c', 'a');
  assert.equal(dag.edgeCount, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// FeatureProvenanceDAG
// ═══════════════════════════════════════════════════════════════════════════

test('buildFeatureProvenanceDAG: resolves a primitive observable with no dependencies', () => {
  const reg = new MeasurementRegistry();
  const dag = buildFeatureProvenanceDAG([PRIMITIVE_OBSERVABLES.CANDLE_CLOSE], reg);
  assert.ok(dag.hasNode(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE));
  assert.equal(dag.getNode(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE).type, NODE_TYPES.MEASUREMENT);
  assert.equal(dag.edgeCount, 0);
});

test('buildFeatureProvenanceDAG: resolves a derived observable and its full dependency chain', () => {
  const reg = new MeasurementRegistry();
  reg.register('close_sma_14', 'SMA-14 of close', [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE]);
  reg.register('sma_slope', 'slope of the SMA', ['close_sma_14']);

  const dag = buildFeatureProvenanceDAG(['sma_slope'], reg);
  assert.ok(dag.hasNode('sma_slope'));
  assert.ok(dag.hasNode('close_sma_14'));
  assert.ok(dag.hasNode(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE));
  assert.equal(dag.getNode('sma_slope').type, NODE_TYPES.FEATURE);
  assert.equal(dag.getNode(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE).type, NODE_TYPES.MEASUREMENT);
  assert.deepEqual(new Set(dag.ancestorsOf('sma_slope')), new Set(['close_sma_14', PRIMITIVE_OBSERVABLES.CANDLE_CLOSE]));
});

test('buildFeatureProvenanceDAG: throws for an unregistered feature name', () => {
  const reg = new MeasurementRegistry();
  assert.throws(() => buildFeatureProvenanceDAG(['nonexistent'], reg));
});

// ═══════════════════════════════════════════════════════════════════════════
// CandidateProvenance
// ═══════════════════════════════════════════════════════════════════════════

async function makeIndicatorFeature(overrides = {}) {
  return IndicatorFeature.create({
    ...BASE_FIELDS,
    id: overrides.id ?? 'if-001',
    inputField: INDICATOR_INPUT_FIELDS.CLOSE,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    ...overrides,
  });
}

test('buildCandidateProvenance: builds a DAG rooted at the candidate with governance nodes', async () => {
  const candidate = await makeIndicatorFeature({
    researchFreezeId: 'freeze-001',
    sapId: 'sap-001',
  });
  const dag = buildCandidateProvenance(candidate, {
    researchConfigurationId: 'rc-001',
    researchFreezeId: 'freeze-001',
    sapId: 'sap-001',
    generatorVersion: '11.0.0',
  });

  assert.ok(dag.hasNode(candidate.id));
  assert.equal(dag.getNode(candidate.id).type, NODE_TYPES.CANDIDATE);
  assert.ok(dag.hasNode('rc-001'));
  assert.ok(dag.hasNode('freeze-001'));
  assert.ok(dag.hasNode('sap-001'));
  assert.ok(dag.hasNode('generator:11.0.0'));
  assert.ok(dag.directParentsOf(candidate.id).includes('freeze-001'));
  assert.ok(dag.directParentsOf(candidate.id).includes('sap-001'));
  // freeze should itself be linked to the configuration
  assert.ok(dag.directParentsOf('freeze-001').includes('rc-001'));
});

test('buildCandidateProvenance: merges feature/measurement lineage when featureProvenance is present', async () => {
  const reg = new MeasurementRegistry();
  reg.register('close_sma_14', 'SMA-14', [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE]);

  const candidate = await IndicatorFeature.create({
    ...BASE_FIELDS,
    id: 'if-002',
    inputField: INDICATOR_INPUT_FIELDS.CLOSE,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    featureProvenance: ['close_sma_14'],
  });

  const dag = buildCandidateProvenance(candidate, { measurementRegistry: reg });
  assert.ok(dag.hasNode('close_sma_14'));
  assert.ok(dag.hasNode(PRIMITIVE_OBSERVABLES.CANDLE_CLOSE));
  assert.ok(dag.directParentsOf(candidate.id).includes('close_sma_14'));
});

test('buildCandidateProvenance: throws if featureProvenance is set but no registry supplied', async () => {
  const candidate = await IndicatorFeature.create({
    ...BASE_FIELDS,
    id: 'if-003',
    inputField: INDICATOR_INPUT_FIELDS.CLOSE,
    indicatorName: 'RSI',
    period: 14,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
    featureProvenance: ['close_sma_14'],
  });
  assert.throws(() => buildCandidateProvenance(candidate, {}), CandidateProvenanceError);
});

test('buildCandidateProvenance: CompositeCandidate recurses into component provenance', async () => {
  const c1 = await makeIndicatorFeature({ id: 'comp-1' });
  const c2 = await makeIndicatorFeature({ id: 'comp-2' });
  const composite = await CompositeCandidate.create({
    ...BASE_FIELDS,
    id: 'composite-001',
    componentIds: [c1.id, c2.id],
    combinator: COMBINATORS.CONJUNCTION,
    weights: null,
  });

  const c1Dag = buildCandidateProvenance(c1, {});
  const dag = buildCandidateProvenance(composite, {
    componentProvenance: { [c1.id]: c1Dag },
  });

  // c1's full sub-DAG should be merged in.
  assert.ok(dag.hasNode(c1.id));
  assert.ok(dag.directParentsOf(composite.id).includes(c1.id));
  // c2 has no supplied sub-DAG, but is still recorded as a shallow reference.
  assert.ok(dag.hasNode(c2.id));
  assert.ok(dag.directParentsOf(composite.id).includes(c2.id));
});

test('buildCandidateProvenance: throws for a candidate missing an id', () => {
  assert.throws(() => buildCandidateProvenance({}), CandidateProvenanceError);
  assert.throws(() => buildCandidateProvenance(null), CandidateProvenanceError);
});
