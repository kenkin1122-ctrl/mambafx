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
});

export const EDGE_TYPES = Object.freeze({
  DERIVES_FROM: 'derivesFrom',                     // Hypothesis -> Behavior
  PROPOSES_MEASUREMENT_FOR: 'proposesMeasurementFor', // CandidateMeasurement -> Hypothesis
  IMPLEMENTS: 'implements',                         // Feature -> CandidateMeasurement
  BELONGS_TO_FAMILY: 'belongsToFamily',             // Hypothesis -> Family
  ANSWERS_QUESTION: 'answersQuestion',              // Family -> ScientificQuestion
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
