/**
 * research/src/bridge/Phase11ReplicationBridge.js
 *
 * Purpose:
 *   Bridges a Confirmed Phase 11 candidate through the existing Lockbox
 *   replication framework (Volume IV Part 7/10) — the second half of the
 *   pipeline this Stage completes:
 *
 *     Phase 11: Confirmed -> [THIS BRIDGE] -> Replicated | Deprecated
 *     Legacy:   Discovery -> Replication -> Lockbox -> (holdout consumed)
 *
 *   Like Phase11ConfirmationBridge.js, this is an orchestration layer only.
 *   No new alpha is spent here (Lockbox is a scarce-resource consumption
 *   mechanism, not a second Online FDR budget — Part 9's alpha spend
 *   happened once, in Confirmation). The replication VERDICT itself is
 *   computed by analysis/DiscoveryStabilityAnalysis.js (already built,
 *   already tested in Phase D) applied to caller-supplied per-block effect
 *   sizes from the held-out data — this bridge does not invent a new
 *   ad hoc pass/fail rule, it reuses the one Phase 11 statistic already
 *   designed for exactly this question ("does the effect hold up across
 *   independent partitions?").
 *
 * Legacy lifecycle sequencing (hypothesisRegistry.js's own machine):
 *   Discovery -> Replication -> Lockbox, then the holdout is allocated and
 *   consumed EXACTLY ONCE regardless of the eventual verdict — accessing
 *   the held-out data to determine pass/fail is itself the act Lockbox
 *   exists to gate (Part 7). The legacy hypothesis deliberately remains at
 *   the Lockbox stage after this bridge runs, win or lose: the next legacy
 *   transition (Lockbox -> Publication) is a separate, later decision
 *   (Phase11PublicationBridge.js, Stage 2 Part 2), not automatic here.
 *
 * Phase 11 side: Confirmed -> Replicated (stability threshold met) or
 *   Confirmed -> Deprecated (not met) — both are valid direct transitions
 *   per phase11LifecycleStates.js's own PHASE11_ALLOWED_TRANSITIONS. A
 *   failed replication is archived as first-class negative evidence, not
 *   discarded — the holdout was legitimately consumed either way.
 *
 * Dependencies: governance/lockbox.js (allocateLockboxHoldout,
 *   consumeLockboxHoldout — unmodified), governance/hypothesisRegistry.js
 *   (transitionLifecycleStage, LIFECYCLE_STAGES — unmodified),
 *   analysis/DiscoveryStabilityAnalysis.js (computeDiscoveryStabilityIndex
 *   — already built, reused not reimplemented),
 *   governance/candidateLifecycleTransition.js (withPhase11Lifecycle).
 * Public API: replicatePhase11Candidate, Phase11ReplicationValidationError.
 * Complexity: O(1) validation + O(p) stability computation (p = number of
 *   replication partitions) + lockbox.js's own documented O(log n).
 */

import { transitionLifecycleStage, LIFECYCLE_STAGES } from '../governance/hypothesisRegistry.js';
import { allocateLockboxHoldout, consumeLockboxHoldout } from '../governance/lockbox.js';
import { computeDiscoveryStabilityIndex } from '../analysis/DiscoveryStabilityAnalysis.js';
import { computeBootstrapCI } from '../statistics/uncertaintyEstimation.js';
import { withPhase11Lifecycle } from '../governance/candidateLifecycleTransition.js';
import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';
import { DECISION_TYPES } from '../governance/DecisionAuditLog.js';
import { REJECTION_STAGES } from '../governance/NegativeEvidenceRegistry.js';

/**
 * Derives a deterministic, reproducible RNG seed from a string key --
 * NOT a cryptographic hash, just a simple, stable, non-random mapping so
 * computeBootstrapCI's mandatory seed requirement can be satisfied
 * without every caller inventing its own seed, while remaining fully
 * reproducible (same hypothesisId+generation always yields the same
 * seed, hence the same CI, run to run).
 */
function deterministicSeedFrom(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

export class Phase11ReplicationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11ReplicationValidationError';
  }
}

const DEFAULT_MIN_STABILITY_INDEX = 0.5;

