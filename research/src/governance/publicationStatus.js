/**
 * research/src/governance/publicationStatus.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 12's full Publication Status state
 *   machine — the SEPARATE "what is the Laboratory's current scientific
 *   verdict" axis, distinct from Lifecycle Stage (Part 2, "where in the
 *   process," already implemented in hypothesisRegistry.js). Explicitly
 *   deferred since Phase 2 pending two prerequisites — Lockbox (Phase E)
 *   and Evidence Standards (this phase's evidenceStandards.js) — both of
 *   which now exist.
 *
 * Design mirrors hypothesisRegistry.js's own Lifecycle Stage machinery
 *   deliberately closely (ALLOWED_TRANSITIONS as an allow-list graph,
 *   append-only transition log, `getCurrent*`/`list*History` reader
 *   pair) — the two state machines are structurally the same kind of
 *   thing, and Part 2 itself draws the parallel explicitly.
 *
 * Responsibilities:
 *   - transitionPublicationStatus(hypothesisId, {to, ...}): enforces
 *     Part 12's ALLOWED_TRANSITIONS graph AND, per the target status,
 *     the specific Evidence Tier / attestation requirement Part 12's own
 *     table lists for entering it (see the per-target guard logic below,
 *     each one commented against its exact source row). A transition
 *     that fails its guard is refused BEFORE any write.
 *   - getCurrentPublicationStatus(hypothesisId): the latest status, or
 *     null if never classified.
 *   - listPublicationStatusHistory(hypothesisId): the full transition
 *     history for a hypothesis.
 *
 * A note on what this module does NOT verify: several of Part 12's entry
 *   requirements name facts this module has no independent way to
 *   compute (a completed Multiverse/Sensitivity Analysis report, active
 *   Stage 7/8 monitoring, contradicting evidence). For these, the
 *   corresponding parameter is a caller-attested boolean, and the
 *   Constitutional requirement is enforced as "the caller must explicitly
 *   assert this happened," matching the exact pattern already used for
 *   Scientific Oversight approval records throughout this codebase
 *   (hypothesisRegistry.js's classifyIndeterminate, dataAccessLedger.js's
 *   attestation checks) — this module cannot exercise human scientific
 *   judgment, only enforce that no gated action proceeds without a
 *   record of it.
 *
 * Inputs: a hypothesisId, a target PUBLICATION_STATUSES value, and the
 *   evidence/attestation signals that status's entry requires (see
 *   per-target comments in transitionPublicationStatus).
 * Outputs: Promises resolving to the new transition record, the current
 *   status string (or null), or the full history array.
 * Dependencies: storage/researchGovernanceDb.js
 *   (getPublicationStatusTransitionsAdapter),
 *   governance/evidenceStandards.js (EVIDENCE_TIERS, TIER_RANK,
 *   isScientificEvidence), statistics/uncertaintyEstimation.js
 *   (Priority 1.4 wiring -- assertReportable/assertPublicationEstimate,
 *   "no scientific result should be published without uncertainty
 *   information").
 *
 * Public API: PUBLICATION_STATUSES, ForbiddenPublicationTransitionError,
 *   InvalidPublicationTransitionError, transitionPublicationStatus,
 *   getCurrentPublicationStatus, listPublicationStatusHistory.
 * Internal API: getLatestPublicationStatusTransition, assertUncertaintyAttached.
 *
 * Error handling: an out-of-graph transition throws
 *   ForbiddenPublicationTransitionError before any write. A missing or
 *   malformed evidence/attestation signal for the attempted target throws
 *   InvalidPublicationTransitionError, also before any write — a rejected
 *   transition never produces a partial record. Priority 1.4: entering
 *   ProvisionallySupported/Replicated/Supported/Published without a valid,
 *   reportable estimateRecord throws InvalidPublicationTransitionError
 *   (missing), NonReportableEstimateError/MissingAccompanyingEstimateError
 *   (present but fails Part 11's reportability policy), or
 *   InvalidPublicationEstimateError (Published specifically requires a
 *   Lockbox-type estimate) -- all propagated, unmodified, from
 *   uncertaintyEstimation.js, before any write.
 * Performance notes: every read is index-bounded
 *   (by_hypothesis_seq/by_hypothesis_createdAt) — no unbounded scan,
 *   matching hypothesisRegistry.js's own discipline exactly.
 * Threading model: main-thread only.
 * Storage usage: append-only writes to the new
 *   PublicationStatusTransitions store only.
 * Complexity analysis: O(log n) per operation.
 * Future extension notes: Part 12's automatic, time-triggered demotions
 *   (e.g. Deprecated must reach Retired within a policy-fixed maximum
 *   dwell time) are NOT enforced by this module — that is a scheduled/
 *   monitoring concern for a future Stage 9 process to surface as a
 *   human-facing alert (Volume III's own "Stage 9 remains read-only,
 *   non-corrective" design), not something a synchronous transition
 *   function can enforce.
 */

