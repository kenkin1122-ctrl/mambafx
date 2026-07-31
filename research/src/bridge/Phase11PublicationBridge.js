/**
 * research/src/bridge/Phase11PublicationBridge.js
 *
 * Purpose:
 *   Bridges a Replicated Phase 11 candidate into the existing legacy
 *   Publication lifecycle stage — the final transition this pipeline
 *   needs:
 *
 *     Phase 11: Replicated -> [THIS BRIDGE] -> Published
 *     Legacy:   Lockbox -> Publication
 *
 *   All eligibility logic this bridge needs already exists and is already
 *   tested (Phase D): Phase11Orchestrator.checkPublicationEligibility()
 *   composes the existing ReproducibilityGate (config/ontology/generator/
 *   proxy-version/fingerprint matching) with the freeze-id/SAP-id/dataset-
 *   manifest/context-version checks the base gate doesn't itself cover.
 *   This bridge does not reimplement any of that — it calls it once, and
 *   only drives the legacy/Phase 11 lifecycle transitions if it passes.
 *
 * Legacy lifecycle: Lockbox -> Publication is hypothesisRegistry.js's own
 *   final forward transition before Retirement/Archive — driven here via
 *   the existing, unmodified transitionLifecycleStage(). No new legacy
 *   storage, no new alpha spend (publication is a documentation/promotion
 *   step, not a statistical test).
 *
 * A failed eligibility check does NOT deprecate the candidate — an
 *   ineligible-for-publication result (e.g. a stale context version) is an
 *   administrative gap, not a scientific rejection of the finding; the
 *   candidate remains Replicated and may be retried once the gate issue is
 *   resolved. This mirrors the same reasoning phase11FunnelBridge.js
 *   already uses for family-incompatible candidates at screening time.
 *
 * Dependencies: hypothesisRegistry.js (transitionLifecycleStage,
 *   LIFECYCLE_STAGES — unmodified), candidateLifecycleTransition.js
 *   (withPhase11Lifecycle), phase11KnowledgeGraphBridge.js
 *   (registerPhase11PublicationInKnowledgeGraph — built in Stage 1 as
 *   groundwork for exactly this).
 * Public API: publishPhase11Candidate, Phase11PublicationValidationError.
 * Complexity: O(1) + whatever checkPublicationEligibility's own documented
 *   complexity is (delegated, not duplicated).
 */

import { transitionLifecycleStage, LIFECYCLE_STAGES } from '../governance/hypothesisRegistry.js';
import { withPhase11Lifecycle } from '../governance/candidateLifecycleTransition.js';
import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';
import { DECISION_TYPES } from '../governance/DecisionAuditLog.js';
import { registerPhase11PublicationInKnowledgeGraph } from '../governance/phase11KnowledgeGraphBridge.js';
import { getNode } from '../governance/knowledgeGraph.js';
import { PHASE11_NODE_TYPES } from '../governance/phase11KnowledgeGraphBridge.js';

export class Phase11PublicationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11PublicationValidationError';
  }
}

/**
 * Best-effort lookup of the previously-registered Discovery Knowledge
 * Graph node for this hypothesis, via knowledgeGraph.js's own read API —
 * never a direct storage read. Returns null if unavailable rather than
 * failing the whole publication (Knowledge Graph enrichment is additive,
 * not a scientific gate).
 */
async function lookupDiscoveryNodeIfAvailable(hypothesisId) {
  try {
    return await getNode(PHASE11_NODE_TYPES.DISCOVERY, hypothesisId);
  } catch {
    return null;
  }
}

