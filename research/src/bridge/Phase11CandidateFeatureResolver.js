/**
 * research/src/bridge/Phase11CandidateFeatureResolver.js
 *
 * Purpose:
 *   Stage 6 of the "Continue Implementation" directive: the Confirmation
 *   Bridge, generalized to every real candidate type Phase 11 currently
 *   supports (IndicatorFeature, MarketState, ProxyCandidate,
 *   CompositeCandidate, ConditionalHypothesis) -- "every candidate type
 *   must flow through the identical confirmation architecture... no
 *   special-case confirmation paths."
 *
 *   Before this module: bridge/Phase11AutomatedConfirmation.js's
 *   computeIndicatorSeries() only knew how to resolve an IndicatorFeature
 *   candidate's own signal (via indicatorName/period against the
 *   canonical Indicator Registry). Every other candidate type had NO
 *   confirmation path at all -- attempting to confirm a MarketState or
 *   ProxyCandidate would throw "unrecognised indicatorName undefined"
 *   the same way registry-generated indicator candidates once did before
 *   the earlier architectural repair, for the identical root-cause reason:
 *   a narrow, type-specific resolver being asked about a type it had
 *   never been extended to handle.
 *
 *   resolveCandidateFeatureSeries() is the ONE canonical function every
 *   candidate type resolves through -- it dispatches by candidate.type to
 *   the SAME canonical registries candidate GENERATION already uses
 *   (indicator/IndicatorRegistry.js, plugin/MarketStateRegistry.js,
 *   proxy/MarketConstructProxyRegistry.js, context/ContextRegistry.js),
 *   never reimplementing any plugin's own math. Composite and Conditional
 *   candidates are resolved RECURSIVELY (a composite's feature series is
 *   built from its own components' feature series, resolved through this
 *   exact same function).
 *
 * GENERIC SIGNAL EXTRACTION, not a hardcoded name table: indicator and
 *   market-state plugins always return { signal: number[], ... }, but
 *   proxy/coreProxies.js's 10 plugins are genuinely heterogeneous --
 *   { signal }, { runLength }, { varianceRatio }, { rangeRatio },
 *   { rateRatio } depending on the proxy. Hardcoding a proxyName ->
 *   fieldName lookup table here would be exactly the kind of "scattered
 *   hard-coded names" / "parallel lookup table" this whole directive
 *   forbids. Instead, extractPrimarySignal() reads each plugin's OWN
 *   existing self-description -- PluginContract's tests()[0].expectedOutputShape,
 *   which every plugin already declares -- to find whichever field is
 *   typed 'number[]', generically, for every plugin type alike. This is
 *   reading existing canonical metadata, not adding a new one.
 *
 * WHAT "context condition holds" MEANS, precisely: each contextCondition
 *   object (produced by discovery/registryDrivenCandidateGenerator.js's
 *   streamConditionalHypothesisCandidateParams()) carries a
 *   requiredCategory alongside its contextName -- e.g. { contextName:
 *   'VolatilityStateContext', requiredCategory: 'HIGH' }. The mask for
 *   observation i is true where that context plugin's own category[i]
 *   equals the required category. Multiple conditions combine via the
 *   candidate's own conditionCombinator ('all' or 'any'), exactly as
 *   candidate/ConditionalHypothesis.js's own CONDITION_COMBINATORS define.
 *
 * SYNTHETIC STATE RECORDS: MarketState/ProxyCandidate/context plugins
 *   expect { states: [{ tick_price, ... }] } (richer than a flat price
 *   array), but a live confirmation dataset here is only ever a flat
 *   prices array (the same convention every other confirmation-adjacent
 *   module in this codebase already uses). This module synthesizes
 *   minimal state records ({ tick_price }) from that array -- honestly
 *   disclosed: any proxy or context whose math depends on candle_high/
 *   low/tick_direction/tick_timestamp (fields a flat price array cannot
 *   supply) will receive NaN for those inputs and produce degenerate
 *   (NaN) signal values at the affected indices, which the existing NaN-
 *   exclusion convention already used by computeQuickIndicatorScore/
 *   runAutomatedConfirmationTest correctly filters out as insufficient
 *   data, rather than silently computing a wrong answer.
 *
 * NOT SUPPORTED (documented limitation, not silently ignored): "Novel-
 *   state candidates" -- Stage 10 (Novel State Discovery) has not been
 *   built; there is no NOVEL_STATE candidate type to resolve, so this
 *   function's default case throws Phase11FeatureResolutionError for any
 *   unrecognised candidate.type, same as it would for any genuinely
 *   unsupported type.
 *
 * Dependencies: candidate/Candidate.js (CANDIDATE_TYPES, read-only),
 *   candidate/ConditionalHypothesis.js (CONDITION_COMBINATORS, read-only,
 *   unmodified), candidate/CompositeCandidate.js (COMBINATORS, read-only,
 *   unmodified). Deliberately does NOT import from
 *   bridge/Phase11AutomatedConfirmation.js (which imports
 *   resolveCandidateFeatureSeries FROM this module) -- Phase11FeatureResolutionError
 *   is defined here as its own distinct error type instead, avoiding a
 *   circular import.
 * Public API: resolveCandidateFeatureSeries, extractPrimarySignal,
 *   extractPrimaryCategory, pricesToStates, Phase11FeatureResolutionError.
 * Complexity: O(n) per leaf candidate (n = prices.length); O(n*d) for a
 *   composite/conditional nested d levels deep (each level re-walks the
 *   price series once -- no memoization across sibling calls within one
 *   resolution, since the datasets are small enough in current usage that
 *   the added complexity of a memo cache was not judged worth it here;
 *   documented as a possible future optimization, not a correctness gap).
 */

