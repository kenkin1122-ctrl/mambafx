/**
 * research/src/governance/metaScience.js
 *
 * Purpose:
 *   Implement a real, data-driven subset of Volume IV v3.0 Part 14's
 *   Meta-Science Engine (Stage 9): metrics computed from the Laboratory's
 *   ACTUAL stored governance history, not caller-supplied signals — the
 *   first Meta-Science module this engagement has been able to build
 *   this way, now that HypothesisRegistry (Phase 2), PublicationStatus
 *   (Phase K), and the Online FDR wealth ledger (Phase B) all hold real,
 *   queryable history to roll up.
 *
 * Scope, deliberately narrowed and disclosed: Part 14 names eleven
 *   metrics. This phase implements the six that are directly computable
 *   from already-shipped stores via bounded, indexed queries: Discovery
 *   Yield, Replication Yield (Part 16's Replication Rate formula,
 *   operationalized against PublicationStatusTransitions' own from/to
 *   fields), Indeterminate Rate, Hypothesis Survival Rate, Scientific
 *   Debt, and Lab-Wide Wealth Remaining. Deliberately NOT built here:
 *   Knowledge Gain / NoveltyWeight / Evidence Score (Part 16's formulas
 *   require a cross-hypothesis analytical-choice-set similarity function
 *   with no existing implementation), Evidence Decay / Survival
 *   Probability / Discovery Half-Life (require a lambda estimated from
 *   historical base rates this codebase has no mechanism to compute
 *   yet), False Discovery Velocity and Model Obsolescence (require
 *   Operational-status live-monitoring history, Stage 7/8 infrastructure
 *   not yet built). Each is a real gap, not silently ignored — see the
 *   Global Compliance Audit precedent for disclosing "not yet checked"
 *   as a fourth, explicit state rather than a silent omission.
 *
 * Read-only, per Volume III Rule 2: "Stage 9 remains strictly read-only
 *   with respect to every other stage's stores." Every function here
 *   only reads HypothesisRegistry, PublicationStatusTransitions, and the
 *   Family Wealth Ledger — it writes only to its OWN store,
 *   MetaSnapshots (dormant since Phase 1, wired here for the first
 *   time), and never mutates any other module's data.
 *
 * Responsibilities:
 *   - computeDiscoveryYield(familyKey): fraction of a Family's Registered
 *     hypotheses whose Publication Status history ever reached
 *     ProvisionallySupported.
 *   - computeReplicationYield(familyKey): Part 16's Replication Rate
 *     formula, RR_F(T) = #{Replication attempted and succeeded} /
 *     #{Replication attempted}, operationalized as: "attempted" = the
 *     hypothesis's status history contains a transition FROM
 *     ProvisionallySupported (the only way to leave it, per Part 12's
 *     graph); "succeeded" = that transition's target was Replicated.
 *   - computeIndeterminateRate(familyKey): fraction of classified
 *     hypotheses (>=1 Publication Status transition) whose history ever
 *     includes a transition to Indeterminate.
 *   - computeHypothesisSurvivalRate(familyKey): fraction of a Family's
 *     hypotheses whose CURRENT Publication Status is not a terminal
 *     negative outcome (Rejected or Refuted).
 *   - computeScientificDebt(familyKey, {maxDwellTimeMs, now}): count and
 *     cumulative dwell time of hypotheses currently sitting in
 *     ProvisionallySupported, Replicated, or Deprecated (Part 14's own
 *     named set) longer than the policy-fixed maximum dwell time.
 *   - computeLabWideWealthRemaining(familyKeys): sums onlineFdr.js's
 *     getCurrentWealth() over a CALLER-SUPPLIED array of Family keys —
 *     there is no persisted, enumerable "list of every Family that has
 *     ever existed" anywhere in this codebase (family.js's
 *     listKnownFamilies() is explicitly documented as an in-memory,
 *     non-persisted index), so true lab-wide enumeration is a disclosed
 *     gap belonging to a future persisted Family Registry, not something
 *     to invent as a side effect of this module.
 *   - computeMetaScienceSnapshot(familyKey, {now}): bundles the five
 *     per-Family metrics above into one snapshot object.
 *   - recordMetaSnapshot(familyKey, opts): computes and permanently
 *     records one snapshot via the existing MetaSnapshots store.
 *   - listMetaSnapshots({limit}): all recorded snapshots, newest first.
 *     Uses getAll() rather than an indexed range query — MetaSnapshots'
 *     only declared index (`by_computedAt`) has a single-field, non-
 *     compound keyPath, which this codebase's listByIndexRange/
 *     queryLatestByIndex helpers do not support (they are compound-index
 *     prefix-query helpers only, and correctly refuse to be used
 *     otherwise). A getAll() scan here is a deliberate, disclosed
 *     exception, not the "unbounded historical scan" antipattern the
 *     architecture warns against elsewhere: MetaSnapshots grows with
 *     snapshot CADENCE (THRESHOLDS.META_SNAPSHOT_INTERVAL_MS, daily),
 *     not with test/discovery volume, so its row count stays small
 *     regardless of how much the Laboratory's other activity grows.
 *
 * Inputs: a Family key (or an array of Family keys for the lab-wide
 *   rollup), and optional timing/threshold overrides.
 * Outputs: Promises resolving to frozen metric records or a written
 *   snapshot.
 * Dependencies: storage/researchGovernanceDb.js
 *   (getHypothesisRegistryAdapter), governance/publicationStatus.js
 *   (listPublicationStatusHistory, getCurrentPublicationStatus,
 *   PUBLICATION_STATUSES), governance/onlineFdr.js (getCurrentWealth),
 *   storage/researchMonitoringDb.js (getMetaSnapshotsAdapter),
 *   core/constants.js (GOVERNANCE.SCIENTIFIC_DEBT_MAX_DWELL_MS).
 *
 * Public API: InvalidMetaScienceInputError, computeDiscoveryYield,
 *   computeReplicationYield, computeIndeterminateRate,
 *   computeHypothesisSurvivalRate, computeScientificDebt,
 *   computeLabWideWealthRemaining, computeMetaScienceSnapshot,
 *   recordMetaSnapshot, listMetaSnapshots.
 * Internal API: getFamilyHypothesisIds.
 *
 * Error handling: malformed inputs throw InvalidMetaScienceInputError
 *   before any read. Every per-hypothesis rollup returns an explicit
 *   {insufficientData: true} result for a Family with zero Registered
 *   hypotheses, never a division blowup.
 * Performance notes: every per-Family function is O(log n + k) — one
 *   bounded index seek on HypothesisRegistry's by_family_createdAt index
 *   for the Family's k hypotheses, then O(log n) per hypothesis against
 *   PublicationStatusTransitions — never a lab-wide unbounded scan.
 * Threading model: main-thread only.
 * Storage usage: reads HypothesisRegistry, PublicationStatusTransitions,
 *   FamilyWealthLedger (all read-only); writes only to MetaSnapshots.
 * Complexity analysis: see Performance notes above.
 * Future extension notes: once a persisted Family Registry exists,
 *   computeLabWideWealthRemaining can enumerate familyKeys itself instead
 *   of requiring a caller-supplied list. Once Operational-status
 *   live-monitoring history exists (Stage 7/8), False Discovery Velocity
 *   and Model Obsolescence become directly computable additions here.
 */

