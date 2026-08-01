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
  EMA: 'trend', SMA: 'trend', WMA: 'trend', MACD: 'trend', ADX: 'trend',
  RSI: 'momentum', CCI: 'momentum', Momentum: 'momentum', ROC: 'momentum',
  ATR: 'volatility', BollingerWidth: 'volatility', BollingerPosition: 'volatility', Volatility: 'volatility', Range: 'volatility',
  ZScore: 'statistical', Entropy: 'statistical', Hurst: 'statistical', FractalDimension: 'statistical',
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

/*
 * LIMITATIONS (stated honestly, not silently omitted):
 *
 * This module implements Stages 1 (Indicator Registry, in
 * indicator/IndicatorRegistry.js + coreIndicators.js), 7 (streaming), 8
 * (fingerprint dedup), and the single-indicator slice of Stage 9
 * (automatic Generated entry) from the directive. It does NOT implement:
 *
 *   - Stage 2 (MarketState Registry / plugins for Trend, Range,
 *     Compression, etc.)
 *   - Stage 3 (Observable Context Registry with the 3-context hard limit)
 *   - Stage 4 (Market Construct Proxy Registry auto-enumeration — the 10
 *     proxies in proxy/coreProxies.js exist and are already registry-
 *     driven via proxy/MarketConstructProxyRegistry.js, but this
 *     generator does not yet compose them into candidates)
 *   - Stage 5 (Composite Candidate Generator: Indicator+Indicator,
 *     Indicator+State, etc.)
 *   - Stage 6 (Conditional Hypothesis Generator, respecting the 3-context
 *     limit)
 *   - Stage 10 (dashboard breakdown by family/indicator/state/context/
 *     proxy/composite/conditional/duplicate/streaming-progress/memory)
 *
 * Candidate space size with the current default periods=[10,14,20,30] and
 * 21 registered indicators: 21 x 4 = 84 candidates (single-indicator only).
 * Composite and conditional generation (Stages 5-6) would multiply this
 * substantially once implemented — the streaming architecture here is
 * already sized for that (no unbounded array anywhere in this module), so
 * extending it to those stages should not require revisiting this file's
 * memory profile, only adding new streamXCandidateParams() generators
 * that a combined streamAllCandidates() can chain.
 */
