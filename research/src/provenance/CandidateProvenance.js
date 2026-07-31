/**
 * research/src/provenance/CandidateProvenance.js
 *
 * Purpose:
 *   Builds the complete provenance DAG for a single Phase 11 Candidate:
 *   originating measurements, derived features, observable contexts, market
 *   construct proxies, the research configuration/freeze/SAP in effect, and
 *   the generator version that produced it. This is the concrete
 *   implementation of directive requirement #18 ("Candidate Provenance DAGs
 *   for full traceability") and #20 ("Data Lineage for every candidate").
 *
 * Scientific rationale:
 *   A candidate's scientific validity depends on more than its own fields —
 *   it depends on the exact chain of measurements, features, contexts, and
 *   proxies it was built from, and the governance objects (ResearchFreeze,
 *   SAP) that were locked in at generation time. Bundling all of this into
 *   one auditable DAG per candidate means a reviewer (human or
 *   ReproducibilityGate) can answer "what does this candidate ultimately
 *   depend on?" without cross-referencing five different registries by hand.
 *
 *   For CompositeCandidate, the DAG additionally recurses into each
 *   component's own provenance (if supplied), so a composite's lineage
 *   traces all the way down through its constituents — never just one level.
 *
 * Dependencies: provenance/ProvenanceDAG.js, provenance/FeatureProvenanceDAG.js,
 *   candidate/Candidate.js (CANDIDATE_TYPES), candidate/MeasurementRegistry.js.
 * Public API: buildCandidateProvenance.
 * Complexity: O(f*d + c + p) where f/d as in FeatureProvenanceDAG, c =
 *   number of contexts/proxies attached, p = number of composite components
 *   (each merged once).
 */

import { ProvenanceDAG, NODE_TYPES } from './ProvenanceDAG.js';
import { buildFeatureProvenanceDAG } from './FeatureProvenanceDAG.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

export class CandidateProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandidateProvenanceError';
  }
}

/**
 * Merges all nodes/edges of `source` into `target`. Node re-adds are
 * idempotent (ProvenanceDAG.addNode) as long as types match; edges are
 * re-added but ProvenanceDAG treats a repeated identical edge as a Set
 * no-op internally (addEdge always re-derives via Set.add, safe to repeat).
 *
 * @param {ProvenanceDAG} target
 * @param {ProvenanceDAG} source
 */
function mergeInto(target, source) {
  for (const node of source.listNodes()) {
    target.addNode(node.id, { type: node.type, label: node.label, metadata: node.metadata });
  }
  for (const { child, parent } of source.toJSON().edges) {
    target.addEdge(child, parent);
  }
}

/**
 * Builds the full provenance DAG for a single candidate.
 *
 * @param {import('../candidate/Candidate.js').Candidate} candidate
 * @param {object} params
 * @param {import('../candidate/MeasurementRegistry.js').MeasurementRegistry} params.measurementRegistry
 *   Required if candidate.featureProvenance is non-empty.
 * @param {string[]} [params.contextIds=[]] - IDs/keys of observable contexts used.
 * @param {string[]} [params.proxyIds=[]]   - IDs/keys of market construct proxies used.
 * @param {string}   [params.researchConfigurationId] - Defaults to candidate.researchConfigurationId.
 * @param {string}   [params.researchFreezeId]         - Defaults to candidate.researchFreezeId.
 * @param {string}   [params.sapId]                    - Defaults to candidate.sapId.
 * @param {string}   [params.generatorVersion]         - Defaults to candidate.generatorVersion.
 * @param {string}   [params.datasetManifestId=null]   - DatasetManifest.datasetId this candidate was built from.
 * @param {Object.<string,string>} [params.contextVersions={}] - contextId -> version, attached as node metadata.
 * @param {Object.<string,string>} [params.proxyVersions={}]   - proxyId -> version, attached as node metadata.
 * @param {Object.<string, ProvenanceDAG>} [params.componentProvenance={}]
 *   For CompositeCandidate only: map of componentId → that component's own
 *   ProvenanceDAG (if already built), merged in wholesale so lineage traces
 *   through composites recursively. Components without a supplied DAG are
 *   still recorded as CANDIDATE nodes (shallow reference) even if their
 *   full sub-lineage isn't available yet.
 * @returns {ProvenanceDAG}
 */