import { getHypothesisRegistryAdapter } from '../storage/researchGovernanceDb.js';
import { getMetaSnapshotsAdapter } from '../storage/researchMonitoringDb.js';
import { listPublicationStatusHistory, getCurrentPublicationStatus, PUBLICATION_STATUSES } from './publicationStatus.js';
import { getCurrentWealth } from './onlineFdr.js';
import { GOVERNANCE } from '../core/constants.js';

export class InvalidMetaScienceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMetaScienceInputError';
  }
}

function assertValidFamilyKey(familyKey, label) {
  if (!familyKey || typeof familyKey !== 'string') {
    throw new InvalidMetaScienceInputError(`${label}: "familyKey" must be a non-empty string`);
  }
}

async function getFamilyHypothesisIds(familyKey) {
  const adapter = await getHypothesisRegistryAdapter();
  const rows = await adapter.listByIndexRange('by_family_createdAt', [familyKey]);
  return rows.map((row) => row.hypothesisId);
}

/** Fraction of a Family's hypotheses whose Publication Status history ever reached ProvisionallySupported. */
export async function computeDiscoveryYield(familyKey) {
  assertValidFamilyKey(familyKey, 'computeDiscoveryYield');
  const hypothesisIds = await getFamilyHypothesisIds(familyKey);
  if (hypothesisIds.length === 0) {
    return Object.freeze({ yield: null, insufficientData: true, n: 0 });
  }
  let reached = 0;
  for (const hypothesisId of hypothesisIds) {
    const history = await listPublicationStatusHistory(hypothesisId);
    if (history.some((r) => r.to === PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED)) reached += 1;
  }
  return Object.freeze({ yield: reached / hypothesisIds.length, insufficientData: false, n: hypothesisIds.length, reached });
}

