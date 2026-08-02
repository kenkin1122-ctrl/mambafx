/**
 * research/src/eventProcess/EventFeatureRegistry.js
 *
 * Purpose:
 *   Generic plugin registry for event-local feature plugins -- Phase 12's
 *   Feature Extractor for the Event Process domain, structurally identical
 *   to indicator/IndicatorRegistry.js, plugin/MarketStateRegistry.js,
 *   proxy/MarketConstructProxyRegistry.js, and context/ContextRegistry.js
 *   (the four existing plugin registries this is a direct, deliberate copy
 *   of the pattern of -- per design-review refinement #6: "implement
 *   EventFeatureExtractor using the existing plugin architecture so each
 *   event-derived feature is an independent plugin instead of building a
 *   monolithic extractor"). This is the fifth sibling registry, not a
 *   sixth architecture.
 *
 * Scope discipline (refinement #1, enforced structurally, not just by
 *   convention): every plugin registered here computes ONE value from
 *   EXACTLY ONE event and its immediate predecessor -- an event-local
 *   observation, never a rolling/windowed/smoothed statistic. There is no
 *   parameter here analogous to indicator plugins' `period`; a plugin
 *   registered in this registry that needed a window-size parameter would
 *   be a design defect (it belongs in Confirmation/Feature Resolution as a
 *   query-time computation instead, exactly as refinement #1 specifies).
 *   This is verified by requiring every registered plugin's own
 *   metadata().maxLookahead === 0 (same structural enforcement every other
 *   registry already has) AND by this registry's own compute-input
 *   contract only ever exposing a single (event, previousEvent) pair to
 *   plugin.compute() -- see computeEventLocalFeatures() below -- a plugin
 *   physically cannot reach for a third event through this interface.
 *
 * Scientific rationale (same as every sibling registry): the pipeline
 *   (EventFeatureRegistry consumers) iterates plugins generically via
 *   list() and never references a specific plugin name in its own logic.
 *   Adding a new event-local feature (e.g. a future "time-of-day" or
 *   "session-relative-position" feature) requires only registering a
 *   conforming plugin -- zero changes to any orchestration code.
 *
 * Dependencies: plugin/PluginContract.js (unmodified, reused).
 * Public API: EventFeatureRegistry, EventFeatureRegistryError.
 * Complexity: O(1) register/lookup/has/unregister; O(n) list/listNames.
 */

import { validatePlugin } from '../plugin/PluginContract.js';

export class EventFeatureRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventFeatureRegistryError';
  }
}

/**
 * Registry for ScientificPlugin-conforming event-local feature plugins.
 *
 * Validates every candidate against the PluginContract interface at
 * registration time (structurally enforcing maxLookahead=0 among other
 * requirements), so downstream consumers can trust that listed plugins
 * are well-formed without re-validating them on every call.
 */
export class EventFeatureRegistry {
  /** @type {Map<string, object>} name → plugin */
  #plugins = new Map();

  /**
   * Registers an event-local feature plugin.
   *
   * Throws EventFeatureRegistryError if:
   *   - the plugin does not conform to PluginContract (all reasons listed)
   *   - a plugin with the same metadata().name is already registered
   *
   * O(k) where k = REQUIRED_METHODS.length (constant 8) for contract check.
   *
   * @param {object} plugin - A ScientificPlugin-conforming object.
   * @returns {this} for chaining.
   */
  register(plugin) {
    const { valid, errors } = validatePlugin(plugin);
    if (!valid) {
      throw new EventFeatureRegistryError(
        `register: plugin does not conform to PluginContract — ${errors.join('; ')}`
      );
    }
    const name = plugin.metadata().name;
    if (this.#plugins.has(name)) {
      throw new EventFeatureRegistryError(
        `register: an event-feature plugin named "${name}" is already registered`
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

/**
 * Computes every registered event-local feature for one event, given only
 * that event and its immediate predecessor (or null, for the first event
 * in a session -- see refinement/Step-3's "NULL gaps on first event").
 *
 * This is the ONLY function that calls plugin.compute() for this registry
 * -- structurally enforcing the event-local-only contract: a plugin
 * receives exactly {event, previousEvent}, nothing else, so it has no way
 * to reach further back in history even if it wanted to.
 *
 * @param {EventFeatureRegistry} registry
 * @param {object} event - The current event record.
 * @param {object|null} previousEvent - The immediately preceding event in
 *   the SAME session, or null (first event of a session -- every feature
 *   correctly returns null/NaN for this case, not a crash).
 * @returns {Record<string, number|null>} pluginName -> computed value.
 */
export function computeEventLocalFeatures(registry, event, previousEvent) {
  if (!registry || typeof registry.list !== 'function') {
    throw new EventFeatureRegistryError('computeEventLocalFeatures: a valid EventFeatureRegistry is required');
  }
  if (!event) {
    throw new EventFeatureRegistryError('computeEventLocalFeatures: a valid current event is required');
  }
  const features = {};
  for (const plugin of registry.list()) {
    const { signal } = plugin.compute({ event, previousEvent });
    features[plugin.metadata().name] = signal;
  }
  return features;
}
