/**
 * research/src/discovery/NovelStateDiscovery.js
 *
 * Purpose:
 *   Stage 10 of the "Continue Implementation" directive: automatic
 *   discovery of novel market states, with NO predefined market-state
 *   assumptions -- pure data-driven clustering over raw statistical
 *   features, not over any of the 15 predefined plugin/coreMarketStates.js
 *   labels (Trend, Range, Compression, etc.). A discovered cluster only
 *   becomes a candidate if it is genuinely NOVEL -- meaningfully far, in
 *   feature space, from every KNOWN state's own empirically-measured
 *   typical feature signature (computed from real data, not assumed).
 *
 * FEATURE EXTRACTION, no new statistics: every dimension of the feature
 *   vector clustering operates on is computed by an EXISTING, unmodified
 *   indicator plugin from indicator/coreIndicators.js -- ZScoreIndicator,
 *   SkewnessIndicator, KurtosisIndicator, AutocorrelationIndicator,
 *   VolatilityIndicator. This module adds zero new statistical formulas;
 *   it only reshapes their existing outputs into per-window feature
 *   vectors. Choosing these five (rather than, say, a predefined "is this
 *   trending" label) is precisely what keeps the discovery process
 *   assumption-free: they are raw distributional/dependency statistics
 *   with no market-state semantics baked in.
 *
 * CLUSTERING: k-means IS genuinely new code in this file -- no clustering
 *   utility exists anywhere else in this codebase to reuse. It uses the
 *   EXISTING createSeededRng (statistics/uncertaintyEstimation.js,
 *   unmodified) for centroid initialization -- not a second PRNG -- so
 *   runs are deterministic and reproducible given a seed, the same "no
 *   hidden randomness" discipline used throughout Phase 11.
 *
 * NOVELTY SCORING: for each of the 15 registered MarketState plugins, this
 *   module finds every window where that plugin's own detector actually
 *   fires (signal=1) on the REAL price series and computes the MEAN
 *   feature vector across those real windows -- an empirically-measured
 *   "typical signature" for each known state, not an assumed one. A
 *   discovered cluster's novelty score is its Euclidean distance (in the
 *   same 5-dimensional feature space) to the NEAREST known state's
 *   signature; only clusters whose nearest-known distance exceeds
 *   noveltyThreshold are reported as genuinely novel.
 *
 * SCIENTIFIC EXPLAINABILITY: every discovered novel-state candidate's
 *   detectionCriteria records exactly which features define its cluster
 *   centroid, its novelty score, and which known state it is LEAST
 *   unlike (nearestKnownState) -- a researcher can always see precisely
 *   why this was flagged as novel, never a black-box label.
 *
 * REPRESENTATION: a discovered novel state is a REAL MarketState
 *   candidate (candidate/MarketState.js, unmodified) -- not a new
 *   NOVEL_STATE candidate type. MarketState.js's own docstring already
 *   defines its scope as "a named, rule-based classification of overall
 *   market conditions" -- a discovered cluster is exactly that, the rule
 *   just came from clustering instead of being hand-specified. This
 *   candidate therefore gets fingerprint/provenance/lifecycle/Knowledge
 *   Graph integration for free, through the exact same generateCandidate()
 *   every other candidate type already uses -- no special-case governance
 *   path was created for novel states.
 *
 * Dependencies: indicator/coreIndicators.js (ZScoreIndicator,
 *   SkewnessIndicator, KurtosisIndicator, AutocorrelationIndicator,
 *   VolatilityIndicator -- unmodified, reused), statistics/uncertaintyEstimation.js
 *   (createSeededRng -- unmodified, reused), discovery/candidateGenerator.js
 *   (generateCandidate -- unmodified, reused), candidate/Candidate.js
 *   (CANDIDATE_TYPES, read-only).
 * Public API: computeFeatureVector, computeAllFeatureVectors, kMeansCluster,
 *   computeKnownStateSignatures, scoreNovelty, streamNovelStateCandidateParams,
 *   streamNovelStateCandidates, NovelStateDiscoveryError.
 * Complexity: O(n) feature extraction per window (n = window size);
 *   O(w) windows total; k-means O(w*k*iterations); novelty scoring
 *   O(w*15) for the known-state signature pass.
 */

import { ZScoreIndicator, SkewnessIndicator, KurtosisIndicator, AutocorrelationIndicator, VolatilityIndicator } from '../indicator/coreIndicators.js';
import { createSeededRng } from '../statistics/uncertaintyEstimation.js';
import { generateCandidate } from './candidateGenerator.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

export class NovelStateDiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NovelStateDiscoveryError';
  }
}

