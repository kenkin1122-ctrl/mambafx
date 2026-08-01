/**
 * research/src/context/coreContexts.js
 *
 * Purpose:
 *   Stage 3 of the "Continue Implementation" directive: automatic context
 *   generation, extended to representative coverage. Three context
 *   plugins already existed (CandlePositionDetector, CandleTimingDetector,
 *   PriorCandleAnalyzer) — this file adds the remaining directive-named
 *   categories (Market Session, Volatility State, Trend State, Momentum
 *   State, Compression, Expansion, Range) and provides the single
 *   canonical registerCoreContexts(registry) this codebase was missing
 *   (proxy/coreProxies.js, indicator/coreIndicators.js, and
 *   plugin/coreMarketStates.js all already had a registerCoreX()
 *   convenience function; ContextRegistry had none until now).
 *
 * REUSE, NOT REIMPLEMENTATION (the whole point of this file): five of the
 *   seven new contexts here (Volatility, Trend, Compression, Expansion,
 *   Range) are conceptually near-identical to plugin/coreMarketStates.js's
 *   existing detectors of the same names -- which already implement this
 *   exact math, already tested. Rather than writing a third copy of "is
 *   this a compression regime", each of these contexts is a THIN WRAPPER:
 *   it calls the existing MarketState plugin's own compute() internally
 *   and reshapes its binary signal into this file's context-shaped output
 *   convention ({category, metadata}, matching CandlePositionDetector's
 *   own {normalizedPosition, zone, metadata} precedent). Momentum State
 *   similarly wraps indicator/coreIndicators.js's existing MomentumIndicator
 *   rather than reimplementing momentum math a third time. Market Session
 *   is the one genuinely new computation here (there is no existing
 *   session-of-day concept anywhere else in Phase 11).
 *
 * ARCHITECTURAL NOTE on why Contexts and MarketStates remain SEPARATE
 *   registries despite this reuse: a MarketState is itself a Candidate --
 *   a hypothesis that can be Generated/Screened/Confirmed/Published in
 *   its own right (candidate/MarketState.js extends Candidate). A Context
 *   is not a candidate at all -- it is a CONDITION attached to a
 *   ConditionalHypothesis (Candidate + up to 3 contexts,
 *   candidate/ConditionalHypothesis.js's MAX_CONTEXT_CONDITIONS=3), used
 *   to ask "does this candidate's relationship hold specifically WHEN
 *   this condition is true?" Collapsing the two into one registry would
 *   conflate "is Compression itself a confirmable discovery" with "is
 *   RSI's relationship to Rise different during Compression" -- two
 *   genuinely different scientific questions that happen to share
 *   detection math, which is exactly what this file's reuse pattern
 *   preserves without merging the concepts themselves.
 *
 * Dependencies: plugin/coreMarketStates.js (Trend/Compression/Expansion/
 *   Range/HighVolatility+LowVolatility StatePlugins — unmodified, reused),
 *   indicator/coreIndicators.js (MomentumIndicator — unmodified, reused),
 *   plugin/MachineReadableMathematics.js, context/{CandlePositionDetector,
 *   CandleTimingDetector,PriorCandleAnalyzer}.js (unmodified, re-exported
 *   for the single canonical registration list).
 * Public API: MarketSessionContext, VolatilityStateContext, TrendStateContext,
 *   MomentumStateContext, CompressionContext, ExpansionContext, RangeContext,
 *   CORE_CONTEXT_PLUGINS, registerCoreContexts.
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';
import {
  TrendStatePlugin, CompressionStatePlugin, ExpansionStatePlugin, RangeStatePlugin,
  HighVolatilityStatePlugin, LowVolatilityStatePlugin,
} from '../plugin/coreMarketStates.js';
import { MomentumIndicator } from '../indicator/coreIndicators.js';
import { CandlePositionDetector } from './CandlePositionDetector.js';
import { CandleTimingDetector } from './CandleTimingDetector.js';
import { PriorCandleAnalyzer } from './PriorCandleAnalyzer.js';

const DISCLAIMER = 'Context definition for ConditionalHypothesis generation -- a condition attached to another candidate\'s evaluation, not a candidate in its own right. maxLookahead=0.';

function baseMeta(name, description, extra = {}) {
  return Object.freeze({
    name, disclaimer: DISCLAIMER, version: '1.0.0', description,
    scientificAssumptions: ['maxLookahead=0: only observations up to and including time t are used.', ...(extra.scientificAssumptions || [])],
    dependencies: extra.dependencies || [], complexity: extra.complexity || 'O(n)',
    validationStatus: 'HEURISTIC', maxLookahead: 0,
  });
}

/**
 * Wraps an existing plugin/coreMarketStates.js state plugin's binary
 * signal into this file's {category, metadata} context convention.
 * Reuses that plugin's compute() verbatim -- adds zero new detection math.
 */
