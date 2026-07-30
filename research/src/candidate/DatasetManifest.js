/**
 * research/src/candidate/DatasetManifest.js
 *
 * Purpose:
 *   Immutable dataset identification record for Phase 11 research campaigns.
 *   A DatasetManifest captures everything needed to exactly reproduce the
 *   dataset used in a campaign: which sessions were included/excluded, how
 *   missing intervals were handled, how duplicates were resolved, and summary
 *   quality metrics.
 *
 * Scientific rationale:
 *   Dataset construction choices are as scientifically significant as modelling
 *   choices. Excluding a session, filling a gap, or treating a duplicate
 *   differently can materially change the distribution of outcomes and therefore
 *   the significance of any test. Pre-committing the dataset construction policy
 *   (before data is examined) and hash-locking the result is necessary for the
 *   same reasons pre-registration of analysis plans is necessary.
 *
 * Fields (per Phase 11 directive):
 *   datasetId, datasetHash, creationTimestamp, sessionIds,
 *   excludedSessions, missingIntervals, duplicatePolicy, repairPolicy,
 *   qualityMetrics
 *
 * Dependencies: core/sha256.js.
 * Public API: DatasetManifest, InvalidDatasetManifestError.
 * Complexity: O(s) construction where s = number of sessions;
 *   O(n) hash in serialized manifest length.
 * Threading: async factory (SHA-256 hash computation).
 */

import { sha256Canonical } from '../core/sha256.js';

export class InvalidDatasetManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDatasetManifestError';
  }
}

/** Valid policies for handling duplicate records in the raw data stream. */
export const DUPLICATE_POLICIES = Object.freeze({
  /** Keep the first occurrence; discard subsequent duplicates of the same key. */
  KEEP_FIRST: 'keep_first',
  /** Keep the last occurrence; overwrite earlier duplicates. */
  KEEP_LAST: 'keep_last',
  /** Raise an error on any duplicate — most conservative. */
  REJECT: 'reject',
  /** Average numeric fields across duplicates. */
  AVERAGE: 'average',
});

/** Valid policies for repairing missing intervals in tick/candle data. */
export const REPAIR_POLICIES = Object.freeze({
  /** Forward-fill from the last valid observation. */
  FORWARD_FILL: 'forward_fill',
  /** Linear interpolation between surrounding valid observations. */
  INTERPOLATE: 'interpolate',
  /** Mark gap as missing; exclude any candidate that would span it. */
  EXCLUDE_SPANNING: 'exclude_spanning',
  /** Drop the entire session containing the gap. */
  DROP_SESSION: 'drop_session',
  /** Leave gap as-is (NaN/null); individual features handle it. */
  NONE: 'none',
});

export class DatasetManifest {
  /** @type {string} Unique identifier for this dataset instance. */
  datasetId;
  /**
   * @type {string}
   * SHA-256 hex of the canonical JSON of all identity-bearing fields
   * (sessionIds, excludedSessions, missingIntervals, duplicatePolicy, repairPolicy).
   * Same content ↔ same hash — enables ReproducibilityGate to verify dataset identity.
   */
  datasetHash;
  /** @type {number} Unix epoch milliseconds when this manifest was created. */
  creationTimestamp;
  /**
   * @type {ReadonlyArray<string>}
   * Sorted list of session IDs included in this dataset.
   * Sorted for determinism: insertion order does not affect dataset identity.
   */
  sessionIds;
  /**
   * @type {ReadonlyArray<string>}
   * Session IDs explicitly excluded from this dataset (e.g., sessions known to
   * contain data quality issues). Recorded separately from sessionIds so an audit
   * can verify that exclusions are intentional and pre-committed.
   */
  excludedSessions;
  /**
   * @type {ReadonlyArray<{ sessionId: string, startEpoch: number, endEpoch: number, reason: string }>}
   * Intervals with missing tick/candle data and the reason for each gap.
   */
  missingIntervals;
  /**
   * @type {string}
   * Policy for handling duplicate records (one of DUPLICATE_POLICIES values).
   * Pre-committed before data is examined.
   */
  duplicatePolicy;
  /**
   * @type {string}
   * Policy for repairing missing intervals (one of REPAIR_POLICIES values).
   * Pre-committed before data is examined.
   */
  repairPolicy;
  /**
   * @type {Readonly<Object>}
   * Summary quality metrics computed after dataset construction:
   * { totalTicks, totalCandles, missingIntervalCount, duplicatesResolved,
   *   coverageRatio, qualityScore, ... }
   */
  qualityMetrics;

