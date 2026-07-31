/**
 * research/src/governance/phase11KnowledgeGraphBridge.js
 *
 * Purpose:
 *   Extends (never replaces) governance/knowledgeGraph.js with the Phase 11
 *   entity types and relationship chain named in the Phase D backend
 *   integration directive:
 *     ConditionalHypothesis, CompositeCandidate, Context,
 *     ObservableMeasurement, DerivedFeature, MarketConstructProxy,
 *     ResearchFreeze, ResearchConfiguration, StatisticalAnalysisPlan,
 *     DatasetManifest, ProvenanceDAG (as a node), NegativeEvidence,
 *     ScientificDebt, DecisionAudit
 *   and the chain: Measurement -> Feature -> Context -> Proxy -> Candidate
 *   -> Discovery -> Publication.
 *
 * How this "extends, never replaces" knowledgeGraph.js: registerNode() and
 *   registerEdge() (both already built, Phase 9) accept ANY non-empty
 *   string as nodeType/edgeType -- they are NOT restricted to the NODE_TYPES/
 *   EDGE_TYPES enums exported by that module (those enums are a convenience
 *   list for existing callers, not an enforced closed set; confirmed by
 *   reading registerNode's actual validation, which only checks
 *   `typeof nodeType === 'string' && nodeType`). This bridge therefore
 *   registers new Phase 11 node/edge type STRINGS through the exact same
 *   generic, already-tested storage path every other node in the graph
 *   uses -- zero modification to knowledgeGraph.js itself. Edge endpoints
 *   always use the `.id` returned by registerNode() rather than
 *   reconstructing knowledgeGraph.js's internal id format, so this bridge
 *   has no dependency on that internal encoding.
 *
 * Dependencies: governance/knowledgeGraph.js (registerNode/registerEdge only).
 * Public API: PHASE11_NODE_TYPES, PHASE11_EDGE_TYPES,
 *   registerPhase11CandidateInKnowledgeGraph, registerPhase11ChainLink,
 *   recordPhase11NegativeEvidenceInKnowledgeGraph.
 * Complexity: O(1) per node/edge registration (delegates entirely to
 *   knowledgeGraph.js's own adapters).
 */

import { registerNode, registerEdge } from './knowledgeGraph.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

/** Phase 11 node type strings, additive to knowledgeGraph.js's NODE_TYPES. */
export const PHASE11_NODE_TYPES = Object.freeze({
  CONDITIONAL_HYPOTHESIS:    'Phase11ConditionalHypothesis',
  COMPOSITE_CANDIDATE:       'Phase11CompositeCandidate',
  INDICATOR_FEATURE:         'Phase11IndicatorFeature',
  MARKET_STATE:              'Phase11MarketState',
  CONTEXT:                   'Phase11Context',
  OBSERVABLE_MEASUREMENT:    'Phase11ObservableMeasurement',
  DERIVED_FEATURE:           'Phase11DerivedFeature',
  MARKET_CONSTRUCT_PROXY:    'Phase11MarketConstructProxy',
  RESEARCH_FREEZE:           'Phase11ResearchFreeze',
  RESEARCH_CONFIGURATION:    'Phase11ResearchConfiguration',
  STATISTICAL_ANALYSIS_PLAN: 'Phase11StatisticalAnalysisPlan',
  DATASET_MANIFEST:          'Phase11DatasetManifest',
  PROVENANCE_DAG:            'Phase11ProvenanceDAG',
  NEGATIVE_EVIDENCE:         'Phase11NegativeEvidence',
  SCIENTIFIC_DEBT:           'Phase11ScientificDebt',
  DECISION_AUDIT:            'Phase11DecisionAudit',
  DISCOVERY:                 'Phase11Discovery',
  PUBLICATION:               'Phase11Publication',
  CHARACTERIZATION:          'Phase11Characterization',
});

