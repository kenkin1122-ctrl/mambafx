/**
 * research/src/plugin/coreIndicators.js
 *
 * Purpose:
 *   Defines a representative set of core indicator plugins for Phase 11's
 *   registry-driven candidate generation (Stage 1). Each plugin conforms
 *   to the ScientificPlugin interface (plugin/PluginContract.js) — the
 *   exact same contract proxy/coreProxies.js's 10 plugins already use —
 *   and carries honest scientific metadata: assumptions, validation
 *   status, and a three-form MachineReadableMathematics definition.
 *
 * Scope (representative coverage across major families, per the
 *   directive's own list — not exhaustive; Hurst exponent, fractal
 *   dimension, entropy-family, and tick-imbalance indicators are
 *   explicitly deferred, documented in the registry-driven generator's
 *   own header rather than silently omitted):
 *   Moving averages:  SMA, EMA, WMA
 *   Momentum:         RSI, Momentum, ROC
 *   Volatility/mean-reversion: BollingerWidth, BollingerPosition, ZScore
 *   Range/volatility: ATR (true-range based)
 *   Sequential:       RunLength
 *
 * IMPORTANT: these are indicator DEFINITIONS for candidate generation —
 *   they produce a numeric signal series for hypothesis construction, and
 *   are separate from bridge/Phase11AutomatedConfirmation.js's OWN
 *   indicator computation used for actual statistical testing (RSI,
 *   EMA_SLOPE, CCI) — that module is UNCHANGED by this work; a confirmed
 *   candidate generated from this registry still goes through the exact
 *   same, unmodified confirmation pipeline.
 *
 * Dependencies: plugin/MachineReadableMathematics.js, plugin/PluginContract.js.
 * Public API: CORE_INDICATOR_PLUGINS, registerCoreIndicators.
 */

import { createMathDefinition } from './MachineReadableMathematics.js';

const DISCLAIMER = 'Indicator definition for candidate hypothesis generation. Computed from the observed price series only (maxLookahead=0); no claim of predictive validity until the candidate passes Rounds 1-4 of the confirmation pipeline.';

function baseMeta(name, displayName, description, complexity, extra = {}) {
  return Object.freeze({
    name, displayName, disclaimer: DISCLAIMER, version: '1.0.0', description,
    scientificAssumptions: ['maxLookahead=0: only prices up to and including time t are used.', ...(extra.scientificAssumptions || [])],
    dependencies: [], complexity, validationStatus: 'HEURISTIC', maxLookahead: 0,
    ...extra,
  });
}

function sma(prices, i, period) {
  if (i < period - 1) return NaN;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += prices[k];
  return sum / period;
}
function stdDev(prices, i, period, mean) {
  if (i < period - 1) return NaN;
  let sumSq = 0;
  for (let k = i - period + 1; k <= i; k++) sumSq += (prices[k] - mean) ** 2;
  return Math.sqrt(sumSq / period);
}

export const SmaPlugin = Object.freeze({
  metadata: () => baseMeta('SMA', 'Simple Moving Average', 'Unweighted rolling mean of price.', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 14 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((_, i) => sma(prices, i, period));
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'SMA-2 of [1,3] is 2', inputs: { states: [{ tick_price: 1 }, { tick_price: 3 }], period: 2 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Simple Moving Average. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'SMA_t = mean(price[t-period+1 .. t])', symbolicExpression: String.raw`\text{SMA}_t = \frac{1}{p}\sum_{i=t-p+1}^{t} P_i`,
    executableFormula: (prices, t, p) => sma(prices, t, p), units: 'price units', domain: 'prices ∈ ℝ^n', range: 'ℝ',
  }),
});

