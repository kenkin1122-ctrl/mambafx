/**
 * research/src/statistics/powerEngine.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 16's formal power analysis:
 *
 *     1 - beta(h) = P(reject H0 | true effect = theta_hat_Replication(h), n = n(h))
 *
 *   computed from the Replication-stage effect size and sample size using
 *   standard power-analysis methodology (Cohen, 1988). This is one of the
 *   two mandatory, objective inputs Part 12 requires before a failed
 *   Discovery/Replication test may be classified `Indeterminate` instead
 *   of `Rejected` — the other being a Drift Surveillance Engine
 *   confirmation (Tier 3, next). A generation is only ELIGIBLE for
 *   Indeterminate if its achieved power fell below
 *   GOVERNANCE.MIN_STATISTICAL_POWER (default 0.80) — eligibility alone
 *   is necessary, never sufficient (Scientific Oversight approval and the
 *   Drift Surveillance confirmation are still required on top, per
 *   hypothesisRegistry.js's classifyIndeterminate(), which this module
 *   does not itself call — see Future extension notes).
 *
 * Also implements the storage half: PowerAnalyses (Phase 1's
 *   getPowerAnalysesAdapter(), write-once, keyed by
 *   (discoveryResultId, engineVersion)) has existed since Phase 1 with no
 *   computational engine populating it. This module is that engine.
 *
 * Responsibilities:
 *   - computeAchievedPower({effectSize, standardError, alpha}): the pure
 *     two-sided normal-approximation power calculation (Cohen, 1988),
 *     using the shared normalDistribution.js primitives so this
 *     computation and uncertaintyEstimation.js's Wald interval always
 *     agree on the same underlying normal-distribution approximation.
 *   - isEligibleForIndeterminate(power, {minPower}): the literal,
 *     one-line enforcement of Part 16's eligibility condition
 *     "1 - beta(h) < (1-beta)_min".
 *   - recordPowerAnalysis({discoveryResultId, effectSize, standardError,
 *     sampleSize, alpha, computedAt}): computes achieved power and writes
 *     an immutable record via the existing write-once PowerAnalyses
 *     adapter, keyed deterministically by (discoveryResultId,
 *     POWER_ENGINE_VERSION) — a repeat call for the same pair is
 *     idempotent-safe (returns the original record, per the adapter's own
 *     write-once contract), never a silent recomputation.
 *   - getPowerAnalysis(discoveryResultId, {engineVersion}): read-through
 *     lookup by the same deterministic key.
 *
 * Why a two-sided normal approximation, not Cohen's full noncentral-t
 *   tables: every statistical test already built in this Laboratory
 *   (Part 9's Online FDR wealth process, Part 11's Wald interval) is
 *   evaluated against a two-sided null on the normal-approximation scale
 *   (Part 16: "the Discovery-stage test statistic T is evaluated against
 *   a two-sided alternative"). Using the same approximation family here
 *   keeps the achieved-power figure consistent with the significance
 *   threshold it is being compared against, rather than introducing a
 *   second, subtly different distributional assumption. A noncentral-t
 *   correction for small-n exact power is a documented, disclosed
 *   simplification this module does not make — acceptable per Cohen
 *   (1988)'s own guidance that the normal approximation is standard
 *   practice for n large enough to already be reporting a Wald interval
 *   (as this Laboratory does).
 *
 * Inputs: an effect size (in standard-error units, i.e. already
 *   standardized — matching how computeWaldCI's `standardError` argument
 *   is used elsewhere), its standard error, and the significance level
 *   (alpha) the test was actually evaluated against (Part 16's Q_F(h,T) —
 *   the level allocated to h at the moment it was tested, from
 *   onlineFdr.js's recorded alphaSpent).
 * Outputs: Promises resolving to frozen power-analysis records, or a
 *   pure {power, ...} object from computeAchievedPower.
 * Dependencies: statistics/normalDistribution.js,
 *   storage/existingDbExtensions.js (getPowerAnalysesAdapter),
 *   core/constants.js (GOVERNANCE.MIN_STATISTICAL_POWER).
 *
 * Public API: POWER_ENGINE_VERSION, InvalidPowerAnalysisInputError,
 *   computeAchievedPower, isEligibleForIndeterminate, recordPowerAnalysis,
 *   getPowerAnalysis.
 * Internal API: none.
 *
 * Error handling: malformed inputs (non-finite effect size, non-positive
 *   standard error, alpha outside (0,1)) throw
 *   InvalidPowerAnalysisInputError synchronously, before any computation
 *   or write.
 * Performance notes: computeAchievedPower/isEligibleForIndeterminate are
 *   O(1). recordPowerAnalysis/getPowerAnalysis are O(log n) (a single
 *   write-once store operation), matching the discipline established for
 *   the other write-once stores.
 * Threading model: main-thread only.
 * Storage usage: writes to the existing PowerAnalyses store only, via the
 *   already-sanctioned getPowerAnalysesAdapter().
 * Complexity analysis: see Performance notes above.
 * Future extension notes: wiring a recorded power analysis into
 *   hypothesisRegistry.js's classifyIndeterminate() is deliberately not
 *   done in this phase — that function requires BOTH this module's output
 *   AND a Drift Surveillance Engine confirmation (Part 12), and the
 *   latter does not exist yet (the next Tier 3 item). Wiring both
 *   together once Drift Surveillance is built keeps Indeterminate's
 *   "mandatory dual objective justification" requirement enforced as one
 *   atomic integration, not two partial ones.
 */

