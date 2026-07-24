/**
 * research/src/governance/lockbox.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 10 (Lockbox Policy) as an actual governed
 *   mechanism — activating the already-built, previously-orphaned Lockbox
 *   store (`existingDbExtensions.js`'s `getLockboxAdapter()`, structurally
 *   write-once/one-time-consumption-safe since Phase 1's V-2/RT-1/RT-3
 *   fixes) with the allocation policy and disqualification rules that make
 *   it Constitutionally meaningful, not just mechanically write-once.
 *
 * Why this matters: without a Lockbox, every reported effect size is
 *   winner's-curse-inflated (Consolidation Retirement Plan, Migration Plan
 *   M-series). The storage-level write-once guarantee alone does not
 *   prevent a disqualified allocation (holdout data already informally
 *   accessed before Registration) or an allocation for an unregistered, or
 *   not-yet-at-the-Lockbox-stage, hypothesis — those are governance rules
 *   this module adds on top of the storage guarantee.
 *
 * Responsibilities:
 *   - allocateLockboxHoldout({hypothesisId, familyKey, featureKey,
 *     generation, holdoutRange, allocatedBy, rangeOverlapsFn}): the
 *     sanctioned allocation entry point. Enforces, in order: (1) the
 *     hypothesis must be Registered AND currently at the Lockbox Lifecycle
 *     Stage (Part 2 — Lockbox allocation is not available earlier in the
 *     lifecycle); (2) Part 7's Lockbox-specific pre-access rule — the
 *     holdout range must not have been accessed before the lineage's own
 *     Registration timestamp (delegates the actual disqualification
 *     check to dataAccessLedger.isLockboxAllocationDisqualified, built in
 *     Phase 2). Only after both checks pass does it write a new,
 *     deterministically-keyed Lockbox row (id derived from
 *     (featureKey, generation), matching the store's own unique index, so
 *     a second allocation attempt for the same feature+generation is
 *     idempotent-safe rather than a silent duplicate — this is also the
 *     concrete enforcement of N_max-scoped scarcity: one Lockbox
 *     allocation per (featureKey, generation), ever).
 *   - consumeLockboxHoldout({id, consumedBy, testStatistic, effectSize,
 *     ...evidence}): the sanctioned one-time-consumption entry point,
 *     thinly wrapping the adapter's own consumeOnce() (already hardened by
 *     Phase 1's structural guard-field forcing and identity-mutation
 *     rejection) — kept here, not called directly by other governance
 *     modules, so Part 10's future extensions (e.g., an Evidence Tier cap
 *     from a disclosed prior access, per Part 7) have exactly one call
 *     site to extend.
 *   - getLockboxAllocation(featureKey, generation): read-through lookup by
 *     the same deterministic id.
 *
 * Inputs: a registered hypothesisId, a Family Key, a (featureKey,
 *   generation) pair identifying the specific holdout slot, and a holdout
 *   range whose overlap semantics are caller-supplied (range shape is a
 *   Stage-level concern this governance module does not need to know the
 *   internals of — matches dataAccessLedger.js's own established pattern).
 * Outputs: Promises resolving to the allocation/consumption result or the
 *   stored allocation row.
 * Dependencies: storage/existingDbExtensions.js (getLockboxAdapter),
 *   governance/hypothesisRegistry.js (getCurrentLifecycleStage,
 *   getHypothesis, LIFECYCLE_STAGES), governance/dataAccessLedger.js
 *   (isLockboxAllocationDisqualified).
 *
 * Public API: allocateLockboxHoldout, consumeLockboxHoldout,
 *   getLockboxAllocation, LockboxNotEligibleError, LockboxDisqualifiedError.
 * Internal API: none.
 *
 * Error handling: LockboxNotEligibleError covers both "not Registered" and
 *   "not currently at the Lockbox stage" — thrown before any read of the
 *   Data Access Ledger or any write, so an ineligible request never even
 *   reveals disqualification status. LockboxDisqualifiedError is thrown
 *   after the ledger check specifically fails, carrying the conflicting
 *   entries for audit purposes. Neither error path writes a Lockbox row.
 * Performance notes: one bounded Lifecycle-stage read, one bounded
 *   Data-Access-Ledger range read (via dataAccessLedger.js, itself
 *   index-bounded), one write-once store operation — no unbounded scans.
 * Threading model: main-thread only.
 * Storage usage: writes to the existing `Lockbox` store only (via the
 *   already-built adapter); reads LifecycleTransitions, HypothesisRegistry,
 *   and DataAccessLedger.
 * Complexity analysis: O(log n) throughout, per Performance notes.
 * Future extension notes: Part 7's Evidence Tier cap for a DISCLOSED (not
 *   disqualifying) prior access is not yet wired here — dataAccessLedger's
 *   verifyAttestation() already surfaces hasDisclosedPriorAccess for a
 *   Registration-time check; a Lockbox-time equivalent belongs here once
 *   Evidence Standards (Part 13) exist to define what the cap actually
 *   constrains.
 */

