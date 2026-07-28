/**
 * research/src/governance/knowledgeGraph.js
 *
 * Purpose:
 *   Implement the Scientific Knowledge Graph — Volume III's Layer 9
 *   ("Knowledge Accumulation") capability named, but never built, by the
 *   Final Laboratory Architecture v1.0 review (Section 3, "KnowledgeBase ->
 *   Scientific Knowledge Graph"): a connected representation of the
 *   relationships between the entities this Laboratory already produces
 *   (Behaviours, Hypotheses, Candidate Measurements, Features, Families,
 *   Scientific Questions), replacing three previously uncoordinated flat
 *   stores (KnowledgeBase, EngineeringLab, DiscoveryLab) with one queryable
 *   graph. This is the final item on the entire Tier 1-4 roadmap.
 *
 * Grounding: read legacy index.html directly (lines 15120-15900) before
 *   writing anything here — msdOpenDiscoveryLabDatabase/
 *   msdOpenEngineeringLabDatabase, msdRegisterBehavior, msdRegisterHypothesis
 *   (DiscoveryLab's own, PRE-Volume-IV hypothesis concept — see the
 *   non-duplication decision below), msdRegisterCandidateMeasurement,
 *   msdRegisterFeatureOntology, MSD_FEATURE_FAMILIES, and
 *   msdGetKnowledgeGraphForBehavior (the legacy function that already used
 *   the phrase "Knowledge Graph" for exactly this Behaviour -> Hypothesis ->
 *   Candidate -> Feature traversal).
 *
 * A non-duplication decision, consistent with the Final Laboratory
 *   Architecture v1.0 review (Section 7, D-2): legacy's DiscoveryLab store
 *   held its OWN `hypothesis_registration` record type (label, statement,
 *   parentBehaviorId, falsifiablePrediction, ...) — a second, competing
 *   "hypothesis" concept alongside Volume IV's own governed
 *   HypothesisRegistry (Phase 2, hypothesisRegistry.js). That review
 *   explicitly retired legacy's standalone HypothesisRecord for "duplicate
 *   scientific authority" while explicitly preserving DiscoveryLab's
 *   TAXONOMY LINKS ("they describe relationships, they don't issue
 *   verdicts"). This module follows that exact line: a Hypothesis node in
 *   this graph is ALWAYS a reference to a real row in the Phase 2
 *   HypothesisRegistry (validated via hypothesisRegistry.getHypothesis
 *   before any Hypothesis node or edge touching it is written) — never a
 *   second, independently-labeled hypothesis object. Behaviour and
 *   Candidate Measurement, which have no Volume IV equivalent anywhere else
 *   in this codebase, ARE ported as genuinely new node types, carrying
 *   their own descriptive fields exactly as legacy defined them.
 *
 * A second, related improvement over the legacy design: legacy's
 *   msdGetKnowledgeGraphForBehavior annotated each descendant Feature with
 *   a caller-supplied Evidence Lifecycle stage computed by
 *   msdComputeEvidenceLifecycleStage — an 11-stage enum this Laboratory's
 *   real governance has since superseded with two independently-governed,
 *   REAL axes: Lifecycle Stage (Part 2, hypothesisRegistry.js) and
 *   Publication Status (Part 12, publicationStatus.js). Rather than port a
 *   third, now-redundant status enum, traverseKnowledgeGraphForBehavior
 *   (below) annotates each Hypothesis node with its actual, current,
 *   already-governed Lifecycle Stage and Publication Status, read live —
 *   nothing about a hypothesis's status is ever computed twice in this
 *   codebase.
 *
 * Responsibilities:
 *   - registerNode / getNode / listNodesByType: generic, typed graph node
 *     primitives (write-once — registering the same (nodeType, refId) pair
 *     twice is a safe idempotent no-op, mirroring Lockbox's own "compute
 *     once" semantics).
 *   - registerEdge / listEdgesFrom / listEdgesTo: generic, typed, directed
 *     graph edge primitives (append-only — an edge is a permanent
 *     historical fact, "this relationship was asserted," the same
 *     reasoning already applied to every other relationship ledger in this
 *     database).
 *   - registerBehavior, linkHypothesisToBehavior, registerCandidateMeasurement,
 *     registerFeatureNode: the ported DiscoveryLab/EngineeringLab taxonomy
 *     chain, each function validating its parent reference exists (mirrors
 *     legacy's own precondition chain) before writing.
 *   - linkHypothesisToFamily, linkFamilyToQuestion: reflect relationships
 *     that ALREADY exist in this codebase's real governance (a hypothesis's
 *     own real familyKey field, hypothesisRegistry.js; a real Family<->
 *     Question attachment, scientificQuestion.js) into the graph as edges — these functions
 *     never create the underlying relationship, only represent an
 *     already-true fact as a traversable edge.
 *   - traverseKnowledgeGraphForBehavior(behaviorId): the ported
 *     msdGetKnowledgeGraphForBehavior view — every Hypothesis derived from
 *     one Behaviour, every Candidate Measurement derived from each
 *     Hypothesis, every Feature derived from each Candidate, each
 *     Hypothesis annotated with its REAL current Lifecycle Stage and
 *     Publication Status (see design note above). Pure, derived, nothing
 *     new stored.
 *   - traceFeatureLineage(featureKey): the reverse walk (Feature ->
 *     Candidate Measurement -> Hypothesis -> Behaviour), directly serving
 *     the Final Laboratory Architecture v1.0's own named benefit #2 —
 *     "Lineage/Generation auditing becomes a direct graph traversal
 *     instead of a manual reconstruction."
 *
 * Scope decision, disclosed in full: the Architecture review named THREE
 *   concrete benefits for this graph (Section 3). This phase builds the
 *   foundational structure plus benefit #2 in full (lineage traversal,
 *   above). Benefit #1 ("target genuinely under-explored regions of the
 *   hypothesis space" — a discovery-adjacency ranking over the graph for
 *   Layer 6's Analyzers to consume) and benefit #3 ("a natural substrate
 *   for Scientific Debt and Model Obsolescence" — Layer 10 Meta-Science
 *   metrics already disclosed as unbuilt in metaScience.js Phase M, since
 *   both still require prerequisites, a similarity function and Stage 7/8
 *   live-monitoring history, this graph alone does not supply) are
 *   correctly sequenced as future consumers of this now-existing
 *   structure, not blockers to building the structure itself — the same
 *   "build the well-defined testable subset, disclose the rest" discipline
 *   applied at every prior phase this engagement.
 *
 * Inputs: plain objects per function; hypothesisId/familyKey/questionId
 *   values are always validated against their real, already-governed
 *   source module before being referenced by any node or edge.
 * Outputs: written node/edge records; derived traversal views (plain
 *   objects, never persisted).
 * Dependencies: storage/researchGovernanceDb.js (node/edge adapters),
 *   governance/hypothesisRegistry.js (Hypothesis validation + live status),
 *   governance/publicationStatus.js (live Publication Status),
 *   governance/scientificQuestion.js (Scientific Question / Family-attachment
 *   validation).
 *
 * Public API: NODE_TYPES, EDGE_TYPES, FEATURE_FAMILIES,
 *   InvalidKnowledgeGraphInputError, UnknownNodeReferenceError,
 *   registerNode, getNode, listNodesByType, registerEdge, listEdgesFrom,
 *   listEdgesTo, registerBehavior, getBehavior, linkHypothesisToBehavior,
 *   registerCandidateMeasurement, registerFeatureNode,
 *   linkHypothesisToFamily, linkFamilyToQuestion,
 *   traverseKnowledgeGraphForBehavior, traceFeatureLineage.
 * Internal API: nodeId (deterministic id builder).
 *
 * Error handling: InvalidKnowledgeGraphInputError for malformed input;
 *   UnknownNodeReferenceError when a parent reference does not resolve to
 *   a registered node or a real governed entity — mirrors every other
 *   governance module's "refuse before writing, never write a partial or
 *   dangling record" discipline.
 * Performance notes: every read here is a bounded, indexed lookup
 *   (by_nodeType_refId / by_fromNodeId_seq / by_toNodeId_registeredAt) or a
 *   single deterministic-id get() — never an unbounded store scan, per this
 *   codebase's own indexingStrategy.js discipline.
 * Threading model: no shared mutable state; safe for concurrent read use,
 *   same caveat on concurrent edge-seq assignment as onlineFdr.js's own
 *   disclosed limitation (not a genuinely concurrency-safe sequence
 *   generator — acceptable for this Laboratory's actual write pattern of
 *   one researcher/process at a time).
 * Storage usage: two additive stores, KnowledgeGraphNodes (write-once) and
 *   KnowledgeGraphEdges (append-only), `mfx_research_governance` v6 -> v7.
 * Complexity analysis: O(log n) per node/edge read or write; traversal
 *   functions are O(k) in the number of matched rows at each hop, never in
 *   the total store size.
 * Future extension notes: a new node or edge type is a new NODE_TYPES/
 *   EDGE_TYPES entry — no schema change required, since both stores are
 *   already generically typed.
 */

