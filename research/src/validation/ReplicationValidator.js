/**
 * research/src/validation/ReplicationValidator.js
 *
 * Purpose:
 *   Section 6 of the Phase 11 Validation & Calibration Directive:
 *   automatically verifies that a replication attempt (bridge/
 *   Phase11ReplicationBridge.js, Stage 2 Part 1) actually used data
 *   independent of the original confirmation, and reports on the
 *   integrity of the partitions used. Diagnostic/reporting layer only —
 *   performs no statistical test itself; it inspects the SAME
 *   partitionEffectSizes / holdoutRange / stability result the real
 *   replication bridge already produced, plus the original confirmation's
 *   own dataset identity, and reports whether they were genuinely
 *   disjoint.
 *
 * What is checked:
 *   - overlap percentage: given the original confirmation dataset's tick
 *     range and the replication holdout's tick range, what fraction of
 *     the replication's range falls inside the original's range (0% is
 *     the honest, correct outcome for a real replication).
 *   - partition integrity: for the replication's own internal partitions
 *     (partitionEffectSizes came from N disjoint chunks), verifies those
 *     chunks' own index ranges do not overlap each other either.
 *   - replication effect size / CI: re-surfaces (does not recompute) the
 *     already-produced DiscoveryStabilityAnalysis result from the
 *     replication bridge, for one-stop reporting.
 *   - consistency with the original discovery: sign agreement between the
 *     original confirmation's effect size and the replication's pooled
 *     effect size (a real discovery should not flip sign on independent
 *     data).
 *
 * Dependencies: none beyond plain arithmetic on caller-supplied ranges and
 *   the ALREADY-PRODUCED results of bridge/Phase11ConfirmationBridge.js
 *   and bridge/Phase11ReplicationBridge.js (both unmodified) — this module
 *   re-derives nothing they already computed, it only audits their inputs
 *   for genuine independence.
 * Public API: verifyReplicationIndependence, Phase11ReplicationValidationInputError.
 * Complexity: O(1) for a single overlap check; O(p^2) for partition-vs-
 *   partition integrity (p = number of replication partitions, always
 *   small — see DiscoveryStabilityAnalysis.js's own typical usage).
 */

export class Phase11ReplicationValidationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11ReplicationValidationInputError';
  }
}

/** Overlap length between two [start,end] ranges (inclusive), or 0 if disjoint. */
function rangeOverlapLength(a, b) {
  const start = Math.max(a.startTick, b.startTick);
  const end = Math.min(a.endTick, b.endTick);
  return Math.max(0, end - start);
}

/**
 * Verifies that a replication's holdout range is genuinely independent of
 * the original confirmation's dataset range, that the replication's own
 * internal partitions don't overlap each other, and reports sign
 * consistency between the original and replication effect sizes.
 *
 * @param {object} params
 * @param {{ startTick: number, endTick: number }} params.originalRange - The
 *   tick range the original Confirmation was computed against.
 * @param {{ startTick: number, endTick: number }} params.replicationRange - The
 *   Lockbox holdout range used for Replication (from
 *   Phase11ReplicationBridge's own lockboxAllocation.record.holdoutRange).
 * @param {{ startTick: number, endTick: number }[]} [params.partitionRanges] -
 *   The tick ranges of each individual replication partition, if available
 *   (for the partition-integrity check). Optional — if omitted, only the
 *   original-vs-replication overlap check runs.
 * @param {number} params.originalEffectSize - The original Confirmation's effect size.
 * @param {number} params.replicationPooledEffectSize - The Replication's pooled effect size.
 * @param {object} [params.stability] - The already-computed
 *   DiscoveryStabilityAnalysis result from the replication bridge, re-surfaced as-is.
 * @returns {{
 *   overlapPercentage: number, partitionIntegrityOk: boolean,
 *   partitionOverlaps: { i: number, j: number, overlapLength: number }[],
 *   signConsistent: boolean, stability: object|null, verdict: 'independent'|'CONTAMINATED'
 * }}
 */
export function verifyReplicationIndependence({
  originalRange, replicationRange, partitionRanges = null,
  originalEffectSize, replicationPooledEffectSize, stability = null,
} = {}) {
  if (!originalRange || !replicationRange
    || !Number.isFinite(originalRange.startTick) || !Number.isFinite(originalRange.endTick)
    || !Number.isFinite(replicationRange.startTick) || !Number.isFinite(replicationRange.endTick)) {
    throw new Phase11ReplicationValidationInputError(
      'verifyReplicationIndependence: originalRange and replicationRange must both be { startTick, endTick } with finite numbers'
    );
  }

  const overlapLength = rangeOverlapLength(originalRange, replicationRange);
  const replicationSpan = replicationRange.endTick - replicationRange.startTick;
  const overlapPercentage = replicationSpan > 0 ? (overlapLength / replicationSpan) * 100 : 0;

  const partitionOverlaps = [];
  if (Array.isArray(partitionRanges)) {
    for (let i = 0; i < partitionRanges.length; i++) {
      for (let j = i + 1; j < partitionRanges.length; j++) {
        const ov = rangeOverlapLength(partitionRanges[i], partitionRanges[j]);
        if (ov > 0) partitionOverlaps.push({ i, j, overlapLength: ov });
      }
    }
  }
  const partitionIntegrityOk = partitionOverlaps.length === 0;

  const signConsistent = Math.sign(originalEffectSize) === Math.sign(replicationPooledEffectSize)
    || originalEffectSize === 0 || replicationPooledEffectSize === 0;

  const verdict = (overlapPercentage === 0 && partitionIntegrityOk) ? 'independent' : 'CONTAMINATED';

  return {
    overlapPercentage, partitionIntegrityOk, partitionOverlaps,
    signConsistent, stability, verdict,
  };
}
