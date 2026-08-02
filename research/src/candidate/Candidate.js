/**
 * research/src/candidate/Candidate.js
 *
 * Purpose:
 *   Abstract base class for all Phase 11 discovery candidates. Defines the
 *   complete field set required by the directive and enforces construction-time
 *   validation for all required fields. Subclasses (IndicatorFeature,
 *   MarketState, CompositeCandidate, ConditionalHypothesis) extend this with
 *   type-specific fields.
 *
 * Scientific rationale for the field set:
 *   - fingerprint: SHA-256 of identifying fields — makes candidate identity
 *     tamper-evident and supports ReproducibilityGate's fingerprint verification.
 *   - researchConfigurationId/configHash: tie the candidate to the exact
 *     computational environment in which it was generated.
 *   - provenance/featureProvenance: full derivation chain from primitives,
 *     enabling CausalLeakageValidator (Phase B) to audit maxLookahead compliance.
 *   - lifecycle: Phase 11 stage (Generated→...→Deprecated) from the parallel
 *     state machine (phase11LifecycleStates.js), independent of hypothesisRegistry.
 *   - evidenceTier: E0-E5 scientific evidence level (scientificEvidenceTiers.js).
 *   - implementationMaturity: Prototype→Production (implementationMaturity.js).
 *   - reproducibilityLevel: 0-5 (reproducibilityLevels.js).
 *   - discoveryStabilityIndex: cross-window stability of the discovery signal.
 *   - decisionAuditTrail: every decision affecting this candidate, immutable log.
 *
 * Dependencies: core/sha256.js, governance/phase11LifecycleStates.js,
 *   governance/scientificEvidenceTiers.js, governance/implementationMaturity.js.
 * Public API: Candidate (abstract), CandidateValidationError, CANDIDATE_TYPES.
 * Complexity: O(1) construction (hash pre-computed by factory); O(n) factory
 *   where n is the serialized identifying-fields length.
 * Threading: async factory (SHA-256 fingerprint computation).
 */

import { sha256Canonical } from '../core/sha256.js';
import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';
import { E_TIERS } from '../governance/scientificEvidenceTiers.js';
import { IMPLEMENTATION_MATURITY } from '../governance/implementationMaturity.js';

export class CandidateValidationError extends Error {
  constructor(message, { candidateType, fields } = {}) {
    super(message);
    this.name = 'CandidateValidationError';
    this.candidateType = candidateType;
    this.fields = fields;
  }
}

/** Recognised concrete candidate types. Each corresponds to a subclass. */
export const CANDIDATE_TYPES = Object.freeze({
  INDICATOR_FEATURE:    'IndicatorFeature',
  MARKET_STATE:         'MarketState',
  PROXY_CANDIDATE:      'ProxyCandidate',
  COMPOSITE_CANDIDATE:  'CompositeCandidate',
  CONDITIONAL_HYPOTHESIS: 'ConditionalHypothesis',
  EVENT_PROCESS_FEATURE: 'EventProcessFeature',
});

/**
 * Abstract base class for Phase 11 discovery candidates.
 *
 * Do NOT instantiate directly — always use a subclass's static async `create()`.
 * The `new.target === Candidate` guard in the constructor enforces this.
 */
export class Candidate {
  // ── Identity fields ──────────────────────────────────────────────────────
  /** @type {string} Unique candidate identifier (caller-supplied or auto-generated). */
  id;
  /**
   * @type {string}
   * SHA-256 hex of canonicalJson({ family, type, parameters, generatorVersion,
   * grammarVersion }). Two candidates with the same fingerprint are provably
   * identical in their scientific definition (modulo metadata fields like id/dates).
   */
  fingerprint;
  /** @type {string} Hypothesis family key this candidate belongs to. */
  family;
  /** @type {string} Concrete candidate type (one of CANDIDATE_TYPES values). */
  type;
  /** @type {Readonly<Object>} Type-specific parameters defining this candidate. */
  parameters;
  /** @type {string} Human-readable scientific description. */
  description;

  // ── Provenance fields ────────────────────────────────────────────────────
  /** @type {string} Version of the generator algorithm that produced this candidate. */
  generatorVersion;
  /** @type {string} Version of the candidate grammar used. */
  grammarVersion;
  /** @type {string} SHA-256 configHash of the active ResearchConfiguration. */
  configHash;
  /** @type {string} ID of the active ResearchConfiguration. */
  researchConfigurationId;
  /** @type {string|null} ID of the ResearchFreeze covering this candidate (null until frozen). */
  researchFreezeId;
  /** @type {string|null} ID of the active StatisticalAnalysisPlan (null until SAP created). */
  sapId;
  /**
   * @type {Readonly<Object>}
   * Source provenance: how and when this candidate was generated.
   * e.g. { source: 'genetic_search', parentIds: [...], mutationType: 'crossover' }
   */
  provenance;
  /**
   * @type {ReadonlyArray<string>}
   * Names of observables from MeasurementRegistry that this candidate uses.
   * Every name must be registered in the campaign's MeasurementRegistry.
   * CausalLeakageValidator (Phase B) will audit these for maxLookahead compliance.
   */
  featureProvenance;

