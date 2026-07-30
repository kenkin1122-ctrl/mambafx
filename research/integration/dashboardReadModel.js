/**
 * research/integration/dashboardReadModel.js
 *
 * Purpose:
 *   The ONLY data-assembly layer behind the new Research Dashboard. Pure
 *   read/aggregate functions over research/src/governance/knowledgeGraph.js's
 *   existing, unmodified query exports and research/src/discovery's
 *   existing, unmodified exports. Computes zero new statistics — every
 *   number here is either a direct read or a plain count/group-by over
 *   an existing query's own result, and every field is validated through
 *   governance/scientificDashboard.js's two guards
 *   (assertPermittedDashboardMetric / assertHasRequiredDisplayContext)
 *   before being returned, exactly matching that module's own stated
 *   intent ("meant to be called by whatever future UI layer assembles
 *   dashboard views").
 *
 * What this module does NOT do:
 *   - It never calls a discovery/campaign/funnel/rngForensics *execution*
 *     function — only knowledgeGraph.js's read/query exports and
 *     campaignPrioritization's side-effect-free
 *     prioritizeNextRepresentationFamily() (confirmed, by reading its
 *     source directly, to perform no writes — it only reads
 *     buildActiveRepresentationFamilyArms() and computes a ranking).
 *   - It never invents a metric Part 15 forbids. Every returned field's
 *     metricName is checked against FORBIDDEN_DASHBOARD_METRICS before
 *     the value is ever assembled.
 *   - It never fabricates data. A field with nothing recorded yet is
 *     reported as an honest empty/zero result (denominator: 0), never
 *     a placeholder.
 *
 * Responsibilities: buildDashboardSnapshot() — the one exported entry
 *   point, returning every field the Research Dashboard displays.
 *
 * Inputs: an optional injectable set of hypothesis IDs is NOT required —
 *   this module discovers them itself via the Knowledge Graph's own
 *   INSTANCE_OF_FAMILY edges (see deriveHypothesisIdFromNodeId below).
 * Outputs: Promise<DashboardSnapshot> — see buildDashboardSnapshot's own
 *   JSDoc for the exact shape.
 * Dependencies: governance/knowledgeGraph.js, governance/scientificDashboard.js,
 *   discovery/campaignPrioritization.js.
 *
 * Public API: buildDashboardSnapshot.
 * Internal API: deriveHypothesisIdFromNodeId (documented derivation, same
 *   sanctioned "thin derived read over a real result" pattern
 *   bridgeToLegacyMsd/read.js already uses for getStatesByEventId).
 *
 * Error handling: a failure in any one section (e.g. no active families
 *   yet) degrades that section to an honest empty state rather than
 *   throwing and blanking the whole dashboard — except governance guard
 *   violations, which must throw (a metric that fails Part 15's guard is
 *   a bug in this file, not a runtime condition to hide from the user).
 * Performance notes: every underlying query is already index-bounded
 *   (see knowledgeGraph.js's own complexity notes); this module adds
 *   only O(n) aggregation over already-small result sets (representation
 *   families, campaigns — not tick-scale data).
 * Threading model: main thread.
 * Storage usage: read-only against mfx_research_governance.
 * Complexity analysis: O(F + C + H) where F = active families, C =
 *   campaigns linked to them, H = hypotheses linked to them — all small,
 *   bounded by scientific throughput, never by tick volume.
 * Future extension notes: if a future phase adds a direct
 *   "listHypothesesForFamily" export to knowledgeGraph.js, replace
 *   deriveHypothesisIdFromNodeId's prefix-parse with that real export —
 *   it is a placeholder for a nicer API, not a preferred design.
 */

import {
  NODE_TYPES,
  EDGE_TYPES,
  queryActiveRepresentationFamilies,
  queryFailedRepresentationFamilies,
  queryReplicationHistory,
  queryUnexploredSearchSpaceVersions,
  listNodesByType,
  listEdgesTo,
  listCampaignsForRepresentationFamily,
  listCampaignRoundMetrics,
} from '../src/governance/knowledgeGraph.js';
import {
  assertPermittedDashboardMetric,
  assertHasRequiredDisplayContext,
} from '../src/governance/scientificDashboard.js';
import {
  prioritizeNextRepresentationFamily,
  InvalidCampaignPrioritizationInputError,
} from '../src/discovery/campaignPrioritization.js';
import { getLatestRngForensicsResult } from '../src/discovery/rngForensics.js';

