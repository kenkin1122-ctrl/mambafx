/**
 * research/integration/phase9CampaignOrchestrator.js
 *
 * Phase 9 Adaptive Scientific Discovery Engine — end-to-end campaign orchestrator.
 *
 * Wires the ncf_v1 MarketState dataset into the 4-round Sequential Elimination
 * Funnel (research/src/discovery/funnel.js), registers discoveries in the
 * Knowledge Graph, and allocates Lockbox holdouts for Round 3 survivors.
 *
 * Caller-supplied statistical functions are sourced from the MSD engine globals
 * in index.html's classic script: msdGetAllMarketStates, msdBuildNcSnapshotRows,
 * msdMaterializeCandidateFeature, msdMutualInformation,
 * msdSingleFeatureMIPermutationTest, msdEvaluateCandidateStatistically.
 *
 * ABSOLUTE GOVERNING RULE (inherited from funnel.js): this module contains zero
 * statistical or governance logic itself. Every statistical primitive is
 * caller-supplied (from the MSD engine globals); every governance action
 * (hypothesis registration, FDR wealth, Knowledge Graph writes, Lockbox
 * allocation) flows through research/src/governance/*.js unchanged.
 *
 * Public API: bootstrapKnowledgeGraph, generateCandidates, runPhase9Campaign.
 */

import {
  registerRepresentationFamily,
  registerSearchSpaceVersion,
  registerDiscoveryCampaign,
  getNode,
  NODE_TYPES,
} from '../src/governance/knowledgeGraph.js';

import {
  runRoundOneScreening,
  runRoundTwoValidation,
  runRoundThreeDeepValidation,
  runRoundFourReplication,
} from '../src/discovery/funnel.js';

import { TEST_METHODS } from '../src/governance/onlineFdr.js';

// ── Campaign constants ─────────────────────────────────────────────────────

/** Representation family ID — shared with the Knowledge Graph's Phase 9 extension. */
export const PH9_FAMILY_ID        = 'non_classical';
/** Search space version ID — seeds from the Phase 8 sealed search space. */
export const PH9_SEARCH_SPACE_ID  = 'phase8_search_space_v1';
/** Discovery campaign ID for this Phase 9 run series. */
export const PH9_CAMPAIGN_ID      = 'ph9_discovery_campaign_v1';
/** Family key passed to evaluateDiscoveryCandidate — must match an existing FDR family. */
const PH9_FAMILY_KEY              = 'non_classical';
/** Generation number for Lockbox allocation (one generation = one systematic sweep). */
const PH9_GENERATION              = 1;

// Round budgets
const PH9_R1_QUANTILE    = 0.20;   // promote top 20% in Round 1 (~22 of 112)
const PH9_R2_ALPHA       = 0.10;   // liberal pre-screen gate in Round 2
const PH9_R2_PERMUTATIONS = 100;   // cheap: 100 shuffles for Round 2
const PH9_R3_PERMUTATIONS = 1000;  // deep: 1 000 shuffles for Round 3 (same as Phase 8)
const PH9_R3_SEED        = 42;     // deterministic seed for reproducibility

// ncf_v1 feature fallback — used if window.MSD_PHASE7B_INDIVIDUAL_FEATURES is unavailable
const NCF_V1_FEATURES = Object.freeze([
  'ncf_netDisplacement', 'ncf_absPathLength', 'ncf_pathEfficiency',
  'ncf_mfe',             'ncf_mae',
  'ncf_upTickCount',     'ncf_downTickCount',  'ncf_dirImbalance',
  'ncf_currentRunLen',   'ncf_maxRunLen',       'ncf_reversalCount',
  'ncf_stdFirstDiff',    'ncf_meanSecondDiff',
  'ncf_dirEntropy',      'ncf_runEntropy',      'ncf_permEntropy3',
]);

// ── Knowledge Graph bootstrap ──────────────────────────────────────────────