const FEATURE_PLUGINS = Object.freeze([ZScoreIndicator, VolatilityIndicator, SkewnessIndicator, KurtosisIndicator, AutocorrelationIndicator]);
export const FEATURE_NAMES = Object.freeze(FEATURE_PLUGINS.map((p) => p.metadata().name));

/**
 * Computes the real, assumption-free feature vector at index i: one
 * value per FEATURE_PLUGINS entry, each computed by that EXISTING
 * indicator plugin's own compute() over the trailing `period` prices.
 * @param {number[]} prices
 * @param {number} i
 * @param {number} [period=20]
 * @returns {number[]|null} null if any feature is not yet finite at i (insufficient lookback).
 */
export function computeFeatureVector(prices, i, period = 20) {
  const vector = FEATURE_PLUGINS.map((plugin) => plugin.compute({ prices, period }).signal[i]);
  return vector.every(Number.isFinite) ? vector : null;
}

/**
 * Slides across the full price series, computing one feature vector per
 * stride-spaced window -- the pure, data-driven dataset clustering
 * operates on.
 * @param {number[]} prices
 * @param {number} [period=20]
 * @param {number} [stride=5]
 * @returns {{ vectors: number[][], indices: number[] }}
 */
export function computeAllFeatureVectors(prices, period = 20, stride = 5) {
  const vectors = [], indices = [];
  for (let i = period; i < prices.length; i += stride) {
    const v = computeFeatureVector(prices, i, period);
    if (v) { vectors.push(v); indices.push(i); }
  }
  return { vectors, indices };
}

function euclideanDistance(a, b) {
  return Math.sqrt(a.reduce((sum, v, idx) => sum + (v - b[idx]) ** 2, 0));
}
function meanVector(vectors) {
  const dims = vectors[0].length;
  const mean = new Array(dims).fill(0);
  for (const v of vectors) for (let d = 0; d < dims; d++) mean[d] += v[d] / vectors.length;
  return mean;
}

/**
 * Deterministic (seeded) k-means over real feature vectors -- genuinely
 * new algorithm in this file (no existing clustering utility to reuse),
 * using the existing createSeededRng for centroid initialization.
 * @param {number[][]} vectors
 * @param {number} k
 * @param {number} seed
 * @param {number} [maxIterations=50]
 * @returns {{ centroids: number[][], assignments: number[] }}
 */
export function kMeansCluster(vectors, k, seed, maxIterations = 50) {
  if (!Array.isArray(vectors) || vectors.length < k) {
    throw new NovelStateDiscoveryError(`kMeansCluster: need at least k=${k} feature vectors, got ${vectors?.length ?? 0}`);
  }
  const rng = createSeededRng(seed);
  const usedIndices = new Set();
  const centroids = [];
  while (centroids.length < k) {
    const idx = Math.floor(rng() * vectors.length);
    if (!usedIndices.has(idx)) { usedIndices.add(idx); centroids.push([...vectors[idx]]); }
  }

  let assignments = new Array(vectors.length).fill(-1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclideanDistance(vectors[i], centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (members.length > 0) centroids[c] = meanVector(members);
    }
    if (!changed) break;
  }
  return { centroids, assignments };
}

/**
 * Computes the EMPIRICAL "typical feature signature" for every registered
 * MarketState plugin: the mean feature vector across every real window
 * where that plugin's own detector actually fires (signal=1). This is
 * measured from real data, never assumed.
 * @param {number[]} prices
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} marketStateRegistry
 * @param {number} [period=20]
 * @param {number} [detectorWindow=20]
 * @returns {Record<string, number[]>} stateLabel -> mean feature vector.
 */
export function computeKnownStateSignatures(prices, marketStateRegistry, period = 20, detectorWindow = 20) {
  const states = prices.map((p) => ({ tick_price: p }));
  const signatures = {};
  for (const plugin of marketStateRegistry.list()) {
    const { signal } = plugin.compute({ states, window: detectorWindow });
    const activeVectors = [];
    for (let i = period; i < prices.length; i++) {
      if (signal[i] === 1) {
        const v = computeFeatureVector(prices, i, period);
        if (v) activeVectors.push(v);
      }
    }
    if (activeVectors.length > 0) signatures[plugin.stateLabel || plugin.metadata().name] = meanVector(activeVectors);
  }
  return signatures;
}

/**
 * Scores a discovered cluster centroid's novelty: Euclidean distance to
 * the NEAREST known state's empirical signature. Higher = more novel.
 * @param {number[]} centroid
 * @param {Record<string, number[]>} knownStateSignatures
 * @returns {{ noveltyScore: number, nearestKnownState: string|null }}
 */
export function scoreNovelty(centroid, knownStateSignatures) {
  let nearestKnownState = null, minDistance = Infinity;
  for (const [label, signature] of Object.entries(knownStateSignatures)) {
    const d = euclideanDistance(centroid, signature);
    if (d < minDistance) { minDistance = d; nearestKnownState = label; }
  }
  return { noveltyScore: Number.isFinite(minDistance) ? minDistance : Infinity, nearestKnownState };
}

