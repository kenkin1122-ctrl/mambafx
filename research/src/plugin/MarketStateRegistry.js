/**
 * research/src/plugin/MarketStateRegistry.js
 *
 * Purpose:
 *   Stage 2 of the registry-driven candidate generation directive: a
 *   generic plugin registry for market-state detection plugins, mirroring
 *   IndicatorRegistry.js's (and context/ContextRegistry.js's) exact,
 *   already-proven pattern.
 *
 * Dependencies: plugin/PluginContract.js (validatePlugin — unmodified).
 * Public API: MarketStateRegistry, MarketStateRegistryError.
 * Complexity: O(1) register/lookup/has; O(n) list/listNames.
 */

import { validatePlugin } from './PluginContract.js';

export class MarketStateRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketStateRegistryError';
  }
}

export class MarketStateRegistry {
  /** @type {Map<string, object>} name → plugin */
  #plugins = new Map();

  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new MarketStateRegistryError(`register: plugin does not conform to PluginContract — ${errors.join('; ')}`);
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new MarketStateRegistryError(`register: a market-state plugin named "${name}" is already registered`);
    }
    this.#plugins.set(name, plugin);
    return this;
  }

  lookup(name) { return this.#plugins.get(name); }
  has(name) { return this.#plugins.has(name); }
  list() { return [...this.#plugins.values()]; }
  listNames() { return [...this.#plugins.keys()]; }
  get size() { return this.#plugins.size; }
}
