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
import { ReproducibilityGate } from '../governance/reproducibilityLevels.js';
import { explainCandidate } from '../interpretation/ExplainabilityEngine.js';
import { computeDiscoveryStabilityIndex } from '../analysis/DiscoveryStabilityAnalysis.js';
import {
  registerPhase11CandidateInKnowledgeGraph,
  recordPhase11NegativeEvidenceInKnowledgeGraph,
} from '../governance/phase11KnowledgeGraphBridge.js';
import { confirmPhase11Candidate } from '../bridge/Phase11ConfirmationBridge.js';
import { replicatePhase11Candidate } from '../bridge/Phase11ReplicationBridge.js';
import { publishPhase11Candidate } from '../bridge/Phase11PublicationBridge.js';
import { runRngForensicsForCandidate, characterizeConfirmedCandidate } from '../bridge/Phase11ScientificCharacterization.js';

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
    /** @type {Map<string, object>} Campaign-scoped candidate registry, id -> latest known candidate instance. */
    this._candidates = new Map();
    /** @type {Map<string, object>} candidateId -> its registered Knowledge Graph node record, if synced. */
    this._knowledgeGraphNodes = new Map();

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
      const result = await generateCandidate({
        candidateType,
        candidateParams,
        researchFreeze: this.researchFreeze,
        sap: this.sap,
        familyRegistry: this.familyRegistry,
        decisionAuditLog: this.decisionAuditLog,
        measurementRegistry,
      });
      this._candidates.set(result.candidate.id, result.candidate);
      results.push(result);
    }
    return results;
  }

  /**
   * Runs Round 1 screening over a batch of candidates.
   * @see phase11FunnelBridge.runPhase11Screening
   */
  screen({ candidates, scoreFn, promotionQuantile, dataset }) {
    const result = runPhase11Screening({
      candidates, scoreFn, promotionPolicy: this.promotionPolicy,
      familyRegistry: this.familyRegistry, promotionQuantile, dataset,
    });
    for (const c of [...result.promoted, ...result.rejected]) this._candidates.set(c.id, c);
    return result;
  }

  /**
   * Runs Round 2 triage over a batch of Screened candidates.
   * @see phase11FunnelBridge.runPhase11Triage
   */
  triage({ candidates, diagnosticsByCandidateId, dataset }) {
    const result = runPhase11Triage({
      promotionPolicy: this.promotionPolicy, candidates, diagnosticsByCandidateId, dataset,
    });
    for (const c of [...result.promoted, ...result.rejected]) this._candidates.set(c.id, c);
    return result;
  }

  /** @returns {object[]} All candidates currently known to this orchestrator, insertion order. */
  listCandidates() {
    return [...this._candidates.values()];
  }

  /** @returns {object|undefined} A single tracked candidate by id. */
  getCandidate(candidateId) {
    return this._candidates.get(candidateId);
  }

  /**
   * Updates a tracked candidate's registry entry to a new instance (e.g.
   * after externally rebuilding a ResearchFreeze to include a candidate's
   * fingerprint, and patching the candidate's researchFreezeId to match --
   * see startPhase11Campaign.js). Does not itself decide or validate
   * anything; it's a plain registry write, matching the internal pattern
   * generate()/screen()/triage()/confirm()/replicate()/publish() already
   * use on themselves.
   * @param {object} candidate - Must have the same .id as an existing entry.
   */
  updateCandidate(candidate) {
    this._candidates.set(candidate.id, candidate);
  }

  /**
   * Read-only summary for UI dashboards (Part 2 "Dashboard" requirements):
   * counts by Phase 11 lifecycle stage plus the active research cycle
   * identifiers. Computed entirely from this orchestrator's own in-memory
   * registry -- never reads IndexedDB directly.
   * @returns {object}
   */
  getCampaignSummary() {
    const counts = { Generated: 0, Screened: 0, Triaged: 0, Confirmed: 0, Replicated: 0, Published: 0, Deprecated: 0 };
    for (const c of this._candidates.values()) {
      if (counts[c.lifecycle] !== undefined) counts[c.lifecycle]++;
    }
    return {
      researchFreezeId: this.researchFreeze.id,
      sapId: this.sap.sapId,
      candidateCount: this._candidates.size,
      countsByStage: counts,
      confirmedCount: counts.Confirmed + counts.Replicated + counts.Published,
      replicationCount: counts.Replicated + counts.Published,
      publicationCount: counts.Published,
    };
  }

  /**
   * Syncs a candidate (and, on later calls, its rejections) into the
   * Knowledge Graph via phase11KnowledgeGraphBridge -- Part 1 §1/§6
   * integration. This is an explicit, caller-invoked sync step (not
   * automatic on every generate/screen/triage call) so campaigns that
   * never touch IndexedDB (e.g. pure in-memory unit tests) are not forced
   * to pay for it.
   *
   * @param {object} candidate
   * @param {object} [links] - @see phase11KnowledgeGraphBridge.registerPhase11CandidateInKnowledgeGraph
   * @returns {Promise<object>} The registered Knowledge Graph node.
   */
  async syncKnowledgeGraph(candidate, links = {}) {
    const node = await registerPhase11CandidateInKnowledgeGraph(candidate, links);
    this._knowledgeGraphNodes.set(candidate.id, node);
    return node;
  }

  /**
   * Records a candidate's negative-evidence rejections into the Knowledge
   * Graph, linked to its already-synced node (call syncKnowledgeGraph
   * first). Part 1 §6: "must be available to the Knowledge Graph."
   * @param {string} candidateId
   * @returns {Promise<object[]>} The registered negative-evidence nodes.
   */
  async syncNegativeEvidenceToKnowledgeGraph(candidateId) {
    const candidateNode = this._knowledgeGraphNodes.get(candidateId);
    const candidate = this._candidates.get(candidateId);
    const fingerprint = candidate?.fingerprint;
    const entries = fingerprint ? this.negativeEvidenceRegistry.byFingerprint(fingerprint) : [];
    const nodes = [];
    for (const entry of entries) {
      nodes.push(await recordPhase11NegativeEvidenceInKnowledgeGraph(candidateNode, entry));
    }
    return nodes;
  }

  /**
   * Computes the Discovery Stability Index for a candidate from
   * caller-supplied per-partition effect sizes -- Part 1 §5, delegates
   * entirely to analysis/DiscoveryStabilityAnalysis.js.
   * @see DiscoveryStabilityAnalysis.computeDiscoveryStabilityIndex
   */
  computeStability(partitionEffectSizes, pooledEffectSize) {
    return computeDiscoveryStabilityIndex(partitionEffectSizes, pooledEffectSize);
  }

  /**
   * Assembles the full ExplainabilityEngine explanation for a candidate --
   * Part 1 §2. Pulls the candidate's own evidence tier/implementation
   * maturity fields, its DecisionAuditLog trail, and (if a debtLog was
   * supplied at construction) any open ScientificDebtLog items -- wiring
   * these already-built pieces together without duplicating their logic.
   *
   * @param {object} candidate
   * @param {object} explainInputs - Passed straight through to
   *   ExplainabilityEngine.explainCandidate (plainEnglishSummary,
   *   mathDefinition, contextDescription, interpretation, knownLimitations,
   *   uncertainty, scientificImportance, tradingImportance,
   *   discoveryStabilityIndex, operationalTradingNote).
   * @returns {object} The full explanation record.
   */
  explain(candidate, explainInputs) {
    const decisionAuditTrailRef = this.decisionAuditLog.forCandidate(candidate.id).map(e => e.toJSON());
    return explainCandidate({ candidate, ...explainInputs, decisionAuditTrailRef });
  }

  /**
   * Checks whether a candidate is eligible for publication -- Part 1 §4.
   * Composes the existing ReproducibilityGate.check() (config/ontology/
   * generator/proxy-version/fingerprint matching, already built in Phase A)
   * with the additional checks the directive requires that the base gate
   * does not itself cover: the candidate's own researchFreezeId/sapId
   * match the currently active freeze/SAP, and (if supplied) the dataset
   * manifest and context-version maps match. Returns the union of all
   * failures in the same { passed, failures } shape as ReproducibilityGate
   * for a consistent caller experience. Never spends alpha, never touches
   * onlineFdr.js/discoveryDecision.js -- this is a reproducibility/
   * bookkeeping check, not a statistical decision.
   *
   * @param {object} candidate
   * @param {import('../config/ResearchConfiguration.js').ResearchConfiguration} publishTimeConfig
   * @param {object} [options]
   * @param {string|null} [options.currentDatasetSnapshotId=null]
   * @param {{datasetId: string}|null} [options.datasetManifest=null] - Compared
   *   against this.researchFreeze.datasetSnapshotId if both are present.
   * @param {Object.<string,string>|null} [options.expectedContextVersions=null]
   * @param {Object.<string,string>|null} [options.actualContextVersions=null]
   * @returns {{ passed: boolean, failures: string[] }}
   */
  checkPublicationEligibility(candidate, publishTimeConfig, {
    currentDatasetSnapshotId = null, datasetManifest = null,
    expectedContextVersions = null, actualContextVersions = null,
  } = {}) {
    const base = ReproducibilityGate.check(candidate, publishTimeConfig, this.researchFreeze, { currentDatasetSnapshotId });
    const failures = [...base.failures];

    if (candidate.researchFreezeId !== this.researchFreeze.id) {
      failures.push(`researchFreezeId mismatch: candidate="${candidate.researchFreezeId}", active="${this.researchFreeze.id}"`);
    }
    if (candidate.sapId !== this.sap.sapId) {
      failures.push(`sapId mismatch: candidate="${candidate.sapId}", active="${this.sap.sapId}"`);
    }
    if (datasetManifest && this.researchFreeze.datasetSnapshotId && datasetManifest.datasetId !== this.researchFreeze.datasetSnapshotId) {
      failures.push(`datasetManifest mismatch: manifest="${datasetManifest.datasetId}", frozen="${this.researchFreeze.datasetSnapshotId}"`);
    }
    if (expectedContextVersions && actualContextVersions) {
      const keys = new Set([...Object.keys(expectedContextVersions), ...Object.keys(actualContextVersions)]);
      for (const key of keys) {
        if (expectedContextVersions[key] !== actualContextVersions[key]) {
          failures.push(`contextVersions["${key}"] mismatch: expected="${expectedContextVersions[key]}", actual="${actualContextVersions[key]}"`);
        }
      }
    }

    return { passed: failures.length === 0, failures };
  }

  /**
   * Explicitly unsupported: Round 3 confirmation and beyond require the
   * still-deferred hypothesisRegistry/IndexedDB integration. Always throws.
   * Exists so a caller mistakenly expecting this orchestrator to reach
   * Confirmed/Published gets a clear, actionable error rather than
   * silently stopping.
   */
  /**
   * Bridges a Triaged candidate through the existing legacy confirmation
   * framework (hypothesisRegistry -> discoveryDecision.evaluateDiscoveryCandidate
   * -> onlineFdr, all unmodified) -- see bridge/Phase11ConfirmationBridge.js
   * for the full validation/mapping this performs. Updates this
   * orchestrator's candidate registry with the resulting Confirmed or
   * Deprecated candidate. Never spends alpha itself; the bridge's single
   * call into evaluateDiscoveryCandidate is the only place that happens.
   *
   * @param {object} params
   * @param {object} params.candidate - Must be at lifecycle stage Triaged.
   * @param {object} params.researchConfiguration - Must match candidate.researchConfigurationId.
   * @param {{datasetId: string}} params.datasetManifest
   * @param {import('../provenance/ProvenanceDAG.js').ProvenanceDAG} params.provenance
   * @param {string} params.market
   * @param {{direction: 'Rise'|'Fall', runLength: number}} params.targetDefinition
   * @param {number} params.pValue - Already-computed; this method computes nothing.
   * @param {string} [params.testMethod]
   * @param {number} [params.testedAt]
   * @returns {Promise<{ outcome: 'confirmed'|'rejected', candidate: object, hypothesisId: string, familyKey: string, legacyResult: object }>}
   */
  async confirm({
    candidate, researchConfiguration, datasetManifest, provenance,
    market, targetDefinition, pValue, testMethod, testedAt,
  } = {}) {
    let knowledgeGraphCandidateNode = this._knowledgeGraphNodes.get(candidate?.id) ?? null;
    if (!knowledgeGraphCandidateNode) {
      try {
        knowledgeGraphCandidateNode = await registerPhase11CandidateInKnowledgeGraph(candidate, {
          datasetManifestId: datasetManifest?.datasetId,
        });
        this._knowledgeGraphNodes.set(candidate.id, knowledgeGraphCandidateNode);
      } catch {
        knowledgeGraphCandidateNode = null; // KG sync is best-effort here; confirmation validity never depends on it
      }
    }

    const result = await confirmPhase11Candidate({
      candidate, researchFreeze: this.researchFreeze, sap: this.sap, researchConfiguration,
      datasetManifest, provenance, familyRegistry: this.familyRegistry,
      market, targetDefinition, pValue, testMethod, testedAt,
      decisionAuditLog: this.decisionAuditLog, negativeEvidenceRegistry: this.negativeEvidenceRegistry,
      knowledgeGraphCandidateNode,
    });

    this._candidates.set(result.candidate.id, result.candidate);
    return result;
  }

  /**
   * Bridges a Confirmed candidate through the existing Lockbox replication
   * framework -- see bridge/Phase11ReplicationBridge.js. Updates this
   * orchestrator's candidate registry with the resulting Replicated or
   * Deprecated candidate. Spends no additional alpha; the replication
   * verdict is computed by analysis/DiscoveryStabilityAnalysis.js.
   *
   * @param {object} params - See Phase11ReplicationBridge.replicatePhase11Candidate
   *   (candidate, hypothesisId, familyKey, featureKey, generation,
   *   holdoutRange, partitionEffectSizes, pooledEffectSize, minStabilityIndex,
   *   rangeOverlapsFn, allocatedBy, datasetId).
   * @returns {Promise<{ outcome: 'replicated'|'failed', candidate: object, hypothesisId: string, stability: object, lockboxAllocation: object, lockboxConsumption: object }>}
   */
  async replicate(params = {}) {
    const result = await replicatePhase11Candidate({
      ...params,
      sap: this.sap,
      decisionAuditLog: this.decisionAuditLog,
      negativeEvidenceRegistry: this.negativeEvidenceRegistry,
    });
    this._candidates.set(result.candidate.id, result.candidate);
    return result;
  }

  /**
   * Bridges a Replicated candidate into the legacy Publication lifecycle
   * stage -- see bridge/Phase11PublicationBridge.js. Only proceeds if
   * checkPublicationEligibility() passes; an ineligible result leaves the
   * candidate at Replicated (not deprecated) and is returned for the
   * caller to inspect/retry once the gap is fixed.
   *
   * @param {object} params - See Phase11PublicationBridge.publishPhase11Candidate
   *   (candidate, hypothesisId, publishTimeConfig, eligibilityOptions, publicationId).
   * @returns {Promise<{ outcome: 'published'|'ineligible', candidate: object, hypothesisId: string, publicationId: string|null, gateResult: object }>}
   */
  async publish(params = {}) {
    const result = await publishPhase11Candidate({ ...params, orchestrator: this });
    if (result.outcome === 'published') {
      this._candidates.set(result.candidate.id, result.candidate);
    }
    return result;
  }

  /**
   * Runs RNG Forensics for a Confirmed+ candidate -- see
   * bridge/Phase11ScientificCharacterization.js. Thin wrapper; computes
   * nothing itself, forwards caller-supplied sub-check results to the
   * existing discovery/rngForensics.js.
   * @param {object} candidate
   * @param {string} hypothesisId
   * @param {object} subChecks
   * @returns {Promise<object>} The recorded RngForensicsResults row.
   */
  async runRngForensics(candidate, hypothesisId, subChecks) {
    return runRngForensicsForCandidate(candidate, hypothesisId, subChecks);
  }

  /**
   * Composes Discovery Stability Analysis, Importance Scoring, and
   * Explainability for a Confirmed+ candidate -- see
   * bridge/Phase11ScientificCharacterization.js.
   * @param {object} params - See Phase11ScientificCharacterization.characterizeConfirmedCandidate.
   * @returns {Promise<object>}
   */
  async characterize(params = {}) {
    return characterizeConfirmedCandidate(params);
  }
}