import {
  getKnowledgeGraphNodesAdapter,
  getKnowledgeGraphEdgesAdapter,
} from '../storage/researchGovernanceDb.js';
import { getHypothesis, getCurrentLifecycleStage } from './hypothesisRegistry.js';
import { getCurrentPublicationStatus } from './publicationStatus.js';
import { getQuestion, listFamiliesForQuestion } from './scientificQuestion.js';

export class InvalidKnowledgeGraphInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidKnowledgeGraphInputError';
  }
}

export class UnknownNodeReferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownNodeReferenceError';
  }
}

// ── Node/edge type vocabularies ────────────────────────────────────────────
export const NODE_TYPES = Object.freeze({
  BEHAVIOR: 'Behavior',
  HYPOTHESIS: 'Hypothesis',
  CANDIDATE_MEASUREMENT: 'CandidateMeasurement',
  FEATURE: 'Feature',
  FAMILY: 'Family',
  SCIENTIFIC_QUESTION: 'ScientificQuestion',
  // Phase 9 (Adaptive Scientific Discovery Engine) additions -- Requirement
  // 9 / "Scientific Memory." Additive only, per this module's own "Future
  // extension notes": a new node type is a new NODE_TYPES entry, no schema
  // change required (both stores are already generically typed by string).
  REPRESENTATION_FAMILY: 'RepresentationFamily',
  SEARCH_SPACE_VERSION: 'SearchSpaceVersion',
  DISCOVERY_CAMPAIGN: 'DiscoveryCampaign',
  REPLICATION_CAMPAIGN: 'ReplicationCampaign',
  EVIDENCE_SUMMARY: 'EvidenceSummary',
});

export const EDGE_TYPES = Object.freeze({
  DERIVES_FROM: 'derivesFrom',                     // Hypothesis -> Behavior
  PROPOSES_MEASUREMENT_FOR: 'proposesMeasurementFor', // CandidateMeasurement -> Hypothesis
  IMPLEMENTS: 'implements',                         // Feature -> CandidateMeasurement
  BELONGS_TO_FAMILY: 'belongsToFamily',             // Hypothesis -> Family
  ANSWERS_QUESTION: 'answersQuestion',              // Family -> ScientificQuestion
  // Phase 9 additions -- see Requirement 9 in
  // MambaFX_Phase9_Part2_ScientificMemory_Integration_FinalRecommendation.md.
  GENERATED_FROM: 'generatedFrom',                  // Hypothesis -> SearchSpaceVersion
  MEMBER_OF_CAMPAIGN: 'memberOfCampaign',           // Hypothesis -> DiscoveryCampaign
  REPLICATED_IN: 'replicatedIn',                    // Hypothesis -> ReplicationCampaign
  SUMMARIZES: 'summarizes',                         // EvidenceSummary -> Hypothesis
  SCREENED_NOT_PROMOTED: 'screenedNotPromoted',     // Hypothesis -> RepresentationFamily | SearchSpaceVersion
  INSTANCE_OF_FAMILY: 'instanceOfFamily',           // Hypothesis -> RepresentationFamily
});

// Ported verbatim from legacy index.html's MSD_FEATURE_FAMILIES (Phase 5,
// Section 3.2) — the canonical Feature Family taxonomy list. A Feature
// Ontology entry may only declare one of these (custom families are
// deliberately out of scope for this phase, matching msdRegisterFeatureFamily's
// own KnowledgeBase-backed extension mechanism, not yet ported).
export const FEATURE_FAMILIES = Object.freeze([
  'Classical Market Measurements', 'Transition Dynamics', 'Persistence', 'Exhaustion',
  'Stability', 'Information Theory', 'Entropy', 'Market Geometry', 'Temporal Behaviour',
  'Multi-Scale Behaviour', 'Physics-Inspired Measurements', 'Complexity Measurements',
  'Regime Measurements', 'Interaction Features', 'Latent State Measurements',
  'Market Flow Proxies', 'Behavioural Measurements',
]);

function nodeId(nodeType, refId) {
  return `kgn_${nodeType}_${refId}`;
}

// ── Generic node primitives ────────────────────────────────────────────────

/**
 * Registers a node for (nodeType, refId) if it doesn't already exist, else
 * returns the existing row unchanged (write-once — see writeOnceAdapter.js).
 */
export async function registerNode({ nodeType, refId, label, metadata } = {}) {
  if (!nodeType || typeof nodeType !== 'string') {
    throw new InvalidKnowledgeGraphInputError('registerNode: "nodeType" is required.');
  }
  if (refId === undefined || refId === null || refId === '') {
    throw new InvalidKnowledgeGraphInputError('registerNode: "refId" is required.');
  }
  const adapter = await getKnowledgeGraphNodesAdapter();
  const record = {
    id: nodeId(nodeType, refId),
    nodeType,
    refId,
    label: label || String(refId),
    metadata: metadata || {},
    registeredAt: Date.now(),
  };
  const result = await adapter.write(record);
  return result.record;
}

export async function getNode(nodeType, refId) {
  const adapter = await getKnowledgeGraphNodesAdapter();
  return adapter.get(nodeId(nodeType, refId));
}

/** Every node of a given type, newest-registered first (bounded, indexed — never a full-store scan). */
export async function listNodesByType(nodeType) {
  const adapter = await getKnowledgeGraphNodesAdapter();
  return adapter.listByIndexRange('by_nodeType_refId', [nodeType]);
}

async function requireNode(nodeType, refId, callerName) {
  const node = await getNode(nodeType, refId);
  if (!node) {
    throw new UnknownNodeReferenceError(
      `${callerName}: no registered ${nodeType} node for refId "${refId}" — register it before linking to it.`
    );
  }
  return node;
}

// ── Generic edge primitives ────────────────────────────────────────────────

/**
 * Appends a new edge (fromNodeId -> toNodeId, typed by edgeType). seq is
 * assigned the same way onlineFdr.js/empiricalFdrCanary.js assign theirs:
 * one more than the latest existing seq for this fromNodeId, via the
 * by_fromNodeId_seq index (bounded read, never a full scan). Duplicate
 * identical edges are permitted (an edge is a historical assertion, not a
 * set-membership fact) — callers that need "assert this edge exists
 * exactly once" should check listEdgesFrom() first, mirroring how every
 * other append-only ledger in this codebase leaves duplicate-suppression
 * to its caller when the store itself does not need uniqueness to be
 * scientifically meaningful.
 */
