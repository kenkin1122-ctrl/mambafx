/**
 * research/src/candidate/MeasurementRegistry.js
 *
 * Purpose:
 *   Single source of truth for raw observable definitions in Phase 11.
 *   Every feature that any Candidate uses must ultimately trace back to one
 *   or more of the primitive observables registered here. Derived observables
 *   (moving averages, ratios, composite signals) are also registrable but are
 *   explicitly marked as non-primitive so the dependency chain remains auditable.
 *
 * Scientific rationale:
 *   A "measurement" in the scientific sense is a direct reading of reality —
 *   tick price, tick direction, tick size, timestamp, candle OHLC. Everything
 *   else is a transformation of these readings. Keeping the primitive layer
 *   explicit prevents "black-box" features whose true data dependencies are
 *   opaque, which would undermine causal-leakage auditing (CausalLeakageValidator,
 *   Phase B) and reproducibility verification.
 *
 *   The set of primitive observables corresponds exactly to what is available in
 *   the legacy msdGetAllStates() records (tick price, direction, size, timestamp;
 *   candle OHLC, start epoch, end epoch; tick interval, tick size) — see
 *   bridgeToLegacyMsd/read.js for the legacy bridge. No new data sources are
 *   assumed; Phase 11 derives all features from this fixed primitive set.
 *
 * Dependencies: none.
 * Public API: PRIMITIVE_OBSERVABLES, MeasurementRegistry, MeasurementRegistryError.
 * Complexity: O(1) for all operations (hash-set membership tests, fixed primitive count).
 */

/**
 * The complete set of raw, directly-observed primitives available to Phase 11.
 * No Candidate may use data that is not derivable from this set.
 *
 * Naming convention: <source>_<measurement> where source is 'tick' or 'candle'.
 */
export const PRIMITIVE_OBSERVABLES = Object.freeze({
  // ── Tick-level primitives ───────────────────────────────────────────────
  /** Raw mid-price at the moment a tick fires. */
  TICK_PRICE:      'tick_price',
  /** Direction of the tick: +1 (up) / -1 (down) / 0 (flat). */
  TICK_DIRECTION:  'tick_direction',
  /** Absolute price movement magnitude of the tick. */
  TICK_SIZE:       'tick_size',
  /** Unix epoch milliseconds of the tick timestamp. */
  TICK_TIMESTAMP:  'tick_timestamp',

  // ── Candle-level primitives ─────────────────────────────────────────────
  /** Candle open price. */
  CANDLE_OPEN:     'candle_open',
  /** Candle high price. */
  CANDLE_HIGH:     'candle_high',
  /** Candle low price. */
  CANDLE_LOW:      'candle_low',
  /** Candle close price. */
  CANDLE_CLOSE:    'candle_close',
  /** Unix epoch seconds of candle start (matches legacy datasetEpochMin convention). */
  CANDLE_START:    'candle_start',
  /** Unix epoch seconds of candle end. */
  CANDLE_END:      'candle_end',

  // ── Instrument-level primitives ─────────────────────────────────────────
  /** Minimum price increment for the instrument (e.g. 0.25 for ES futures). */
  TICK_INTERVAL:   'tick_interval',
});

/** Frozen set of all primitive observable names for O(1) membership testing. */
const PRIMITIVE_SET = Object.freeze(new Set(Object.values(PRIMITIVE_OBSERVABLES)));

export class MeasurementRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MeasurementRegistryError';
  }
}

/**
 * Registry of all observables (primitive + derived) available to Phase 11 candidates.
 * Maintains the full derivation chain so CausalLeakageValidator (Phase B) can audit
 * that no candidate uses data beyond maxLookahead = 0.
 *
 * One shared instance is created per campaign; Candidate instances reference it.
 * O(1) per registration and membership test.
 */
export class MeasurementRegistry {
  /** @type {Map<string, { name: string, description: string, isPrimitive: boolean, derivedFrom: string[] }>} */
  #observables = new Map();

  constructor() {
    // Auto-register all primitives.
    for (const [key, name] of Object.entries(PRIMITIVE_OBSERVABLES)) {
      this.#observables.set(name, {
        name,
        description: `Primitive observable: ${key}`,
        isPrimitive: true,
        derivedFrom: [],
      });
    }
  }

  /**
   * Registers a derived observable (a feature computed from one or more primitives
   * or other registered observables). Throws if any dependency is unregistered.
   *
   * O(k) where k = number of derivedFrom entries.
   *
   * @param {string}   name         - Unique observable name (snake_case).
   * @param {string}   description  - Human-readable description.
   * @param {string[]} derivedFrom  - Names of observables this is derived from (must already be registered).
   * @returns {this} for chaining.
   */
  register(name, description, derivedFrom = []) {
    if (!name || typeof name !== 'string')
      throw new MeasurementRegistryError('register: name must be a non-empty string');
    if (this.#observables.has(name))
      throw new MeasurementRegistryError(`register: "${name}" is already registered`);
    if (!Array.isArray(derivedFrom))
      throw new MeasurementRegistryError('register: derivedFrom must be an array');
    for (const dep of derivedFrom) {
      if (!this.#observables.has(dep))
        throw new MeasurementRegistryError(
          `register: dependency "${dep}" is not registered — register it before registering "${name}"`
        );
    }
    this.#observables.set(name, {
      name,
      description: description || '',
      isPrimitive: false,
      derivedFrom: [...derivedFrom],
    });
    return this;
  }

  /**
   * Returns true if the named observable is a primitive (directly observed, not derived).
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  isPrimitive(name) {
    const obs = this.#observables.get(name);
    return obs ? obs.isPrimitive : false;
  }

  /**
   * Returns true if the named observable is registered (primitive or derived).
   * O(1).
   * @param {string} name
   * @returns {boolean}
   */
  isRegistered(name) {
    return this.#observables.has(name);
  }

  /**
   * Returns the full spec for a registered observable, or undefined if not found.
   * O(1).
   * @param {string} name
   * @returns {{ name, description, isPrimitive, derivedFrom } | undefined}
   */
  get(name) {
    return this.#observables.get(name);
  }

  /**
   * Returns all registered observable names.
   * O(n) in the number of registered observables.
   * @returns {string[]}
   */
  listAll() {
    return [...this.#observables.keys()];
  }

  /**
   * Returns all primitive observable names.
   * O(p) where p = number of primitives (constant: currently 11).
   * @returns {string[]}
   */
  listPrimitives() {
    return [...PRIMITIVE_SET];
  }
}
