/**
 * research/src/context/ObservableContextDetector.js
 *
 * Purpose:
 *   Generic orchestrator that runs every plugin registered in a ContextRegistry
 *   uniformly over a shared inputs bundle. It never hardcodes which plugins
 *   exist — adding a new context plugin requires only registering it in the
 *   ContextRegistry. This file requires zero modifications when new plugins
 *   are added.
 *
 * Architectural contract:
 *   ObservableContextDetector knows NOTHING about specific plugins. It calls
 *   plugin.compute(inputs) on each registered plugin and collects results
 *   keyed by plugin name. No switch statements, no if-chains, no plugin-name
 *   checks. If you see a conditional dispatching on a specific plugin name
 *   in this file, that is a contract violation.
 *
 * Scientific rationale:
 *   Context detection is a composable, parallelizable operation: each plugin
 *   is an independent measurement of the market environment. Running all of
 *   them uniformly and collecting their results in a flat map ensures that:
 *     (a) no context variable is accidentally skipped,
 *     (b) adding / removing context variables is a pure registry operation,
 *     (c) the orchestrator is independently testable against any plugin set.
 *
 * Phase B scope:
 *   The runtime engine for all context plugins in Phase B.
 *
 * Dependencies: context/ContextRegistry.js (type only — no hardcoded plugin imports).
 * Public API: ObservableContextDetector.
 * Complexity: O(P·n) where P = number of registered plugins, n = states.length.
 */

/**
 * ObservableContextDetector — generic context orchestrator.
 *
 * Constructor takes a ContextRegistry and runs all registered plugins on
 * each call to detect(). No plugin-specific logic lives here.
 */
export class ObservableContextDetector {
  /** @type {import('./ContextRegistry.js').ContextRegistry} */
  #registry;

  /**
   * @param {import('./ContextRegistry.js').ContextRegistry} registry
   */
  constructor(registry) {
    if (!registry || typeof registry.list !== 'function') {
      throw new TypeError(
        'ObservableContextDetector: registry must be a ContextRegistry instance'
      );
    }
    this.#registry = registry;
  }

  /**
   * Runs every registered context plugin over the provided inputs.
   *
   * For each plugin p in registry.list():
   *   results[p.metadata().name] = p.compute(inputs)
   *
   * Plugins that throw are caught; their entry is set to
   * { error: <message>, pluginName: <name> } so a single failing plugin
   * does not abort the entire detection pass.
   *
   * O(P·n) where P = plugin count, n = inputs.states?.length.
   *
   * @param {object} inputs - Forwarded to every plugin's compute() unchanged.
   * @returns {{
   *   results: Record<string, object>,
   *   errors:  { pluginName: string, error: string }[],
   *   pluginCount: number
   * }}
   */
  detect(inputs) {
    const plugins = this.#registry.list();
    const results = {};
    const errors  = [];

    for (const plugin of plugins) {
      const name = plugin.metadata().name;
      try {
        results[name] = plugin.compute(inputs);
      } catch (e) {
        // Isolate plugin failures — one bad plugin must not stop others.
        results[name] = { error: e.message, pluginName: name };
        errors.push({ pluginName: name, error: e.message });
      }
    }

    return Object.freeze({
      results:     Object.freeze(results),
      errors,
      pluginCount: plugins.length,
    });
  }

  /**
   * Returns the names of all plugins that will run on the next detect() call.
   * O(n).
   * @returns {string[]}
   */
  registeredPluginNames() {
    return this.#registry.listNames();
  }
}
