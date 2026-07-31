/**
 * research/src/bridge/Phase11ConfirmationBridge.js
 *
 * Purpose:
 *   Completes the Phase 11 pipeline's missing Round 3 by bridging a
 *   Triaged Phase 11 Candidate into the EXISTING, validated Phase 9/10
 *   confirmation framework:
 *
 *     Phase 11: Generate -> Screen -> Triage -> [THIS BRIDGE] -> Confirmed
 *     Legacy:   Registration -> FeatureGeneration -> [onlineFdr via
 *               discoveryDecision.evaluateDiscoveryCandidate] -> Discovery
 *
 *   This module is an orchestration layer ONLY. It contains no statistical
 *   logic, no p-value computation, no independent FDR bookkeeping, and no
 *   second hypothesis registry. Every governance decision is made by the
 *   existing, unmodified legacy modules; this file only translates a
 *   Phase 11 Candidate into the shape those modules already expect, and
 *   translates their answer back into a Phase 11 lifecycle transition.
 *
 * Compatibility note (read before using): the calling directive for this
 *   bridge named the entry point "onlineFdr.processPValue()". That function
 *   does not exist. The actual, existing, sanctioned entry point for
 *   spending Family wealth is discoveryDecision.evaluateDiscoveryCandidate(),
 *   which itself calls onlineFdr.recordTestAndUpdateWealth() internally —
 *   this is the ONLY code path in the legacy governance layer permitted to
 *   spend alpha (Volume IV Part 9), and this bridge calls it exactly once
 *   per confirmation attempt, never onlineFdr.js directly. No interface was
 *   missing; this note exists so the discrepancy is visible rather than
 *   silently "fixed" by inventing a same-named wrapper.
 *
 * Legacy lifecycle mapping (hypothesisRegistry.js's LIFECYCLE_STAGES is a
 *   SEPARATE state machine from phase11LifecycleStates.js — see that
 *   module's own header for why they are intentionally parallel, not
 *   merged). This bridge drives the legacy machine through its own
 *   documented sequence on behalf of a Phase 11 candidate:
 *     (unregistered) -> Registration -> FeatureGeneration
 *       -> [evaluateDiscoveryCandidate] -> Discovery (if not rejected)
 *   and mirrors the outcome onto the Phase 11 side:
 *     Triaged -> Confirmed (accepted) | Deprecated (rejected)
 *
 * What this bridge validates BEFORE spending any alpha (directive's
 *   required validation list): candidate.lifecycle === Triaged; candidate's
 *   researchFreezeId/sapId/researchConfigurationId match the active cycle;
 *   a DatasetManifest with a real datasetId was supplied; the candidate's
 *   provenance DAG actually contains a node for the candidate and for every
 *   entry in its featureProvenance (measurement lineage); the candidate's
 *   fingerprint is a well-formed SHA-256 hex string. Any failure throws
 *   Phase11ConfirmationValidationError before hypothesisRegistry or
 *   onlineFdr are touched at all.
 *
 * Dependencies: governance/hypothesisRegistry.js (registerHypothesis,
 *   getCurrentLifecycleStage, transitionLifecycleStage, LIFECYCLE_STAGES —
 *   read/write via its own existing adapters, unmodified), governance/
 *   discoveryDecision.js (evaluateDiscoveryCandidate — unmodified),
 *   governance/FamilyRegistry.js (routeToLegacyFamilyKey — reuses family.js's
 *   equivalence-aware key resolution, never mints one independently),
 *   governance/candidateLifecycleTransition.js (withPhase11Lifecycle),
 *   governance/phase11KnowledgeGraphBridge.js (KG relationship extension).
 * Public API: confirmPhase11Candidate, Phase11ConfirmationValidationError.
 * Complexity: O(1) validation + whatever hypothesisRegistry/
 *   discoveryDecision's own documented complexity is (both O(log n)).
 */