/** Silently attempt to get a node; returns null if absent or on any error. */
async function tryGetNode(nodeType, refId) {
  try {
    const node = await getNode(nodeType, refId);
    return node ?? null;
  } catch {
    return null;
  }
}

/** Try to create; if a ConstraintError / duplicate fires, ignore it. */
async function tryCreate(createFn) {
  try {
    await createFn();
  } catch (e) {
    if (!isConstraintError(e)) throw e;
    // Already exists — harmless on idempotent re-runs.
  }
}

function isConstraintError(e) {
  if (!e) return false;
  const tag = (e.name || '') + (e.message || '');
  return tag.includes('ConstraintError') || tag.includes('already exists');
}

/**
 * Idempotent: ensures the representation family, search space version, and
 * discovery campaign nodes required for Phase 9 exist in the Knowledge Graph.
 * Safe to call on every campaign execution — no-ops if all three exist.
 *
 * @returns {{ familyId, searchSpaceVersionId, campaignId }}
 */
export async function bootstrapKnowledgeGraph() {
  // 1. Representation family (Phase 9 extension node type)
  if (!(await tryGetNode(NODE_TYPES.REPRESENTATION_FAMILY, PH9_FAMILY_ID))) {
    await tryCreate(() => registerRepresentationFamily({
      familyId: PH9_FAMILY_ID,
      label: 'Non-Classical Features (ncf_v1)',
      description:
        '16-feature family derived from 20-tick raw price histories. ' +
        'Phase 8 exhaustively tested 80 pre-registered hypotheses and found a ' +
        'statistically valid null result. Phase 9 explores the same feature ' +
        'space adaptively via the 4-round Sequential Elimination Funnel.',
    }));
  }

  // 2. Search space version (seeds from the Phase 8 sealed search space)
  if (!(await tryGetNode(NODE_TYPES.SEARCH_SPACE_VERSION, PH9_SEARCH_SPACE_ID))) {
    await tryCreate(() => registerSearchSpaceVersion({
      versionId: PH9_SEARCH_SPACE_ID,
      label: 'Phase 8 Search Space v1 (ncf_v1, 16 features)',
      metadata: {
        featureFamily: PH9_FAMILY_ID,
        featureVersion: 'ncf_v1',
        numFeatures: NCF_V1_FEATURES.length,
        sourceProtocol: 'phase8_official_nc_campaign_v1',
      },
    }));
  }

  // 3. Discovery campaign node
  if (!(await tryGetNode(NODE_TYPES.DISCOVERY_CAMPAIGN, PH9_CAMPAIGN_ID))) {
    await tryCreate(() => registerDiscoveryCampaign({
      campaignId: PH9_CAMPAIGN_ID,
      label: 'Phase 9 Adaptive Discovery Campaign v1',
      representationFamilyId: PH9_FAMILY_ID,
      metadata: {
        protocol: 'sequential_elimination_funnel_v1',
        rounds: 4,
        featureVersion: 'ncf_v1',
        r1Quantile: PH9_R1_QUANTILE,
        r2Alpha: PH9_R2_ALPHA,
        r3Permutations: PH9_R3_PERMUTATIONS,
      },
    }));
  }

  return {
    familyId: PH9_FAMILY_ID,
    searchSpaceVersionId: PH9_SEARCH_SPACE_ID,
    campaignId: PH9_CAMPAIGN_ID,
  };
}

// ── Candidate generation ───────────────────────────────────────────────────

/**
 * Generates Phase 9 candidates from NC-eligible snapshot rows.
 *
 * For each of the 16 ncf_v1 features:
 *   - 1 raw-feature candidate  (MI of continuous values vs binary outcome)
 *   - 6 threshold candidates   (25 / 50 / 75th percentile × above / below)
 * Total: 16 × 7 = 112 candidates for the first systematic sweep.
 *
 * @param {object[]} rows - NC-eligible, certain-label snapshot rows
 *   (output of msdBuildNcSnapshotRows with filterCertainOnly:true)
 * @returns {object[]} Candidate objects ready for runRoundOneScreening.
 */
