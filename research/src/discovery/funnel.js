/**
 * research/src/discovery/funnel.js
 *
 * Purpose:
 *   Implement Phase 9 Requirement 2 — the Sequential Elimination Funnel
 *   specified in MambaFX_NextGen_Discovery_Engine_Architecture.md Section
 *   2: Round 1 (cheap screening) -> Round 2 (intermediate validation +
 *   registration) -> Round 3 (deep validation, the ONLY round that spends
 *   statistical error budget) -> Round 4 (replication) -> the existing
 *   Layer 1 Human Acceptance Gate (msdAcceptHypothesisAsResearchKnowledge,
 *   untouched, outside this module's scope — this funnel FEEDS candidates
 *   into it, never bypasses it).
 *
 * ABSOLUTE GOVERNING RULE: this module introduces NO new statistical or
 *   governance logic, exactly like governance/researchPipeline.js's own
 *   stated discipline ("a SEQUENCER, not a reimplementation"). Every round
 *   below is a thin, documented composition of already-built, already-
 *   tested functions:
 *     - Round 1: pure in-memory ranking — no governance module involved at
 *       all (matches the architecture doc: "Pure filter. No hypothesis is
 *       registered. No wealth spent.").
 *     - Round 2: hypothesisRegistry.registerHypothesis (registration),
 *       hypothesisRegistry.transitionLifecycleStage (Registration ->
 *       FeatureGeneration), knowledgeGraph.js's Phase 9 extension
 *       (representation family / search space version / campaign links).
 *     - Round 3: hypothesisRegistry.transitionLifecycleStage (->
 *       Discovery), discoveryDecision.evaluateDiscoveryCandidate (THE
 *       single authoritative gate — this module never computes a p-value
 *       or touches onlineFdr.js directly), knowledgeGraph.recordScreenedNotPromoted
 *       for eliminated candidates, transitionLifecycleStage (Discovery ->
 *       Replication) for survivors.
 *     - Round 4: hypothesisRegistry.transitionLifecycleStage (Replication
 *       -> Lockbox), lockbox.allocateLockboxHoldout /
 *       lockbox.consumeLockboxHoldout, knowledgeGraph.linkHypothesisToCampaign
 *       (replication=true).
 *
 * Data-boundary discipline (same disclosed pattern as
 *   discovery/rngForensics.js and this codebase's own randomnessAudit.js
 *   positiveControlInputs / driftSurveillance.js evaluateWindow): Round 1's
 *   scoreFn and Round 2/3's test functions are entirely CALLER-SUPPLIED.
 *   This module never computes a mutual-information statistic or a
 *   permutation p-value itself — it orchestrates WHEN existing statistics
 *   primitives (statistics/permutationTest.js) and governance gates run,
 *   never duplicates what they compute.
 *
 * Responsibilities:
 *   - runRoundOneScreening: pure ranking + quantile cut over a candidate
 *     stream, no I/O, no side effects.
 *   - runRoundTwoValidation: cheap-permutation cut + registration +
 *     Knowledge Graph linking for survivors.
 *   - runRoundThreeDeepValidation: the one round that spends Family Online
 *     FDR wealth, via evaluateDiscoveryCandidate exclusively.
 *   - runRoundFourReplication: Lockbox allocation/consumption for Round 3
 *     survivors.
 *   - advanceLifecycleStage: a single documented wrapper around
 *     transitionLifecycleStage, used internally by Rounds 2-4 so the exact
 *     REQUIRED stage sequence (Registration -> FeatureGeneration ->
 *     Discovery -> Replication -> Lockbox — hypothesisRegistry.js's own
 *     ALLOWED_TRANSITIONS graph, unchanged) is driven consistently rather
 *     than re-typed at each call site.
 *
 * Inputs: candidate objects (shape entirely caller-defined beyond a
 *   required `candidateKey`); campaign/representation-family/search-space-
 *   version ids (already registered via knowledgeGraph.js before this
 *   module is called — this module does not register those itself, only
 *   links to them, mirroring knowledgeGraph.js's own "never creates the
 *   relationship it reflects" discipline where applicable).
 * Outputs: per-round summary objects; Round 2-4 return objects reference
 *   real hypothesisIds a caller can look up in hypothesisRegistry.js/
 *   discoveryDecision.js/lockbox.js directly — nothing is duplicated here.
 * Dependencies: governance/hypothesisRegistry.js, governance/discoveryDecision.js,
 *   governance/lockbox.js, governance/knowledgeGraph.js.
 *
 * Public API: InvalidFunnelInputError, runRoundOneScreening,
 *   runRoundTwoValidation, runRoundThreeDeepValidation,
 *   runRoundFourReplication, advanceLifecycleStage.
 * Internal API: none.
 *
 * Error handling: InvalidFunnelInputError for malformed funnel-level
 *   input; every underlying governance module's own errors (e.g.
 *   ForbiddenTransitionError, LockboxNotEligibleError,
 *   NotRegisteredError) propagate UNCHANGED, never caught and downgraded
 *   — same discipline researchPipeline.js's header documents for itself.
 * Performance notes: Round 1 is O(n log n) in candidate count (a sort);
 *   Rounds 2-4 are O(1) governance calls per candidate — this module never
 *   iterates the full Round-1 population itself, only whatever a caller
 *   passes to Round 2 onward (already filtered).
 * Threading model: no shared mutable state between calls.
 * Storage usage: none directly — all persistence happens inside the
 *   governance modules this file composes.
 * Complexity analysis: see Performance notes.
 * Future extension notes: a fifth round, if ever needed, is a new
 *   exported function following the same "thin composition, no new
 *   statistical logic" shape — no change to the four existing rounds.
 */

