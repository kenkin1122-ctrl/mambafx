/**
 * research/src/governance/NegativeEvidenceRegistry.js
 *
 * Purpose:
 *   Permanent, append-only archive of rejected Phase 11 candidates —
 *   directive requirement #23 ("Negative Evidence Registry — rejected
 *   hypotheses permanently archived") and constraint #9 ("Negative Findings
 *   Are First-Class Outputs: rejected hypotheses shall remain queryable,
 *   versioned, reproducible, and included in the Knowledge Graph").
 *
 * Scientific rationale:
 *   Publication bias — the selective reporting of only positive results —
 *   is one of the largest known threats to the replicability of empirical
 *   research. A permanent, queryable record of every rejection (with the
 *   same rigor as an acceptance: fingerprint, stage, effect size, CI,
 *   dataset) makes it possible to later ask "how many times has this
 *   family been tested and failed?" — the exact information an isolated
 *   record of only confirmed discoveries would erase.
 *
 * Relationship to knowledgeGraph.recordScreenedNotPromoted (existing,
 *   DO NOT TOUCH): that function already records a *screened-out* note in
 *   the Knowledge Graph for legacy Round 1 eliminations. This registry is
 *   Phase 11-native and broader in scope (covers screening, triage,
 *   confirmation, AND replication rejections, not just Round 1) and richer
 *   in required fields (effect size + CI + replication status, per
 *   constraint #8). It does not replace recordScreenedNotPromoted; the two
 *   can be called side-by-side (see discovery/phase11FunnelBridge.js) —
 *   this keeps the legacy Knowledge Graph note-taking untouched while
 *   giving Phase 11 its own fully-specified permanent record.
 *
 * Phase A/B precedent: like DecisionAuditLog and ScientificDebtLog, this is
 *   a Phase-A-style pure in-memory implementation; IndexedDB backing is a
 *   deferred wiring concern (recorded in ScientificDebtLog — see
 *   phase11FunnelBridge.js's registerKnownDeferredWork()).
 *
 * Dependencies: none.
 * Public API: NegativeEvidenceRegistry, NegativeEvidenceEntry,
 *   InvalidNegativeEvidenceError, REJECTION_STAGES.
 * Complexity: record O(1); query methods O(n) in registry size.
 */

/** Recognised pipeline stages at which a candidate can be rejected. */
export const REJECTION_STAGES = Object.freeze({
  SCREENING:    'SCREENING',    // Round 1
  TRIAGE:       'TRIAGE',       // Round 2
  CONFIRMATION: 'CONFIRMATION', // Round 3
  REPLICATION:  'REPLICATION',  // Round 4
});

const VALID_STAGES = new Set(Object.values(REJECTION_STAGES));

export class InvalidNegativeEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidNegativeEvidenceError';
  }
}

/** A single immutable negative-evidence record. */
export class NegativeEvidenceEntry {
  constructor({
    candidateFingerprint, stageRejected, reason, dataset = null,
    effectSize = null, confidenceInterval = null, replicationStatus = null,
    timestamp,
  }) {
    this.candidateFingerprint = candidateFingerprint;
    this.stageRejected = stageRejected;
    this.reason = reason;
    this.dataset = dataset;
    this.effectSize = effectSize;
    this.confidenceInterval = confidenceInterval ? Object.freeze({ ...confidenceInterval }) : null;
    this.replicationStatus = replicationStatus;
    this.timestamp = typeof timestamp === 'number' ? timestamp : Date.now();
    Object.freeze(this);
  }

  toJSON() {
    return {
      candidateFingerprint: this.candidateFingerprint,
      stageRejected: this.stageRejected,
      reason: this.reason,
      dataset: this.dataset,
      effectSize: this.effectSize,
      confidenceInterval: this.confidenceInterval,
      replicationStatus: this.replicationStatus,
      timestamp: this.timestamp,
    };
  }
}

export class NegativeEvidenceRegistry {
  /** @type {NegativeEvidenceEntry[]} */
  #entries = [];

  /**
   * Records a rejection as a permanent scientific object. Append-only —
   * there is no delete or update method; a candidate re-tested later and
   * rejected again produces a NEW entry, preserving the full history.
   * O(1).
   *
   * @param {object} params
   * @param {string} params.candidateFingerprint - SHA-256 fingerprint (Candidate.fingerprint).
   * @param {string} params.stageRejected         - One of REJECTION_STAGES.
   * @param {string} params.reason                - Human-readable rejection rationale.
   * @param {string} [params.dataset]              - Dataset identifier the test ran against.
   * @param {number} [params.effectSize]
   * @param {{lower: number, upper: number, level: number}} [params.confidenceInterval]
   * @param {string} [params.replicationStatus]   - e.g. 'not_attempted', 'failed', 'n/a'.
   * @param {number} [params.timestamp]           - Defaults to Date.now().
   * @returns {NegativeEvidenceEntry}
   */
  record({
    candidateFingerprint, stageRejected, reason, dataset,
    effectSize, confidenceInterval, replicationStatus, timestamp,
  } = {}) {
    const errors = [];
    if (!candidateFingerprint || typeof candidateFingerprint !== 'string')
      errors.push('candidateFingerprint: required non-empty string');
    if (!VALID_STAGES.has(stageRejected))
      errors.push(`stageRejected: must be one of [${[...VALID_STAGES].join(', ')}]`);
    if (!reason || typeof reason !== 'string')
      errors.push('reason: required non-empty string');
    if (errors.length) throw new InvalidNegativeEvidenceError(errors.join('; '));

    const entry = new NegativeEvidenceEntry({
      candidateFingerprint, stageRejected, reason, dataset,
      effectSize, confidenceInterval, replicationStatus, timestamp,
    });
    this.#entries.push(entry);
    return entry;
  }

  /** @returns {NegativeEvidenceEntry[]} All rejections for a given candidate fingerprint. */
  byFingerprint(candidateFingerprint) {
    return this.#entries.filter(e => e.candidateFingerprint === candidateFingerprint);
  }

  /** @returns {NegativeEvidenceEntry[]} All rejections at a given stage. */
  byStage(stageRejected) {
    return this.#entries.filter(e => e.stageRejected === stageRejected);
  }

  /** @returns {number} How many times a given candidate fingerprint has been rejected, across all stages. */
  rejectionCount(candidateFingerprint) {
    return this.byFingerprint(candidateFingerprint).length;
  }

  /** @returns {NegativeEvidenceEntry[]} Full registry, insertion order. */
  all() {
    return this.#entries.slice();
  }

  /** @returns {number} */
  get size() {
    return this.#entries.length;
  }
}