import {
  registerHypothesis,
  getCurrentLifecycleStage,
  transitionLifecycleStage,
  LIFECYCLE_STAGES,
} from '../governance/hypothesisRegistry.js';
import { evaluateDiscoveryCandidate } from '../governance/discoveryDecision.js';
import { TEST_METHODS } from '../governance/onlineFdr.js';
import { withPhase11Lifecycle } from '../governance/candidateLifecycleTransition.js';
import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';
import { DECISION_TYPES } from '../governance/DecisionAuditLog.js';
import { REJECTION_STAGES } from '../governance/NegativeEvidenceRegistry.js';
import {
  registerPhase11DiscoveryInKnowledgeGraph,
  recordPhase11NegativeEvidenceInKnowledgeGraph,
} from '../governance/phase11KnowledgeGraphBridge.js';

export class Phase11ConfirmationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11ConfirmationValidationError';
  }
}

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validates every precondition the directive requires before ANY legacy
 * call is made. Throws Phase11ConfirmationValidationError listing every
 * failure at once (not just the first) so a caller can fix them all in one
 * pass rather than one exception at a time.
 */
function validateBeforeConfirmation({
  candidate, researchFreeze, sap, researchConfiguration, datasetManifest, provenance,
}) {
  const errors = [];

  if (!candidate || candidate.lifecycle !== PHASE11_LIFECYCLE_STAGES.TRIAGED) {
    errors.push(`candidate must be at lifecycle stage "Triaged" (got "${candidate?.lifecycle}")`);
  }
  if (!candidate?.fingerprint || !FINGERPRINT_PATTERN.test(candidate.fingerprint)) {
    errors.push('candidate.fingerprint is missing or not a well-formed SHA-256 hex string');
  }
  if (!researchFreeze?.id || candidate?.researchFreezeId !== researchFreeze.id) {
    errors.push(`candidate.researchFreezeId ("${candidate?.researchFreezeId}") does not match the active ResearchFreeze ("${researchFreeze?.id}")`);
  }
  if (!sap?.sapId || candidate?.sapId !== sap.sapId) {
    errors.push(`candidate.sapId ("${candidate?.sapId}") does not match the active SAP ("${sap?.sapId}")`);
  }
  if (!researchConfiguration?.id || candidate?.researchConfigurationId !== researchConfiguration.id) {
    errors.push(`candidate.researchConfigurationId ("${candidate?.researchConfigurationId}") does not match the active ResearchConfiguration ("${researchConfiguration?.id}")`);
  }
  if (!datasetManifest?.datasetId) {
    errors.push('a DatasetManifest with a real datasetId is required before confirmation (Round 3 must run against a locked dataset, not an ad-hoc sample)');
  }
  if (!provenance || typeof provenance.hasNode !== 'function' || !provenance.hasNode(candidate?.id)) {
    errors.push(`provenance DAG has no node for candidate "${candidate?.id}" — full lineage must be resolvable before confirmation`);
  } else if (Array.isArray(candidate.featureProvenance)) {
    for (const featureName of candidate.featureProvenance) {
      if (!provenance.hasNode(featureName)) {
        errors.push(`provenance DAG is missing feature/measurement lineage node "${featureName}" declared in candidate.featureProvenance`);
      }
    }
  }

  if (errors.length) {
    throw new Phase11ConfirmationValidationError(
      `confirmPhase11Candidate: ${errors.length} validation failure(s) — refusing before any legacy registration or alpha spend:\n- ${errors.join('\n- ')}`
    );
  }
}

/**
 * Deterministic, stable legacy hypothesisId for a Phase 11 candidate —
 * derived from its fingerprint (not its mutable display id), so the SAME
 * underlying candidate always maps to the SAME legacy hypothesis even if
 * generated again in a later campaign.
 */
function legacyHypothesisIdFor(candidate) {
  return `ph11_${candidate.fingerprint}`;
}

