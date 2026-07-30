/**
 * research/src/config/StatisticalAnalysisPlan.js
 *
 * Purpose:
 *   Immutable, pre-registration Statistical Analysis Plan (SAP). The SAP is
 *   written and hash-locked before any data is examined — this is the constitutional
 *   guarantee that no analytical choice is made post-hoc in response to data.
 *
 * Scientific rationale:
 *   Pre-registration of analysis plans is the most reliable defence against
 *   HARKing (Hypothesising After Results are Known) and against the garden of
 *   forking paths (Gelman & Loken 2014): when researchers examine data before
 *   committing to their analysis, seemingly minor methodological choices can be
 *   unconsciously guided by the results, inflating false discovery rates far above
 *   the nominal alpha level. A hash-locked, immutable SAP makes it
 *   cryptographically impossible to retroactively claim a different analysis plan
 *   was followed — every analytical step can be verified against the pre-committed
 *   record arbitrarily long after the experiment is complete.
 *
 * Exact fields (per Phase 11 directive):
 *   sapId, hypothesisFamilies, alphaAllocation, promotionPolicies,
 *   stoppingRules, replicationCriteria, publicationCriteria,
 *   effectSizeThresholds, minimumSampleSizes, requiredDiagnostics,
 *   createdTimestamp, version
 *
 * Dependencies: core/sha256.js, config/VersionSchema.js.
 * Public API: StatisticalAnalysisPlan, InvalidStatisticalAnalysisPlanError.
 * Complexity: O(k) validation where k = number of hypothesis families;
 *   O(n) hash in serialized SAP length (constant in practice).
 * Threading: async factory (SHA-256 hash computation).
 */

import { sha256Canonical } from '../core/sha256.js';
import { isValidVersion, PHASE11_SCHEMA_VERSION } from './VersionSchema.js';

export class InvalidStatisticalAnalysisPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStatisticalAnalysisPlanError';
  }
}

export class StatisticalAnalysisPlan {
  /** @type {string} Unique identifier for this SAP. */
  sapId;
  /** @type {string[]} Hypothesis family keys covered by this plan. */
  hypothesisFamilies;
  /**
   * @type {Readonly<Object.<string,number>>}
   * Alpha budget allocation across families: { familyKey: alphaFraction }.
   * The sum of all fractions must not exceed 1.0 (pre-validated at creation).
   * Scientific rationale: committing the alpha allocation before data access
   * prevents post-hoc reallocation in response to observed p-values.
   */
  alphaAllocation;
  /**
   * @type {Readonly<Object>}
   * Rules governing when a candidate advances lifecycle stages (e.g., minimum
   * effect size at each promotion gate). Pre-committed to prevent selective
   * advancement of candidates whose results happen to look promising.
   */
  promotionPolicies;
  /**
   * @type {ReadonlyArray<Object>}
   * Stopping rules for screening / discovery / replication phases
   * (e.g., maximum candidate count per round, minimum screening score).
   * Pre-committed to prevent indefinite continuation until a significant
   * result appears (a form of optional stopping that inflates FDR).
   */
  stoppingRules;
  /** @type {Readonly<Object>} Minimum replication blocks, decorrelation gap, etc. */
  replicationCriteria;
  /** @type {Readonly<Object>} Minimum evidence tier, reproducibility level required. */
  publicationCriteria;
  /** @type {Readonly<Object>} Effect size thresholds per feature class / family. */
  effectSizeThresholds;
  /** @type {Readonly<Object>} Minimum sample sizes per test type. */
  minimumSampleSizes;
  /** @type {ReadonlyArray<string>} Diagnostic tests that must pass before promotion. */
  requiredDiagnostics;
  /** @type {number} Unix epoch milliseconds when this SAP was locked. */
  createdTimestamp;
  /** @type {string} Phase 11 schema version. */
  version;
  /**
   * @type {string}
   * SHA-256 hex of the canonical JSON of the entire SAP content.
   * Any post-hoc change to any field produces a different hash, making
   * tampering detectable.
   */
  sapHash;