import { normalCDF, inverseNormalCDF } from './normalDistribution.js';
import { getPowerAnalysesAdapter } from '../storage/existingDbExtensions.js';
import { GOVERNANCE } from '../core/constants.js';

// Bumped only if the achieved-power methodology itself materially changes
// (e.g. a future noncentral-t correction) -- the write-once PowerAnalyses
// store's unique index is keyed on (discoveryResultId, engineVersion), so
// a methodology change produces a new, independently-recorded analysis
// rather than silently overwriting or being blocked by an older one.
export const POWER_ENGINE_VERSION = 'power-engine-v1-normal-approx';

export class InvalidPowerAnalysisInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPowerAnalysisInputError';
  }
}

function assertValidPowerInputs({ effectSize, standardError, alpha }, label) {
  if (typeof effectSize !== 'number' || !Number.isFinite(effectSize)) {
    throw new InvalidPowerAnalysisInputError(`${label}: "effectSize" must be a finite number`);
  }
  if (typeof standardError !== 'number' || !Number.isFinite(standardError) || standardError <= 0) {
    throw new InvalidPowerAnalysisInputError(`${label}: "standardError" must be a finite, positive number`);
  }
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new InvalidPowerAnalysisInputError(`${label}: "alpha" must be a finite number strictly between 0 and 1`);
  }
}

/**
 * The pure achieved-power calculation (Part 16), two-sided normal
 * approximation. See module header for the methodology rationale.
 */
export function computeAchievedPower({ effectSize, standardError, alpha } = {}) {
  assertValidPowerInputs({ effectSize, standardError, alpha }, 'computeAchievedPower');

  const zCritical = Math.abs(inverseNormalCDF(1 - alpha / 2));
  const zEffect = Math.abs(effectSize) / standardError;

  // Two-sided achieved power: probability the test statistic falls beyond
  // either critical tail, under the assumption the true effect equals the
  // observed (Replication-stage) effect size.
  const power = normalCDF(zEffect - zCritical) + normalCDF(-zEffect - zCritical);
  const clampedPower = Math.min(1, Math.max(0, power));

  return Object.freeze({
    power: clampedPower,
    zEffect,
    zCritical,
    alpha,
    effectSize,
    standardError,
  });
}

/** Direct enforcement of Part 16's eligibility condition: "1 - beta(h) < (1-beta)_min". Eligibility alone is never sufficient for Indeterminate (Part 12) -- see module header. */
export function isEligibleForIndeterminate(power, { minPower = GOVERNANCE.MIN_STATISTICAL_POWER } = {}) {
  if (typeof power !== 'number' || !Number.isFinite(power) || power < 0 || power > 1) {
    throw new InvalidPowerAnalysisInputError('isEligibleForIndeterminate: "power" must be a finite number in [0, 1]');
  }
  return power < minPower;
}

function deterministicPowerAnalysisId(discoveryResultId, engineVersion) {
  return `pa_${discoveryResultId}_${engineVersion}`;
}

/**
 * Computes achieved power and permanently records it via the existing
 * write-once PowerAnalyses adapter. Idempotent-safe: a repeat call for
 * the same (discoveryResultId, engineVersion) returns the ORIGINAL
 * record (adapter.write()'s own {created, record} contract), never a
 * silent recomputation.
 */
export async function recordPowerAnalysis({
  discoveryResultId,
  effectSize,
  standardError,
  sampleSize,
  alpha,
  computedAt,
} = {}) {
  if (!discoveryResultId || typeof discoveryResultId !== 'string') {
    throw new InvalidPowerAnalysisInputError('recordPowerAnalysis: "discoveryResultId" must be a non-empty string');
  }
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new InvalidPowerAnalysisInputError('recordPowerAnalysis: "sampleSize" must be a positive integer');
  }
  const { power, zEffect, zCritical } = computeAchievedPower({ effectSize, standardError, alpha });

  const record = {
    id: deterministicPowerAnalysisId(discoveryResultId, POWER_ENGINE_VERSION),
    discoveryResultId,
    engineVersion: POWER_ENGINE_VERSION,
    effectSize,
    standardError,
    sampleSize,
    alpha,
    power,
    zEffect,
    zCritical,
    minPowerThreshold: GOVERNANCE.MIN_STATISTICAL_POWER,
    eligibleForIndeterminate: isEligibleForIndeterminate(power),
    computedAt: computedAt ?? Date.now(),
  };

  const adapter = await getPowerAnalysesAdapter();
  return adapter.write(record); // { created, record } -- idempotent-safe per the write-once adapter's own contract
}

/** Read-through lookup for an existing power analysis by its natural (discoveryResultId, engineVersion) key. */
export async function getPowerAnalysis(discoveryResultId, { engineVersion = POWER_ENGINE_VERSION } = {}) {
  const adapter = await getPowerAnalysesAdapter();
  return adapter.get(deterministicPowerAnalysisId(discoveryResultId, engineVersion));
}