export const EmaPlugin = Object.freeze({
  metadata: () => baseMeta('EMA', 'Exponential Moving Average', 'Exponentially-weighted rolling mean of price.', 'O(n)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 14 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const k = 2 / (period + 1);
    let ema = null;
    const signal = prices.map((p) => { ema = ema === null ? p : p * k + ema * (1 - k); return ema; });
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'EMA of a constant series equals that constant', inputs: { states: [{ tick_price: 5 }, { tick_price: 5 }], period: 3 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Exponential Moving Average. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'EMA_t = price_t*k + EMA_{t-1}*(1-k), k=2/(period+1)', symbolicExpression: String.raw`\text{EMA}_t = k P_t + (1-k)\text{EMA}_{t-1}`,
    executableFormula: (p, prev, k) => p * k + prev * (1 - k), units: 'price units', domain: 'prices ∈ ℝ^n', range: 'ℝ',
  }),
});

export const WmaPlugin = Object.freeze({
  metadata: () => baseMeta('WMA', 'Weighted Moving Average', 'Linearly-weighted rolling mean, most recent price weighted highest.', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 14 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const denom = (period * (period + 1)) / 2;
    const signal = prices.map((_, i) => {
      if (i < period - 1) return NaN;
      let sum = 0;
      for (let k = 0; k < period; k++) sum += prices[i - period + 1 + k] * (k + 1);
      return sum / denom;
    });
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'WMA respects recency weighting', inputs: { states: [{ tick_price: 1 }, { tick_price: 3 }], period: 2 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Weighted Moving Average. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'WMA_t = sum(price_i * weight_i) / sum(weight_i), weight increases linearly with recency',
    symbolicExpression: String.raw`\text{WMA}_t = \frac{\sum_{i=1}^{p} i \cdot P_{t-p+i}}{\sum_{i=1}^{p} i}`,
    executableFormula: (prices) => prices, units: 'price units', domain: 'prices ∈ ℝ^n', range: 'ℝ',
  }),
});

