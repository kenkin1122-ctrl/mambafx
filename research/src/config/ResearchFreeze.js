/**
 * research/src/config/ResearchFreeze.js
 *
 * Purpose:
 *   Write-once, content-addressed snapshot of the full research state at a
 *   decision point. A ResearchFreeze locks the exact configuration, ontology
 *   version, generator version, proxy versions, candidate fingerprints, and
 *   dataset snapshot that were in effect when a discovery decision was made.
 *   ReproducibilityGate uses the freeze to certify that publication-time
 *   conditions are identical to discovery-time conditions.
 *
 * Scientific rationale:
 *   The winner's curse and selective reporting require that discoveries be
 *   evaluated against exactly the same conditions that produced them. A freeze
 *   makes the entire computational environment tamper-evident: any change to
 *   any field produces a different SHA-256 hash and therefore a different record,
 *   making retroactive modification detectable.
 *
 * Storage resolution (UNKNOWN #2 resolution):
 *   Content-addressed record in the existing 'Decisions' store (mfx_msd_experiments
 *   v2 database). No DB version bump required. The record's `id` IS its content
 *   address (SHA-256 of identity fields). A second freeze() call with the same
 *   content is idempotent — the writeOnce adapter returns the existing record.
 *   The `discoveryResultId` sentinel '_research_freeze:<researchConfigurationId>'
 *   distinguishes freeze records from regular decision records within the store.
 *
 * Dependencies: core/sha256.js, config/VersionSchema.js.
 * Public API: ResearchFreeze, InvalidResearchFreezeError.
 * Complexity: O(k) in candidate fingerprint array size for identity field
 *   construction (sort); O(n) for hash in serialized length.
 * Threading: async factory (SHA-256 hash computation).
 */

import { sha256Canonical } from '../core/sha256.js';
import { PHASE11_SCHEMA_VERSION } from './VersionSchema.js';

export class InvalidResearchFreezeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidResearchFreezeError';
  }
}

export class ResearchFreeze {
  /**
   * @type {string}
   * SHA-256 hex of the canonical identity fields. This IS the content address:
   * two freezes with the same id are provably identical.
   */
  id;
  /** @type {string} ID of the ResearchConfiguration that was active at freeze time. */
  researchConfigurationId;
  /** @type {string} SHA-256 configHash from the ResearchConfiguration. */
  configHash;
  /** @type {string} Feature ontology version at freeze time. */
  ontologyVersion;
  /** @type {string} Candidate generator version at freeze time. */
  generatorVersion;
  /** @type {Readonly<Object.<string,string>>} Proxy versions at freeze time. */
  proxyVersions;
  /**
   * @type {ReadonlyArray<string>}
   * SHA-256 fingerprints of every Candidate covered by this freeze, sorted
   * deterministically. ReproducibilityGate verifies that a publishing candidate's
   * fingerprint is present here.
   */
  candidateFingerprints;
  /** @type {string|null} Hash of the dataset snapshot at freeze time (null if not yet snapshotted). */
  datasetSnapshotId;
  /**
   * @type {string}
   * SHA-256 of the full ResearchConfiguration record's canonical JSON.
   * Redundant with configHash but explicit: configHash covers only identity
   * fields; this covers the entire configuration record.
   */
  researchConfigurationHash;
  /** @type {number} Unix epoch milliseconds when this freeze was created. */
  frozenAt;
  /** @type {string} Phase 11 schema version. */
  version;