import {
  transitionLifecycleStage,
  registerHypothesis,
} from '../governance/hypothesisRegistry.js';
import { evaluateDiscoveryCandidate } from '../governance/discoveryDecision.js';
import { allocateLockboxHoldout, consumeLockboxHoldout } from '../governance/lockbox.js';
import {
  linkHypothesisToRepresentationFamily,
  linkHypothesisToSearchSpaceVersion,
  linkHypothesisToCampaign,
  recordScreenedNotPromoted,
  recordCampaignRoundMetric,
} from '../governance/knowledgeGraph.js';

export class InvalidFunnelInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFunnelInputError';
  }
}

/** Thin, documented wrapper around hypothesisRegistry.transitionLifecycleStage — see module header. */
export async function advanceLifecycleStage(hypothesisId, to, { reason, approvedBy } = {}) {
  return transitionLifecycleStage(hypothesisId, { to, reason, approvedBy });
}

// ── Round 1: cheap screening (pure, no I/O, no governance module touched) ─

/**
 * `candidates`: array of objects, each carrying whatever `scoreFn` needs
 * plus a `candidateKey`. `scoreFn(candidate) -> number`, higher = more
 * promising (a cheap sufficient statistic — rank correlation, binned MI —
 * computed by the CALLER, e.g. via statistics/permutationTest.js's
 * computeMutualInformation with permutations=0, matching the architecture
 * doc's "O(n), a single pass, no permutations" cost profile for this
 * round). Returns the top `promotionQuantile` fraction by score, rounded
 * up to at least 1 candidate if the input is non-empty. This function does
 * not register anything, spend anything, or write anything — the
 * architecture doc's own words: "Pure filter. No hypothesis is registered.
 * No wealth spent."
 */
export function runRoundOneScreening({ candidates, scoreFn, promotionQuantile = 0.001 } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new InvalidFunnelInputError('runRoundOneScreening: "candidates" must be a non-empty array.');
  }
  if (typeof scoreFn !== 'function') {
    throw new InvalidFunnelInputError('runRoundOneScreening: "scoreFn" is required.');
  }
  if (!(promotionQuantile > 0 && promotionQuantile <= 1)) {
    throw new InvalidFunnelInputError('runRoundOneScreening: "promotionQuantile" must be in (0, 1].');
  }
  const scored = candidates.map((c) => ({ candidate: c, score: scoreFn(c) }));
  scored.sort((a, b) => b.score - a.score);
  const promoteCount = Math.max(1, Math.ceil(scored.length * promotionQuantile));
  const promoted = scored.slice(0, promoteCount).map((s) => s.candidate);
  return { evaluated: candidates.length, promotedCount: promoted.length, promoted };
}

