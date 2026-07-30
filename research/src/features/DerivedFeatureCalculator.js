/**
 * research/src/features/DerivedFeatureCalculator.js
 *
 * Purpose:
 *   Factory functions that produce ScientificPlugin-conforming derived-feature
 *   plugins. Each plugin computes one time-series transformation (rolling variance,
 *   entropy, slope, acceleration, normalized candle position) over a numeric array
 *   produced by RawObservationExtractor. Each plugin carries a full three-form
 *   MachineReadableMathematics definition.
 *
 * Scientific rationale:
 *   Derived features should never be bundled into monolithic black-box extractors.
 *   By isolating each transformation as an independently validatable plugin, we can:
 *     (a) test each formula against hand-computed fixtures,
 *     (b) audit the dependency chain (each plugin declares its inputField),
 *     (c) swap or version individual indicators without touching the pipeline.
 *   All computations are strictly causal: a value at position t depends only on
 *   positions [t−w+1, t], never on [t+1, ...]. This enforces maxLookahead=0.
 *
 * Phase B scope:
 *   Provides the derived-feature layer for Phase B context and proxy detectors.
 *
 * Dependencies: plugin/MachineReadableMathematics.js.
 * Public API: createRollingVariancePlugin, createEntropyPlugin, createSlopePlugin,
 *   createAccelerationPlugin, createNormalizedCandlePositionPlugin,
 *   DERIVED_FEATURE_FACTORIES.
 * Complexity:
 *   rollingVariance — O(n·w) naïve; each plugin is used offline so acceptable.
 *   entropy         — O(n·w) per window.
 *   slope           — O(n·w) OLS over window.
 *   acceleration    — O(n·w) second difference.
 *   normalizedPos   — O(n) single pass.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Rolling window helper: returns an array of subarrays of length windowSize. */
function rollingWindows(arr, windowSize) {
  const windows = [];
  for (let i = windowSize - 1; i < arr.length; i++) {
    windows.push(arr.slice(i - windowSize + 1, i + 1));
  }
  return windows;
}

/** Sample mean of an array. Returns NaN for empty arrays. */
function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ── Rolling Variance ─────────────────────────────────────────────────────────

const ROLLING_VARIANCE_MATH = createMathDefinition({
  humanReadable:
    'Rolling sample variance over a window of w observations: ' +
    'the average squared deviation from the window mean.',
  symbolicExpression:
    String.raw`\hat{\sigma}^2_t = \frac{1}{w-1}\sum_{i=t-w+1}^{t}(x_i - \bar{x}_t)^2`,
  executableFormula: (window) => {
    if (window.length < 2) return NaN;
    const mu = mean(window);
    return window.reduce((s, v) => s + (v - mu) ** 2, 0) / (window.length - 1);
  },
  units: 'input² (e.g. price²)',
  domain: 'ℝ^w, w ≥ 2',
  range: 'ℝ≥0',
});

/**
 * Creates a rolling sample variance plugin.
 *
 * compute input:  { values: number[], windowSize?: number }
 * compute output: { variance: number[], windowSize: number, inputLength: number }
 *
 * Output length = max(0, values.length − windowSize + 1).
 * The first (windowSize − 1) positions have no output (insufficient history).
 *
 * @param {number} [defaultWindowSize=20]
 * @returns {object} ScientificPlugin
 */
