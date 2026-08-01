/**
 * research/src/plugin/coreMarketStates.js
 *
 * Purpose:
 *   Defines a representative set of core market-state detection plugins
 *   for Phase 11's registry-driven candidate generation (Stage 2). Each
 *   plugin conforms to ScientificPlugin (plugin/PluginContract.js) and
 *   produces a binary "is this state active at t" signal from simple,
 *   honest, disclosed rolling-window heuristics — not validated market-
 *   regime classifiers. Used to construct MarketState candidates
 *   (candidate/MarketState.js) via the registry-driven generator.
 *
 * Scope (representative coverage, per the directive's own list — not
 *   exhaustive; deferred states — Drift, Oscillation as their own
 *   distinct detectors, Novel State detection — are documented in the
 *   registry-driven generator's own header, not silently omitted):
 *   Trend, Range (Consolidation), HighVolatility, LowVolatility,
 *   Compression, Expansion, Persistence, Reversal.
 *
 * Dependencies: plugin/MachineReadableMathematics.js.
 * Public API: CORE_MARKET_STATE_PLUGINS, registerCoreMarketStates.
 */

import { createMathDefinition } from './MachineReadableMathematics.js';

const DISCLAIMER = 'Market-state definition for candidate hypothesis generation, from a simple, disclosed rolling-window heuristic -- not a validated regime classifier. No claim of predictive validity until the candidate passes Rounds 1-4 of the confirmation pipeline.';

function baseMeta(name, displayName, description, extra = {}) {
  return Object.freeze({
    name, displayName, disclaimer: DISCLAIMER, version: '1.0.0', description,
    scientificAssumptions: ['maxLookahead=0: only prices up to and including time t are used.', ...(extra.scientificAssumptions || [])],
    dependencies: [], complexity: 'O(n·window)', validationStatus: 'HEURISTIC', maxLookahead: 0,
    ...extra,
  });
}