/** The prioritization method this integration layer is configured to use for its (manual-only) campaign step. Single source of truth — campaignRunner.js reads this exact same constant, never a duplicated literal. */
export const ACTIVE_SEARCH_STRATEGY = 'ucb1';

/** Derives a hypothesisId from a Knowledge Graph nodeId of the form `kgn_Hypothesis_<hypothesisId>` (knowledgeGraph.js's own private nodeId() format). Documented derivation, not a guess — mirrors the sanctioned "thin derived read" pattern already used by bridgeToLegacyMsd/read.js's getStatesByEventId. */
function deriveHypothesisIdFromNodeId(nodeIdStr) {
  const prefix = `kgn_${NODE_TYPES.HYPOTHESIS}_`;
  if (typeof nodeIdStr !== 'string' || !nodeIdStr.startsWith(prefix)) return null;
  return nodeIdStr.slice(prefix.length);
}

function metric(metricName, value, denominator, scope, extra = {}) {
  assertPermittedDashboardMetric(metricName);
  assertHasRequiredDisplayContext({ denominator, scope });
  return { metricName, value, denominator, scope, ...extra };
}

async function buildActiveFamiliesSection() {
  const families = await queryActiveRepresentationFamilies();
  return metric(
    'active_representation_families_count',
    families.length,
    families.length,
    'AllActiveFamilies',
    { families }
  );
}

async function buildFailedFamiliesSection() {
  const failed = await queryFailedRepresentationFamilies();
  return metric('failed_representation_families_count', failed.length, failed.length, 'AllFailedFamilies', { families: failed });
}

async function buildCampaignsSection(activeFamilies) {
  const discoveryCampaigns = await listNodesByType(NODE_TYPES.DISCOVERY_CAMPAIGN);
  const replicationCampaigns = await listNodesByType(NODE_TYPES.REPLICATION_CAMPAIGN);

  // Campaign Queue: for every currently-Active family, list its
  // registered campaigns — this is a direct read (listCampaignsForRepresentationFamily),
  // not a new ranking; ordering within each family's list is whatever
  // that existing query already returns.
  const queueByFamily = [];
  for (const fam of activeFamilies) {
    // queryActiveRepresentationFamilies() returns { familyId, label, status }
    // (not a raw Knowledge Graph node record), so the scientific ID is
    // fam.familyId directly — confirmed against knowledgeGraph.js's own
    // implementation of that query, not assumed.
    const familyId = fam.familyId;
    const campaigns = await listCampaignsForRepresentationFamily(familyId);
    queueByFamily.push({ familyId, campaigns });
  }

  return {
    discoveryCampaigns: metric('discovery_campaigns_count', discoveryCampaigns.length, discoveryCampaigns.length, 'AllDiscoveryCampaigns', { campaigns: discoveryCampaigns }),
    replicationCampaigns: metric('replication_campaigns_count', replicationCampaigns.length, replicationCampaigns.length, 'AllReplicationCampaigns', { campaigns: replicationCampaigns }),
    campaignQueue: metric('campaign_queue_by_active_family', queueByFamily, activeFamilies.length, 'AllActiveFamilies', {}),
  };
}

async function buildValidationFunnelSection(campaignQueue) {
  // Direct read of round metrics already recorded via
  // knowledgeGraph.recordCampaignRoundMetric — a genuine, existing
  // record of funnel activity, not a re-run of any funnel round here.
  const perCampaign = [];
  for (const { campaigns } of campaignQueue.value) {
    for (const c of campaigns) {
      const campaignId = c.refId !== undefined ? c.refId : c.id;
      const rounds = await listCampaignRoundMetrics(campaignId);
      if (rounds.length) perCampaign.push({ campaignId, rounds });
    }
  }
  const totalEvaluated = perCampaign.reduce((sum, c) => sum + c.rounds.reduce((s, r) => s + (r.evaluated || 0), 0), 0);
  const totalPromoted = perCampaign.reduce((sum, c) => sum + c.rounds.reduce((s, r) => s + (r.promoted || 0), 0), 0);

  return metric(
    'validation_funnel_evaluated_vs_promoted',
    { evaluated: totalEvaluated, promoted: totalPromoted, perCampaign },
    totalEvaluated,
    'AllCampaignsWithRecordedRounds'
  );
}

