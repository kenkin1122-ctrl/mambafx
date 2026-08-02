/**
 * research/src/discovery/candidateGenerator.js
 *
 * Purpose:
 *   Phase C "Generator Extensions" — the single entry point through which
 *   any Phase 11 Candidate subclass (IndicatorFeature, MarketState,
 *   CompositeCandidate, ConditionalHypothesis) is generated with:
 *     - mandatory ResearchFreeze attachment (constraint #12),
 *     - mandatory SAP attachment (constraint #13),
 *     - deterministic candidate fingerprints (Candidate._computeFingerprint,
 *       already built in Phase A — reused, not reimplemented),
 *     - FamilyRegistry compatibility routing,
 *     - full provenance recording (CandidateProvenance.js),
 *     - a GENERATED entry in DecisionAuditLog.
 *
 * Relationship to discovery/searchEngine.js (existing Phase 9, DO NOT
 *   REWRITE): searchEngine.js answers "where should the adaptive search
 *   look next?" (rankings/scores/selections over an abstract move space) —
 *   it does not construct Candidate objects and never did. This module is
 *   the missing piece one level below it: given a (move, parameters) pair
 *   that searchEngine.js's bandit/MCTS/evolutionary methods selected, THIS
 *   is where a concrete, fully-governed Phase 11 Candidate instance gets
 *   materialized. searchEngine.js is untouched; this module is purely
 *   additive and sits downstream of it in the pipeline.
 *
 * ABSOLUTE GOVERNING RULE (same discipline as funnel.js): this module
 *   produces CANDIDATES ONLY. It never computes a p-value, never spends
 *   Online-FDR wealth, and never calls onlineFdr.js or discoveryDecision.js
 *   — those remain reachable only through the funnel (Round 3+).
 *
 * Dependencies: candidate/*.js (Candidate subclasses), provenance/CandidateProvenance.js,
 *   governance/FamilyRegistry.js, governance/DecisionAuditLog.js.
 * Public API: generateCandidate, GeneratorPreconditionError.
 * Complexity: O(1) generator-side bookkeeping + the underlying Candidate
 *   subclass's own O(n) fingerprint hash + CandidateProvenance's cost (see
 *   that module).
 */

import { CANDIDATE_TYPES } from '../candidate/Candidate.js';
import { IndicatorFeature } from '../candidate/IndicatorFeature.js';
import { MarketState } from '../candidate/MarketState.js';
import { ProxyCandidate } from '../candidate/ProxyCandidate.js';
import { CompositeCandidate } from '../candidate/CompositeCandidate.js';
import { ConditionalHypothesis } from '../candidate/ConditionalHypothesis.js';
import { EventProcessFeature } from '../candidate/EventProcessFeature.js';
import { buildCandidateProvenance } from '../provenance/CandidateProvenance.js';
import { DECISION_TYPES } from '../governance/DecisionAuditLog.js';

export class GeneratorPreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeneratorPreconditionError';
  }
}

/** Maps CANDIDATE_TYPES values to their concrete class's async create() factory. */
const CANDIDATE_CLASSES = Object.freeze({
  [CANDIDATE_TYPES.INDICATOR_FEATURE]: IndicatorFeature,
  [CANDIDATE_TYPES.MARKET_STATE]: MarketState,
  [CANDIDATE_TYPES.PROXY_CANDIDATE]: ProxyCandidate,
  [CANDIDATE_TYPES.COMPOSITE_CANDIDATE]: CompositeCandidate,
  [CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS]: ConditionalHypothesis,
  [CANDIDATE_TYPES.EVENT_PROCESS_FEATURE]: EventProcessFeature,
});

/**
 * Generates a single Phase 11 candidate under full governance: a valid
 * ResearchFreeze and SAP MUST already exist and be passed in (this
 * function does not create them — ResearchFreeze/StatisticalAnalysisPlan
 * creation is its own gated step, upstream of generation, per constraints
 * #12/#13). Also verifies family compatibility (if a FamilyRegistry is
 * supplied) and builds the candidate's full provenance DAG.
 *
 * @param {object} params
 * @param {string} params.candidateType - One of CANDIDATE_TYPES.
 * @param {object} params.candidateParams - Passed through to the subclass's
 *   create() factory verbatim, EXCEPT researchFreezeId/sapId which are
 *   always overridden from params.researchFreeze/params.sap below (a
 *   candidate cannot be generated attached to a freeze/SAP other than the
 *   ones actually active — this is the mechanical enforcement of
 *   constraints #12/#13, not merely documentation).
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze - Required.
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap - Required.
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 *   Optional; if supplied, the generated candidate's family/type is checked
 *   for compatibility before being returned. A generator MUST NOT silently
 *   produce a candidate for an unregistered or incompatible family — this
 *   throws rather than returning a candidate the funnel would later reject
 *   for an avoidable reason.
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 *   Optional; if supplied, a GENERATED entry is appended.
 * @param {import('../candidate/MeasurementRegistry.js').MeasurementRegistry} [params.measurementRegistry]
 *   Required only if candidateParams.featureProvenance is non-empty (needed
 *   to build the provenance DAG).
 * @param {string[]} [params.contextIds=[]]
 * @param {string[]} [params.proxyIds=[]]
 * @param {Object.<string, import('../provenance/ProvenanceDAG.js').ProvenanceDAG>} [params.componentProvenance={}]
 * @returns {Promise<{ candidate: import('../candidate/Candidate.js').Candidate, provenance: import('../provenance/ProvenanceDAG.js').ProvenanceDAG }>}
 */
export async function generateCandidate({
  candidateType,
  candidateParams,
  researchFreeze,
  sap,
  familyRegistry = null,
  decisionAuditLog = null,
  measurementRegistry = null,
  contextIds = [],
  proxyIds = [],
  componentProvenance = {},
} = {}) {
  if (!researchFreeze || !researchFreeze.id) {
    throw new GeneratorPreconditionError(
      'generateCandidate: a valid ResearchFreeze is mandatory before any candidate may be generated (constraint #12)'
    );
  }
  if (!sap || !sap.sapId) {
    throw new GeneratorPreconditionError(
      'generateCandidate: a valid StatisticalAnalysisPlan is mandatory before any candidate may be generated (constraint #13)'
    );
  }
  const CandidateClass = CANDIDATE_CLASSES[candidateType];
  if (!CandidateClass) {
    throw new GeneratorPreconditionError(`generateCandidate: unrecognised candidateType "${candidateType}"`);
  }

  const effectiveParams = {
    ...candidateParams,
    researchFreezeId: researchFreeze.id,
    sapId: sap.sapId,
  };

  const candidate = await CandidateClass.create(effectiveParams);

  if (familyRegistry) {
    const { compatible, reasons } = familyRegistry.isCandidateCompatible(candidate);
    if (!compatible) {
      throw new GeneratorPreconditionError(
        `generateCandidate: generated candidate "${candidate.id}" failed FamilyRegistry compatibility check: ${reasons.join('; ')}`
      );
    }
  }

  const provenance = buildCandidateProvenance(candidate, {
    measurementRegistry,
    contextIds,
    proxyIds,
    componentProvenance,
  });

  if (decisionAuditLog) {
    decisionAuditLog.append({
      candidateId: candidate.id,
      decisionType: DECISION_TYPES.GENERATED,
      reason: `Generated via candidateGenerator under ResearchFreeze ${researchFreeze.id} and SAP ${sap.sapId}`,
      actor: 'orchestrator:candidateGenerator',
      metadata: { candidateType, researchFreezeId: researchFreeze.id, sapId: sap.sapId },
    });
  }

  return { candidate, provenance };
}
