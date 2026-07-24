/**
 * research/src/governance/dataAccessLedger.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 7 (Pre-Registration Data Governance): the
 *   Data Access Ledger and the verification logic behind a Registration's
 *   Data Access Attestation. This is the module that closes Finding F-1 of
 *   the Independent Panel Review — "secret peeking" before Registration —
 *   by making every access to a Family's data a permanent, logged fact that
 *   a Registration must truthfully account for before it may complete.
 *
 * Responsibilities:
 *   - logAccess(entry): append one permanent Data Access Ledger row. Called
 *     for EVERY access to a Family's data, regardless of Lifecycle Stage —
 *     including Idea/Hypothesis-stage informal exploration, which Part 7
 *     explicitly brings inside the governance perimeter.
 *   - listAccessForFamily(familyKey): every logged access for a Family,
 *     newest first (bounded read via the by_family_accessedAt index — never
 *     an unbounded getAll() scan).
 *   - verifyAttestation({familyKey, registrationTimestamp, disclosedEntryIds}):
 *     the actual truth-check behind a Data Access Attestation (Part 3) — do
 *     any logged accesses to this Family, timestamped before
 *     registrationTimestamp, exist that are NOT among the entry ids the
 *     registering researcher disclosed? Returns a structured result rather
 *     than throwing, so hypothesisRegistry.js can decide how to apply the
 *     Part 7 consequences (Registration block if undisclosed access exists
 *     and is unacknowledged; Evidence Tier cap if disclosed).
 *   - isLockboxAllocationDisqualified({familyKey, lineageRegistrationTimestamp,
 *     rangeOverlapsFn}): the Part 7 Lockbox-specific rule — was any of a
 *     designated holdout range accessed before the lineage's own
 *     Registration? Delegates the actual range-overlap comparison to a
 *     caller-supplied predicate, since "range" semantics (tick-index ranges,
 *     timestamp ranges) are a Stage-level concern this governance module
 *     does not need to know the internals of.
 *
 * Inputs: plain objects describing an access event or an attestation check.
 * Outputs: Promises resolving to the logged entry's id, an array of ledger
 *   rows, or a structured { attested, undisclosedEntries } / { disqualified,
 *   conflictingEntries } result.
 * Dependencies: storage/researchGovernanceDb.js (getDataAccessLedgerAdapter).
 *
 * Public API: logAccess, listAccessForFamily, verifyAttestation,
 *   isLockboxAllocationDisqualified.
 * Internal API: none.
 *
 * Error handling: logAccess validates required fields and throws TypeError
 *   synchronously before any I/O on obviously malformed input (missing
 *   familyKey/accessedAt); IndexedDB errors propagate as rejected Promises,
 *   never swallowed — Principle 8 (complete audit trail) requires a failed
 *   log write to be loud, not silently dropped.
 * Performance notes: verifyAttestation is O(log n + k) via the
 *   by_family_accessedAt index (k = accesses for this Family before
 *   registrationTimestamp), never a full-ledger scan.
 * Threading model: main-thread only (matches sibling governance/storage
 *   modules).
 * Storage usage: DataAccessLedger store only (append-only; see
 *   researchGovernanceDb.js).
 * Complexity analysis: see Performance notes.
 * Future extension notes: a future "automated ingestion access" source
 *   (e.g., routine data-quality monitoring that is not hypothesis-directed)
 *   should still call logAccess() with purpose: 'routine-ingestion' —
 *   Part 7 requires ALL access logged, and verifyAttestation's undisclosed-
 *   entry check is what distinguishes disclosed-but-benign access from a
 *   true violation, not an exemption at the logging layer.
 */

import { getDataAccessLedgerAdapter } from '../storage/researchGovernanceDb.js';

function assertRequired(entry, fields, callerName) {
  for (const f of fields) {
    if (entry[f] === undefined || entry[f] === null) {
      throw new TypeError(`${callerName}: "${f}" is required`);
    }
  }
}

/**
 * Log one access event, permanently. `familyKey` should be the same
 * canonical (Market, TargetDefinition) tuple used throughout the governance
 * layer (see familyKey.js once Part 6 is implemented); this module accepts
 * it as an opaque string/array so it has no dependency on that module's
 * internal representation.
 */
export async function logAccess({ familyKey, accessedBy, accessedAt, range, purpose, lifecycleStageAtAccess }) {
  assertRequired({ familyKey, accessedBy, accessedAt, purpose }, ['familyKey', 'accessedBy', 'accessedAt', 'purpose'], 'logAccess');
  const adapter = await getDataAccessLedgerAdapter();
  const id = `dal_${accessedAt}_${Math.random().toString(36).slice(2, 10)}`;
  const entry = {
    id,
    familyKey,
    accessedBy,
    accessedAt,
    range: range ?? null,
    purpose,
    lifecycleStageAtAccess: lifecycleStageAtAccess ?? 'Idea', // Part 7: Idea/Hypothesis stages are NOT exempt from logging
  };
  await adapter.add(entry);
  return id;
}

/** Every logged access for a Family, newest first. */
export async function listAccessForFamily(familyKey, { limit = Infinity } = {}) {
  const adapter = await getDataAccessLedgerAdapter();
  return adapter.listByIndexRange('by_family_accessedAt', [familyKey], { limit });
}

/**
 * The truth-check behind a Data Access Attestation (Part 3, Part 7).
 * Returns { attested, undisclosedEntries }. `attested` is true only if
 * every logged access to `familyKey` before `registrationTimestamp` appears
 * in `disclosedEntryIds` — i.e., the researcher accounted for all of it.
 */
export async function verifyAttestation({ familyKey, registrationTimestamp, disclosedEntryIds = [] }) {
  assertRequired({ familyKey, registrationTimestamp }, ['familyKey', 'registrationTimestamp'], 'verifyAttestation');
  const priorAccess = await listAccessForFamily(familyKey);
  const disclosedSet = new Set(disclosedEntryIds);
  const undisclosedEntries = priorAccess.filter(
    (entry) => entry.accessedAt < registrationTimestamp && !disclosedSet.has(entry.id)
  );
  return {
    attested: undisclosedEntries.length === 0,
    undisclosedEntries,
    // Part 7: any DISCLOSED pre-Registration access still caps Evidence Tier
    // at Moderate — surfaced here so hypothesisRegistry.js does not need a
    // second query to know whether the cap applies.
    hasDisclosedPriorAccess: priorAccess.some(
      (entry) => entry.accessedAt < registrationTimestamp && disclosedSet.has(entry.id)
    ),
  };
}

/**
 * Part 7's Lockbox-specific rule: was any data within the designated
 * holdout range accessed before the lineage's own Registration timestamp?
 * `rangeOverlapsFn(accessRange, holdoutRange) -> boolean` is supplied by the
 * caller (Stage-level range semantics are out of scope for this module).
 */
export async function isLockboxAllocationDisqualified({ familyKey, lineageRegistrationTimestamp, holdoutRange, rangeOverlapsFn }) {
  assertRequired(
    { familyKey, lineageRegistrationTimestamp, holdoutRange, rangeOverlapsFn },
    ['familyKey', 'lineageRegistrationTimestamp', 'holdoutRange', 'rangeOverlapsFn'],
    'isLockboxAllocationDisqualified'
  );
  const priorAccess = await listAccessForFamily(familyKey);
  const conflictingEntries = priorAccess.filter(
    (entry) => entry.accessedAt < lineageRegistrationTimestamp
      && entry.range != null
      && rangeOverlapsFn(entry.range, holdoutRange)
  );
  return { disqualified: conflictingEntries.length > 0, conflictingEntries };
}
