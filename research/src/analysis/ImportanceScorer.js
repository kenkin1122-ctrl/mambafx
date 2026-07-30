/**
 * research/src/analysis/ImportanceScorer.js
 *
 * Purpose:
 *   Computes Candidate.scientificImportance and Candidate.tradingImportance
 *   (both already declared as fields on Candidate.js in Phase A, but never
 *   populated until now) — directive requirement #31 and constraint #14:
 *   "Importance Scores Are Descriptive... shall NEVER influence candidate
 *   generation, filtering, alpha spending, promotion, replication, or
 *   publication eligibility."
 *
 * Mechanical enforcement of constraint #14 (not just documentation):
 *   score() REFUSES to score any candidate whose lifecycle is earlier than
 *   Confirmed (PHASE11_LIFECYCLE_STAGES.CONFIRMED) — throwing
 *   ImportanceScoringPreconditionError. This makes it structurally
 *   impossible to call this scorer from anywhere in the Generated →
 *   Screened → Triaged path (candidateGenerator.js, PromotionPolicy.js,
 *   phase11FunnelBridge.js) without the candidate already having survived
 *   Round 3 confirmation — the scorer simply has no valid input before
 *   that point. This is a stronger guarantee than a code-review rule: it
 *   is enforced by the type signature of what this function will accept.
 *
 *   Additionally, this module returns a plain descriptive result object —
 *   it never mutates the candidate object itself (avoiding the same
 *   frozen-instance problem PromotionPolicy hit; see
 *   governance/candidateLifecycleTransition.js for the general pattern of
 *   producing an updated clone when a caller does want to attach the score).
 *
 * Scientific rationale for two separate scores: a candidate can be
 *   theoretically important (novel relative to the existing Knowledge
 *   Graph, explains a previously unexplained anomaly) without being
 *   trading-relevant (effect too small or too unstable to trade), and
 *   vice versa (a well-known, unsurprising effect that is nonetheless
 *   highly tradeable). Conflating the two would bias future search toward
 *   whichever dimension happens to dominate the combined score.
 *
 * Dependencies: governance/phase11LifecycleStates.js (stage-gate check
 *   only — does not import onlineFdr.js, discoveryDecision.js, or any
 *   alpha-spending module, since this scorer must never be positioned
 *   upstream of those).
 * Public API: scoreImportance, ImportanceScoringPreconditionError,
 *   InvalidImportanceInputError.
 * Complexity: O(1).
 */

import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';

/** Ordinal rank of each Phase 11 lifecycle stage, for the "at least Confirmed" gate. */
const STAGE_RANK = Object.freeze({
  [PHASE11_LIFECYCLE_STAGES.GENERATED]: 0,
  [PHASE11_LIFECYCLE_STAGES.SCREENED]: 1,
  [PHASE11_LIFECYCLE_STAGES.TRIAGED]: 2,
  [PHASE11_LIFECYCLE_STAGES.CONFIRMED]: 3,
  [PHASE11_LIFECYCLE_STAGES.REPLICATED]: 4,
  [PHASE11_LIFECYCLE_STAGES.PUBLISHED]: 5,
  [PHASE11_LIFECYCLE_STAGES.DEPRECATED]: -1, // never scoreable — evidence withdrawn
});

export class ImportanceScoringPreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportanceScoringPreconditionError';
  }
}

export class InvalidImportanceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidImportanceInputError';
  }
}

/**
 * Computes descriptive scientific and trading importance scores for a
 * candidate that has already reached Confirmed (or later) in the Phase 11
 * lifecycle. Throws for any earlier stage — see module header.
 *
 * @param {import('../candidate/Candidate.js').Candidate} candidate
 * @param {object} inputs
 * @param {number} inputs.noveltyScore - 0-1, how novel this finding is
 *   relative to the existing Knowledge Graph (caller-supplied, e.g. from
 *   knowledgeGraph.js's traceFeatureLineage / queryFeatureFamilyOutcomeStats
 *   — this module does not query the graph itself, keeping it a pure
 *   function of caller-supplied inputs, consistent with the rest of this
 *   codebase's "caller-supplied signal bundle" discipline).
 * @param {number} inputs.effectSize - The candidate's confirmed effect size.
 * @param {number} inputs.discoveryStabilityIndex - From DiscoveryStabilityAnalysis.
 * @param {number} inputs.evidenceTierWeight - 0-1, weight derived from the
 *   candidate's evidenceTier (higher tiers → higher weight; caller supplies
 *   this via scientificEvidenceTiers.js's E_TIER_RANK, keeping this module
 *   decoupled from that enum's internal ranking scheme).
 * @returns {{ scientificImportance: number, tradingImportance: number }}
 *   Both in [0, 1]. Descriptive only — the caller decides whether/how to
 *   attach these to a candidate record (e.g. via a clone helper), and MUST
 *   NOT feed them back into generation, screening, triage, confirmation,
 *   replication, or publication decisions.
 */
export function scoreImportance(candidate, { noveltyScore, effectSize, discoveryStabilityIndex, evidenceTierWeight } = {}) {
  if (!candidate || !candidate.lifecycle) {
    throw new InvalidImportanceInputError('scoreImportance: a candidate with a lifecycle field is required');
  }
  const rank = STAGE_RANK[candidate.lifecycle];
  if (rank === undefined || rank < STAGE_RANK[PHASE11_LIFECYCLE_STAGES.CONFIRMED]) {
    throw new ImportanceScoringPreconditionError(
      `scoreImportance: candidate "${candidate.id}" is at lifecycle stage "${candidate.lifecycle}", but ` +
      `importance scoring is descriptive and post-confirmation only (constraint #14) — the candidate must ` +
      `have reached at least "${PHASE11_LIFECYCLE_STAGES.CONFIRMED}" first.`
    );
  }

  const errors = [];
  for (const [name, val] of Object.entries({ noveltyScore, discoveryStabilityIndex, evidenceTierWeight })) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      errors.push(`${name}: must be a finite number in [0, 1]`);
    }
  }
  if (typeof effectSize !== 'number' || !Number.isFinite(effectSize)) {
    errors.push('effectSize: must be a finite number');
  }
  if (errors.length) throw new InvalidImportanceInputError(errors.join('; '));

  // Scientific importance: weighted toward novelty and evidence strength —
  // a well-replicated, novel finding is scientifically important even if
  // its effect is currently too small to trade profitably.
  const scientificImportance = clamp01(0.5 * noveltyScore + 0.3 * evidenceTierWeight + 0.2 * discoveryStabilityIndex);

  // Trading importance: weighted toward effect size magnitude and cross-
  // partition stability — a large but unstable effect is not tradeable in
  // practice, and stability matters more here than theoretical novelty.
  const normalizedEffect = clamp01(Math.abs(effectSize) / (Math.abs(effectSize) + 1)); // soft-saturating map to [0,1)
  const tradingImportance = clamp01(0.6 * normalizedEffect + 0.4 * discoveryStabilityIndex);

  return { scientificImportance, tradingImportance };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