// ── Round 2: intermediate validation + registration ────────────────────

/**
 * For each Round-1 survivor, runs `intermediateTestFn(candidate) -> {
 * pValue }` (a cheap permutation estimate — the architecture doc's "k≈50-
 * 200 permutations," caller-supplied, e.g. via
 * statistics/permutationTest.js's computeCircularShiftPermutationTest with
 * a small `permutations` value). Candidates with pValue < alpha are, and
 * ONLY they are, registered — this is the point in the funnel where
 * preregistration of an INSTANCE actually happens, always after Round 1's
 * cut, matching the architecture doc's Section 2 exactly. `buildRegistrationSpec(candidate)`
 * must return a full hypothesisRegistry.registerHypothesis() spec object.
 * Survivors are additionally linked into the Knowledge Graph (Requirement
 * 9) — representation family, search space version, and campaign
 * membership — and advanced one lifecycle stage (Registration ->
 * FeatureGeneration).
 */
export async function runRoundTwoValidation({
  candidates,
  intermediateTestFn,
  buildRegistrationSpec,
  alpha = 0.05,
  representationFamilyId,
  searchSpaceVersionId,
  campaignId,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new InvalidFunnelInputError('runRoundTwoValidation: "candidates" must be a non-empty array.');
  }
  if (typeof intermediateTestFn !== 'function' || typeof buildRegistrationSpec !== 'function') {
    throw new InvalidFunnelInputError('runRoundTwoValidation: "intermediateTestFn" and "buildRegistrationSpec" are required.');
  }

  const registered = [];
  for (const candidate of candidates) {
    const { pValue } = await intermediateTestFn(candidate);
    if (!(Number.isFinite(pValue) && pValue < alpha)) continue;

    const spec = await buildRegistrationSpec(candidate);
    const registration = await registerHypothesis(spec);
    const hypothesisId = registration.hypothesisId;

    if (representationFamilyId) await linkHypothesisToRepresentationFamily(hypothesisId, representationFamilyId);
    if (searchSpaceVersionId) await linkHypothesisToSearchSpaceVersion(hypothesisId, searchSpaceVersionId);
    if (campaignId) await linkHypothesisToCampaign(hypothesisId, campaignId);

    await advanceLifecycleStage(hypothesisId, 'FeatureGeneration', { reason: 'Round 2 intermediate validation cleared; features already computed for the tested candidate.' });

    registered.push({ candidate, hypothesisId, pValue });
  }

  if (campaignId) {
    await recordCampaignRoundMetric({ campaignId, round: 2, evaluated: candidates.length, promoted: registered.length });
  }

  return { evaluated: candidates.length, promotedCount: registered.length, registered };
}

// ── Round 3: deep validation (the ONLY round that spends statistical error budget) ─

/**
 * For each Round-2 registered hypothesis, advances it to the Discovery
 * lifecycle stage and calls discoveryDecision.evaluateDiscoveryCandidate —
 * THE single authoritative Discovery gate, unchanged, un-wrapped in any
 * new decision logic. `deepTestFn(item) -> { pValue }` OR
 * `discoveryKeyFn(item) -> discoveryKey` (mutually exclusive per item;
 * when discoveryKeyFn resolves a key, evaluateDiscoveryCandidate resolves
 * the REAL p-value from legacy's own completed discovery evidence exactly
 * as it already does when called directly with a discoveryKey — see
 * discoveryDecision.js). A candidate the wealth process rejects (its
 * `rejected` field — onlineFdr.js's naming: `rejected: true` means the
 * NULL hypothesis was rejected, i.e., this IS a discovery, survives to
 * Round 4; `rejected: false` means it did NOT clear FDR and is eliminated
 * here) gets a permanent recordScreenedNotPromoted edge and stays at the
 * Discovery lifecycle stage. A survivor is advanced to Replication.
 */