/** Phase 11 edge type strings, additive to knowledgeGraph.js's EDGE_TYPES. */
export const PHASE11_EDGE_TYPES = Object.freeze({
  DERIVED_FROM:   'phase11_derived_from',   // Feature -derivedFrom-> Measurement
  CONDITIONED_ON: 'phase11_conditioned_on', // Candidate -conditionedOn-> Context
  ESTIMATES:      'phase11_estimates',      // Candidate -estimates-> Proxy
  PRODUCED_UNDER: 'phase11_produced_under', // Candidate -producedUnder-> Freeze/Configuration/SAP/DatasetManifest
  REJECTED_AS:    'phase11_rejected_as',    // Candidate -rejectedAs-> NegativeEvidence
  AUDITED_BY:     'phase11_audited_by',     // Candidate -auditedBy-> DecisionAudit
  FLAGGED_BY:     'phase11_flagged_by',     // Candidate -flaggedBy-> ScientificDebt
  CONFIRMED_AS:   'phase11_confirmed_as',   // Candidate -confirmedAs-> Discovery
  PUBLISHED_AS:   'phase11_published_as',   // Discovery -publishedAs-> Publication
  CHARACTERIZED_BY: 'phase11_characterized_by', // Discovery -characterizedBy-> Characterization
});

const CANDIDATE_TYPE_TO_NODE_TYPE = Object.freeze({
  [CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS]: PHASE11_NODE_TYPES.CONDITIONAL_HYPOTHESIS,
  [CANDIDATE_TYPES.COMPOSITE_CANDIDATE]: PHASE11_NODE_TYPES.COMPOSITE_CANDIDATE,
  [CANDIDATE_TYPES.INDICATOR_FEATURE]: PHASE11_NODE_TYPES.INDICATOR_FEATURE,
  [CANDIDATE_TYPES.MARKET_STATE]: PHASE11_NODE_TYPES.MARKET_STATE,
});

/**
 * Registers a Phase 11 candidate as a Knowledge Graph node, plus edges for
 * every governance object it was produced under (ResearchFreeze,
 * ResearchConfiguration, SAP, DatasetManifest if supplied), its contexts,
 * and its proxies. Implements the Context->Proxy->Candidate segment of the
 * required chain for this candidate (the shared Measurement->Feature
 * segment is registered separately, once per distinct feature, via
 * registerPhase11ChainLink -- not re-derived per candidate).
 *
 * @param {import('../candidate/Candidate.js').Candidate} candidate
 * @param {object} [links]
 * @param {string[]} [links.contextIds=[]]
 * @param {string[]} [links.proxyIds=[]]
 * @param {string} [links.datasetManifestId=null]
 * @returns {Promise<object>} The registered candidate node record.
 */
export async function registerPhase11CandidateInKnowledgeGraph(candidate, {
  contextIds = [], proxyIds = [], datasetManifestId = null,
} = {}) {
  const nodeType = CANDIDATE_TYPE_TO_NODE_TYPE[candidate.type] ?? PHASE11_NODE_TYPES.INDICATOR_FEATURE;
  const node = await registerNode({
    nodeType, refId: candidate.id, label: candidate.description || candidate.id,
    metadata: { fingerprint: candidate.fingerprint, family: candidate.family, lifecycle: candidate.lifecycle },
  });

  for (const contextId of contextIds) {
    const ctxNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.CONTEXT, refId: contextId, label: contextId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.CONDITIONED_ON, fromNodeId: node.id, toNodeId: ctxNode.id });
  }
  for (const proxyId of proxyIds) {
    const proxyNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.MARKET_CONSTRUCT_PROXY, refId: proxyId, label: proxyId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.ESTIMATES, fromNodeId: node.id, toNodeId: proxyNode.id });
  }
  if (candidate.researchFreezeId) {
    const freezeNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.RESEARCH_FREEZE, refId: candidate.researchFreezeId, label: candidate.researchFreezeId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.PRODUCED_UNDER, fromNodeId: node.id, toNodeId: freezeNode.id });
  }
  if (candidate.researchConfigurationId) {
    const rcNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.RESEARCH_CONFIGURATION, refId: candidate.researchConfigurationId, label: candidate.researchConfigurationId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.PRODUCED_UNDER, fromNodeId: node.id, toNodeId: rcNode.id });
  }
  if (candidate.sapId) {
    const sapNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.STATISTICAL_ANALYSIS_PLAN, refId: candidate.sapId, label: candidate.sapId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.PRODUCED_UNDER, fromNodeId: node.id, toNodeId: sapNode.id });
  }
  if (datasetManifestId) {
    const dmNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.DATASET_MANIFEST, refId: datasetManifestId, label: datasetManifestId });
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.PRODUCED_UNDER, fromNodeId: node.id, toNodeId: dmNode.id });
  }

  return node;
}