/**
 * Orchestrates the full pipeline: extract features -> cluster -> score
 * novelty -> yield candidateParams for clusters whose novelty exceeds
 * noveltyThreshold. Deliberately synchronous/non-streaming internally
 * (clustering inherently needs the whole feature-vector set at once,
 * unlike this codebase's other streamXCandidateParams generators which
 * can process one plugin at a time) -- still yields one candidateParams
 * object at a time, so a caller consuming this via `for...of` never
 * receives a bulk array of candidates either.
 *
 * @param {object} params
 * @param {number[]} params.prices
 * @param {import('../plugin/MarketStateRegistry.js').MarketStateRegistry} params.marketStateRegistry
 * @param {object} params.researchConfiguration
 * @param {number} [params.k=5] - Number of clusters to discover.
 * @param {number} [params.seed] - Required (no hidden randomness).
 * @param {number} [params.noveltyThreshold=1.0]
 * @param {number} [params.period=20]
 * @param {number} [params.stride=5]
 * @yields {object} A candidateParams object ready for generateCandidate() (type MARKET_STATE).
 */
export function* streamNovelStateCandidateParams({
  prices, marketStateRegistry, researchConfiguration, k = 5, seed, noveltyThreshold = 1.0, period = 20, stride = 5,
} = {}) {
  if (!Array.isArray(prices) || prices.length < period + k * stride) {
    throw new NovelStateDiscoveryError('streamNovelStateCandidateParams: not enough price data for the requested period/k/stride');
  }
  if (!marketStateRegistry || typeof marketStateRegistry.list !== 'function') {
    throw new NovelStateDiscoveryError('streamNovelStateCandidateParams: a valid MarketStateRegistry is required');
  }
  if (seed === undefined || seed === null) {
    throw new NovelStateDiscoveryError('streamNovelStateCandidateParams: an explicit seed is required (no hidden randomness)');
  }
  if (!researchConfiguration?.id || !researchConfiguration?.configHash) {
    throw new NovelStateDiscoveryError('streamNovelStateCandidateParams: a valid ResearchConfiguration is required');
  }

  const { vectors } = computeAllFeatureVectors(prices, period, stride);
  if (vectors.length < k) {
    throw new NovelStateDiscoveryError(`streamNovelStateCandidateParams: only ${vectors.length} usable feature vectors, need at least k=${k}`);
  }
  const { centroids, assignments } = kMeansCluster(vectors, k, seed);
  const knownStateSignatures = computeKnownStateSignatures(prices, marketStateRegistry, period);

  for (let c = 0; c < centroids.length; c++) {
    const memberCount = assignments.filter((a) => a === c).length;
    const { noveltyScore, nearestKnownState } = scoreNovelty(centroids[c], knownStateSignatures);
    if (noveltyScore < noveltyThreshold) continue; // not novel enough -- matches a known state too closely

    yield {
      id: `novel-cluster-${c}-seed${seed}`,
      family: 'novelState',
      parameters: {},
      description: `Data-driven novel market state (cluster ${c}, ${memberCount} member windows) — nearest known state: ${nearestKnownState || 'none'} (novelty=${noveltyScore.toFixed(3)}).`,
      generatorVersion: '11.1.0',
      grammarVersion: '11.0.0',
      configHash: researchConfiguration.configHash,
      researchConfigurationId: researchConfiguration.id,
      stateLabel: `NovelCluster-${c}-seed${seed}`,
      detectionCriteria: {
        discoveryMethod: 'kmeans-clustering',
        featureNames: [...FEATURE_NAMES],
        centroid: centroids[c],
        memberCount,
        noveltyScore,
        nearestKnownState,
        period, stride, k, seed,
      },
    };
  }
}

/**
 * Streams fully-governed, deduplicated novel-state MarketState candidates
 * -- routed through the existing, unmodified generateCandidate(), same as
 * every other candidate type. No special-case governance path.
 * @param {object} params - Same as streamNovelStateCandidateParams, plus:
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {Set<string>} [params.seenFingerprints]
 * @param {(err: Error, candidateParams: object) => void} [params.onSkip]
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamNovelStateCandidates({
  prices, marketStateRegistry, researchConfiguration, researchFreeze, sap,
  familyRegistry = null, decisionAuditLog = null, k = 5, seed, noveltyThreshold = 1.0,
  period = 20, stride = 5, seenFingerprints = new Set(), onSkip = null,
} = {}) {
  for (const candidateParams of streamNovelStateCandidateParams({
    prices, marketStateRegistry, researchConfiguration, k, seed, noveltyThreshold, period, stride,
  })) {
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
