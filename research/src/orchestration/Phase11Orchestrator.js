/**
 * research/src/orchestration/Phase11Orchestrator.js
 *
 * Purpose:
 *   Single top-level entry point that runs the Phase 11 pipeline currently
 *   available end-to-end: Generation (candidateGenerator.js) → Round 1
 *   Screening → Round 2 Triage (both via phase11FunnelBridge.js /
 *   PromotionPolicy.js). This is the "Phase11Orchestrator" component named
 *   in the directive's Phase D file structure.
 *
 * Honest scope boundary (matches phase11FunnelBridge.js's own documented
 *   debt item): this orchestrator stops after Round 2 (Triaged). It does
 *   NOT advance candidates to Confirmed/Replicated/Published — that
 *   requires the still-deferred integration with legacy
 *   runRoundTwoValidation's real hypothesisRegistry + Knowledge Graph +
 *   IndexedDB wiring (recordFunnelIntegrationDebt(), already logged). A
 *   caller asking this orchestrator to run past Round 2 gets an explicit
 *   NotYetIntegratedError rather than a silently-incomplete result — this
 *   codebase's established discipline (matches ConfigValidator/
 *   CausalLeakageValidator's "never silently pass" pattern) applied to
 *   pipeline-stage completeness rather than field validation.
 *
 * Composition, not reimplementation: every step below delegates to an
 *   already-built, already-tested module. This file contains no new
 *   statistical or governance logic of its own.
 *
 * Dependencies: discovery/candidateGenerator.js, discovery/phase11FunnelBridge.js,
 *   governance/PromotionPolicy.js, governance/DecisionAuditLog.js,
 *   governance/NegativeEvidenceRegistry.js, governance/ScientificDebtLog.js.
 * Public API: Phase11Orchestrator, NotYetIntegratedError.
 * Complexity: dominated by the underlying generation/screening/triage
 *   calls; see those modules for their individual complexity.
 */

import { generateCandidate } from '../discovery/candidateGenerator.js';
import {
  runPhase11Screening,
  runPhase11Triage,
  recordFunnelIntegrationDebt,
} from '../discovery/phase11FunnelBridge.js';
import { PromotionPolicy } from '../governance/PromotionPolicy.js';
import { DecisionAuditLog } from '../governance/DecisionAuditLog.js';
import { NegativeEvidenceRegistry } from '../governance/NegativeEvidenceRegistry.js';

export class NotYetIntegratedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotYetIntegratedError';
  }
}

export class Phase11Orchestrator {
  /**
   * @param {object} params
   * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
   * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
   * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
   * @param {import('../governance/ScientificDebtLog.js').ScientificDebtLog} [params.debtLog]
   *   Optional; if supplied, the deferred Round 3+ integration debt is
   *   recorded (idempotently) the first time this orchestrator runs.
   * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
   * @param {import('../governance/NegativeEvidenceRegistry.js').NegativeEvidenceRegistry} [params.negativeEvidenceRegistry]
   */
  constructor({
    researchFreeze,
    sap,
    familyRegistry = null,
    debtLog = null,
    decisionAuditLog = new DecisionAuditLog(),
    negativeEvidenceRegistry = new NegativeEvidenceRegistry(),
  } = {}) {
    if (!researchFreeze || !researchFreeze.id) {
      throw new NotYetIntegratedError('Phase11Orchestrator: a valid ResearchFreeze is required (constraint #12)');
    }
    if (!sap || !sap.sapId) {
      throw new NotYetIntegratedError('Phase11Orchestrator: a valid StatisticalAnalysisPlan is required (constraint #13)');
    }
    this.researchFreeze = researchFreeze;
    this.sap = sap;
    this.familyRegistry = familyRegistry;
    this.decisionAuditLog = decisionAuditLog;
    this.negativeEvidenceRegistry = negativeEvidenceRegistry;
    this.promotionPolicy = new PromotionPolicy(sap, decisionAuditLog, negativeEvidenceRegistry);

    if (debtLog) {
      recordFunnelIntegrationDebt(debtLog);
    }
  }

  /**
   * Generates a batch of candidates under this orchestrator's active
   * ResearchFreeze/SAP/FamilyRegistry.
   *
   * @param {object} params
   * @param {string} params.candidateType - One of CANDIDATE_TYPES.
   * @param {object[]} params.candidateParamsList - One candidateParams object per candidate.
   * @param {import('../candidate/MeasurementRegistry.js').MeasurementRegistry} [params.measurementRegistry]
   * @returns {Promise<{ candidate: object, provenance: object }[]>}
   */
  async generate({ candidateType, candidateParamsList, measurementRegistry = null }) {
    const results = [];
    for (const candidateParams of candidateParamsList) {
      results.push(await generateCandidate({
        candidateType,
        candidateParams,
        researchFreeze: this.researchFreeze,
        sap: this.sap,
        familyRegistry: this.familyRegistry,
        decisionAuditLog: this.decisionAuditLog,
        measurementRegistry,
      }));
    }
    return results;
  }

  /**
   * Runs Round 1 screening over a batch of candidates.
   * @see phase11FunnelBridge.runPhase11Screening
   */
  screen({ candidates, scoreFn, promotionQuantile, dataset }) {
    return runPhase11Screening({
      candidates, scoreFn, promotionPolicy: this.promotionPolicy,
      familyRegistry: this.familyRegistry, promotionQuantile, dataset,
    });
  }

  /**
   * Runs Round 2 triage over a batch of Screened candidates.
   * @see phase11FunnelBridge.runPhase11Triage
   */
  triage({ candidates, diagnosticsByCandidateId, dataset }) {
    return runPhase11Triage({
      promotionPolicy: this.promotionPolicy, candidates, diagnosticsByCandidateId, dataset,
    });
  }

  /**
   * Explicitly unsupported: Round 3 confirmation and beyond require the
   * still-deferred hypothesisRegistry/IndexedDB integration. Always throws.
   * Exists so a caller mistakenly expecting this orchestrator to reach
   * Confirmed/Published gets a clear, actionable error rather than
   * silently stopping.
   */
  confirm() {
    throw new NotYetIntegratedError(
      'Phase11Orchestrator.confirm: Round 3 confirmation requires the deferred integration with legacy ' +
      'runRoundTwoValidation\'s hypothesisRegistry + Knowledge Graph + IndexedDB path (see the ' +
      '"phase11-funnel-db-integration" ScientificDebtLog item). Not yet available.'
    );
  }
}
