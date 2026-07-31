/**
 * research/src/provenance/ProvenanceDAG.js
 *
 * Purpose:
 *   Generic, dependency-free directed acyclic graph for recording the full
 *   derivation lineage of a Phase 11 discovery candidate — from raw
 *   observable measurements, through derived features, contexts, and market
 *   construct proxies, up to the candidate itself and the research
 *   governance objects (ResearchConfiguration, ResearchFreeze, SAP,
 *   generator version) that were active when it was produced.
 *
 * Scientific rationale:
 *   Directive requirement #18 ("Candidate Provenance DAGs for full
 *   traceability") and #19/#20 (Feature Provenance / Data Lineage) require
 *   that every candidate's derivation be independently auditable after the
 *   fact — e.g. to answer "did this feature's computation use only
 *   information available before event onset?" (CausalLeakageValidator,
 *   Phase B) or "which raw measurements ultimately feed this discovery?"
 *   (ReproducibilityGate, replication review). A DAG is the natural
 *   structure: nodes are provenance objects of a known NODE_TYPE, edges are
 *   directed "derivedFrom" relationships, and the acyclic constraint is
 *   enforced at insertion time so a malformed lineage (e.g. a feature
 *   circularly "derived from" itself via an intermediate) is caught
 *   immediately rather than silently corrupting later analysis.
 *
 * Design notes:
 *   - This module is intentionally generic (not candidate-specific) so it
 *     can back CandidateProvenance.js (whole-candidate lineage) and
 *     FeatureProvenanceDAG.js (measurement→feature lineage) without
 *     duplicating graph logic — both are thin builders over this class.
 *   - Cycle detection is O(V+E) per edge insertion (DFS from the proposed
 *     target back to the proposed source) which is acceptable given the
 *     DAGs here are small (bounded by a single candidate's derivation
 *     chain, not the whole campaign's search space).
 *   - No import of legacy code: this is a pure, standalone data structure,
 *     matching the "Extend — Never Replace" directive for legacy modules
 *     (there is nothing analogous to replace here — provenance/ did not
 *     exist before Phase C).
 *
 * Dependencies: none.
 * Public API: NODE_TYPES, ProvenanceDAG, ProvenanceCycleError, UnknownProvenanceNodeError.
 * Complexity: addNode O(1); addEdge O(V+E) (cycle check); ancestorsOf/
 *   descendantsOf O(V+E); toJSON O(V+E).
 */

/** Recognised provenance node types spanning the full Level 1-4 ontology. */
export const NODE_TYPES = Object.freeze({
  MEASUREMENT:            'MEASUREMENT',             // Level 1: raw observable
  FEATURE:                'FEATURE',                 // Level 2: derived feature
  CONTEXT:                'CONTEXT',                 // observable context (candle timing/position/prior candle)
  PROXY:                  'PROXY',                   // Level 3: market construct proxy
  CANDIDATE:              'CANDIDATE',               // Level 4: the candidate itself
  RESEARCH_CONFIGURATION: 'RESEARCH_CONFIGURATION',
  RESEARCH_FREEZE:        'RESEARCH_FREEZE',
  STATISTICAL_ANALYSIS_PLAN: 'STATISTICAL_ANALYSIS_PLAN',
  DATASET_MANIFEST:       'DATASET_MANIFEST',
  GENERATOR:              'GENERATOR',               // generator/grammar version marker
});

const VALID_NODE_TYPES = new Set(Object.values(NODE_TYPES));

export class ProvenanceCycleError extends Error {
  constructor(fromId, toId) {
    super(`ProvenanceDAG: adding edge ${fromId} → ${toId} would introduce a cycle`);
    this.name = 'ProvenanceCycleError';
    this.fromId = fromId;
    this.toId = toId;
  }
}

export class UnknownProvenanceNodeError extends Error {
  constructor(nodeId) {
    super(`ProvenanceDAG: node "${nodeId}" is not registered`);
    this.name = 'UnknownProvenanceNodeError';
    this.nodeId = nodeId;
  }
}

export class InvalidProvenanceNodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProvenanceNodeError';
  }
}

/**
 * A directed acyclic graph of provenance nodes and derivedFrom edges.
 *
 * Edge direction convention: addEdge(childId, parentId) means "childId is
 * derivedFrom parentId" — e.g. addEdge(featureId, measurementId) records
 * that the feature was derived from the measurement. This matches the
 * natural reading order of ancestorsOf() ("what did this node come from?").
 */
export class ProvenanceDAG {
  /** @type {Map<string, {id: string, type: string, label: string, metadata: object}>} */
  #nodes = new Map();
  /** @type {Map<string, Set<string>>} childId → Set<parentId> (derivedFrom edges) */
  #parentsOf = new Map();
  /** @type {Map<string, Set<string>>} parentId → Set<childId> (reverse index) */
  #childrenOf = new Map();

