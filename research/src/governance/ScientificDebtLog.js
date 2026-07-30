/**
 * research/src/governance/ScientificDebtLog.js
 *
 * Purpose:
 *   Tracks scientific debt items — known methodological limitations,
 *   missing validations, or deferred quality improvements — associated
 *   with Phase 11 research candidates and campaigns.
 *
 * Scientific rationale:
 *   "Scientific debt" (analogous to technical debt in software engineering)
 *   is the accumulation of methodological shortcuts, unresolved assumptions,
 *   and deferred validation steps that reduce the scientific integrity of a
 *   research finding. Making these items explicit and tracked (rather than
 *   tacit knowledge in a researcher's head) is a pre-condition for the
 *   meta-science auditing that Part 14 of Volume IV v3.0 requires.
 *
 *   Examples of scientific debt:
 *   - A hypothesis that has been in Confirmed status for > 30 days without
 *     replication (STALE_HYPOTHESIS).
 *   - A published finding whose implementation maturity is still Experimental
 *     (IMPLEMENTATION_GAP).
 *   - A feature that may theoretically introduce look-ahead but hasn't been
 *     formally audited by CausalLeakageValidator (CAUSAL_LEAKAGE_RISK).
 *
 * Phase A scope: pure in-memory implementation. IndexedDB backing is Phase B.
 *
 * Dependencies: none.
 * Public API: DEBT_TYPE, DEBT_STATUS, DEBT_PRIORITY, ScientificDebtItem,
 *   ScientificDebtLog, InvalidDebtError.
 * Complexity: create O(1); resolve O(log n) with sorted structures (here O(n)
 *   with Map lookup); listOpen O(n). All n values are bounded by campaign size.
 */

/** Recognised categories of scientific debt. */
export const DEBT_TYPE = Object.freeze({
  /** Hypothesis stuck in a lifecycle stage past SCIENTIFIC_DEBT_MAX_DWELL_MS. */
  STALE_HYPOTHESIS:        'STALE_HYPOTHESIS',
  /** Discovery without a completed replication block set. */
  MISSING_REPLICATION:     'MISSING_REPLICATION',
  /** Statistical test run with insufficient power (< TARGET_POWER). */
  UNDERPOWERED_STUDY:      'UNDERPOWERED_STUDY',
  /** Feature or context condition with potential look-ahead that hasn't been audited. */
  CAUSAL_LEAKAGE_RISK:     'CAUSAL_LEAKAGE_RISK',
  /** Required diagnostic (from SAP.requiredDiagnostics) not yet run. */
  MISSING_DIAGNOSTIC:      'MISSING_DIAGNOSTIC',
  /** Candidate has scientific evidence but no implemented computation. */
  IMPLEMENTATION_GAP:      'IMPLEMENTATION_GAP',
  /** Published finding not yet independently validated (reproducibilityLevel < 5). */
  VALIDATION_DEBT:         'VALIDATION_DEBT',
  /** Candidate uses a proxy whose version has changed since the discovery freeze. */
  PROXY_VERSION_DRIFT:     'PROXY_VERSION_DRIFT',
});

/** Lifecycle status of a scientific debt item. */
export const DEBT_STATUS = Object.freeze({
  /** Identified but not yet being addressed. */
  OPEN:        'OPEN',
  /** Actively being worked on. */
  IN_PROGRESS: 'IN_PROGRESS',
  /** Fully resolved; resolution rationale recorded. */
  RESOLVED:    'RESOLVED',
  /** Intentionally not addressed; dismissal rationale recorded. */
  DISMISSED:   'DISMISSED',
  /** Not urgent; flagged for future attention. */
  MONITORING:  'MONITORING',
});

/** Priority levels for scientific debt items. */
export const DEBT_PRIORITY = Object.freeze({
  /** Blocks publication or scientific integrity; must be resolved immediately. */
  CRITICAL: 'CRITICAL',
  /** Should be addressed before the next discovery cycle. */
  HIGH:     'HIGH',
  /** Address in the current research phase. */
  MEDIUM:   'MEDIUM',
  /** Address eventually; not blocking any current action. */
  LOW:      'LOW',
});

const VALID_TYPES      = new Set(Object.values(DEBT_TYPE));
const VALID_STATUSES   = new Set(Object.values(DEBT_STATUS));
const VALID_PRIORITIES = new Set(Object.values(DEBT_PRIORITY));

export class InvalidDebtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDebtError';
  }
}

/**
 * A single scientific debt item record.
 */
export class ScientificDebtItem {
  /** @type {string} Unique identifier for this debt item. */
  id;
  /** @type {string} One of DEBT_TYPE values. */
  type;
  /** @type {string} Human-readable description of the debt. */
  description;
  /** @type {string} One of DEBT_PRIORITY values. */
  priority;
  /** @type {number} Unix epoch milliseconds when this debt item was created. */
  dateCreated;
  /**
   * @type {string|null}
   * Who is responsible for resolving this debt item.
   * 'system' for automatically detected debt; researcher ID or team name otherwise.
   */
  assignedTo;
  /** @type {string} One of DEBT_STATUS values. */
  status;
  /** @type {string|null} Resolution rationale (null while open/in-progress). */
  resolution;
  /** @type {number|null} Unix epoch milliseconds of resolution (null while open). */
  resolutionDate;
  /** @type {Readonly<Object>} Type-specific metadata (candidateId, sapId, etc.). */
  metadata;

  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.metadata);
    Object.freeze(this);
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      id: this.id, type: this.type, description: this.description,
      priority: this.priority, dateCreated: this.dateCreated,
      assignedTo: this.assignedTo, status: this.status,
      resolution: this.resolution, resolutionDate: this.resolutionDate,
      metadata: { ...this.metadata },
    };
  }
}