/**
 * Registers one Measurement->Feature edge (shared, campaign-level lineage --
 * call once per distinct feature, not once per candidate that uses it).
 *
 * @param {string} featureId
 * @param {string} measurementId
 * @returns {Promise<{ featureNode: object, measurementNode: object }>}
 */
export async function registerPhase11ChainLink(featureId, measurementId) {
  const featureNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.DERIVED_FEATURE, refId: featureId, label: featureId });
  const measurementNode = await registerNode({ nodeType: PHASE11_NODE_TYPES.OBSERVABLE_MEASUREMENT, refId: measurementId, label: measurementId });
  await registerEdge({ edgeType: PHASE11_EDGE_TYPES.DERIVED_FROM, fromNodeId: featureNode.id, toNodeId: measurementNode.id });
  return { featureNode, measurementNode };
}

/**
 * Registers a confirmed candidate's Discovery relationship in the
 * Knowledge Graph -- completes the chain Measurement -> Feature -> Context
 * -> Proxy -> Candidate -> Discovery for a candidate that has just passed
 * Round 3 confirmation (see bridge/Phase11ConfirmationBridge.js). Evidence
 * tier and implementation maturity are recorded as metadata on the
 * Discovery node itself (not as separate node types) -- they describe the
 * discovery's quality, not a distinct entity in the lineage graph.
 *
 * @param {object} candidateNode - The record returned by
 *   registerPhase11CandidateInKnowledgeGraph (needed for its real `.id`).
 * @param {object} discoveryInfo
 * @param {string} discoveryInfo.hypothesisId - The legacy hypothesisRegistry id.
 * @param {string} discoveryInfo.familyKey - The legacy Online-FDR family key.
 * @param {string} [discoveryInfo.datasetManifestId]
 * @param {string} [discoveryInfo.evidenceTier]
 * @param {string} [discoveryInfo.implementationMaturity]
 * @returns {Promise<object>} The registered Discovery node record.
 */
export async function registerPhase11DiscoveryInKnowledgeGraph(candidateNode, {
  hypothesisId, familyKey, datasetManifestId = null, evidenceTier = null, implementationMaturity = null,
} = {}) {
  const discoveryNode = await registerNode({
    nodeType: PHASE11_NODE_TYPES.DISCOVERY,
    refId: hypothesisId,
    label: `Discovery: ${hypothesisId}`,
    metadata: { familyKey, datasetManifestId, evidenceTier, implementationMaturity, confirmedAt: Date.now() },
  });
  if (candidateNode && candidateNode.id) {
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.CONFIRMED_AS, fromNodeId: candidateNode.id, toNodeId: discoveryNode.id });
  }
  return discoveryNode;
}

/**
 * Registers a Discovery's Publication relationship, once
 * checkPublicationEligibility() has passed (Stage 2 concern; included here
 * now since the node/edge types already exist and this is a one-line
 * extension of the same pattern above).
 *
 * @param {object} discoveryNode - The record returned by registerPhase11DiscoveryInKnowledgeGraph.
 * @param {string} publicationId
 * @returns {Promise<object>} The registered Publication node record.
 */