export function generateCandidates(rows) {
  const features =
    (typeof window !== 'undefined' && Array.isArray(window.MSD_PHASE7B_INDIVIDUAL_FEATURES))
      ? Array.from(window.MSD_PHASE7B_INDIVIDUAL_FEATURES)
      : Array.from(NCF_V1_FEATURES);

  const candidates = [];

  for (const featureKey of features) {
    // Collect finite values and sort for percentile computation
    const vals = rows
      .map(r => r[featureKey])
      .filter(v => typeof v === 'number' && isFinite(v))
      .sort((a, b) => a - b);

    if (vals.length < 10) continue; // too few values — skip this feature

    // ── Raw feature candidate ────────────────────────────────────────────
    candidates.push({
      candidateKey: `ph9_v1__${featureKey}__raw`,
      features: [featureKey],
      transformation: 'raw',
      featureKey,
      testType: 'raw',
    });

    // ── Threshold candidates at 25th / 50th / 75th percentile × 2 directions
    for (const pct of [0.25, 0.50, 0.75]) {
      const idx       = Math.max(0, Math.floor(pct * vals.length) - 1);
      const threshold = vals[idx];
      for (const direction of ['above', 'below']) {
        candidates.push({
          candidateKey: `ph9_v1__${featureKey}__p${Math.round(pct * 100)}_${direction}`,
          features: [featureKey],
          transformation: 'raw',
          featureKey,
          testType: 'threshold',
          threshold,
          direction,
        });
      }
    }
  }

  return candidates;
}

// ── Internal statistical helpers ───────────────────────────────────────────

/**
 * Materializes feature values for a candidate and optionally binarizes them
 * (for threshold-type candidates). Returns null if materialization fails or
 * produces too few paired values.
 */
function materializeCandidate(rows, candidate) {
  // msdMaterializeCandidateFeature is a global from index.html's classic script.
  const mat = window.msdMaterializeCandidateFeature(rows, candidate, { maxMissingRate: 0.1 });
  if (!mat.ok || mat.values.length < 10) return null;

  let featureVals = mat.values;
  if (candidate.testType === 'threshold' && typeof candidate.threshold === 'number') {
    featureVals = mat.values.map(v =>
      candidate.direction === 'above'
        ? (v >= candidate.threshold ? 1 : 0)
        : (v <  candidate.threshold ? 1 : 0)
    );
  }

  return { featureVals, outcomes: mat.outcomes, sampleSize: mat.values.length };
}

/** Round 1 scoreFn factory — raw MI, no permutations. */
function makeScoreFn(rows) {
  return function scoreFn(candidate) {
    const m = materializeCandidate(rows, candidate);
    if (!m) return 0;
    return window.msdMutualInformation(m.featureVals, m.outcomes, 10) || 0;
  };
}

/** Round 2 intermediateTestFn factory — cheap permutation test (100 shuffles). */
function makeIntermediateTestFn(rows) {
  return async function intermediateTestFn(candidate) {
    const m = materializeCandidate(rows, candidate);
    if (!m) return { pValue: 1 };
    const observedMI = window.msdMutualInformation(m.featureVals, m.outcomes, 10);
    if (observedMI == null || observedMI <= 0) return { pValue: 1 };
    const pValue = window.msdSingleFeatureMIPermutationTest(
      m.featureVals, m.outcomes, observedMI, PH9_R2_PERMUTATIONS, /* seed */ 1
    );
    return { pValue };
  };
}

/**
 * buildRegistrationSpec factory.
 * hypothesisId is scoped to the run timestamp so repeated campaign runs
 * don't collide on a ConstraintError from hypothesisRegistry.
 */