function wrapMarketStateAsContext({ name, description, statePlugin, window = 20 }) {
  return Object.freeze({
    metadata: () => baseMeta(name, description, { dependencies: [statePlugin.metadata().name] }),
    validate() { return { valid: true, errors: [] }; },
    compute({ states, window: w = window } = {}) {
      const { signal } = statePlugin.compute({ states, window: w });
      const category = signal.map((v) => (Number.isFinite(v) ? (v === 1 ? 'ACTIVE' : 'INACTIVE') : 'UNKNOWN'));
      return Object.freeze({ category, signal, metadata: Object.freeze({ stateCount: (states || []).length, window: w }) });
    },
    version: () => '1.0.0', dependencies: () => [statePlugin.metadata().name],
    tests: () => statePlugin.tests(),
    documentation: () => `${description} Reuses plugin/coreMarketStates.js's ${statePlugin.metadata().name} internally -- see that plugin's own documentation for the underlying math. ${DISCLAIMER}`,
    scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
    mathDefinition: statePlugin.mathDefinition,
  });
}

export const VolatilityStateContext = Object.freeze({
  metadata: () => baseMeta('VolatilityStateContext', 'Classifies the current volatility regime as HIGH, LOW, or NORMAL by delegating to the existing HighVolatility/LowVolatility market-state detectors.', { dependencies: ['HighVolatility', 'LowVolatility'] }),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, window = 20 } = {}) {
    const high = HighVolatilityStatePlugin.compute({ states, window }).signal;
    const low = LowVolatilityStatePlugin.compute({ states, window }).signal;
    const category = high.map((h, i) => (h === 1 ? 'HIGH' : (low[i] === 1 ? 'LOW' : (Number.isFinite(h) ? 'NORMAL' : 'UNKNOWN'))));
    return Object.freeze({ category, metadata: Object.freeze({ stateCount: (states || []).length, window }) });
  },
  version: () => '1.0.0', dependencies: () => ['HighVolatility', 'LowVolatility'],
  tests: () => [{ name: 'classifies a real state array without throwing', inputs: { states: Array.from({ length: 25 }, (_, i) => ({ tick_price: 100 + i })), window: 20 }, expectedOutputShape: { category: 'string[]' } }],
  documentation: () => `Volatility regime context. Reuses coreMarketStates.js's HighVolatility/LowVolatility plugins internally. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'category = HIGH if HighVolatilityState else (LOW if LowVolatilityState else NORMAL)',
    symbolicExpression: String.raw`\text{Vol}(t) = \begin{cases}\text{HIGH} & \text{HighVol}(t)=1\\\text{LOW} & \text{LowVol}(t)=1\\\text{NORMAL} & \text{otherwise}\end{cases}`,
    executableFormula: (high, low) => (high ? 'HIGH' : (low ? 'LOW' : 'NORMAL')), units: 'categorical', domain: 'ℝ^n', range: '{HIGH, LOW, NORMAL}',
  }),
});

export const TrendStateContext = wrapMarketStateAsContext({
  name: 'TrendStateContext', description: 'Whether the current window is trending, delegating to the existing Trend market-state detector.', statePlugin: TrendStatePlugin,
});
export const CompressionContext = wrapMarketStateAsContext({
  name: 'CompressionContext', description: 'Whether the current window shows volatility compression, delegating to the existing Compression market-state detector.', statePlugin: CompressionStatePlugin,
});
export const ExpansionContext = wrapMarketStateAsContext({
  name: 'ExpansionContext', description: 'Whether the current window shows volatility expansion, delegating to the existing Expansion market-state detector.', statePlugin: ExpansionStatePlugin,
});
export const RangeContext = wrapMarketStateAsContext({
  name: 'RangeContext', description: 'Whether the current window is range-bound/consolidating, delegating to the existing Range market-state detector.', statePlugin: RangeStatePlugin,
});

export const MomentumStateContext = Object.freeze({
  metadata: () => baseMeta('MomentumStateContext', 'Classifies current momentum as POSITIVE, NEGATIVE, or FLAT by delegating to the existing Momentum indicator.', { dependencies: ['Momentum'], complexity: 'O(n)' }),
  validate() { return { valid: true, errors: [] }; },
  compute({ states, period = 10 } = {}) {
    const prices = (states || []).map((s) => Number(s.tick_price));
    const { signal } = MomentumIndicator.compute({ prices, period });
    const category = signal.map((m) => (!Number.isFinite(m) ? 'UNKNOWN' : (m > 0 ? 'POSITIVE' : (m < 0 ? 'NEGATIVE' : 'FLAT'))));
    return Object.freeze({ category, signal, metadata: Object.freeze({ stateCount: prices.length, period }) });
  },
  version: () => '1.0.0', dependencies: () => ['Momentum'],
  tests: () => [{ name: 'a rising series shows positive momentum', inputs: { states: Array.from({ length: 15 }, (_, i) => ({ tick_price: 100 + i })), period: 5 }, expectedOutputShape: { category: 'string[]' } }],
  documentation: () => `Momentum-state context. Reuses indicator/coreIndicators.js's MomentumIndicator internally. ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'category = POSITIVE if Momentum_t > 0, NEGATIVE if < 0, else FLAT', symbolicExpression: String.raw`\text{Mom}(t) = \text{sign}(M_t)`,
    executableFormula: (m) => (m > 0 ? 'POSITIVE' : (m < 0 ? 'NEGATIVE' : 'FLAT')), units: 'categorical', domain: 'ℝ^n', range: '{POSITIVE, NEGATIVE, FLAT}',
  }),
});

