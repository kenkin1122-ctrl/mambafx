/**
 * research/src/statistics/uncertaintyEstimation.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 11 (Effect Size Reporting and Claim-Scope
 *   Discipline)'s uncertainty-estimation requirement: every effect size the
 *   Laboratory computes must carry a confidence interval AND a tagged
 *   estimate type (Selection / Validation / Replication / Lockbox /
 *   Operational — Part 11's table), because the same numeric estimate is a
 *   Constitutional violation in one context (a Selection estimate shown
 *   externally) and mandatory in another (a Lockbox estimate at
 *   Publication). This module supplies both halves: the interval
 *   computation itself, and the tagging/reportability enforcement that
 *   keeps the five estimate types from being silently interchanged.
 *
 *   Deliberately self-contained: no storage, no legacy dependency, no
 *   dependency on any other governance module — pure computation plus
 *   input/policy validation, per the Phase 0 Repository Recovery Audit's
 *   own classification of this item as "fully recoverable / buildable in
 *   isolation." Persisting a computed record (e.g. alongside a Lockbox
 *   consumption's evidence fields, per lockbox.js's `consumeLockboxHoldout`
 *   `...evidence` spread) is the caller's responsibility, not this
 *   module's.
 *
 * Responsibilities:
 *   - computeBootstrapCI(samples, {statisticFn, confidenceLevel, numResamples, seed}):
 *     a nonparametric percentile-bootstrap confidence interval for an
 *     arbitrary sample statistic. `seed` is REQUIRED, not optional-with-a-
 *     hidden-default — consistent with this project's standing discipline
 *     that anything statistically consequential is explicit and
 *     reproducible (the same seed + samples always yields the same
 *     interval, auditable independently of when it was computed).
 *   - computeWaldCI(pointEstimate, standardError, {confidenceLevel}): an
 *     analytic normal-approximation interval for when a closed-form
 *     standard error is already available (e.g. a proportion or a
 *     difference-in-means with known SE), using a rational approximation
 *     of the inverse normal CDF (Acklam's algorithm) so it is not limited
 *     to a small fixed table of confidence levels.
 *   - attachEstimateRecord({estimateType, ...}): stamps a computed interval
 *     with its Part 11 estimate type and derives whether it is, by policy,
 *     ever externally reportable — returns a frozen record, never a
 *     mutable one, so a record's type cannot be silently changed after
 *     computation.
 *   - assertReportable(record, {accompaniedByRecord}): the enforcement
 *     half — throws if a Selection-type record is checked for external
 *     reportability at all, and throws if a Validation-type record is
 *     checked without a Replication- or Lockbox-type record to accompany
 *     it (Part 11: "if shown, always alongside the Replication or Lockbox
 *     estimate").
 *   - assertPublicationEstimate(record): a direct, literal enforcement of
 *     Part 11's bolded rule — "A Published effect size is always,
 *     exclusively, the Lockbox estimate" — throws for any other type.
 *
 * Inputs: raw numeric sample arrays or a pre-computed point estimate and
 *   standard error, plus an explicit seed and confidence level.
 * Outputs: frozen estimate records; throws on policy violation.
 * Dependencies: statistics/normalDistribution.js (shared inverseNormalCDF
 *   approximation only -- no storage, no other governance module).
 *
 * Public API: ESTIMATE_TYPES, InvalidUncertaintyInputError,
 *   NonReportableEstimateError, MissingAccompanyingEstimateError,
 *   InvalidPublicationEstimateError, createSeededRng, computeBootstrapCI,
 *   computeWaldCI, attachEstimateRecord, assertReportable,
 *   assertPublicationEstimate.
 * Internal API: mean (default statisticFn), inverseNormalCDF, percentile.
 *
 * Error handling: input validation (non-empty finite-numeric sample
 *   arrays, in-range confidence levels, positive integer resample counts,
 *   a required seed) throws InvalidUncertaintyInputError before any
 *   computation begins. Reportability violations throw distinct,
 *   dedicated error types so callers can distinguish "bad input" from "a
 *   Constitutional reporting rule was about to be broken."
 * Performance notes: computeBootstrapCI is O(numResamples * sampleSize)
 *   for the default mean statistic; a caller-supplied statisticFn's own
 *   complexity is multiplied by numResamples in the same way. No
 *   unbounded loop — numResamples is a required, explicit, finite input.
 * Threading model: pure, synchronous, side-effect-free functions —
 *   trivially safe from a Worker or the main thread.
 * Storage usage: none.
 * Complexity analysis: computeWaldCI and attachEstimateRecord/
 *   assertReportable/assertPublicationEstimate are O(1). computeBootstrapCI
 *   is O(numResamples * sampleSize * cost(statisticFn)); sorting the
 *   resample distribution for the percentile step is
 *   O(numResamples log numResamples).
 * Future extension notes: a BCa (bias-corrected and accelerated) bootstrap
 *   variant would improve small-sample coverage over the plain percentile
 *   method used here — not built now because Part 13's Multiverse
 *   Analysis (a separate, already-scoped-for-later mechanism) is the
 *   Constitution's designated place for evaluating estimator sensitivity,
 *   and adding BCa now would be scope creep ahead of that.
 */