function makeBuildRegistrationSpec(runTimestamp) {
  return async function buildRegistrationSpec(candidate) {
    const hypothesisId = `ph9_${runTimestamp}_${candidate.candidateKey}`;
    return {
      hypothesisId,
      lineageId:            `ph9_ncf_v1_lineage_gen${PH9_GENERATION}`,
      generationId:         PH9_GENERATION,
      parentIds:            [],
      familyKey:            PH9_FAMILY_KEY,
      lineageDeclaration:
        'Phase 9 Adaptive Scientific Discovery — ncf_v1 feature space, ' +
        `generation ${PH9_GENERATION}, Sequential Elimination Funnel.`,
      dataAccessAttestation: {
        attested:    true,
        attestedBy:  'ph9_campaign_orchestrator_v1',
        attestedAt:  runTimestamp,
        disclosure:
          'Round 1 (raw MI) and Round 2 (100-shuffle permutation) used the full ' +
          'NC-eligible certain dataset before this registration. This is a declared ' +
          'analytical choice of the Phase 9 protocol: Rounds 1–2 are pure filters ' +
          'that spend zero FDR budget. Round 3 is the sole test that spends Family ' +
          'Online FDR wealth and is the only test that can yield a discovery claim.',
      },
      analyticalChoiceSet: [
        'mutual_information_permutation_test',
        `feature_transformation_${candidate.transformation || 'raw'}`,
        candidate.testType === 'threshold'
          ? `threshold_${candidate.direction}_percentile_based`
          : 'raw_continuous_mi',
        'uncertainty_handling_filter_certain_only',
        'nc_eligible_only',
        `r2_alpha_${PH9_R2_ALPHA}`,
        `r3_permutations_${PH9_R3_PERMUTATIONS}`,
      ],
      reasonForCreation:
        `Phase 9 Round 2 promotion: ${candidate.candidateKey} ` +
        `(featureKey=${candidate.featureKey}, testType=${candidate.testType})`,
    };
  };
}

/**
 * Round 3 deepTestFn factory.
 * Runs the full 1000-shuffle permutation test; stores complete stats in
 * testStatsMap (keyed by hypothesisId) for display in the results UI.
 */
function makeDeepTestFn(rows, testStatsMap) {
  return async function deepTestFn(item) {
    const candidate = item.candidate;
    const m = materializeCandidate(rows, candidate);
    if (!m) {
      testStatsMap.set(item.hypothesisId, { ok: false, pValue: 1, effectSize: 0, sampleSize: 0 });
      return { pValue: 1 };
    }

    // Feed pre-materialized values into msdEvaluateCandidateStatistically
    // (avoids re-materializing; the function only needs the paired arrays).
    const syntheticMat = {
      ok:           true,
      values:       m.featureVals,
      outcomes:     m.outcomes,
      missingCount: 0,
      missingRate:  0,
    };
    const stats = window.msdEvaluateCandidateStatistically(
      syntheticMat, PH9_R3_PERMUTATIONS, PH9_R3_SEED
    );

    const entry = stats.ok
      ? { ok: true,  pValue: stats.pValue, effectSize: stats.effectSize, sampleSize: stats.sampleSize }
      : { ok: false, pValue: 1,            effectSize: 0,                sampleSize: 0 };
    testStatsMap.set(item.hypothesisId, entry);
    return { pValue: entry.pValue };
  };
}

// ── Campaign orchestrator ──────────────────────────────────────────────────

/**
 * Runs the full Phase 9 Adaptive Scientific Discovery campaign end-to-end.
 *
 * Loads allStates from the caller (use msdGetAllMarketStates() from the global
 * scope — same source as Phase 8's ph8Execute), runs all four funnel rounds,
 * and returns a structured result object for the UI renderer.
 *
 * @param {object[]} allStates  Raw MarketState records from IndexedDB.
 * @param {{ onProgress?: (event: {phase, message, ...}) => void }} [opts]
 * @returns {Promise<object>} Campaign result with per-round counts and verdict.
 */