/**
 * Scientific debt log — tracks open and resolved debt items for a campaign.
 * Phase A: in-memory. Phase B: wired to a governance DB store.
 */
export class ScientificDebtLog {
  /** @type {Map<string, ScientificDebtItem>} */
  #items = new Map();

  /**
   * Creates and registers a new scientific debt item.
   * O(1).
   *
   * @param {object} params
   * @param {string} params.id            - Unique identifier (caller-supplied).
   * @param {string} params.type          - One of DEBT_TYPE values.
   * @param {string} params.description   - Description of the debt.
   * @param {string} params.priority      - One of DEBT_PRIORITY values.
   * @param {string|null} [params.assignedTo=null] - Responsible party.
   * @param {number} [params.dateCreated] - Unix epoch ms; defaults to Date.now().
   * @param {object} [params.metadata={}] - Type-specific metadata.
   * @returns {ScientificDebtItem} The newly created item.
   */
  create({ id, type, description, priority, assignedTo = null, dateCreated = Date.now(), metadata = {} } = {}) {
    const errors = [];
    if (!id || typeof id !== 'string') errors.push('id: required non-empty string');
    if (!VALID_TYPES.has(type)) errors.push(`type: "${type}" is not a recognised DEBT_TYPE`);
    if (!description || typeof description !== 'string') errors.push('description: required non-empty string');
    if (!VALID_PRIORITIES.has(priority)) errors.push(`priority: "${priority}" is not a recognised DEBT_PRIORITY`);
    if (errors.length) throw new InvalidDebtError(errors.join('; '));
    if (this.#items.has(id)) throw new InvalidDebtError(`debt item "${id}" already exists`);

    const item = new ScientificDebtItem({
      id, type, description, priority, dateCreated,
      assignedTo, status: DEBT_STATUS.OPEN,
      resolution: null, resolutionDate: null,
      metadata,
    });
    this.#items.set(id, item);
    return item;
  }

  /**
   * Updates the status of a debt item. For RESOLVED/DISMISSED, resolution is required.
   * O(1).
   *
   * @param {string} id       - The debt item ID.
   * @param {string} status   - The new status (one of DEBT_STATUS values).
   * @param {object} [options]
   * @param {string|null} [options.resolution=null]    - Required for RESOLVED/DISMISSED.
   * @param {number|null} [options.resolutionDate=null]- Unix epoch ms; defaults to now for terminal states.
   * @param {string|null} [options.assignedTo=null]    - Update assignee if needed.
   * @returns {ScientificDebtItem} The updated item (new immutable instance).
   */
  updateStatus(id, status, { resolution = null, resolutionDate = null, assignedTo } = {}) {
    const existing = this.#items.get(id);
    if (!existing) throw new InvalidDebtError(`debt item "${id}" not found`);
    if (!VALID_STATUSES.has(status)) throw new InvalidDebtError(`status: "${status}" is not a recognised DEBT_STATUS`);
    const terminalStatuses = new Set([DEBT_STATUS.RESOLVED, DEBT_STATUS.DISMISSED]);
    if (terminalStatuses.has(status) && !resolution)
      throw new InvalidDebtError(`resolution rationale is required when status is ${status}`);

    const updated = new ScientificDebtItem({
      ...existing,
      status,
      resolution: resolution ?? existing.resolution,
      resolutionDate: resolutionDate ?? (terminalStatuses.has(status) ? Date.now() : existing.resolutionDate),
      assignedTo: assignedTo !== undefined ? assignedTo : existing.assignedTo,
    });
    this.#items.set(id, updated);
    return updated;
  }

  /**
   * Returns all open (non-terminal) debt items, sorted by priority (CRITICAL first).
   * O(n log n) in the number of debt items.
   * @returns {ScientificDebtItem[]}
   */
  listOpen() {
    const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const terminalStatuses = new Set([DEBT_STATUS.RESOLVED, DEBT_STATUS.DISMISSED]);
    return [...this.#items.values()]
      .filter(item => !terminalStatuses.has(item.status))
      .sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));
  }

  /**
   * Returns a debt item by ID, or undefined if not found. O(1).
   * @param {string} id
   * @returns {ScientificDebtItem|undefined}
   */
  get(id) {
    return this.#items.get(id);
  }

  /** @returns {number} Total number of debt items (open + resolved). */
  get size() {
    return this.#items.size;
  }

  /**
   * Returns all debt items as plain objects.
   * O(n).
   * @returns {object[]}
   */
  toArray() {
    return [...this.#items.values()].map(i => i.toJSON());
  }
}
