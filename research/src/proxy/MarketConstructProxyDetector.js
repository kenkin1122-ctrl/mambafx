/**
 * research/src/proxy/MarketConstructProxyDetector.js
 *
 * Purpose:
 *   Generic orchestrator that runs every proxy plugin registered in a
 *   MarketConstructProxyRegistry uniformly over a shared inputs bundle.
 *   It never hardcodes which proxies exist — adding a new proxy requires
 *   only registering it in the registry; this file is never modified.
 *
 * Architectural contract:
 *   MarketConstructProxyDetector knows NOTHING about specific proxy plugins.
 *   It calls plugin.compute(inputs) on each registered plugin and collects
 *   results keyed by plugin name. No switch statements, no if-chains, no
 *   proxy-name checks anywhere in this file.
 *
 * Scientific rationale:
 *   Proxy detection is composable and independent by design. Each proxy
 *   measures a different facet of potential market construct activity; running
 *   them all uniformly and assembling results into a flat map lets downstream
 *   conditional hypothesis testing correlate any combination of proxies without
 *   the pipeline needing to know which proxies are active.
 *
 * Phase B scope:
 *   The runtime engine for all 10 core proxies and any future proxies.
 *
 * Dependencies: proxy/MarketConstructProxyRegistry.js (type only).
 * Public API: MarketConstructProxyDetector.
 * Complexity: O(P·n) where P = number of registered proxies, n = states.length.
 */

/**
 * MarketConstructProxyDetector — generic proxy orchestrator.
 *
 * Constructor takes a MarketConstructProxyRegistry and runs all registered
 * proxies on each call to detect(). No proxy-specific logic lives here.
 */
export class MarketConstructProxyDetector {
  /** @type {import('./MarketConstructProxyRegistry.js').MarketConstructProxyRegistry} */
  #registry;

  /**
   * @param {import('./MarketConstructProxyRegistry.js').MarketConstructProxyRegistry} registry
   */
  constructor(registry) {
    if (!registry || typeof registry.list !== 'function') {
      throw new TypeError(
        'MarketConstructProxyDetector: registry must be a MarketConstructProxyRegistry instance'
      );
    }
    this.#registry = registry;
  }

  /**
   * Runs every registered proxy plugin over the provided inputs.
   *
   * For each proxy p in registry.list():
   *   results[p.metadata().name] = p.compute(inputs)
   *
   * Plugins that throw are caught; their entry is set to
   * { error: <message>, pluginName: <name> } so a single failing proxy
   * does not abort the entire detection pass.
   *
   * O(P·n) where P = proxy count, n = inputs.states?.length.
   *
   * @param {object} inputs - Forwarded to every proxy's compute() unchanged.
   * @returns {{
   *   results:     Record<string, object>,
   *   errors:      { pluginName: string, error: string }[],
   *   proxyCount:  number
   * }}
   */
  detect(inputs) {
    const proxies = this.#registry.list();
    const results = {};
    const errors  = [];

    for (const proxy of proxies) {
      const name = proxy.metadata().name;
      try {
        results[name] = proxy.compute(inputs);
      } catch (e) {
        results[name] = { error: e.message, pluginName: name };
        errors.push({ pluginName: name, error: e.message });
      }
    }

    return Object.freeze({
      results:    Object.freeze(results),
      errors,
      proxyCount: proxies.length,
    });
  }

  /**
   * Returns the names of all proxies that will run on the next detect() call.
   * O(n).
   * @returns {string[]}
   */
  registeredProxyNames() {
    return this.#registry.listNames();
  }
}