import { CANDIDATE_TYPES } from '../candidate/Candidate.js';
import { CONDITION_COMBINATORS } from '../candidate/ConditionalHypothesis.js';
import { COMBINATORS } from '../candidate/CompositeCandidate.js';

/**
 * A distinct error type from Phase11AutomatedConfirmation.js's
 * Phase11FeatureResolutionError -- genuinely different failure mode
 * (cannot resolve a candidate's feature series at all vs. resolved fine
 * but too few aligned pairs for a meaningful statistical test). Not
 * imported from that module to avoid a circular import (that module
 * imports resolveCandidateFeatureSeries FROM this one).
 */
export class Phase11FeatureResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11FeatureResolutionError';
  }
}

/**
 * Reads a plugin's own PluginContract self-description
 * (tests()[0].expectedOutputShape) to find which field of its compute()
 * output is the primary numeric signal array -- generic across every
 * plugin type, never a hardcoded per-plugin-name table.
 *
 * @param {object} plugin - A ScientificPlugin-conforming plugin.
 * @param {object} computeOutput - The result of plugin.compute(...).
 * @returns {number[]}
 */
export function extractPrimarySignal(plugin, computeOutput) {
  const testCases = typeof plugin.tests === 'function' ? plugin.tests() : [];
  const shape = testCases[0]?.expectedOutputShape;
  const fieldName = shape ? Object.keys(shape).find((k) => shape[k] === 'number[]') : null;
  const resolvedField = fieldName || (Array.isArray(computeOutput.signal) ? 'signal' : null);
  if (!resolvedField || !Array.isArray(computeOutput[resolvedField])) {
    throw new Phase11FeatureResolutionError(
      `extractPrimarySignal: could not identify a number[] output field for plugin "${plugin.metadata?.().name}" -- ` +
      `its PluginContract tests()[0].expectedOutputShape must declare exactly one 'number[]' field.`
    );
  }
  return computeOutput[resolvedField];
}

/**
 * Sister function to extractPrimarySignal: reads a plugin's own
 * PluginContract self-description to find which field of its compute()
 * output is the primary categorical (string[]) classification -- generic
 * across every context plugin, including the 3 pre-existing ones (which
 * use zone/phase/priorDirection, not the category field name this
 * module's own 7 newer contexts happen to use) and any future one.
 *
 * @param {object} plugin
 * @param {object} computeOutput
 * @returns {string[]}
 */
export function extractPrimaryCategory(plugin, computeOutput) {
  const testCases = typeof plugin.tests === 'function' ? plugin.tests() : [];
  const shape = testCases[0]?.expectedOutputShape;
  const fieldName = shape ? Object.keys(shape).find((k) => shape[k] === 'string[]') : null;
  const resolvedField = fieldName || (Array.isArray(computeOutput.category) ? 'category' : null);
  if (!resolvedField || !Array.isArray(computeOutput[resolvedField])) {
    throw new Phase11FeatureResolutionError(
      `extractPrimaryCategory: could not identify a string[] output field for plugin "${plugin.metadata?.().name}" -- ` +
      `its PluginContract tests()[0].expectedOutputShape must declare exactly one 'string[]' field.`
    );
  }
  return computeOutput[resolvedField];
}

/** Synthesizes minimal state records from a flat price array -- see module header's disclosure. */
export function pricesToStates(prices) {
  return (prices || []).map((p, i) => ({ tick_price: p, tick_timestamp: i }));
}