import { getLockboxAdapter } from '../storage/existingDbExtensions.js';
import { getCurrentLifecycleStage, getHypothesis, LIFECYCLE_STAGES } from './hypothesisRegistry.js';
import { isLockboxAllocationDisqualified } from './dataAccessLedger.js';

export class LockboxNotEligibleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockboxNotEligibleError';
  }
}

export class LockboxDisqualifiedError extends Error {
  constructor(message, conflictingEntries) {
    super(message);
    this.name = 'LockboxDisqualifiedError';
    this.conflictingEntries = conflictingEntries;
  }
}

function deterministicLockboxId(featureKey, generation) {
  return `lockbox_${featureKey}_${generation}`;
}

/** Default range-overlap predicate for the common case of {startTick, endTick} numeric ranges. */
function defaultRangeOverlapsFn(a, b) {
  if (!a || !b) return false;
  return a.startTick <= b.endTick && b.startTick <= a.endTick;
}

/**
 * The sanctioned Lockbox allocation entry point. See module header for the
 * full two-check rationale (eligibility, then disqualification).
 */
export async function allocateLockboxHoldout({
  hypothesisId,
  familyKey,
  featureKey,
  generation,
  holdoutRange,
  allocatedBy,
  rangeOverlapsFn = defaultRangeOverlapsFn,
} = {}) {
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new LockboxNotEligibleError('allocateLockboxHoldout: "hypothesisId" must be a non-empty string');
  }
  if (!featureKey || generation === undefined || generation === null) {
    throw new LockboxNotEligibleError('allocateLockboxHoldout: "featureKey" and "generation" are required');
  }

  // Check 1: Registration + Lifecycle Stage eligibility. Refused BEFORE
  // any Data Access Ledger read, so an ineligible caller learns nothing
  // about disqualification status.
  const currentStage = await getCurrentLifecycleStage(hypothesisId);
  if (!currentStage) {
    throw new LockboxNotEligibleError(
      `allocateLockboxHoldout: hypothesis "${hypothesisId}" has no Registration on record`
    );
  }
  if (currentStage !== LIFECYCLE_STAGES.LOCKBOX) {
    throw new LockboxNotEligibleError(
      `allocateLockboxHoldout: hypothesis "${hypothesisId}" is at Lifecycle Stage "${currentStage}", ` +
      `not "${LIFECYCLE_STAGES.LOCKBOX}" — a Lockbox holdout may only be allocated once a hypothesis has ` +
      'reached the Lockbox stage (Part 2)'
    );
  }

  // Check 2: Part 7's Lockbox-specific pre-access rule.
  const hypothesis = await getHypothesis(hypothesisId);
  const disqualification = await isLockboxAllocationDisqualified({
    familyKey: familyKey ?? hypothesis.familyKey,
    lineageRegistrationTimestamp: hypothesis.birthTimestamp,
    holdoutRange,
    rangeOverlapsFn,
  });
  if (disqualification.disqualified) {
    throw new LockboxDisqualifiedError(
      `allocateLockboxHoldout: the requested holdout range for hypothesis "${hypothesisId}" was accessed ` +
      'before its lineage\'s Registration -- Part 7 disqualifies this allocation',
      disqualification.conflictingEntries
    );
  }

  const adapter = await getLockboxAdapter();
  const id = deterministicLockboxId(featureKey, generation);
  const result = await adapter.write({
    id,
    featureKey,
    generation,
    hypothesisId,
    familyKey: familyKey ?? hypothesis.familyKey,
    holdoutRange,
    allocatedBy: allocatedBy ?? null,
    allocatedAt: Date.now(),
    consumedAt: null,
    consumedBy: null,
  });
  return result; // { created: true, record } on first allocation; { created: false, record } if one already exists for this (featureKey, generation)
}

/**
 * The sanctioned one-time-consumption entry point. Thinly wraps the
 * adapter's own consumeOnce() — see module header for why this
 * indirection exists.
 */
export async function consumeLockboxHoldout({ id, consumedBy, ...evidence } = {}) {
  if (!id || typeof id !== 'string') {
    throw new LockboxNotEligibleError('consumeLockboxHoldout: "id" must be a non-empty string');
  }
  const adapter = await getLockboxAdapter();
  return adapter.consumeOnce(id, { consumedBy: consumedBy ?? null, ...evidence });
}

/** Read-through lookup for an existing allocation by its natural (featureKey, generation) key. */
export async function getLockboxAllocation(featureKey, generation) {
  const adapter = await getLockboxAdapter();
  return adapter.get(deterministicLockboxId(featureKey, generation));
}
