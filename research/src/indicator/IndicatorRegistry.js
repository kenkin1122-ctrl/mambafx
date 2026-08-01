/**
 * research/src/indicator/IndicatorRegistry.js
 *
 * Purpose:
 *   Generic plugin registry for technical-indicator plugins — the
 *   Indicator Registry half of the registry-driven candidate generation
 *   system. Deliberately mirrors context/ContextRegistry.js's exact
 *   structure (same register/lookup/has/list/listNames/unregister shape,
 *   same PluginContract enforcement) rather than introducing a new
 *   generic base class: this codebase already has two working registries
 *   built this way (ContextRegistry, MarketConstructProxyRegistry), and
 *   refactoring them into a shared base class was explicitly out of scope
 *   for this change ("Do NOT refactor working scientific components").
 *   A small amount of structural duplication across three registries is
 *   the honest tradeoff for that constraint.
 *
 * Scientific rationale: identical to ContextRegistry.js's — the pipeline
 *   (candidateGenerator.js, extended in this change) iterates this
 *   registry generically via list(), never referencing specific indicator
 *   names in orchestration logic. Adding a new indicator requires ONLY
 *   registering a conforming plugin here.
 *
 * Dependencies: plugin/PluginContract.js (validatePlugin — unmodified,
 *   reused exactly as ContextRegistry/MarketConstructProxyRegistry do).
 * Public API: IndicatorRegistry, IndicatorRegistryError.
 * Complexity: O(1) register/lookup/has/unregister; O(n) list/listNames.
 */

import { validatePlugin } from '../plugin/PluginContract.js';

export class IndicatorRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndicatorRegistryError';
  }
}

/**
 * Registry for ScientificPlugin-conforming indicator plugins.
 */
export class IndicatorRegistry {
  /** @type {Map<string, object>} name -> plugin */
  #plugins = new Map();

  /**
   * Registers an indicator plugin.
   * Throws IndicatorRegistryError if the plugin doesn't conform to
   * PluginContract, or if its name is already registered.
   * @param {object} plugin
   * @returns {this}
   */
  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new IndicatorRegistryError(
        `register: plugin does not conform to PluginContract — ${errors.join('; ')}`
      );
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new IndicatorRegistryError(
        `register: an indicator plugin named "${name}" is already registered`
      );
    }
    this.#plugins.set(name, plugin);
    return this;
  }

  /** @param {string} name @returns {object|undefined} */
  lookup(name) {
    return this.#plugins.get(name);
  }

  /** @param {string} name @returns {boolean} */
  has(name) {
    return this.#plugins.has(name);
  }

  /** @returns {object[]} All registered plugins, insertion order. */
  list() {
    return [...this.#plugins.values()];
  }

  /** @returns {string[]} All registered plugin names, insertion order. */
  listNames() {
    return [...this.#plugins.keys()];
  }

  /** @param {string} name @returns {boolean} true if a plugin was removed. */
  unregister(name) {
    return this.#plugins.delete(name);
  }

  /** @returns {number} */
  get size() {
    return this.#plugins.size;
  }
}