function combineComponentSeries(componentSeriesList, combinator, weights, length) {
  const out = new Array(length).fill(NaN);
  for (let i = 0; i < length; i++) {
    const values = componentSeriesList.map((s) => s[i]);
    if (values.some((v) => !Number.isFinite(v))) continue; // NaN propagates -- insufficient data at this index
    if (combinator === COMBINATORS.WEIGHTED) {
      out[i] = values.reduce((sum, v, idx) => sum + v * (weights?.[idx] ?? 1 / values.length), 0);
    } else {
      const active = values.map((v) => v !== 0);
      out[i] = combinator === COMBINATORS.DISJUNCTION
        ? (active.some(Boolean) ? 1 : 0)
        : (active.every(Boolean) ? 1 : 0); // CONJUNCTION is the default
    }
  }
  return out;
}

function computeContextMask({ contextConditions, contextRegistry, prices, combinator }) {
  const states = pricesToStates(prices);
  const perConditionMasks = contextConditions.map((cond) => {
    const plugin = contextRegistry?.lookup(cond.contextName);
    if (!plugin) {
      throw new Phase11FeatureResolutionError(
        `computeContextMask: context "${cond.contextName}" is not registered in the canonical Context Registry.`
      );
    }
    const output = plugin.compute({ states });
    const category = extractPrimaryCategory(plugin, output);
    return category.map((c) => c === cond.requiredCategory);
  });
  return prices.map((_, i) => {
    const values = perConditionMasks.map((m) => m[i]);
    return combinator === CONDITION_COMBINATORS.ANY ? values.some(Boolean) : values.every(Boolean);
  });
}

/**
 * THE canonical entry point: resolves ANY supported candidate's feature
 * series from a real price series. Dispatches by candidate.type; never
 * reimplements a plugin's own math.
 *
 * @param {object} params
 * @param {object} params.candidate
 * @param {object} params.registries - { indicatorRegistry, marketStateRegistry, proxyRegistry, contextRegistry }
 * @param {number[]} params.prices
 * @param {Record<string, object>} [params.componentsById] - Required for
 *   CompositeCandidate/ConditionalHypothesis -- maps componentIds/
 *   baseHypothesis.candidateId to the REAL candidate object (never a
 *   duplicate/reconstructed one).
 * @returns {number[]} One value per input index; NaN where unresolvable.
 */
export function resolveCandidateFeatureSeries({ candidate, registries = {}, prices, componentsById = {} } = {}) {
  const { indicatorRegistry, marketStateRegistry, proxyRegistry, contextRegistry } = registries;

  switch (candidate?.type) {
    case CANDIDATE_TYPES.INDICATOR_FEATURE: {
      const plugin = indicatorRegistry?.lookup(candidate.indicatorName);
      if (!plugin) throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: indicator "${candidate.indicatorName}" is not registered.`);
      const output = plugin.compute({ prices, period: candidate.period });
      return extractPrimarySignal(plugin, output);
    }
    case CANDIDATE_TYPES.MARKET_STATE: {
      const plugin = marketStateRegistry?.lookup(candidate.stateLabel);
      if (!plugin) throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: market state "${candidate.stateLabel}" is not registered.`);
      const output = plugin.compute({ states: pricesToStates(prices) });
      return extractPrimarySignal(plugin, output);
    }
    case CANDIDATE_TYPES.PROXY_CANDIDATE: {
      const plugin = proxyRegistry?.lookup(candidate.proxyName);
      if (!plugin) throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: proxy "${candidate.proxyName}" is not registered.`);
      const output = plugin.compute({ states: pricesToStates(prices) });
      return extractPrimarySignal(plugin, output);
    }
    case CANDIDATE_TYPES.COMPOSITE_CANDIDATE: {
      const componentSeries = candidate.componentIds.map((id) => {
        const component = componentsById[id];
        if (!component) throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: composite component "${id}" was not supplied in componentsById.`);
        return resolveCandidateFeatureSeries({ candidate: component, registries, prices, componentsById });
      });
      return combineComponentSeries(componentSeries, candidate.combinator, candidate.weights, prices.length);
    }
    case CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS: {
      const base = componentsById[candidate.baseHypothesis.candidateId];
      if (!base) throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: base hypothesis candidate "${candidate.baseHypothesis.candidateId}" was not supplied in componentsById.`);
      const baseSeries = resolveCandidateFeatureSeries({ candidate: base, registries, prices, componentsById });
      const mask = computeContextMask({ contextConditions: candidate.contextConditions, contextRegistry, prices, combinator: candidate.conditionCombinator });
      return baseSeries.map((v, i) => (mask[i] ? v : NaN));
    }
    default:
      throw new Phase11FeatureResolutionError(`resolveCandidateFeatureSeries: unsupported candidate type "${candidate?.type}".`);
  }
}
