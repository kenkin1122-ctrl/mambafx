/**
 * research/src/governance/DecisionAuditLog.js
 *
 * Purpose:
 *   Append-only log of every decision affecting a Phase 11 candidate.
 *   Provides the audit trail recorded in Candidate.decisionAuditTrail and
 *   enables external review of the full decision history for any candidate.
 *
 * Scientific rationale:
 *   Reproducibility and fraud prevention both require that every decision
 *   affecting a candidate's fate (generation, promotion, rejection, deprecation)
 *   is permanently recorded with a timestamp, actor, and reason. An append-only
 *   log (no delete, no modify) is the strongest practical guarantee of this
 *   property outside of a blockchain — any tampering requires modifying the
 *   log object itself, which is detectable in review.
 *
 *   The decision type enum is pre-committed (DECISION_TYPES) so that no novel
 *   decision type can be invented post-hoc to reclassify an outcome.
 *
 * Phase A scope: pure in-memory implementation. IndexedDB backing is a Phase B
 *   wiring concern, following the same pattern as other governance modules
 *   (e.g., complianceAudit.js's separation of logic from storage).
 *
 * Dependencies: none.
 * Public API: DECISION_TYPES, DecisionAuditLog, DecisionAuditEntry,
 *   InvalidDecisionError.
 * Complexity: append O(1); forCandidate O(n) in log length; toArray O(n).
 */

/**
 * Complete enumeration of decision types that can affect a Phase 11 candidate.
 * This enum is pre-committed and non-extensible at runtime — adding a new
 * decision type requires a code change and schema version bump.
 */
export const DECISION_TYPES = Object.freeze({
  /** Candidate was created by the generator. */
  GENERATED:           'GENERATED',
  /** Candidate passed Round 1 screening and was promoted to Screened. */
  SCREENED_PROMOTED:   'SCREENED_PROMOTED',
  /** Candidate failed Round 1 screening and was rejected. */
  SCREENED_REJECTED:   'SCREENED_REJECTED',
  /** Candidate passed Round 2 validation and was promoted to Triaged. */
  TRIAGED_PROMOTED:    'TRIAGED_PROMOTED',
  /** Candidate failed Round 2 validation and was rejected. */
  TRIAGED_REJECTED:    'TRIAGED_REJECTED',
  /** Candidate passed Round 3 out-of-sample validation and was Confirmed. */
  CONFIRMED:           'CONFIRMED',
  /** Candidate failed Round 3 out-of-sample validation. */
  CONFIRMED_REJECTED:  'CONFIRMED_REJECTED',
  /** Candidate successfully replicated across independent time windows/regimes. */
  REPLICATED:          'REPLICATED',
  /** Candidate failed independent replication. */
  REPLICATION_FAILED:  'REPLICATION_FAILED',
  /** Candidate cleared ReproducibilityGate and all SAP publication criteria. */
  PUBLISHED:           'PUBLISHED',
  /** Candidate evidence withdrawn or superseded; moved to terminal Deprecated stage. */
  DEPRECATED:          'DEPRECATED',
});

const VALID_DECISION_TYPES = new Set(Object.values(DECISION_TYPES));

export class InvalidDecisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}

/**
 * A single immutable decision entry.
 * Constructed by DecisionAuditLog.append() — do not construct directly.
 */
export class DecisionAuditEntry {
  /** @type {string} ID of the candidate this decision concerns. */
  candidateId;
  /** @type {string} One of DECISION_TYPES values. */
  decisionType;
  /** @type {string} Human-readable rationale for this decision. */
  reason;
  /** @type {number} Unix epoch milliseconds when the decision was made. */
  timestamp;
  /**
   * @type {string}
   * Identity of the actor making the decision:
   *   'system'  — automated pipeline decision
   *   'researcher:<id>' — human researcher decision (requires Scientific Oversight context)
   *   'orchestrator:<name>' — orchestrator module decision
   */
  actor;
  /** @type {Readonly<Object>} Type-specific metadata (round number, p-value, effect size, etc.). */
  metadata;

  constructor({ candidateId, decisionType, reason, timestamp, actor, metadata }) {
    this.candidateId  = candidateId;
    this.decisionType = decisionType;
    this.reason       = reason;
    this.timestamp    = timestamp;
    this.actor        = actor;
    this.metadata     = Object.freeze(metadata ? { ...metadata } : {});
    Object.freeze(this);
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      candidateId:  this.candidateId,
      decisionType: this.decisionType,
      reason:       this.reason,
      timestamp:    this.timestamp,
      actor:        this.actor,
      metadata:     this.metadata,
    };
  }
}

/**
 * Append-only audit log of candidate decisions.
 * One instance is typically shared per campaign session and consulted when
 * building a candidate's decisionAuditTrail snapshot for serialization.
 *
 * Phase A: in-memory. Phase B: wired to a governance DB store.
 */
export class DecisionAuditLog {
  /** @type {DecisionAuditEntry[]} */
  #entries = [];

  /**
   * Appends a new decision entry to the log.
   * O(1).
   *
   * @param {object} entry
   * @param {string} entry.candidateId  - Required non-empty string.
   * @param {string} entry.decisionType - One of DECISION_TYPES.
   * @param {string} entry.reason       - Required non-empty string.
   * @param {number} [entry.timestamp]  - Unix epoch ms; defaults to Date.now().
   * @param {string} [entry.actor]      - Defaults to 'system'.
   * @param {object} [entry.metadata]   - Type-specific metadata.
   * @returns {DecisionAuditEntry} The newly appended entry.
   */
  append({ candidateId, decisionType, reason, timestamp, actor, metadata } = {}) {
    const errors = [];
    if (!candidateId || typeof candidateId !== 'string')
      errors.push('candidateId: required non-empty string');
    if (!VALID_DECISION_TYPES.has(decisionType))
      errors.push(`decisionType: "${decisionType}" is not a recognised DECISION_TYPE. Valid: ${[...VALID_DECISION_TYPES].join(', ')}`);
    if (!reason || typeof reason !== 'string')
      errors.push('reason: required non-empty string');
    if (errors.length) throw new InvalidDecisionError(errors.join('; '));

    const entry = new DecisionAuditEntry({
      candidateId,
      decisionType,
      reason,
      timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
      actor: actor || 'system',
      metadata: metadata || {},
    });
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Returns all decision entries for a given candidate ID, in insertion order.
   * O(n) in total log length.
   *
   * @param {string} candidateId
   * @returns {DecisionAuditEntry[]}
   */
  forCandidate(candidateId) {
    return this.#entries.filter(e => e.candidateId === candidateId);
  }

  /**
   * Returns a copy of the full log as plain objects, suitable for serialization.
   * O(n).
   * @returns {object[]}
   */
  toArray() {
    return this.#entries.map(e => e.toJSON());
  }

  /** @returns {number} Total number of entries across all candidates. */
  get size() {
    return this.#entries.length;
  }
}
