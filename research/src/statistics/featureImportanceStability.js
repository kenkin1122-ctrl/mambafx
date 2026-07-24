/**
 * research/src/statistics/featureImportanceStability.js
 *
 * Purpose:
 *   Implement the Feature Importance Stability Index — a Meta-Science
 *   metric the Final Laboratory Architecture v1.0 review identified (its
 *   Section 11) as a genuinely discovery-relevant addition beyond Volume
 *   IV's own Part 14 metric list: "does a feature's effect size/
 *   importance hold steady across replications and time, or drift — a
 *   direct false-discovery-risk signal." Neither document gives this
 *   metric a formal equation (unlike, e.g., Part 16's Empirical Discovery
 *   Rate or Multiverse Stability Ratio, which this session implemented
 *   from their exact stated formulas). This module supplies one
 *   disclosed, reasoned operational definition rather than inventing an
 *   arbitrary one: it mirrors Part 16's already-Constitutional Multiverse
 *   Stability Ratio — "the fraction of [observations] under which the
 *   qualitative conclusion (sign...) is preserved" — applied to the
 *   time/replication dimension instead of the analytical-choice-set
 *   dimension MSR itself covers, extended with an explicit magnitude-
 *   tolerance band since "importance holding steady" is a magnitude
 *   claim, not only a sign claim.
 *
 * Deliberately self-contained, no storage: unlike the Empirical FDR
 *   Canary (Phase G) and Power Engine (Phase H), which had existing
 *   dormant stores (or an explicit Part 14 "permanently recorded"
 *   requirement) to wire into, no queryable "effect size per feature over
 *   time" history store exists anywhere in this codebase yet — that
 *   depends on Publication Status tracking and the Reproducibility
 *   Manifest, both separate, later, unbuilt Tier 4 items. Rather than
 *   invent a new store ahead of its actual data source, this module
 *   accepts a caller-supplied series of effect-size observations and
 *   computes the index — the same "build the testable statistical core
 *   now, flag persistence/integration as a later slice" pattern already
 *   used for discoveryDecision.js and historicalBackfill.js.
 *
 * Responsibilities:
 *   - computeSignConsistency(effectSizes, {referenceSign}): the fraction
 *     of observations sharing an explicitly caller-supplied reference
 *     sign — no majority-vote or first-observation default, matching
 *     Part 16's own anchor choice for MSR (the Lockbox estimate's sign,
 *     never an arbitrary pick) and this session's standing "no hidden
 *     defaults for anything statistically consequential" discipline
 *     (the same reasoning behind uncertaintyEstimation.js's required
 *     bootstrap seed).
 *   - computeCoefficientOfVariation(effectSizes): the standard |sample SD
 *     / mean| dispersion measure, with an explicit "undefined" result
 *     (never a division blowup) when the mean is too close to zero.
 *   - computeFeatureImportanceStabilityIndex({effectSizes,
 *     referenceEffectSize, magnitudeToleranceRatio}): the compound index
 *     — the fraction of observations that are BOTH sign-consistent with
 *     the reference AND within a tolerance band of its magnitude —
 *     reported ALONGSIDE its two constituent measures, never collapsed
 *     into one opaque number alone. This mirrors Part 16's own explicit
 *     warning for EvidenceScore/EvidenceDecay ("must display... as
 *     separate series, never only their product") applied to this
 *     metric's own components.
 *
 * Inputs: an array of finite, nonzero effect-size observations (one per
 *   replication block or time window), a reference effect size (typically
 *   the hypothesis's Lockbox/Publication estimate, per Part 11), and an
 *   optional magnitude-tolerance ratio.
 * Outputs: frozen result records; throws on malformed input.
 * Dependencies: none (a pure statistics leaf module).
 *
 * Public API: InvalidStabilityInputError, computeSignConsistency,
 *   computeCoefficientOfVariation, computeFeatureImportanceStabilityIndex.
 * Internal API: none.
 *
 * Error handling: non-array, empty, non-finite, or zero-valued effect
 *   sizes throw InvalidStabilityInputError before any computation (a
 *   zero-valued effect size has an ambiguous sign and is rejected rather
 *   than silently treated as a special case).
 * Performance notes: all three functions are O(n) in the number of
 *   effect-size observations — no unbounded scan, no storage access.
 * Threading model: pure, synchronous, side-effect-free — safe anywhere.
 * Storage usage: none.
 * Complexity analysis: O(n).
 * Future extension notes: once Publication Status tracking and the
 *   Reproducibility Manifest exist (Tier 4), a thin wrapper can assemble
 *   a feature's real effect-size history from stored Replication/Lockbox
 *   records and call this module's functions on a Stage 9 snapshot
 *   cadence — no change to this module's own logic would be required,
 *   the same relationship already established between onlineFdr.js and
 *   discoveryDecision.js's real-p-value wiring (Phase C).
 */

