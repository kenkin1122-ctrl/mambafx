/**
 * research/src/discovery/registryDrivenCandidateGenerator.js
 *
 * Purpose:
 *   Replaces the demonstration 3-candidate generator (startPhase11Campaign.js's
 *   DEFAULT_INDICATOR_CANDIDATES — unmodified, still available and still
 *   the default for backward compatibility) with a genuine registry-driven
 *   generator: enumerates every plugin registered in an IndicatorRegistry
 *   × a set of periods, and streams real, deduplicated, fully-governed
 *   IndicatorFeature candidates.
 *
 *   Scope of this increment: single-indicator IndicatorFeature candidates
 *   only (Stage 1's Indicator Registry -> Stage 9's automatic Generated
 *   entry). MarketState/Context/Proxy registries and Composite/Conditional
 *   generation (Stages 2-6 of the directive) are NOT implemented here —
 *   see the module-level LIMITATIONS note at the bottom of this file and
 *   the accompanying delivery report for why, and what remains.
 *
 * Streaming (Stage 7): streamRegistryDrivenCandidates() is an async
 *   generator. It holds only the current candidate plus a Set of seen
 *   fingerprints (Stage 8 dedup) in memory at any time — never a full
 *   array of (indicator × period) combinations. A caller generating
 *   100,000+ candidates consumes them one at a time (e.g. via `for await`)
 *   without the generator itself accumulating an unbounded array. The
 *   caller's own OWN accumulation choice (e.g. feeding them into
 *   Phase11Orchestrator's _candidates Map) is outside this module's
 *   control — that Map is the existing, unmodified campaign registry, and
 *   its own memory profile is unchanged from before this increment.
 *
 * Every generated candidate goes through the EXISTING, UNMODIFIED
 *   discovery/candidateGenerator.js's generateCandidate() — the same
 *   function startPhase11Campaign.js's demonstration generator already
 *   used. This module does not construct Candidate instances itself, does
 *   not compute fingerprints itself (Candidate.js's own content-addressed
 *   SHA-256 hashing does that, unmodified), and does not bypass
 *   ResearchFreeze/SAP/FamilyRegistry/ProvenanceDAG/DecisionAuditLog —
 *   every governance gate generateCandidate() already enforces applies
 *   here unchanged.
 *
 * Dependencies: discovery/candidateGenerator.js (generateCandidate —
 *   unmodified), indicator/IndicatorRegistry.js, candidate/MeasurementRegistry.js
 *   (PRIMITIVE_OBSERVABLES — unmodified).
 * Public API: INDICATOR_FAMILY_BY_NAME, streamIndicatorCandidateParams,
 *   streamRegistryDrivenCandidates, RegistryDrivenGenerationError.
 * Complexity: O(indicators × periods) total work; O(1) additional memory
 *   per yielded candidate beyond the seen-fingerprints Set (O(k) where k =
 *   number of unique candidates actually yielded so far).
 */

import { generateCandidate } from './candidateGenerator.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';
import { PRIMITIVE_OBSERVABLES } from '../candidate/MeasurementRegistry.js';

export class RegistryDrivenGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryDrivenGenerationError';
  }
}

/**
 * A reasonable, standard categorization of the core indicators into
 * families for FamilyRegistry/legacy-family-key purposes — not part of
 * any indicator's own PluginContract metadata (which doesn't require a
 * "family" field), so this mapping lives here, in the generator that
 * actually needs it. New indicators registered later that aren't in this
 * map fall back to a generic "indicator" family (see below) rather than
 * throwing — registration should never require updating this file.
 */
export const INDICATOR_FAMILY_BY_NAME = Object.freeze({
  EMA: 'trend', SMA: 'trend', WMA: 'trend', MACD: 'trend', ADX: 'trend', EMA_SLOPE: 'trend',
  RSI: 'momentum', CCI: 'momentum', Momentum: 'momentum', ROC: 'momentum', StochasticK: 'momentum',
  ATR: 'volatility', BollingerWidth: 'volatility', BollingerPosition: 'volatility', Volatility: 'volatility', Range: 'volatility', KeltnerWidth: 'volatility',
  ZScore: 'statistical', Entropy: 'statistical', Hurst: 'statistical', FractalDimension: 'statistical', Autocorrelation: 'statistical', Skewness: 'statistical', Kurtosis: 'statistical',
  RunLength: 'microstructure', TickImbalance: 'microstructure', DirectionalEntropy: 'microstructure',
});
const DEFAULT_FAMILY = 'indicator';

