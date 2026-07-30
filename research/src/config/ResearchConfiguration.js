/**
 * research/src/config/ResearchConfiguration.js
 *
 * Purpose:
 *   Immutable configuration record governing one Phase 11 research campaign.
 *   Every Candidate, SAP, and ResearchFreeze produced during a campaign carries
 *   a reference to the ResearchConfiguration active at the time — this is the
 *   first link in the provenance chain that ReproducibilityGate verifies before
 *   publication.
 *
 * Scientific rationale:
 *   Reproducibility requires that every computational decision in a research
 *   campaign (which grammar was used to generate candidates, which feature
 *   ontology governed their classification, which proxy versions were in effect)
 *   is tied to an immutable, hash-verified configuration snapshot.
 *   ResearchConfiguration is the authoritative record of those decisions.
 *
 *   maxLookahead is hard-wired to 0: any look-ahead > 0 constitutes data leakage
 *   because the candidate would exploit future price information to classify the
 *   present, invalidating every statistical test performed on it. This is enforced
 *   at construction time rather than left to the CausalLeakageValidator (Phase B)
 *   so that the constraint is visible at the earliest possible stage.
 *
 * Dependencies: core/sha256.js, config/VersionSchema.js.
 * Public API: ResearchConfiguration, InvalidResearchConfigurationError.
 * Complexity: O(1) construction; O(n) hash (constant in practice for realistic configs).
 * Threading: async factory (SHA-256 hash computation).
 */

import { sha256Canonical } from '../core/sha256.js';
import { isValidVersion, PHASE11_SCHEMA_VERSION } from './VersionSchema.js';

export class InvalidResearchConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidResearchConfigurationError';
  }
}

export class ResearchConfiguration {
  /** @type {string} Unique identifier for this configuration instance. */
  id;
  /** @type {string} Human-readable campaign name. */
  name;
  /** @type {string} Description of the campaign's scientific goal. */
  description;
  /** @type {string} Candidate grammar version (MAJOR.MINOR.PATCH). */
  grammarVersion;
  /** @type {string} Feature ontology version. */
  ontologyVersion;
  /** @type {string} Candidate generator algorithm version. */
  generatorVersion;
  /**
   * @type {Readonly<Object.<string,string>>}
   * Map of proxy name → version for every proxy used in this campaign.
   * Captured at campaign start; any change produces a new configuration.
   */
  proxyVersions;
  /**
   * @type {0}
   * Maximum look-ahead (candles beyond the qualifying event) any Candidate in
   * this campaign may use. Hard-wired to 0: Phase 11 candidates are strictly
   * causal. CausalLeakageValidator (Phase B) enforces this per-candidate;
   * this field records the campaign-level policy.
   */
  maxLookahead;
  /** @type {string} Phase 11 schema version. */
  version;
  /** @type {number} Unix epoch milliseconds of creation. */
  createdAt;
  /**
   * @type {string}
   * SHA-256 hex of the canonical JSON of all identity-bearing fields
   * (grammarVersion, ontologyVersion, generatorVersion, proxyVersions,
   * maxLookahead). ReproducibilityGate compares this against the freeze's
   * stored configHash to certify the configuration has not changed.
   */
  configHash;

  /** @private — use the async factory ResearchConfiguration.create(). */
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.proxyVersions);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates params, computes configHash, returns a frozen instance.
   *
   * @param {object} params
   * @param {string}  params.id              - Unique identifier (caller-supplied UUID or similar).
   * @param {string}  params.name            - Human-readable campaign name.
   * @param {string}  params.description     - Scientific goal description.
   * @param {string}  params.grammarVersion  - MAJOR.MINOR.PATCH grammar version.
   * @param {string}  params.ontologyVersion - MAJOR.MINOR.PATCH ontology version.
   * @param {string}  params.generatorVersion- MAJOR.MINOR.PATCH generator version.
   * @param {Object}  [params.proxyVersions={}] - Map of proxy name → version string.
   * @param {0}       [params.maxLookahead=0]   - Must be 0 (Phase 11 causal constraint).
   * @param {number}  [params.createdAt]        - Unix epoch ms; defaults to Date.now().
   * @returns {Promise<ResearchConfiguration>}
   */
  static async create({
    id,
    name,
    description,
    grammarVersion,
    ontologyVersion,
    generatorVersion,
    proxyVersions = {},
    maxLookahead = 0,
    createdAt = Date.now(),
  } = {}) {
    const errors = [];
    if (!id || typeof id !== 'string') errors.push('id: required non-empty string');
    if (!name || typeof name !== 'string') errors.push('name: required non-empty string');
    if (!description || typeof description !== 'string') errors.push('description: required non-empty string');
    if (!isValidVersion(grammarVersion))
      errors.push(`grammarVersion: "${grammarVersion}" is not a valid MAJOR.MINOR.PATCH version`);
    if (!isValidVersion(ontologyVersion))
      errors.push(`ontologyVersion: "${ontologyVersion}" is not a valid MAJOR.MINOR.PATCH version`);
    if (!isValidVersion(generatorVersion))
      errors.push(`generatorVersion: "${generatorVersion}" is not a valid MAJOR.MINOR.PATCH version`);
    if (proxyVersions === null || typeof proxyVersions !== 'object' || Array.isArray(proxyVersions))
      errors.push('proxyVersions: required plain object (may be empty)');
    if (maxLookahead !== 0)
      errors.push('maxLookahead: must be 0 — Phase 11 enforces strict causality; any look-ahead > 0 constitutes data leakage');
    if (errors.length) throw new InvalidResearchConfigurationError(errors.join('; '));

    // Hash covers only the fields that determine whether two configurations
    // produce identical experimental conditions — name/description are
    // metadata and do not affect experimental outcomes.
    const identityFields = {
      grammarVersion,
      ontologyVersion,
      generatorVersion,
      proxyVersions: { ...proxyVersions },
      maxLookahead,
    };
    const configHash = await sha256Canonical(identityFields);

    return new ResearchConfiguration({
      id, name, description,
      grammarVersion, ontologyVersion, generatorVersion,
      proxyVersions: { ...proxyVersions },
      maxLookahead,
      version: PHASE11_SCHEMA_VERSION,
      createdAt,
      configHash,
    });
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      grammarVersion: this.grammarVersion,
      ontologyVersion: this.ontologyVersion,
      generatorVersion: this.generatorVersion,
      proxyVersions: { ...this.proxyVersions },
      maxLookahead: this.maxLookahead,
      version: this.version,
      createdAt: this.createdAt,
      configHash: this.configHash,
    };
  }
}