import { getPublicationStatusTransitionsAdapter } from '../storage/researchGovernanceDb.js';
import { EVIDENCE_TIERS, TIER_RANK, isScientificEvidence } from './evidenceStandards.js';
// Priority 1.4 wiring (Final Core Research Pipeline Implementation): "no
// scientific result should be published without uncertainty information."
// Reuses Part 11's existing, already-tested reportability policy directly
// -- no new uncertainty logic is introduced here, only enforcement of it
// at the point a result actually becomes a Publication Status entry.
import { assertReportable, assertPublicationEstimate } from '../statistics/uncertaintyEstimation.js';

export const PUBLICATION_STATUSES = Object.freeze({
  PROVISIONALLY_SUPPORTED: 'ProvisionallySupported',
  INDETERMINATE: 'Indeterminate',
  REJECTED: 'Rejected',
  REFUTED: 'Refuted',
  REPLICATED: 'Replicated',
  SUPPORTED: 'Supported',
  PUBLISHED: 'Published',
  OPERATIONAL: 'Operational',
  DEPRECATED: 'Deprecated',
  RETIRED: 'Retired',
  ARCHIVED: 'Archived',
});

// ── Part 12's table, expressed as an allow-list graph. ENTRY_STATUSES are
//    the statuses reachable when a hypothesis has no Publication Status
//    row yet (its first Discovery/Replication verdict). ───────────────────
const ENTRY_STATUSES = Object.freeze([
  PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED,
  PUBLICATION_STATUSES.REJECTED,
  PUBLICATION_STATUSES.INDETERMINATE,
  PUBLICATION_STATUSES.REFUTED,
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED]: Object.freeze([
    PUBLICATION_STATUSES.REPLICATED, PUBLICATION_STATUSES.REJECTED, PUBLICATION_STATUSES.INDETERMINATE,
  ]),
  [PUBLICATION_STATUSES.INDETERMINATE]: Object.freeze([PUBLICATION_STATUSES.REJECTED]),
  [PUBLICATION_STATUSES.REJECTED]: Object.freeze([PUBLICATION_STATUSES.RETIRED]),
  [PUBLICATION_STATUSES.REFUTED]: Object.freeze([PUBLICATION_STATUSES.RETIRED]),
  [PUBLICATION_STATUSES.REPLICATED]: Object.freeze([PUBLICATION_STATUSES.SUPPORTED, PUBLICATION_STATUSES.REJECTED]),
  [PUBLICATION_STATUSES.SUPPORTED]: Object.freeze([PUBLICATION_STATUSES.PUBLISHED, PUBLICATION_STATUSES.DEPRECATED]),
  [PUBLICATION_STATUSES.PUBLISHED]: Object.freeze([
    PUBLICATION_STATUSES.OPERATIONAL, PUBLICATION_STATUSES.DEPRECATED, PUBLICATION_STATUSES.RETIRED,
  ]),
  [PUBLICATION_STATUSES.OPERATIONAL]: Object.freeze([PUBLICATION_STATUSES.DEPRECATED]),
  [PUBLICATION_STATUSES.DEPRECATED]: Object.freeze([PUBLICATION_STATUSES.RETIRED]),
  [PUBLICATION_STATUSES.RETIRED]: Object.freeze([PUBLICATION_STATUSES.ARCHIVED]),
  [PUBLICATION_STATUSES.ARCHIVED]: Object.freeze([]),
});

export class ForbiddenPublicationTransitionError extends Error {
  constructor(message, { from, to } = {}) {
    super(message);
    this.name = 'ForbiddenPublicationTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class InvalidPublicationTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPublicationTransitionError';
  }
}

function isWellFormedApproval(oversightApproval) {
  return !!oversightApproval
    && typeof oversightApproval.approvedBy === 'string' && oversightApproval.approvedBy.length > 0
    && typeof oversightApproval.rationale === 'string' && oversightApproval.rationale.length > 0;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidPublicationTransitionError(`transitionPublicationStatus: "${label}" must be a non-empty string`);
  }
}

function assertValidTier(evidenceTier, label) {
  if (!Object.values(EVIDENCE_TIERS).includes(evidenceTier)) {
    throw new InvalidPublicationTransitionError(`transitionPublicationStatus: "${label}" must be a recognized evidence tier`);
  }
}

async function getLatestPublicationStatusTransition(hypothesisId) {
  const adapter = await getPublicationStatusTransitionsAdapter();
  return adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
}

export async function getCurrentPublicationStatus(hypothesisId) {
  const latest = await getLatestPublicationStatusTransition(hypothesisId);
  return latest ? latest.to : null;
}