/**
 * Lazily yields candidateParams-shaped objects (NOT yet Candidate
 * instances — no async work, no fingerprinting) for every
 * (registered indicator × period) combination. Pure and synchronous;
 * used internally by streamRegistryDrivenCandidates() and exported
 * separately so callers can inspect the intended candidate space (e.g.
 * for dashboard "estimated candidate space size" reporting) without
 * paying for candidate construction.
 *
 * @param {object} params
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} params.indicatorRegistry
 * @param {number[]} [params.periods=[10, 14, 20, 30]]
 * @param {object} params.researchConfiguration
 * @yields {object} A candidateParams object ready for generateCandidate().
 */
export function* streamIndicatorCandidateParams({
  indicatorRegistry, periods = [10, 14, 20, 30], researchConfiguration,
} = {}) {
  if (!indicatorRegistry || typeof indicatorRegistry.list !== 'function') {
    throw new RegistryDrivenGenerationError('streamIndicatorCandidateParams: a valid IndicatorRegistry is required');
  }
  if (!researchConfiguration?.id || !researchConfiguration?.configHash) {
    throw new RegistryDrivenGenerationError('streamIndicatorCandidateParams: a valid ResearchConfiguration is required');
  }
  for (const plugin of indicatorRegistry.list()) {
    const meta = plugin.metadata();
    const family = INDICATOR_FAMILY_BY_NAME[meta.name] || DEFAULT_FAMILY;
    for (const period of periods) {
      yield {
        id: `${meta.name}-${period}`,
        family,
        parameters: { period },
        description: `${meta.displayName || meta.name} (period=${period}) — auto-generated from the Indicator Registry.`,
        generatorVersion: '11.1.0',
        grammarVersion: '11.0.0',
        configHash: researchConfiguration.configHash,
        researchConfigurationId: researchConfiguration.id,
        indicatorName: meta.name,
        period,
        inputObservables: [PRIMITIVE_OBSERVABLES.TICK_PRICE],
      };
    }
  }
}

/**
 * Streams fully-governed, deduplicated Phase 11 candidates for every
 * (registered indicator × period) combination — the registry-driven
 * replacement for the old hardcoded 3-candidate demonstration generator.
 * Every yielded candidate has already passed through the existing,
 * unmodified generateCandidate() (ResearchFreeze/SAP/FamilyRegistry
 * checks, real fingerprint, real ProvenanceDAG, optional
 * DecisionAuditLog entry).
 *
 * @param {object} params
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} params.indicatorRegistry
 * @param {number[]} [params.periods]
 * @param {object} params.researchConfiguration
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {(err: Error, candidateParams: object) => void} [params.onSkip] - Called
 *   (not thrown) for candidates that fail generation for a recoverable
 *   reason (e.g. FamilyRegistry incompatibility for an indicator whose
 *   auto-assigned family isn't registered) — generation continues with
 *   the next candidate rather than aborting the whole stream.
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamRegistryDrivenCandidates({
  indicatorRegistry, periods, researchConfiguration, researchFreeze, sap,
  familyRegistry = null, decisionAuditLog = null, onSkip = null,
} = {}) {
  const seenFingerprints = new Set();
  let duplicateCount = 0;

  for (const candidateParams of streamIndicatorCandidateParams({ indicatorRegistry, periods, researchConfiguration })) {
    let result;
    try {
      result = await generateCandidate({
        candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
        candidateParams, researchFreeze, sap, familyRegistry, decisionAuditLog,
      });
    } catch (err) {
      if (onSkip) onSkip(err, candidateParams);
      continue;
    }

    // Stage 8: fingerprint-based deduplication — a duplicate fingerprint
    // (e.g. two periods that happen to produce byte-identical parameters,
    // or the same indicator registered under two names) must never enter
    // the pipeline twice.
    if (seenFingerprints.has(result.candidate.fingerprint)) {
      duplicateCount++;
      continue;
    }
    seenFingerprints.add(result.candidate.fingerprint);
    yield result;
  }
}

/**
 * Lazily yields candidateParams-shaped objects for every registered
 * market-state plugin (Stage 2's MarketState Registry, added alongside
 * this extension — plugin/MarketStateRegistry.js + coreMarketStates.js).
 * Mirrors streamIndicatorCandidateParams()'s exact shape/discipline: pure,
 * synchronous, no async work, no fingerprinting.
 *
 * @param {object} params
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} params.marketStateRegistry
 * @param {object} params.researchConfiguration
 * @yields {object} A candidateParams object ready for generateCandidate().
 */
