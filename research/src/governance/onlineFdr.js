/**
 * research/src/governance/onlineFdr.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 9's Family-Level Online FDR wealth
 *   process — the mechanism that replaces flat per-run alpha = 0.05 with a
 *   lifetime, Family-scoped multiplicity control, so the number of tests a
 *   Family has ever undergone (not just the current run) bounds its
 *   cumulative false-discovery exposure.
 *
 * Method: generalized alpha-investing (Foster & Stine 2008; Aharoni &
 *   Rosset 2014). Each Family owns its own wealth process, keyed by
 *   familyKey (family.js). Wealth starts at GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH.
 *   Before each test, the Family "bids" alpha_j = wealth * GOVERNANCE.
 *   ONLINE_FDR_INVESTMENT_FRACTION (never more than the wealth actually
 *   available — bids are computed FROM current wealth, so cumulative spend
 *   is bounded by construction regardless of how many tests are ever run).
 *   A test is significant (a "rejection," in the FDR sense) iff its p-value
 *   <= alpha_j. On rejection, wealth is credited a bonus
 *   (GOVERNANCE.ONLINE_FDR_REJECTION_BONUS) net of the bid; on a
 *   non-rejection, wealth simply decreases by the bid. This is the
 *   standard generalized-alpha-investing update:
 *     W_j = W_{j-1} - alpha_j + bonus * 1{reject_j}
 *   which the cited literature proves controls a lifetime (not per-run)
 *   false discovery rate for the sequence of tests it gates, without
 *   needing to know in advance how many tests will ever be run.
 *
 * Why per-Family, not lab-wide: Part 6 already established Family as the
 *   correct scope of statistical correction (the single largest lever
 *   against false discovery via family fragmentation, per the Scientific
 *   Value Audit). A single lab-wide wealth process would let an unrelated
 *   Family's testing activity silently deplete a different Family's
 *   budget; per-Family wealth keeps each Family's multiplicity exposure
 *   exactly scoped to its own history, matching Part 6's own scoping rule.
 *
 * Responsibilities:
 *   - getCurrentWealth(familyKey): the Family's current wealth (the most
 *     recent ledger row's wealthAfter), or GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH
 *     if the Family has never been tested before. Bounded read via the
 *     by_family_seq index — never a full-ledger scan.
 *   - recordTestAndUpdateWealth({familyKey, hypothesisId, pValue, testedAt}):
 *     the sole function that spends a Family's wealth against a test
 *     outcome. Computes the bid from CURRENT wealth, decides rejection,
 *     applies the wealth update, and appends a permanent, immutable ledger
 *     row recording every quantity (bid, outcome, wealth before/after) —
 *     never mutates a prior row. Returns the full decision so callers
 *     (e.g., a future discoveryDecision.js orchestrator) can act on it.
 *   - listWealthHistory(familyKey): full ledger history for a Family, for
 *     Compliance Audit / dashboard use.
 *
 * Inputs: a familyKey (opaque string, produced by family.js) and a p-value
 *   from a completed statistical test.
 * Outputs: Promises resolving to a wealth number, a decision record, or an
 *   array of ledger rows.
 * Dependencies: storage/researchGovernanceDb.js (getFamilyWealthLedgerAdapter),
 *   core/constants.js (GOVERNANCE thresholds), statistics/indexingStrategy.js
 *   (via the adapter's queryLatestByIndex/listByIndexRange).
 *
 * Public API: getCurrentWealth, recordTestAndUpdateWealth, listWealthHistory,
 *   computeBid, InvalidOnlineFdrInputError.
 * Internal API: none.
 *
 * Error handling: malformed inputs (missing familyKey, a pValue outside
 *   [0,1]) throw InvalidOnlineFdrInputError synchronously, before any read
 *   or write is attempted.
 * Performance notes: getCurrentWealth and recordTestAndUpdateWealth are
 *   O(log n) via the by_family_seq index (single-row lookup for the
 *   latest sequence number) — never an unbounded scan, consistent with the
 *   discipline established throughout research/src/.
 * Threading model: main-thread only.
 * Storage usage: FamilyWealthLedger store only (append-only).
 * Complexity analysis: O(log n + k) where k is the small, bounded number of
 *   rows read to determine the next sequence number and current wealth
 *   (effectively O(1) since only the single latest row is ever read).
 * Concurrency note (documented limitation, consistent with
 *   hypothesisRegistry.js's LifecycleTransitions sequencing): this module
 *   does not provide atomic read-then-write across two concurrent calls
 *   for the SAME familyKey — two overlapping recordTestAndUpdateWealth()
 *   calls for the same Family could both read the same "current wealth"
 *   before either write lands, double-spending that wealth. This mirrors
 *   the same single-writer assumption already documented and accepted for
 *   LifecycleTransitions' seq field; Part 9 does not currently require
 *   concurrent multi-writer support (Discovery is a Registration-gated,
 *   sequential process per Family), so this is a disclosed limitation, not
 *   a silent gap.
 * Future extension notes: Part 16's SAFFRON/ADDIS family (adaptive,
 *   discarding-aware variants) can be added as alternative bid/update
 *   strategies behind the same recordTestAndUpdateWealth() signature
 *   without changing the ledger schema, since every quantity the
 *   alternative strategies need (bid, outcome, wealth before/after) is
 *   already recorded per row.
 */