  // ── Lifecycle and evidence fields ─────────────────────────────────────────
  /**
   * @type {string}
   * Current Phase 11 lifecycle stage (from phase11LifecycleStates.js).
   * Defaults to 'Generated'. Transitions are managed by the Phase 11 lifecycle
   * machine, NOT by hypothesisRegistry.js's LIFECYCLE_STAGES.
   */
  lifecycle;
  /**
   * @type {string}
   * Scientific evidence tier (E0–E5 from scientificEvidenceTiers.js).
   * Defaults to E0. Advanced by the evidence accumulation process.
   */
  evidenceTier;
  /**
   * @type {string}
   * Implementation maturity level (from implementationMaturity.js).
   * Defaults to Prototype. Reflects how production-ready this candidate's
   * computational implementation is, independent of scientific evidence strength.
   */
  implementationMaturity;
  /**
   * @type {number}
   * Reproducibility level 0–5 (from reproducibilityLevels.js).
   * 0 = not yet reproduced; 5 = independently reproduced across multiple labs/contexts.
   * Defaults to 0. Required to be ≥ 3 before ReproducibilityGate passage.
   */
  reproducibilityLevel;
  /**
   * @type {number|null}
   * Posterior probability (0–1) that this candidate represents a real effect,
   * given all accumulated evidence. Null until first evidence is collected.
   */
  confidenceLevel;
  /**
   * @type {number|null}
   * Calibrated scientific importance score (0–1). Higher = more theoretically
   * significant or more novel relative to the existing knowledge graph.
   * Null until scored by the prioritization layer.
   */
  scientificImportance;
  /**
   * @type {number|null}
   * Calibrated trading importance score (0–1). Higher = more likely to translate
   * into a profitable signal under real trading conditions.
   * Null until scored by the prioritization layer.
   */
  tradingImportance;
  /**
   * @type {Object|null}
   * Uncertainty decomposition: { epistemic: number, aleatoric: number, total: number }.
   * Epistemic uncertainty is reducible with more data; aleatoric is irreducible.
   * Null until uncertainty estimation is run.
   */
  uncertainty;

  // ── Lineage and stability fields ─────────────────────────────────────────
  /**
   * @type {ReadonlyArray<string>}
   * IDs of parent candidates from which this was derived (e.g., via mutation
   * or crossover in a genetic search). Empty for root/seed candidates.
   */
  lineage;
  /**
   * @type {Object|null}
   * Measurement uncertainty: { bias: number, variance: number, se: number }.
   * Quantifies uncertainty in the measurement of the candidate's effect size.
   * Null until a power analysis is completed.
   */
  measurementUncertainty;
  /**
   * @type {number|null}
   * Discovery Stability Index: fraction of time windows across which this
   * candidate's effect size maintains consistent sign and magnitude
   * (related to driftSurveillance.js's multiverse stability ratio).
   * Null until computed. Range [0, 1]; higher = more stable.
   */
  discoveryStabilityIndex;

  // ── Audit fields ─────────────────────────────────────────────────────────
  /** @type {Readonly<Object>|null} Diagnostic test results (varies by candidate type). */
  diagnostics;
  /**
   * @type {ReadonlyArray<Object>}
   * Append-only log of every decision affecting this candidate:
   * [{ decisionType, reason, timestamp, actor, metadata }, ...]
   * Managed externally by DecisionAuditLog; stored here as a snapshot for
   * serialization. Defaults to empty array.
   */
  decisionAuditTrail;

  /** @type {number} Unix epoch milliseconds of creation. */
  createdAt;

  /**
   * Protected constructor — called only by subclass create() factories.
   * Throws CandidateValidationError for all missing required fields.
   * @param {object} fields - Pre-validated, pre-fingerprinted field set.
   */
  constructor(fields) {
    if (new.target === Candidate) {
      throw new CandidateValidationError(
        'Candidate is abstract — use IndicatorFeature, MarketState, CompositeCandidate, or ConditionalHypothesis'
      );
    }
    Object.assign(this, fields);
    Object.freeze(this.parameters);
    Object.freeze(this.featureProvenance);
    Object.freeze(this.lineage);
    Object.freeze(this.decisionAuditTrail);
    // Note: do NOT freeze the top-level object — subclasses assign additional
    // properties after super() returns. Subclass constructors call Object.freeze(this).
  }

