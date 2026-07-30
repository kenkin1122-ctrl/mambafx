/**
 * research/src/governance/FamilyRegistry.js
 *
 * Purpose:
 *   Registry of Phase 11 hypothesis FAMILIES — named, versioned groupings
 *   of candidate families (e.g. "momentum", "mean_reversion",
 *   "volatility_regime") that gate which CANDIDATE_TYPES each family
 *   accepts and provide the single routing point from a Phase 11 family
 *   name to the legacy Family Online-FDR budget it spends against.
 *
 * Relationship to governance/family.js (existing, DO NOT TOUCH):
 *   family.js answers a DIFFERENT question — "given a (Market, Target
 *   Definition) pair, what is the canonical familyKey for FDR-wealth
 *   accounting purposes?" (Volume IV Part 6). This module answers "is
 *   candidate X, of type T, a member of a registered Phase 11 family, and
 *   is that membership version-compatible?" — a candidate-taxonomy
 *   question, not an alpha-accounting question. The two concepts are
 *   related but distinct: many Phase 11 families may route to the same
 *   legacy familyKey (e.g. two different hypothesis families both testing
 *   against the same Market+TargetDefinition share one FDR budget), and
 *   this registry's routeToLegacyFamilyKey() is a thin, explicit bridge
 *   between them — it calls family.js's resolveOrCreateFamilyKey exactly
 *   once per lookup and never reimplements equivalence-class matching.
 *
 * Responsibilities (directive "Family Registry" spec):
 *   - family registration: registerFamily() — name, version, description,
 *     allowed candidate types.
 *   - versioning: each family carries a semver-like version string; a
 *     later registration with the same name and a higher version
 *     supersedes the prior one (recorded, not deleted — the version
 *     history remains queryable).
 *   - compatibility checks: isCandidateCompatible() — does this candidate's
 *     type belong to a registered family, and was it generated with a
 *     generatorVersion the family's current version still recognises?
 *   - discovery routing: routeToLegacyFamilyKey() — resolve the legacy
 *     Online-FDR familyKey a candidate's discovery test should spend
 *     against, via governance/family.js (never onlineFdr.js directly —
 *     that remains discoveryDecision.js's exclusive job).
 *
 * Dependencies: governance/family.js (resolveOrCreateFamilyKey, read-only use).
 * Public API: FamilyRegistry, InvalidFamilyRegistrationError,
 *   UnregisteredFamilyError, IncompatibleCandidateError.
 * Complexity: registerFamily O(1); isCandidateCompatible O(1);
 *   routeToLegacyFamilyKey O(1) amortized (delegates to family.js).
 */

import { resolveOrCreateFamilyKey } from './family.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

const VALID_CANDIDATE_TYPES = new Set(Object.values(CANDIDATE_TYPES));

export class InvalidFamilyRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFamilyRegistrationError';
  }
}

export class UnregisteredFamilyError extends Error {
  constructor(familyName) {
    super(`FamilyRegistry: "${familyName}" is not a registered Phase 11 family`);
    this.name = 'UnregisteredFamilyError';
    this.familyName = familyName;
  }
}

export class IncompatibleCandidateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompatibleCandidateError';
  }
}