export async function registerEdge({ edgeType, fromNodeId, toNodeId, metadata } = {}) {
  if (!edgeType || typeof edgeType !== 'string') {
    throw new InvalidKnowledgeGraphInputError('registerEdge: "edgeType" is required.');
  }
  if (!fromNodeId || !toNodeId) {
    throw new InvalidKnowledgeGraphInputError('registerEdge: "fromNodeId" and "toNodeId" are required.');
  }
  const adapter = await getKnowledgeGraphEdgesAdapter();
  const latest = await adapter.queryLatestByIndex('by_fromNodeId_seq', [fromNodeId]);
  const seq = latest ? latest.seq + 1 : 0;
  const record = {
    id: `kge_${fromNodeId}_${seq}`,
    edgeType,
    fromNodeId,
    toNodeId,
    seq,
    metadata: metadata || {},
    registeredAt: Date.now(),
  };
  await adapter.add(record);
  return record;
}

/** Every edge originating at nodeId, newest first; optionally filtered to one edgeType. */
export async function listEdgesFrom(nodeId_, { edgeType } = {}) {
  const adapter = await getKnowledgeGraphEdgesAdapter();
  const rows = await adapter.listByIndexRange('by_fromNodeId_seq', [nodeId_]);
  return edgeType ? rows.filter((r) => r.edgeType === edgeType) : rows;
}

/** Every edge pointing at nodeId, newest first; optionally filtered to one edgeType. */
export async function listEdgesTo(nodeId_, { edgeType } = {}) {
  const adapter = await getKnowledgeGraphEdgesAdapter();
  const rows = await adapter.listByIndexRange('by_toNodeId_registeredAt', [nodeId_]);
  return edgeType ? rows.filter((r) => r.edgeType === edgeType) : rows;
}

// ── Ported taxonomy chain (legacy DiscoveryLab/EngineeringLab design) ──────

/**
 * Registers a Behaviour node. Mirrors msdRegisterBehavior's shape (label
 * required; description/theoreticalRationale optional) — a named, described
 * market behaviour, registered before any measurement of it exists.
 */
export async function registerBehavior({ behaviorId, label, description, theoreticalRationale } = {}) {
  if (!behaviorId) {
    throw new InvalidKnowledgeGraphInputError('registerBehavior: "behaviorId" is required.');
  }
  if (!label) {
    throw new InvalidKnowledgeGraphInputError('registerBehavior: a behavior requires at least a label (mirrors msdRegisterBehavior).');
  }
  return registerNode({
    nodeType: NODE_TYPES.BEHAVIOR,
    refId: behaviorId,
    label,
    metadata: { description: description || '', theoreticalRationale: theoreticalRationale || '' },
  });
}

export async function getBehavior(behaviorId) {
  return getNode(NODE_TYPES.BEHAVIOR, behaviorId);
}

/**
 * Links an ALREADY-REGISTERED, real Volume IV hypothesis (hypothesisRegistry.js)
 * to a Behaviour node — the non-duplication decision documented in this
 * module's header. Ensures a Hypothesis node exists for hypothesisId
 * (registering one on first reference, labeled from the real registry
 * row's own reasonForCreation, never inventing a separate label) and then
 * asserts the derivesFrom edge.
 */
export async function linkHypothesisToBehavior(hypothesisId, behaviorId) {
  if (!hypothesisId) {
    throw new InvalidKnowledgeGraphInputError('linkHypothesisToBehavior: "hypothesisId" is required.');
  }
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(
      `linkHypothesisToBehavior: "${hypothesisId}" does not reference a registered hypothesis (hypothesisRegistry.js). ` +
      'This graph never represents a hypothesis that is not already real and governed.'
    );
  }
  await requireNode(NODE_TYPES.BEHAVIOR, behaviorId, 'linkHypothesisToBehavior');
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  const behaviorNode = await getNode(NODE_TYPES.BEHAVIOR, behaviorId);
  return registerEdge({ edgeType: EDGE_TYPES.DERIVES_FROM, fromNodeId: hypothesisNode.id, toNodeId: behaviorNode.id });
}

/**
 * Registers a Candidate Measurement node — "we propose measuring this
 * behaviour THIS way," mathematically sketched but not yet a fully
 * specified feature. Mirrors msdRegisterCandidateMeasurement: requires a
 * parentHypothesisId resolving to a REAL registered hypothesis (Module 3
 * precedes Module 2/4) — family is deliberately not validated here, exactly
 * as legacy left it unvalidated at this step (the canonical-list check
 * happens once, at Feature registration, matching the legacy design's own
 * documented reasoning).
 */
export async function registerCandidateMeasurement({ candidateId, label, mathematicalSketch, parentHypothesisId, rationale } = {}) {
  if (!candidateId) {
    throw new InvalidKnowledgeGraphInputError('registerCandidateMeasurement: "candidateId" is required.');
  }
  if (!label) {
    throw new InvalidKnowledgeGraphInputError('registerCandidateMeasurement: a candidate measurement requires at least a label.');
  }
  if (!parentHypothesisId) {
    throw new InvalidKnowledgeGraphInputError(
      'registerCandidateMeasurement: "parentHypothesisId" is required — a Candidate Measurement must derive from a registered Hypothesis.'
    );
  }
  const hypothesis = await getHypothesis(parentHypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`registerCandidateMeasurement: "${parentHypothesisId}" does not reference a registered hypothesis.`);
  }
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: parentHypothesisId,
    label: hypothesis.reasonForCreation || parentHypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  const candidateNode = await registerNode({
    nodeType: NODE_TYPES.CANDIDATE_MEASUREMENT,
    refId: candidateId,
    label,
    metadata: { mathematicalSketch: mathematicalSketch || '', rationale: rationale || '', parentHypothesisId },
  });
  await registerEdge({ edgeType: EDGE_TYPES.PROPOSES_MEASUREMENT_FOR, fromNodeId: candidateNode.id, toNodeId: hypothesisNode.id });
  return candidateNode;
}

/**
 * Registers a Feature (Ontology) node — one immutable record per feature
 * key, implementing a Candidate Measurement Module 5 already proposed
 * (mirrors msdRegisterFeatureOntology's "may only implement what's already
 * proposed" precondition and its canonical Feature Family validation).
 */
export async function registerFeatureNode({ featureKey, family, parentCandidateMeasurementId, mathematicalDefinition, units } = {}) {
  if (!featureKey) {
    throw new InvalidKnowledgeGraphInputError('registerFeatureNode: "featureKey" is required.');
  }
  if (!parentCandidateMeasurementId) {
    throw new InvalidKnowledgeGraphInputError(
      'registerFeatureNode: "parentCandidateMeasurementId" is required — Feature Engineering may not invent a measurement.'
    );
  }
  const candidateNode = await requireNode(NODE_TYPES.CANDIDATE_MEASUREMENT, parentCandidateMeasurementId, 'registerFeatureNode');
  if (!FEATURE_FAMILIES.includes(family)) {
    throw new InvalidKnowledgeGraphInputError(
      `registerFeatureNode: family "${family}" is not a recognized Feature Family. Must be one of: ${FEATURE_FAMILIES.join(', ')}`
    );
  }
  const featureNode = await registerNode({
    nodeType: NODE_TYPES.FEATURE,
    refId: featureKey,
    label: featureKey,
    metadata: { family, mathematicalDefinition: mathematicalDefinition || '', units: units || 'dimensionless', parentCandidateMeasurementId },
  });
  await registerEdge({ edgeType: EDGE_TYPES.IMPLEMENTS, fromNodeId: featureNode.id, toNodeId: candidateNode.id });
  return featureNode;
}

