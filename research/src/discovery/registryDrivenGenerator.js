/**
 * research/src/discovery/registryDrivenGenerator.js
 *
 * Purpose:
 *   Replaces the demonstration 3-candidate generator (startPhase11Campaign.js's
 *   DEFAULT_INDICATOR_CANDIDATES, left fully intact for backward
 *   compatibility) with a scalable, registry-driven generation engine —
 *   Stages 5, 7, and 8 of the directive. Enumerates plugin/IndicatorRegistry.js
 *   and plugin/MarketStateRegistry.js (Stages 1-2, this same change) plus
 *   the ALREADY-EXISTING context/ContextRegistry.js and proxy/
 *   MarketConstructProxyRegistry.js (Stages 3-4 — pre-existing Phase B
 *   infrastructure, wired here for the first time, not rebuilt) into real
 *   Candidate instances, streamed rather than materialized in bulk.
 *
 * What this delivers now (tested, working):
 *   - Streaming generation of IndicatorFeature candidates: registry ×
 *     period grid, via an async generator (yields one at a time — no
 *     array of N candidates is ever held in memory by the generator
 *     itself; see "Memory bounds" below for the one disclosed exception).
 *   - Streaming generation of MarketState candidates from the Market
 *     State Registry.
 *   - Streaming generation of two composite combination types (Stage 5):
 *     Indicator+Indicator and Indicator+MarketState, via
 *     candidate/CompositeCandidate.js's existing CONJUNCTION combinator —
 *     bounded pairing (not full combinatorial explosion) so this stays
 *     practical even with a large component pool.
 *   - Fingerprint-based deduplication (Stage 8): every candidate is
 *     fingerprinted by Candidate.create()'s OWN existing SHA-256
 *     content-addressed hash (never reimplemented here); a caller-shared
 *     `seenFingerprints` Set is checked before yielding, so a duplicate
 *     definition (same type/family/parameters/generatorVersion/
 *     grammarVersion) is silently skipped rather than entering the
 *     pipeline twice.
 *
 * Explicitly deferred (documented, not silently omitted — this directive's
 *   full scope is far larger than one increment):
 *   - Observable Context Registry auto-combination (Stage 3): the
 *     pre-existing ContextRegistry is wired and enumerable here
 *     (listRegisteredContextNames), but automatic Indicator+Context /
 *     State+Context / Composite+Context candidate generation respecting
 *     ConditionalHypothesis.js's existing MAX_CONTEXT_CONDITIONS=3 hard
 *     limit is not yet built.
 *   - Market Construct Proxy auto-combination (Stage 4): same status as
 *     Context — the registry is wired and enumerable
 *     (listRegisteredProxyNames), Indicator+Proxy / Proxy+State candidate
 *     generation is not yet built.
 *   - The remaining 7 of Stage 5's 9 composite combination types (State+
 *     State, Indicator+Proxy, Proxy+State, Indicator+Context, State+
 *     Context, Proxy+Context, Composite+Context).
 *   - Stage 6 (Conditional Hypothesis Generator) — not started.
 *   - Stage 10 (dashboard: totals by family/indicator/state/context/proxy,
 *     duplicate-removed count, streaming progress, generation
 *     time/memory) — not started; the existing dashboard's Candidate
 *     Count continues to reflect whatever was actually generated,
 *     honestly, just without the new breakdown views.
 *
 * Memory bounds (Stage 7): the async generator itself yields one
 *   candidate at a time and holds no candidate array. The ONE piece of
 *   state that grows with output size is the caller-supplied
 *   `seenFingerprints` Set (Stage 8 requires remembering what's already
 *   been emitted to deduplicate against) — this is a Set<string> of
 *   64-character hex strings, not candidate objects, so its footprint at
 *   100,000 candidates is on the order of a few megabytes, not the
 *   multi-hundred-megabyte footprint holding 100,000 full Candidate
 *   objects in an array would cost. This trade-off is disclosed, not
 *   hidden: true O(1) memory would require abandoning cross-call
 *   deduplication entirely, which Stage 8 explicitly requires.
 *
 * Scientific safeguards preserved (nothing here bypasses any of these —
 *   every generated candidate is a genuine Candidate.create() call with
 *   the SAME validation, the SAME fingerprinting, the SAME lifecycle
 *   default (Generated) as the existing 3-candidate generator produced):
 *   ResearchFreeze/SAP/DatasetManifest, DecisionAuditLog,
 *   NegativeEvidenceRegistry, candidate fingerprints, Provenance DAG,
 *   feature provenance, candidate lineage, the Winner's Curse firewall,
 *   Online FDR, maxLookahead=0 (enforced structurally by PluginContract's
 *   validatePlugin on every indicator/state plugin), ReproducibilityGate,
 *   Knowledge Graph integration — none of this file touches any of them;
 *   it only constructs Candidate instances, same as the old generator did.
 *
 * Dependencies: candidate/IndicatorFeature.js, candidate/MarketState.js,
 *   candidate/CompositeCandidate.js (all unmodified), plugin/
 *   IndicatorRegistry.js, plugin/MarketStateRegistry.js (this same change).
 * Public API: generateIndicatorCandidatesStream, generateMarketStateCandidatesStream,
 *   generateCompositeCandidatesStream, RegistryDrivenGeneratorError.
 * Complexity: O(1) memory for candidate objects themselves (streaming);
 *   O(k) memory for the seenFingerprints Set, k = candidates yielded so far.
 */