/** Naive semver-ish comparison: '1.2.0' > '1.1.9'. Returns -1/0/1. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export class FamilyRegistry {
  /** @type {Map<string, object>} familyName → current registration record */
  #families = new Map();
  /** @type {Map<string, object[]>} familyName → version history (append-only) */
  #history = new Map();

  /**
   * Registers a Phase 11 hypothesis family, or a new version of an existing
   * one. Registering a lower-or-equal version than the currently active
   * one is rejected (versions are monotonically increasing per family, the
   * same discipline as VersionSchema.js elsewhere in Phase 11).
   * O(1).
   *
   * @param {object} params
   * @param {string}   params.familyName            - Unique family name.
   * @param {string}   params.version                - e.g. '1.0.0'.
   * @param {string[]} params.allowedCandidateTypes   - Subset of CANDIDATE_TYPES.
   * @param {string}   [params.description='']
   * @param {number}   [params.minGeneratorVersion]   - Ignored if not supplied;
   *   compared as a string version — candidates generated with an older
   *   generatorVersion than this are flagged incompatible.
   * @returns {object} The registered family record.
   */
  registerFamily({ familyName, version, allowedCandidateTypes, description = '', minGeneratorVersion = null } = {}) {
    const errors = [];
    if (!familyName || typeof familyName !== 'string') errors.push('familyName: required non-empty string');
    if (!version || typeof version !== 'string') errors.push('version: required non-empty string');
    if (!Array.isArray(allowedCandidateTypes) || allowedCandidateTypes.length === 0) {
      errors.push('allowedCandidateTypes: required non-empty array');
    } else {
      for (const t of allowedCandidateTypes) {
        if (!VALID_CANDIDATE_TYPES.has(t)) errors.push(`allowedCandidateTypes: "${t}" is not a recognised CANDIDATE_TYPE`);
      }
    }
    if (errors.length) throw new InvalidFamilyRegistrationError(errors.join('; '));

    const existing = this.#families.get(familyName);
    if (existing && compareVersions(version, existing.version) <= 0) {
      throw new InvalidFamilyRegistrationError(
        `FamilyRegistry: family "${familyName}" is already registered at version "${existing.version}"; ` +
        `re-registration requires a strictly higher version (got "${version}")`
      );
    }

    const record = Object.freeze({
      familyName,
      version,
      allowedCandidateTypes: Object.freeze([...allowedCandidateTypes]),
      description,
      minGeneratorVersion,
      registeredAt: Date.now(),
    });

    this.#families.set(familyName, record);
    if (!this.#history.has(familyName)) this.#history.set(familyName, []);
    this.#history.get(familyName).push(record);
    return record;
  }

  /** @returns {object} The current registration record for a family. Throws if unregistered. */
  getFamily(familyName) {
    const record = this.#families.get(familyName);
    if (!record) throw new UnregisteredFamilyError(familyName);
    return record;
  }

  /** @returns {boolean} */
  isRegistered(familyName) {
    return this.#families.has(familyName);
  }

  /** @returns {object[]} Full version history for a family, oldest first. */
  versionHistory(familyName) {
    return (this.#history.get(familyName) || []).slice();
  }

  /** @returns {object[]} All currently-registered families (latest version each). */
  listFamilies() {
    return [...this.#families.values()];
  }

  /**
   * Compatibility check for a given candidate against its declared family.
   * Checks (a) the family is registered, (b) the candidate's type is in
   * that family's allowedCandidateTypes, (c) if the family declares a
   * minGeneratorVersion, the candidate's generatorVersion is not older.
   * Never throws — returns a structured result so callers (e.g. the
   * generator, or PromotionPolicy) can decide how to react.
   * O(1).
   *
   * @param {import('../candidate/Candidate.js').Candidate} candidate
   * @returns {{compatible: boolean, reasons: string[]}}
   */
  isCandidateCompatible(candidate) {
    const reasons = [];
    if (!candidate || !candidate.family) {
      return { compatible: false, reasons: ['candidate is missing a family'] };
    }
    if (!this.isRegistered(candidate.family)) {
      return { compatible: false, reasons: [`family "${candidate.family}" is not registered`] };
    }
    const record = this.getFamily(candidate.family);
    if (!record.allowedCandidateTypes.includes(candidate.type)) {
      reasons.push(`type "${candidate.type}" is not allowed for family "${candidate.family}" (allowed: ${record.allowedCandidateTypes.join(', ')})`);
    }
    if (record.minGeneratorVersion && candidate.generatorVersion &&
        compareVersions(candidate.generatorVersion, record.minGeneratorVersion) < 0) {
      reasons.push(`generatorVersion "${candidate.generatorVersion}" is older than family's minGeneratorVersion "${record.minGeneratorVersion}"`);
    }
    return { compatible: reasons.length === 0, reasons };
  }

  /**
   * Routes a candidate to its legacy Online-FDR familyKey via
   * governance/family.js's resolveOrCreateFamilyKey — the ONLY function
   * permitted to mint/resolve familyKeys (Volume IV Part 6 discipline).
   * This is discovery ROUTING only: it does not spend alpha, register a
   * hypothesis, or evaluate a p-value — those remain discoveryDecision.js's
   * exclusive responsibilities, reached later in the funnel.
   * O(1) amortized (delegates to family.js's own complexity).
   *
   * @param {import('../candidate/Candidate.js').Candidate} candidate
   * @param {{market: string, targetDefinition: object}} target
   * @returns {string} The resolved legacy familyKey.
   */
  routeToLegacyFamilyKey(candidate, { market, targetDefinition } = {}) {
    const { compatible, reasons } = this.isCandidateCompatible(candidate);
    if (!compatible) {
      throw new IncompatibleCandidateError(
        `FamilyRegistry.routeToLegacyFamilyKey: candidate "${candidate?.id}" is not compatible with its ` +
        `declared family: ${reasons.join('; ')}`
      );
    }
    return resolveOrCreateFamilyKey({ market, targetDefinition });
  }
}