/**
 * Bridges a Replicated Phase 11 candidate into the legacy Publication
 * stage, IF AND ONLY IF every mandatory scientific gate passes.
 *
 * @param {object} params
 * @param {object} params.candidate - Must be at PHASE11_LIFECYCLE_STAGES.REPLICATED.
 * @param {string} params.hypothesisId - The legacy hypothesisRegistry id.
 * @param {import('../orchestration/Phase11Orchestrator.js').Phase11Orchestrator} params.orchestrator
 *   Used only to call its existing checkPublicationEligibility() and to
 *   keep its candidate registry in sync — this bridge never computes
 *   reproducibility/version checks itself.
 * @param {import('../config/ResearchConfiguration.js').ResearchConfiguration} params.publishTimeConfig
 *   The configuration in effect AT PUBLICATION TIME, compared against the
 *   frozen one — this is what lets the gate detect drift since Confirmation.
 * @param {object} [params.eligibilityOptions] - Passed through to
 *   checkPublicationEligibility (currentDatasetSnapshotId, datasetManifest,
 *   expectedContextVersions, actualContextVersions).
 * @param {string} [params.publicationId] - Defaults to `pub_${hypothesisId}`.
 * @param {string} [params.approvedBy='phase11-publication-bridge']
 * @returns {Promise<{
 *   outcome: 'published'|'ineligible',
 *   candidate: object,
 *   hypothesisId: string,
 *   publicationId: string|null,
 *   gateResult: { passed: boolean, failures: string[] }
 * }>}
 */
export async function publishPhase11Candidate({
  candidate, hypothesisId, orchestrator, publishTimeConfig, eligibilityOptions = {},
  publicationId, approvedBy = 'phase11-publication-bridge',
} = {}) {
  if (!candidate || candidate.lifecycle !== PHASE11_LIFECYCLE_STAGES.REPLICATED) {
    throw new Phase11PublicationValidationError(
      `publishPhase11Candidate: candidate must be at lifecycle stage "Replicated" (got "${candidate?.lifecycle}")`
    );
  }
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new Phase11PublicationValidationError('publishPhase11Candidate: "hypothesisId" is required');
  }
  if (!orchestrator || typeof orchestrator.checkPublicationEligibility !== 'function') {
    throw new Phase11PublicationValidationError('publishPhase11Candidate: a Phase11Orchestrator instance is required');
  }

  // ── The ONLY eligibility check — composes ReproducibilityGate +
  //    freeze/SAP/dataset-manifest/context-version checks. Not duplicated
  //    here; this bridge simply acts on its verdict.
  const gateResult = orchestrator.checkPublicationEligibility(candidate, publishTimeConfig, eligibilityOptions);

  if (!gateResult.passed) {
    return { outcome: 'ineligible', candidate, hypothesisId, publicationId: null, gateResult };
  }

  const resolvedPublicationId = publicationId || `pub_${hypothesisId}`;

  // ── Legacy lifecycle: Lockbox -> Publication (final forward transition
  //    before Retirement/Archive, both out of this bridge's scope).
  await transitionLifecycleStage(hypothesisId, {
    to: LIFECYCLE_STAGES.PUBLICATION,
    reason: `Phase 11 candidate cleared publication eligibility (ReproducibilityGate + freeze/SAP/dataset/context checks) -- publicationId=${resolvedPublicationId}`,
    approvedBy,
  });

  const publishedCandidate = withPhase11Lifecycle(candidate, PHASE11_LIFECYCLE_STAGES.PUBLISHED);

  if (orchestrator.decisionAuditLog) {
    orchestrator.decisionAuditLog.append({
      candidateId: candidate.id,
      decisionType: DECISION_TYPES.PUBLISHED,
      reason: `Published: all mandatory scientific gates passed (publicationId=${resolvedPublicationId})`,
      actor: 'phase11-publication-bridge',
      metadata: { hypothesisId, publicationId: resolvedPublicationId },
    });
  }

  const discoveryNode = await lookupDiscoveryNodeIfAvailable(hypothesisId);
  if (discoveryNode) {
    await registerPhase11PublicationInKnowledgeGraph(discoveryNode, resolvedPublicationId);
  }

  return { outcome: 'published', candidate: publishedCandidate, hypothesisId, publicationId: resolvedPublicationId, gateResult };
}
