/**
 * research/src/proxy/MarketConstructProxyRegistry.js
 *
 * Purpose:
 *   Generic plugin registry for market-construct proxy plugins. Structurally
 *   identical to ContextRegistry in its mechanics; separated because proxies
 *   carry additional scientific metadata (displayName, disclaimer, biases,
 *   causalAssumptions, etc.) and are consumed by a distinct orchestrator
 *   (MarketConstructProxyDetector).
 *
 * Scientific rationale:
 *   Market-construct proxies (support levels, institutional activity, etc.)
 *   are inferred from price data; they are not directly observable. Keeping
 *   their roster in a registry — rather than hardcoded in the pipeline — makes
 *   the set of modelled market constructs an explicit, auditable artefact of
 *   the research configuration. Peer reviewers can enumerate exactly which
 *   constructs are assumed; adding or removing a construct is a registry-only
 *   operation that leaves the pipeline code unchanged.
 *
 * Phase B scope:
 *   Supports all 10 core proxies defined in coreProxies.js and any future
 *   proxies without modification.
 *
 * Dependencies: plugin/PluginContract.js.
 * Public API: MarketConstructProxyRegistry, MarketConstructProxyRegistryError.
 * Complexity: O(1) register/lookup/has/unregister; O(n) list/listNames.
 */

import { validatePlugin } from '../plugin/PluginContract.js';

export class MarketConstructProxyRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketConstructProxyRegistryError';
  }
}

/**
 * Registry for ScientificPlugin-conforming market-construct proxy plugins.
 *
 * Every candidate is validated against the PluginContract interface at
 * registration time. The orchestrator (MarketConstructProxyDetector) iterates
 * list() generically — it never names specific proxies.
 */
export class MarketConstructProxyRegistry {
  /** @type {Map<string, object>} name → plugin */
  #plugins = new Map();

  /**
   * Registers a proxy plugin.
   *
   * Throws MarketConstructProxyRegistryError if:
   *   - the plugin does not conform to PluginContract
   *   - a plugin with the same metadata().name is already registered
   *
   * O(k) where k = REQUIRED_METHODS.length (constant 8).
   *
   * @param {object} plugin - A ScientificPlugin-conforming proxy plugin.
   * @returns {this} for chaining.
   */
  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new MarketConstructProxyRegistryError(
        `register: proxy plugin does not conform to PluginContract — ${errors.join('; ')}`
      );
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new MarketConstructProxyRegistryError(
        `register: a proxy plugin named "${name}" is already registered`
      );
    }
    this.#plugins.set(name, plugin);
    return this;
  }

  /**
   * Returns the proxy plugin registered under the given name, or undefined.
   * O(1).
   * @param {string} name
   * @returns {object|undefined}
   */
  lookup(name) {
    return this.#plugins.get(name);
  }

  /**
   * Returns true if a proxy plugin with the given name is registered.
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#plugins.has(name);
  }

  /**
   * Returns all registered proxy plugins as an array (insertion order).
   * O(n).
   * @returns {object[]}
   */
  list() {
    return [...this.#plugins.values()];
  }

  /**
   * Returns all registered proxy plugin names (insertion order).
   * O(n).
   * @returns {string[]}
   */
  listNames() {
    return [...this.#plugins.keys()];
  }

  /**
   * Removes the proxy plugin with the given name.
   * Returns true if removed, false if not found.
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    return this.#plugins.delete(name);
  }

  /**
   * Number of currently registered proxy plugins.
   * O(1).
   * @returns {number}
   */
  get size() {
    return this.#plugins.size;
  }
}
