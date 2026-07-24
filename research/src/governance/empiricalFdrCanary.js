/**
 * research/src/governance/empiricalFdrCanary.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 14/16's Empirical FDR Calibration
 *   Canary — the one mechanism the Constitution names, by Principle 2
 *   ("one calibration canary"), as the Laboratory's sole authority for
 *   checking whether the online-procedure's claimed false-discovery
 *   guarantee (Part 9's wealth process) is actually being met in
 *   practice. Retires the legacy `msdEvaluateControlCalibration`'s ad hoc
 *   3x-nominal-alpha heuristic (Research Debt R-008, self-disclosed as
 *   not formally derived) in favor of the Constitution's own formal
 *   definition (Part 16):
 *
 *     EDR_F(T) = #{h in F : Supported(h,T) AND Replicated(h,T)}
 *                / #{h in F : Supported(h,T)}
 *
 *   compared against the online procedure's implied 1 - alpha_F, where
 *   alpha_F is the Family's wealth-process guarantee bound
 *   (GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH — see onlineFdr.js).
 *
 * Scope boundary, deliberately drawn narrow:
 *   Per Volume III's Stage 9 design ("strictly read-only... no automatic
 *   corrective action, only a defined human-facing alert"), this module
 *   computes, records, and flags — it never gates or blocks anything. It
 *   also does not itself track which hypotheses are Supported/Replicated
 *   (Part 12's Publication Status taxonomy has no storage-backed
 *   implementation yet — a separate, later Tier 4 item, "Publication
 *   Status completion"). Callers supply pre-counted `supportedCount` /
 *   `supportedAndReplicatedCount` for a Family; this keeps the canary's
 *   own statistical logic fully self-contained and testable now, with
 *   wiring to a real Publication Status store an explicit next slice —
 *   the same "build the testable half now, flag the integration half"
 *   pattern already used for discoveryDecision.js and
 *   historicalBackfill.js this session.
 *
 * Responsibilities:
 *   - computeEmpiricalDiscoveryRate({supportedCount, supportedAndReplicatedCount}):
 *     the pure EDR ratio, with an explicit "insufficient data" result
 *     (never a divide-by-zero) when no hypothesis has yet reached
 *     Supported for a Family.
 *   - recordCalibrationRun({familyKey, supportedCount,
 *     supportedAndReplicatedCount, allocatedWealth, computedAt}): computes
 *     EDR, compares it against the implied target, classifies the single
 *     run's divergence as material or not (GOVERNANCE.
 *     EMPIRICAL_FDR_CANARY_MATERIAL_DIVERGENCE_TOLERANCE), and appends an
 *     immutable record — never a mutation of a prior one, matching every
 *     other ledger in this codebase.
 *   - listCalibrationRuns(familyKey, {limit}): a Family's full run
 *     history, oldest first (matching onlineFdr.js's listWealthHistory
 *     convention).
 *   - checkPersistentMaterialDivergence(familyKey, {minConsecutiveRuns}):
 *     the "persistent" half of Part 14's "persistent, material
 *     divergence triggers mandatory Scientific Oversight review" — an
 *     explicit, disclosed, policy-fixed operational definition (the
 *     Constitution does not itself define "persistent"): the most recent
 *     N sufficiently-sampled runs are ALL materially divergent in the
 *     same below-target direction. Returns a diagnostic result; raises no
 *     alert and takes no action itself, consistent with Stage 9 read-only
 *     design — surfacing the condition is the caller's (Dashboard/
 *     alerts.js's) job.
 *
 * Inputs: a Family key, integer Supported/Replicated counts, an optional
 *   allocatedWealth override (defaults to the Laboratory-wide policy
 *   constant), an optional computedAt timestamp.
 * Outputs: Promises resolving to frozen calibration-run records or arrays
 *   of them; throws only on malformed input (never on "found
 *   divergence" — divergence is data, not an error).
 * Dependencies: storage/researchGovernanceDb.js
 *   (getCalibrationCanaryRunsAdapter), core/constants.js (GOVERNANCE).
 *
 * Public API: InvalidCanaryInputError, computeEmpiricalDiscoveryRate,
 *   recordCalibrationRun, listCalibrationRuns,
 *   checkPersistentMaterialDivergence.
 * Internal API: getLatestCanaryRun.
 *
 * Error handling: malformed inputs (negative counts, a replicated count
 *   exceeding the supported count, a non-string familyKey) throw
 *   InvalidCanaryInputError synchronously, before any read or write.
 * Performance notes: recordCalibrationRun is O(log n) (one
 *   queryLatestByIndex seek for the next seq, one add()).
 *   checkPersistentMaterialDivergence is O(log n + minConsecutiveRuns) via
 *   listByIndexRange, never an unbounded scan.
 * Threading model: main-thread only (matches every other governance
 *   module in this codebase).
 * Storage usage: writes to the new CalibrationCanaryRuns store only;
 *   reads nothing from any other store (counts are caller-supplied).
 * Complexity analysis: see Performance notes above.
 * Future extension notes: once Publication Status tracking exists (Tier
 *   4), a thin wrapper can compute supportedCount/supportedAndReplicatedCount
 *   from real per-hypothesis status rows and call recordCalibrationRun on
 *   a schedule (Stage 9's periodic snapshot cadence, THRESHOLDS.
 *   META_SNAPSHOT_INTERVAL_MS) — no change to this module's own logic
 *   would be required.
 */

