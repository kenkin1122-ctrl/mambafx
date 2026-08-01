/**
 * research/src/dashboard/Phase11ScientificDashboard.js
 *
 * Purpose:
 *   Stage 9 of the "Continue Implementation" directive: completes the
 *   Phase 11 dashboard beyond orchestration/Phase11Orchestrator.js's own
 *   getCampaignSummary() (lifecycle counts, freeze/SAP ids, confirmation/
 *   replication/publication counts, negative evidence count -- already
 *   built, unmodified, reused here rather than duplicated).
 *
 *   buildPhase11ScientificDashboard() is PURE AGGREGATION -- exactly the
 *   same discipline validation/ValidationReport.js already established
 *   for the Validation Suite: it reads existing fields already present on
 *   every real candidate object (evidenceTier, implementationMaturity,
 *   confidenceLevel, reproducibilityLevel, discoveryStabilityIndex,
 *   uncertainty, measurementUncertainty -- all defined and populated by
 *   candidate/Candidate.js's own common fields, unmodified) plus the
 *   orchestrator's own DecisionAuditLog and NegativeEvidenceRegistry. It
 *   computes NOTHING new: no stability index, no confidence interval, no
 *   evidence-tier ranking logic lives here -- those all already exist
 *   elsewhere (analysis/DiscoveryStabilityAnalysis.js,
 *   statistics/uncertaintyEstimation.js, governance/scientificEvidenceTiers.js)
 *   and are simply tallied by their own already-assigned values.
 *
 * Dependencies: orchestration/Phase11Orchestrator.js (getCampaignSummary
 *   -- unmodified, reused), candidate/Candidate.js (CANDIDATE_TYPES,
 *   read-only).
 * Public API: buildPhase11ScientificDashboard.
 * Complexity: O(n) over the orchestrator's candidate registry + O(m) over
 *   its DecisionAuditLog, where n/m are typically small (hundreds, not
 *   millions) for a single research campaign.
 */

import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

function tallyBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeNumericField(candidates, fieldName) {
  const values = candidates.map((c) => c[fieldName]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return { count: 0, mean: null, min: null, max: null };
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Builds the full Phase 11 Scientific Dashboard data structure from a
 * live orchestrator's current state. Pure read -- never mutates the
 * orchestrator, never spends alpha, never touches any protected legacy
 * module.
 *
 * @param {import('../orchestration/Phase11Orchestrator.js').Phase11Orchestrator} orchestrator
 * @returns {{
 *   campaignSummary: object,
 *   candidateCountsByType: Record<string, number>,
 *   candidateCountsByFamily: Record<string, number>,
 *   evidenceTierBreakdown: Record<string, number>,
 *   implementationMaturityBreakdown: Record<string, number>,
 *   confidenceLevelBreakdown: Record<string, number>,
 *   reproducibilityLevelSummary: { count: number, mean: number|null, min: number|null, max: number|null },
 *   discoveryStabilityIndexSummary: { count: number, mean: number|null, min: number|null, max: number|null },
 *   contextUsage: Record<string, number>,
 *   proxyUsage: Record<string, number>,
 *   conditionalHypothesisCount: number,
 *   negativeEvidenceByStage: Record<string, number>,
 *   decisionAuditSummary: Record<string, number>,
 *   publicationReadyCount: number,
 * }}
 */
export function buildPhase11ScientificDashboard(orchestrator) {
  const campaignSummary = orchestrator.getCampaignSummary();
  const candidates = orchestrator.listCandidates();

  const candidateCountsByType = tallyBy(candidates, (c) => c.type);
  const candidateCountsByFamily = tallyBy(candidates, (c) => c.family);
  const evidenceTierBreakdown = tallyBy(candidates, (c) => c.evidenceTier);
  const implementationMaturityBreakdown = tallyBy(candidates, (c) => c.implementationMaturity);
  const confidenceLevelBreakdown = tallyBy(candidates, (c) => c.confidenceLevel);
  const reproducibilityLevelSummary = summarizeNumericField(candidates, 'reproducibilityLevel');
  const discoveryStabilityIndexSummary = summarizeNumericField(candidates, 'discoveryStabilityIndex');

  // Proxy usage: how many ProxyCandidate instances exist per proxyName.
  const proxyUsage = tallyBy(candidates.filter((c) => c.type === CANDIDATE_TYPES.PROXY_CANDIDATE), (c) => c.proxyName);

  // Context usage: tallies every contextName appearing in any
  // ConditionalHypothesis's contextConditions -- a candidate using 2
  // contexts contributes to both context's counts.
  const conditionalCandidates = candidates.filter((c) => c.type === CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS);
  const contextUsage = {};
  for (const c of conditionalCandidates) {
    for (const cond of c.contextConditions || []) {
      contextUsage[cond.contextName] = (contextUsage[cond.contextName] || 0) + 1;
    }
  }

  const auditEntries = orchestrator.decisionAuditLog.toArray();
  const decisionAuditSummary = tallyBy(auditEntries, (e) => e.decisionType);

  const negativeEvidenceByStage = tallyBy(orchestrator.negativeEvidenceRegistry.all(), (e) => e.stageRejected);

  // Publication-ready: candidates that have reached Replicated but not
  // yet Published -- the population Publication would actually act on
  // next. Read from the Phase11 lifecycle field already on every
  // candidate; no new eligibility computation happens here (that remains
  // exclusively orchestrator.checkPublicationEligibility()'s job).
  const publicationReadyCount = candidates.filter((c) => c.lifecycle === 'Replicated').length;

  return {
    campaignSummary,
    candidateCountsByType,
    candidateCountsByFamily,
    evidenceTierBreakdown,
    implementationMaturityBreakdown,
    confidenceLevelBreakdown,
    reproducibilityLevelSummary,
    discoveryStabilityIndexSummary,
    contextUsage,
    proxyUsage,
    conditionalHypothesisCount: conditionalCandidates.length,
    negativeEvidenceByStage,
    decisionAuditSummary,
    publicationReadyCount,
  };
}
