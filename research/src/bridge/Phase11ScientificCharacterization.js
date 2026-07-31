/**
 * research/src/bridge/Phase11ScientificCharacterization.js
 *
 * Purpose:
 *   Completes Stage 2 Part 3: post-confirmation scientific characterization
 *   of a Phase 11 candidate. Unlike the Confirmation/Replication/Publication
 *   bridges, this one integrates NO new legacy governance decision — it
 *   composes already-built, already-tested Phase 11 analysis modules into
 *   one convenient call, and (for RNG Forensics specifically) reuses the
 *   existing, unmodified discovery/rngForensics.js exactly as designed.
 *
 * Mechanical "post-confirmation only" enforcement: both entry points below
 *   refuse a candidate below PHASE11_LIFECYCLE_STAGES.CONFIRMED — this is
 *   not just documented, it is a structural gate (same discipline as
 *   analysis/ImportanceScorer.js's own precondition), so neither can be
 *   called from anywhere in the Generate -> Screen -> Triage path without
 *   the candidate already having survived Round 3.
 *
 * RNG Forensics integration: runRngForensicsForCandidate() is a thin
 *   wrapper around discovery/rngForensics.js's runRngForensics() — which
 *   itself already enforces the randomnessAudit.js precondition
 *   (assertRandomnessAuditSurvived) and does all classification/recording.
 *   This wrapper adds nothing statistical; it only adds the Phase 11
 *   lifecycle gate and a DecisionAuditLog entry, and forwards caller-
 *   supplied, already-computed sub-check results — it does not fetch or
 *   recompute raw tick data, matching that module's own disclosed
 *   data-boundary discipline.
 *
 * Discovery Stability / Importance / Explainability integration:
 *   characterizeConfirmedCandidate() composes (does not reimplement):
 *     - analysis/DiscoveryStabilityAnalysis.js (Phase D)
 *     - analysis/ImportanceScorer.js (Phase D, already gated to Confirmed+)
 *     - interpretation/ExplainabilityEngine.js (Phase D)
 *   into one call, and records the numeric outputs as a new, append-only
 *   Knowledge Graph Characterization node (phase11KnowledgeGraphBridge.js,
 *   extended in this same change) linked to the Discovery node.
 *
 * Dependencies: governance/phase11LifecycleStates.js (stage gate),
 *   discovery/rngForensics.js (runRngForensics — unmodified),
 *   analysis/DiscoveryStabilityAnalysis.js, analysis/ImportanceScorer.js,
 *   interpretation/ExplainabilityEngine.js,
 *   governance/phase11KnowledgeGraphBridge.js
 *   (registerPhase11CharacterizationInKnowledgeGraph).
 * Public API: runRngForensicsForCandidate, characterizeConfirmedCandidate,
 *   Phase11CharacterizationPreconditionError.
 * Complexity: O(1) gate check + whatever the composed modules' own
 *   documented complexity is (none duplicated).
 */

import { PHASE11_LIFECYCLE_STAGES } from '../governance/phase11LifecycleStates.js';
import { runRngForensics } from '../discovery/rngForensics.js';
import { computeDiscoveryStabilityIndex } from '../analysis/DiscoveryStabilityAnalysis.js';
import { scoreImportance } from '../analysis/ImportanceScorer.js';
import { explainCandidate } from '../interpretation/ExplainabilityEngine.js';
import { registerPhase11CharacterizationInKnowledgeGraph } from '../governance/phase11KnowledgeGraphBridge.js';

export class Phase11CharacterizationPreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11CharacterizationPreconditionError';
  }
}

/** Ordinal rank of each Phase 11 lifecycle stage, for the "at least Confirmed" gate. */
const STAGE_RANK = Object.freeze({
  [PHASE11_LIFECYCLE_STAGES.GENERATED]: 0,
  [PHASE11_LIFECYCLE_STAGES.SCREENED]: 1,
  [PHASE11_LIFECYCLE_STAGES.TRIAGED]: 2,
  [PHASE11_LIFECYCLE_STAGES.CONFIRMED]: 3,
  [PHASE11_LIFECYCLE_STAGES.REPLICATED]: 4,
  [PHASE11_LIFECYCLE_STAGES.PUBLISHED]: 5,
  [PHASE11_LIFECYCLE_STAGES.DEPRECATED]: -1,
});