function windowStats(prices, i, window) {
  if (i < window - 1) return null;
  const slice = prices.slice(i - window + 1, i + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / window;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window;
  return { mean, stdDev: Math.sqrt(variance), first: slice[0], last: slice[slice.length - 1] };
}

function makeStatePlugin({ name, displayName, description, stateLabel, detectFn, testCase, humanReadable, extra }) {
  return Object.freeze({
    metadata: () => baseMeta(name, displayName, description, extra),
    validate() { return { valid: true, errors: [] }; },
    compute({ states, window = 20 } = {}) {
      const prices = (states || []).map((s) => Number(s.tick_price));
      const signal = prices.map((_, i) => {
        const stats = windowStats(prices, i, window);
        return stats ? (detectFn(stats, prices, i, window) ? 1 : 0) : NaN;
      });
      return Object.freeze({ signal, window, stateLabel, stateCount: prices.length });
    },
    version: () => '1.0.0', dependencies: () => [],
    tests: () => [testCase],
    documentation: () => `${displayName} state detector. ${DISCLAIMER}`,
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    stateLabel,
    mathDefinition: createMathDefinition({
      humanReadable, symbolicExpression: String.raw`\mathbb{1}_{\text{${name}}}(t)`,
      executableFormula: detectFn, units: 'binary {0,1}', domain: 'prices ∈ ℝ^n', range: '{0,1}',
    }),
  });
}

export const TrendStatePlugin = makeStatePlugin({
  name: 'Trend', displayName: 'Trending', stateLabel: 'Trend',
  description: 'Net directional movement across the window exceeds half the window\'s own volatility.',
  detectFn: (stats) => stats.stdDev > 0 && Math.abs(stats.last - stats.first) > stats.stdDev * 0.5,
  humanReadable: '|last - first| > 0.5 * stdDev over the window',
  testCase: { name: 'a steadily rising series is a trend', inputs: { states: Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + i })), window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const RangeStatePlugin = makeStatePlugin({
  name: 'Range', displayName: 'Range / Consolidation', stateLabel: 'Range',
  description: 'Net directional movement across the window is small relative to the window\'s own volatility.',
  detectFn: (stats) => stats.stdDev > 0 && Math.abs(stats.last - stats.first) < stats.stdDev * 0.25,
  humanReadable: '|last - first| < 0.25 * stdDev over the window',
  testCase: { name: 'a flat series is a range', inputs: { states: Array(25).fill({ tick_price: 100 }), window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const HighVolatilityStatePlugin = makeStatePlugin({
  name: 'HighVolatility', displayName: 'High Volatility', stateLabel: 'HighVolatility',
  description: 'Rolling standard deviation, relative to the rolling mean, exceeds a threshold.',
  detectFn: (stats) => stats.mean !== 0 && stats.stdDev / Math.abs(stats.mean) > 0.02,
  humanReadable: 'stdDev / mean > 0.02',
  testCase: { name: 'a widely oscillating series is high volatility', inputs: { states: Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 10 : -10) })), window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const LowVolatilityStatePlugin = makeStatePlugin({
  name: 'LowVolatility', displayName: 'Low Volatility', stateLabel: 'LowVolatility',
  description: 'Rolling standard deviation, relative to the rolling mean, is below a threshold.',
  detectFn: (stats) => stats.mean !== 0 && stats.stdDev / Math.abs(stats.mean) < 0.002,
  humanReadable: 'stdDev / mean < 0.002',
  testCase: { name: 'a flat series is low volatility', inputs: { states: Array(25).fill({ tick_price: 100 }), window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const CompressionStatePlugin = makeStatePlugin({
  name: 'Compression', displayName: 'Compression', stateLabel: 'Compression',
  description: 'Rolling volatility in the second half of the window is markedly lower than the first half -- a narrowing pattern.',
  detectFn: (stats, prices, i, window) => {
    const half = Math.floor(window / 2);
    const firstHalf = windowStats(prices, i - half, half);
    const secondHalf = windowStats(prices, i, half);
    return firstHalf && secondHalf && firstHalf.stdDev > 0 && secondHalf.stdDev < firstHalf.stdDev * 0.5;
  },
  humanReadable: 'stdDev(second half of window) < 0.5 * stdDev(first half of window)',
  testCase: { name: 'narrowing volatility is compression', inputs: { states: [...Array(10).fill(null).map((_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 5 : -5) })), ...Array(10).fill({ tick_price: 100 })], window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const ExpansionStatePlugin = makeStatePlugin({
  name: 'Expansion', displayName: 'Expansion', stateLabel: 'Expansion',
  description: 'Rolling volatility in the second half of the window is markedly higher than the first half -- a widening pattern.',
  detectFn: (stats, prices, i, window) => {
    const half = Math.floor(window / 2);
    const firstHalf = windowStats(prices, i - half, half);
    const secondHalf = windowStats(prices, i, half);
    return firstHalf && secondHalf && secondHalf.stdDev > firstHalf.stdDev * 2;
  },
  humanReadable: 'stdDev(second half of window) > 2 * stdDev(first half of window)',
  testCase: { name: 'widening volatility is expansion', inputs: { states: [...Array(10).fill({ tick_price: 100 }), ...Array(10).fill(null).map((_, i) => ({ tick_price: 100 + (i % 2 === 0 ? 10 : -10) }))], window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const PersistenceStatePlugin = makeStatePlugin({
  name: 'Persistence', displayName: 'Persistence', stateLabel: 'Persistence',
  description: 'The price direction over the first half and second half of the window agree in sign -- momentum is persisting.',
  detectFn: (stats, prices, i, window) => {
    const half = Math.floor(window / 2);
    const firstHalf = windowStats(prices, i - half, half);
    const secondHalf = windowStats(prices, i, half);
    if (!firstHalf || !secondHalf) return false;
    const d1 = firstHalf.last - firstHalf.first, d2 = secondHalf.last - secondHalf.first;
    return d1 !== 0 && d2 !== 0 && Math.sign(d1) === Math.sign(d2);
  },
  humanReadable: 'sign(delta in first half) == sign(delta in second half)',
  testCase: { name: 'consistently rising series shows persistence', inputs: { states: Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + i })), window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const ReversalStatePlugin = makeStatePlugin({
  name: 'Reversal', displayName: 'Reversal', stateLabel: 'Reversal',
  description: 'The price direction over the first half and second half of the window disagree in sign -- a directional flip.',
  detectFn: (stats, prices, i, window) => {
    const half = Math.floor(window / 2);
    const firstHalf = windowStats(prices, i - half, half);
    const secondHalf = windowStats(prices, i, half);
    if (!firstHalf || !secondHalf) return false;
    const d1 = firstHalf.last - firstHalf.first, d2 = secondHalf.last - secondHalf.first;
    return d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2);
  },
  humanReadable: 'sign(delta in first half) != sign(delta in second half)',
  testCase: { name: 'rise then fall shows reversal', inputs: { states: [...Array.from({ length: 10 }, (_, i) => ({ tick_price: 100 + i })), ...Array.from({ length: 10 }, (_, i) => ({ tick_price: 110 - i }))], window: 20 }, expectedOutputShape: { signal: 'number[]' } },
});

export const CORE_MARKET_STATE_PLUGINS = Object.freeze([
  TrendStatePlugin, RangeStatePlugin, HighVolatilityStatePlugin, LowVolatilityStatePlugin,
  CompressionStatePlugin, ExpansionStatePlugin, PersistenceStatePlugin, ReversalStatePlugin,
]);

/** Registers all core market-state plugins into the given MarketStateRegistry. */
export function registerCoreMarketStates(registry) {
  for (const plugin of CORE_MARKET_STATE_PLUGINS) registry.register(plugin);
  return registry;
}
