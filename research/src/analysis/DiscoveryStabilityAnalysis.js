/**
 * research/src/analysis/DiscoveryStabilityAnalysis.js
 *
 * Purpose:
 *   Computes a candidate's Discovery Stability Index (directive requirement
 *   #26, "Discovery Stability Analysis across partitions") — the field
 *   already declared on Candidate.js (`discoveryStabilityIndex`, Phase A)
 *   but never populated until now. Given a set of per-partition effect-size
 *   estimates (e.g. one per calendar month, or one per volatility regime),
 *   this module answers: does this candidate's effect maintain consistent
 *   sign and comparable magnitude across independent slices of the data, or
 *   does it flip sign / vanish depending on which slice you look at?
 *
 * Scientific rationale:
 *   A discovery that is only "significant" in the full pooled sample but
 *   whose effect sign is inconsistent across sub-partitions is a strong
 *   candidate for a spurious or regime-specific artifact (this is
 *   conceptually related to driftSurveillance.js's multiverse stability
 *   ratio, mentioned directly in Candidate.js's own field documentation —
 *   this module is the Phase 11-native, candidate-facing counterpart,
 *   deliberately kept separate rather than importing driftSurveillance.js
 *   directly, since that module's scope is the legacy multiverse-analysis
 *   pipeline, not individual Phase 11 Candidate scoring).
 *
 * Design: pure, caller-supplied-data function — this module never fetches
 *   or computes effect sizes itself (no dependency on any specific
 *   statistical test), matching the "caller-supplied signal bundle"
 *   pattern already established throughout this codebase (e.g.
 *   discovery/funnel.js's scoreFn, statistics/permutationTest.js's
 *   statisticFn).
 *
 * Dependencies: none.
 * Public API: computeDiscoveryStabilityIndex, InvalidStabilityInputError.
 * Complexity: O(p) where p = number of partitions.
 */

export class InvalidStabilityInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStabilityInputError';
  }
}

/**
 * Computes the Discovery Stability Index for a set of per-partition effect
 * sizes: the fraction of partitions whose effect size has the same sign as
 * the majority sign, weighted toward partitions with comparable magnitude
 * to the overall (pooled) effect size.
 *
 * Concretely: stabilityIndex = (partitions agreeing in sign with the
 * majority sign) / (total partitions), further discounted by a magnitude
 * consistency term — the mean absolute deviation of each partition's
 * effect size from the pooled effect size, normalized by the pooled
 * effect size's magnitude and capped at 1. This penalizes a candidate
 * that has the "right" sign everywhere but wildly inconsistent magnitude
 * (e.g. huge in one partition, negligible in the rest) as well as one
 * with outright sign flips.
 *
 * Range: [0, 1]. 1 = perfectly consistent sign and magnitude across all
 * partitions. 0 = no consistency at all (evenly split signs, or a pooled
 * effect size of exactly 0 with any non-zero partition variance).
 *
 * O(p) where p = partitionEffectSizes.length.
 *
 * @param {number[]} partitionEffectSizes - Effect size estimate per
 *   independent partition (e.g. one per month/regime/session). Must have
 *   at least 2 elements — stability is undefined for a single partition.
 * @param {number} pooledEffectSize - The full-sample (pooled) effect size,
 *   for the magnitude-consistency term.
 * @returns {{
 *   stabilityIndex: number,
 *   signAgreementFraction: number,
 *   magnitudeConsistency: number,
 *   majoritySign: -1 | 0 | 1,
 *   partitionCount: number
 * }}
 */
export function computeDiscoveryStabilityIndex(partitionEffectSizes, pooledEffectSize) {
  if (!Array.isArray(partitionEffectSizes) || partitionEffectSizes.length < 2) {
    throw new InvalidStabilityInputError(
      'computeDiscoveryStabilityIndex: partitionEffectSizes must be an array of at least 2 values'
    );
  }
  if (partitionEffectSizes.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new InvalidStabilityInputError('computeDiscoveryStabilityIndex: all partition effect sizes must be finite numbers');
  }
  if (typeof pooledEffectSize !== 'number' || !Number.isFinite(pooledEffectSize)) {
    throw new InvalidStabilityInputError('computeDiscoveryStabilityIndex: pooledEffectSize must be a finite number');
  }

  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const signs = partitionEffectSizes.map(sign);
  const positiveCount = signs.filter(s => s === 1).length;
  const negativeCount = signs.filter(s => s === -1).length;
  const majoritySign = positiveCount === negativeCount ? sign(pooledEffectSize) : (positiveCount > negativeCount ? 1 : -1);

  const agreeingCount = signs.filter(s => s === majoritySign).length;
  const signAgreementFraction = agreeingCount / partitionEffectSizes.length;

  // Magnitude consistency: 1 - mean(|partition - pooled| / max(|pooled|, epsilon)), clamped to [0, 1].
  const epsilon = 1e-9;
  const denom = Math.max(Math.abs(pooledEffectSize), epsilon);
  const meanRelDeviation = partitionEffectSizes.reduce((sum, v) => sum + Math.abs(v - pooledEffectSize) / denom, 0)
    / partitionEffectSizes.length;
  const magnitudeConsistency = Math.max(0, Math.min(1, 1 - meanRelDeviation));

  const stabilityIndex = signAgreementFraction * magnitudeConsistency;

  return {
    stabilityIndex,
    signAgreementFraction,
    magnitudeConsistency,
    majoritySign,
    partitionCount: partitionEffectSizes.length,
  };
}
