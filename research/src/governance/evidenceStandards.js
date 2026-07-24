/**
 * research/src/governance/evidenceStandards.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 13 (Evidence Standards): the tiered
 *   Weak/Moderate/Strong/Extraordinary evidence ladder that gates
 *   Publication Status transitions (Part 12), plus the Pre-Registration
 *   data-exposure cap and the Strong Evidence tolerance-band formula
 *   (Part 16). Built now because Part 12's full Publication Status state
 *   machine — deferred since Phase 2 with the explicit note "intentionally
 *   deferred until Lockbox and Evidence Standards exist for it to gate
 *   against" — is unblocked now that Lockbox (Phase E) exists; this
 *   module is the second, final prerequisite.
 *
 * Responsibilities:
 *   - checkStrongEvidenceToleranceBand({lockboxEstimate,
 *     replicationEstimate, replicationStandardError, z}): Part 16's exact
 *     formula, |LockboxEstimate - ReplicationEstimate| <= z *
 *     SE_Replication, z policy-fixed (GOVERNANCE.DEFAULT_TOLERANCE_BAND_Z,
 *     default 2).
 *   - classifyEvidenceTier({...signals}): Part 13's table as a pure
 *     decision function over a caller-supplied signal bundle (whether
 *     Discovery's two Part 9 conditions cleared, replication block count
 *     and completeness, Lockbox consumption and tolerance-band result,
 *     Scientific Question reference and out-of-domain replication count,
 *     and the Part 7 pre-registration data-exposure cap flag). Signals
 *     are caller-supplied rather than re-derived here because each one
 *     already has its own authoritative source elsewhere in this
 *     codebase (discoveryDecision.js's two-condition gate, lockbox.js's
 *     write-once consumption, dataAccessLedger.js's attestation
 *     verification) — this module's job is to combine already-computed
 *     facts into a tier, not to recompute them.
 *   - isScientificEvidence(tier): Part 13's "Scientific evidence = union
 *     of Weak/Moderate/Strong/Extraordinary" definition, as a predicate.
 *
 * Explicitly out of scope: Operational and Production evidence (Part 13)
 *   are a separate axis entirely — "a continuously-updated tally of live,
 *   post-Publication performance" — not part of the Discovery/Replication/
 *   Lockbox evidence ladder this module classifies, and depend on Stage 7/8
 *   live-monitoring infrastructure this module does not touch.
 *
 * Priority 3 wiring (Final Core Research Pipeline Implementation):
 *   classifyEvidenceTier() now accepts an optional randomnessAuditPassed
 *   signal (default true, so every pre-existing caller is unaffected) --
 *   its own authoritative source is governance/randomnessAudit.js's
 *   computeRandomnessAuditVerdict(). When explicitly false, the tier is
 *   forced to None regardless of every other signal.
 *
 * Inputs: plain signal objects (see each function's own doc comment).
 * Outputs: a tier string (or null), or a boolean.
 * Dependencies: core/constants.js (GOVERNANCE thresholds).
 *
 * Public API: EVIDENCE_TIERS, TIER_RANK, InvalidEvidenceStandardsInputError,
 *   checkStrongEvidenceToleranceBand, classifyEvidenceTier,
 *   isScientificEvidence. TIER_RANK is exported specifically so
 *   publicationStatus.js can compare tiers ("is this tier >= Strong?")
 *   without a second, independently-maintained ordering.
 * Internal API: none.
 *
 * Error handling: malformed inputs throw
 *   InvalidEvidenceStandardsInputError synchronously.
 * Performance notes: both functions are O(1) — pure decision logic over a
 *   small, fixed signal bundle.
 * Threading model: pure, synchronous, side-effect-free.
 * Storage usage: none.
 * Complexity analysis: O(1).
 * Future extension notes: publicationStatus.js is the sole intended
 *   caller of classifyEvidenceTier() as a transition gate; a future
 *   Operational/Production evidence module would be a natural sibling,
 *   not an extension of this file, per the explicit scope boundary above.
 */

import { GOVERNANCE } from '../core/constants.js';

export const EVIDENCE_TIERS = Object.freeze({
  NONE: 'None',
  WEAK: 'Weak',
  MODERATE: 'Moderate',
  STRONG: 'Strong',
  EXTRAORDINARY: 'Extraordinary',
});

export const TIER_RANK = Object.freeze({
  [EVIDENCE_TIERS.NONE]: 0,
  [EVIDENCE_TIERS.WEAK]: 1,
  [EVIDENCE_TIERS.MODERATE]: 2,
  [EVIDENCE_TIERS.STRONG]: 3,
  [EVIDENCE_TIERS.EXTRAORDINARY]: 4,
});

export class InvalidEvidenceStandardsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEvidenceStandardsInputError';
  }
}

/** Part 13's "Scientific evidence = union of Weak/Moderate/Strong/Extraordinary" definition. */
export function isScientificEvidence(tier) {
  if (!Object.values(EVIDENCE_TIERS).includes(tier)) {
    throw new InvalidEvidenceStandardsInputError(`isScientificEvidence: "${tier}" is not a recognized evidence tier`);
  }
  return tier !== EVIDENCE_TIERS.NONE;
}