function assertPostConfirmation(candidate, callerName) {
  const rank = STAGE_RANK[candidate?.lifecycle];
  if (rank === undefined || rank < STAGE_RANK[PHASE11_LIFECYCLE_STAGES.CONFIRMED]) {
    throw new Phase11CharacterizationPreconditionError(
      `${callerName}: candidate "${candidate?.id}" is at lifecycle stage "${candidate?.lifecycle}", but this is a ` +
      `post-confirmation-only operation — the candidate must have reached at least "${PHASE11_LIFECYCLE_STAGES.CONFIRMED}" first.`
    );
  }
}

/**
 * Runs RNG Forensics for a Confirmed+ candidate — thin wrapper around
 * discovery/rngForensics.js's own governed entry point. Throws
 * Phase11CharacterizationPreconditionError before calling it at all if the
 * candidate hasn't reached Confirmed (in addition to that module's own
 * randomnessAudit.js precondition, enforced internally by runRngForensics).
 *
 * Deliberately does NOT append to DecisionAuditLog: DECISION_TYPES is a
 * closed, pre-committed enum with no "informational" entry (by design —
 * its own header says no novel decision type may be invented post-hoc),
 * and RNG Forensics already has its own dedicated, permanent audit trail
 * (RngForensicsResults, written by runRngForensics itself). Forcing this
 * into DecisionAuditLog under a reused type like CONFIRMED would
 * misrepresent the log to anything auditing it later.
 *
 * @param {object} candidate - Must be at PHASE11_LIFECYCLE_STAGES.CONFIRMED or later.
 * @param {string} hypothesisId - The legacy hypothesisRegistry id.
 * @param {object} subChecks - Passed straight through to rngForensics.runRngForensics
 *   (reseedWindowResults, tickIndexAlignedResult, wallClockAlignedResult,
 *   coarseQuantizationResult, fineQuantizationResult, alpha) — already-computed,
 *   caller-supplied sub-check results; this function computes none of them.
 * @returns {Promise<object>} The recorded RngForensicsResults row.
 */
export async function runRngForensicsForCandidate(candidate, hypothesisId, subChecks) {
  assertPostConfirmation(candidate, 'runRngForensicsForCandidate');
  return runRngForensics({ hypothesisId, ...subChecks });
}

/**
 * Composes Discovery Stability Analysis, Importance Scoring, and
 * Explainability for a Confirmed+ candidate into one call, and records the
 * numeric outputs as a new Knowledge Graph Characterization node.
 *
 * @param {object} params
 * @param {object} params.candidate - Must be at PHASE11_LIFECYCLE_STAGES.CONFIRMED or later.
 * @param {number[]} params.partitionEffectSizes - For DiscoveryStabilityAnalysis.
 * @param {number} params.pooledEffectSize
 * @param {number} params.noveltyScore - For ImportanceScorer (0-1).
 * @param {number} params.evidenceTierWeight - For ImportanceScorer (0-1).
 * @param {object} params.explainInputs - Passed to ExplainabilityEngine.explainCandidate
 *   (plainEnglishSummary, mathDefinition, contextDescription, interpretation,
 *   knownLimitations, uncertainty, operationalTradingNote, decisionAuditTrailRef).
 * @param {object} [params.discoveryNode] - The Knowledge Graph Discovery node
 *   (from registerPhase11DiscoveryInKnowledgeGraph), if KG enrichment is wanted.
 * @param {string} [params.rngForensicsClassification] - If already computed via
 *   runRngForensicsForCandidate, included in the Characterization node's metadata.
 * @returns {Promise<{ stability: object, scientificImportance: number, tradingImportance: number, explanation: object, characterizationNode: object|null }>}
 */
export async function characterizeConfirmedCandidate({
  candidate, partitionEffectSizes, pooledEffectSize, noveltyScore, evidenceTierWeight,
  explainInputs, discoveryNode = null, rngForensicsClassification = null,
} = {}) {
  assertPostConfirmation(candidate, 'characterizeConfirmedCandidate');

  const stability = computeDiscoveryStabilityIndex(partitionEffectSizes, pooledEffectSize);
  const { scientificImportance, tradingImportance } = scoreImportance(candidate, {
    noveltyScore, effectSize: pooledEffectSize, discoveryStabilityIndex: stability.stabilityIndex, evidenceTierWeight,
  });
  const explanation = explainCandidate({
    candidate, ...explainInputs,
    scientificImportance, tradingImportance, discoveryStabilityIndex: stability.stabilityIndex,
  });

  let characterizationNode = null;
  if (discoveryNode) {
    characterizationNode = await registerPhase11CharacterizationInKnowledgeGraph(discoveryNode, {
      stabilityIndex: stability.stabilityIndex, scientificImportance, tradingImportance, rngForensicsClassification,
    });
  }

  return { stability, scientificImportance, tradingImportance, explanation, characterizationNode };
}
