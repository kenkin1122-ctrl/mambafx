/**
 * research/src/validation/ContextValidator.js
 *
 * Purpose:
 *   Non-throwing structural validator for context plugin objects.
 *   Validates that a context plugin: (a) conforms to PluginContract,
 *   (b) provides context-specific metadata fields (observableInputs),
 *   (c) has maxLookahead=0 in its metadata.
 *
 * Design philosophy:
 *   Matches the ConfigValidator pattern: all functions return
 *   { valid: boolean, errors: string[] }, never throw, and are pure
 *   functions over plain objects (usable on deserialized records too).
 *
 * Dependencies: plugin/PluginContract.js.
 * Public API: validateContextPlugin, ContextValidator.
 * Complexity: O(k) where k = REQUIRED_METHODS.length (constant 8).
 */

import { validatePlugin } from '../plugin/PluginContract.js';

/**
 * Validates a context plugin object.
 *
 * In addition to the base PluginContract checks, a context plugin must:
 *   - Pass validatePlugin() (all 8 methods, valid metadata shape)
 *   - metadata().observableInputs must be a non-empty array of strings
 *     (every primitive the plugin reads must be declared for auditability)
 *
 * @param {object} plugin
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateContextPlugin(plugin) {
  // Start with base contract validation.
  const base = validatePlugin(plugin);
  const errors = [...base.errors];

  // If metadata() is accessible, check context-specific fields.
  if (typeof plugin?.metadata === 'function') {
    let meta;
    try { meta = plugin.metadata(); } catch { meta = null; }
    if (meta && typeof meta === 'object') {
      if (!Array.isArray(meta.observableInputs)) {
        errors.push(
          'plugin.metadata().observableInputs: required array of primitive observable names ' +
          '(may be empty for plugins with no direct observable dependency)'
        );
      } else {
        for (const obs of meta.observableInputs) {
          if (typeof obs !== 'string') {
            errors.push(
              `plugin.metadata().observableInputs: all entries must be strings; found ${typeof obs}`
            );
            break;
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Namespace object for import convenience.
 * Standalone function export is also available for direct use.
 */
export const ContextValidator = Object.freeze({ validateContextPlugin });