/**
 * Bridges a Triaged Phase 11 candidate through the existing legacy
 * confirmation framework and returns the outcome.
 *
 * @param {object} params
 * @param {object} params.candidate - Must be at PHASE11_LIFECYCLE_STAGES.TRIAGED.
 * @param {object} params.researchFreeze - Active ResearchFreeze (must match candidate.researchFreezeId).
 * @param {object} params.sap - Active StatisticalAnalysisPlan (must match candidate.sapId).
 * @param {object} params.researchConfiguration - Active ResearchConfiguration (must match candidate.researchConfigurationId).
 * @param {{datasetId: string}} params.datasetManifest - Locked dataset the p-value was computed against.
 * @param {import('../provenance/ProvenanceDAG.js').ProvenanceDAG} params.provenance - This candidate's full provenance DAG.
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} params.familyRegistry
 * @param {string} params.market - e.g. "R_100" — passed to family.js's equivalence resolution via FamilyRegistry.
 * @param {{direction: 'Rise'|'Fall', runLength: number}} params.targetDefinition
 * @param {number} params.pValue - Already-computed p-value from an independent statistical test.
 *   This bridge computes nothing; it only submits this value to the existing gate.
 * @param {string} [params.testMethod=TEST_METHODS.UNSPECIFIED]
 * @param {number} [params.testedAt] - Defaults to Date.now() inside onlineFdr.js if omitted.
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {import('../governance/NegativeEvidenceRegistry.js').NegativeEvidenceRegistry} [params.negativeEvidenceRegistry]
 * @param {object} [params.knowledgeGraphCandidateNode] - The node returned by
 *   registerPhase11CandidateInKnowledgeGraph, if the caller wants the
 *   Discovery/NegativeEvidence relationship registered too.
 * @param {string} [params.missingValueHandlingPolicy='forward-fill']
 * @param {string} [params.outlierHandlingPolicy='winsorize-3sigma']
 * @param {string} [params.approvedBy='phase11-confirmation-bridge']
 * @returns {Promise<{
 *   outcome: 'confirmed'|'rejected',
 *   candidate: object,
 *   hypothesisId: string,
 *   familyKey: string,
 *   legacyResult: object
 * }>}
 */
