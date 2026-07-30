/**
 * research/src/provenance/FeatureProvenanceDAG.js
 *
 * Purpose:
 *   Builds the Level 1→2 (Measurement→Derived Feature) slice of a
 *   candidate's provenance: given a set of feature names and the campaign's
 *   MeasurementRegistry (Phase A), constructs a ProvenanceDAG whose edges
 *   are the registry's own `derivedFrom` declarations, recursively resolved
 *   down to primitive observables.
 *
 * Scientific rationale:
 *   Directive requirement #19 ("Feature Provenance for every generated
 *   feature"). MeasurementRegistry.register() already requires every
 *   derived observable to declare its immediate dependencies (Phase A); this
 *   module is a pure read-side traversal of that already-authoritative
 *   information — it does not introduce a second source of truth for
 *   feature lineage, it only reifies the registry's dependency graph into
 *   ProvenanceDAG form so it can be merged into a candidate's full
 *   CandidateProvenance DAG (see CandidateProvenance.js) and inspected
 *   independently (e.g. by CausalLeakageValidator or a human reviewer asking
 *   "which primitives ultimately feed this feature?").
 *
 * Dependencies: provenance/ProvenanceDAG.js, candidate/MeasurementRegistry.js.
 * Public API: buildFeatureProvenanceDAG.
 * Complexity: O(f * d) where f = number of requested feature names and d =
 *   average dependency-chain depth (each name resolved once via memoized
 *   recursion).
 */

import { ProvenanceDAG, NODE_TYPES } from './ProvenanceDAG.js';
import { MeasurementRegistryError } from '../candidate/MeasurementRegistry.js';

/**
 * Recursively adds a registered observable and its full dependency chain
 * (down to primitives) to the given DAG.
 *
 * @param {ProvenanceDAG} dag
 * @param {import('../candidate/MeasurementRegistry.js').MeasurementRegistry} registry
 * @param {string} name
 * @param {Set<string>} visited - names already added (avoids duplicate work).
 */
function addObservableRecursive(dag, registry, name, visited) {
  if (visited.has(name)) return;
  visited.add(name);

  if (!registry.isRegistered(name)) {
    throw new MeasurementRegistryError(
      `FeatureProvenanceDAG: "${name}" is not registered in the MeasurementRegistry`
    );
  }
  const spec = registry.get(name);
  dag.addNode(name, {
    type: spec.isPrimitive ? NODE_TYPES.MEASUREMENT : NODE_TYPES.FEATURE,
    label: name,
    metadata: { description: spec.description, isPrimitive: spec.isPrimitive },
  });

  for (const dep of spec.derivedFrom || []) {
    addObservableRecursive(dag, registry, dep, visited);
    dag.addEdge(name, dep); // name is derivedFrom dep
  }
}

/**
 * Builds a ProvenanceDAG covering the requested feature names and their
 * full recursive dependency chains, down to primitive observables.
 *
 * @param {string[]} featureNames - Names to include (typically a
 *   candidate's featureProvenance array).
 * @param {import('../candidate/MeasurementRegistry.js').MeasurementRegistry} registry
 * @returns {ProvenanceDAG}
 */
export function buildFeatureProvenanceDAG(featureNames, registry) {
  if (!Array.isArray(featureNames))
    throw new MeasurementRegistryError('buildFeatureProvenanceDAG: featureNames must be an array');
  const dag = new ProvenanceDAG();
  const visited = new Set();
  for (const name of featureNames) {
    addObservableRecursive(dag, registry, name, visited);
  }
  return dag;
}
