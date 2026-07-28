/**
 * research/src/discovery/campaignPrioritization.js
 *
 * Purpose:
 *   Implement Phase 9's "Adaptive Campaign Prioritization" requirement:
 *   wire Knowledge Graph history (discovery/funnel.js's own recorded
 *   campaign metrics and elimination records, read via
 *   governance/knowledgeGraph.js's Requirement 9 extension) into
 *   discovery/searchEngine.js's bandit policies, so that WHERE the funnel
 *   spends its next unit of Round 1/2 budget is informed by what has
 *   already been tried — without that history ever influencing a
 *   statistical decision.
 *
 * ABSOLUTE GOVERNING RULE, restated a third time in this Phase 9 delivery
 *   because it is the single most important property of this subsystem:
 *   this module imports ONLY governance/knowledgeGraph.js (read) and
 *   discovery/searchEngine.js (ranking). It does NOT import onlineFdr.js,
 *   discoveryDecision.js, or publicationStatus.js — checkable by reading
 *   this file's own import list, not just by convention. History read
 *   here may only ever change WHERE the next candidate comes from, never
 *   WHETHER something is a discovery.
 *
 * Representation Family exclusion (Requirement 9's core mechanism, made
 *   operational here): buildActiveRepresentationFamilyArms below reads
 *   ONLY families whose current status is Active (queryActiveRepresentationFamilies)
 *   — a Rejected or Retired family is not merely down-weighted, it is
 *   ABSENT from the arm set entirely, which is the concrete mechanism that
 *   turns "null result -> reject representation family -> stop spending
 *   compute there" from a stated principle (architecture doc, "Governing
 *   Principle") into an enforced allocation rule.
 *
 * Responsibilities:
 *   - computeRepresentationFamilyArmStatistics(familyId): aggregates every
 *     Discovery/Replication Campaign's recorded round metrics
 *     (knowledgeGraph.listCampaignsForRepresentationFamily +
 *     listCampaignRoundMetrics) into one bandit-arm-shaped
 *     {totalReward, pulls} summary — reused by both bandit policies below.
 *   - buildActiveRepresentationFamilyArms(): the Active-only arm set.
 *   - prioritizeNextRepresentationFamily({method, seed?}): calls
 *     searchEngine.selectNextArmUcb1 or selectNextArmThompson over that
 *     arm set — "look here next," nothing else.
 *   - rankFeatureFamiliesByPromise(): reads
 *     knowledgeGraph.queryFeatureFamilyOutcomeStats() and ranks the
 *     canonical Feature Families by ascending elimination rate (families
 *     with no evidence yet are ranked as maximally worth exploring,
 *     ahead of families with an observed high elimination rate) — answers
 *     "which feature families are worth generating more candidates from."
 *
 * Inputs: representation family / feature family identifiers already
 *   registered in the Knowledge Graph.
 * Outputs: rankings/selections only (see searchEngine.js's own governing
 *   rule, inherited unchanged here).
 * Dependencies: governance/knowledgeGraph.js (read), discovery/searchEngine.js
 *   (ranking).
 *
 * Public API: InvalidCampaignPrioritizationInputError,
 *   computeRepresentationFamilyArmStatistics,
 *   buildActiveRepresentationFamilyArms, prioritizeNextRepresentationFamily,
 *   rankFeatureFamiliesByPromise.
 * Internal API: none.
 *
 * Error handling: InvalidCampaignPrioritizationInputError for malformed
 *   input; propagates knowledgeGraph.js's own UnknownNodeReferenceError
 *   unchanged for an unregistered familyId.
 * Performance notes: bounded by the number of ACTIVE representation
 *   families and their scoped campaigns — never a full Knowledge Graph
 *   scan across all history, since queryActiveRepresentationFamilies
 *   itself is bounded by listNodesByType(REPRESENTATION_FAMILY), a single
 *   node type's population, not the whole graph.
 * Threading model: no shared mutable state.
 * Storage usage: none directly — reads only, through knowledgeGraph.js.
 * Complexity analysis: O(F * C) where F = active representation families,
 *   C = campaigns per family — small by construction (campaigns are
 *   created per representation family per funnel run, not per candidate).
 * Future extension notes: a new prioritization signal (e.g., a per-
 *   Feature-Family bandit rather than a static ranking) is a new exported
 *   function following the same "read knowledgeGraph.js, rank via
 *   searchEngine.js, nothing else" shape.
 */