// ── Reflecting already-governed relationships into the graph ──────────────

/** Reflects an existing hypothesis's real familyKey (hypothesisRegistry.js) as a graph edge — never creates the Family assignment itself. */
export async function linkHypothesisToFamily(hypothesisId, familyKey) {
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`linkHypothesisToFamily: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  if (hypothesis.familyKey !== familyKey) {
    throw new InvalidKnowledgeGraphInputError(
      `linkHypothesisToFamily: hypothesis "${hypothesisId}" is actually registered under familyKey "${hypothesis.familyKey}", not "${familyKey}" — ` +
      'this function only reflects the real, already-governed assignment, it does not reassign it.'
    );
  }
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  const familyNode = await registerNode({ nodeType: NODE_TYPES.FAMILY, refId: familyKey, label: familyKey, metadata: {} });
  return registerEdge({ edgeType: EDGE_TYPES.BELONGS_TO_FAMILY, fromNodeId: hypothesisNode.id, toNodeId: familyNode.id });
}

/** Reflects an existing Family<->Scientific Question attachment (scientificQuestion.js's attachFamilyToQuestion) as a graph edge — never creates the attachment itself. */
export async function linkFamilyToQuestion(familyKey, questionId) {
  const question = await getQuestion(questionId);
  if (!question) {
    throw new UnknownNodeReferenceError(`linkFamilyToQuestion: "${questionId}" does not reference a registered Scientific Question.`);
  }
  const attachedFamilies = await listFamiliesForQuestion(questionId);
  if (!attachedFamilies.some((row) => row.familyKey === familyKey)) {
    throw new InvalidKnowledgeGraphInputError(
      `linkFamilyToQuestion: familyKey "${familyKey}" is not actually attached to Scientific Question "${questionId}" — ` +
      'attach it first via scientificQuestion.attachFamilyToQuestion; this function only reflects an existing attachment.'
    );
  }
  const familyNode = await registerNode({ nodeType: NODE_TYPES.FAMILY, refId: familyKey, label: familyKey, metadata: {} });
  const questionNode = await registerNode({ nodeType: NODE_TYPES.SCIENTIFIC_QUESTION, refId: questionId, label: question.label || questionId, metadata: {} });
  return registerEdge({ edgeType: EDGE_TYPES.ANSWERS_QUESTION, fromNodeId: familyNode.id, toNodeId: questionNode.id });
}

// ── Traversal views ─────────────────────────────────────────────────────

/**
 * The Knowledge Graph view for one Behaviour — the ported
 * msdGetKnowledgeGraphForBehavior: every Hypothesis derived from it, every
 * Candidate Measurement derived from each Hypothesis, every Feature derived
 * from each Candidate. Each Hypothesis is annotated with its REAL, live
 * Lifecycle Stage (hypothesisRegistry.js) and Publication Status
 * (publicationStatus.js) — see this module's header for why that replaces
 * legacy's own separate Evidence Lifecycle enum. Pure, derived, nothing new
 * stored.
 */
export async function traverseKnowledgeGraphForBehavior(behaviorId) {
  const behaviorNode = await getNode(NODE_TYPES.BEHAVIOR, behaviorId);
  if (!behaviorNode) {
    return { error: `Unknown behaviorId: ${behaviorId}` };
  }

  const hypothesisEdges = await listEdgesTo(behaviorNode.id, { edgeType: EDGE_TYPES.DERIVES_FROM });
  const hypothesisNodes = [];
  for (const edge of hypothesisEdges) {
    const adapter = await getKnowledgeGraphNodesAdapter();
    const node = await adapter.get(edge.fromNodeId);
    if (node) hypothesisNodes.push(node);
  }

  const hypotheses = [];
  for (const hNode of hypothesisNodes) {
    const [lifecycleStage, publicationStatus] = await Promise.all([
      getCurrentLifecycleStage(hNode.refId),
      getCurrentPublicationStatus(hNode.refId),
    ]);

    const candidateEdges = await listEdgesTo(hNode.id, { edgeType: EDGE_TYPES.PROPOSES_MEASUREMENT_FOR });
    const candidates = [];
    for (const cEdge of candidateEdges) {
      const adapter = await getKnowledgeGraphNodesAdapter();
      const cNode = await adapter.get(cEdge.fromNodeId);
      if (!cNode) continue;

      const featureEdges = await listEdgesTo(cNode.id, { edgeType: EDGE_TYPES.IMPLEMENTS });
      const features = [];
      for (const fEdge of featureEdges) {
        const fNode = await adapter.get(fEdge.fromNodeId);
        if (fNode) {
          features.push({ featureKey: fNode.refId, family: fNode.metadata.family, mathematicalDefinition: fNode.metadata.mathematicalDefinition });
        }
      }
      candidates.push({ candidateId: cNode.refId, label: cNode.label, mathematicalSketch: cNode.metadata.mathematicalSketch, features });
    }

    hypotheses.push({
      hypothesisId: hNode.refId,
      label: hNode.label,
      lifecycleStage: lifecycleStage ?? null,
      publicationStatus: publicationStatus ?? null,
      candidates,
    });
  }

  return { behavior: { behaviorId: behaviorNode.refId, label: behaviorNode.label, ...behaviorNode.metadata }, hypotheses };
}

/**
 * The reverse walk: Feature -> Candidate Measurement -> Hypothesis ->
 * Behaviour, each hop a single bounded indexed read. Directly serves the
 * Final Laboratory Architecture v1.0's named benefit: "Lineage/Generation
 * auditing (Layer 12) becomes a direct graph traversal instead of a manual
 * reconstruction."
 */
export async function traceFeatureLineage(featureKey) {
  const featureNode = await getNode(NODE_TYPES.FEATURE, featureKey);
  if (!featureNode) {
    return { error: `Unknown featureKey: ${featureKey}` };
  }
  const implementsEdges = await listEdgesFrom(featureNode.id, { edgeType: EDGE_TYPES.IMPLEMENTS });
  const candidateEdge = implementsEdges[0];
  if (!candidateEdge) {
    return { feature: { featureKey: featureNode.refId, family: featureNode.metadata.family }, candidateMeasurement: null, hypothesis: null, behavior: null };
  }
  const nodesAdapter = await getKnowledgeGraphNodesAdapter();
  const candidateNode = await nodesAdapter.get(candidateEdge.toNodeId);

  const proposesEdges = candidateNode ? await listEdgesFrom(candidateNode.id, { edgeType: EDGE_TYPES.PROPOSES_MEASUREMENT_FOR }) : [];
  const hypothesisEdge = proposesEdges[0];
  const hypothesisNode = hypothesisEdge ? await nodesAdapter.get(hypothesisEdge.toNodeId) : null;

  const derivesEdges = hypothesisNode ? await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.DERIVES_FROM }) : [];
  const behaviorEdge = derivesEdges[0];
  const behaviorNode = behaviorEdge ? await nodesAdapter.get(behaviorEdge.toNodeId) : null;

  return {
    feature: { featureKey: featureNode.refId, family: featureNode.metadata.family },
    candidateMeasurement: candidateNode ? { candidateId: candidateNode.refId, label: candidateNode.label } : null,
    hypothesis: hypothesisNode
      ? {
          hypothesisId: hypothesisNode.refId,
          lifecycleStage: await getCurrentLifecycleStage(hypothesisNode.refId),
          publicationStatus: await getCurrentPublicationStatus(hypothesisNode.refId),
        }
      : null,
    behavior: behaviorNode ? { behaviorId: behaviorNode.refId, label: behaviorNode.label } : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// PHASE 9 EXTENSION — Adaptive Scientific Discovery Engine, Requirement 9
// ("Extend Scientific Memory"). Everything below is additive to the module
// above: no existing export's behavior changes, no new store is created
// (Requirement 9's own rule: "The Knowledge Graph is the laboratory's ONLY
// scientific memory"). New node/edge types were added to NODE_TYPES/
// EDGE_TYPES above; everything here builds on the same registerNode/
// registerEdge/listEdgesFrom/listEdgesTo primitives already used throughout
// this file.
//
// Design note on mutability (resolved during implementation, not assumed
// beforehand): KnowledgeGraphNodes is write-once (see this module's own
// header — "registering the same (nodeType, refId) pair twice is a safe
// idempotent no-op"). A RepresentationFamily's status is NOT stored as
// mutable node metadata for exactly the same reason hypothesisRegistry.js
// never mutates a HypothesisRegistry row in place: this codebase tracks
// state CHANGES in a separate append-only ledger. Here, that ledger is a
// self-referential edge (RepresentationFamily -> itself) of type
// REPRESENTATION_FAMILY_STATUS_TRANSITION — current status is simply the
// most recent such edge. This is not a new storage mechanism, it is the
// exact same edge primitive already used for every other relationship in
// this file, applied to a node's own history instead of to another node.
// The identical technique is used for DiscoveryCampaign round-by-round
// metrics (CAMPAIGN_ROUND_METRIC self-edges) — a campaign's aggregate
// stats accumulate as a permanent timeline of append-only facts, never as
// an in-place counter mutation.
// ═════════════════════════════════════════════════════════════════════════

// ── Representation Family lifecycle (Requirement 9 / Requirement 4) ───────

export const REPRESENTATION_FAMILY_STATUSES = Object.freeze({
  ACTIVE: 'Active',
  REJECTED: 'Rejected',
  REPLICATED: 'Replicated',
  RETIRED: 'Retired',
});

// A rejected family may only become Active again for one of these reasons
// (Requirement 9's guardrail: "Previously rejected hypotheses may only be
// reconsidered when justified by ... genuinely new data, a new
// representation family, a different scientific question, or a formally
// pre-registered protocol revision"). Machine-checkable, not free text,
// mirroring how this codebase prefers an enum precondition over a prose
// convention wherever the precondition can be made mechanical.
export const REPRESENTATION_FAMILY_JUSTIFICATION_TYPES = Object.freeze({
  NEW_DATA: 'NewData',
  NEW_SEARCH_SPACE_VERSION: 'NewSearchSpaceVersion',
  NEW_SCIENTIFIC_QUESTION: 'NewScientificQuestion',
  PROTOCOL_REVISION: 'ProtocolRevision',
});

// Mirrors hypothesisRegistry.js's ALLOWED_TRANSITIONS shape exactly: a
// whitelist graph, not a convention enforced only by caller discipline.
const ALLOWED_REPRESENTATION_FAMILY_TRANSITIONS = Object.freeze({
  [REPRESENTATION_FAMILY_STATUSES.ACTIVE]: Object.freeze([
    REPRESENTATION_FAMILY_STATUSES.REJECTED,
    REPRESENTATION_FAMILY_STATUSES.REPLICATED,
    REPRESENTATION_FAMILY_STATUSES.RETIRED,
  ]),
  [REPRESENTATION_FAMILY_STATUSES.REJECTED]: Object.freeze([
    REPRESENTATION_FAMILY_STATUSES.ACTIVE, // only with a qualifying justificationType, enforced below
    REPRESENTATION_FAMILY_STATUSES.RETIRED,
  ]),
  [REPRESENTATION_FAMILY_STATUSES.REPLICATED]: Object.freeze([
    REPRESENTATION_FAMILY_STATUSES.RETIRED,
  ]),
  [REPRESENTATION_FAMILY_STATUSES.RETIRED]: Object.freeze([]),
});

export const EDGE_TYPES_PHASE9 = Object.freeze({
  REPRESENTATION_FAMILY_STATUS_TRANSITION: 'representationFamilyStatusTransition', // RepresentationFamily -> itself
  CAMPAIGN_ROUND_METRIC: 'campaignRoundMetric',                                    // DiscoveryCampaign -> itself
});

export class InvalidRepresentationFamilyTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRepresentationFamilyTransitionError';
  }
}

/**
 * Registers a Representation Family node and immediately records its
 * initial status transition (null -> Active) via the same append-only edge
 * mechanism every later transition uses — there is no separate "creation"
 * code path for status, only the first row in the transition history.
 */
export async function registerRepresentationFamily({ familyId, label, description } = {}) {
  if (!familyId) {
    throw new InvalidKnowledgeGraphInputError('registerRepresentationFamily: "familyId" is required.');
  }
  if (!label) {
    throw new InvalidKnowledgeGraphInputError('registerRepresentationFamily: a representation family requires at least a label.');
  }
  const node = await registerNode({
    nodeType: NODE_TYPES.REPRESENTATION_FAMILY,
    refId: familyId,
    label,
    metadata: { description: description || '' },
  });
  const existing = await listEdgesFrom(node.id, { edgeType: EDGE_TYPES_PHASE9.REPRESENTATION_FAMILY_STATUS_TRANSITION });
  if (existing.length === 0) {
    await registerEdge({
      edgeType: EDGE_TYPES_PHASE9.REPRESENTATION_FAMILY_STATUS_TRANSITION,
      fromNodeId: node.id,
      toNodeId: node.id,
      metadata: {
        status: REPRESENTATION_FAMILY_STATUSES.ACTIVE,
        previousStatus: null,
        reason: 'Initial registration.',
        justificationType: null,
        transitionedAt: Date.now(),
      },
    });
  }
  return node;
}

/** Full, time-ordered status transition history for a Representation Family. */
export async function listRepresentationFamilyStatusHistory(familyId) {
  const node = await getNode(NODE_TYPES.REPRESENTATION_FAMILY, familyId);
  if (!node) return [];
  const edges = await listEdgesFrom(node.id, { edgeType: EDGE_TYPES_PHASE9.REPRESENTATION_FAMILY_STATUS_TRANSITION });
  return edges.slice().sort((a, b) => a.seq - b.seq).map((e) => e.metadata);
}

/** The Representation Family's current status (its most recent transition), or null if unregistered. */
export async function getRepresentationFamilyStatus(familyId) {
  const history = await listRepresentationFamilyStatusHistory(familyId);
  if (history.length === 0) return null;
  return history[history.length - 1].status;
}

/**
 * Transitions a Representation Family's status, enforced against
 * ALLOWED_REPRESENTATION_FAMILY_TRANSITIONS exactly the way
 * hypothesisRegistry.transitionLifecycleStage enforces ALLOWED_TRANSITIONS.
 * A Rejected -> Active transition additionally requires a qualifying
 * justificationType (Requirement 9's reconsideration guardrail) — this is
 * the one precondition this function checks that the generic whitelist
 * graph cannot express by itself.
 */
export async function transitionRepresentationFamilyStatus({ familyId, to, reason, justificationType } = {}) {
  if (!familyId) {
    throw new InvalidKnowledgeGraphInputError('transitionRepresentationFamilyStatus: "familyId" is required.');
  }
  if (!Object.values(REPRESENTATION_FAMILY_STATUSES).includes(to)) {
    throw new InvalidKnowledgeGraphInputError(
      `transitionRepresentationFamilyStatus: "to" must be one of ${Object.values(REPRESENTATION_FAMILY_STATUSES).join(', ')}`
    );
  }
  const node = await getNode(NODE_TYPES.REPRESENTATION_FAMILY, familyId);
  if (!node) {
    throw new UnknownNodeReferenceError(
      `transitionRepresentationFamilyStatus: "${familyId}" is not a registered Representation Family — register it first.`
    );
  }
  const current = await getRepresentationFamilyStatus(familyId);
  const allowed = ALLOWED_REPRESENTATION_FAMILY_TRANSITIONS[current] || [];
  if (!allowed.includes(to)) {
    throw new InvalidRepresentationFamilyTransitionError(
      `transitionRepresentationFamilyStatus: "${current}" -> "${to}" is not an allowed transition for Representation Family "${familyId}". ` +
      `Allowed from "${current}": ${allowed.length ? allowed.join(', ') : '(none — terminal state)'}`
    );
  }
  if (current === REPRESENTATION_FAMILY_STATUSES.REJECTED && to === REPRESENTATION_FAMILY_STATUSES.ACTIVE) {
    if (!Object.values(REPRESENTATION_FAMILY_JUSTIFICATION_TYPES).includes(justificationType)) {
      throw new InvalidRepresentationFamilyTransitionError(
        `transitionRepresentationFamilyStatus: reviving a Rejected Representation Family requires a qualifying "justificationType" ` +
        `(one of ${Object.values(REPRESENTATION_FAMILY_JUSTIFICATION_TYPES).join(', ')}) — a rejected family may not simply be re-tried.`
      );
    }
  }
  return registerEdge({
    edgeType: EDGE_TYPES_PHASE9.REPRESENTATION_FAMILY_STATUS_TRANSITION,
    fromNodeId: node.id,
    toNodeId: node.id,
    metadata: {
      status: to,
      previousStatus: current,
      reason: reason || '',
      justificationType: justificationType || null,
      transitionedAt: Date.now(),
    },
  });
}

/** Reflects that an already-registered real Hypothesis was drawn from a given Representation Family. Never creates the family. */
export async function linkHypothesisToRepresentationFamily(hypothesisId, familyId) {
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`linkHypothesisToRepresentationFamily: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  const familyNode = await requireNode(NODE_TYPES.REPRESENTATION_FAMILY, familyId, 'linkHypothesisToRepresentationFamily');
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  return registerEdge({ edgeType: EDGE_TYPES.INSTANCE_OF_FAMILY, fromNodeId: hypothesisNode.id, toNodeId: familyNode.id });
}

