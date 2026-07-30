/**
 * research/src/config/ConfigValidator.js
 *
 * Purpose:
 *   Pure, non-throwing validation functions for Phase 11 configuration objects.
 *   All functions return { valid: boolean, errors: string[] } so callers can
 *   display multiple errors at once rather than catching a sequence of exceptions.
 *
 * Design philosophy:
 *   - Never throw — return a structured error list. The async factories in
 *     ResearchConfiguration/StatisticalAnalysisPlan/ResearchFreeze DO throw for
 *     invalid inputs (to guard creation); this module is the UI-friendly layer that
 *     pre-validates before calling those factories.
 *   - Only validate structural properties and mandatory fields here; domain-specific
 *     cross-object consistency (e.g., SAP family keys matching the active config's
 *     proxyVersions) is the caller's responsibility.
 *   - Each validator is a pure function over a plain object — it does not require
 *     the input to be an instance of the corresponding class, making it usable for
 *     deserialized (e.g., database-read) records too.
 *
 * Dependencies: config/VersionSchema.js.
 * Public API: validateResearchConfiguration, validateStatisticalAnalysisPlan,
 *   validateResearchFreeze.
 * Complexity: O(k) where k = number of hypothesis families / alpha keys (small, bounded).
 */

import { isValidVersion } from './VersionSchema.js';

/**
 * Validates a ResearchConfiguration instance or plain object.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResearchConfiguration(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config: expected a non-null object'] };
  }
  const errors = [];
  if (!config.id || typeof config.id !== 'string')
    errors.push('id: required non-empty string');
  if (!config.name || typeof config.name !== 'string')
    errors.push('name: required non-empty string');
  if (!config.description || typeof config.description !== 'string')
    errors.push('description: required non-empty string');
  if (!isValidVersion(config.grammarVersion))
    errors.push(`grammarVersion: "${config.grammarVersion}" is not a valid MAJOR.MINOR.PATCH version`);
  if (!isValidVersion(config.ontologyVersion))
    errors.push(`ontologyVersion: "${config.ontologyVersion}" is not a valid MAJOR.MINOR.PATCH version`);
  if (!isValidVersion(config.generatorVersion))
    errors.push(`generatorVersion: "${config.generatorVersion}" is not a valid MAJOR.MINOR.PATCH version`);
  if (config.proxyVersions === null || typeof config.proxyVersions !== 'object' || Array.isArray(config.proxyVersions))
    errors.push('proxyVersions: required plain object (may be empty)');
  if (config.maxLookahead !== 0)
    errors.push('maxLookahead: must be 0 (Phase 11 causal constraint)');
  if (!config.configHash || typeof config.configHash !== 'string')
    errors.push('configHash: required non-empty string (SHA-256 hex)');
  if (typeof config.createdAt !== 'number' || !Number.isFinite(config.createdAt))
    errors.push('createdAt: required finite number (Unix epoch ms)');
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a StatisticalAnalysisPlan instance or plain object.
 *
 * @param {object} sap
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateStatisticalAnalysisPlan(sap) {
  if (!sap || typeof sap !== 'object') {
    return { valid: false, errors: ['sap: expected a non-null object'] };
  }
  const errors = [];
  if (!sap.sapId || typeof sap.sapId !== 'string')
    errors.push('sapId: required non-empty string');
  if (!Array.isArray(sap.hypothesisFamilies) || sap.hypothesisFamilies.length === 0)
    errors.push('hypothesisFamilies: required non-empty array');
  if (!sap.alphaAllocation || typeof sap.alphaAllocation !== 'object' || Array.isArray(sap.alphaAllocation)) {
    errors.push('alphaAllocation: required plain object');
  } else {
    const alphaSum = Object.values(sap.alphaAllocation)
      .reduce((s, v) => s + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
    if (alphaSum > 1.0 + 1e-9)
      errors.push(`alphaAllocation: total alpha ${alphaSum.toFixed(6)} exceeds 1.0`);
  }
  if (!sap.promotionPolicies || typeof sap.promotionPolicies !== 'object' || Array.isArray(sap.promotionPolicies))
    errors.push('promotionPolicies: required plain object');
  if (!Array.isArray(sap.stoppingRules))
    errors.push('stoppingRules: required array');
  if (!sap.replicationCriteria || typeof sap.replicationCriteria !== 'object' || Array.isArray(sap.replicationCriteria))
    errors.push('replicationCriteria: required plain object');
  if (!sap.publicationCriteria || typeof sap.publicationCriteria !== 'object' || Array.isArray(sap.publicationCriteria))
    errors.push('publicationCriteria: required plain object');
  if (!sap.effectSizeThresholds || typeof sap.effectSizeThresholds !== 'object' || Array.isArray(sap.effectSizeThresholds))
    errors.push('effectSizeThresholds: required plain object');
  if (!sap.minimumSampleSizes || typeof sap.minimumSampleSizes !== 'object' || Array.isArray(sap.minimumSampleSizes))
    errors.push('minimumSampleSizes: required plain object');
  if (!Array.isArray(sap.requiredDiagnostics))
    errors.push('requiredDiagnostics: required array');
  if (typeof sap.createdTimestamp !== 'number' || !Number.isFinite(sap.createdTimestamp))
    errors.push('createdTimestamp: required finite number (Unix epoch ms)');
  if (!sap.sapHash || typeof sap.sapHash !== 'string')
    errors.push('sapHash: required non-empty string (SHA-256 hex)');
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a ResearchFreeze instance or plain object.
 *
 * @param {object} freeze
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateResearchFreeze(freeze) {
  if (!freeze || typeof freeze !== 'object') {
    return { valid: false, errors: ['freeze: expected a non-null object'] };
  }
  const errors = [];
  if (!freeze.id || typeof freeze.id !== 'string')
    errors.push('id: required non-empty string (SHA-256 content address)');
  if (!freeze.researchConfigurationId || typeof freeze.researchConfigurationId !== 'string')
    errors.push('researchConfigurationId: required non-empty string');
  if (!freeze.configHash || typeof freeze.configHash !== 'string')
    errors.push('configHash: required non-empty string (SHA-256 hex)');
  if (!freeze.ontologyVersion || typeof freeze.ontologyVersion !== 'string')
    errors.push('ontologyVersion: required non-empty string');
  if (!freeze.generatorVersion || typeof freeze.generatorVersion !== 'string')
    errors.push('generatorVersion: required non-empty string');
  if (freeze.proxyVersions === null || typeof freeze.proxyVersions !== 'object' || Array.isArray(freeze.proxyVersions))
    errors.push('proxyVersions: required plain object');
  if (!Array.isArray(freeze.candidateFingerprints))
    errors.push('candidateFingerprints: required array');
  if (!freeze.researchConfigurationHash || typeof freeze.researchConfigurationHash !== 'string')
    errors.push('researchConfigurationHash: required non-empty string');
  if (typeof freeze.frozenAt !== 'number' || !Number.isFinite(freeze.frozenAt))
    errors.push('frozenAt: required finite number (Unix epoch ms)');
  return { valid: errors.length === 0, errors };
}


/**
 * Namespace object grouping the three config validators.
 * Allows callers to import as: import { ConfigValidator } from '.../ConfigValidator.js'
 * The standalone function exports remain for direct-import convenience.
 */
export const ConfigValidator = Object.freeze({
  validateResearchConfiguration,
  validateStatisticalAnalysisPlan,
  validateResearchFreeze,
});