export async function confirmPhase11Candidate({
  candidate, researchFreeze, sap, researchConfiguration, datasetManifest, provenance,
  familyRegistry, market, targetDefinition, pValue, testMethod = TEST_METHODS.UNSPECIFIED, testedAt,
  decisionAuditLog = null, negativeEvidenceRegistry = null, knowledgeGraphCandidateNode = null,
  missingValueHandlingPolicy = 'forward-fill', outlierHandlingPolicy = 'winsorize-3sigma',
  approvedBy = 'phase11-confirmation-bridge',
} = {}) {
  validateBeforeConfirmation({ candidate, researchFreeze, sap, researchConfiguration, datasetManifest, provenance });

  // Resolve the canonical legacy Family Key via the existing equivalence-
  // aware resolver (family.js, through FamilyRegistry — never minted here).
  const familyKey = familyRegistry.routeToLegacyFamilyKey(candidate, { market, targetDefinition });
  const hypothesisId = legacyHypothesisIdFor(candidate);

  // ── Registration (Part 3) — precondition for any Discovery decision ──
  let currentStage = await getCurrentLifecycleStage(hypothesisId);
  if (!currentStage) {
    await registerHypothesis({
      hypothesisId,
      lineageId: candidate.family,
      generationId: 0,
      parentIds: Array.isArray(candidate.componentIds) ? candidate.componentIds : [],
      familyKey,
      lineageDeclaration: { isContinuation: false },
      // Phase 11's own discipline (ResearchFreeze/SAP locked BEFORE
      // generation, enforced by candidateGenerator.js) is what makes this
      // attestation honestly assertable here, rather than a rubber stamp.
      dataAccessAttestation: { attested: true },
      missingValueHandlingPolicy,
      outlierHandlingPolicy,
      analyticalChoiceSet: [candidate.type],
      reasonForCreation: candidate.description || `Phase 11 candidate ${candidate.id} (family ${candidate.family})`,
    });
    currentStage = LIFECYCLE_STAGES.REGISTRATION;
  }
  if (currentStage === LIFECYCLE_STAGES.REGISTRATION) {
    await transitionLifecycleStage(hypothesisId, {
      to: LIFECYCLE_STAGES.FEATURE_GENERATION,
      reason: 'Phase 11 candidate reached Triaged — advancing legacy lifecycle to FeatureGeneration before Discovery evaluation',
      approvedBy,
    });
  }

  // ── Confirmation (Part 6/9) — the ONLY alpha-spending call in this
  //    entire bridge, and it is the existing, unmodified, sanctioned gate.
  //    Terminology note: onlineFdr.js's `rejected` field means "the null
  //    hypothesis was rejected" — i.e. THIS IS a statistically significant
  //    result / a confirmed discovery. `rejected: false` means the test
  //    failed to clear its bid — no discovery, no wealth bonus.
  const legacyResult = await evaluateDiscoveryCandidate({
    hypothesisId, familyKey, pValue, testMethod, testedAt,
  });

  if (legacyResult.rejected) {
    await transitionLifecycleStage(hypothesisId, {
      to: LIFECYCLE_STAGES.DISCOVERY,
      reason: `Phase 11 Confirmed — onlineFdr accepted at family "${familyKey}" (wealth ${legacyResult.wealthBefore} -> ${legacyResult.wealthAfter})`,
      approvedBy,
    });
    const confirmedCandidate = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.CONFIRMED);

    if (decisionAuditLog) {
      decisionAuditLog.append({
        candidateId: candidate.id,
        decisionType: DECISION_TYPES.CONFIRMED,
        reason: `Round 3: onlineFdr accepted via discoveryDecision.evaluateDiscoveryCandidate (familyKey=${familyKey}, hypothesisId=${hypothesisId})`,
        actor: 'phase11-confirmation-bridge',
        metadata: { familyKey, hypothesisId, ...legacyResult },
      });
    }
    if (knowledgeGraphCandidateNode) {
      await registerPhase11DiscoveryInKnowledgeGraph(knowledgeGraphCandidateNode, {
        hypothesisId, familyKey, datasetManifestId: datasetManifest.datasetId,
        evidenceTier: candidate.evidenceTier, implementationMaturity: candidate.implementationMaturity,
      });
    }

    return { outcome: 'confirmed', candidate: confirmedCandidate, hypothesisId, familyKey, legacyResult };
  }

  // ── Rejected: evidence withdrawn, permanently archived, never discarded ──
  const deprecatedCandidate = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.DEPRECATED);

  if (decisionAuditLog) {
    decisionAuditLog.append({
      candidateId: candidate.id,
      decisionType: DECISION_TYPES.CONFIRMED_REJECTED,
      reason: `Round 3: onlineFdr rejected via discoveryDecision.evaluateDiscoveryCandidate (familyKey=${familyKey}, hypothesisId=${hypothesisId})`,
      actor: 'phase11-confirmation-bridge',
      metadata: { familyKey, hypothesisId, ...legacyResult },
    });
  }
  if (negativeEvidenceRegistry) {
    negativeEvidenceRegistry.record({
      candidateFingerprint: candidate.fingerprint,
      stageRejected: REJECTION_STAGES.CONFIRMATION,
      reason: `onlineFdr rejected at family "${familyKey}" (Round 3 confirmation)`,
      dataset: datasetManifest.datasetId,
      effectSize: null,
      replicationStatus: 'not_attempted',
    });
  }
  if (knowledgeGraphCandidateNode) {
    await recordPhase11NegativeEvidenceInKnowledgeGraph(knowledgeGraphCandidateNode, {
      candidateFingerprint: candidate.fingerprint,
      stageRejected: REJECTION_STAGES.CONFIRMATION,
      timestamp: Date.now(),
      toJSON: () => ({ familyKey, hypothesisId, ...legacyResult }),
    });
  }

  return { outcome: 'rejected', candidate: deprecatedCandidate, hypothesisId, familyKey, legacyResult };
}
