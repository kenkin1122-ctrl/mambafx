/**
 * research/src/proxy/coreProxies.js
 *
 * Purpose:
 *   Defines all 10 core market-construct proxy plugins for Phase 11. Each
 *   plugin implements the ScientificPlugin interface and carries honest
 *   scientific metadata: assumptions, failure modes, biases, causal caveats,
 *   and a three-form MachineReadableMathematics definition.
 *
 * IMPORTANT DISCLAIMER (enforced in every plugin's metadata):
 *   These plugins are PROXIES — indirect measurements of hypothesised market
 *   constructs (support/resistance levels, institutional activity, etc.).
 *   They are NOT proof of any agent's behaviour. Observing a local minimum
 *   is consistent with — but does not confirm — the existence of a "support
 *   level". All causal claims require explicit scientific justification beyond
 *   the presence of the proxy signal.
 *
 * Scientific rationale:
 *   Market microstructure research (e.g. Kyle 1985, Easley & O'Hara 1987)
 *   suggests that several price patterns are consistent with hypothesised
 *   constructs like order-flow imbalances and informed trading. These proxies
 *   operationalize such patterns as computable features with explicit math
 *   so researchers can form conditional hypotheses, not just qualitative
 *   observations. Each proxy declares its scientific evidence tier honestly:
 *   most are HEURISTIC, meaning practitioner intuition with limited formal
 *   testing.
 *
 * Phase B scope:
 *   All 10 proxies are auto-registered in registerCoreProxies().
 *
 * Dependencies: plugin/MachineReadableMathematics.js, governance/implementationMaturity.js,
 *   governance/scientificEvidenceTiers.js.
 * Public API: CORE_PROXY_PLUGINS, registerCoreProxies.
 * Complexity:
 *   RecentLocalMinimum/Maximum — O(n·w) sliding window
 *   ConsecutiveCluster         — O(n) single pass
 *   LocalVolatilitySpike       — O(n·w) variance ratio
 *   RangeExpansion             — O(n·w) range ratio
 *   LocalExtremum              — O(n·w) union of min+max
 *   TickRateSurge              — O(n·w) rate ratio
 *   CompressionRelease         — O(n·w) two-phase window
 *   ActivityBurst              — O(n·w) combined signal
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

// ── Shared proxy disclaimer ──────────────────────────────────────────────────

const PROXY_DISCLAIMER =
  'This is a proxy measurement, NOT proof of agent behaviour or market-construct ' +
  'existence. Observing this signal is consistent with — but does not confirm — ' +
  'the hypothesised construct. All causal claims require explicit scientific ' +
  'justification.';

// ── Shared rolling-window helper ─────────────────────────────────────────────

/** Extract the w values ending at index i (inclusive). O(w). */
function windowEndingAt(arr, i, w) {
  const start = Math.max(0, i - w + 1);
  return arr.slice(start, i + 1);
}