/**
 * Part 16's Strong Evidence tolerance-band formula:
 * |LockboxEstimate - ReplicationEstimate| <= z * SE_Replication.
 */
export function checkStrongEvidenceToleranceBand({
  lockboxEstimate,
  replicationEstimate,
  replicationStandardError,
  z = GOVERNANCE.DEFAULT_TOLERANCE_BAND_Z,
} = {}) {
  for (const [name, value] of [
    ['lockboxEstimate', lockboxEstimate],
    ['replicationEstimate', replicationEstimate],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidEvidenceStandardsInputError(`checkStrongEvidenceToleranceBand: "${name}" must be a finite number`);
    }
  }
  if (typeof replicationStandardError !== 'number' || !Number.isFinite(replicationStandardError) || replicationStandardError < 0) {
    throw new InvalidEvidenceStandardsInputError('checkStrongEvidenceToleranceBand: "replicationStandardError" must be a finite, non-negative number');
  }
  if (typeof z !== 'number' || !Number.isFinite(z) || z <= 0) {
    throw new InvalidEvidenceStandardsInputError('checkStrongEvidenceToleranceBand: "z" must be a finite, positive number');
  }

  const deviation = Math.abs(lockboxEstimate - replicationEstimate);
  const band = z * replicationStandardError;
  return Object.freeze({ cleared: deviation <= band, deviation, band, z });
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new InvalidEvidenceStandardsInputError(`classifyEvidenceTier: "${label}" must be a boolean`);
  }
}

/**
 * Part 13's evidence ladder as a pure decision function over an
 * already-computed signal bundle. See module header for why each signal
 * is caller-supplied rather than re-derived.
 */
export function classifyEvidenceTier({
  discoveryConditionsMet,
  replicationBlockCount = 0,
  replicationBlocksAllReported = false,
  lockboxConsumed = false,
  toleranceBandCleared = false,
  hasScientificQuestionRef = false,
  outOfDomainReplicationCount = 0,
  dataAccessCapped = false,
  // Priority 3 wiring (Final Core Research Pipeline Implementation):
  // defaults to true so every pre-existing caller/test is completely
  // unaffected. When a caller HAS run a Randomness Audit
  // (governance/randomnessAudit.js) and it did not conclude
  // GenuinePredictiveStructure, this must be passed explicitly as false.
  randomnessAuditPassed = true,
} = {}) {
  assertBoolean(discoveryConditionsMet, 'discoveryConditionsMet');
  assertBoolean(replicationBlocksAllReported, 'replicationBlocksAllReported');
  assertBoolean(lockboxConsumed, 'lockboxConsumed');
  assertBoolean(toleranceBandCleared, 'toleranceBandCleared');
  assertBoolean(hasScientificQuestionRef, 'hasScientificQuestionRef');
  assertBoolean(dataAccessCapped, 'dataAccessCapped');
  assertBoolean(randomnessAuditPassed, 'randomnessAuditPassed');
  if (!Number.isInteger(replicationBlockCount) || replicationBlockCount < 0) {
    throw new InvalidEvidenceStandardsInputError('classifyEvidenceTier: "replicationBlockCount" must be a non-negative integer');
  }
  if (!Number.isInteger(outOfDomainReplicationCount) || outOfDomainReplicationCount < 0) {
    throw new InvalidEvidenceStandardsInputError('classifyEvidenceTier: "outOfDomainReplicationCount" must be a non-negative integer');
  }

  let tier = EVIDENCE_TIERS.NONE;

  if (discoveryConditionsMet) {
    tier = EVIDENCE_TIERS.WEAK;

    const moderateMet = replicationBlockCount >= GOVERNANCE.MIN_REPLICATION_BLOCKS && replicationBlocksAllReported;
    if (moderateMet) {
      tier = EVIDENCE_TIERS.MODERATE;

      const strongMet = lockboxConsumed && toleranceBandCleared;
      if (strongMet) {
        tier = EVIDENCE_TIERS.STRONG;

        const extraordinaryMet = hasScientificQuestionRef && outOfDomainReplicationCount >= 1;
        if (extraordinaryMet) {
          tier = EVIDENCE_TIERS.EXTRAORDINARY;
        }
      }
    }
  }

  // Part 13: "any Family with disclosed pre-Registration data access is
  // capped at Moderate Evidence for all its hypotheses" -- applied last,
  // after the ladder has been climbed as far as the signals allow.
  if (dataAccessCapped && TIER_RANK[tier] > TIER_RANK[EVIDENCE_TIERS.MODERATE]) {
    tier = EVIDENCE_TIERS.MODERATE;
  }

  // Priority 3: a Randomness Audit that did NOT conclude genuine
  // predictive structure (random chance, statistical artifact, selection
  // bias, or multiple testing) forces None regardless of every other
  // signal -- a result the audit could not distinguish from noise/bias
  // must never accumulate as scientific evidence at any tier.
  if (!randomnessAuditPassed) {
    tier = EVIDENCE_TIERS.NONE;
  }

  return tier;
}