export class InvalidStabilityInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidStabilityInputError';
  }
}

function assertFiniteNonZeroNumberArray(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InvalidStabilityInputError(`${label}: must be a non-empty array`);
  }
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidStabilityInputError(`${label}: every element must be a finite number`);
    }
    if (value === 0) {
      throw new InvalidStabilityInputError(`${label}: a zero-valued effect size has an ambiguous sign and is not accepted`);
    }
  }
}

function assertValidReferenceSign(referenceSign, label) {
  if (referenceSign !== 1 && referenceSign !== -1) {
    throw new InvalidStabilityInputError(`${label}: "referenceSign" must be exactly 1 or -1 (use Math.sign(referenceEffectSize))`);
  }
}

/**
 * The fraction of effectSizes sharing the explicitly caller-supplied
 * referenceSign. See module header for why there is no majority-vote or
 * first-observation default.
 */
export function computeSignConsistency(effectSizes, { referenceSign } = {}) {
  assertFiniteNonZeroNumberArray(effectSizes, 'computeSignConsistency: "effectSizes"');
  assertValidReferenceSign(referenceSign, 'computeSignConsistency');

  const matching = effectSizes.filter((value) => Math.sign(value) === referenceSign).length;
  return matching / effectSizes.length;
}

/**
 * The standard |sample SD / mean| dispersion measure. Returns an explicit
 * "undefined" result (never a division blowup) when the mean is too close
 * to zero for a coefficient of variation to be meaningful.
 */
export function computeCoefficientOfVariation(effectSizes) {
  assertFiniteNonZeroNumberArray(effectSizes, 'computeCoefficientOfVariation: "effectSizes"');
  if (effectSizes.length < 2) {
    throw new InvalidStabilityInputError('computeCoefficientOfVariation: at least 2 observations are required to compute a dispersion measure');
  }

  const n = effectSizes.length;
  const mean = effectSizes.reduce((sum, v) => sum + v, 0) / n;

  if (Math.abs(mean) < 1e-12) {
    return Object.freeze({ cv: null, undefinedReason: 'mean-near-zero', mean, n });
  }

  const variance = effectSizes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return Object.freeze({ cv: Math.abs(sd / mean), undefinedReason: null, mean, sd, n });
}

/**
 * The compound Feature Importance Stability Index. See module header for
 * the full rationale. Reports its constituent measures alongside the
 * compound index, never collapsed into one opaque number alone.
 */
export function computeFeatureImportanceStabilityIndex({ effectSizes, referenceEffectSize, magnitudeToleranceRatio = 0.5 } = {}) {
  assertFiniteNonZeroNumberArray(effectSizes, 'computeFeatureImportanceStabilityIndex: "effectSizes"');
  if (typeof referenceEffectSize !== 'number' || !Number.isFinite(referenceEffectSize) || referenceEffectSize === 0) {
    throw new InvalidStabilityInputError('computeFeatureImportanceStabilityIndex: "referenceEffectSize" must be a finite, non-zero number');
  }
  if (typeof magnitudeToleranceRatio !== 'number' || !Number.isFinite(magnitudeToleranceRatio) || magnitudeToleranceRatio <= 0) {
    throw new InvalidStabilityInputError('computeFeatureImportanceStabilityIndex: "magnitudeToleranceRatio" must be a finite, positive number');
  }

  const referenceSign = Math.sign(referenceEffectSize);
  const referenceMagnitude = Math.abs(referenceEffectSize);

  if (effectSizes.length < 2) {
    return Object.freeze({
      index: null,
      insufficientData: true,
      n: effectSizes.length,
      referenceSign,
      magnitudeToleranceRatio,
      signConsistency: null,
      coefficientOfVariation: null,
    });
  }

  const signConsistency = computeSignConsistency(effectSizes, { referenceSign });
  const coefficientOfVariation = computeCoefficientOfVariation(effectSizes);

  const compoundConsistentCount = effectSizes.filter((value) => {
    if (Math.sign(value) !== referenceSign) return false;
    const relativeMagnitudeDeviation = Math.abs(Math.abs(value) - referenceMagnitude) / referenceMagnitude;
    return relativeMagnitudeDeviation <= magnitudeToleranceRatio;
  }).length;

  return Object.freeze({
    index: compoundConsistentCount / effectSizes.length,
    insufficientData: false,
    n: effectSizes.length,
    referenceSign,
    magnitudeToleranceRatio,
    signConsistency,
    coefficientOfVariation,
  });
}
