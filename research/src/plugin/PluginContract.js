/**
 * research/src/plugin/PluginContract.js
 *
 * Purpose:
 *   Formal interface definition for the ScientificPlugin contract that every
 *   detector, context plugin, and market-construct proxy in Phase 11 must
 *   satisfy. The contract is enforced structurally at registration time by
 *   ContextRegistry and MarketConstructProxyRegistry via validatePlugin().
 *
 * Scientific rationale:
 *   Uniform plugin interfaces enable orchestrators (ObservableContextDetector,
 *   MarketConstructProxyDetector) to iterate a heterogeneous set of detectors
 *   generically: the pipeline calls plugin.compute(inputs) on every registered
 *   plugin with zero knowledge of what any specific plugin does. Adding a new
 *   context or proxy requires ONLY registering a conforming plugin object —
 *   no modifications to orchestration code, no switch statements, no if-chains.
 *   Hardcoded per-plugin branching in the pipeline is an architectural defect
 *   because it couples the pipeline's correctness to the specific plugin roster.
 *
 * Phase B scope:
 *   Foundational interface consumed by all Phase B components.
 *
 * Dependencies: none.
 * Public API: REQUIRED_METHODS, VALID_VALIDATION_STATUSES, REQUIRED_METADATA_FIELDS,
 *   ScientificPlugin, validatePlugin, PluginContractError.
 * Complexity: O(k) for validatePlugin where k = REQUIRED_METHODS.length (constant = 8).
 */

/** All method names a conforming ScientificPlugin object must expose. */
export const REQUIRED_METHODS = Object.freeze([
  'metadata',
  'validate',
  'compute',
  'version',
  'dependencies',
  'tests',
  'documentation',
  'scientificAssumptions',
]);

/**
 * Allowed values for metadata().validationStatus.
 * Ordered from least to most evidence; REPLICATED is the highest.
 */
export const VALID_VALIDATION_STATUSES = Object.freeze([
  'THEORETICAL',   // mathematically defined but never tested empirically
  'HEURISTIC',     // practitioner intuition with no formal testing
  'VALIDATED',     // tested in at least one study on in-sample data
  'REPLICATED',    // independently confirmed on out-of-sample data
]);

/** All fields required in the object returned by metadata(). */
export const REQUIRED_METADATA_FIELDS = Object.freeze([
  'name',
  'version',
  'description',
  'scientificAssumptions',
  'dependencies',
  'complexity',
  'validationStatus',
  'maxLookahead',
]);

export class PluginContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginContractError';
  }
}

/**
 * Validates that a plugin object conforms to the ScientificPlugin interface.
 * Non-throwing — returns { valid: boolean, errors: string[] } so callers can
 * report all failures at once.
 *
 * Checks performed:
 *   1. plugin is a non-null object
 *   2. Every REQUIRED_METHODS entry is present and callable
 *   3. metadata() can be invoked without throwing
 *   4. metadata() return value contains all REQUIRED_METADATA_FIELDS
 *   5. metadata().validationStatus is in VALID_VALIDATION_STATUSES
 *   6. metadata().maxLookahead === 0 (Phase 11 causal constraint)
 *
 * O(k) where k = REQUIRED_METHODS.length (constant 8).
 *
 * @param {object} plugin
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: ['plugin: expected a non-null object'] };
  }
  const errors = [];

  // Check all required methods are callable.
  for (const method of REQUIRED_METHODS) {
    if (typeof plugin[method] !== 'function') {
      errors.push(
        `plugin.${method}: required callable method is missing or not a function`
      );
    }
  }

  // If metadata() is callable, validate its return shape deeply.
  if (typeof plugin.metadata === 'function') {
    let meta;
    try {
      meta = plugin.metadata();
    } catch (e) {
      errors.push(`plugin.metadata(): threw during validation — ${e.message}`);
      meta = null;
    }
    if (meta !== null) {
      if (!meta || typeof meta !== 'object') {
        errors.push('plugin.metadata(): must return a non-null object');
      } else {
        for (const field of REQUIRED_METADATA_FIELDS) {
          if (!(field in meta)) {
            errors.push(`plugin.metadata().${field}: required field is missing`);
          }
        }
        if (meta.maxLookahead !== 0) {
          errors.push(
            `plugin.metadata().maxLookahead: must be 0 (causal constraint); got ${meta.maxLookahead}`
          );
        }
        if (
          meta.validationStatus !== undefined &&
          !VALID_VALIDATION_STATUSES.includes(meta.validationStatus)
        ) {
          errors.push(
            `plugin.metadata().validationStatus: "${meta.validationStatus}" is not one of ` +
            VALID_VALIDATION_STATUSES.join(', ')
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Abstract base class documenting the ScientificPlugin interface.
 *
 * Concrete plugins may extend this class but are not required to — the
 * registry enforces the interface structurally via validatePlugin(), not
 * via instanceof, so plain objects are fully supported. This class serves
 * as executable documentation: every method throws PluginContractError
 * by default, reminding implementors that the method must be overridden.
 */
export class ScientificPlugin {
  /**
   * Returns machine-readable plugin metadata.
   * @returns {{
   *   name: string,
   *   version: string,
   *   description: string,
   *   scientificAssumptions: string[],
   *   dependencies: string[],
   *   complexity: string,
   *   validationStatus: 'THEORETICAL'|'HEURISTIC'|'VALIDATED'|'REPLICATED',
   *   maxLookahead: 0
   * }}
   */
  metadata() {
    throw new PluginContractError(`${this.constructor.name}.metadata() is not implemented`);
  }

  /**
   * Validates the plugin's own internal configuration (not its inputs).
   * Non-throwing — returns { valid: boolean, errors: string[] }.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate() {
    throw new PluginContractError(`${this.constructor.name}.validate() is not implemented`);
  }

  /**
   * Executes the plugin's computation.
   * @param {object} inputs - Plugin-specific input bundle.
   * @returns {object} result - Plugin-specific output shape.
   */
  compute(inputs) {  // eslint-disable-line no-unused-vars
    throw new PluginContractError(`${this.constructor.name}.compute() is not implemented`);
  }

  /**
   * Returns the plugin's SemVer version string.
   * @returns {string}
   */
  version() {
    throw new PluginContractError(`${this.constructor.name}.version() is not implemented`);
  }

  /**
   * Returns the names of other plugins or modules this plugin depends on.
   * @returns {string[]}
   */
  dependencies() {
    throw new PluginContractError(`${this.constructor.name}.dependencies() is not implemented`);
  }

  /**
   * Returns a list of self-test cases for this plugin.
   * @returns {Array<{ name: string, inputs: object, expectedOutputShape: object }>}
   */
  tests() {
    throw new PluginContractError(`${this.constructor.name}.tests() is not implemented`);
  }

  /**
   * Returns human-readable documentation for this plugin.
   * @returns {string}
   */
  documentation() {
    throw new PluginContractError(`${this.constructor.name}.documentation() is not implemented`);
  }

  /**
   * Returns the full list of scientific assumptions underlying this plugin.
   * @returns {string[]}
   */
  scientificAssumptions() {
    throw new PluginContractError(`${this.constructor.name}.scientificAssumptions() is not implemented`);
  }
}
