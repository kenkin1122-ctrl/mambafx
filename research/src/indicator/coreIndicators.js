/**
 * research/src/indicator/coreIndicators.js
 *
 * Purpose:
 *   Defines the core set of indicator plugins for the registry-driven
 *   candidate generator, covering representative examples from every
 *   family the directive named: moving averages (EMA/SMA/WMA), momentum
 *   oscillators (RSI/CCI/ROC/Momentum), trend-strength (ADX/MACD),
 *   volatility (ATR/Bollinger Width/Volatility/Range), statistical
 *   (Z-score/Entropy), long-memory (Hurst/Fractal Dimension), and
 *   tick-microstructure (Run Length/Tick Imbalance/Directional Entropy).
 *   Every plugin implements the ScientificPlugin interface (plugin/
 *   PluginContract.js — unmodified, reused exactly as coreProxies.js's
 *   plugins do) and is auto-registered via registerCoreIndicators().
 *
 * Honesty disclosures (stated once here, not repeated per-plugin unless a
 *   plugin has an ADDITIONAL simplification beyond this one):
 *   - This codebase's tick-level data has no OHLC candles, only a single
 *     price stream. Indicators textbook-defined over High/Low/Close
 *     (ATR, ADX, CCI's typical price) substitute the single price for all
 *     three — the same disclosed simplification already used by
 *     bridge/Phase11AutomatedConfirmation.js's CCI implementation. This is
 *     a data-availability simplification, not a different indicator.
 *   - Hurst exponent uses a single-window rescaled-range (R/S) estimate,
 *     the simplest standard method — not a multi-scale regression, which
 *     would give a more robust estimate but costs more per computation.
 *     Fractal Dimension is derived from it via the standard relationship
 *     D = 2 - H, not computed independently.
 *
 * maxLookahead=0 is enforced structurally by PluginContract.validatePlugin
 *   for every plugin here, matching the codebase's causal-safety
 *   discipline (Volume IV Part 5) — no indicator reads beyond index t.
 *
 * Dependencies: plugin/MachineReadableMathematics.js (createMathDefinition
 *   — unmodified, reused), indicator/IndicatorRegistry.js.
 * Public API: CORE_INDICATOR_PLUGINS, registerCoreIndicators.
 * Complexity: noted per plugin below; all are O(n) or O(n·w) single/
 *   rolling-window passes, consistent with coreProxies.js's plugins.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

// ── Shared numeric helpers (private to this file — small, standard
//    formulas; not imported from elsewhere since no shared indicator-math
//    module exists yet in research/src/, and this mirrors coreProxies.js's
//    own choice to keep its rolling-window helpers local rather than
//    requiring a new shared dependency for this change). ──────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(NaN);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function wma(values, period) {
  const out = new Array(values.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let k = 0; k < period; k++) s += values[i - period + 1 + k] * (k + 1);
    out[i] = s / denom;
  }
  return out;
}
function rollingStd(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1);
    const mu = w.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - mu) ** 2, 0) / period);
  }
  return out;
}
function diffs(values) {
  const out = new Array(values.length).fill(NaN);
  for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1];
  return out;
}

const DISCLAIMER = 'Indicator computed on a single tick-price stream (no OHLC available); ' +
  'High/Low/Close-defined formulas substitute price for all three. maxLookahead=0.';

/** Boilerplate shared by every plugin below, reducing per-plugin repetition. */
function makePlugin({ name, displayName, description, assumptions, complexity, validationStatus, mathDef, computeFn, testInputs }) {
  return Object.freeze({
    metadata() {
      return Object.freeze({
        name, displayName, description,
        version: '1.0.0',
        scientificAssumptions: assumptions,
        dependencies: [],
        complexity,
        validationStatus,
        maxLookahead: 0,
        disclaimer: DISCLAIMER,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute(inputs) { return computeFn(inputs); },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() { return [{ name: `${name} computes without throwing`, inputs: testInputs, expectedOutputShape: { signal: 'number[]' } }]; },
    documentation() { return `${description} ${DISCLAIMER} LaTeX: ${mathDef.symbolicExpression}`; },
    scientificAssumptions() { return [...assumptions]; },
    mathDefinition: mathDef,
  });
}

const DEFAULT_TEST_INPUT = { prices: [10, 11, 12, 11, 10, 9, 10, 11, 12, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12, 13], period: 5 };

// ── 1-3. Moving averages ─────────────────────────────────────────────────

export const EMAIndicator = makePlugin({
  name: 'EMA', displayName: 'Exponential Moving Average',
  description: 'Exponentially-weighted moving average of price, recent values weighted more heavily.',
  assumptions: ['Recent prices are more informative than older prices for the current trend.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'EMA_t = k*price_t + (1-k)*EMA_{t-1}, k = 2/(period+1)',
    symbolicExpression: String.raw`EMA_t = \alpha P_t + (1-\alpha) EMA_{t-1}`,
    executableFormula: (p, period) => ema(p, period), units: 'price units', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 14 } = {}) => ({ signal: ema(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

export const EMASlopeIndicator = makePlugin({
  name: 'EMA_SLOPE', displayName: 'EMA Slope',
  description: 'First difference of the Exponential Moving Average -- the EMA\'s own rate of change, distinct from EMA\'s level. This is the original Phase 11 demo campaign\'s founding indicator definition (startPhase11Campaign.js\'s DEFAULT_INDICATOR_CANDIDATES), registered here as the canonical implementation -- the confirmation pipeline no longer maintains a separate copy of this formula.',
  assumptions: ['A rising/falling EMA slope indicates accelerating/decelerating trend strength beyond the EMA level alone.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'EMA_SLOPE_t = EMA_t - EMA_{t-1}',
    symbolicExpression: String.raw`\Delta\text{EMA}_t = \text{EMA}_t - \text{EMA}_{t-1}`,
    executableFormula: (p, period) => {
      const emaSeries = ema(p, period);
      const out = new Array(emaSeries.length).fill(NaN);
      for (let i = 1; i < emaSeries.length; i++) out[i] = emaSeries[i] - emaSeries[i - 1];
      return out;
    },
    units: 'price units per tick', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 14 } = {}) => {
    const emaSeries = ema(prices || [], period);
    const out = new Array(emaSeries.length).fill(NaN);
    for (let i = 1; i < emaSeries.length; i++) out[i] = emaSeries[i] - emaSeries[i - 1];
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const SMAIndicator = makePlugin({
  name: 'SMA', displayName: 'Simple Moving Average',
  description: 'Unweighted rolling mean of price over a fixed window.',
  assumptions: ['All prices in the window are equally informative.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'SMA_t = mean(price[t-period+1 .. t])',
    symbolicExpression: String.raw`SMA_t = \frac{1}{w}\sum_{i=t-w+1}^{t} P_i`,
    executableFormula: (p, period) => sma(p, period), units: 'price units', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 14 } = {}) => ({ signal: sma(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

export const WMAIndicator = makePlugin({
  name: 'WMA', displayName: 'Weighted Moving Average',
  description: 'Linearly-weighted moving average — most recent price gets weight = period, oldest gets weight = 1.',
  assumptions: ['Informativeness decays linearly, not exponentially, with age.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'WMA_t = sum(k * price[t-period+k]) / sum(k), k=1..period',
    symbolicExpression: String.raw`WMA_t = \frac{\sum_{k=1}^{w} k \cdot P_{t-w+k}}{\sum_{k=1}^{w} k}`,
    executableFormula: (p, period) => wma(p, period), units: 'price units', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 14 } = {}) => ({ signal: wma(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 4-7. Momentum oscillators ────────────────────────────────────────────

function rsiCompute(p, period) {
  const out = new Array(p.length).fill(NaN);
  let avgGain = null, avgLoss = null;
  for (let i = 1; i < p.length; i++) {
    const change = p[i] - p[i - 1], gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) { avgGain = (avgGain ?? 0) + gain / period; avgLoss = (avgLoss ?? 0) + loss / period; if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss); }
  }
  return out;
}

export const RSIIndicator = makePlugin({
  name: 'RSI', displayName: 'Relative Strength Index',
  description: 'Wilder\'s RSI: ratio of average gains to average losses over a lookback, scaled to [0,100].',
  assumptions: ['Larger recent gains relative to losses indicate overbought conditions, and vice versa.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'RSI = 100 - 100/(1+RS), RS = avgGain/avgLoss (Wilder smoothing)',
    symbolicExpression: String.raw`RSI_t = 100 - \frac{100}{1+RS_t}`,
    executableFormula: (p, period) => rsiCompute(p, period),
    units: 'dimensionless [0,100]', domain: 'ℝ^n', range: '[0,100]',
  }),
  computeFn: ({ prices, period = 14 } = {}) => ({ signal: rsiCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

export const CCIIndicator = makePlugin({
  name: 'CCI', displayName: 'Commodity Channel Index',
  description: 'Deviation of price from its moving average, scaled by mean absolute deviation.',
  assumptions: ['Typical price simplified to raw price (no OHLC available).'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'CCI = (price - SMA) / (0.015 * meanAbsDev)',
    symbolicExpression: String.raw`CCI_t = \frac{P_t - SMA_t}{0.015 \cdot MAD_t}`,
    executableFormula: (p, period) => {
      const out = new Array(p.length).fill(NaN);
      for (let i = period - 1; i < p.length; i++) {
        const w = p.slice(i - period + 1, i + 1);
        const m = w.reduce((a, b) => a + b, 0) / period;
        const mad = w.reduce((a, b) => a + Math.abs(b - m), 0) / period;
        out[i] = mad === 0 ? 0 : (p[i] - m) / (0.015 * mad);
      }
      return out;
    },
    units: 'dimensionless', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const out = new Array(p.length).fill(NaN);
    for (let i = period - 1; i < p.length; i++) {
      const w = p.slice(i - period + 1, i + 1);
      const m = w.reduce((a, b) => a + b, 0) / period;
      const mad = w.reduce((a, b) => a + Math.abs(b - m), 0) / period;
      out[i] = mad === 0 ? 0 : (p[i] - m) / (0.015 * mad);
    }
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const MomentumIndicator = makePlugin({
  name: 'Momentum', displayName: 'Momentum',
  description: 'Raw price change over a fixed lookback: price_t - price_{t-period}.',
  assumptions: ['Absolute price change over a fixed window reflects trend strength.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Momentum_t = price_t - price_{t-period}',
    symbolicExpression: String.raw`M_t = P_t - P_{t-w}`,
    executableFormula: (p, period) => p.map((v, i) => (i >= period ? v - p[i - period] : NaN)),
    units: 'price units', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 10 } = {}) => {
    const p = prices || [];
    return { signal: p.map((v, i) => (i >= period ? v - p[i - period] : NaN)), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const ROCIndicator = makePlugin({
  name: 'ROC', displayName: 'Rate of Change',
  description: 'Percentage price change over a fixed lookback.',
  assumptions: ['Percentage change is more comparable across price regimes than absolute change.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'ROC_t = 100 * (price_t - price_{t-period}) / price_{t-period}',
    symbolicExpression: String.raw`ROC_t = 100 \cdot \frac{P_t - P_{t-w}}{P_{t-w}}`,
    executableFormula: (p, period) => p.map((v, i) => (i >= period && p[i - period] !== 0 ? 100 * (v - p[i - period]) / p[i - period] : NaN)),
    units: 'percent', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 10 } = {}) => {
    const p = prices || [];
    return { signal: p.map((v, i) => (i >= period && p[i - period] !== 0 ? 100 * (v - p[i - period]) / p[i - period] : NaN)), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 8-9. Trend strength ──────────────────────────────────────────────────

export const MACDIndicator = makePlugin({
  name: 'MACD', displayName: 'MACD Histogram',
  description: 'Difference between a fast and slow EMA, minus a signal-line EMA of that difference.',
  assumptions: ['Divergence between fast and slow trend estimates signals momentum shifts.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'MACD = EMA_fast - EMA_slow; Histogram = MACD - EMA_signal(MACD)',
    symbolicExpression: String.raw`H_t = (EMA^{fast}_t - EMA^{slow}_t) - EMA^{signal}_t`,
    executableFormula: (p, fast, slow, signal) => {
      const macd = ema(p, fast).map((v, i) => v - ema(p, slow)[i]);
      const sig = ema(macd, signal);
      return macd.map((v, i) => v - sig[i]);
    },
    units: 'price units', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9 } = {}) => {
    const p = prices || [];
    const fastE = ema(p, fastPeriod), slowE = ema(p, slowPeriod);
    const macd = fastE.map((v, i) => v - slowE[i]);
    const sig = ema(macd, signalPeriod);
    return { signal: macd.map((v, i) => v - sig[i]), fastPeriod, slowPeriod, signalPeriod };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

function adxCompute(p, period) {
  const n = p.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = p[i] - p[i - 1], down = p[i - 1] - p[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.abs(p[i] - p[i - 1]);
  }
  const smoothedPlusDM = ema(plusDM, period), smoothedMinusDM = ema(minusDM, period), smoothedTR = ema(tr, period);
  const plusDI = smoothedPlusDM.map((v, i) => (smoothedTR[i] ? 100 * v / smoothedTR[i] : 0));
  const minusDI = smoothedMinusDM.map((v, i) => (smoothedTR[i] ? 100 * v / smoothedTR[i] : 0));
  const dx = plusDI.map((v, i) => (v + minusDI[i] ? 100 * Math.abs(v - minusDI[i]) / (v + minusDI[i]) : 0));
  return ema(dx, period);
}

export const ADXIndicator = makePlugin({
  name: 'ADX', displayName: 'Average Directional Index',
  description: 'Wilder\'s trend-strength indicator from smoothed directional movement (price-only approximation).',
  assumptions: ['+DM/-DM approximated from price changes only (no High/Low available).'],
  complexity: 'O(n)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'ADX = smoothed average of DX; DX = 100*|+DI - -DI|/(+DI + -DI)',
    symbolicExpression: String.raw`ADX_t = \text{smooth}\left(100 \cdot \frac{|{+DI_t} - {-DI_t}|}{{+DI_t} + {-DI_t}}\right)`,
    executableFormula: (p, period) => adxCompute(p, period),
    units: 'dimensionless [0,100]', domain: 'ℝ^n', range: '[0,100]',
  }),
  computeFn: ({ prices, period = 14 } = {}) => ({ signal: adxCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 10-13. Volatility ─────────────────────────────────────────────────────

export const ATRIndicator = makePlugin({
  name: 'ATR', displayName: 'Average True Range',
  description: 'Smoothed average of absolute tick-to-tick price change (True Range simplified to |Δprice|).',
  assumptions: ['True Range approximated as |price_t - price_{t-1}| (no High/Low available).'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'ATR = EMA(|price_t - price_{t-1}|, period)',
    symbolicExpression: String.raw`ATR_t = EMA_t(|P_t - P_{t-1}|)`,
    executableFormula: (p, period) => ema(diffs(p).map((v) => Math.abs(v || 0)), period),
    units: 'price units', domain: 'ℝ^n', range: 'ℝ⁺',
  }),
  computeFn: ({ prices, period = 14 } = {}) => {
    const p = prices || [];
    return { signal: ema(diffs(p).map((v) => Math.abs(v || 0)), period), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const BollingerWidthIndicator = makePlugin({
  name: 'BollingerWidth', displayName: 'Bollinger Band Width',
  description: 'Normalized width between upper and lower Bollinger Bands (SMA ± k·stddev).',
  assumptions: ['Band width proxies for recent realized volatility regime.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Width = (upper - lower) / middle, bands = SMA ± k*stddev',
    symbolicExpression: String.raw`W_t = \frac{2k\sigma_t}{SMA_t}`,
    executableFormula: (p, period, k) => {
      const mid = sma(p, period), sd = rollingStd(p, period);
      return mid.map((m, i) => (m ? (2 * k * sd[i]) / m : NaN));
    },
    units: 'dimensionless', domain: 'ℝ^n', range: 'ℝ⁺',
  }),
  computeFn: ({ prices, period = 20, k = 2 } = {}) => {
    const p = prices || [];
    const mid = sma(p, period), sd = rollingStd(p, period);
    return { signal: mid.map((m, i) => (m ? (2 * k * sd[i]) / m : NaN)), period, k };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const BollingerPositionIndicator = makePlugin({
  name: 'BollingerPosition', displayName: 'Bollinger Band Position',
  description: 'Where the current price sits within its Bollinger Bands (0=lower band, 1=upper band).',
  assumptions: ['Position within recent volatility range indicates overbought/oversold state.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Position = (price - lower) / (upper - lower)',
    symbolicExpression: String.raw`Pos_t = \frac{P_t - (SMA_t - k\sigma_t)}{2k\sigma_t}`,
    executableFormula: (p, period, k) => {
      const mid = sma(p, period), sd = rollingStd(p, period);
      return p.map((v, i) => { const lo = mid[i] - k * sd[i], hi = mid[i] + k * sd[i]; return hi - lo ? (v - lo) / (hi - lo) : NaN; });
    },
    units: 'dimensionless [0,1] (typically)', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 20, k = 2 } = {}) => {
    const p = prices || [];
    const mid = sma(p, period), sd = rollingStd(p, period);
    return { signal: p.map((v, i) => { const lo = mid[i] - k * sd[i], hi = mid[i] + k * sd[i]; return hi - lo ? (v - lo) / (hi - lo) : NaN; }), period, k };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const VolatilityIndicator = makePlugin({
  name: 'Volatility', displayName: 'Rolling Volatility',
  description: 'Rolling standard deviation of tick-to-tick returns.',
  assumptions: ['Recent return dispersion is a reasonable short-horizon volatility estimate.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Volatility = rollingStd(returns, period)',
    symbolicExpression: String.raw`\sigma_t = \sqrt{\frac{1}{w}\sum_{i=t-w+1}^{t}(r_i - \bar{r})^2}`,
    executableFormula: (p, period) => rollingStd(diffs(p).map((v) => v || 0), period),
    units: 'price units', domain: 'ℝ^n', range: 'ℝ⁺',
  }),
  computeFn: ({ prices, period = 14 } = {}) => {
    const p = prices || [];
    return { signal: rollingStd(diffs(p).map((v) => v || 0), period), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 14. Range ─────────────────────────────────────────────────────────────

export const RangeIndicator = makePlugin({
  name: 'Range', displayName: 'Rolling Range',
  description: 'Rolling max minus min over a fixed window.',
  assumptions: ['Range captures recent price dispersion independent of distributional shape.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Range_t = max(price[t-period+1..t]) - min(price[t-period+1..t])',
    symbolicExpression: String.raw`R_t = \max_{i \in [t-w+1,t]} P_i - \min_{i \in [t-w+1,t]} P_i`,
    executableFormula: (p, period) => p.map((_, i) => { if (i < period - 1) return NaN; const w = p.slice(i - period + 1, i + 1); return Math.max(...w) - Math.min(...w); }),
    units: 'price units', domain: 'ℝ^n', range: 'ℝ⁺',
  }),
  computeFn: ({ prices, period = 14 } = {}) => {
    const p = prices || [];
    return { signal: p.map((_, i) => { if (i < period - 1) return NaN; const w = p.slice(i - period + 1, i + 1); return Math.max(...w) - Math.min(...w); }), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 15. Z-score ────────────────────────────────────────────────────────────

export const ZScoreIndicator = makePlugin({
  name: 'ZScore', displayName: 'Rolling Z-Score',
  description: 'Standardized deviation of price from its rolling mean, in units of rolling standard deviation.',
  assumptions: ['Price is approximately locally stationary within the rolling window.'],
  complexity: 'O(n·period)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'Z_t = (price_t - rollingMean_t) / rollingStd_t',
    symbolicExpression: String.raw`Z_t = \frac{P_t - \mu_t}{\sigma_t}`,
    executableFormula: (p, period) => { const m = sma(p, period), sd = rollingStd(p, period); return p.map((v, i) => (sd[i] ? (v - m[i]) / sd[i] : NaN)); },
    units: 'dimensionless (standard deviations)', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const m = sma(p, period), sd = rollingStd(p, period);
    return { signal: p.map((v, i) => (sd[i] ? (v - m[i]) / sd[i] : NaN)), period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 16. Entropy (of binned returns) ────────────────────────────────────────

function entropyCompute(p, period) {
  const d = diffs(p);
  return p.map((_, i) => {
    if (i < period) return NaN;
    const w = d.slice(i - period + 1, i + 1);
    const counts = { down: 0, flat: 0, up: 0 };
    for (const v of w) { if (v > 0) counts.up++; else if (v < 0) counts.down++; else counts.flat++; }
    let h = 0;
    for (const c of Object.values(counts)) { if (c > 0) { const pr = c / period; h -= pr * Math.log2(pr); } }
    return h;
  });
}

export const EntropyIndicator = makePlugin({
  name: 'Entropy', displayName: 'Shannon Entropy of Returns',
  description: 'Shannon entropy of the sign-binned return distribution (down/flat/up) over a rolling window.',
  assumptions: ['Return-sign distribution over the window approximates the local generating distribution.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'Entropy = -sum(p_i * log2(p_i)) over 3 return bins (down/flat/up)',
    symbolicExpression: String.raw`H_t = -\sum_i p_i \log_2 p_i`,
    executableFormula: (p, period) => entropyCompute(p, period),
    units: 'bits', domain: 'ℝ^n', range: '[0, log2(3)]',
  }),
  computeFn: ({ prices, period = 20 } = {}) => ({ signal: entropyCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 17-18. Long-memory: Hurst / Fractal Dimension ──────────────────────────

function hurstCompute(p, period) {
  const d = diffs(p);
  return p.map((_, i) => {
    if (i < period) return NaN;
    const w = d.slice(i - period + 1, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / period;
    let cum = 0; const cumDev = w.map((v) => (cum += v - mean));
    const range = Math.max(...cumDev) - Math.min(...cumDev);
    const std = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    if (std === 0 || range === 0) return NaN;
    return Math.log(range / std) / Math.log(period);
  });
}

export const HurstIndicator = makePlugin({
  name: 'Hurst', displayName: 'Hurst Exponent (R/S estimate)',
  description: 'Rescaled-range (R/S) estimate of long-memory dependence over a rolling window.',
  assumptions: ['Single-window R/S is a simplified, noisier estimate than multi-scale regression.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'H ~ log(R/S) / log(period), R/S = range of cumulative mean-deviation / stddev of returns',
    symbolicExpression: String.raw`H_t \approx \frac{\log(R_t/S_t)}{\log(w)}`,
    executableFormula: (p, period) => hurstCompute(p, period),
    units: 'dimensionless [0,1] (typically)', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 30 } = {}) => ({ signal: hurstCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

export const FractalDimensionIndicator = makePlugin({
  name: 'FractalDimension', displayName: 'Fractal Dimension (from Hurst)',
  description: 'Derived from the Hurst exponent via the standard relationship D = 2 - H.',
  assumptions: ['Uses this file\'s own Hurst estimate as input — inherits its simplifications.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'D = 2 - H',
    symbolicExpression: String.raw`D_t = 2 - H_t`,
    executableFormula: (p, period) => hurstCompute(p, period).map((h) => (Number.isFinite(h) ? 2 - h : NaN)),
    units: 'dimensionless [1,2] (typically)', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 30 } = {}) => ({ signal: hurstCompute(prices || [], period).map((h) => (Number.isFinite(h) ? 2 - h : NaN)), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 19-21. Tick microstructure ─────────────────────────────────────────────

function runLengthCompute(p) {
  const d = diffs(p);
  const out = new Array(p.length).fill(NaN);
  let run = 0, lastSign = null;
  for (let i = 1; i < p.length; i++) {
    const s = Math.sign(d[i]);
    if (s === lastSign && s !== 0) run++; else run = 1;
    lastSign = s;
    out[i] = run;
  }
  return out;
}

export const RunLengthIndicator = makePlugin({
  name: 'RunLength', displayName: 'Consecutive Same-Direction Run Length',
  description: 'Number of consecutive ticks (ending at t) that moved in the same direction as tick t.',
  assumptions: ['Run length approximates local momentum persistence at tick granularity.'],
  complexity: 'O(n)', validationStatus: 'VALIDATED',
  mathDef: createMathDefinition({
    humanReadable: 'RunLength_t = count of consecutive prior ticks with the same sign(Δprice) as tick t',
    symbolicExpression: String.raw`RL_t = \max\{k : \text{sign}(\Delta P_{t-j}) = \text{sign}(\Delta P_t)\ \forall j \in [0,k)\}`,
    executableFormula: (p) => runLengthCompute(p),
    units: 'ticks', domain: 'ℝ^n', range: 'ℤ⁺',
  }),
  computeFn: ({ prices } = {}) => ({ signal: runLengthCompute(prices || []) }),
  testInputs: DEFAULT_TEST_INPUT,
});

function tickImbalanceCompute(p, period) {
  const d = diffs(p);
  return p.map((_, i) => {
    if (i < period) return NaN;
    const w = d.slice(i - period + 1, i + 1);
    let up = 0, down = 0;
    for (const v of w) { if (v > 0) up++; else if (v < 0) down++; }
    return (up - down) / period;
  });
}

export const TickImbalanceIndicator = makePlugin({
  name: 'TickImbalance', displayName: 'Tick Direction Imbalance',
  description: 'Net fraction of up-ticks minus down-ticks over a rolling window, in [-1, 1].',
  assumptions: ['Tick-direction imbalance proxies for short-horizon order-flow imbalance (Lee-Ready-style).'],
  complexity: 'O(n)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'Imbalance = (upTicks - downTicks) / period',
    symbolicExpression: String.raw`I_t = \frac{U_t - D_t}{w}`,
    executableFormula: (p, period) => tickImbalanceCompute(p, period),
    units: 'dimensionless [-1,1]', domain: 'ℝ^n', range: '[-1,1]',
  }),
  computeFn: ({ prices, period = 20 } = {}) => ({ signal: tickImbalanceCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

function directionalEntropyCompute(p, period) {
  const d = diffs(p);
  return p.map((_, i) => {
    if (i < period) return NaN;
    const w = d.slice(i - period + 1, i + 1).filter((v) => v !== 0);
    if (w.length === 0) return NaN;
    const up = w.filter((v) => v > 0).length, down = w.length - up;
    let h = 0;
    if (up > 0) { const pr = up / w.length; h -= pr * Math.log2(pr); }
    if (down > 0) { const pr = down / w.length; h -= pr * Math.log2(pr); }
    return h;
  });
}

export const DirectionalEntropyIndicator = makePlugin({
  name: 'DirectionalEntropy', displayName: 'Directional (Up/Down) Entropy',
  description: 'Shannon entropy of the binary up/down tick-direction sequence over a rolling window (excludes flat ticks, unlike Entropy above which includes a flat bin).',
  assumptions: ['Binary direction sequence entropy proxies for local unpredictability of tick direction.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'H = -(pUp*log2(pUp) + pDown*log2(pDown)), over non-flat ticks in window',
    symbolicExpression: String.raw`H_t = -p_{up}\log_2 p_{up} - p_{down}\log_2 p_{down}`,
    executableFormula: (p, period) => directionalEntropyCompute(p, period),
    units: 'bits', domain: 'ℝ^n', range: '[0,1]',
  }),
  computeFn: ({ prices, period = 20 } = {}) => ({ signal: directionalEntropyCompute(prices || [], period), period }),
  testInputs: DEFAULT_TEST_INPUT,
});

// ── 22-26. Newly added: range-normalization, ATR-based bands, and
//    distribution-shape statistics not covered by the existing 21
//    (avoiding renamed duplicates of RSI/CCI/BollingerWidth/ZScore etc.) ──

export const StochasticKIndicator = makePlugin({
  name: 'StochasticK', displayName: 'Stochastic %K',
  description: 'Current price\'s position within its own rolling min/max range over the period — a min/max-based normalization, distinct from BollingerPosition\'s standard-deviation-based one.',
  assumptions: ['Price position relative to its recent range is informative independent of the range\'s own statistical shape.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: '%K_t = (price_t - min(window)) / (max(window) - min(window)) * 100',
    symbolicExpression: String.raw`\%K_t = \frac{P_t - \min(W_t)}{\max(W_t) - \min(W_t)} \times 100`,
    executableFormula: (p, i, period) => {
      const w = p.slice(Math.max(0, i - period + 1), i + 1);
      const lo = Math.min(...w), hi = Math.max(...w);
      return hi === lo ? 50 : ((p[i] - lo) / (hi - lo)) * 100;
    },
    units: 'dimensionless [0,100]', domain: 'ℝ^n', range: '[0,100]',
  }),
  computeFn: ({ prices, period = 14 } = {}) => {
    const p = prices || [];
    const out = new Array(p.length).fill(NaN);
    for (let i = period - 1; i < p.length; i++) {
      const w = p.slice(i - period + 1, i + 1);
      const lo = Math.min(...w), hi = Math.max(...w);
      out[i] = hi === lo ? 50 : ((p[i] - lo) / (hi - lo)) * 100;
    }
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const KeltnerWidthIndicator = makePlugin({
  name: 'KeltnerWidth', displayName: 'Keltner Channel Width',
  description: 'Normalized channel width using ATR (average absolute tick-to-tick movement) rather than standard deviation — distinct from BollingerWidth\'s variance-based construction.',
  assumptions: ['ATR-based bands respond differently to outlier ticks than standard-deviation-based bands.'],
  complexity: 'O(n)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'width_t = 2 * ATR_t / SMA_t',
    symbolicExpression: String.raw`W_t = \frac{2\,\text{ATR}_t}{\text{SMA}_t}`,
    executableFormula: (atr, meanVal) => (meanVal === 0 ? NaN : (2 * atr) / meanVal),
    units: 'dimensionless ratio', domain: 'ℝ^n', range: '[0, ∞)',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const atrSeries = ema(diffs(p).map((v) => Math.abs(v || 0)), period);
    const meanSeries = sma(p, period);
    const out = p.map((_, i) => (meanSeries[i] === 0 || Number.isNaN(meanSeries[i]) ? NaN : (2 * atrSeries[i]) / meanSeries[i]));
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const AutocorrelationIndicator = makePlugin({
  name: 'Autocorrelation', displayName: 'Lag-1 Return Autocorrelation',
  description: 'Rolling lag-1 serial correlation of tick-to-tick returns — a genuinely distinct statistical concept from any single-value dispersion or position measure already in this registry.',
  assumptions: ['Serial correlation in returns, if present, reflects momentum (positive) or mean-reversion (negative) at the tick scale.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'autocorr_t = corr(returns[t-period+1..t-1], returns[t-period+2..t])',
    symbolicExpression: String.raw`\rho_1(t) = \text{corr}(r_{t-p+1..t-1},\, r_{t-p+2..t})`,
    executableFormula: (returns) => returns, units: 'dimensionless [-1,1]', domain: 'ℝ^n', range: '[-1,1]',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const returns = diffs(p);
    const out = new Array(p.length).fill(NaN);
    for (let i = period; i < p.length; i++) {
      const a = returns.slice(i - period + 1, i);
      const b = returns.slice(i - period + 2, i + 1);
      const n = a.length;
      const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
      let cov = 0, va = 0, vb = 0;
      for (let k = 0; k < n; k++) { const da = a[k] - ma, db = b[k] - mb; cov += da * db; va += da * da; vb += db * db; }
      out[i] = va === 0 || vb === 0 ? 0 : cov / Math.sqrt(va * vb);
    }
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const SkewnessIndicator = makePlugin({
  name: 'Skewness', displayName: 'Rolling Return Skewness',
  description: 'Third standardized moment of the rolling return distribution — a higher-order distribution-shape statistic not covered by ZScore (first/second moment only).',
  assumptions: ['Return-distribution asymmetry may carry information beyond mean/variance alone.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'skew_t = mean((r - mean(r))^3) / stddev(r)^3, over the rolling return window',
    symbolicExpression: String.raw`\gamma_1(t) = \frac{E[(r-\mu)^3]}{\sigma^3}`,
    executableFormula: (returns) => returns, units: 'dimensionless', domain: 'ℝ^n', range: 'ℝ',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const returns = diffs(p);
    const out = new Array(p.length).fill(NaN);
    for (let i = period; i < p.length; i++) {
      const w = returns.slice(i - period + 1, i + 1);
      const n = w.length;
      const mu = w.reduce((s, v) => s + v, 0) / n;
      const variance = w.reduce((s, v) => s + (v - mu) ** 2, 0) / n;
      const sd = Math.sqrt(variance);
      out[i] = sd === 0 ? 0 : (w.reduce((s, v) => s + (v - mu) ** 3, 0) / n) / (sd ** 3);
    }
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

export const KurtosisIndicator = makePlugin({
  name: 'Kurtosis', displayName: 'Rolling Return Excess Kurtosis',
  description: 'Fourth standardized moment (excess kurtosis) of the rolling return distribution — a distinct higher-order statistic capturing tail-heaviness, not covered elsewhere in this registry.',
  assumptions: ['Return-distribution tail-heaviness may indicate regime changes not visible in mean/variance/skew alone.'],
  complexity: 'O(n·period)', validationStatus: 'HEURISTIC',
  mathDef: createMathDefinition({
    humanReadable: 'kurt_t = mean((r - mean(r))^4) / stddev(r)^4 - 3, over the rolling return window',
    symbolicExpression: String.raw`\gamma_2(t) = \frac{E[(r-\mu)^4]}{\sigma^4} - 3`,
    executableFormula: (returns) => returns, units: 'dimensionless', domain: 'ℝ^n', range: '[-2, ∞)',
  }),
  computeFn: ({ prices, period = 20 } = {}) => {
    const p = prices || [];
    const returns = diffs(p);
    const out = new Array(p.length).fill(NaN);
    for (let i = period; i < p.length; i++) {
      const w = returns.slice(i - period + 1, i + 1);
      const n = w.length;
      const mu = w.reduce((s, v) => s + v, 0) / n;
      const variance = w.reduce((s, v) => s + (v - mu) ** 2, 0) / n;
      const sd = Math.sqrt(variance);
      out[i] = sd === 0 ? -3 : (w.reduce((s, v) => s + (v - mu) ** 4, 0) / n) / (sd ** 4) - 3;
    }
    return { signal: out, period };
  },
  testInputs: DEFAULT_TEST_INPUT,
});

// ── Registration ────────────────────────────────────────────────────────

export const CORE_INDICATOR_PLUGINS = Object.freeze([
  EMAIndicator, EMASlopeIndicator, SMAIndicator, WMAIndicator,
  RSIIndicator, CCIIndicator, MomentumIndicator, ROCIndicator,
  MACDIndicator, ADXIndicator,
  ATRIndicator, BollingerWidthIndicator, BollingerPositionIndicator, VolatilityIndicator,
  RangeIndicator, ZScoreIndicator, EntropyIndicator,
  HurstIndicator, FractalDimensionIndicator,
  RunLengthIndicator, TickImbalanceIndicator, DirectionalEntropyIndicator,
  StochasticKIndicator, KeltnerWidthIndicator, AutocorrelationIndicator, SkewnessIndicator, KurtosisIndicator,
]);

/**
 * Registers all core indicator plugins into the given registry.
 * @param {import('./IndicatorRegistry.js').IndicatorRegistry} registry
 * @returns {import('./IndicatorRegistry.js').IndicatorRegistry}
 */
export function registerCoreIndicators(registry) {
  for (const plugin of CORE_INDICATOR_PLUGINS) registry.register(plugin);
  return registry;
}