import { GOVERNANCE } from '../core/constants.js';
import { getCalibrationCanaryRunsAdapter } from '../storage/researchGovernanceDb.js';

export class InvalidCanaryInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCanaryInputError';
  }
}

function assertValidFamilyKey(familyKey, label) {
  if (!familyKey || typeof familyKey !== 'string') {
    throw new InvalidCanaryInputError(`${label}: "familyKey" must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value, label, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidCanaryInputError(`${label}: "${fieldName}" must be a non-negative integer`);
  }
}

/**
 * The pure EDR ratio (Part 16). Returns an explicit "insufficient data"
 * result rather than dividing by zero when no hypothesis in the Family has
 * yet reached Supported.
 */
export function computeEmpiricalDiscoveryRate({ supportedCount, supportedAndReplicatedCount } = {}) {
  assertNonNegativeInteger(supportedCount, 'computeEmpiricalDiscoveryRate', 'supportedCount');
  assertNonNegativeInteger(supportedAndReplicatedCount, 'computeEmpiricalDiscoveryRate', 'supportedAndReplicatedCount');
  if (supportedAndReplicatedCount > supportedCount) {
    throw new InvalidCanaryInputError(
      'computeEmpiricalDiscoveryRate: "supportedAndReplicatedCount" cannot exceed "supportedCount" ' +
      '(every Supported hypothesis that is also Replicated is, by Part 12\'s promotion rule, a subset of Supported)'
    );
  }
  if (supportedCount === 0) {
    return Object.freeze({ edr: null, supportedCount: 0, supportedAndReplicatedCount: 0, insufficientData: true });
  }
  return Object.freeze({
    edr: supportedAndReplicatedCount / supportedCount,
    supportedCount,
    supportedAndReplicatedCount,
    insufficientData: false,
  });
}

async function getLatestCanaryRun(familyKey) {
  const adapter = await getCalibrationCanaryRunsAdapter();
  return adapter.queryLatestByIndex('by_family_seq', [familyKey]);
}

/**
 * Computes, classifies, and permanently records one Empirical FDR
 * Calibration Canary run for a Family. See module header for the EDR
 * formula and the "material" classification's policy-fixed tolerance.
 */
export async function recordCalibrationRun({
  familyKey,
  supportedCount,
  supportedAndReplicatedCount,
  allocatedWealth = GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH,
  computedAt,
} = {}) {
  assertValidFamilyKey(familyKey, 'recordCalibrationRun');
  if (typeof allocatedWealth !== 'number' || !Number.isFinite(allocatedWealth) || allocatedWealth < 0 || allocatedWealth > 1) {
    throw new InvalidCanaryInputError('recordCalibrationRun: "allocatedWealth" must be a finite number in [0, 1]');
  }

  const { edr, insufficientData } = computeEmpiricalDiscoveryRate({ supportedCount, supportedAndReplicatedCount });
  const impliedTarget = 1 - allocatedWealth;

  let divergence = null;
  let direction = null;
  let materialDivergence = false;
  if (!insufficientData) {
    divergence = impliedTarget - edr; // positive => EDR below target (the concerning direction: more failed-to-replicate "Supported" findings than the wealth-process guarantee implies)
    direction = divergence > 0 ? 'below-target' : (divergence < 0 ? 'above-target' : 'on-target');
    materialDivergence = Math.abs(divergence) > GOVERNANCE.EMPIRICAL_FDR_CANARY_MATERIAL_DIVERGENCE_TOLERANCE;
  }
  const belowMinimumSampleSize = insufficientData || supportedCount < GOVERNANCE.EMPIRICAL_FDR_CANARY_MIN_SUPPORTED_FOR_SIGNAL;

  const latest = await getLatestCanaryRun(familyKey);
  const seq = latest ? latest.seq + 1 : 0;
  const resolvedComputedAt = computedAt ?? Date.now();

  const record = {
    id: `ccr_${familyKey}_${seq}`,
    familyKey,
    seq,
    supportedCount,
    supportedAndReplicatedCount,
    edr,
    allocatedWealth,
    impliedTarget,
    divergence,
    direction,
    materialDivergence,
    belowMinimumSampleSize,
    computedAt: resolvedComputedAt,
  };

  const adapter = await getCalibrationCanaryRunsAdapter();
  await adapter.add(record); // native add() -> ConstraintError on any duplicate (familyKey, seq) pair (unique index)

  return record;
}

/** A Family's full calibration-run history, oldest first (matches onlineFdr.js's listWealthHistory convention). */
export async function listCalibrationRuns(familyKey, { limit = Infinity } = {}) {
  assertValidFamilyKey(familyKey, 'listCalibrationRuns');
  const adapter = await getCalibrationCanaryRunsAdapter();
  const rows = await adapter.listByIndexRange('by_family_seq', [familyKey], { limit });
  return rows.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * The "persistent" half of Part 14's "persistent, material divergence"
 * trigger. See module header for the disclosed, policy-fixed operational
 * definition. This function only diagnoses; it never raises an alert or
 * blocks anything (Stage 9 remains strictly read-only/non-corrective).
 */
export async function checkPersistentMaterialDivergence(familyKey, { minConsecutiveRuns = GOVERNANCE.EMPIRICAL_FDR_CANARY_MIN_CONSECUTIVE_RUNS_FOR_PERSISTENCE } = {}) {
  assertValidFamilyKey(familyKey, 'checkPersistentMaterialDivergence');
  if (!Number.isInteger(minConsecutiveRuns) || minConsecutiveRuns < 1) {
    throw new InvalidCanaryInputError('checkPersistentMaterialDivergence: "minConsecutiveRuns" must be a positive integer');
  }

  const allRuns = await listCalibrationRuns(familyKey);
  const signalRuns = allRuns.filter((run) => !run.belowMinimumSampleSize);
  const mostRecent = signalRuns.slice(-minConsecutiveRuns);

  if (mostRecent.length < minConsecutiveRuns) {
    return Object.freeze({
      triggered: false,
      reason: 'insufficient-history',
      runsConsidered: mostRecent.length,
      minConsecutiveRuns,
    });
  }

  const allMaterialBelowTarget = mostRecent.every((run) => run.materialDivergence && run.direction === 'below-target');
  return Object.freeze({
    triggered: allMaterialBelowTarget,
    reason: allMaterialBelowTarget ? 'persistent-material-divergence' : 'not-persistent',
    runsConsidered: mostRecent.length,
    minConsecutiveRuns,
    mostRecentRuns: Object.freeze(mostRecent),
  });
}