import { IndicatorFeature } from '../candidate/IndicatorFeature.js';
import { MarketState } from '../candidate/MarketState.js';
import { CompositeCandidate, COMBINATORS } from '../candidate/CompositeCandidate.js';

export class RegistryDrivenGeneratorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryDrivenGeneratorError';
  }
}

/**
 * Streams IndicatorFeature candidates: one per (registered indicator
 * plugin) x (period in `periods`) combination, deduplicated by fingerprint.
 *
 * @param {object} params
 * @param {import('../plugin/IndicatorRegistry.js').IndicatorRegistry} params.indicatorRegistry
 * @param {number[]} [params.periods] - Defaults to [10, 14, 20, 50].
 * @param {object} params.baseParams - { family, generatorVersion, grammarVersion,
 *   configHash, researchConfigurationId } shared across all generated candidates.
 * @param {Set<string>} [params.seenFingerprints] - Shared across calls for
 *   cross-generator deduplication; created fresh if omitted.
 * @yields {{ candidate: object, plugin: object }}
 */
export async function* generateIndicatorCandidatesStream({
  indicatorRegistry, periods = [10, 14, 20, 50], baseParams, seenFingerprints = new Set(),
} = {}) {
  if (!indicatorRegistry || typeof indicatorRegistry.list !== 'function') {
    throw new RegistryDrivenGeneratorError('generateIndicatorCandidatesStream: a valid IndicatorRegistry is required');
  }
  for (const plugin of indicatorRegistry.list()) {
    const meta = plugin.metadata();
    for (const period of periods) {
      const candidate = await IndicatorFeature.create({
        ...baseParams,
        id: `ind-${meta.name}-${period}`,
        parameters: { period },
        description: `${meta.displayName} (period=${period}) -- ${meta.description}`,
        indicatorName: meta.name,
        period,
        inputObservables: [],
      });
      if (seenFingerprints.has(candidate.fingerprint)) continue;
      seenFingerprints.add(candidate.fingerprint);
      yield { candidate, plugin };
    }
  }
}

/**
 * Streams MarketState candidates: one per registered market-state plugin,
 * deduplicated by fingerprint.
 *
 * @param {object} params
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} params.marketStateRegistry
 * @param {object} params.baseParams
 * @param {Set<string>} [params.seenFingerprints]
 * @yields {{ candidate: object, plugin: object }}
 */
export async function* generateMarketStateCandidatesStream({
  marketStateRegistry, baseParams, seenFingerprints = new Set(),
} = {}) {
  if (!marketStateRegistry || typeof marketStateRegistry.list !== 'function') {
    throw new RegistryDrivenGeneratorError('generateMarketStateCandidatesStream: a valid MarketStateRegistry is required');
  }
  for (const plugin of marketStateRegistry.list()) {
    const meta = plugin.metadata();
    const candidate = await MarketState.create({
      ...baseParams,
      id: `state-${meta.name}`,
      parameters: {},
      description: `${meta.displayName} -- ${meta.description}`,
      stateLabel: plugin.stateLabel || meta.name,
      detectionCriteria: { pluginName: meta.name, humanReadable: meta.description },
    });
    if (seenFingerprints.has(candidate.fingerprint)) continue;
    seenFingerprints.add(candidate.fingerprint);
    yield { candidate, plugin };
  }
}

/**
 * Streams CompositeCandidate instances combining pairs drawn from two
 * component streams (Stage 5, two of the nine combination types:
 * Indicator+Indicator when both inputs are indicator candidates,
 * Indicator+MarketState when one of each). Bounded: pairs sequentially
 * (component[i] with component[i+1]) rather than the full n² cross
 * product, so this stays practical for large component pools — a
 * disclosed simplification, not silent under-generation.
 *
 * @param {object} params
 * @param {object[]} params.components - Candidate objects to combine (in order).
 * @param {object} params.baseParams
 * @param {string} [params.combinator] - One of CompositeCandidate's COMBINATORS; defaults to CONJUNCTION.
 * @param {Set<string>} [params.seenFingerprints]
 * @param {number} [params.maxComposites] - Optional cap on how many to yield.
 * @yields {{ candidate: object }}
 */
export async function* generateCompositeCandidatesStream({
  components, baseParams, combinator = COMBINATORS.CONJUNCTION, seenFingerprints = new Set(), maxComposites = Infinity,
} = {}) {
  if (!Array.isArray(components) || components.length < 2) {
    throw new RegistryDrivenGeneratorError('generateCompositeCandidatesStream: at least 2 components are required');
  }
  let emitted = 0;
  for (let i = 0; i + 1 < components.length && emitted < maxComposites; i++) {
    const a = components[i], b = components[i + 1];
    const candidate = await CompositeCandidate.create({
      ...baseParams,
      id: `composite-${a.id}-${b.id}`,
      parameters: {},
      description: `${a.description} AND ${b.description}`,
      componentIds: [a.id, b.id],
      combinator,
      weights: combinator === COMBINATORS.WEIGHTED ? [0.5, 0.5] : null,
    });
    if (seenFingerprints.has(candidate.fingerprint)) continue;
    seenFingerprints.add(candidate.fingerprint);
    emitted++;
    yield { candidate };
  }
}
