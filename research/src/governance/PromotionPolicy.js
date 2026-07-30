/**
 * research/src/governance/PromotionPolicy.js
 *
 * Purpose:
 *   Determines Phase 11 candidate promotion through
 *     Generated → Screened → Triaged
 *   WITHOUT spending any statistical error budget — directive's
 *   "Promotion Policy" component spec. Confirmation (Triaged → Confirmed)
 *   and beyond remain exclusively discoveryDecision.js's job, reached only
 *   through the legacy funnel (discovery/funnel.js Round 3), which is the
 *   ONLY code path permitted to call onlineFdr.recordTestAndUpdateWealth.
 *   This module never imports onlineFdr.js.
 *
 * Round 1 (Screening → cheap ranking only):
 *   Delegates the actual ranking/quantile-cut arithmetic to the existing,
 *   already-tested discovery/funnel.js `runRoundOneScreening` — this module
 *   does not reimplement that logic (per "Extend — Never Replace"). It adds
 *   the Phase 11-specific wiring on top: transitioning each candidate's
 *   `lifecycle` field (phase11LifecycleStates.js, NOT hypothesisRegistry's
 *   parallel machine), writing DecisionAuditLog entries, and archiving
 *   non-promoted candidates into NegativeEvidenceRegistry.
 *
 * Round 2 (Triage → pre-committed threshold gate only):
 *   Legacy `runRoundTwoValidation` performs real hypothesisRegistry
 *   registration and Knowledge Graph linking against a live governance DB —
 *   integrating Phase 11 Candidate objects with that path is a deferred
 *   wiring concern (recorded in ScientificDebtLog; see
 *   discovery/phase11FunnelBridge.js). Round 2 here instead applies the
 *   SAP's own pre-committed, immutable stoppingRules /
 *   effectSizeThresholds / requiredDiagnostics (constraint #13: no
 *   candidate may be generated or promoted outside its SAP) to decide
 *   Screened → Triaged. This spends no alpha and reimplements no
 *   statistical test — it only checks pre-committed thresholds against
 *   caller-supplied, already-computed diagnostics.
 *
 * Dependencies: discovery/funnel.js (runRoundOneScreening, read-only reuse),
 *   governance/phase11LifecycleStates.js, governance/DecisionAuditLog.js,
 *   governance/NegativeEvidenceRegistry.js.
 * Public API: PromotionPolicy, InvalidPromotionInputError.
 * Complexity: evaluateScreening O(n log n) (delegates to funnel's sort);
 *   evaluateTriage O(1) per candidate.
 */

import { runRoundOneScreening } from '../discovery/funnel.js';
import {
  PHASE11_LIFECYCLE_STAGES,
} from './phase11LifecycleStates.js';
import { withPhase11Lifecycle } from './candidateLifecycleTransition.js';
import { DECISION_TYPES } from './DecisionAuditLog.js';
import { REJECTION_STAGES } from './NegativeEvidenceRegistry.js';

export class InvalidPromotionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPromotionInputError';
  }
}

export class PromotionPolicy {
  /**
   * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} sap
   *   Immutable SAP whose promotionPolicies/effectSizeThresholds/
   *   requiredDiagnostics govern this policy's decisions. Required —
   *   constraint #13, no promotion outside a locked SAP.
   * @param {import('./DecisionAuditLog.js').DecisionAuditLog} decisionAuditLog
   * @param {import('./NegativeEvidenceRegistry.js').NegativeEvidenceRegistry} negativeEvidenceRegistry
   */
  constructor(sap, decisionAuditLog, negativeEvidenceRegistry) {
    if (!sap || !sap.sapId) {
      throw new InvalidPromotionInputError('PromotionPolicy: a valid, locked StatisticalAnalysisPlan (sap) is required');
    }
    if (!decisionAuditLog || typeof decisionAuditLog.append !== 'function') {
      throw new InvalidPromotionInputError('PromotionPolicy: a DecisionAuditLog instance is required');
    }
    if (!negativeEvidenceRegistry || typeof negativeEvidenceRegistry.record !== 'function') {
      throw new InvalidPromotionInputError('PromotionPolicy: a NegativeEvidenceRegistry instance is required');
    }
    this.sap = sap;
    this.decisionAuditLog = decisionAuditLog;
    this.negativeEvidenceRegistry = negativeEvidenceRegistry;
  }

  /**
   * Round 1 — Screening. Ranks candidates via the existing funnel's cheap
   * scoreFn cut, then updates each candidate's phase11 lifecycle field and
   * writes audit/negative-evidence records for the outcome. Never spends
   * alpha; never registers a hypothesis.
   *
   * @param {object} params
   * @param {import('../candidate/Candidate.js').Candidate[]} params.candidates
   * @param {(candidate) => number} params.scoreFn - Caller-supplied cheap statistic.
   * @param {number} [params.promotionQuantile] - Defaults to SAP's stoppingRules
   *   value if present, else 0.001 (funnel.js's own default).
   * @param {string} [params.dataset] - Dataset identifier, for negative-evidence records.
   * @returns {{ promoted: import('../candidate/Candidate.js').Candidate[], rejected: import('../candidate/Candidate.js').Candidate[] }}
   */
  evaluateScreening({ candidates, scoreFn, promotionQuantile, dataset = null } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new InvalidPromotionInputError('evaluateScreening: "candidates" must be a non-empty array');
    }
    const quantile = promotionQuantile ?? this.sap.stoppingRules?.screeningPromotionQuantile ?? 0.001;