import { inverseNormalCDF } from './normalDistribution.js';

// ── Part 11's five estimate types, in the Constitution's own table order ──
export const ESTIMATE_TYPES = Object.freeze({
  SELECTION: 'selection',
  VALIDATION: 'validation',
  REPLICATION: 'replication',
  LOCKBOX: 'lockbox',
  OPERATIONAL: 'operational',
});

export class InvalidUncertaintyInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidUncertaintyInputError';
  }
}

export class NonReportableEstimateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonReportableEstimateError';
  }
}

export class MissingAccompanyingEstimateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingAccompanyingEstimateError';
  }
}

export class InvalidPublicationEstimateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPublicationEstimateError';
  }
}

function assertFiniteNumberArray(samples, label) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new InvalidUncertaintyInputError(`${label}: "samples" must be a non-empty array`);
  }
  for (const value of samples) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidUncertaintyInputError(`${label}: every element of "samples" must be a finite number`);
    }
  }
}

function assertConfidenceLevel(confidenceLevel, label) {
  if (typeof confidenceLevel !== 'number' || !Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new InvalidUncertaintyInputError(`${label}: "confidenceLevel" must be a finite number strictly between 0 and 1`);
  }
}

function mean(samples) {
  let sum = 0;
  for (const value of samples) sum += value;
  return sum / samples.length;
}

/**
 * Deterministic seeded PRNG (mulberry32). Chosen for its combination of
 * simplicity, a full 32-bit period for practical resample counts, and
 * being trivially auditable by a reader of this file — this project has
 * repeatedly favored code that a future author can verify by reading over
 * an opaque library dependency for anything statistically consequential.
 */
export function createSeededRng(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new InvalidUncertaintyInputError('createSeededRng: "seed" must be a finite number');
  }
  let state = seed >>> 0;
  return function nextRandom() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an already-sorted ascending array (deterministic, no interpolation ambiguity). */
function percentile(sortedValues, p) {
  const rank = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1));
  return sortedValues[rank];
}

/**
 * Percentile-bootstrap confidence interval for an arbitrary sample
 * statistic. See module header for the reproducibility rationale behind
 * requiring an explicit seed.
 */
export function computeBootstrapCI(samples, { statisticFn = mean, confidenceLevel = 0.95, numResamples = 2000, seed } = {}) {
  assertFiniteNumberArray(samples, 'computeBootstrapCI');
  assertConfidenceLevel(confidenceLevel, 'computeBootstrapCI');
  if (typeof statisticFn !== 'function') {
    throw new InvalidUncertaintyInputError('computeBootstrapCI: "statisticFn" must be a function');
  }
  if (!Number.isInteger(numResamples) || numResamples < 100) {
    throw new InvalidUncertaintyInputError('computeBootstrapCI: "numResamples" must be an integer >= 100');
  }
  if (seed === undefined || seed === null) {
    throw new InvalidUncertaintyInputError(
      'computeBootstrapCI: an explicit "seed" is required (reproducibility discipline — see module header); ' +
      'derive one deterministically from the calling context (e.g. hypothesisId + generation) rather than omitting it'
    );
  }

  const rng = createSeededRng(seed);
  const n = samples.length;
  const resampleStatistics = new Array(numResamples);
  for (let r = 0; r < numResamples; r += 1) {
    const resample = new Array(n);
    for (let i = 0; i < n; i += 1) {
      resample[i] = samples[Math.floor(rng() * n)];
    }
    resampleStatistics[r] = statisticFn(resample);
  }
  resampleStatistics.sort((a, b) => a - b);

  const alpha = 1 - confidenceLevel;
  const ciLower = percentile(resampleStatistics, alpha / 2);
  const ciUpper = percentile(resampleStatistics, 1 - alpha / 2);

  return Object.freeze({
    pointEstimate: statisticFn(samples),
    ciLower,
    ciUpper,
    confidenceLevel,
    method: 'percentile-bootstrap',
    numResamples,
    seed,
    sampleSize: n,
  });
}

/** Analytic normal-approximation ("Wald") confidence interval from a point estimate and its standard error. */
export function computeWaldCI(pointEstimate, standardError, { confidenceLevel = 0.95 } = {}) {
  if (typeof pointEstimate !== 'number' || !Number.isFinite(pointEstimate)) {
    throw new InvalidUncertaintyInputError('computeWaldCI: "pointEstimate" must be a finite number');
  }
  if (typeof standardError !== 'number' || !Number.isFinite(standardError) || standardError < 0) {
    throw new InvalidUncertaintyInputError('computeWaldCI: "standardError" must be a finite, non-negative number');
  }
  assertConfidenceLevel(confidenceLevel, 'computeWaldCI');

  const z = Math.abs(inverseNormalCDF(1 - (1 - confidenceLevel) / 2));
  return Object.freeze({
    pointEstimate,
    ciLower: pointEstimate - z * standardError,
    ciUpper: pointEstimate + z * standardError,
    confidenceLevel,
    method: 'wald-normal-approximation',
    standardError,
    z,
  });
}

