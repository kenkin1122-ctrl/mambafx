/**
 * research/src/discovery/phase11FunnelBridge.js
 *
 * Purpose:
 *   Phase C "Screening Extension" / "Triage Extension" — the composition
 *   point that lets discovery/funnel.js's Round 1/2 "understand"
 *   ConditionalHypothesis, CompositeCandidate, and MarketState objects
 *   while preserving the Winner's Curse firewall exactly as documented in
 *   funnel.js's own header (Round 1/2 never spend alpha; only Round 3 via
 *   discoveryDecision.js does).
 *
 * What this module IS: a thin orchestration layer that wires together
 *   already-built Phase 11 pieces — PromotionPolicy (which itself delegates
 *   Round 1's ranking arithmetic to funnel.runRoundOneScreening),
 *   FamilyRegistry (routing), NegativeEvidenceRegistry, and DecisionAuditLog
 *   — for a batch of Phase 11 Candidate objects. It introduces NO new
 *   statistical or governance logic of its own, matching funnel.js's own
 *   stated discipline ("a SEQUENCER, not a reimplementation").
 *
 * What this module is NOT: a replacement for legacy runRoundTwoValidation's
 *   real hypothesisRegistry registration + Knowledge Graph linking against
 *   a live governance DB. Wiring Phase 11 Candidate objects into THAT path
 *   (so a Phase 11 discovery can eventually reach Round 3/4 and a real
 *   Online-FDR wealth spend) is architecturally straightforward but
 *   requires the IndexedDB-backed governance stores to be live — deferred
 *   here and explicitly logged via recordFunnelIntegrationDebt() below,
 *   per constraint #32 (Scientific Debt Log: "track deferred improvements
 *   and assumptions").
 *
 * Dependencies: governance/PromotionPolicy.js, governance/FamilyRegistry.js,
 *   governance/ScientificDebtLog.js.
 * Public API: runPhase11Screening, runPhase11Triage, recordFunnelIntegrationDebt.
 * Complexity: O(n log n) for screening (delegates to PromotionPolicy/funnel's
 *   sort); O(n) for triage.
 */

import { DEBT_TYPE, DEBT_PRIORITY } from '../governance/ScientificDebtLog.js';
import { DECISION_TYPES } from '../governance/DecisionAuditLog.js';
import { REJECTION_STAGES } from '../governance/NegativeEvidenceRegistry.js';

/**
 * Round 1 for Phase 11 candidates: optionally checks FamilyRegistry
 * compatibility for every candidate BEFORE ranking (an incompatible
 * candidate is excluded from ranking entirely and recorded as a rejection —
 * ranking a candidate that could never be compatible would waste the
 * screening budget), then delegates to PromotionPolicy.evaluateScreening
 * for the actual cut. Never spends alpha.
 *
 * @param {object} params
 * @param {import('../candidate/Candidate.js').Candidate[]} params.candidates
 * @param {(candidate) => number} params.scoreFn
 * @param {import('../governance/PromotionPolicy.js').PromotionPolicy} params.promotionPolicy
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {number} [params.promotionQuantile]
 * @param {string} [params.dataset]
 * @returns {{ promoted: object[], rejected: object[], excludedIncompatible: object[] }}
 */
export function runPhase11Screening({
  candidates, scoreFn, promotionPolicy, familyRegistry = null,
  promotionQuantile, dataset = null,
} = {}) {
  let eligible = candidates;
  const excludedIncompatible = [];

  if (familyRegistry) {
    eligible = [];
    for (const candidate of candidates) {
      const { compatible, reasons } = familyRegistry.isCandidateCompatible(candidate);
      if (compatible) {
        eligible.push(candidate);
      } else {
        excludedIncompatible.push({ candidate, reasons });
        promotionPolicy.decisionAuditLog.append({
          candidateId: candidate.id,
          decisionType: DECISION_TYPES.SCREENED_REJECTED,
          reason: `Excluded before Round 1 ranking: family incompatibility (${reasons.join('; ')})`,
          actor: 'system',
        });
        promotionPolicy.negativeEvidenceRegistry.record({
          candidateFingerprint: candidate.fingerprint,
          stageRejected: REJECTION_STAGES.SCREENING,
          reason: `Family incompatibility: ${reasons.join('; ')}`,
          dataset,
          replicationStatus: 'not_attempted',
        });
      }
    }
  }

  if (eligible.length === 0) {
    return { promoted: [], rejected: [], excludedIncompatible };
  }

  const { promoted, rejected } = promotionPolicy.evaluateScreening({
    candidates: eligible, scoreFn, promotionQuantile, dataset,
  });
  return { promoted, rejected, excludedIncompatible };
}

/**
 * Round 2 for Phase 11 candidates: thin pass-through to
 * PromotionPolicy.evaluateTriage. Kept as a separate named entry point
 * (rather than inlining the call at every call site) so the Round 1/Round 2
 * boundary stays visible and independently testable, matching funnel.js's
 * own Round-by-Round structure.
 *
 * @param {object} params - See PromotionPolicy.evaluateTriage.
 * @param {import('../governance/PromotionPolicy.js').PromotionPolicy} params.promotionPolicy
 * @returns {{ promoted: object[], rejected: object[] }}
 */
export function runPhase11Triage({ promotionPolicy, ...rest }) {
  return promotionPolicy.evaluateTriage(rest);
}

/**
 * Records the deferred Round 2/3/4 hypothesisRegistry/IndexedDB integration
 * as an explicit, tracked scientific debt item rather than silently
 * pretending the integration is complete. Idempotent per debtId.
 *
 * @param {import('../governance/ScientificDebtLog.js').ScientificDebtLog} debtLog
 * @param {string} [debtId='phase11-funnel-db-integration']
 * @returns {import('../governance/ScientificDebtLog.js').ScientificDebtItem|null}
 *   The created item, or null if already recorded.
 */
export function recordFunnelIntegrationDebt(debtLog, debtId = 'phase11-funnel-db-integration') {
  try {
    return debtLog.create({
      id: debtId,
      type: DEBT_TYPE.IMPLEMENTATION_GAP,
      description:
        'Phase 11 Candidate objects (ConditionalHypothesis/CompositeCandidate/MarketState) are not yet ' +
        'wired into legacy runRoundTwoValidation\'s real hypothesisRegistry registration + Knowledge Graph ' +
        'linking against the live IndexedDB governance stores. Round 1/2 promotion for Phase 11 candidates ' +
        'currently runs entirely through PromotionPolicy (in-memory, SAP-threshold-gated). Wiring the ' +
        'remaining path to Round 3 (discoveryDecision.js/onlineFdr.js) so a Phase 11 discovery can spend ' +
        'real Online-FDR wealth is required before any Phase 11 candidate can be Confirmed.',
      priority: DEBT_PRIORITY.HIGH,
      assignedTo: null,
      metadata: { blocksPhase: 'Phase C → Round 3 integration' },
    });
  } catch {
    return null; // already recorded
  }
}