/** A hypothesis's full Publication Status transition history, oldest first (matches every other list*History()/listWealthHistory()-style function's ordering convention in this codebase). */
export async function listPublicationStatusHistory(hypothesisId) {
  const adapter = await getPublicationStatusTransitionsAdapter();
  const rows = await adapter.listByIndexRange('by_hypothesis_seq', [hypothesisId]);
  return rows.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * The per-target Evidence Tier / attestation guard, checked BEFORE the
 * graph-adjacency check's result is written. Each branch is commented
 * against its exact Part 12 source row.
 */
/**
 * Priority 1.4 wiring: requires an attached estimate record and enforces
 * Part 11's existing reportability policy via assertReportable() -- e.g. a
 * Validation-type estimate must be accompanied by a Replication/Lockbox
 * one, a Selection-type estimate may never be reported at all. No
 * uncertainty logic is reimplemented here; this only enforces that a
 * "reported result" status never enters without one.
 */
function assertUncertaintyAttached(to, estimateRecord, accompanyingEstimateRecord) {
  if (!estimateRecord) {
    throw new InvalidPublicationTransitionError(
      `transitionPublicationStatus: entering "${to}" requires "estimateRecord" (Part 11 — no result may be reported without its uncertainty/effect-size basis attached)`
    );
  }
  assertReportable(estimateRecord, { accompaniedByRecord: accompanyingEstimateRecord ?? null });
}

function assertEntryRequirementsMet(to, signals) {
  const {
    evidenceTier, hasScientificQuestionRef, formalReportCompleted,
    activeMonitoringConfirmed, oversightApproval, contradictingEvidenceConfirmed,
    estimateRecord, accompanyingEstimateRecord,
  } = signals;

  switch (to) {
    case PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED:
      // "Discovery result at >= Weak Evidence."
      assertValidTier(evidenceTier, 'evidenceTier');
      if (!isScientificEvidence(evidenceTier)) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering ProvisionallySupported requires at least Weak Evidence (Part 12)');
      }
      assertUncertaintyAttached(to, estimateRecord, accompanyingEstimateRecord);
      break;

    case PUBLICATION_STATUSES.REPLICATED:
      // "Successful, pre-specified Replication" -- Moderate Evidence (Part 13).
      assertValidTier(evidenceTier, 'evidenceTier');
      if (TIER_RANK[evidenceTier] < TIER_RANK[EVIDENCE_TIERS.MODERATE]) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Replicated requires at least Moderate Evidence (Part 12/13)');
      }
      assertUncertaintyAttached(to, estimateRecord, accompanyingEstimateRecord);
      break;

    case PUBLICATION_STATUSES.SUPPORTED:
      // "Successful Lockbox consumption at Strong Evidence, using the
      // Lockbox estimate" -- classifyEvidenceTier() only reaches Strong
      // once lockboxConsumed && toleranceBandCleared are both true, so
      // checking the tier here is sufficient without a redundant flag.
      assertValidTier(evidenceTier, 'evidenceTier');
      if (TIER_RANK[evidenceTier] < TIER_RANK[EVIDENCE_TIERS.STRONG]) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Supported requires Strong Evidence via Lockbox consumption (Part 12/13)');
      }
      assertUncertaintyAttached(to, estimateRecord, accompanyingEstimateRecord);
      break;

    case PUBLICATION_STATUSES.PUBLISHED: {
      // "A completed, permanently archived formal report, using only
      // permitted estimates and claim-scope" -- Strong Evidence
      // (Extraordinary, if referencing a Scientific Question) (Part 12/13).
      assertValidTier(evidenceTier, 'evidenceTier');
      if (typeof formalReportCompleted !== 'boolean' || !formalReportCompleted) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Published requires "formalReportCompleted: true" (the completed formal publication report, including Multiverse/Sensitivity Analysis, Part 13)');
      }
      const requiredTier = hasScientificQuestionRef ? EVIDENCE_TIERS.EXTRAORDINARY : EVIDENCE_TIERS.STRONG;
      if (TIER_RANK[evidenceTier] < TIER_RANK[requiredTier]) {
        throw new InvalidPublicationTransitionError(
          `transitionPublicationStatus: entering Published ${hasScientificQuestionRef ? 'while referencing a Scientific Question requires Extraordinary Evidence' : 'requires at least Strong Evidence'} (Part 12/13)`
        );
      }
      // Priority 1.4 (Final Core Research Pipeline Implementation): "no
      // scientific result should be published without uncertainty
      // information." Published specifically requires the Lockbox
      // estimate (Part 11's own rule, enforced by the existing
      // assertPublicationEstimate -- not reimplemented here).
      if (!estimateRecord) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Published requires "estimateRecord" (Part 11 — no result may publish without its uncertainty/effect-size basis attached)');
      }
      assertPublicationEstimate(estimateRecord);
      break;
    }

    case PUBLICATION_STATUSES.OPERATIONAL:
      // "Published status, plus active Stage 7/8 continuous monitoring."
      if (typeof activeMonitoringConfirmed !== 'boolean' || !activeMonitoringConfirmed) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Operational requires "activeMonitoringConfirmed: true" (active Stage 7/8 continuous monitoring, Part 12)');
      }
      break;

    case PUBLICATION_STATUSES.INDETERMINATE:
      // "Confirmed by Scientific Oversight to lack adequate power or to
      // be drift-confounded" -- the full triple-check (power + drift +
      // Oversight) is hypothesisRegistry.js's classifyIndeterminate()'s
      // job; this module requires the same well-formed Oversight record
      // as evidence that check already happened.
      if (!isWellFormedApproval(oversightApproval)) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Indeterminate requires a well-formed Scientific Oversight approval record (Part 12)');
      }
      break;

    case PUBLICATION_STATUSES.REFUTED:
      // "Evidence affirmatively contradicts the hypothesis; or a
      // confirmed governance violation."
      if (!isWellFormedApproval(oversightApproval) && contradictingEvidenceConfirmed !== true) {
        throw new InvalidPublicationTransitionError('transitionPublicationStatus: entering Refuted requires either a well-formed Scientific Oversight approval record (governance violation) or "contradictingEvidenceConfirmed: true" (Part 12)');
      }
      break;

    case PUBLICATION_STATUSES.REJECTED:
    case PUBLICATION_STATUSES.DEPRECATED:
    case PUBLICATION_STATUSES.RETIRED:
    case PUBLICATION_STATUSES.ARCHIVED:
      // No Evidence Tier gate for these -- Rejected/Deprecated are
      // failure/decay outcomes, Retired/Archived are terminal bookkeeping.
      // A recorded reason is still mandatory (Part 12: "Retired... with a
      // mandatory recorded reason") and is checked below for every target.
      break;

    default:
      // Unreachable given the ALLOWED_TRANSITIONS graph check that always
      // runs first, but kept as a defensive guard against a future
      // mis-added enum value with no corresponding case here.
      throw new InvalidPublicationTransitionError(`transitionPublicationStatus: no entry-requirement rule defined for target status "${to}"`);
  }
}