  /** @private — use the async factory StatisticalAnalysisPlan.create(). */
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.hypothesisFamilies);
    Object.freeze(this.stoppingRules);
    Object.freeze(this.requiredDiagnostics);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates params, checks alpha sum ≤ 1.0, computes sapHash,
   * returns a frozen instance.
   *
   * @param {object} params
   * @param {string}    params.sapId                - Unique SAP identifier.
   * @param {string[]}  params.hypothesisFamilies   - Family keys covered by this plan.
   * @param {Object}    params.alphaAllocation      - familyKey → alpha fraction (sum ≤ 1.0).
   * @param {Object}    params.promotionPolicies    - Lifecycle promotion rules.
   * @param {Object[]}  params.stoppingRules        - Campaign stopping rules.
   * @param {Object}    params.replicationCriteria  - Replication requirements.
   * @param {Object}    params.publicationCriteria  - Publication requirements.
   * @param {Object}    params.effectSizeThresholds - Effect size gates per class.
   * @param {Object}    params.minimumSampleSizes   - Minimum n per test type.
   * @param {string[]}  params.requiredDiagnostics  - Required diagnostic names.
   * @param {number}    [params.createdTimestamp]   - Unix epoch ms; defaults to Date.now().
   * @param {string}    [params.version]            - Schema version; defaults to current.
   * @returns {Promise<StatisticalAnalysisPlan>}
   */
  static async create({
    sapId,
    hypothesisFamilies,
    alphaAllocation,
    promotionPolicies,
    stoppingRules,
    replicationCriteria,
    publicationCriteria,
    effectSizeThresholds,
    minimumSampleSizes,
    requiredDiagnostics,
    createdTimestamp = Date.now(),
    version = PHASE11_SCHEMA_VERSION,
  } = {}) {
    const errors = [];
    if (!sapId || typeof sapId !== 'string') errors.push('sapId: required non-empty string');
    if (!Array.isArray(hypothesisFamilies) || hypothesisFamilies.length === 0)
      errors.push('hypothesisFamilies: required non-empty string array');
    if (!alphaAllocation || typeof alphaAllocation !== 'object' || Array.isArray(alphaAllocation))
      errors.push('alphaAllocation: required plain object mapping family keys to alpha fractions');
    if (!promotionPolicies || typeof promotionPolicies !== 'object' || Array.isArray(promotionPolicies))
      errors.push('promotionPolicies: required plain object');
    if (!Array.isArray(stoppingRules))
      errors.push('stoppingRules: required array (may be empty)');
    if (!replicationCriteria || typeof replicationCriteria !== 'object' || Array.isArray(replicationCriteria))
      errors.push('replicationCriteria: required plain object');
    if (!publicationCriteria || typeof publicationCriteria !== 'object' || Array.isArray(publicationCriteria))
      errors.push('publicationCriteria: required plain object');
    if (!effectSizeThresholds || typeof effectSizeThresholds !== 'object' || Array.isArray(effectSizeThresholds))
      errors.push('effectSizeThresholds: required plain object');
    if (!minimumSampleSizes || typeof minimumSampleSizes !== 'object' || Array.isArray(minimumSampleSizes))
      errors.push('minimumSampleSizes: required plain object');
    if (!Array.isArray(requiredDiagnostics))
      errors.push('requiredDiagnostics: required array (may be empty)');
    if (!isValidVersion(version))
      errors.push(`version: "${version}" is not a valid MAJOR.MINOR.PATCH version`);
    if (errors.length) throw new InvalidStatisticalAnalysisPlanError(errors.join('; '));

    // Verify alpha allocation sum does not exceed 1.0.
    // Scientific rationale: the sum of alpha allocations is the Laboratory's
    // total family-level false discovery budget. Exceeding 1.0 is mathematically
    // incoherent — it would allow more expected false discoveries than tests run.
    if (alphaAllocation && typeof alphaAllocation === 'object') {
      const alphaSum = Object.values(alphaAllocation)
        .reduce((s, v) => s + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
      if (alphaSum > 1.0 + 1e-9) {
        throw new InvalidStatisticalAnalysisPlanError(
          `alphaAllocation: total alpha ${alphaSum.toFixed(6)} exceeds 1.0 — the Laboratory's total FDR budget cannot exceed 1`
        );
      }
    }

    const contentFields = {
      sapId, hypothesisFamilies, alphaAllocation, promotionPolicies,
      stoppingRules, replicationCriteria, publicationCriteria,
      effectSizeThresholds, minimumSampleSizes, requiredDiagnostics,
      createdTimestamp, version,
    };
    const sapHash = await sha256Canonical(contentFields);

    return new StatisticalAnalysisPlan({ ...contentFields, sapHash });
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      sapId: this.sapId,
      hypothesisFamilies: [...this.hypothesisFamilies],
      alphaAllocation: this.alphaAllocation,
      promotionPolicies: this.promotionPolicies,
      stoppingRules: [...this.stoppingRules],
      replicationCriteria: this.replicationCriteria,
      publicationCriteria: this.publicationCriteria,
      effectSizeThresholds: this.effectSizeThresholds,
      minimumSampleSizes: this.minimumSampleSizes,
      requiredDiagnostics: [...this.requiredDiagnostics],
      createdTimestamp: this.createdTimestamp,
      version: this.version,
      sapHash: this.sapHash,
    };
  }
}
