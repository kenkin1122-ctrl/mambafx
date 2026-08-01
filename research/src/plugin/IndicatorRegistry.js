/**
 * research/src/plugin/IndicatorRegistry.js
 *
 * Purpose:
 *   Stage 1 of the registry-driven candidate generation directive: a
 *   generic plugin registry for indicator plugins. Mirrors context/
 *   ContextRegistry.js's exact, already-proven pattern (register/lookup/
 *   has/list, structural validation via plugin/PluginContract.js's
 *   validatePlugin()) rather than inventing a new pattern — "Indicators
 *   are plugins" is satisfied by reusing the SAME contract every other
 *   Phase 11 plugin type (contexts, market-construct proxies) already
 *   conforms to, not a bespoke indicator-only interface.
 *
 *   Adding a new indicator requires ONLY registering a conforming plugin
 *   here — zero changes to the candidate generator (discovery/
 *   registryDrivenGenerator.js), which iterates this registry generically
 *   via list().
 *
 * Dependencies: plugin/PluginContract.js (validatePlugin — unmodified,
 *   the exact same contract ContextRegistry/MarketConstructProxyRegistry
 *   already enforce).
 * Public API: IndicatorRegistry, IndicatorRegistryError.
 * Complexity: O(1) register/lookup/has; O(n) list/listNames.
 */

import { validatePlugin } from './PluginContract.js';

export class IndicatorRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndicatorRegistryError';
  }
}

export class IndicatorRegistry {
  /** @type {Map<string, object>} name → plugin */
  #plugins = new Map();

  /**
   * Registers an indicator plugin. Throws IndicatorRegistryError if the
   * plugin does not conform to PluginContract, or if a plugin with the
   * same metadata().name is already registered.
   * @param {object} plugin
   * @returns {this}
   */
  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new IndicatorRegistryError(`register: plugin does not conform to PluginContract — ${errors.join('; ')}`);
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new IndicatorRegistryError(`register: an indicator plugin named "${name}" is already registered`);
    }
    this.#plugins.set(name, plugin);
    return this;
  }

  /** @returns {object|undefined} */
  lookup(name) {
    return this.#plugins.get(name);
  }

  /** @returns {boolean} */
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

  /** @returns {number} */
  get size() {
    return this.#plugins.size;
  }
}