  /** @private — use the async factory ResearchFreeze.create(). */
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.proxyVersions);
    Object.freeze(this.candidateFingerprints);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates, computes SHA-256 content address, returns frozen instance.
   *
   * Identity fields (those that determine whether two freezes are "the same"):
   *   researchConfigurationId, configHash, ontologyVersion, generatorVersion,
   *   proxyVersions, candidateFingerprints (sorted), researchConfigurationHash.
   * Non-identity: datasetSnapshotId (null at creation; filled post-snapshot),
   *   frozenAt (same logical freeze may be re-created after a restart).
   *
   * @param {object}   params
   * @param {string}   params.researchConfigurationId  - Active configuration's ID.
   * @param {string}   params.configHash               - From ResearchConfiguration.configHash.
   * @param {string}   params.ontologyVersion          - Active ontology version.
   * @param {string}   params.generatorVersion         - Active generator version.
   * @param {Object}   [params.proxyVersions={}]       - Active proxy versions.
   * @param {string[]} [params.candidateFingerprints=[]]- Candidate fingerprints to lock.
   * @param {string|null} [params.datasetSnapshotId=null]- Dataset snapshot hash (if available).
   * @param {string}   params.researchConfigurationHash - SHA-256 of full config record.
   * @param {number}   [params.frozenAt]               - Unix epoch ms; defaults to Date.now().
   * @param {string}   [params.version]                - Schema version; defaults to current.
   * @returns {Promise<ResearchFreeze>}
   */
  static async create({
    researchConfigurationId,
    configHash,
    ontologyVersion,
    generatorVersion,
    proxyVersions = {},
    candidateFingerprints = [],
    datasetSnapshotId = null,
    researchConfigurationHash,
    frozenAt = Date.now(),
    version = PHASE11_SCHEMA_VERSION,
  } = {}) {
    const errors = [];
    if (!researchConfigurationId || typeof researchConfigurationId !== 'string')
      errors.push('researchConfigurationId: required non-empty string');
    if (!configHash || typeof configHash !== 'string')
      errors.push('configHash: required string (SHA-256 hex from ResearchConfiguration.configHash)');
    if (!ontologyVersion || typeof ontologyVersion !== 'string')
      errors.push('ontologyVersion: required non-empty string');
    if (!generatorVersion || typeof generatorVersion !== 'string')
      errors.push('generatorVersion: required non-empty string');
    if (proxyVersions === null || typeof proxyVersions !== 'object' || Array.isArray(proxyVersions))
      errors.push('proxyVersions: required plain object (may be empty)');
    if (!Array.isArray(candidateFingerprints))
      errors.push('candidateFingerprints: required array (may be empty)');
    if (!researchConfigurationHash || typeof researchConfigurationHash !== 'string')
      errors.push('researchConfigurationHash: required string (SHA-256 of full ResearchConfiguration JSON)');
    if (errors.length) throw new InvalidResearchFreezeError(errors.join('; '));

    // Sort fingerprints for determinism: the order candidates were added
    // should not affect whether two freezes are considered identical.
    const sortedFingerprints = [...candidateFingerprints].sort();

    const identityFields = {
      researchConfigurationId,
      configHash,
      ontologyVersion,
      generatorVersion,
      proxyVersions: { ...proxyVersions },
      candidateFingerprints: sortedFingerprints,
      researchConfigurationHash,
    };
    const id = await sha256Canonical(identityFields);

    return new ResearchFreeze({
      id,
      researchConfigurationId,
      configHash,
      ontologyVersion,
      generatorVersion,
      proxyVersions: { ...proxyVersions },
      candidateFingerprints: sortedFingerprints,
      datasetSnapshotId,
      researchConfigurationHash,
      frozenAt,
      version,
    });
  }

  /**
   * Persists this freeze to the Decisions store using a write-once adapter.
   * The `id` field (content address) acts as the primary key, guaranteeing
   * that a second persist() call with the same freeze is a safe no-op.
   *
   * The sentinel `discoveryResultId = '_research_freeze:<researchConfigurationId>'`
   * distinguishes freeze records from regular decision records in the store.
   *
   * @param {{ write: (record: object) => Promise<*> }} decisionsAdapter
   *   A write-once adapter opened on the 'Decisions' store. Must expose write().
   * @returns {Promise<ResearchFreeze>} this (for chaining)
   */
  async persist(decisionsAdapter) {
    if (!decisionsAdapter || typeof decisionsAdapter.write !== 'function') {
      throw new InvalidResearchFreezeError(
        'persist: decisionsAdapter must expose a write(record) method (use a writeOnceAdapter on the Decisions store)'
      );
    }
    await decisionsAdapter.write({
      id: this.id,
      discoveryResultId: `_research_freeze:${this.researchConfigurationId}`,
      decisionInputHash: this.id,
      decisionType: 'ResearchFreeze',
      payload: this.toJSON(),
      createdAt: this.frozenAt,
    });
    return this;
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      id: this.id,
      researchConfigurationId: this.researchConfigurationId,
      configHash: this.configHash,
      ontologyVersion: this.ontologyVersion,
      generatorVersion: this.generatorVersion,
      proxyVersions: { ...this.proxyVersions },
      candidateFingerprints: [...this.candidateFingerprints],
      datasetSnapshotId: this.datasetSnapshotId,
      researchConfigurationHash: this.researchConfigurationHash,
      frozenAt: this.frozenAt,
      version: this.version,
    };
  }
}