    const { promoted: promotedOriginals } = runRoundOneScreening({ candidates, scoreFn, promotionQuantile: quantile });
    const promotedIds = new Set(promotedOriginals.map(c => c.id));
    const rejected = candidates.filter(c => !promotedIds.has(c.id));

    const promoted = promotedOriginals.map(candidate => {
      const advanced = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.SCREENED);
      this.decisionAuditLog.append({
        candidateId: advanced.id,
        decisionType: DECISION_TYPES.SCREENED_PROMOTED,
        reason: `Round 1 screening: promoted under quantile ${quantile} against SAP ${this.sap.sapId}`,
        actor: 'system',
        metadata: { sapId: this.sap.sapId, promotionQuantile: quantile },
      });
      return advanced;
    });
    for (const candidate of rejected) {
      this.decisionAuditLog.append({
        candidateId: candidate.id,
        decisionType: DECISION_TYPES.SCREENED_REJECTED,
        reason: `Round 1 screening: did not survive quantile ${quantile} cut against SAP ${this.sap.sapId}`,
        actor: 'system',
        metadata: { sapId: this.sap.sapId, promotionQuantile: quantile },
      });
      this.negativeEvidenceRegistry.record({
        candidateFingerprint: candidate.fingerprint,
        stageRejected: REJECTION_STAGES.SCREENING,
        reason: `Did not survive Round 1 screening quantile cut (${quantile})`,
        dataset,
        replicationStatus: 'not_attempted',
      });
    }

    return { promoted, rejected };
  }

  /**
   * Round 2 — Triage. Applies the SAP's pre-committed effect-size threshold
   * and required diagnostics to each Screened candidate's already-computed
   * diagnostics (caller-supplied — this method computes no statistics
   * itself). Never spends alpha; this is a threshold gate, not a
   * significance test.
   *
   * @param {object} params
   * @param {import('../candidate/Candidate.js').Candidate[]} params.candidates - Must be Screened.
   * @param {Object.<string, {effectSize: number, diagnosticsPassed: string[]}>} params.diagnosticsByCandidateId
   *   Caller-supplied diagnostic results keyed by candidate.id.
   * @param {string} [params.dataset]
   * @returns {{ promoted: import('../candidate/Candidate.js').Candidate[], rejected: import('../candidate/Candidate.js').Candidate[] }}
   */
  evaluateTriage({ candidates, diagnosticsByCandidateId, dataset = null } = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new InvalidPromotionInputError('evaluateTriage: "candidates" must be a non-empty array');
    }
    if (!diagnosticsByCandidateId || typeof diagnosticsByCandidateId !== 'object') {
      throw new InvalidPromotionInputError('evaluateTriage: "diagnosticsByCandidateId" is required');
    }

    const minEffectSize = this.sap.effectSizeThresholds?.default ?? 0;
    const requiredDiagnostics = this.sap.requiredDiagnostics ?? [];

    const promoted = [];
    const rejected = [];

    for (const candidate of candidates) {
      if (candidate.lifecycle !== PHASE11_LIFECYCLE_STAGES.SCREENED) {
        throw new InvalidPromotionInputError(
          `evaluateTriage: candidate "${candidate.id}" is not in Screened stage (currently "${candidate.lifecycle}")`
        );
      }
      const diag = diagnosticsByCandidateId[candidate.id];
      const effectSize = diag?.effectSize ?? -Infinity;
      const diagnosticsPassed = new Set(diag?.diagnosticsPassed ?? []);
      const missingDiagnostics = requiredDiagnostics.filter(d => !diagnosticsPassed.has(d));

      const passes = effectSize >= minEffectSize && missingDiagnostics.length === 0;

      if (passes) {
        const advanced = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.TRIAGED);
        this.decisionAuditLog.append({
          candidateId: advanced.id,
          decisionType: DECISION_TYPES.TRIAGED_PROMOTED,
          reason: `Round 2 triage: effectSize ${effectSize} >= threshold ${minEffectSize}; all required diagnostics passed`,
          actor: 'system',
          metadata: { sapId: this.sap.sapId, effectSize, requiredDiagnostics },
        });
        promoted.push(advanced);
      } else {
        const reasonParts = [];
        if (effectSize < minEffectSize) reasonParts.push(`effectSize ${effectSize} < threshold ${minEffectSize}`);
        if (missingDiagnostics.length) reasonParts.push(`missing diagnostics: ${missingDiagnostics.join(', ')}`);
        const reason = `Round 2 triage: ${reasonParts.join('; ')}`;
        this.decisionAuditLog.append({
          candidateId: candidate.id,
          decisionType: DECISION_TYPES.TRIAGED_REJECTED,
          reason,
          actor: 'system',
          metadata: { sapId: this.sap.sapId, effectSize, missingDiagnostics },
        });
        this.negativeEvidenceRegistry.record({
          candidateFingerprint: candidate.fingerprint,
          stageRejected: REJECTION_STAGES.TRIAGE,
          reason,
          dataset,
          effectSize: effectSize === -Infinity ? null : effectSize,
          replicationStatus: 'not_attempted',
        });
        rejected.push(candidate);
      }
    }

    return { promoted, rejected };
  }
}