/** Rolling mean of a numeric array. */
function rollingMean(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

/** Rolling variance (sample, Bessel-corrected). */
function rollingVariance(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = w - 1; i < arr.length; i++) {
    const win = arr.slice(i - w + 1, i + 1);
    const mu = win.reduce((s, v) => s + v, 0) / w;
    out[i] = win.reduce((s, v) => s + (v - mu) ** 2, 0) / (w - 1);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RecentLocalMinimumProxy
// ─────────────────────────────────────────────────────────────────────────────

const RLM_MATH = createMathDefinition({
  humanReadable:
    'Binary indicator: 1 if the current tick price is a new local minimum ' +
    'over the past w ticks (strictly less than all previous prices in the window).',
  symbolicExpression:
    String.raw`\mathbb{1}_{\text{LMin}}(t) = \mathbf{1}\!\left[P_t = \min_{i \in [t-w, t-1]} P_i - 1\right]`,
  executableFormula: (prices, t, w) => {
    if (t < 1) return 0;
    const lo = Math.max(0, t - w);
    for (let i = lo; i < t; i++) {
      if (prices[i] <= prices[t]) return 0;
    }
    return 1;
  },
  units: 'binary {0, 1}',
  domain: 'prices ∈ ℝ^n, t ∈ [1,n-1], w ≥ 1',
  range: '{0, 1}',
});

export const RecentLocalMinimumProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'RecentLocalMinimumProxy',
      displayName: 'Recent Local Minimum (Support Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects when the current tick price is a local minimum over a lookback window. ' +
        'Proxy for potential support levels or demand zones.',
      scientificAssumptions: [
        'Local price minima are consistent with — but not proof of — support levels.',
        'The lookback window w determines sensitivity vs. specificity of detection.',
        'maxLookahead=0: only prices up to and including time t are accessed.',
      ],
      dependencies:         [],
      complexity:           'O(n·w)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_price'],
      assumedConstruct:     'Support level / demand zone',
      failureModes:         ['False positives in ranging markets', 'Missed minima during fast trends'],
      biases:               ['Recency bias: short w overweights recent activity'],
      confidenceLevel:      'LOW',
      limitations:          'No adjustment for tick-interval variation or market microstructure noise.',
      causalAssumptions:    ['Price approaching a prior minimum attracts demand — untested assumption.'],
      measurementUncertainty: 'Signal frequency inversely proportional to w; no calibration procedure defined.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, windowSize = 10 } = {}) {
    if (!Array.isArray(states)) return { signal: [], error: 'states: expected array' };
    const prices = states.map(r => Number(r.tick_price));
    const signal = prices.map((_, t) => RLM_MATH.executableFormula(prices, t, windowSize));
    return Object.freeze({ signal, windowSize, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'new low at index 1 is detected', inputs: { states: [{ tick_price: 10 }, { tick_price: 5 }], windowSize: 5 }, expectedOutputShape: { signal: 'number[]' } }]; },
  documentation() { return `Detects local price minima. ${PROXY_DISCLAIMER} LaTeX: ${RLM_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: RLM_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RecentLocalMaximumProxy
// ─────────────────────────────────────────────────────────────────────────────

const RLX_MATH = createMathDefinition({
  humanReadable:
    'Binary indicator: 1 if the current tick price is a new local maximum ' +
    'over the past w ticks (strictly greater than all previous prices in the window).',
  symbolicExpression:
    String.raw`\mathbb{1}_{\text{LMax}}(t) = \mathbf{1}\!\left[P_t > \max_{i \in [t-w, t-1]} P_i\right]`,
  executableFormula: (prices, t, w) => {
    if (t < 1) return 0;
    const lo = Math.max(0, t - w);
    for (let i = lo; i < t; i++) {
      if (prices[i] >= prices[t]) return 0;
    }
    return 1;
  },
  units: 'binary {0, 1}',
  domain: 'prices ∈ ℝ^n, t ∈ [1,n-1], w ≥ 1',
  range: '{0, 1}',
});

export const RecentLocalMaximumProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'RecentLocalMaximumProxy',
      displayName: 'Recent Local Maximum (Resistance Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects when the current tick price is a local maximum over a lookback window. ' +
        'Proxy for potential resistance levels or supply zones.',
      scientificAssumptions: [
        'Local price maxima are consistent with — but not proof of — resistance levels.',
        'maxLookahead=0: only prices up to and including time t are accessed.',
      ],
      dependencies:         [],
      complexity:           'O(n·w)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_price'],
      assumedConstruct:     'Resistance level / supply zone',
      failureModes:         ['False positives in trending markets', 'Delayed detection with large w'],
      biases:               ['Recency bias: short w overweights recent activity'],
      confidenceLevel:      'LOW',
      limitations:          'Symmetric counterpart to RecentLocalMinimumProxy; same caveats apply.',
      causalAssumptions:    ['Price approaching a prior maximum attracts supply — untested.'],
      measurementUncertainty: 'Frequency depends on w; no calibration defined.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, windowSize = 10 } = {}) {
    if (!Array.isArray(states)) return { signal: [], error: 'states: expected array' };
    const prices = states.map(r => Number(r.tick_price));
    const signal = prices.map((_, t) => RLX_MATH.executableFormula(prices, t, windowSize));
    return Object.freeze({ signal, windowSize, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'new high at index 1 is detected', inputs: { states: [{ tick_price: 5 }, { tick_price: 10 }], windowSize: 5 }, expectedOutputShape: { signal: 'number[]' } }]; },
  documentation() { return `Detects local price maxima. ${PROXY_DISCLAIMER} LaTeX: ${RLX_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: RLX_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ConsecutiveUpTickClusterProxy
// ─────────────────────────────────────────────────────────────────────────────

const CUTC_MATH = createMathDefinition({
  humanReadable:
    'Count of the current consecutive run of up ticks (tick_direction = +1). ' +
    'Resets to 0 on any non-up tick.',
  symbolicExpression:
    String.raw`R^+_t = \begin{cases} R^+_{t-1} + 1 & d_t = +1 \\ 0 & \text{otherwise} \end{cases}`,
  executableFormula: (directions) => {
    const run = new Array(directions.length).fill(0);
    for (let i = 0; i < directions.length; i++) {
      run[i] = directions[i] === 1 ? (i > 0 ? run[i - 1] + 1 : 1) : 0;
    }
    return run;
  },
  units: 'ticks (count)',
  domain: 'directions ∈ {-1, 0, +1}^n',
  range: 'ℤ≥0',
});

export const ConsecutiveUpTickClusterProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'ConsecutiveUpTickClusterProxy',
      displayName: 'Consecutive Up-Tick Cluster (Buying Pressure Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Counts the current run length of consecutive up ticks. ' +
        'Proxy for potential concentrated buying pressure or order-flow imbalance.',
      scientificAssumptions: [
        'Consecutive up ticks are consistent with — but not proof of — institutional buying.',
        'tick_direction encodes +1 (up), -1 (down), 0 (flat) per MeasurementRegistry.',
        'maxLookahead=0: uses only tick_direction at and before time t.',
      ],
      dependencies:         [],
      complexity:           'O(n)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_direction'],
      assumedConstruct:     'Concentrated buying pressure / informed buying',
      failureModes:         ['Run counts inflate in low-liquidity trending markets with no actual clustering'],
      biases:               ['Does not account for tick size; a run of small up ticks may be noise'],
      confidenceLevel:      'LOW',
      limitations:          'Pure directional count; ignores tick magnitude.',
      causalAssumptions:    ['Consecutive up ticks reflect sustained demand — a microstructure assumption.'],
      measurementUncertainty: 'Run length is unbounded; normalisation is caller\'s responsibility.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states } = {}) {
    if (!Array.isArray(states)) return { runLength: [], error: 'states: expected array' };
    const directions = states.map(r => Number(r.tick_direction));
    const runLength = CUTC_MATH.executableFormula(directions);
    return Object.freeze({ runLength, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'three consecutive up ticks → run=3', inputs: { states: [{ tick_direction: 1 }, { tick_direction: 1 }, { tick_direction: 1 }] }, expectedOutputShape: { runLength: 'number[]' } }]; },
  documentation() { return `Consecutive up-tick run counter. ${PROXY_DISCLAIMER} LaTeX: ${CUTC_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: CUTC_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ConsecutiveDownTickClusterProxy
// ─────────────────────────────────────────────────────────────────────────────

const CDTC_MATH = createMathDefinition({
  humanReadable:
    'Count of the current consecutive run of down ticks (tick_direction = -1). ' +
    'Resets to 0 on any non-down tick.',
  symbolicExpression:
    String.raw`R^-_t = \begin{cases} R^-_{t-1} + 1 & d_t = -1 \\ 0 & \text{otherwise} \end{cases}`,
  executableFormula: (directions) => {
    const run = new Array(directions.length).fill(0);
    for (let i = 0; i < directions.length; i++) {
      run[i] = directions[i] === -1 ? (i > 0 ? run[i - 1] + 1 : 1) : 0;
    }
    return run;
  },
  units: 'ticks (count)',
  domain: 'directions ∈ {-1, 0, +1}^n',
  range: 'ℤ≥0',
});

export const ConsecutiveDownTickClusterProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'ConsecutiveDownTickClusterProxy',
      displayName: 'Consecutive Down-Tick Cluster (Selling Pressure Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Counts the current run length of consecutive down ticks. ' +
        'Proxy for potential concentrated selling pressure or order-flow imbalance.',
      scientificAssumptions: [
        'Consecutive down ticks are consistent with — but not proof of — institutional selling.',
        'maxLookahead=0: uses only tick_direction at and before time t.',
      ],
      dependencies:         [],
      complexity:           'O(n)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_direction'],
      assumedConstruct:     'Concentrated selling pressure / informed selling',
      failureModes:         ['Inflated counts in weak trending / illiquid conditions'],
      biases:               ['Ignores tick magnitude; large drops may equal small drops in count'],
      confidenceLevel:      'LOW',
      limitations:          'Symmetric counterpart to ConsecutiveUpTickClusterProxy.',
      causalAssumptions:    ['Consecutive down ticks reflect sustained supply — a microstructure assumption.'],
      measurementUncertainty: 'Unbounded run length; no calibration threshold defined.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states } = {}) {
    if (!Array.isArray(states)) return { runLength: [], error: 'states: expected array' };
    const directions = states.map(r => Number(r.tick_direction));
    const runLength = CDTC_MATH.executableFormula(directions);
    return Object.freeze({ runLength, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'three consecutive down ticks → run=3', inputs: { states: [{ tick_direction: -1 }, { tick_direction: -1 }, { tick_direction: -1 }] }, expectedOutputShape: { runLength: 'number[]' } }]; },
  documentation() { return `Consecutive down-tick run counter. ${PROXY_DISCLAIMER} LaTeX: ${CDTC_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: CDTC_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. LocalVolatilitySpikeProxy
// ─────────────────────────────────────────────────────────────────────────────

const LVS_MATH = createMathDefinition({
  humanReadable:
    'Ratio of short-window variance to long-window variance of tick price. ' +
    'Values > 1 indicate a local volatility spike relative to recent baseline.',
  symbolicExpression:
    String.raw`V_t = \frac{\hat{\sigma}^2_{[t-w_s, t]}}{\hat{\sigma}^2_{[t-w_l, t]}}, \quad w_s < w_l`,
  executableFormula: (shortVar, longVar) => {
    if (longVar === 0 || longVar === null) return NaN;
    return shortVar / longVar;
  },
  units: 'dimensionless ratio',
  domain: 'shortVar ≥ 0, longVar > 0',
  range: 'ℝ≥0',
});

export const LocalVolatilitySpikeProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'LocalVolatilitySpikeProxy',
      displayName: 'Local Volatility Spike (Regime Change Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects a local spike in tick-price variance relative to a longer-term baseline. ' +
        'Proxy for potential regime changes, news events, or liquidity shocks.',
      scientificAssumptions: [
        'Short-window variance captures local turbulence; long-window captures baseline.',
        'Variance ratio > spikeThreshold is operationalised as a "spike".',
        'maxLookahead=0: both windows end at time t.',
      ],
      dependencies:         [],
      complexity:           'O(n·(w_s + w_l))',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_price'],
      assumedConstruct:     'Volatility regime change / news shock',
      failureModes:         ['False positives at candle boundaries where price gaps', 'GARCH effects not modelled'],
      biases:               ['Ratio inflates when long-window variance is near zero (calm markets)'],
      confidenceLevel:      'LOW',
      limitations:          'No heavy-tail correction; Gaussian variance assumption.',
      causalAssumptions:    ['Variance spikes proxy for information arrival — academic assumption (Kyle 1985).'],
      measurementUncertainty: 'Choice of w_s and w_l is arbitrary; sensitivity analysis recommended.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, shortWindow = 5, longWindow = 20, spikeThreshold = 2.0 } = {}) {
    if (!Array.isArray(states)) return { varianceRatio: [], spikeDetected: [], error: 'states: expected array' };
    const prices = states.map(r => Number(r.tick_price));
    const shortVar = rollingVariance(prices, shortWindow);
    const longVar  = rollingVariance(prices, longWindow);
    const varianceRatio  = shortVar.map((sv, i) => LVS_MATH.executableFormula(sv, longVar[i]));
    const spikeDetected  = varianceRatio.map(vr => Number.isFinite(vr) && vr > spikeThreshold ? 1 : 0);
    return Object.freeze({ varianceRatio, spikeDetected, shortWindow, longWindow, spikeThreshold, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'constant price → variance ratio is NaN (zero baseline)', inputs: { states: Array(25).fill({ tick_price: 100 }), shortWindow: 5, longWindow: 20 }, expectedOutputShape: { varianceRatio: 'number[]' } }]; },
  documentation() { return `Variance ratio spike detector. ${PROXY_DISCLAIMER} LaTeX: ${LVS_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: LVS_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. RangeExpansionProxy
// ─────────────────────────────────────────────────────────────────────────────

const RE_MATH = createMathDefinition({
  humanReadable:
    'Ratio of the current candle\'s high-low range to the rolling average ' +
    'range over the past w candles. Values > 1 indicate range expansion.',
  symbolicExpression:
    String.raw`\rho_t = \frac{H_t - L_t}{\overline{(H - L)}_{[t-w, t-1]}}`,
  executableFormula: (currentRange, avgPriorRange) => {
    if (avgPriorRange === 0 || !Number.isFinite(avgPriorRange)) return NaN;
    return currentRange / avgPriorRange;
  },
  units: 'dimensionless ratio',
  domain: 'currentRange ≥ 0, avgPriorRange > 0',
  range: 'ℝ≥0',
});

export const RangeExpansionProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'RangeExpansionProxy',
      displayName: 'Range Expansion (Breakout / Momentum Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects expansion of the current candle\'s H-L range relative to recent average. ' +
        'Proxy for potential breakouts, momentum events, or increased participation.',
      scientificAssumptions: [
        'Candle range expansion is consistent with — but not proof of — breakout activity.',
        'Comparison is against rolling average of prior-candle ranges (causal, w candles back).',
        'maxLookahead=0: current candle H-L is the running range up to time t.',
      ],
      dependencies:         [],
      complexity:           'O(n·w)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['candle_high', 'candle_low'],
      assumedConstruct:     'Price breakout / momentum surge',
      failureModes:         ['A single outlier candle distorts the rolling average for w periods'],
      biases:               ['Sensitive to w choice; small w overreacts to single large candles'],
      confidenceLevel:      'LOW',
      limitations:          'No volume confirmation; range expansion without volume may be noise.',
      causalAssumptions:    ['Range expansion signals increased price uncertainty or new information.'],
      measurementUncertainty: 'Average range is arithmetic mean — median would be more robust to outliers.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, windowSize = 10, expansionThreshold = 1.5 } = {}) {
    if (!Array.isArray(states)) return { rangeRatio: [], expansionDetected: [], error: 'states: expected array' };
    const ranges = states.map(r => Number(r.candle_high) - Number(r.candle_low));
    const avgRange = rollingMean(ranges, windowSize);
    // Compare current range against average of PRIOR window (shift by 1 to avoid lookahead).
    const rangeRatio = ranges.map((r, i) => {
      const priorAvg = i >= windowSize ? avgRange[i - 1] : NaN;
      return RE_MATH.executableFormula(r, priorAvg);
    });
    const expansionDetected = rangeRatio.map(rr => Number.isFinite(rr) && rr > expansionThreshold ? 1 : 0);
    return Object.freeze({ rangeRatio, expansionDetected, windowSize, expansionThreshold, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'wide candle after narrow candles is detected', inputs: { states: [...Array(10).fill({ candle_high: 101, candle_low: 100 }), { candle_high: 115, candle_low: 100 }], windowSize: 5, expansionThreshold: 2 }, expectedOutputShape: { rangeRatio: 'number[]' } }]; },
  documentation() { return `Range expansion ratio detector. ${PROXY_DISCLAIMER} LaTeX: ${RE_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: RE_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. LocalExtremumProxy
// ─────────────────────────────────────────────────────────────────────────────

const LEX_MATH = createMathDefinition({
  humanReadable:
    'Union signal: 1 if the current tick is either a local minimum OR a local ' +
    'maximum over the lookback window w.',
  symbolicExpression:
    String.raw`E_t = \mathbb{1}_{\text{LMin}}(t) \lor \mathbb{1}_{\text{LMax}}(t)`,
  executableFormula: (isMin, isMax) => (isMin || isMax) ? 1 : 0,
  units: 'binary {0, 1}',
  domain: 'isMin ∈ {0,1}, isMax ∈ {0,1}',
  range: '{0, 1}',
});

export const LocalExtremumProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'LocalExtremumProxy',
      displayName: 'Local Extremum (Inflection Point Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects whether the current tick is a local minimum OR maximum. ' +
        'Proxy for potential price inflection points.',
      scientificAssumptions: [
        'Local extrema are consistent with — but not proof of — inflection points or turning points.',
        'maxLookahead=0: depends on RecentLocalMinimumProxy and RecentLocalMaximumProxy signals.',
      ],
      dependencies:         ['RecentLocalMinimumProxy', 'RecentLocalMaximumProxy'],
      complexity:           'O(n·w)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_price'],
      assumedConstruct:     'Price inflection point / turning point',
      failureModes:         ['High signal frequency in choppy markets; most extrema are noise'],
      biases:               ['Equally treats minor and major extrema without magnitude weighting'],
      confidenceLevel:      'LOW',
      limitations:          'No confirmation mechanism; requires downstream filtering.',
      causalAssumptions:    ['Extrema mark the boundaries of supply/demand imbalances.'],
      measurementUncertainty: 'Same w dependency as component proxies.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, windowSize = 10 } = {}) {
    if (!Array.isArray(states)) return { signal: [], error: 'states: expected array' };
    const prices = states.map(r => Number(r.tick_price));
    const isMin = prices.map((_, t) => RLM_MATH.executableFormula(prices, t, windowSize));
    const isMax = prices.map((_, t) => RLX_MATH.executableFormula(prices, t, windowSize));
    const signal = isMin.map((mn, i) => LEX_MATH.executableFormula(mn, isMax[i]));
    return Object.freeze({ signal, isLocalMin: isMin, isLocalMax: isMax, windowSize, stateCount: states.length });
  },
  version()  { return '1.0.0'; },
  dependencies() { return ['RecentLocalMinimumProxy', 'RecentLocalMaximumProxy']; },
  tests() { return [{ name: 'extremum detected at local min or max', inputs: { states: [{ tick_price: 10 }, { tick_price: 5 }, { tick_price: 10 }], windowSize: 5 }, expectedOutputShape: { signal: 'number[]' } }]; },
  documentation() { return `Local extremum union detector. ${PROXY_DISCLAIMER} LaTeX: ${LEX_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: LEX_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. TickRateSurgeProxy
// ─────────────────────────────────────────────────────────────────────────────

const TRS_MATH = createMathDefinition({
  humanReadable:
    'Ratio of recent tick rate (ticks per second in a short window) to ' +
    'baseline tick rate (long window). Values > 1 indicate a surge.',
  symbolicExpression:
    String.raw`\tau_t = \frac{n_{[t-w_s,t]} / (T_t - T_{t-w_s})}{n_{[t-w_l,t]} / (T_t - T_{t-w_l})}`,
  executableFormula: (shortRate, longRate) => {
    if (!longRate || longRate === 0) return NaN;
    return shortRate / longRate;
  },
  units: 'dimensionless ratio',
  domain: 'shortRate ≥ 0, longRate > 0',
  range: 'ℝ≥0',
});

export const TickRateSurgeProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'TickRateSurgeProxy',
      displayName: 'Tick Rate Surge (Activity Surge Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects a surge in tick arrival rate relative to a rolling baseline. ' +
        'Proxy for potential information events, news, or concentrated order flow.',
      scientificAssumptions: [
        'tick_timestamp enables computation of inter-tick intervals and rates.',
        'Short/long window tick counts divided by elapsed time approximate tick rate.',
        'maxLookahead=0: uses only timestamps up to time t.',
      ],
      dependencies:         [],
      complexity:           'O(n)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_timestamp'],
      assumedConstruct:     'Information event / concentrated order flow',
      failureModes:         ['Rate computation degenerates when timestamps are equal (batch delivery)'],
      biases:               ['Confounds genuine surges with data-feed artifacts'],
      confidenceLevel:      'LOW',
      limitations:          'Uses count-based rate; does not weight by tick_size.',
      causalAssumptions:    ['Elevated tick rates proxy for increased market participation.'],
      measurementUncertainty: 'Sensitive to data-feed delivery patterns; not a real-time measure.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, shortWindow = 5, longWindow = 20, surgeThreshold = 2.0 } = {}) {
    if (!Array.isArray(states)) return { rateRatio: [], surgeDetected: [], error: 'states: expected array' };
    const n = states.length;
    const ts = states.map(r => Number(r.tick_timestamp));
    const rateRatio = new Array(n).fill(NaN);
    const surgeDetected = new Array(n).fill(0);
    for (let i = longWindow; i < n; i++) {
      const dtShort = ts[i] - ts[Math.max(0, i - shortWindow)];
      const dtLong  = ts[i] - ts[Math.max(0, i - longWindow)];
      const shortRate = dtShort > 0 ? shortWindow / dtShort : NaN;
      const longRate  = dtLong  > 0 ? longWindow  / dtLong  : NaN;
      rateRatio[i] = TRS_MATH.executableFormula(shortRate, longRate);
      surgeDetected[i] = Number.isFinite(rateRatio[i]) && rateRatio[i] > surgeThreshold ? 1 : 0;
    }
    return Object.freeze({ rateRatio, surgeDetected, shortWindow, longWindow, surgeThreshold, stateCount: n });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'returns rateRatio array of correct length', inputs: { states: Array(25).fill({ tick_timestamp: 1000 }), shortWindow: 5, longWindow: 20 }, expectedOutputShape: { rateRatio: 'number[]' } }]; },
  documentation() { return `Tick rate surge detector. ${PROXY_DISCLAIMER} LaTeX: ${TRS_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: TRS_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CompressionReleaseProxy
// ─────────────────────────────────────────────────────────────────────────────

const CR_MATH = createMathDefinition({
  humanReadable:
    'Two-phase pattern: compression (low range in window w1) followed by ' +
    'release (high range in window w2). Detected when the release-window range ' +
    'exceeds a multiple of the compression-window range.',
  symbolicExpression:
    String.raw`C_t = \mathbf{1}\!\left[\frac{R_{[t-w_2,t]}}{R_{[t-w_1-w_2,t-w_2]}} > k\right]`,
  executableFormula: (compressionRange, releaseRange, k) => {
    if (compressionRange === 0 || !Number.isFinite(compressionRange)) return NaN;
    return releaseRange / compressionRange > k ? 1 : 0;
  },
  units: 'binary {0, 1}',
  domain: 'compressionRange > 0, releaseRange ≥ 0, k > 1',
  range: '{0, 1}',
});

export const CompressionReleaseProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'CompressionReleaseProxy',
      displayName: 'Compression-Release (Volatility Coiling Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects a compression phase (low range) followed by a release phase (range expansion). ' +
        'Proxy for potential coiling / spring patterns preceding directional moves.',
      scientificAssumptions: [
        'Compression precedes releases in some market regimes (e.g. equilibrium before news).',
        'Two non-overlapping windows measure prior compression and current release.',
        'maxLookahead=0: both windows end at time t.',
      ],
      dependencies:         [],
      complexity:           'O(n·(w_1+w_2))',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['candle_high', 'candle_low'],
      assumedConstruct:     'Volatility coiling / spring-loaded move preparation',
      failureModes:         ['Requires genuine compression phase; false negatives in trending markets'],
      biases:               ['k threshold is arbitrary; sensitivity analysis required'],
      confidenceLevel:      'LOW',
      limitations:          'Does not distinguish direction of release.',
      causalAssumptions:    ['Compression reflects equilibrium before information arrival.'],
      measurementUncertainty: 'Depends jointly on w_1, w_2, and k — three free parameters.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, compressionWindow = 10, releaseWindow = 5, multiplier = 2.0 } = {}) {
    if (!Array.isArray(states)) return { signal: [], error: 'states: expected array' };
    const n = states.length;
    const ranges = states.map(r => Number(r.candle_high) - Number(r.candle_low));
    const signal = new Array(n).fill(0);
    const totalWindow = compressionWindow + releaseWindow;
    for (let i = totalWindow - 1; i < n; i++) {
      const compressionSlice = ranges.slice(i - totalWindow + 1, i - releaseWindow + 1);
      const releaseSlice     = ranges.slice(i - releaseWindow + 1, i + 1);
      const comprRange = Math.max(...compressionSlice) - Math.min(...compressionSlice);
      const relRange   = Math.max(...releaseSlice)     - Math.min(...releaseSlice);
      signal[i] = CR_MATH.executableFormula(comprRange, relRange, multiplier);
    }
    return Object.freeze({ signal, compressionWindow, releaseWindow, multiplier, stateCount: n });
  },
  version()  { return '1.0.0'; },
  dependencies() { return []; },
  tests() { return [{ name: 'returns signal array of correct length', inputs: { states: Array(20).fill({ candle_high: 101, candle_low: 100 }), compressionWindow: 10, releaseWindow: 5 }, expectedOutputShape: { signal: 'number[]' } }]; },
  documentation() { return `Compression-release pattern detector. ${PROXY_DISCLAIMER} LaTeX: ${CR_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: CR_MATH,
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. ActivityBurstProxy
// ─────────────────────────────────────────────────────────────────────────────

const AB_MATH = createMathDefinition({
  humanReadable:
    'Combined activity burst: 1 if BOTH the tick-rate ratio AND the range ' +
    'expansion ratio exceed their respective thresholds simultaneously.',
  symbolicExpression:
    String.raw`A_t = \mathbf{1}\!\left[\tau_t > \theta_\tau\right] \land \mathbf{1}\!\left[\rho_t > \theta_\rho\right]`,
  executableFormula: (tickRateSurge, rangeExpansion) => (tickRateSurge && rangeExpansion) ? 1 : 0,
  units: 'binary {0, 1}',
  domain: 'tickRateSurge ∈ {0,1}, rangeExpansion ∈ {0,1}',
  range: '{0, 1}',
});

export const ActivityBurstProxy = Object.freeze({
  metadata() {
    return Object.freeze({
      name:        'ActivityBurstProxy',
      displayName: 'Activity Burst (Combined Participation Proxy)',
      disclaimer:  PROXY_DISCLAIMER,
      version:     '1.0.0',
      description:
        'Detects simultaneous surges in tick rate AND range expansion. ' +
        'Proxy for potential high-participation events (e.g. news, catalogue events).',
      scientificAssumptions: [
        'Concurrent tick-rate and range surge is a stronger proxy than either alone.',
        'Depends on TickRateSurgeProxy and RangeExpansionProxy signals.',
        'maxLookahead=0: all component signals use only data up to time t.',
      ],
      dependencies:         ['TickRateSurgeProxy', 'RangeExpansionProxy'],
      complexity:           'O(n·w)',
      validationStatus:     'HEURISTIC',
      maxLookahead:         0,
      observableInputs:     ['tick_timestamp', 'candle_high', 'candle_low'],
      assumedConstruct:     'High-participation event / information arrival',
      failureModes:         ['Requires both signals to fire; may miss range-only or rate-only events'],
      biases:               ['AND logic makes this stricter but less sensitive than either component'],
      confidenceLevel:      'LOW',
      limitations:          'No directional information; burst is unsigned.',
      causalAssumptions:    ['Joint surges in rate and range reflect genuine information events.'],
      measurementUncertainty: 'Inherits uncertainty from both component proxies.',
      scientificEvidenceTier: 'E1',
      implementationMaturity: 'Prototype',
    });
  },
  validate() { return { valid: true, errors: [] }; },
  compute({ states, shortWindow = 5, longWindow = 20, rateThreshold = 2.0, rangeThreshold = 1.5 } = {}) {
    if (!Array.isArray(states)) return { signal: [], error: 'states: expected array' };
    // Compute component signals independently.
    const trsResult = TickRateSurgeProxy.compute({ states, shortWindow, longWindow, surgeThreshold: rateThreshold });
    const reResult  = RangeExpansionProxy.compute({ states, windowSize: longWindow, expansionThreshold: rangeThreshold });
    const signal = trsResult.surgeDetected.map(
      (surge, i) => AB_MATH.executableFormula(surge, reResult.expansionDetected[i])
    );
    return Object.freeze({ signal, stateCount: states.length, shortWindow, longWindow, rateThreshold, rangeThreshold });
  },
  version()  { return '1.0.0'; },
  dependencies() { return ['TickRateSurgeProxy', 'RangeExpansionProxy']; },
  tests() { return [{ name: 'returns signal array of correct length', inputs: { states: Array(25).fill({ tick_timestamp: 1000, candle_high: 101, candle_low: 100 }) }, expectedOutputShape: { signal: 'number[]' } }]; },
  documentation() { return `Activity burst (conjunction) detector. ${PROXY_DISCLAIMER} LaTeX: ${AB_MATH.symbolicExpression}`; },
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: AB_MATH,
});

// ── Ordered collection and auto-registration helper ───────────────────────────

/**
 * All 10 core proxy plugin objects, in definition order.
 * @type {ReadonlyArray<object>}
 */
export const CORE_PROXY_PLUGINS = Object.freeze([
  RecentLocalMinimumProxy,
  RecentLocalMaximumProxy,
  ConsecutiveUpTickClusterProxy,
  ConsecutiveDownTickClusterProxy,
  LocalVolatilitySpikeProxy,
  RangeExpansionProxy,
  LocalExtremumProxy,
  TickRateSurgeProxy,
  CompressionReleaseProxy,
  ActivityBurstProxy,
]);

/**
 * Registers all 10 core proxy plugins into the provided registry.
 * Convenience function for bootstrap code.
 *
 * @param {import('./MarketConstructProxyRegistry.js').MarketConstructProxyRegistry} registry
 * @returns {void}
 */
export function registerCoreProxies(registry) {
  for (const plugin of CORE_PROXY_PLUGINS) {
    registry.register(plugin);
  }
}