/** Part 16's Replication Rate formula, operationalized against PublicationStatusTransitions' own from/to fields. See module header. */
export async function computeReplicationYield(familyKey) {
  assertValidFamilyKey(familyKey, 'computeReplicationYield');
  const hypothesisIds = await getFamilyHypothesisIds(familyKey);
  let attempted = 0;
  let succeeded = 0;
  for (const hypothesisId of hypothesisIds) {
    const history = await listPublicationStatusHistory(hypothesisId);
    const leftProvisionallySupported = history.filter((r) => r.from === PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED);
    if (leftProvisionallySupported.length > 0) {
      attempted += 1;
      if (leftProvisionallySupported.some((r) => r.to === PUBLICATION_STATUSES.REPLICATED)) succeeded += 1;
    }
  }
  if (attempted === 0) {
    return Object.freeze({ yield: null, insufficientData: true, attempted: 0, succeeded: 0 });
  }
  return Object.freeze({ yield: succeeded / attempted, insufficientData: false, attempted, succeeded });
}

/** Fraction of classified hypotheses (>=1 Publication Status transition) whose history ever includes a transition to Indeterminate. */
export async function computeIndeterminateRate(familyKey) {
  assertValidFamilyKey(familyKey, 'computeIndeterminateRate');
  const hypothesisIds = await getFamilyHypothesisIds(familyKey);
  let classified = 0;
  let indeterminate = 0;
  for (const hypothesisId of hypothesisIds) {
    const history = await listPublicationStatusHistory(hypothesisId);
    if (history.length === 0) continue;
    classified += 1;
    if (history.some((r) => r.to === PUBLICATION_STATUSES.INDETERMINATE)) indeterminate += 1;
  }
  if (classified === 0) {
    return Object.freeze({ rate: null, insufficientData: true, classified: 0, indeterminate: 0 });
  }
  return Object.freeze({ rate: indeterminate / classified, insufficientData: false, classified, indeterminate });
}

const TERMINAL_NEGATIVE_STATUSES = Object.freeze([PUBLICATION_STATUSES.REJECTED, PUBLICATION_STATUSES.REFUTED]);

/** Fraction of a Family's hypotheses whose CURRENT Publication Status is not a terminal negative outcome (Rejected or Refuted). A never-classified hypothesis counts as surviving (it has not been rejected). */
export async function computeHypothesisSurvivalRate(familyKey) {
  assertValidFamilyKey(familyKey, 'computeHypothesisSurvivalRate');
  const hypothesisIds = await getFamilyHypothesisIds(familyKey);
  if (hypothesisIds.length === 0) {
    return Object.freeze({ rate: null, insufficientData: true, n: 0 });
  }
  let surviving = 0;
  for (const hypothesisId of hypothesisIds) {
    const current = await getCurrentPublicationStatus(hypothesisId);
    if (!TERMINAL_NEGATIVE_STATUSES.includes(current)) surviving += 1;
  }
  return Object.freeze({ rate: surviving / hypothesisIds.length, insufficientData: false, n: hypothesisIds.length, surviving });
}

const DEBT_STATUSES = Object.freeze([
  PUBLICATION_STATUSES.PROVISIONALLY_SUPPORTED,
  PUBLICATION_STATUSES.REPLICATED,
  PUBLICATION_STATUSES.DEPRECATED,
]);