export const RsiPlugin = Object.freeze({
  metadata: () => baseMeta('RSI', 'Relative Strength Index', 'Wilder\'s RSI: ratio of average gains to average losses over the lookback period.', 'O(n)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 14 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const n = prices.length;
    const signal = new Array(n).fill(NaN);
    let avgGain = null, avgLoss = null;
    for (let i = 1; i < n; i++) {
      const change = prices[i] - prices[i - 1];
      const gain = Math.max(change, 0), loss = Math.max(-change, 0);
      if (i <= period) {
        avgGain = (avgGain ?? 0) + gain / period; avgLoss = (avgLoss ?? 0) + loss / period;
        if (i === period) signal[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period;
        signal[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return Object.freeze({ signal, period, stateCount: n });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'RSI is bounded in [0,100]', inputs: { states: Array.from({ length: 20 }, (_, i) => ({ tick_price: 100 + i })), period: 14 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Wilder's RSI. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions, 'Wilder\'s smoothing (1978), a heuristic momentum oscillator, not a validated causal model.']; },
  mathDefinition: createMathDefinition({
    humanReadable: 'RSI = 100 - 100/(1+RS), RS = avgGain/avgLoss over period', symbolicExpression: String.raw`\text{RSI}_t = 100 - \frac{100}{1+\text{RS}_t}`,
    executableFormula: (avgGain, avgLoss) => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)), units: 'dimensionless [0,100]', domain: 'prices ∈ ℝ^n', range: '[0,100]',
  }),
});

export const MomentumPlugin = Object.freeze({
  metadata: () => baseMeta('Momentum', 'Momentum', 'Simple N-period price difference.', 'O(n)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 10 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((p, i) => (i < period ? NaN : p - prices[i - period]));
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'momentum of a rising series is positive', inputs: { states: [{ tick_price: 1 }, { tick_price: 2 }, { tick_price: 3 }], period: 1 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Momentum (N-period price difference). ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'Momentum_t = price_t - price_{t-period}', symbolicExpression: String.raw`M_t = P_t - P_{t-p}`,
    executableFormula: (prices, t, p) => prices[t] - prices[t - p], units: 'price units', domain: 'prices ∈ ℝ^n', range: 'ℝ',
  }),
});

export const RocPlugin = Object.freeze({
  metadata: () => baseMeta('ROC', 'Rate of Change', 'Percentage price change over N periods.', 'O(n)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 10 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((p, i) => (i < period || prices[i - period] === 0 ? NaN : ((p - prices[i - period]) / prices[i - period]) * 100));
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'ROC of a 10% rise is 10', inputs: { states: [{ tick_price: 100 }, { tick_price: 110 }], period: 1 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Rate of Change. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'ROC_t = (price_t - price_{t-period}) / price_{t-period} * 100', symbolicExpression: String.raw`\text{ROC}_t = \frac{P_t - P_{t-p}}{P_{t-p}} \times 100`,
    executableFormula: (prices, t, p) => ((prices[t] - prices[t - p]) / prices[t - p]) * 100, units: 'percent', domain: 'prices ∈ ℝ^n, price ≠ 0', range: 'ℝ',
  }),
});

export const BollingerWidthPlugin = Object.freeze({
  metadata: () => baseMeta('BollingerWidth', 'Bollinger Band Width', 'Width of the Bollinger Bands (2 std dev) relative to the moving average, a volatility measure.', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 20, numStdDev = 2 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((_, i) => {
      const mean = sma(prices, i, period);
      if (Number.isNaN(mean) || mean === 0) return NaN;
      const sd = stdDev(prices, i, period, mean);
      return (2 * numStdDev * sd) / mean;
    });
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'width of a constant series is 0', inputs: { states: Array(20).fill({ tick_price: 100 }), period: 10 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Bollinger Band Width. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions, 'Bollinger (1980s): price volatility is well-approximated by a rolling standard deviation band.']; },
  mathDefinition: createMathDefinition({
    humanReadable: 'width_t = (2*k*stdDev_t) / SMA_t', symbolicExpression: String.raw`W_t = \frac{2k\sigma_t}{\text{SMA}_t}`,
    executableFormula: (sd, mean, k) => (2 * k * sd) / mean, units: 'dimensionless ratio', domain: 'prices ∈ ℝ^n', range: '[0, ∞)',
  }),
});

export const BollingerPositionPlugin = Object.freeze({
  metadata: () => baseMeta('BollingerPosition', 'Bollinger Band Position', 'Current price\'s position within the Bollinger Bands, normalized to [0,1].', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 20, numStdDev = 2 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((p, i) => {
      const mean = sma(prices, i, period);
      if (Number.isNaN(mean)) return NaN;
      const sd = stdDev(prices, i, period, mean);
      const lower = mean - numStdDev * sd, upper = mean + numStdDev * sd;
      return upper === lower ? 0.5 : (p - lower) / (upper - lower);
    });
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'position is defined for a warmed-up series', inputs: { states: Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + Math.sin(i) })), period: 20 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Bollinger Band Position. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'position_t = (price_t - lowerBand_t) / (upperBand_t - lowerBand_t)', symbolicExpression: String.raw`\%B_t = \frac{P_t - L_t}{U_t - L_t}`,
    executableFormula: (p, lower, upper) => (p - lower) / (upper - lower), units: 'dimensionless [0,1] typical', domain: 'prices ∈ ℝ^n', range: 'ℝ (typically [0,1])',
  }),
});

export const ZScorePlugin = Object.freeze({
  metadata: () => baseMeta('ZScore', 'Rolling Z-Score', 'Number of standard deviations the current price is from its rolling mean.', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 20 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = prices.map((p, i) => {
      const mean = sma(prices, i, period);
      if (Number.isNaN(mean)) return NaN;
      const sd = stdDev(prices, i, period, mean);
      return sd === 0 ? 0 : (p - mean) / sd;
    });
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'z-score of the mean itself is 0', inputs: { states: Array(20).fill({ tick_price: 100 }), period: 10 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Rolling Z-Score. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions, 'Assumes local approximate normality of the rolling price distribution -- not tested here.']; },
  mathDefinition: createMathDefinition({
    humanReadable: 'z_t = (price_t - mean_t) / stdDev_t', symbolicExpression: String.raw`z_t = \frac{P_t - \mu_t}{\sigma_t}`,
    executableFormula: (p, mean, sd) => (p - mean) / sd, units: 'standard deviations', domain: 'prices ∈ ℝ^n', range: 'ℝ',
  }),
});

