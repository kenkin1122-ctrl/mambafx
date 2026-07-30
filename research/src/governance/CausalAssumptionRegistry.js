/**
 * research/src/governance/CausalAssumptionRegistry.js
 *
 * Purpose:
 *   Central registry where every proxy, context, detector, and hypothesis
 *   declares its causal assumptions explicitly — directive requirement #33
 *   ("Causal Assumptions Registry for every relationship") and the
 *   corresponding Step-3 governance verification item, distinct from
 *   constraint #1's mechanical no-future-leakage check.
 *
 * Relationship to validation/CausalLeakageValidator.js (existing, Phase B,
 *   DO NOT REWRITE): CausalLeakageValidator answers a MECHANICAL question —
 *   "does this plugin's metadata().maxLookahead equal 0?" — a structural
 *   check computable without understanding what the plugin actually claims
 *   about the world. This registry answers a different, non-mechanical
 *   question — "what causal claim is this component making, in the
 *   author's own words, and can a reviewer see everything ever declared for
 *   it?" (e.g. "ConsecutiveUpTickClusterProxy assumes recent tick direction
 *   persistence reflects order-flow imbalance, not merely PRNG
 *   autocorrelation" — a substantive, falsifiable claim CausalLeakageValidator
 *   cannot express because it operates purely on maxLookahead). The two are
 *   complementary: registerAssumptions() below optionally cross-checks the
 *   declaring component's maxLookahead via CausalLeakageValidator when a
 *   `pluginRef` implementing PluginContract is supplied, but never
 *   reimplements that check itself.
 *
 * Dependencies: validation/CausalLeakageValidator.js (optional cross-check only).
 * Public API: CausalAssumptionRegistry, COMPONENT_TYPES,
 *   InvalidCausalAssumptionError.
 * Complexity: registerAssumptions O(1) (or O(1) amortized with the optional
 *   plugin cross-check, itself O(1)); query methods O(n) in registry size.
 */

import { validateCausalConstraint } from '../validation/CausalLeakageValidator.js';

/** Recognised categories of components that may declare causal assumptions. */
export const COMPONENT_TYPES = Object.freeze({
  PROXY:      'PROXY',
  CONTEXT:    'CONTEXT',
  DETECTOR:   'DETECTOR',
  HYPOTHESIS: 'HYPOTHESIS',
});

const VALID_COMPONENT_TYPES = new Set(Object.values(COMPONENT_TYPES));

export class InvalidCausalAssumptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCausalAssumptionError';
  }
}

/** A single immutable causal-assumption declaration. */
class CausalAssumptionEntry {
  constructor({ componentId, componentType, assumptions, maxLookahead, registeredAt, causalLeakageCheck }) {
    this.componentId = componentId;
    this.componentType = componentType;
    this.assumptions = Object.freeze([...assumptions]);
    this.maxLookahead = maxLookahead;
    this.registeredAt = registeredAt;
    this.causalLeakageCheck = causalLeakageCheck ? Object.freeze({ ...causalLeakageCheck }) : null;
    Object.freeze(this);
  }

  toJSON() {
    return {
      componentId: this.componentId,
      componentType: this.componentType,
      assumptions: this.assumptions,
      maxLookahead: this.maxLookahead,
      registeredAt: this.registeredAt,
      causalLeakageCheck: this.causalLeakageCheck,
    };
  }
}

export class CausalAssumptionRegistry {
  /** @type {Map<string, CausalAssumptionEntry>} componentId → latest declaration */
  #entries = new Map();
  /** @type {Map<string, CausalAssumptionEntry[]>} componentId → full declaration history */
  #history = new Map();

  /**
   * Declares the causal assumptions for a component. Re-registering the
   * same componentId records a new version in history and updates the
   * current entry (declarations may legitimately be refined as
   * understanding improves; the history preserves what was claimed when).
   * O(1), or O(1) amortized if `pluginRef` is supplied for cross-checking.
   *
   * @param {object} params
   * @param {string}   params.componentId    - Unique identifier (e.g. proxy id, context key).
   * @param {string}   params.componentType  - One of COMPONENT_TYPES.
   * @param {string[]} params.assumptions    - Non-empty array of explicit causal-assumption statements.
   * @param {number}   [params.maxLookahead=0] - Declared max lookahead; SHOULD be 0 per constraint #1.
   * @param {object}   [params.pluginRef]    - Optional object exposing a PluginContract-shaped
   *   `metadata()` method; if supplied, validateCausalConstraint() is invoked and its
   *   result attached as causalLeakageCheck (informational — this registry does not
   *   throw on a failed mechanical check, it records the fact for review; the
   *   authoritative gate remains CausalLeakageValidator itself when invoked directly).
   * @returns {CausalAssumptionEntry}
   */
  registerAssumptions({ componentId, componentType, assumptions, maxLookahead = 0, pluginRef } = {}) {
    const errors = [];
    if (!componentId || typeof componentId !== 'string') errors.push('componentId: required non-empty string');
    if (!VALID_COMPONENT_TYPES.has(componentType))
      errors.push(`componentType: must be one of [${[...VALID_COMPONENT_TYPES].join(', ')}]`);
    if (!Array.isArray(assumptions) || assumptions.length === 0 || assumptions.some(a => typeof a !== 'string' || !a.trim()))
      errors.push('assumptions: required non-empty array of non-empty strings');
    if (typeof maxLookahead !== 'number' || maxLookahead < 0)
      errors.push('maxLookahead: must be a non-negative number');
    if (errors.length) throw new InvalidCausalAssumptionError(errors.join('; '));

    let causalLeakageCheck = null;
    if (pluginRef) {
      const result = validateCausalConstraint(pluginRef, componentId);
      causalLeakageCheck = { valid: result.valid, errors: [...result.errors] };
    }

    const entry = new CausalAssumptionEntry({
      componentId, componentType, assumptions, maxLookahead,
      registeredAt: Date.now(), causalLeakageCheck,
    });

    this.#entries.set(componentId, entry);
    if (!this.#history.has(componentId)) this.#history.set(componentId, []);
    this.#history.get(componentId).push(entry);
    return entry;
  }

  /** @returns {CausalAssumptionEntry|undefined} Current declaration for a component. */
  get(componentId) {
    return this.#entries.get(componentId);
  }

  /** @returns {boolean} */
  isRegistered(componentId) {
    return this.#entries.has(componentId);
  }

  /** @returns {CausalAssumptionEntry[]} Full declaration history for a component, oldest first. */
  history(componentId) {
    return (this.#history.get(componentId) || []).slice();
  }

  /** @returns {CausalAssumptionEntry[]} All current declarations of a given component type. */
  listByType(componentType) {
    return [...this.#entries.values()].filter(e => e.componentType === componentType);
  }

  /** @returns {CausalAssumptionEntry[]} All current declarations. */
  all() {
    return [...this.#entries.values()];
  }

  /** @returns {number} */
  get size() {
    return this.#entries.size;
  }
}