/** Count and cumulative dwell time of hypotheses sitting in ProvisionallySupported/Replicated/Deprecated (Part 14's own named set) longer than the policy-fixed maximum dwell time. */
export async function computeScientificDebt(familyKey, { maxDwellTimeMs = GOVERNANCE.SCIENTIFIC_DEBT_MAX_DWELL_MS, now = Date.now() } = {}) {
  assertValidFamilyKey(familyKey, 'computeScientificDebt');
  if (typeof maxDwellTimeMs !== 'number' || !Number.isFinite(maxDwellTimeMs) || maxDwellTimeMs <= 0) {
    throw new InvalidMetaScienceInputError('computeScientificDebt: "maxDwellTimeMs" must be a finite, positive number');
  }
  const hypothesisIds = await getFamilyHypothesisIds(familyKey);
  let debtCount = 0;
  let cumulativeDwellTimeMs = 0;
  const debtHypothesisIds = [];
  for (const hypothesisId of hypothesisIds) {
    const history = await listPublicationStatusHistory(hypothesisId);
    if (history.length === 0) continue;
    const latest = history[history.length - 1]; // oldest-first, so the last element is the latest
    if (!DEBT_STATUSES.includes(latest.to)) continue;
    const dwellTimeMs = now - latest.createdAt;
    if (dwellTimeMs > maxDwellTimeMs) {
      debtCount += 1;
      cumulativeDwellTimeMs += dwellTimeMs;
      debtHypothesisIds.push(hypothesisId);
    }
  }
  return Object.freeze({ debtCount, cumulativeDwellTimeMs, maxDwellTimeMs, hypothesisIds: Object.freeze(debtHypothesisIds) });
}

/** Sums onlineFdr.js's getCurrentWealth() over a caller-supplied array of Family keys. See module header for why true lab-wide enumeration is out of scope. */
export async function computeLabWideWealthRemaining(familyKeys) {
  if (!Array.isArray(familyKeys) || familyKeys.length === 0) {
    throw new InvalidMetaScienceInputError('computeLabWideWealthRemaining: "familyKeys" must be a non-empty array');
  }
  const perFamily = {};
  let total = 0;
  for (const familyKey of familyKeys) {
    assertValidFamilyKey(familyKey, 'computeLabWideWealthRemaining');
    const wealth = await getCurrentWealth(familyKey);
    perFamily[familyKey] = wealth;
    total += wealth;
  }
  return Object.freeze({ total, perFamily: Object.freeze(perFamily) });
}

/** Bundles the five per-Family metrics into one snapshot object (excludes Lab-Wide Wealth Remaining, which spans multiple Families). */
export async function computeMetaScienceSnapshot(familyKey, { now = Date.now() } = {}) {
  assertValidFamilyKey(familyKey, 'computeMetaScienceSnapshot');
  const [discoveryYield, replicationYield, indeterminateRate, hypothesisSurvivalRate, scientificDebt] = await Promise.all([
    computeDiscoveryYield(familyKey),
    computeReplicationYield(familyKey),
    computeIndeterminateRate(familyKey),
    computeHypothesisSurvivalRate(familyKey),
    computeScientificDebt(familyKey, { now }),
  ]);
  return Object.freeze({
    familyKey, computedAt: now,
    discoveryYield, replicationYield, indeterminateRate, hypothesisSurvivalRate, scientificDebt,
  });
}

/** Computes and permanently records one Meta-Science snapshot for a Family via the existing (Phase 1, previously dormant) MetaSnapshots store. */
export async function recordMetaSnapshot(familyKey, opts = {}) {
  const snapshot = await computeMetaScienceSnapshot(familyKey, opts);
  const record = { id: `ms_${familyKey}_${snapshot.computedAt}_${Math.random().toString(36).slice(2, 10)}`, ...snapshot };
  const adapter = await getMetaSnapshotsAdapter();
  await adapter.add(record);
  return record;
}

/** All recorded Meta-Science snapshots, newest first. See module header for why this uses getAll() rather than an indexed range query. */
export async function listMetaSnapshots({ limit = Infinity } = {}) {
  const adapter = await getMetaSnapshotsAdapter();
  const all = await adapter.getAll();
  const sorted = all.slice().sort((a, b) => b.computedAt - a.computedAt);
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
}