function validateBeforeReplication({ candidate, partitionEffectSizes, pooledEffectSize, featureKey, generation, holdoutRange }) {
  const errors = [];
  if (!candidate || candidate.lifecycle !== PHASE11_LIFECYCLE_STAGES.CONFIRMED) {
    errors.push(`candidate must be at lifecycle stage "Confirmed" (got "${candidate?.lifecycle}")`);
  }
  if (!Array.isArray(partitionEffectSizes) || partitionEffectSizes.length < 2) {
    errors.push('partitionEffectSizes must be an array of at least 2 independent-partition effect sizes from the held-out data');
  }
  if (typeof pooledEffectSize !== 'number' || !Number.isFinite(pooledEffectSize)) {
    errors.push('pooledEffectSize (from the original Confirmation) must be a finite number');
  }
  if (!featureKey || generation === undefined || generation === null) {
    errors.push('featureKey and generation are required to identify the Lockbox holdout slot');
  }
  if (!holdoutRange) {
    errors.push('holdoutRange is required (the specific held-out data range being consumed)');
  }
  if (errors.length) {
    throw new Phase11ReplicationValidationError(
      `replicatePhase11Candidate: ${errors.length} validation failure(s) — refusing before any legacy Lockbox call:\n- ${errors.join('\n- ')}`
    );
  }
}

/**
 * Bridges a Confirmed Phase 11 candidate through Replication -> Lockbox,
 * consumes the holdout exactly once, and determines the replication
 * verdict via DiscoveryStabilityAnalysis applied to the held-out data.
 *
 * @param {object} params
 * @param {object} params.candidate - Must be at PHASE11_LIFECYCLE_STAGES.CONFIRMED.
 * @param {string} params.hypothesisId - The legacy hypothesisRegistry id (from confirmPhase11Candidate's result).
 * @param {string} params.familyKey - The legacy Online-FDR family key (from confirmPhase11Candidate's result).
 * @param {string} params.featureKey - Identifies the Lockbox holdout slot (with generation).
 * @param {number} params.generation
 * @param {object} params.holdoutRange - The specific held-out data range being consumed (e.g. {startTick, endTick}).
 * @param {number[]} params.partitionEffectSizes - Per-independent-partition effect size estimates from the held-out data.
 * @param {number} params.pooledEffectSize - The original Confirmation's pooled effect size, for stability comparison.
 * @param {number} [params.minStabilityIndex] - Defaults to sap.replicationCriteria.minStabilityIndex, else 0.5.
 * @param {object} [params.sap] - Used only to read replicationCriteria.minStabilityIndex if minStabilityIndex isn't given directly.
 * @param {(a: object, b: object) => boolean} [params.rangeOverlapsFn] - Passed through to allocateLockboxHoldout.
 * @param {string} [params.allocatedBy='phase11-replication-bridge']
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {import('../governance/NegativeEvidenceRegistry.js').NegativeEvidenceRegistry} [params.negativeEvidenceRegistry]
 * @param {string} [params.datasetId] - For negative-evidence records, if replication fails.
 * @returns {Promise<{
 *   outcome: 'replicated'|'failed',
 *   candidate: object,
 *   hypothesisId: string,
 *   stability: object,
 *   lockboxAllocation: object,
 *   lockboxConsumption: object
 * }>}
 */