// ── Part 11's reportability policy, keyed by estimate type ────────────────
const REPORTABILITY_POLICY = Object.freeze({
  [ESTIMATE_TYPES.SELECTION]: Object.freeze({ externallyReportable: false, mustAccompanyOneOf: null }),
  [ESTIMATE_TYPES.VALIDATION]: Object.freeze({ externallyReportable: true, mustAccompanyOneOf: Object.freeze([ESTIMATE_TYPES.REPLICATION, ESTIMATE_TYPES.LOCKBOX]) }),
  [ESTIMATE_TYPES.REPLICATION]: Object.freeze({ externallyReportable: true, mustAccompanyOneOf: null }),
  [ESTIMATE_TYPES.LOCKBOX]: Object.freeze({ externallyReportable: true, mustAccompanyOneOf: null }),
  [ESTIMATE_TYPES.OPERATIONAL]: Object.freeze({ externallyReportable: true, mustAccompanyOneOf: null }),
});

/**
 * Stamps a computed interval (from computeBootstrapCI or computeWaldCI, or
 * any object with the same {pointEstimate, ciLower, ciUpper,
 * confidenceLevel, method} shape) with its Part 11 estimate type. Returns
 * a frozen record — the estimate type is fixed at creation, never mutated.
 */
export function attachEstimateRecord({ estimateType, interval, computedAt = Date.now(), notes = null } = {}) {
  if (!Object.values(ESTIMATE_TYPES).includes(estimateType)) {
    throw new InvalidUncertaintyInputError(
      `attachEstimateRecord: "estimateType" must be one of ${Object.values(ESTIMATE_TYPES).join(', ')}`
    );
  }
  if (!interval || typeof interval.pointEstimate !== 'number' || typeof interval.ciLower !== 'number' || typeof interval.ciUpper !== 'number') {
    throw new InvalidUncertaintyInputError('attachEstimateRecord: "interval" must be a computed CI record ({pointEstimate, ciLower, ciUpper, ...})');
  }
  const policy = REPORTABILITY_POLICY[estimateType];
  return Object.freeze({
    estimateType,
    ...interval,
    computedAt,
    notes,
    externallyReportable: policy.externallyReportable,
  });
}

/**
 * Enforces Part 11's reportability rules. Throws NonReportableEstimateError
 * for a Selection-type record (never reportable, in any external-facing
 * artifact, under any circumstance) and MissingAccompanyingEstimateError
 * for a Validation-type record checked without its required Replication-
 * or Lockbox-type companion.
 */
export function assertReportable(record, { accompaniedByRecord = null } = {}) {
  if (!record || !Object.values(ESTIMATE_TYPES).includes(record.estimateType)) {
    throw new InvalidUncertaintyInputError('assertReportable: "record" must be a valid estimate record produced by attachEstimateRecord');
  }
  const policy = REPORTABILITY_POLICY[record.estimateType];
  if (!policy.externallyReportable) {
    throw new NonReportableEstimateError(
      `assertReportable: a "${record.estimateType}" estimate may never appear in any external-facing artifact (Part 11) — ` +
      'internal diagnostic use only, and must be labeled "biased, pre-selection" wherever shown internally'
    );
  }
  if (policy.mustAccompanyOneOf) {
    const accompanyingType = accompaniedByRecord?.estimateType;
    if (!policy.mustAccompanyOneOf.includes(accompanyingType)) {
      throw new MissingAccompanyingEstimateError(
        `assertReportable: a "${record.estimateType}" estimate may only be shown alongside one of: ` +
        `${policy.mustAccompanyOneOf.join(', ')} (Part 11) — no qualifying "accompaniedByRecord" was supplied`
      );
    }
  }
  return true;
}

/**
 * Direct enforcement of Part 11's bolded rule: "A Published effect size is
 * always, exclusively, the Lockbox estimate." Throws for any other type.
 */
export function assertPublicationEstimate(record) {
  if (!record || !Object.values(ESTIMATE_TYPES).includes(record.estimateType)) {
    throw new InvalidUncertaintyInputError('assertPublicationEstimate: "record" must be a valid estimate record produced by attachEstimateRecord');
  }
  if (record.estimateType !== ESTIMATE_TYPES.LOCKBOX) {
    throw new InvalidPublicationEstimateError(
      `assertPublicationEstimate: a Publication's reported effect size must be the Lockbox estimate (Part 11), ` +
      `not "${record.estimateType}"`
    );
  }
  return true;
}