export function createRollingVariancePlugin(defaultWindowSize = 20) {
  if (!Number.isInteger(defaultWindowSize) || defaultWindowSize < 2) {
    throw new RangeError('createRollingVariancePlugin: defaultWindowSize must be an integer ≥ 2');
  }
  return Object.freeze({
    metadata() {
      return Object.freeze({
        name: `RollingVariance_w${defaultWindowSize}`,
        version: '1.0.0',
        description: `Rolling sample variance with default window ${defaultWindowSize}.`,
        scientificAssumptions: [
          'Values are i.i.d. within each window (local stationarity assumption).',
          'maxLookahead=0: window [t−w+1, t] uses only past and present values.',
          'Bessel correction (÷(w−1)) is applied for sample variance.',
        ],
        dependencies: [],
        complexity: `O(n·w) where n=series length, w=${defaultWindowSize}`,
        validationStatus: 'THEORETICAL',
        maxLookahead: 0,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute({ values, windowSize } = {}) {
      if (!Array.isArray(values)) return { variance: [], error: 'values: expected array' };
      const w = (Number.isInteger(windowSize) && windowSize >= 2) ? windowSize : defaultWindowSize;
      const variance = rollingWindows(values, w).map(ROLLING_VARIANCE_MATH.executableFormula);
      return Object.freeze({ variance, windowSize: w, inputLength: values.length });
    },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() {
      return [{
        name: 'variance of constant series is 0',
        inputs: { values: [5, 5, 5, 5, 5], windowSize: 3 },
        expectedOutputShape: { variance: 'number[]' },
      }];
    },
    documentation() {
      return `Rolling sample variance (Bessel-corrected) over a window of ${defaultWindowSize}. ` +
        'LaTeX: ' + ROLLING_VARIANCE_MATH.symbolicExpression;
    },
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: ROLLING_VARIANCE_MATH,
  });
}

// ── Entropy (histogram approximation) ────────────────────────────────────────

const ENTROPY_MATH = createMathDefinition({
  humanReadable:
    'Approximate Shannon entropy of the value distribution within a rolling window, ' +
    'estimated via equal-width histogram binning.',
  symbolicExpression:
    String.raw`H_t = -\sum_{k=1}^{B} \hat{p}_k \log_2 \hat{p}_k, \quad \hat{p}_k = n_k / w`,
  executableFormula: (window, bins = 5) => {
    if (window.length < 2) return NaN;
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    if (hi === lo) return 0; // all values identical → zero entropy
    const binWidth = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of window) {
      const idx = Math.min(Math.floor((v - lo) / binWidth), bins - 1);
      counts[idx]++;
    }
    let h = 0;
    for (const c of counts) {
      if (c > 0) {
        const p = c / window.length;
        h -= p * Math.log2(p);
      }
    }
    return h;
  },
  units: 'bits',
  domain: 'ℝ^w, w ≥ 2',
  range: '[0, log₂(B)]',
});

/**
 * Creates a rolling entropy plugin.
 *
 * compute input:  { values: number[], windowSize?: number, bins?: number }
 * compute output: { entropy: number[], windowSize: number, bins: number }
 *
 * @param {number} [defaultWindowSize=20]
 * @param {number} [defaultBins=5]
 * @returns {object} ScientificPlugin
 */
export function createEntropyPlugin(defaultWindowSize = 20, defaultBins = 5) {
  if (!Number.isInteger(defaultWindowSize) || defaultWindowSize < 2)
    throw new RangeError('createEntropyPlugin: defaultWindowSize must be an integer ≥ 2');
  if (!Number.isInteger(defaultBins) || defaultBins < 2)
    throw new RangeError('createEntropyPlugin: defaultBins must be an integer ≥ 2');

  return Object.freeze({
    metadata() {
      return Object.freeze({
        name: `RollingEntropy_w${defaultWindowSize}_b${defaultBins}`,
        version: '1.0.0',
        description:
          `Approximate Shannon entropy over a rolling window of ${defaultWindowSize} ` +
          `with ${defaultBins} histogram bins.`,
        scientificAssumptions: [
          'Histogram binning is an approximation; true entropy requires infinite data.',
          'Equal-width bins assume a roughly uniform or unimodal local distribution.',
          'maxLookahead=0: window [t−w+1, t] contains no future values.',
        ],
        dependencies: [],
        complexity: `O(n·(w+B)) where n=series length, w=${defaultWindowSize}, B=${defaultBins}`,
        validationStatus: 'THEORETICAL',
        maxLookahead: 0,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute({ values, windowSize, bins } = {}) {
      if (!Array.isArray(values)) return { entropy: [], error: 'values: expected array' };
      const w = (Number.isInteger(windowSize) && windowSize >= 2) ? windowSize : defaultWindowSize;
      const b = (Number.isInteger(bins) && bins >= 2) ? bins : defaultBins;
      const entropy = rollingWindows(values, w).map(win => ENTROPY_MATH.executableFormula(win, b));
      return Object.freeze({ entropy, windowSize: w, bins: b, inputLength: values.length });
    },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() {
      return [{
        name: 'entropy of constant series is 0',
        inputs: { values: [3, 3, 3, 3, 3], windowSize: 4, bins: 3 },
        expectedOutputShape: { entropy: 'number[]' },
      }];
    },
    documentation() {
      return `Approximate rolling Shannon entropy. LaTeX: ${ENTROPY_MATH.symbolicExpression}`;
    },
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: ENTROPY_MATH,
  });
}

// ── Slope (OLS linear regression over window) ─────────────────────────────────

const SLOPE_MATH = createMathDefinition({
  humanReadable:
    'Ordinary least-squares slope of the series over a rolling window: ' +
    'the best-fit linear trend per unit time step.',
  symbolicExpression:
    String.raw`\hat{\beta}_t = \frac{\sum_{i=0}^{w-1}(i - \bar{i})(x_{t-w+1+i} - \bar{x}_t)}{\sum_{i=0}^{w-1}(i - \bar{i})^2}`,
  executableFormula: (window) => {
    const n = window.length;
    if (n < 2) return NaN;
    const iBar = (n - 1) / 2;
    const xBar = mean(window);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - iBar) * (window[i] - xBar);
      den += (i - iBar) ** 2;
    }
    return den === 0 ? 0 : num / den;
  },
  units: 'input/step (e.g. price/tick)',
  domain: 'ℝ^w, w ≥ 2',
  range: 'ℝ',
});

/**
 * Creates a rolling OLS slope plugin.
 *
 * compute input:  { values: number[], windowSize?: number }
 * compute output: { slope: number[], windowSize: number }
 *
 * @param {number} [defaultWindowSize=10]
 * @returns {object} ScientificPlugin
 */
export function createSlopePlugin(defaultWindowSize = 10) {
  if (!Number.isInteger(defaultWindowSize) || defaultWindowSize < 2)
    throw new RangeError('createSlopePlugin: defaultWindowSize must be an integer ≥ 2');

  return Object.freeze({
    metadata() {
      return Object.freeze({
        name: `RollingOLSSlope_w${defaultWindowSize}`,
        version: '1.0.0',
        description: `OLS linear slope over a rolling window of ${defaultWindowSize}.`,
        scientificAssumptions: [
          'Local linearity assumption: price moves approximately linearly within the window.',
          'Time steps are equally spaced (tick-indexed, not wall-clock).',
          'maxLookahead=0: slope at t uses only values [t−w+1, t].',
        ],
        dependencies: [],
        complexity: `O(n·w) where n=series length, w=${defaultWindowSize}`,
        validationStatus: 'THEORETICAL',
        maxLookahead: 0,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute({ values, windowSize } = {}) {
      if (!Array.isArray(values)) return { slope: [], error: 'values: expected array' };
      const w = (Number.isInteger(windowSize) && windowSize >= 2) ? windowSize : defaultWindowSize;
      const slope = rollingWindows(values, w).map(SLOPE_MATH.executableFormula);
      return Object.freeze({ slope, windowSize: w, inputLength: values.length });
    },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() {
      return [{
        name: 'slope of linear series equals step size',
        inputs: { values: [0, 1, 2, 3, 4], windowSize: 3 },
        expectedOutputShape: { slope: 'number[]' },
      }];
    },
    documentation() {
      return `Rolling OLS slope. LaTeX: ${SLOPE_MATH.symbolicExpression}`;
    },
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: SLOPE_MATH,
  });
}

// ── Acceleration (second finite difference) ───────────────────────────────────

const ACCELERATION_MATH = createMathDefinition({
  humanReadable:
    'Rolling mean of the second finite difference over a window: ' +
    'approximates the rate of change of the slope (curvature).',
  symbolicExpression:
    String.raw`a_t = \frac{1}{w-2}\sum_{i=t-w+3}^{t}(x_i - 2x_{i-1} + x_{i-2})`,
  executableFormula: (window) => {
    if (window.length < 3) return NaN;
    let sum = 0;
    let count = 0;
    for (let i = 2; i < window.length; i++) {
      sum += window[i] - 2 * window[i - 1] + window[i - 2];
      count++;
    }
    return count === 0 ? NaN : sum / count;
  },
  units: 'input/step² (e.g. price/tick²)',
  domain: 'ℝ^w, w ≥ 3',
  range: 'ℝ',
});

/**
 * Creates a rolling acceleration plugin.
 *
 * compute input:  { values: number[], windowSize?: number }
 * compute output: { acceleration: number[], windowSize: number }
 *
 * @param {number} [defaultWindowSize=10]
 * @returns {object} ScientificPlugin
 */
export function createAccelerationPlugin(defaultWindowSize = 10) {
  if (!Number.isInteger(defaultWindowSize) || defaultWindowSize < 3)
    throw new RangeError('createAccelerationPlugin: defaultWindowSize must be an integer ≥ 3');

  return Object.freeze({
    metadata() {
      return Object.freeze({
        name: `RollingAcceleration_w${defaultWindowSize}`,
        version: '1.0.0',
        description:
          `Mean of second finite differences over a rolling window of ${defaultWindowSize}.`,
        scientificAssumptions: [
          'Second finite difference is a noisy approximation of acceleration; ' +
          'small windows amplify noise.',
          'maxLookahead=0: window [t−w+1, t] contains no future values.',
        ],
        dependencies: [],
        complexity: `O(n·w) where n=series length, w=${defaultWindowSize}`,
        validationStatus: 'THEORETICAL',
        maxLookahead: 0,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute({ values, windowSize } = {}) {
      if (!Array.isArray(values)) return { acceleration: [], error: 'values: expected array' };
      const w = (Number.isInteger(windowSize) && windowSize >= 3) ? windowSize : defaultWindowSize;
      const acceleration = rollingWindows(values, w).map(ACCELERATION_MATH.executableFormula);
      return Object.freeze({ acceleration, windowSize: w, inputLength: values.length });
    },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() {
      return [{
        name: 'acceleration of constant-slope series is 0',
        inputs: { values: [0, 1, 2, 3, 4, 5], windowSize: 4 },
        expectedOutputShape: { acceleration: 'number[]' },
      }];
    },
    documentation() {
      return `Rolling acceleration via second finite differences. LaTeX: ${ACCELERATION_MATH.symbolicExpression}`;
    },
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: ACCELERATION_MATH,
  });
}

// ── Normalized Candle Position ────────────────────────────────────────────────

const NORMALIZED_POSITION_MATH = createMathDefinition({
  humanReadable:
    'Normalized position of the close price within the candle\'s high-low range: ' +
    '0 = at the low, 1 = at the high. Undefined when high equals low.',
  symbolicExpression:
    String.raw`p_t = \frac{c_t - l_t}{h_t - l_t}, \quad h_t \ne l_t`,
  executableFormula: (close, high, low) => {
    const range = high - low;
    if (range === 0) return NaN; // degenerate candle — undefined
    return (close - low) / range;
  },
  units: 'dimensionless [0, 1]',
  domain: 'close ∈ [low, high], high > low',
  range: '[0, 1]',
});

/**
 * Creates a normalized candle position plugin.
 *
 * compute input:  { candle_close: number[], candle_high: number[], candle_low: number[] }
 * compute output: { normalizedPosition: number[] }
 *
 * Arrays must be the same length (one entry per state record).
 *
 * @returns {object} ScientificPlugin
 */
export function createNormalizedCandlePositionPlugin() {
  return Object.freeze({
    metadata() {
      return Object.freeze({
        name: 'NormalizedCandlePosition',
        version: '1.0.0',
        description:
          'Normalized close position within the candle H-L range. ' +
          '0=close at low, 0.5=midpoint, 1=close at high.',
        scientificAssumptions: [
          'Close is always within [low, high] (guaranteed by candle construction).',
          'A value of NaN is returned for zero-range candles (high=low) to signal degenerate input.',
          'maxLookahead=0: uses only candle_close/high/low at time t.',
        ],
        dependencies: [],
        complexity: 'O(n) where n=number of state records',
        validationStatus: 'THEORETICAL',
        maxLookahead: 0,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute({ candle_close, candle_high, candle_low } = {}) {
      if (!Array.isArray(candle_close) || !Array.isArray(candle_high) || !Array.isArray(candle_low)) {
        return { normalizedPosition: [], error: 'candle_close, candle_high, candle_low: all must be arrays' };
      }
      const n = candle_close.length;
      const normalizedPosition = new Array(n);
      for (let i = 0; i < n; i++) {
        normalizedPosition[i] = NORMALIZED_POSITION_MATH.executableFormula(
          candle_close[i], candle_high[i], candle_low[i]
        );
      }
      return Object.freeze({ normalizedPosition, inputLength: n });
    },
    version() { return '1.0.0'; },
    dependencies() { return ['RawObservationExtractor']; },
    tests() {
      return [{
        name: 'close at midpoint → 0.5',
        inputs: { candle_close: [105], candle_high: [110], candle_low: [100] },
        expectedOutputShape: { normalizedPosition: 'number[]' },
      }];
    },
    documentation() {
      return `Normalized candle close position. LaTeX: ${NORMALIZED_POSITION_MATH.symbolicExpression}`;
    },
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: NORMALIZED_POSITION_MATH,
  });
}

// ── Named factory map for programmatic access ─────────────────────────────────

/**
 * Map of factory name → factory function for all derived feature plugins.
 * Consumers can iterate this map to register all available derived features
 * without importing each factory individually.
 *
 * @type {Readonly<Record<string, Function>>}
 */
export const DERIVED_FEATURE_FACTORIES = Object.freeze({
  RollingVariance:            createRollingVariancePlugin,
  RollingEntropy:             createEntropyPlugin,
  RollingOLSSlope:            createSlopePlugin,
  RollingAcceleration:        createAccelerationPlugin,
  NormalizedCandlePosition:   createNormalizedCandlePositionPlugin,
});