export async function runPhase9Campaign(allStates, { onProgress = () => {} } = {}) {
  const runTimestamp = Date.now();
  const log = [];

  function progress(phase, message, extra = {}) {
    const entry = { phase, message, elapsedMs: Date.now() - runTimestamp, ...extra };
    log.push(entry);
    try { onProgress(entry); } catch { /* UI errors must not abort the campaign */ }
  }

  // ── Step 1: Bootstrap Knowledge Graph (idempotent) ────────────────────
  progress('bootstrap', 'Setting up Knowledge Graph (idempotent)…');
  const { familyId, searchSpaceVersionId, campaignId } = await bootstrapKnowledgeGraph();
  progress('bootstrap', 'Knowledge Graph ready.');

  // ── Step 2: Build NC-eligible certain-label dataset ───────────────────
  progress('dataset', 'Building NC snapshot rows from captured MarketStates…');
  const snapshotResult = window.msdBuildNcSnapshotRows(allStates, { filterCertainOnly: true });
  const rows = snapshotResult.rows;
  progress('dataset',
    `Dataset: ${allStates.length.toLocaleString()} total MarketStates · ` +
    `${snapshotResult.eligibleCount?.toLocaleString() ?? '?'} NC-eligible · ` +
    `${rows.length.toLocaleString()} NC-eligible & certain (usable).`,
    { totalStates: allStates.length, usableRows: rows.length }
  );

  if (rows.length < 30) {
    throw new Error(
      `Insufficient data: Phase 9 needs ≥30 NC-eligible certain rows, found ${rows.length}. ` +
      'Continue the live scanner to capture more MarketStates and try again.'
    );
  }

  // ── Step 3: Generate candidates ───────────────────────────────────────
  progress('candidates', 'Generating candidate hypotheses from ncf_v1 feature space…');
  const candidates = generateCandidates(rows);
  progress('candidates',
    `Generated ${candidates.length} candidates (16 features × 7: 1 raw + 6 threshold variants).`,
    { candidateCount: candidates.length }
  );

  // ── Step 4: Round 1 — cheap screening (raw MI, no permutations) ───────
  progress('round1',
    `Round 1: scoring ${candidates.length} candidates with raw MI (zero permutations, no FDR budget spent)…`
  );
  const scoreFn = makeScoreFn(rows);
  const round1  = runRoundOneScreening({
    candidates,
    scoreFn,
    promotionQuantile: PH9_R1_QUANTILE,
  });
  progress('round1',
    `Round 1 complete: ${round1.promotedCount} / ${round1.evaluated} promoted (top ${Math.round(PH9_R1_QUANTILE * 100)}% by raw MI score).`,
    { evaluated: round1.evaluated, promoted: round1.promotedCount }
  );

  if (!round1.promoted.length) {
    return buildResult({ runTimestamp, snapshotResult, candidates, round1,
      round2: null, round3: null, round4: null, log });
  }

  // ── Step 5: Round 2 — cheap permutation test + registration ──────────
  progress('round2',
    `Round 2: cheap permutation test (${PH9_R2_PERMUTATIONS} shuffles, α=${PH9_R2_ALPHA}) ` +
    `on ${round1.promotedCount} Round 1 survivors…`
  );
  const round2 = await runRoundTwoValidation({
    candidates:           round1.promoted,
    intermediateTestFn:   makeIntermediateTestFn(rows),
    buildRegistrationSpec: makeBuildRegistrationSpec(runTimestamp),
    alpha:                PH9_R2_ALPHA,
    representationFamilyId: familyId,
    searchSpaceVersionId,
    campaignId,
  });
  progress('round2',
    `Round 2 complete: ${round2.promotedCount} / ${round2.evaluated} registered as formal hypotheses.`,
    { evaluated: round2.evaluated, registered: round2.promotedCount }
  );

  if (!round2.registered.length) {
    return buildResult({ runTimestamp, snapshotResult, candidates, round1, round2,
      round3: null, round4: null, log });
  }

  // ── Step 6: Round 3 — deep validation (the ONLY round that spends FDR budget)
  progress('round3',
    `Round 3: deep permutation test (${PH9_R3_PERMUTATIONS} shuffles) + Family Online FDR gate ` +
    `on ${round2.promotedCount} registered hypotheses — THIS is the only step that spends α budget…`
  );
  const testStatsMap = new Map(); // hypothesisId → full stats for display
  const round3 = await runRoundThreeDeepValidation({
    registered:           round2.registered,
    familyKey:            PH9_FAMILY_KEY,
    deepTestFn:           makeDeepTestFn(rows, testStatsMap),
    testMethod:           TEST_METHODS.PERMUTATION,
    representationFamilyId: familyId,
    campaignId,
  });
  progress('round3',
    `Round 3 complete: ${round3.promotedCount} / ${round3.evaluated} cleared Family Online FDR gate.`,
    { evaluated: round3.evaluated, survivors: round3.promotedCount }
  );

  if (!round3.survivors.length) {
    return buildResult({ runTimestamp, snapshotResult, candidates, round1, round2, round3,
      round4: null, log, testStatsMap });
  }

  // ── Step 7: Round 4 — Lockbox allocation for replication ─────────────
  progress('round4',
    `Round 4: allocating Lockbox holdouts for ${round3.promotedCount} survivor(s)…`
  );
  const round4 = await runRoundFourReplication({
    survivors: round3.survivors,
    buildLockboxRequest: (item) => ({
      familyKey:    PH9_FAMILY_KEY,
      featureKey:   item.candidate.candidateKey, // full key — unique per candidate variant
      generation:   PH9_GENERATION,
      holdoutRange: {
        type: 'future_collection_session',
        note: 'Reserved for independent replication on the next live-data collection session.',
      },
      allocatedBy: 'ph9_campaign_orchestrator_v1',
    }),
    // consumeEvidenceFn omitted — allocate now, consume when real replication data arrives.
  });
  progress('round4',
    `Round 4 complete: ${round4.results.length} Lockbox holdout(s) allocated. ` +
    'Independent replication required before human acceptance.',
    { allocated: round4.results.length }
  );

  return buildResult({ runTimestamp, snapshotResult, candidates, round1, round2,
    round3, round4, log, testStatsMap });
}