export async function runRoundThreeDeepValidation({
  registered,
  familyKey,
  deepTestFn,
  discoveryKeyFn,
  testMethod,
  representationFamilyId,
  campaignId,
} = {}) {
  if (!Array.isArray(registered) || registered.length === 0) {
    throw new InvalidFunnelInputError('runRoundThreeDeepValidation: "registered" must be a non-empty array (Round 2 output).');
  }
  if (!familyKey) {
    throw new InvalidFunnelInputError('runRoundThreeDeepValidation: "familyKey" is required.');
  }
  if (typeof deepTestFn !== 'function' && typeof discoveryKeyFn !== 'function') {
    throw new InvalidFunnelInputError('runRoundThreeDeepValidation: either "deepTestFn" or "discoveryKeyFn" is required.');
  }

  const survivors = [];
  const eliminated = [];
  for (const item of registered) {
    const hypothesisId = item.hypothesisId;
    await advanceLifecycleStage(hypothesisId, 'Discovery', { reason: 'Entering Round 3 deep validation.' });

    let discoveryResult;
    if (discoveryKeyFn) {
      const discoveryKey = await discoveryKeyFn(item);
      discoveryResult = await evaluateDiscoveryCandidate({ hypothesisId, familyKey, discoveryKey, testMethod });
    } else {
      const { pValue } = await deepTestFn(item);
      discoveryResult = await evaluateDiscoveryCandidate({ hypothesisId, familyKey, pValue, testMethod });
    }

    if (discoveryResult.rejected) {
      await advanceLifecycleStage(hypothesisId, 'Replication', { reason: 'Round 3 cleared Family Online FDR wealth.' });
      survivors.push({ ...item, discoveryResult });
    } else {
      if (representationFamilyId) {
        await recordScreenedNotPromoted({ hypothesisId, round: 3, reason: 'Did not clear Family Online FDR wealth (Round 3).', representationFamilyId });
      }
      eliminated.push({ ...item, discoveryResult });
    }
  }

  if (campaignId) {
    await recordCampaignRoundMetric({ campaignId, round: 3, evaluated: registered.length, promoted: survivors.length });
  }

  return { evaluated: registered.length, promotedCount: survivors.length, survivors, eliminated };
}

// ── Round 4: replication (Lockbox — write-once, one draw per candidate) ──

/**
 * For each Round-3 survivor, advances the hypothesis to the Lockbox
 * lifecycle stage (required precondition for lockbox.allocateLockboxHoldout
 * — enforced by that function itself, unchanged here) and allocates a
 * holdout. `buildLockboxRequest(item) -> { featureKey, generation,
 * holdoutRange, allocatedBy }`. When `consumeEvidenceFn` is supplied, the
 * allocation is immediately consumed with the evidence it returns (the
 * one-shot, write-once replication check) — omitted, an allocation is
 * left pending consumption by a later, separate call (a caller may want
 * to allocate now and consume once real Lockbox tick data actually
 * arrives, matching this codebase's own disclosed live/browser-data
 * boundary).
 */
export async function runRoundFourReplication({
  survivors,
  buildLockboxRequest,
  consumeEvidenceFn,
  replicationCampaignId,
} = {}) {
  if (!Array.isArray(survivors) || survivors.length === 0) {
    throw new InvalidFunnelInputError('runRoundFourReplication: "survivors" must be a non-empty array (Round 3 output).');
  }
  if (typeof buildLockboxRequest !== 'function') {
    throw new InvalidFunnelInputError('runRoundFourReplication: "buildLockboxRequest" is required.');
  }

  const results = [];
  for (const item of survivors) {
    const hypothesisId = item.hypothesisId;
    await advanceLifecycleStage(hypothesisId, 'Lockbox', { reason: 'Entering Round 4 replication.' });

    const request = await buildLockboxRequest(item);
    const allocation = await allocateLockboxHoldout({ hypothesisId, ...request });

    let consumption = null;
    if (consumeEvidenceFn) {
      const evidence = await consumeEvidenceFn(item, allocation.record);
      consumption = await consumeLockboxHoldout({ id: allocation.record.id, ...evidence });
    }

    if (replicationCampaignId) {
      await linkHypothesisToCampaign(hypothesisId, replicationCampaignId, { replication: true });
    }

    results.push({ ...item, allocation, consumption });
  }

  if (replicationCampaignId) {
    await recordCampaignRoundMetric({ campaignId: replicationCampaignId, round: 4, evaluated: survivors.length, promoted: results.length });
  }

  return { evaluated: survivors.length, results };
}