  /** @private — use the async factory DatasetManifest.create(). */
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.sessionIds);
    Object.freeze(this.excludedSessions);
    Object.freeze(this.missingIntervals);
    Object.freeze(this.qualityMetrics);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates params, computes datasetHash, returns a frozen instance.
   *
   * @param {object}   params
   * @param {string}   params.datasetId          - Unique dataset identifier.
   * @param {string[]} params.sessionIds          - Included session IDs.
   * @param {string[]} [params.excludedSessions=[]] - Explicitly excluded session IDs.
   * @param {object[]} [params.missingIntervals=[]] - Missing interval descriptors.
   * @param {string}   params.duplicatePolicy    - One of DUPLICATE_POLICIES.
   * @param {string}   params.repairPolicy       - One of REPAIR_POLICIES.
   * @param {object}   [params.qualityMetrics={}] - Post-construction quality metrics.
   * @param {number}   [params.creationTimestamp] - Unix epoch ms; defaults to Date.now().
   * @returns {Promise<DatasetManifest>}
   */
  static async create({
    datasetId,
    sessionIds,
    excludedSessions = [],
    missingIntervals = [],
    duplicatePolicy,
    repairPolicy,
    qualityMetrics = {},
    creationTimestamp = Date.now(),
  } = {}) {
    const errors = [];
    if (!datasetId || typeof datasetId !== 'string')
      errors.push('datasetId: required non-empty string');
    if (!Array.isArray(sessionIds) || sessionIds.length === 0)
      errors.push('sessionIds: required non-empty array of session ID strings');
    if (!Array.isArray(excludedSessions))
      errors.push('excludedSessions: required array (may be empty)');
    if (!Array.isArray(missingIntervals))
      errors.push('missingIntervals: required array (may be empty)');
    if (!Object.values(DUPLICATE_POLICIES).includes(duplicatePolicy))
      errors.push(`duplicatePolicy: must be one of [${Object.values(DUPLICATE_POLICIES).join(', ')}]`);
    if (!Object.values(REPAIR_POLICIES).includes(repairPolicy))
      errors.push(`repairPolicy: must be one of [${Object.values(REPAIR_POLICIES).join(', ')}]`);
    if (errors.length) throw new InvalidDatasetManifestError(errors.join('; '));

    const sortedSessionIds = [...sessionIds].sort();
    const sortedExcluded = [...excludedSessions].sort();

    // Check for sessions appearing in both lists — that is always an error.
    const excludedSet = new Set(sortedExcluded);
    const overlap = sortedSessionIds.filter(id => excludedSet.has(id));
    if (overlap.length > 0) {
      throw new InvalidDatasetManifestError(
        `sessions appear in both sessionIds and excludedSessions: ${overlap.join(', ')}`
      );
    }

    const identityFields = {
      sessionIds: sortedSessionIds,
      excludedSessions: sortedExcluded,
      missingIntervals,
      duplicatePolicy,
      repairPolicy,
    };
    const datasetHash = await sha256Canonical(identityFields);

    return new DatasetManifest({
      datasetId,
      datasetHash,
      creationTimestamp,
      sessionIds: sortedSessionIds,
      excludedSessions: sortedExcluded,
      missingIntervals: Object.freeze([...missingIntervals]),
      duplicatePolicy,
      repairPolicy,
      qualityMetrics: { ...qualityMetrics },
    });
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      datasetId: this.datasetId,
      datasetHash: this.datasetHash,
      creationTimestamp: this.creationTimestamp,
      sessionIds: [...this.sessionIds],
      excludedSessions: [...this.excludedSessions],
      missingIntervals: [...this.missingIntervals],
      duplicatePolicy: this.duplicatePolicy,
      repairPolicy: this.repairPolicy,
      qualityMetrics: { ...this.qualityMetrics },
    };
  }
}
