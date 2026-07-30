/**
 * research/src/context/ContextRegistry.js
 *
 * Purpose:
 *   Generic plugin registry for context detector plugins. The registry is the
 *   ONLY location that knows which context plugins exist at runtime. All
 *   orchestration (ObservableContextDetector) iterates this registry generically
 *   via list() — it never references specific plugin names in its pipeline logic.
 *
 * Scientific rationale:
 *   Separating the plugin roster from orchestration logic enforces the
 *   Open/Closed Principle for scientific software: the detection pipeline is
 *   closed for modification but open for extension. Researchers add new context
 *   variables by registering a conforming plugin here; zero lines of pipeline
 *   code change. This prevents the common failure mode where every new context
 *   requires an orchestration code change, which is a regression surface.
 *
 * Phase B scope:
 *   Supports CandleTimingDetector, CandlePositionDetector, PriorCandleAnalyzer,
 *   and any future context plugins without modification.
 *
 * Dependencies: plugin/PluginContract.js.
 * Public API: ContextRegistry, ContextRegistryError.
 * Complexity: O(1) register/lookup/has/unregister; O(n) list/listNames.
 */

import { validatePlugin } from '../plugin/PluginContract.js';

export class ContextRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContextRegistryError';
  }
}

/**
 * Registry for ScientificPlugin-conforming context detector plugins.
 *
 * Validates every candidate against the PluginContract interface at registration
 * time, so downstream consumers can trust that listed plugins are well-formed
 * without re-validating them on every call.
 */
export class ContextRegistry {
  /** @type {Map<string, object>} name → plugin */
  #plugins = new Map();

  /**
   * Registers a context plugin.
   *
   * Throws ContextRegistryError if:
   *   - the plugin does not conform to PluginContract (all reasons listed)
   *   - a plugin with the same metadata().name is already registered
   *
   * O(k) where k = REQUIRED_METHODS.length (constant 8) for contract check.
   *
   * @param {object} plugin - A ScientificPlugin-conforming object or plain object.
   * @returns {this} for chaining.
   */
  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new ContextRegistryError(
        `register: plugin does not conform to PluginContract — ${errors.join('; ')}`
      );
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new ContextRegistryError(
        `register: a context plugin named "${name}" is already registered`
      );
    }
    this.#plugins.set(name, plugin);
    return this;
  }

  /**
   * Returns the plugin registered under the given name, or undefined if absent.
   * O(1).
   * @param {string} name
   * @returns {object|undefined}
   */
  lookup(name) {
    return this.#plugins.get(name);
  }

  /**
   * Returns true if a plugin with the given name is registered.
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#plugins.has(name);
  }

  /**
   * Returns all registered plugins as an array (insertion order).
   * O(n).
   * @returns {object[]}
   */
  list() {
    return [...this.#plugins.values()];
  }

  /**
   * Returns all registered plugin names (insertion order).
   * O(n).
   * @returns {string[]}
   */
  listNames() {
    return [...this.#plugins.keys()];
  }

  /**
   * Removes the plugin with the given name from the registry.
   * Returns true if a plugin was removed, false if the name was not found.
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    return this.#plugins.delete(name);
  }

  /**
   * Number of currently registered plugins.
   * O(1).
   * @returns {number}
   */
  get size() {
    return this.#plugins.size;
  }
}