export const AtrPlugin = Object.freeze({
  metadata: () => baseMeta('ATR', 'Average True Range', 'Rolling average of absolute tick-to-tick price movement (true range proxy for tick-level data).', 'O(n·period)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 14 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const trueRanges = prices.map((p, i) => (i === 0 ? NaN : Math.abs(p - prices[i - 1])));
    const signal = trueRanges.map((_, i) => sma(trueRanges, i, period));
    return Object.freeze({ signal, period, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'ATR of a constant series is 0', inputs: { states: Array(20).fill({ tick_price: 100 }), period: 10 }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Average True Range (tick-level true-range proxy, since raw ticks have no high/low/close). ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions, 'Simplified from Wilder\'s ATR (which uses candle high/low/close): tick-level data substitutes |price_t - price_{t-1}| for true range.']; },
  mathDefinition: createMathDefinition({
    humanReadable: 'ATR_t = mean(|price_i - price_{i-1}|) over the trailing period', symbolicExpression: String.raw`\text{ATR}_t = \frac{1}{p}\sum_{i=t-p+1}^{t} |P_i - P_{i-1}|`,
    executableFormula: (trueRanges, t, p) => sma(trueRanges, t, p), units: 'price units', domain: 'prices ∈ ℝ^n', range: '[0, ∞)',
  }),
});

export const RunLengthPlugin = Object.freeze({
  metadata: () => baseMeta('RunLength', 'Consecutive Directional Run Length', 'Current length of the consecutive same-direction tick run ending at t.', 'O(n)'),
  validate() { return { valid: true, errors: [] }; },
  compute({ states } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const signal = new Array(prices.length).fill(0);
    for (let i = 1; i < prices.length; i++) {
      const dir = Math.sign(prices[i] - prices[i - 1]);
      const prevDir = i >= 2 ? Math.sign(prices[i - 1] - prices[i - 2]) : 0;
      signal[i] = dir !== 0 && dir === prevDir ? signal[i - 1] + 1 : (dir !== 0 ? 1 : 0);
    }
    return Object.freeze({ signal, period: null, stateCount: prices.length });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'three consecutive rises -> run length 3', inputs: { states: [{ tick_price: 1 }, { tick_price: 2 }, { tick_price: 3 }, { tick_price: 4 }] }, expectedOutputShape: { signal: 'number[]' } }],
  documentation: () => `Consecutive directional run length. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'runLength_t = runLength_{t-1}+1 if direction unchanged, else reset', symbolicExpression: String.raw`R_t = R_{t-1}+1 \text{ if } \text{sign}(\Delta P_t) = \text{sign}(\Delta P_{t-1})\text{, else } 1`,
    executableFormula: (prevRun, sameDirection) => (sameDirection ? prevRun + 1 : 1), units: 'tick count', domain: 'prices ∈ ℝ^n', range: '{0, 1, 2, ...}',
  }),
});

export const CORE_INDICATOR_PLUGINS = Object.freeze([
  SmaPlugin, EmaPlugin, WmaPlugin, RsiPlugin, MomentumPlugin, RocPlugin,
  BollingerWidthPlugin, BollingerPositionPlugin, ZScorePlugin, AtrPlugin, RunLengthPlugin,
]);

/** Registers all core indicator plugins into the given IndicatorRegistry. */
export function registerCoreIndicators(registry) {
  for (const plugin of CORE_INDICATOR_PLUGINS) registry.register(plugin);
  return registry;
}