export async function registerPhase11PublicationInKnowledgeGraph(discoveryNode, publicationId) {
  const publicationNode = await registerNode({
    nodeType: PHASE11_NODE_TYPES.PUBLICATION,
    refId: publicationId,
    label: `Publication: ${publicationId}`,
    metadata: { publishedAt: Date.now() },
  });
  if (discoveryNode && discoveryNode.id) {
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.PUBLISHED_AS, fromNodeId: discoveryNode.id, toNodeId: publicationNode.id });
  }
  return publicationNode;
}

/**
 * Registers a post-confirmation scientific characterization as a NEW,
 * append-only Knowledge Graph record linked to the Discovery node --
 * NOT a mutation of the Discovery node's own metadata. registerNode() is
 * write-once (returns the existing row unchanged if the same nodeType+
 * refId is registered again -- confirmed by reading its implementation),
 * matching this codebase's audit-trail discipline (DecisionAuditLog,
 * RngForensicsResults, etc. are all append-only histories, not mutable
 * fields). Every characterization run (e.g. a later re-computation with
 * more data) therefore gets its own timestamped node, never overwriting
 * a prior one.
 *
 * @param {object} discoveryNode - The record returned by
 *   registerPhase11DiscoveryInKnowledgeGraph.
 * @param {object} characterization
 * @param {number} [characterization.stabilityIndex]
 * @param {number} [characterization.scientificImportance]
 * @param {number} [characterization.tradingImportance]
 * @param {string} [characterization.rngForensicsClassification]
 * @returns {Promise<object>} The registered Characterization node record.
 */
export async function registerPhase11CharacterizationInKnowledgeGraph(discoveryNode, {
  stabilityIndex = null, scientificImportance = null, tradingImportance = null, rngForensicsClassification = null,
} = {}) {
  const refId = `${discoveryNode?.refId ?? 'unknown'}:${Date.now()}`;
  const characterizationNode = await registerNode({
    nodeType: PHASE11_NODE_TYPES.CHARACTERIZATION,
    refId,
    label: `Characterization: ${refId}`,
    metadata: { stabilityIndex, scientificImportance, tradingImportance, rngForensicsClassification, computedAt: Date.now() },
  });
  if (discoveryNode && discoveryNode.id) {
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.CHARACTERIZED_BY, fromNodeId: discoveryNode.id, toNodeId: characterizationNode.id });
  }
  return characterizationNode;
}

/**
 * Records a rejected candidate's negative evidence entry as a permanent,
 * queryable Knowledge Graph node linked back to the candidate node -- the
 * Knowledge-Graph-availability half of "Negative Findings Are First-Class
 * Outputs" (constraint #9). This is distinct from, and does not replace,
 * NegativeEvidenceRegistry's own in-memory record (the two are linked by
 * candidateFingerprint, not merged into one data structure) -- see
 * NegativeEvidenceRegistry.js's own module header for why the DERIVATION
 * provenance DAG deliberately does not include evaluation outcomes like
 * rejections; the Knowledge Graph is the correct place for that.
 *
 * @param {object} candidateNode - The record returned by
 *   registerPhase11CandidateInKnowledgeGraph (needed for its real `.id`).
 * @param {import('./NegativeEvidenceRegistry.js').NegativeEvidenceEntry} entry
 * @returns {Promise<object>} The registered negative-evidence node record.
 */
export async function recordPhase11NegativeEvidenceInKnowledgeGraph(candidateNode, entry) {
  const refId = `${entry.candidateFingerprint}:${entry.stageRejected}:${entry.timestamp}`;
  const neNode = await registerNode({
    nodeType: PHASE11_NODE_TYPES.NEGATIVE_EVIDENCE, refId,
    label: `Rejected at ${entry.stageRejected}`,
    metadata: typeof entry.toJSON === 'function' ? entry.toJSON() : { ...entry },
  });
  if (candidateNode && candidateNode.id) {
    await registerEdge({ edgeType: PHASE11_EDGE_TYPES.REJECTED_AS, fromNodeId: candidateNode.id, toNodeId: neNode.id });
  }
  return neNode;
}