  /**
   * Computes the SHA-256 fingerprint for a candidate from its identifying fields.
   * Called by subclass create() factories before constructing the instance.
   *
   * Fingerprint covers only fields that define the scientific identity of the
   * candidate — NOT metadata fields like id, researchConfigurationId, or dates.
   * Two independently generated candidates with identical family/type/parameters/
   * generatorVersion/grammarVersion have the same fingerprint, enabling deduplication.
   *
   * O(n) in the serialized length of the identifying fields.
   *
   * @param {{ family, type, parameters, generatorVersion, grammarVersion }} fields
   * @returns {Promise<string>} 64-char lowercase hex SHA-256.
   */
  static async _computeFingerprint({ family, type, parameters, generatorVersion, grammarVersion }) {
    return sha256Canonical({ family, type, parameters, generatorVersion, grammarVersion });
  }

  /**
   * Validates the common required fields shared by all Candidate subclasses.
   * Returns an array of error strings; empty = valid.
   * O(1).
   * @param {object} params
   * @returns {string[]}
   */
  static _validateCommonFields(params) {
    const errors = [];
    const { id, family, type, parameters, description, generatorVersion, grammarVersion,
            configHash, researchConfigurationId } = params;
    if (!id || typeof id !== 'string') errors.push('id: required non-empty string');
    if (!family || typeof family !== 'string') errors.push('family: required non-empty string');
    if (!type || typeof type !== 'string') errors.push('type: required non-empty string');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
      errors.push('parameters: required plain object');
    if (!description || typeof description !== 'string') errors.push('description: required non-empty string');
    if (!generatorVersion || typeof generatorVersion !== 'string') errors.push('generatorVersion: required non-empty string');
    if (!grammarVersion || typeof grammarVersion !== 'string') errors.push('grammarVersion: required non-empty string');
    if (!configHash || typeof configHash !== 'string') errors.push('configHash: required non-empty string');
    if (!researchConfigurationId || typeof researchConfigurationId !== 'string')
      errors.push('researchConfigurationId: required non-empty string');
    return errors;
  }

  /**
   * Builds the common field set with defaults for all optional fields.
   * Called by subclass create() factories after _validateCommonFields passes.
   * @param {object} params
   * @param {string} fingerprint - Pre-computed SHA-256 fingerprint.
   * @returns {object}
   */
  static _buildCommonFields(params, fingerprint) {
    return {
      id: params.id,
      fingerprint,
      family: params.family,
      type: params.type,
      parameters: { ...params.parameters },
      description: params.description,
      generatorVersion: params.generatorVersion,
      grammarVersion: params.grammarVersion,
      configHash: params.configHash,
      researchConfigurationId: params.researchConfigurationId,
      researchFreezeId: params.researchFreezeId ?? null,
      sapId: params.sapId ?? null,
      provenance: params.provenance ? { ...params.provenance } : {},
      featureProvenance: Array.isArray(params.featureProvenance) ? [...params.featureProvenance] : [],
      lifecycle: params.lifecycle ?? PHASE11_LIFECYCLE_STAGES.GENERATED,
      evidenceTier: params.evidenceTier ?? E_TIERS.E0,
      implementationMaturity: params.implementationMaturity ?? IMPLEMENTATION_MATURITY.PROTOTYPE,
      reproducibilityLevel: typeof params.reproducibilityLevel === 'number' ? params.reproducibilityLevel : 0,
      confidenceLevel: params.confidenceLevel ?? null,
      scientificImportance: params.scientificImportance ?? null,
      tradingImportance: params.tradingImportance ?? null,
      uncertainty: params.uncertainty ?? null,
      lineage: Array.isArray(params.lineage) ? [...params.lineage] : [],
      measurementUncertainty: params.measurementUncertainty ?? null,
      discoveryStabilityIndex: params.discoveryStabilityIndex ?? null,
      diagnostics: params.diagnostics ?? null,
      decisionAuditTrail: Array.isArray(params.decisionAuditTrail) ? [...params.decisionAuditTrail] : [],
      createdAt: params.createdAt ?? Date.now(),
    };
  }

  /** @returns {object} Plain object safe for JSON.stringify. */
  toJSON() {
    return {
      id: this.id, fingerprint: this.fingerprint, family: this.family,
      type: this.type, parameters: this.parameters, description: this.description,
      generatorVersion: this.generatorVersion, grammarVersion: this.grammarVersion,
      configHash: this.configHash, researchConfigurationId: this.researchConfigurationId,
      researchFreezeId: this.researchFreezeId, sapId: this.sapId,
      provenance: this.provenance, featureProvenance: this.featureProvenance,
      lifecycle: this.lifecycle, evidenceTier: this.evidenceTier,
      implementationMaturity: this.implementationMaturity,
      reproducibilityLevel: this.reproducibilityLevel,
      confidenceLevel: this.confidenceLevel,
      scientificImportance: this.scientificImportance,
      tradingImportance: this.tradingImportance,
      uncertainty: this.uncertainty, lineage: this.lineage,
      measurementUncertainty: this.measurementUncertainty,
      discoveryStabilityIndex: this.discoveryStabilityIndex,
      diagnostics: this.diagnostics,
      decisionAuditTrail: this.decisionAuditTrail,
      createdAt: this.createdAt,
    };
  }
}