// ── Result builder ─────────────────────────────────────────────────────────

function buildResult({ runTimestamp, snapshotResult, candidates, round1,
                       round2, round3, round4, log, testStatsMap }) {
  const survivors    = round3?.survivors ?? [];
  const hasDiscovery = survivors.some(s => s.discoveryResult?.rejected === true);

  const survivorDetails = survivors.map(s => ({
    candidateKey: s.candidate?.candidateKey  ?? '?',
    featureKey:   s.candidate?.featureKey    ?? '?',
    testType:     s.candidate?.testType      ?? '?',
    direction:    s.candidate?.direction     ?? null,
    threshold:    s.candidate?.threshold     ?? null,
    hypothesisId: s.hypothesisId,
    pValue:       s.discoveryResult?.pValue      ?? null,
    alphaSpent:   s.discoveryResult?.alphaSpent  ?? null,
    rejected:     s.discoveryResult?.rejected    ?? false,
    wealthBefore: s.discoveryResult?.wealthBefore ?? null,
    wealthAfter:  s.discoveryResult?.wealthAfter  ?? null,
    effectSize:   testStatsMap?.get(s.hypothesisId)?.effectSize ?? null,
    sampleSize:   testStatsMap?.get(s.hypothesisId)?.sampleSize ?? null,
  }));

  return {
    ok:                  true,
    runTimestamp,
    executedAt:          new Date(runTimestamp).toISOString(),
    datasetRows:         snapshotResult.rows.length,
    totalCandidates:     candidates.length,
    round1: round1 ? { evaluated: round1.evaluated, promoted: round1.promotedCount }   : null,
    round2: round2 ? { evaluated: round2.evaluated, registered: round2.promotedCount } : null,
    round3: round3 ? { evaluated: round3.evaluated, survivors: round3.promotedCount }  : null,
    round4: round4 ? { allocated: round4.results.length }                              : null,
    hasDiscovery,
    authorizationDecision: hasDiscovery ? 'PHASE_9_DISCOVERY_CANDIDATE' : 'NULL_RESULT',
    survivors: survivorDetails,
    log,
  };
}