/**
 * Enforces Part 12's ALLOWED_TRANSITIONS graph AND the target status's own
 * Evidence Tier / attestation entry requirement, then appends the new
 * transition. See module header and assertEntryRequirementsMet() for the
 * full per-target rationale.
 */
export async function transitionPublicationStatus(hypothesisId, {
  to,
  reason,
  evidenceTier,
  hasScientificQuestionRef = false,
  formalReportCompleted = false,
  activeMonitoringConfirmed = false,
  oversightApproval,
  contradictingEvidenceConfirmed = false,
  estimateRecord,
  accompanyingEstimateRecord,
} = {}) {
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new InvalidPublicationTransitionError('transitionPublicationStatus: "hypothesisId" must be a non-empty string');
  }
  if (!Object.values(PUBLICATION_STATUSES).includes(to)) {
    throw new InvalidPublicationTransitionError(`transitionPublicationStatus: "${to}" is not a recognized Publication Status`);
  }
  assertNonEmptyString(reason, 'reason');

  const latest = await getLatestPublicationStatusTransition(hypothesisId);
  const from = latest ? latest.to : null;
  const allowed = from === null ? ENTRY_STATUSES : (ALLOWED_TRANSITIONS[from] || []);

  if (!allowed.includes(to)) {
    throw new ForbiddenPublicationTransitionError(
      `transitionPublicationStatus: "${from ?? '(none)'}" -> "${to}" is not a permitted Publication Status transition for hypothesis "${hypothesisId}" (Part 12)`,
      { from, to }
    );
  }

  assertEntryRequirementsMet(to, {
    evidenceTier, hasScientificQuestionRef, formalReportCompleted,
    activeMonitoringConfirmed, oversightApproval, contradictingEvidenceConfirmed,
    estimateRecord, accompanyingEstimateRecord,
  });

  const seq = latest ? latest.seq + 1 : 0;
  const record = {
    id: `pst_${hypothesisId}_${seq}`,
    hypothesisId,
    seq,
    from,
    to,
    reason,
    evidenceTier: evidenceTier ?? null,
    approvedBy: oversightApproval?.approvedBy ?? null,
    // Priority 1.4: the estimate record that justified this transition is
    // permanently attached to it -- a published verdict's uncertainty
    // basis is itself part of the permanent scientific record, not a
    // fact that only existed transiently at decision time.
    estimateRecord: estimateRecord ?? null,
    createdAt: Date.now(),
  };

  const adapter = await getPublicationStatusTransitionsAdapter();
  await adapter.add(record);
  return record;
}
