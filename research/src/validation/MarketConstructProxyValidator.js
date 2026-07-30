/**
 * research/src/validation/MarketConstructProxyValidator.js
 *
 * Purpose:
 *   Non-throwing structural validator for market-construct proxy plugin objects.
 *   Validates that a proxy plugin: (a) conforms to PluginContract, (b) carries
 *   all proxy-specific scientific metadata fields required by Phase 11's honesty
 *   standard for proxies (disclaimer, assumedConstruct, failureModes, biases,
 *   causalAssumptions, measurementUncertainty, observableInputs).
 *
 * Design philosophy:
 *   Matches the ConfigValidator pattern: returns { valid: boolean, errors: string[] },
 *   never throws, pure function over plain objects.
 *
 *   Proxies have a higher metadata bar than plain context plugins because they
 *   make implicit causal claims. Every proxy must explicitly declare its assumed
 *   market construct AND a disclaimer that the signal is not proof of that construct.
 *
 * Dependencies: plugin/PluginContract.js.
 * Public API: validateMarketConstructProxy, MarketConstructProxyValidator.
 * Complexity: O(k) where k = REQUIRED_METHODS.length + proxy-specific field count.
 */

import { validatePlugin } from '../plugin/PluginContract.js';

/** Fields that every proxy plugin's metadata() must include beyond base PluginContract. */
const PROXY_REQUIRED_METADATA_FIELDS = Object.freeze([
  'displayName',
  'disclaimer',
  'observableInputs',
  'assumedConstruct',
  'failureModes',
  'biases',
  'confidenceLevel',
  'limitations',
  'causalAssumptions',
  'measurementUncertainty',
]);

const VALID_CONFIDENCE_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/**
 * Validates a market-construct proxy plugin.
 *
 * Checks (in order of specificity):
 *   1. Base PluginContract compliance (all 8 methods + metadata shape)
 *   2. All PROXY_REQUIRED_METADATA_FIELDS present
 *   3. disclaimer is a non-empty string (proxy honesty requirement)
 *   4. observableInputs is an array of strings
 *   5. failureModes, biases, causalAssumptions are arrays
 *   6. confidenceLevel is LOW/MEDIUM/HIGH
 *
 * @param {object} plugin
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMarketConstructProxy(plugin) {
  const base = validatePlugin(plugin);
  const errors = [...base.errors];

  if (typeof plugin?.metadata === 'function') {
    let meta;
    try { meta = plugin.metadata(); } catch { meta = null; }
    if (meta && typeof meta === 'object') {
      // Check all proxy-required metadata fields are present.
      for (const field of PROXY_REQUIRED_METADATA_FIELDS) {
        if (!(field in meta)) {
          errors.push(`plugin.metadata().${field}: required proxy metadata field is missing`);
        }
      }
      // Specific type checks on proxy fields.
      if ('disclaimer' in meta && (!meta.disclaimer || typeof meta.disclaimer !== 'string')) {
        errors.push(
          'plugin.metadata().disclaimer: required non-empty string (proxy honesty requirement)'
        );
      }
      if ('observableInputs' in meta && !Array.isArray(meta.observableInputs)) {
        errors.push('plugin.metadata().observableInputs: must be an array of string field names');
      }
      if ('failureModes' in meta && !Array.isArray(meta.failureModes)) {
        errors.push('plugin.metadata().failureModes: must be an array of strings');
      }
      if ('biases' in meta && !Array.isArray(meta.biases)) {
        errors.push('plugin.metadata().biases: must be an array of strings');
      }
      if ('causalAssumptions' in meta && !Array.isArray(meta.causalAssumptions)) {
        errors.push('plugin.metadata().causalAssumptions: must be an array of strings');
      }
      if (
        'confidenceLevel' in meta &&
        meta.confidenceLevel !== undefined &&
        !VALID_CONFIDENCE_LEVELS.includes(meta.confidenceLevel)
      ) {
        errors.push(
          `plugin.metadata().confidenceLevel: "${meta.confidenceLevel}" is not one of ` +
          VALID_CONFIDENCE_LEVELS.join(', ')
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Namespace object for import convenience.
 */
export const MarketConstructProxyValidator = Object.freeze({ validateMarketConstructProxy });