import {
  queryActiveRepresentationFamilies,
  listCampaignsForRepresentationFamily,
  listCampaignRoundMetrics,
  queryFeatureFamilyOutcomeStats,
} from '../governance/knowledgeGraph.js';
import {
  selectNextArmUcb1,
  selectNextArmThompson,
  InvalidSearchEngineInputError,
} from './searchEngine.js';

export class InvalidCampaignPrioritizationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCampaignPrioritizationInputError';
  }
}

/**
 * Aggregates every campaign scoped to `familyId` into one bandit-arm
 * summary: `pulls` = total candidates evaluated across every recorded
 * round of every scoped campaign; `totalReward` = total candidates
 * promoted. This is an EMPIRICAL hit rate over the funnel's own recorded
 * history — not a new statistic, a sum of numbers funnel.js already wrote
 * via knowledgeGraph.recordCampaignRoundMetric.
 */
export async function computeRepresentationFamilyArmStatistics(familyId) {
  const campaigns = await listCampaignsForRepresentationFamily(familyId);
  let pulls = 0;
  let totalReward = 0;
  for (const campaign of campaigns) {
    const metrics = await listCampaignRoundMetrics(campaign.refId);
    for (const m of metrics) {
      if (Number.isFinite(m.evaluated)) pulls += m.evaluated;
      if (Number.isFinite(m.promoted)) totalReward += m.promoted;
    }
  }
  return { armId: familyId, pulls, totalReward };
}

/**
 * The Active-only arm set — see this module's header for why exclusion
 * (not down-weighting) is the mechanism here.
 */
export async function buildActiveRepresentationFamilyArms() {
  const activeFamilies = await queryActiveRepresentationFamilies();
  const arms = [];
  for (const family of activeFamilies) {
    const stats = await computeRepresentationFamilyArmStatistics(family.familyId);
    arms.push({ ...stats, label: family.label });
  }
  return arms;
}

/**
 * "Look here next" among currently-Active representation families only.
 * `method`: 'ucb1' (default, deterministic given the same history) or
 * 'thompson' (requires `seed`, stochastic).
 */
export async function prioritizeNextRepresentationFamily({ method = 'ucb1', seed } = {}) {
  const arms = await buildActiveRepresentationFamilyArms();
  if (arms.length === 0) {
    throw new InvalidCampaignPrioritizationInputError(
      'prioritizeNextRepresentationFamily: no Active Representation Family exists to prioritize among — ' +
      'every registered family has been Rejected or Retired. A new representation family must be registered before further exploration.'
    );
  }
  if (method === 'thompson') {
    if (typeof seed !== 'number') {
      throw new InvalidCampaignPrioritizationInputError('prioritizeNextRepresentationFamily: method "thompson" requires a numeric "seed".');
    }
    const bernoulliArms = arms.map((a) => ({
      armId: a.armId,
      successes: a.totalReward,
      failures: Math.max(0, a.pulls - a.totalReward),
    }));
    const selection = selectNextArmThompson(bernoulliArms, seed);
    return { ...selection, arms };
  }
  if (method !== 'ucb1') {
    throw new InvalidCampaignPrioritizationInputError(`prioritizeNextRepresentationFamily: unknown method "${method}" (expected "ucb1" or "thompson").`);
  }
  try {
    const selection = selectNextArmUcb1(arms);
    return { ...selection, arms };
  } catch (err) {
    if (err instanceof InvalidSearchEngineInputError) {
      throw new InvalidCampaignPrioritizationInputError(err.message);
    }
    throw err;
  }
}

/**
 * Static ranking (not a bandit — a snapshot report) of every canonical
 * Feature Family by ascending elimination rate, i.e. most-promising-to-
 * explore first. A family with no observations yet (eliminationRate ===
 * null) is ranked ahead of any family with a recorded non-zero elimination
 * rate — untested is treated as more worth exploring than "tested and
 * mostly failed," matching the architecture doc's Section 3 recommendation
 * that Round 1/2 breadth be prioritized while the search has not yet found
 * a promising region.
 */
export async function rankFeatureFamiliesByPromise() {
  const stats = await queryFeatureFamilyOutcomeStats();
  return Object.entries(stats)
    .map(([family, s]) => ({ family, ...s }))
    .sort((a, b) => {
      if (a.eliminationRate === null && b.eliminationRate === null) return 0;
      if (a.eliminationRate === null) return -1;
      if (b.eliminationRate === null) return 1;
      return a.eliminationRate - b.eliminationRate;
    });
}