// ── Search Space Version (Requirement 9 / architecture doc Section 5) ─────

/** Registers a frozen, versioned Generator/grammar snapshot node — the graph-side counterpart to the legacy SearchSpaceSpecVersion concept. */
export async function registerSearchSpaceVersion({ versionId, label, metadata } = {}) {
  if (!versionId) {
    throw new InvalidKnowledgeGraphInputError('registerSearchSpaceVersion: "versionId" is required.');
  }
  return registerNode({
    nodeType: NODE_TYPES.SEARCH_SPACE_VERSION,
    refId: versionId,
    label: label || versionId,
    metadata: metadata || {},
  });
}

/** Answers, for a given real Hypothesis, "under what Generator/grammar version was this hypothesis allowed to exist." */
export async function linkHypothesisToSearchSpaceVersion(hypothesisId, versionId) {
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`linkHypothesisToSearchSpaceVersion: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  const versionNode = await requireNode(NODE_TYPES.SEARCH_SPACE_VERSION, versionId, 'linkHypothesisToSearchSpaceVersion');
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  return registerEdge({ edgeType: EDGE_TYPES.GENERATED_FROM, fromNodeId: hypothesisNode.id, toNodeId: versionNode.id });
}

// ── Discovery / Replication Campaigns (Requirement 9, funnel Rounds 1-4) ──

/**
 * Registers a Discovery Campaign node. `representationFamilyId`, when
 * supplied, is stored as immutable node metadata (not an edge) — a
 * campaign is scoped to one representation family for its whole lifetime,
 * decided at creation, so this is a creation-time fact rather than a
 * relationship that changes over time.
 */
export async function registerDiscoveryCampaign({ campaignId, label, representationFamilyId, metadata } = {}) {
  if (!campaignId) {
    throw new InvalidKnowledgeGraphInputError('registerDiscoveryCampaign: "campaignId" is required.');
  }
  if (representationFamilyId) {
    await requireNode(NODE_TYPES.REPRESENTATION_FAMILY, representationFamilyId, 'registerDiscoveryCampaign');
  }
  return registerNode({
    nodeType: NODE_TYPES.DISCOVERY_CAMPAIGN,
    refId: campaignId,
    label: label || campaignId,
    metadata: { representationFamilyId: representationFamilyId || null, ...(metadata || {}) },
  });
}

export async function registerReplicationCampaign({ campaignId, label, representationFamilyId, metadata } = {}) {
  if (!campaignId) {
    throw new InvalidKnowledgeGraphInputError('registerReplicationCampaign: "campaignId" is required.');
  }
  if (representationFamilyId) {
    await requireNode(NODE_TYPES.REPRESENTATION_FAMILY, representationFamilyId, 'registerReplicationCampaign');
  }
  return registerNode({
    nodeType: NODE_TYPES.REPLICATION_CAMPAIGN,
    refId: campaignId,
    label: label || campaignId,
    metadata: { representationFamilyId: representationFamilyId || null, ...(metadata || {}) },
  });
}

/** Links a real Hypothesis to a Discovery Campaign (memberOfCampaign) or, when replication=true, a Replication Campaign (replicatedIn). */
export async function linkHypothesisToCampaign(hypothesisId, campaignId, { replication = false } = {}) {
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`linkHypothesisToCampaign: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  const campaignNode = await requireNode(
    replication ? NODE_TYPES.REPLICATION_CAMPAIGN : NODE_TYPES.DISCOVERY_CAMPAIGN,
    campaignId,
    'linkHypothesisToCampaign'
  );
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  return registerEdge({
    edgeType: replication ? EDGE_TYPES.REPLICATED_IN : EDGE_TYPES.MEMBER_OF_CAMPAIGN,
    fromNodeId: hypothesisNode.id,
    toNodeId: campaignNode.id,
  });
}