export function buildCandidateProvenance(candidate, {
  measurementRegistry = null,
  contextIds = [],
  proxyIds = [],
  researchConfigurationId = candidate?.researchConfigurationId,
  researchFreezeId = candidate?.researchFreezeId,
  sapId = candidate?.sapId,
  generatorVersion = candidate?.generatorVersion,
  datasetManifestId = null,
  contextVersions = {},
  proxyVersions = {},
  componentProvenance = {},
} = {}) {
  if (!candidate || !candidate.id) {
    throw new CandidateProvenanceError('buildCandidateProvenance: a valid candidate with an id is required');
  }

  const dag = new ProvenanceDAG();
  dag.addNode(candidate.id, {
    type: NODE_TYPES.CANDIDATE,
    label: candidate.description || candidate.id,
    metadata: { family: candidate.family, type: candidate.type, fingerprint: candidate.fingerprint },
  });

  // ── Feature/measurement lineage ───────────────────────────────────────
  const featureNames = Array.isArray(candidate.featureProvenance) ? candidate.featureProvenance : [];
  if (featureNames.length > 0) {
    if (!measurementRegistry) {
      throw new CandidateProvenanceError(
        `buildCandidateProvenance: candidate "${candidate.id}" declares featureProvenance but no ` +
        `measurementRegistry was supplied to resolve it`
      );
    }
    const featureDag = buildFeatureProvenanceDAG(featureNames, measurementRegistry);
    mergeInto(dag, featureDag);
    for (const name of featureNames) {
      dag.addEdge(candidate.id, name);
    }
  }

  // ── Contexts ──────────────────────────────────────────────────────────
  for (const contextId of contextIds) {
    dag.addNode(contextId, { type: NODE_TYPES.CONTEXT, label: contextId, metadata: { version: contextVersions[contextId] ?? null } });
    dag.addEdge(candidate.id, contextId);
  }

  // ── Proxies ───────────────────────────────────────────────────────────
  for (const proxyId of proxyIds) {
    dag.addNode(proxyId, { type: NODE_TYPES.PROXY, label: proxyId, metadata: { version: proxyVersions[proxyId] ?? null } });
    dag.addEdge(candidate.id, proxyId);
  }

  // ── Dataset manifest ──────────────────────────────────────────────────
  if (datasetManifestId) {
    dag.addNode(datasetManifestId, { type: NODE_TYPES.DATASET_MANIFEST, label: datasetManifestId });
    dag.addEdge(candidate.id, datasetManifestId);
  }

  // ── Governance objects ───────────────────────────────────────────────
  if (researchConfigurationId) {
    dag.addNode(researchConfigurationId, { type: NODE_TYPES.RESEARCH_CONFIGURATION, label: researchConfigurationId });
    dag.addEdge(candidate.id, researchConfigurationId);
  }
  if (researchFreezeId) {
    dag.addNode(researchFreezeId, { type: NODE_TYPES.RESEARCH_FREEZE, label: researchFreezeId });
    dag.addEdge(candidate.id, researchFreezeId);
    if (researchConfigurationId) dag.addEdge(researchFreezeId, researchConfigurationId);
  }
  if (sapId) {
    dag.addNode(sapId, { type: NODE_TYPES.STATISTICAL_ANALYSIS_PLAN, label: sapId });
    dag.addEdge(candidate.id, sapId);
  }
  if (generatorVersion) {
    const genNodeId = `generator:${generatorVersion}`;
    dag.addNode(genNodeId, { type: NODE_TYPES.GENERATOR, label: genNodeId });
    dag.addEdge(candidate.id, genNodeId);
  }

  // ── CompositeCandidate: recurse into components ─────────────────────
  if (candidate.type === CANDIDATE_TYPES.COMPOSITE_CANDIDATE && Array.isArray(candidate.componentIds)) {
    for (const componentId of candidate.componentIds) {
      const componentDag = componentProvenance[componentId];
      if (componentDag instanceof ProvenanceDAG) {
        mergeInto(dag, componentDag);
      } else if (!dag.hasNode(componentId)) {
        dag.addNode(componentId, { type: NODE_TYPES.CANDIDATE, label: componentId });
      }
      dag.addEdge(candidate.id, componentId);
    }
  }

  return dag;
}