export function* streamMarketStateCandidateParams({
  marketStateRegistry, researchConfiguration,
} = {}) {
  if (!marketStateRegistry || typeof marketStateRegistry.list !== 'function') {
    throw new RegistryDrivenGenerationError('streamMarketStateCandidateParams: a valid MarketStateRegistry is required');
  }
  if (!researchConfiguration?.id || !researchConfiguration?.configHash) {
    throw new RegistryDrivenGenerationError('streamMarketStateCandidateParams: a valid ResearchConfiguration is required');
  }
  for (const plugin of marketStateRegistry.list()) {
    const meta = plugin.metadata();
    yield {
      id: `state-${meta.name}`,
      family: 'marketState',
      parameters: {},
      description: `${meta.displayName || meta.name} — auto-generated from the Market State Registry.`,
      generatorVersion: '11.1.0',
      grammarVersion: '11.0.0',
      configHash: researchConfiguration.configHash,
      researchConfigurationId: researchConfiguration.id,
      stateLabel: plugin.stateLabel || meta.name,
      detectionCriteria: { pluginName: meta.name, humanReadable: meta.description },
    };
  }
}

/**
 * Streams fully-governed, deduplicated MarketState candidates — the
 * MarketState-Registry counterpart to streamRegistryDrivenCandidates().
 * Same generateCandidate()-routed governance, same graceful onSkip
 * handling, same fingerprint deduplication.
 *
 * @param {object} params
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} params.marketStateRegistry
 * @param {object} params.researchConfiguration
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {Set<string>} [params.seenFingerprints] - Shared with
 *   streamRegistryDrivenCandidates() to deduplicate across BOTH streams
 *   when chained (see streamAllRegistryDrivenCandidates below).
 * @param {(err: Error, candidateParams: object) => void} [params.onSkip]
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamMarketStateCandidates({
  marketStateRegistry, researchConfiguration, researchFreeze, sap,
  familyRegistry = null, decisionAuditLog = null, seenFingerprints = new Set(), onSkip = null,
} = {}) {
  for (const candidateParams of streamMarketStateCandidateParams({ marketStateRegistry, researchConfiguration })) {
    let result;
    try {
      result = await generateCandidate({
        candidateType: CANDIDATE_TYPES.MARKET_STATE,
        candidateParams, researchFreeze, sap, familyRegistry, decisionAuditLog,
      });
    } catch (err) {
      if (onSkip) onSkip(err, candidateParams);
      continue;
    }
    if (seenFingerprints.has(result.candidate.fingerprint)) continue;
    seenFingerprints.add(result.candidate.fingerprint);
    yield result;
  }
}

/**
 * Chains streamRegistryDrivenCandidates() (indicators) and
 * streamMarketStateCandidates() (market states) into one stream sharing a
 * single seenFingerprints Set, exactly as this file's own original
 * LIMITATIONS note anticipated ("extending it to those stages should not
 * require revisiting this file's memory profile, only adding new
 * streamXCandidateParams() generators that a combined streamAllCandidates()
 * can chain"). Composite/Conditional/Context/Proxy generation (Stages
 * 3-6) are NOT chained here yet — see the updated LIMITATIONS note below.
 *
 * @param {object} params - Union of streamRegistryDrivenCandidates' and
 *   streamMarketStateCandidates' params, plus:
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} [params.indicatorRegistry]
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} [params.marketStateRegistry]
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamAllRegistryDrivenCandidates({
  indicatorRegistry, marketStateRegistry, periods, researchConfiguration, researchFreeze, sap,
  familyRegistry = null, decisionAuditLog = null, onSkip = null,
} = {}) {
  const seenFingerprints = new Set();
  if (indicatorRegistry) {
    for await (const result of streamRegistryDrivenCandidates({
      indicatorRegistry, periods, researchConfiguration, researchFreeze, sap, familyRegistry, decisionAuditLog, onSkip,
    })) {
      if (seenFingerprints.has(result.candidate.fingerprint)) continue;
      seenFingerprints.add(result.candidate.fingerprint);
      yield result;
    }
  }
  if (marketStateRegistry) {
    for await (const result of streamMarketStateCandidates({
      marketStateRegistry, researchConfiguration, researchFreeze, sap, familyRegistry, decisionAuditLog, seenFingerprints, onSkip,
    })) {
      yield result;
    }
  }
}

/**
 * Lazily yields candidateParams-shaped objects for CompositeCandidate
 * instances pairing consecutive components from a supplied list (bounded
 * sequential pairing -- component[i] with component[i+1] -- not the full
 * n² cross product, so this stays practical for large component pools;
 * a disclosed simplification, not silent under-generation).
 *
 * @param {object} params
 * @param {object[]} params.components - Already-generated candidate objects to pair.
 * @param {object} params.researchConfiguration
 * @param {string} [params.combinator='conjunction']
 * @param {number} [params.maxComposites=Infinity]
 * @yields {object} A candidateParams object ready for generateCandidate().
 */