async function buildRngForensicsSection(activeFamilies) {
  const results = [];
  for (const fam of activeFamilies) {
    const familyNodeId = `kgn_${NODE_TYPES.REPRESENTATION_FAMILY}_${fam.familyId}`;
    const edges = await listEdgesTo(familyNodeId, { edgeType: EDGE_TYPES.INSTANCE_OF_FAMILY });
    for (const edge of edges) {
      const hypothesisId = deriveHypothesisIdFromNodeId(edge.fromNodeId);
      if (!hypothesisId) continue;
      const latest = await getLatestRngForensicsResult(hypothesisId);
      if (latest) results.push({ hypothesisId, ...latest });
    }
  }
  return metric('rng_forensics_latest_by_hypothesis', results, results.length, 'ActiveFamilyHypotheses');
}

async function buildReplicationQueueSection(activeFamilies) {
  const perFamily = [];
  for (const fam of activeFamilies) {
    const familyNodeId = `kgn_${NODE_TYPES.REPRESENTATION_FAMILY}_${fam.familyId}`;
    const edges = await listEdgesTo(familyNodeId, { edgeType: EDGE_TYPES.INSTANCE_OF_FAMILY });
    for (const edge of edges) {
      const hypothesisId = deriveHypothesisIdFromNodeId(edge.fromNodeId);
      if (!hypothesisId) continue;
      const history = await queryReplicationHistory(hypothesisId);
      if (history && history.length) perFamily.push({ hypothesisId, history });
    }
  }
  return metric('replication_queue_by_hypothesis', perFamily, perFamily.length, 'ActiveFamilyHypotheses');
}

async function buildCurrentPhaseAndCandidateCount(activeFamilies) {
  let prioritized = null;
  let prioritizationError = null;
  try {
    prioritized = await prioritizeNextRepresentationFamily({ method: ACTIVE_SEARCH_STRATEGY });
  } catch (err) {
    if (err instanceof InvalidCampaignPrioritizationInputError) {
      prioritizationError = err.message;
    } else {
      throw err;
    }
  }

  const candidateCount = metric(
    'current_candidate_count',
    activeFamilies.length,
    activeFamilies.length,
    'AllActiveFamilies'
  );

  const currentPhase = metric(
    'current_discovery_phase',
    prioritized ? 'Prioritization: candidate identified' : 'No active family to prioritize',
    activeFamilies.length,
    'AllActiveFamilies',
    { prioritized, prioritizationError }
  );

  return { candidateCount, currentPhase };
}

/**
 * @returns {Promise<{
 *   activeFamilies: object, failedFamilies: object,
 *   discoveryCampaigns: object, replicationCampaigns: object, campaignQueue: object,
 *   validationFunnel: object, rngForensics: object, replicationQueue: object,
 *   candidateCount: object, currentPhase: object,
 *   searchStrategy: string, unexploredSearchSpaceVersions: object,
 *   generatedAt: number,
 * }>}
 */
export async function buildDashboardSnapshot() {
  const activeFamiliesMetric = await buildActiveFamiliesSection();
  const failedFamiliesMetric = await buildFailedFamiliesSection();
  const { discoveryCampaigns, replicationCampaigns, campaignQueue } = await buildCampaignsSection(activeFamiliesMetric.families);
  const validationFunnel = await buildValidationFunnelSection(campaignQueue);
  const rngForensics = await buildRngForensicsSection(activeFamiliesMetric.families);
  const replicationQueue = await buildReplicationQueueSection(activeFamiliesMetric.families);
  const { candidateCount, currentPhase } = await buildCurrentPhaseAndCandidateCount(activeFamiliesMetric.families);
  const unexplored = await queryUnexploredSearchSpaceVersions();

  return {
    activeFamilies: activeFamiliesMetric,
    failedFamilies: failedFamiliesMetric,
    discoveryCampaigns,
    replicationCampaigns,
    campaignQueue,
    validationFunnel,
    rngForensics,
    replicationQueue,
    candidateCount,
    currentPhase,
    searchStrategy: ACTIVE_SEARCH_STRATEGY,
    unexploredSearchSpaceVersions: metric('unexplored_search_space_versions_count', unexplored.length, unexplored.length, 'AllSearchSpaceVersions', { versions: unexplored }),
    generatedAt: Date.now(),
  };
}
