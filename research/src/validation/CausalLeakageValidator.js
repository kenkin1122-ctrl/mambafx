/**
 * research/src/validation/CausalLeakageValidator.js
 *
 * Purpose:
 *   Dedicated governance module that enforces the maxLookahead=0 causal
 *   constraint across all plugin objects submitted for validation. Returns
 *   a structured { valid: boolean, errors: string[] } result — never throws —
 *   consistent with the ConfigValidator pattern established in Phase A.
 *
 *   "Causal leakage" in the context of Phase 11 means any plugin that accesses
 *   future data (maxLookahead > 0) when computing its features. Such a plugin
 *   would produce features that are impossible to compute in live trading or
 *   genuine out-of-sample testing, and any hypothesis confirmed using those
 *   features suffers from look-ahead bias — one of the most common and
 *   damaging failure modes in quantitative research.
 *
 * Design philosophy (matching ConfigValidator):
 *   - Never throw — return { valid: boolean, errors: string[] }.
 *   - Pure function over plain objects — works on any object with a metadata()
 *     method, whether it's a class instance or a plain object.
 *   - Report all violations at once rather than short-circuiting.
 *
 * Phase A resolution:
 *   This module was deferred from Phase A as item 13. It is implemented here
 *   as a governance validator (not as part of ContextRegistry or any registry)
 *   to keep causal enforcement separate from plugin registration, making it
 *   independently auditable.
 *
 * Dependencies: none.
 * Public API: validateCausalConstraint, validatePluginsBatch, CausalLeakageValidator.
 * Complexity: O(1) per plugin; O(P) for batch of P plugins.
 */

/**
 * Validates that a single plugin object satisfies the maxLookahead=0 constraint.
 *
 * Checks:
 *   1. plugin is a non-null object
 *   2. plugin.metadata is a callable function
 *   3. plugin.metadata() returns an object without throwing
 *   4. metadata().maxLookahead is exactly 0
 *
 * @param {object} plugin - Any object with a metadata() method.
 * @param {string} [pluginIdentifier] - Optional human-readable name for error messages.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCausalConstraint(plugin, pluginIdentifier) {
  const id = pluginIdentifier ?? '(unknown plugin)';

  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: [`${id}: expected a non-null object`] };
  }

  const errors = [];

  if (typeof plugin.metadata !== 'function') {
    errors.push(
      `${id}: plugin.metadata is not a function — cannot verify maxLookahead constraint`
    );
    return { valid: false, errors };
  }

  let meta;
  try {
    meta = plugin.metadata();
  } catch (e) {
    return {
      valid: false,
      errors: [`${id}: plugin.metadata() threw during validation — ${e.message}`],
    };
  }

  if (!meta || typeof meta !== 'object') {
    errors.push(`${id}: plugin.metadata() did not return an object`);
    return { valid: false, errors };
  }

  if (!('maxLookahead' in meta)) {
    errors.push(
      `${id}: metadata.maxLookahead is missing — all plugins must declare maxLookahead`
    );
  } else if (meta.maxLookahead !== 0) {
    errors.push(
      `${id}: metadata.maxLookahead=${meta.maxLookahead} violates the causal constraint ` +
      `(must be exactly 0). A plugin with maxLookahead>0 accesses future data and ` +
      `introduces look-ahead bias into any hypothesis tested using it.`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates an array of plugins in batch against the maxLookahead=0 constraint.
 * Returns a combined result with per-plugin details.
 *
 * O(P) where P = plugins.length.
 *
 * @param {object[]} plugins
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   perPlugin: Array<{ name: string, valid: boolean, errors: string[] }>
 * }}
 */
export function validatePluginsBatch(plugins) {
  if (!Array.isArray(plugins)) {
    return { valid: false, errors: ['plugins: expected an array'], perPlugin: [] };
  }

  const allErrors = [];
  const perPlugin = plugins.map((plugin, index) => {
    // Try to get the plugin name for better error messages.
    let name = `plugin[${index}]`;
    try {
      if (typeof plugin?.metadata === 'function') {
        const meta = plugin.metadata();
        if (meta?.name) name = meta.name;
      }
    } catch { /* keep default index-based name */ }

    const result = validateCausalConstraint(plugin, name);
    if (!result.valid) allErrors.push(...result.errors);
    return { name, valid: result.valid, errors: result.errors };
  });

  return {
    valid:     allErrors.length === 0,
    errors:    allErrors,
    perPlugin,
  };
}

/**
 * Namespace object grouping both validators.
 * Standalone function exports remain for direct-import convenience.
 */
export const CausalLeakageValidator = Object.freeze({
  validateCausalConstraint,
  validatePluginsBatch,
});