/**
 * Records one round's aggregate funnel statistics for a Discovery Campaign
 * (Requirement 2's per-round evaluated/promoted counts; architecture doc
 * Section 7's hit-rate monitoring). Rounds 1/2 operate on volumes (millions
 * of Generator-produced candidates) that make an individual node/edge per
 * candidate infeasible under this codebase's own "never an unbounded store
 * scan" discipline — this aggregate record is the scalable equivalent of
 * "nothing eliminated at any round is permanently recorded" for those two
 * rounds. Round 3+ eliminations of already-registered Hypotheses are
 * additionally recorded individually via recordScreenedNotPromoted, below,
 * since those candidates DO have a stable id cheap enough to attach an
 * edge to.
 */
export async function recordCampaignRoundMetric({ campaignId, round, evaluated, promoted, computationalCost } = {}) {
  if (!campaignId) {
    throw new InvalidKnowledgeGraphInputError('recordCampaignRoundMetric: "campaignId" is required.');
  }
  if (!Number.isInteger(round) || round < 1 || round > 4) {
    throw new InvalidKnowledgeGraphInputError('recordCampaignRoundMetric: "round" must be an integer 1-4.');
  }
  const campaignNode = await getNode(NODE_TYPES.DISCOVERY_CAMPAIGN, campaignId)
    || await getNode(NODE_TYPES.REPLICATION_CAMPAIGN, campaignId);
  if (!campaignNode) {
    throw new UnknownNodeReferenceError(`recordCampaignRoundMetric: "${campaignId}" is not a registered campaign.`);
  }
  return registerEdge({
    edgeType: EDGE_TYPES_PHASE9.CAMPAIGN_ROUND_METRIC,
    fromNodeId: campaignNode.id,
    toNodeId: campaignNode.id,
    metadata: {
      round,
      evaluated: Number.isFinite(evaluated) ? evaluated : null,
      promoted: Number.isFinite(promoted) ? promoted : null,
      hitRate: (Number.isFinite(evaluated) && evaluated > 0 && Number.isFinite(promoted)) ? promoted / evaluated : null,
      computationalCost: Number.isFinite(computationalCost) ? computationalCost : null,
      recordedAt: Date.now(),
    },
  });
}