export async function replicatePhase11Candidate({
  candidate, hypothesisId, familyKey, featureKey, generation, holdoutRange,
  partitionEffectSizes, pooledEffectSize, minStabilityIndex, sap,
  rangeOverlapsFn, allocatedBy = 'phase11-replication-bridge',
  decisionAuditLog = null, negativeEvidenceRegistry = null, datasetId = null,
} = {}) {
  validateBeforeReplication({ candidate, partitionEffectSizes, pooledEffectSize, featureKey, generation, holdoutRange });

  const threshold = minStabilityIndex ?? sap?.replicationCriteria?.minStabilityIndex ?? DEFAULT_MIN_STABILITY_INDEX;

  // ── Legacy lifecycle: Discovery -> Replication -> Lockbox ──────────
  await transitionLifecycleStage(hypothesisId, {
    to: LIFECYCLE_STAGES.REPLICATION,
    reason: 'Phase 11 candidate Confirmed — advancing legacy lifecycle to Replication',
    approvedBy: allocatedBy,
  });
  await transitionLifecycleStage(hypothesisId, {
    to: LIFECYCLE_STAGES.LOCKBOX,
    reason: 'Phase 11 replication requires the held-out Lockbox data',
    approvedBy: allocatedBy,
  });

  // ── Allocate and consume the holdout exactly once, regardless of the
  //    eventual verdict — accessing this data IS the replication attempt.
  const lockboxAllocation = await allocateLockboxHoldout({
    hypothesisId, familyKey, featureKey, generation, holdoutRange, allocatedBy, rangeOverlapsFn,
  });

  // ── The replication verdict: reuses the already-built, already-tested
  //    Phase 11 stability statistic — not a new ad hoc rule.
  const stability = computeDiscoveryStabilityIndex(partitionEffectSizes, pooledEffectSize);

  // ── Stage 7 requirement: a real confidence interval on the replication
  //    effect size, not just the scalar stability index. Reuses the
  //    EXISTING generic computeBootstrapCI (statistics/uncertaintyEstimation.js
  //    — unmodified) directly over partitionEffectSizes; no new bootstrap
  //    logic is written here. A deterministic seed is derived from
  //    hypothesisId+generation (same "no hidden randomness" discipline
  //    used throughout Phase 11) so this is reproducible without requiring
  //    every caller to invent its own seed. Honestly disclosed: with only
  //    a handful of replication partitions (typically 4), this CI is
  //    necessarily wide — it reports genuine uncertainty rather than a
  //    false precision, not a claim of high statistical power.
  const ciSeed = deterministicSeedFrom(`${hypothesisId}:${generation}`);
  const replicationConfidenceInterval = computeBootstrapCI(partitionEffectSizes, {
    confidenceLevel: 0.95, numResamples: 2000, seed: ciSeed,
  });

  const lockboxConsumption = await consumeLockboxHoldout({
    id: lockboxAllocation.record.id,
    consumedBy: allocatedBy,
    testStatistic: stability.stabilityIndex,
    effectSize: pooledEffectSize,
    partitionEffectSizes,
    signAgreementFraction: stability.signAgreementFraction,
    magnitudeConsistency: stability.magnitudeConsistency,
  });

  if (stability.stabilityIndex >= threshold) {
    const replicatedCandidate = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.REPLICATED);
    if (decisionAuditLog) {
      decisionAuditLog.append({
        candidateId: candidate.id,
        decisionType: DECISION_TYPES.REPLICATED,
        reason: `Round 4: stabilityIndex ${stability.stabilityIndex.toFixed(4)} >= threshold ${threshold} across ${partitionEffectSizes.length} independent partitions`,
        actor: 'phase11-replication-bridge',
        metadata: { hypothesisId, familyKey, stability },
      });
    }
    return { outcome: 'replicated', candidate: replicatedCandidate, hypothesisId, stability, replicationConfidenceInterval, lockboxAllocation, lockboxConsumption };
  }

  const deprecatedCandidate = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.DEPRECATED);
  if (decisionAuditLog) {
    decisionAuditLog.append({
      candidateId: candidate.id,
      decisionType: DECISION_TYPES.REPLICATION_FAILED,
      reason: `Round 4: stabilityIndex ${stability.stabilityIndex.toFixed(4)} < threshold ${threshold} across ${partitionEffectSizes.length} independent partitions`,
      actor: 'phase11-replication-bridge',
      metadata: { hypothesisId, familyKey, stability },
    });
  }
  if (negativeEvidenceRegistry) {
    negativeEvidenceRegistry.record({
      candidateFingerprint: candidate.fingerprint,
      stageRejected: REJECTION_STAGES.REPLICATION,
      reason: `Failed replication: stabilityIndex ${stability.stabilityIndex.toFixed(4)} < threshold ${threshold}`,
      dataset: datasetId,
      effectSize: pooledEffectSize,
      replicationStatus: 'failed',
    });
  }
  return { outcome: 'failed', candidate: deprecatedCandidate, hypothesisId, stability, replicationConfidenceInterval, lockboxAllocation, lockboxConsumption };
}