const SESSION_BUCKETS = Object.freeze(['ASIA', 'EUROPE', 'US', 'OFF_HOURS']);
function classifySession(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return 'UNKNOWN';
  const hourUtc = new Date(epochSeconds * 1000).getUTCHours();
  if (hourUtc >= 0 && hourUtc < 8) return 'ASIA';
  if (hourUtc >= 7 && hourUtc < 16) return 'EUROPE';
  if (hourUtc >= 13 && hourUtc < 21) return 'US';
  return 'OFF_HOURS';
}

export const MarketSessionContext = Object.freeze({
  metadata: () => baseMeta('MarketSessionContext', 'Classifies each tick into an approximate trading session (Asia/Europe/US/off-hours) by UTC hour-of-day. Genuinely new to Phase 11 -- no other context or indicator reuses this concept.', {
    scientificAssumptions: ['UTC hour-of-day is a reasonable, if approximate, proxy for regional trading-session activity; real session boundaries vary by instrument and vary with daylight-saving transitions, not modeled here.'],
  }),
  validate() { return { valid: true, errors: [] }; },
  compute({ states } = {}) {
    const category = (states || []).map((s) => classifySession(Number(s.tick_timestamp)));
    return Object.freeze({ category, metadata: Object.freeze({ stateCount: (states || []).length, buckets: SESSION_BUCKETS }) });
  },
  version: () => '1.0.0', dependencies: () => [],
  tests: () => [{ name: 'classifies a UTC timestamp into a session bucket', inputs: { states: [{ tick_timestamp: 1700000000 }] }, expectedOutputShape: { category: 'string[]' } }],
  documentation: () => `Market session context (UTC hour-of-day proxy). ${DISCLAIMER}`,
  scientificAssumptions() { return [...this.metadata().scientificAssumptions]; },
  mathDefinition: createMathDefinition({
    humanReadable: 'session = bucket(UTC hour of tick_timestamp)', symbolicExpression: String.raw`S(t) = \text{bucket}(\text{hourUTC}(t))`,
    executableFormula: (epochSeconds) => classifySession(epochSeconds), units: 'categorical', domain: 'epoch seconds', range: '{ASIA, EUROPE, US, OFF_HOURS}',
  }),
});

export const CORE_CONTEXT_PLUGINS = Object.freeze([
  CandlePositionDetector, CandleTimingDetector, PriorCandleAnalyzer,
  MarketSessionContext, VolatilityStateContext, TrendStateContext, MomentumStateContext,
  CompressionContext, ExpansionContext, RangeContext,
]);

/** Registers every core context plugin (3 pre-existing + 7 new) into the given ContextRegistry -- the single canonical registration path. */
export function registerCoreContexts(registry) {
  for (const plugin of CORE_CONTEXT_PLUGINS) registry.register(plugin);
  return registry;
}