/** Full, time-ordered per-round metric history for one campaign. */
export async function listCampaignRoundMetrics(campaignId) {
  const campaignNode = await getNode(NODE_TYPES.DISCOVERY_CAMPAIGN, campaignId)
    || await getNode(NODE_TYPES.REPLICATION_CAMPAIGN, campaignId);
  if (!campaignNode) return [];
  const edges = await listEdgesFrom(campaignNode.id, { edgeType: EDGE_TYPES_PHASE9.CAMPAIGN_ROUND_METRIC });
  return edges.slice().sort((a, b) => a.seq - b.seq).map((e) => e.metadata);
}

/**
 * Records that an already-registered real Hypothesis (one that reached
 * Round 2 registration or beyond) was screened and NOT promoted past a
 * given funnel round, with the reason — the permanent, individually
 * addressable elimination record Requirement 2 calls for, scoped to the
 * population of candidates for which an individual record is actually
 * scalable (see recordCampaignRoundMetric's doc comment above for Round
 * 1/2 volumes).
 */
export async function recordScreenedNotPromoted({ hypothesisId, round, reason, representationFamilyId } = {}) {
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`recordScreenedNotPromoted: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  let targetNode;
  if (representationFamilyId) {
    targetNode = await requireNode(NODE_TYPES.REPRESENTATION_FAMILY, representationFamilyId, 'recordScreenedNotPromoted');
  } else {
    throw new InvalidKnowledgeGraphInputError('recordScreenedNotPromoted: "representationFamilyId" is required.');
  }
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  return registerEdge({
    edgeType: EDGE_TYPES.SCREENED_NOT_PROMOTED,
    fromNodeId: hypothesisNode.id,
    toNodeId: targetNode.id,
    metadata: { round: round ?? null, reason: reason || '', recordedAt: Date.now() },
  });
}

// ── Evidence Summary (Requirement 9's multi-axis confidence profile) ──────

/**
 * Registers an Evidence Summary node for a real Hypothesis. `evidenceTier`
 * is expected to be one of evidenceStandards.js's own EVIDENCE_TIERS (not
 * re-validated here to avoid a circular import — evidenceStandards.js does
 * not import this module — callers pass the real tier they already
 * computed). `confidenceProfile` is the architecture doc's Section 6
 * multi-axis object (statistical evidence, replication, effect size,
 * stability, generalization, computational cost, practical significance),
 * stored as a structured object, never collapsed to one scalar.
 */
export async function registerEvidenceSummary({ summaryId, hypothesisId, evidenceTier, uncertaintyClassification, confidenceProfile } = {}) {
  if (!summaryId) {
    throw new InvalidKnowledgeGraphInputError('registerEvidenceSummary: "summaryId" is required.');
  }
  const hypothesis = await getHypothesis(hypothesisId);
  if (!hypothesis) {
    throw new UnknownNodeReferenceError(`registerEvidenceSummary: "${hypothesisId}" does not reference a registered hypothesis.`);
  }
  const hypothesisNode = await registerNode({
    nodeType: NODE_TYPES.HYPOTHESIS,
    refId: hypothesisId,
    label: hypothesis.reasonForCreation || hypothesisId,
    metadata: { familyKey: hypothesis.familyKey, scientificQuestionRef: hypothesis.scientificQuestionRef },
  });
  const summaryNode = await registerNode({
    nodeType: NODE_TYPES.EVIDENCE_SUMMARY,
    refId: summaryId,
    label: summaryId,
    metadata: {
      hypothesisId,
      evidenceTier: evidenceTier || null,
      uncertaintyClassification: uncertaintyClassification || null,
      confidenceProfile: confidenceProfile || {},
    },
  });
  await registerEdge({ edgeType: EDGE_TYPES.SUMMARIZES, fromNodeId: summaryNode.id, toNodeId: hypothesisNode.id });
  return summaryNode;
}

// ── Scientific Memory queries (Requirement 9, item 5 — "Scientific Memory
//    Queries") ─────────────────────────────────────────────────────────
//
// GUARDRAIL, restated at the point of use because this is the one place a
// future caller could accidentally violate it: every function below is a
// READ over already-recorded history. None of them may be called from
// inside onlineFdr.js, discoveryDecision.js, or publicationStatus.js — they
// exist to tell the adaptive search engine (searchEngine.js /
// campaignPrioritization.js) WHERE to look next, never to help decide
// whether something is a discovery.

/** Which representation families are currently Rejected. */
export async function queryFailedRepresentationFamilies() {
  const nodes = await listNodesByType(NODE_TYPES.REPRESENTATION_FAMILY);
  const results = [];
  for (const node of nodes) {
    const status = await getRepresentationFamilyStatus(node.refId);
    if (status === REPRESENTATION_FAMILY_STATUSES.REJECTED) {
      results.push({ familyId: node.refId, label: node.label, status });
    }
  }
  return results;
}

/** Which representation families are currently Active (eligible for further exploration). */
export async function queryActiveRepresentationFamilies() {
  const nodes = await listNodesByType(NODE_TYPES.REPRESENTATION_FAMILY);
  const results = [];
  for (const node of nodes) {
    const status = await getRepresentationFamilyStatus(node.refId);
    if (status === REPRESENTATION_FAMILY_STATUSES.ACTIVE) {
      results.push({ familyId: node.refId, label: node.label, status });
    }
  }
  return results;
}

/**
 * For each canonical Feature Family (FEATURE_FAMILIES), the count of
 * distinct Features implemented in that family whose parent Hypothesis was
 * ultimately screened-not-promoted at least once, versus the count that
 * were not — a per-family failure-rate proxy answering "which feature
 * families consistently fail." Walks Feature -> CandidateMeasurement ->
 * Hypothesis (the same chain traceFeatureLineage already walks) and checks
 * for SCREENED_NOT_PROMOTED edges on that hypothesis.
 */
export async function queryFeatureFamilyOutcomeStats() {
  const stats = {};
  for (const family of FEATURE_FAMILIES) stats[family] = { featuresObserved: 0, featuresWithEliminatedHypothesis: 0 };

  const featureNodes = await listNodesByType(NODE_TYPES.FEATURE);
  for (const featureNode of featureNodes) {
    const family = featureNode.metadata?.family;
    if (!family || !(family in stats)) continue;
    stats[family].featuresObserved += 1;

    const lineage = await traceFeatureLineage(featureNode.refId);
    if (!lineage.hypothesis) continue;
    const hypothesisNode = await getNode(NODE_TYPES.HYPOTHESIS, lineage.hypothesis.hypothesisId);
    if (!hypothesisNode) continue;
    const eliminationEdges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.SCREENED_NOT_PROMOTED });
    if (eliminationEdges.length > 0) {
      stats[family].featuresWithEliminatedHypothesis += 1;
    }
  }

  return Object.fromEntries(
    Object.entries(stats).map(([family, s]) => [
      family,
      { ...s, eliminationRate: s.featuresObserved > 0 ? s.featuresWithEliminatedHypothesis / s.featuresObserved : null },
    ])
  );
}

/**
 * Features whose parent Hypothesis has at least one Evidence Summary with
 * evidenceTier in `survivingTiers` (default: any recorded summary at all,
 * since this module does not import evidenceStandards.js's tier ranking to
 * avoid a circular dependency — callers wanting a tier-ranked cut should
 * filter the returned evidenceTier values themselves against
 * evidenceStandards.TIER_RANK) — answers "which transformations repeatedly
 * survive."
 */
export async function querySurvivingTransformations({ survivingTiers } = {}) {
  const featureNodes = await listNodesByType(NODE_TYPES.FEATURE);
  const survivors = [];
  for (const featureNode of featureNodes) {
    const lineage = await traceFeatureLineage(featureNode.refId);
    if (!lineage.hypothesis) continue;
    const hypothesisNode = await getNode(NODE_TYPES.HYPOTHESIS, lineage.hypothesis.hypothesisId);
    if (!hypothesisNode) continue;
    const summaryEdges = await listEdgesTo(hypothesisNode.id, { edgeType: EDGE_TYPES.SUMMARIZES });
    if (summaryEdges.length === 0) continue;
    const nodesAdapter = await getKnowledgeGraphNodesAdapter();
    let survived = false;
    let latestTier = null;
    for (const edge of summaryEdges) {
      const summaryNode = await nodesAdapter.get(edge.fromNodeId);
      if (!summaryNode) continue;
      latestTier = summaryNode.metadata.evidenceTier;
      if (!survivingTiers || survivingTiers.includes(summaryNode.metadata.evidenceTier)) {
        survived = true;
      }
    }
    if (survived) {
      survivors.push({ featureKey: featureNode.refId, family: featureNode.metadata.family, evidenceTier: latestTier });
    }
  }
  return survivors;
}

/** Search Space Versions with zero Hypotheses generated from them yet — the coarsest-grained honest answer this graph can give to "which regions remain unexplored." */
export async function queryUnexploredSearchSpaceVersions() {
  const versionNodes = await listNodesByType(NODE_TYPES.SEARCH_SPACE_VERSION);
  const unexplored = [];
  for (const versionNode of versionNodes) {
    const edges = await listEdgesTo(versionNode.id, { edgeType: EDGE_TYPES.GENERATED_FROM });
    if (edges.length === 0) {
      unexplored.push({ versionId: versionNode.refId, label: versionNode.label });
    }
  }
  return unexplored;
}

/**
 * Every Discovery and Replication Campaign node scoped to a given
 * Representation Family (campaigns declare this at creation time via
 * registerDiscoveryCampaign/registerReplicationCampaign's
 * representationFamilyId parameter). Single source for this filter —
 * queryComputationalCostByRepresentationFamily below and
 * discovery/campaignPrioritization.js both build on this rather than each
 * re-implementing the same scan-and-filter.
 */
export async function listCampaignsForRepresentationFamily(familyId) {
  await requireNode(NODE_TYPES.REPRESENTATION_FAMILY, familyId, 'listCampaignsForRepresentationFamily');
  const discoveryCampaigns = await listNodesByType(NODE_TYPES.DISCOVERY_CAMPAIGN);
  const replicationCampaigns = await listNodesByType(NODE_TYPES.REPLICATION_CAMPAIGN);
  return [...discoveryCampaigns, ...replicationCampaigns].filter((n) => n.metadata?.representationFamilyId === familyId);
}

/** Total recorded computational cost across every Discovery/Replication Campaign scoped to a given Representation Family. */
export async function queryComputationalCostByRepresentationFamily(familyId) {
  const scoped = await listCampaignsForRepresentationFamily(familyId);
  let total = 0;
  for (const campaignNode of scoped) {
    const metrics = await listCampaignRoundMetrics(campaignNode.refId);
    for (const m of metrics) {
      if (Number.isFinite(m.computationalCost)) total += m.computationalCost;
    }
  }
  return { familyId, campaignsScoped: scoped.length, totalComputationalCost: total };
}

/** Every Replication Campaign a real Hypothesis has been through, in order. */
export async function queryReplicationHistory(hypothesisId) {
  const hypothesisNode = await getNode(NODE_TYPES.HYPOTHESIS, hypothesisId);
  if (!hypothesisNode) return [];
  const edges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.REPLICATED_IN });
  const nodesAdapter = await getKnowledgeGraphNodesAdapter();
  const results = [];
  for (const edge of edges.slice().sort((a, b) => a.seq - b.seq)) {
    const campaignNode = await nodesAdapter.get(edge.toNodeId);
    if (campaignNode) results.push({ campaignId: campaignNode.refId, label: campaignNode.label });
  }
  return results;
}

/**
 * The complete evidence trail for one real Hypothesis: representation
 * family + status, search space version, discovery/replication campaign
 * membership, elimination history, and every recorded Evidence Summary —
 * composed entirely from the primitives above and hypothesisRegistry.js/
 * publicationStatus.js's own live status, nothing new stored.
 */
export async function queryEvidenceLineage(hypothesisId) {
  const hypothesisNode = await getNode(NODE_TYPES.HYPOTHESIS, hypothesisId);
  if (!hypothesisNode) {
    return { error: `Unknown hypothesisId: ${hypothesisId}` };
  }
  const nodesAdapter = await getKnowledgeGraphNodesAdapter();

  const familyEdges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.INSTANCE_OF_FAMILY });
  const familyEdge = familyEdges[0];
  const familyNode = familyEdge ? await nodesAdapter.get(familyEdge.toNodeId) : null;

  const versionEdges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.GENERATED_FROM });
  const versionNode = versionEdges[0] ? await nodesAdapter.get(versionEdges[0].toNodeId) : null;

  const campaignEdges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.MEMBER_OF_CAMPAIGN });
  const campaigns = [];
  for (const e of campaignEdges) {
    const n = await nodesAdapter.get(e.toNodeId);
    if (n) campaigns.push({ campaignId: n.refId, label: n.label });
  }

  const eliminationEdges = await listEdgesFrom(hypothesisNode.id, { edgeType: EDGE_TYPES.SCREENED_NOT_PROMOTED });
  const eliminations = eliminationEdges.map((e) => e.metadata);

  const summaryEdges = await listEdgesTo(hypothesisNode.id, { edgeType: EDGE_TYPES.SUMMARIZES });
  const summaries = [];
  for (const e of summaryEdges) {
    const n = await nodesAdapter.get(e.fromNodeId);
    if (n) summaries.push({ summaryId: n.refId, ...n.metadata });
  }

  const [lifecycleStage, publicationStatus, replicationHistory] = await Promise.all([
    getCurrentLifecycleStage(hypothesisId),
    getCurrentPublicationStatus(hypothesisId),
    queryReplicationHistory(hypothesisId),
  ]);

  return {
    hypothesisId,
    lifecycleStage: lifecycleStage ?? null,
    publicationStatus: publicationStatus ?? null,
    representationFamily: familyNode ? { familyId: familyNode.refId, label: familyNode.label } : null,
    searchSpaceVersion: versionNode ? { versionId: versionNode.refId, label: versionNode.label } : null,
    discoveryCampaigns: campaigns,
    eliminationHistory: eliminations,
    replicationHistory,
    evidenceSummaries: summaries,
  };
}