  /**
   * Registers a provenance node. Idempotent: re-adding the same id with
   * identical type is a no-op; re-adding with a different type throws.
   * O(1).
   *
   * @param {string} id
   * @param {object} params
   * @param {string} params.type    - One of NODE_TYPES.
   * @param {string} [params.label] - Human-readable label.
   * @param {object} [params.metadata]
   * @returns {ProvenanceDAG} this, for chaining.
   */
  addNode(id, { type, label = '', metadata = {} } = {}) {
    if (!id || typeof id !== 'string')
      throw new InvalidProvenanceNodeError('addNode: id must be a non-empty string');
    if (!VALID_NODE_TYPES.has(type))
      throw new InvalidProvenanceNodeError(`addNode: type "${type}" is not a recognised NODE_TYPE`);

    const existing = this.#nodes.get(id);
    if (existing) {
      if (existing.type !== type)
        throw new InvalidProvenanceNodeError(
          `addNode: node "${id}" already registered with type "${existing.type}", cannot re-add as "${type}"`
        );
      return this; // idempotent re-add
    }

    this.#nodes.set(id, { id, type, label, metadata: Object.freeze({ ...metadata }) });
    if (!this.#parentsOf.has(id)) this.#parentsOf.set(id, new Set());
    if (!this.#childrenOf.has(id)) this.#childrenOf.set(id, new Set());
    return this;
  }

  /** @returns {boolean} */
  hasNode(id) {
    return this.#nodes.has(id);
  }

  /** @returns {object|undefined} The registered node record, or undefined. */
  getNode(id) {
    return this.#nodes.get(id);
  }

  /**
   * Records a derivedFrom edge: childId was derived from parentId.
   * Throws UnknownProvenanceNodeError if either endpoint is unregistered,
   * ProvenanceCycleError if the edge would create a cycle.
   * O(V+E) due to the cycle check (DFS from parentId looking for childId
   * among parentId's ancestors — if found, the new edge would close a loop).
   *
   * @param {string} childId
   * @param {string} parentId
   * @returns {ProvenanceDAG} this, for chaining.
   */
  addEdge(childId, parentId) {
    if (!this.#nodes.has(childId)) throw new UnknownProvenanceNodeError(childId);
    if (!this.#nodes.has(parentId)) throw new UnknownProvenanceNodeError(parentId);
    if (childId === parentId) throw new ProvenanceCycleError(childId, parentId);

    // Cycle check: would parentId become a descendant of childId?
    // i.e. is childId already an ancestor of parentId? If parentId is
    // reachable FROM childId via existing parent edges... equivalently:
    // check whether childId is already in the ancestor set of parentId.
    if (this.#isAncestor(childId, parentId)) {
      throw new ProvenanceCycleError(childId, parentId);
    }

    this.#parentsOf.get(childId).add(parentId);
    this.#childrenOf.get(parentId).add(childId);
    return this;
  }

  /** @private DFS: is `candidateAncestorId` an ancestor of `nodeId`? */
  #isAncestor(candidateAncestorId, nodeId) {
    const visited = new Set();
    const stack = [nodeId];
    while (stack.length) {
      const current = stack.pop();
      if (current === candidateAncestorId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const parent of this.#parentsOf.get(current) || []) {
        stack.push(parent);
      }
    }
    return false;
  }

  /**
   * Returns all ancestor node ids of `id` (transitive parents), not
   * including `id` itself. O(V+E).
   * @param {string} id
   * @returns {string[]}
   */
  ancestorsOf(id) {
    if (!this.#nodes.has(id)) throw new UnknownProvenanceNodeError(id);
    const visited = new Set();
    const stack = [...(this.#parentsOf.get(id) || [])];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const parent of this.#parentsOf.get(current) || []) stack.push(parent);
    }
    return [...visited];
  }

  /**
   * Returns all descendant node ids of `id` (transitive children), not
   * including `id` itself. O(V+E).
   * @param {string} id
   * @returns {string[]}
   */
  descendantsOf(id) {
    if (!this.#nodes.has(id)) throw new UnknownProvenanceNodeError(id);
    const visited = new Set();
    const stack = [...(this.#childrenOf.get(id) || [])];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of this.#childrenOf.get(current) || []) stack.push(child);
    }
    return [...visited];
  }

  /** @returns {string[]} Direct parents (one hop). */
  directParentsOf(id) {
    if (!this.#nodes.has(id)) throw new UnknownProvenanceNodeError(id);
    return [...(this.#parentsOf.get(id) || [])];
  }

  /** @returns {string[]} Direct children (one hop). */
  directChildrenOf(id) {
    if (!this.#nodes.has(id)) throw new UnknownProvenanceNodeError(id);
    return [...(this.#childrenOf.get(id) || [])];
  }

  /** @returns {object[]} All registered nodes, insertion order. */
  listNodes() {
    return [...this.#nodes.values()];
  }

  /** @returns {number} Total node count. */
  get nodeCount() {
    return this.#nodes.size;
  }

  /** @returns {number} Total edge count. */
  get edgeCount() {
    let n = 0;
    for (const parents of this.#parentsOf.values()) n += parents.size;
    return n;
  }

  /**
   * Serializes the full DAG to a plain object safe for JSON.stringify.
   * @returns {{nodes: object[], edges: {child: string, parent: string}[]}}
   */
  toJSON() {
    const edges = [];
    for (const [child, parents] of this.#parentsOf.entries()) {
      for (const parent of parents) edges.push({ child, parent });
    }
    return {
      nodes: this.listNodes(),
      edges,
    };
  }
}