import { getFamilyWealthLedgerAdapter } from '../storage/researchGovernanceDb.js';
import { GOVERNANCE } from '../core/constants.js';

export class InvalidOnlineFdrInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidOnlineFdrInputError';
  }
}

// Part 6/9: the Laboratory has exactly one authoritative Discovery process;
// multiple validated statistical methods operate as INTERCHANGEABLE tests
// inside it, sharing one Family wealth ledger, rather than as separate,
// independently-corrected engines (this is the specific mechanism that
// retires the legacy mutual-information engine's standalone correction
// path -- its statistic becomes one more valid value of TEST_METHODS,
// spending against the SAME ledger as the permutation-based test, never a
// second, independently-alpha'd path). Extend this enum, never bypass it.
export const TEST_METHODS = Object.freeze({
  PERMUTATION: 'permutation',
  MUTUAL_INFORMATION: 'mutualInformation',
  UNSPECIFIED: 'unspecified',
});

function assertValidFamilyKey(familyKey, callerName) {
  if (!familyKey || typeof familyKey !== 'string') {
    throw new InvalidOnlineFdrInputError(`${callerName}: "familyKey" must be a non-empty string`);
  }
}

function assertValidPValue(pValue, callerName) {
  if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
    throw new InvalidOnlineFdrInputError(`${callerName}: "pValue" must be a finite number in [0, 1]`);
  }
}

/** The bid (significance threshold) for the next test, given current wealth. Never exceeds current wealth. */
export function computeBid(currentWealth) {
  return currentWealth * GOVERNANCE.ONLINE_FDR_INVESTMENT_FRACTION;
}

/** Latest ledger row for a Family, or undefined if the Family has never been tested (bounded index read). */
async function getLatestLedgerRow(familyKey) {
  const adapter = await getFamilyWealthLedgerAdapter();
  return adapter.queryLatestByIndex('by_family_seq', [familyKey]);
}

/** A Family's current wealth: the most recent ledger row's wealthAfter, or the policy-fixed initial wealth if never tested. */
export async function getCurrentWealth(familyKey) {
  assertValidFamilyKey(familyKey, 'getCurrentWealth');
  const latest = await getLatestLedgerRow(familyKey);
  return latest ? latest.wealthAfter : GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH;
}

/**
 * Spend a Family's wealth against one completed test's p-value. This is
 * the sole function permitted to advance a Family's wealth process — it
 * always appends a new, immutable ledger row (never mutates a prior one),
 * mirroring the append-only discipline used throughout research/src/.
 */
export async function recordTestAndUpdateWealth({ familyKey, hypothesisId, pValue, testedAt, testMethod = TEST_METHODS.UNSPECIFIED } = {}) {
  assertValidFamilyKey(familyKey, 'recordTestAndUpdateWealth');
  assertValidPValue(pValue, 'recordTestAndUpdateWealth');
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new InvalidOnlineFdrInputError('recordTestAndUpdateWealth: "hypothesisId" must be a non-empty string');
  }
  if (!Object.values(TEST_METHODS).includes(testMethod)) {
    throw new InvalidOnlineFdrInputError(
      `recordTestAndUpdateWealth: "testMethod" must be one of ${Object.values(TEST_METHODS).join(', ')} -- got "${testMethod}"`
    );
  }

  const latest = await getLatestLedgerRow(familyKey);
  const wealthBefore = latest ? latest.wealthAfter : GOVERNANCE.ONLINE_FDR_INITIAL_WEALTH;
  const seq = latest ? latest.seq + 1 : 0;

  const alphaSpent = computeBid(wealthBefore);
  const rejected = pValue <= alphaSpent;
  const wealthAfter = rejected
    ? wealthBefore - alphaSpent + GOVERNANCE.ONLINE_FDR_REJECTION_BONUS
    : wealthBefore - alphaSpent;

  const resolvedTestedAt = testedAt ?? Date.now();
  const adapter = await getFamilyWealthLedgerAdapter();
  const record = {
    id: `fwl_${familyKey}_${seq}`,
    familyKey,
    seq,
    hypothesisId,
    pValue,
    testMethod,
    alphaSpent,
    rejected,
    wealthBefore,
    wealthAfter,
    testedAt: resolvedTestedAt,
  };
  await adapter.add(record); // native add() -> ConstraintError on any duplicate (familyKey, seq) pair (unique index)

  return record;
}

/** Full wealth-ledger history for a Family, oldest first (bounded index read). */
export async function listWealthHistory(familyKey, { limit = Infinity } = {}) {
  assertValidFamilyKey(familyKey, 'listWealthHistory');
  const adapter = await getFamilyWealthLedgerAdapter();
  const rows = await adapter.listByIndexRange('by_family_seq', [familyKey], { limit });
  return rows.slice().sort((a, b) => a.seq - b.seq);
}