export function* streamCompositeCandidateParams({
  components, researchConfiguration, combinator = 'conjunction', maxComposites = Infinity,
} = {}) {
  if (!Array.isArray(components) || components.length < 2) {
    throw new RegistryDrivenGenerationError('streamCompositeCandidateParams: at least 2 components are required');
  }
  if (!researchConfiguration?.id || !researchConfiguration?.configHash) {
    throw new RegistryDrivenGenerationError('streamCompositeCandidateParams: a valid ResearchConfiguration is required');
  }
  let emitted = 0;
  for (let i = 0; i + 1 < components.length && emitted < maxComposites; i++) {
    const a = components[i], b = components[i + 1];
    yield {
      id: `composite-${a.id}-${b.id}`,
      family: 'composite',
      parameters: {},
      description: `${a.description} AND ${b.description} — auto-generated composite.`,
      generatorVersion: '11.1.0',
      grammarVersion: '11.0.0',
      configHash: researchConfiguration.configHash,
      researchConfigurationId: researchConfiguration.id,
      componentIds: [a.id, b.id],
      combinator,
      weights: combinator === 'weighted' ? [0.5, 0.5] : null,
    };
    emitted++;
  }
}

/**
 * Streams fully-governed, deduplicated CompositeCandidate instances,
 * routed through the existing generateCandidate() exactly like every
 * other stream in this module. Stage 4: currently supports pairing
 * components drawn from indicator and/or market-state streams
 * (Indicator+Indicator, Indicator+MarketState, State+State, depending on
 * what the caller passes as `components`). Indicator+Proxy and
 * State+Proxy are NOT implemented yet -- see this file's LIMITATIONS note.
 *
 * @param {object} params
 * @param {object[]} params.components
 * @param {object} params.researchConfiguration
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {string} [params.combinator]
 * @param {number} [params.maxComposites]
 * @param {Set<string>} [params.seenFingerprints]
 * @param {(err: Error, candidateParams: object) => void} [params.onSkip]
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamCompositeCandidates({
  components, researchConfiguration, researchFreeze, sap, familyRegistry = null,
  decisionAuditLog = null, combinator = 'conjunction', maxComposites = Infinity,
  seenFingerprints = new Set(), onSkip = null,
} = {}) {
  for (const candidateParams of streamCompositeCandidateParams({ components, researchConfiguration, combinator, maxComposites })) {
    let result;
    try {
      result = await generateCandidate({
        candidateType: CANDIDATE_TYPES.COMPOSITE_CANDIDATE,
        candidateParams, researchFreeze, sap, familyRegistry, decisionAuditLog,
      });
    } catch (err) {
      if (onSkip) onSkip(err, candidateParams);
      continue;
    }
    if (seenFingerprints.has(result.candidate.fingerprint)) continue;
    seenFingerprints.add(result.candidate.fingerprint);
    yield result;
  }
}


/*
 * LIMITATIONS (stated honestly, not silently omitted; updated again to
 * reflect the composite-generation extension):
 *
 * This module now implements Stages 1 (Indicator Registry, 26 plugins),
 * 2 (Market State Registry, 15 plugins, in plugin/MarketStateRegistry.js
 * + coreMarketStates.js — directory placement inconsistent with
 * indicator/IndicatorRegistry.js's convention; a real but minor
 * organizational debt, not a functional gap), 4 (Composite Candidate
 * Generator -- Indicator+Indicator, Indicator+MarketState, State+State,
 * via streamCompositeCandidates(), bounded sequential pairing not full
 * n²), 7 (streaming), 8 (fingerprint dedup), and the covered-registries
 * slice of Stage 9 (automatic Generated entry). It does NOT implement:
 *
 *   - Stage 3 (Observable Context Registry with the 3-context hard limit)
 *   - Stage 4's remaining two composite types (Indicator+Proxy,
 *     State+Proxy) -- the 10 proxies in proxy/coreProxies.js exist and
 *     are already registry-driven via proxy/MarketConstructProxyRegistry.js,
 *     but this generator does not yet compose them into candidates
 *   - Stage 5 (Conditional Hypothesis Generator, respecting the 3-context
 *     limit)
 *   - Stage 10 (dashboard breakdown by family/indicator/state/context/
 *     proxy/composite/conditional/duplicate/streaming-progress/memory)
 *   - "Novel States" (deliberately not invented -- would require an
 *     anomaly-detection framework not yet built; inventing a heuristic
 *     for it without real statistical grounding would violate "do not
 *     invent states unsupported by observable measurements")
 *
 * Candidate space size with the current default periods=[10,14,20,30],
 * 26 registered indicators, and 15 registered market states:
 * (26 x 4) + 15 = 119 single-type candidates. Composite generation over
 * that same pool (bounded sequential pairing, one composite per adjacent
 * pair) adds up to another ~118. Combined: ~237 candidates from the
 * currently-registered plugin sets alone, before widening the period
 * grid further (which does scale this substantially -- see the
 * regression tests for a 1,500+-candidate run).
 */

