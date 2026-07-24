/**
 * research/src/governance/family.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 6's Family Definition: a Family is the
 *   canonical (Market, Target Definition) pairing that defines the correct
 *   scope of statistical correction. This module owns the single
 *   authoritative rule for when two Target Definitions count as "the same"
 *   Family (equivalence-class matching within a policy-fixed tolerance
 *   band) and produces the canonical familyKey string every other
 *   governance module (Hypothesis Registry, Data Access Ledger, and, once
 *   built, the Online FDR wealth process) treats as an opaque identifier.
 *
 * Why this exists (mission alignment): Part 6 is the single largest lever
 *   against false discovery via family fragmentation — if near-identical
 *   Target Definitions (e.g., "5-tick Rise" vs. "5-tick Rise, 0.01%
 *   tolerance") were allowed to canonicalize to different Family Keys, a
 *   researcher could silently multiply their number of independent alpha
 *   budgets by making cosmetic redefinitions, defeating every FDR guarantee
 *   built on top of familyKey elsewhere in the governance layer.
 *
 * Responsibilities:
 *   - canonicalizeFamilyKey({market, targetDefinition}): the sole function
 *     that turns a (Market, Target Definition) pair into the canonical
 *     familyKey string. Two Target Definitions whose numeric parameters
 *     differ by no more than the applicable tolerance band (Part 6,
 *     GOVERNANCE.DEFAULT_TARGET_DEFINITION_TOLERANCE, unless a
 *     Family/Scientific-Question-specific override is supplied with a
 *     Scientific Oversight approval) canonicalize to the SAME familyKey.
 *   - targetDefinitionsAreEquivalent(a, b, {toleranceOverride,
 *     oversightApproval}): the underlying equivalence-class comparison,
 *     exposed directly so callers (e.g., a UI proposing a new Target
 *     Definition) can check equivalence against an existing Family before
 *     registering, rather than only discovering a collision after the fact.
 *   - resolveOrCreateFamilyKey(...): given a market + target definition,
 *     either returns the familyKey of an existing equivalent Family already
 *     known to the Laboratory (via familyRegistry, listed below) or mints a
 *     new canonical key — this is the function Registration should call,
 *     not canonicalizeFamilyKey directly, so that near-duplicate but
 *     distinct-in-representation definitions collapse onto one existing key
 *     rather than each producing a technically-different string.
 *
 * Non-goals: this module does not decide WHICH Family a given hypothesis
 *   belongs to in a scientific sense (that is a researcher's registration
 *   choice, reviewed by Scientific Oversight) — it only enforces that the
 *   *encoding* of a (Market, Target Definition) pair into a familyKey is
 *   deterministic, tolerance-aware, and collision-resistant, so the same
 *   real-world Family cannot silently fragment into multiple Family Keys.
 *
 * Inputs: plain objects describing a Market (string identifier, e.g.
 *   'R_100') and a Target Definition (a small object of numeric/string
 *   parameters — this module treats it as {direction, runLength, ...rest}
 *   with `direction` and `runLength` compared exactly and any other numeric
 *   fields compared within tolerance; non-numeric extra fields must match
 *   exactly).
 * Outputs: a deterministic string familyKey, or boolean equivalence
 *   results.
 * Dependencies: core/constants.js (GOVERNANCE.DEFAULT_TARGET_DEFINITION_TOLERANCE).
 *
 * Public API: canonicalizeFamilyKey, targetDefinitionsAreEquivalent,
 *   registerKnownFamily, resolveOrCreateFamilyKey, listKnownFamilies,
 *   InvalidFamilyDefinitionError.
 * Internal API: none.
 *
 * Error handling: malformed Target Definitions (missing direction/runLength,
 *   non-finite numeric fields) throw InvalidFamilyDefinitionError
 *   synchronously, before any key is produced.
 * Performance notes: pure, synchronous, in-memory comparison logic — no
 *   IndexedDB access in this module. The "known families" registry
 *   (registerKnownFamily/listKnownFamilies) is an in-memory index over
 *   Families already seen this session; it is a convenience cache for
 *   resolveOrCreateFamilyKey's equivalence lookup, not a source of truth —
 *   the source of truth for which Families actually have registered
 *   hypotheses remains the Hypothesis Registry's by_family_createdAt index.
 * Threading model: main-thread only (no I/O).
 * Storage usage: none directly — familyKey is stored as an opaque field by
 *   hypothesisRegistry.js and dataAccessLedger.js.
 * Complexity analysis: canonicalizeFamilyKey/targetDefinitionsAreEquivalent
 *   are O(number of Target Definition fields); resolveOrCreateFamilyKey is
 *   O(k) against the in-memory known-families cache (k = families seen this
 *   session, expected small).
 * Future extension notes: a persistent Family registry (surviving across
 *   sessions, not just in-memory) is a natural Phase 4 addition once the
 *   Online FDR wealth process (Part 9) needs to look up a Family's
 *   accumulated wealth by key — at that point resolveOrCreateFamilyKey's
 *   in-memory cache should be backed by a real store instead of replaced,
 *   since the equivalence-matching logic itself does not change.
 */

import { GOVERNANCE } from '../core/constants.js';

export class InvalidFamilyDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidFamilyDefinitionError';
  }
}

const EXACT_MATCH_FIELDS = Object.freeze(['direction', 'runLength']);

function validateTargetDefinition(targetDefinition) {
  if (!targetDefinition || typeof targetDefinition !== 'object') {
    throw new InvalidFamilyDefinitionError('targetDefinition must be an object');
  }
  for (const field of EXACT_MATCH_FIELDS) {
    if (targetDefinition[field] === undefined || targetDefinition[field] === null) {
      throw new InvalidFamilyDefinitionError(`targetDefinition."${field}" is required`);
    }
  }
  if (!Number.isInteger(targetDefinition.runLength) || targetDefinition.runLength < 1) {
    throw new InvalidFamilyDefinitionError('targetDefinition.runLength must be a positive integer');
  }
  if (targetDefinition.direction !== 'Rise' && targetDefinition.direction !== 'Fall') {
    throw new InvalidFamilyDefinitionError('targetDefinition.direction must be "Rise" or "Fall"');
  }
}

function numericFieldNames(targetDefinition) {
  return Object.keys(targetDefinition).filter(
    (k) => !EXACT_MATCH_FIELDS.includes(k) && typeof targetDefinition[k] === 'number'
  );
}

/**
 * Part 6: are two Target Definitions the SAME Family? direction and
 * runLength must match exactly (these define the outcome itself, not a
 * tunable parameter). Any other numeric field (e.g., a price-tolerance
 * band on the run definition) must match within the applicable tolerance;
 * non-numeric extra fields must match exactly. A non-default tolerance
 * requires a well-formed Scientific Oversight approval record, matching the
 * pattern already established for N_max in hypothesisRegistry.js.
 */
export function targetDefinitionsAreEquivalent(a, b, { toleranceOverride, oversightApproval } = {}) {
  validateTargetDefinition(a);
  validateTargetDefinition(b);

  for (const field of EXACT_MATCH_FIELDS) {
    if (a[field] !== b[field]) return false;
  }

  let tolerance = GOVERNANCE.DEFAULT_TARGET_DEFINITION_TOLERANCE;
  if (toleranceOverride !== undefined && toleranceOverride !== null) {
    const approvalValid = oversightApproval
      && typeof oversightApproval.approvedBy === 'string' && oversightApproval.approvedBy.length > 0
      && typeof oversightApproval.rationale === 'string' && oversightApproval.rationale.length > 0
      && Number.isFinite(oversightApproval.timestamp);
    if (!approvalValid) {
      throw new InvalidFamilyDefinitionError(
        'targetDefinitionsAreEquivalent: a non-default tolerance was requested without a well-formed ' +
        'Scientific Oversight approval {approvedBy, rationale, timestamp} — Part 6/8 require prior approval'
      );
    }
    if (!Number.isFinite(toleranceOverride) || toleranceOverride < 0) {
      throw new InvalidFamilyDefinitionError('targetDefinitionsAreEquivalent: toleranceOverride must be a non-negative finite number');
    }
    tolerance = toleranceOverride;
  }

  const numericFields = new Set([...numericFieldNames(a), ...numericFieldNames(b)]);
  for (const field of numericFields) {
    const av = a[field];
    const bv = b[field];
    if (typeof av !== 'number' || typeof bv !== 'number') {
      // one side has this field and the other doesn't, or it's non-numeric on one side
      if (av !== bv) return false;
      continue;
    }
    if (Math.abs(av - bv) > tolerance) return false;
  }

  // any remaining non-numeric, non-exact-match fields must match exactly
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    if (EXACT_MATCH_FIELDS.includes(key)) continue;
    if (typeof a[key] === 'number' || typeof b[key] === 'number') continue; // handled above
    if (a[key] !== b[key]) return false;
  }

  return true;
}

/**
 * Deterministic canonical familyKey for a (market, targetDefinition) pair.
 * Two calls with EQUAL (not just equivalent-within-tolerance) inputs always
 * produce an identical string. Two calls with equivalent-but-not-identical
 * inputs (e.g., differing only by a sub-tolerance rounding difference) are
 * NOT guaranteed to produce the same string by this function alone — that
 * collapsing is resolveOrCreateFamilyKey's job (it consults known Families
 * for equivalence before minting a new key). This function is intentionally
 * pure and tolerance-unaware so it is trivially reproducible.
 */
export function canonicalizeFamilyKey({ market, targetDefinition }) {
  if (!market || typeof market !== 'string') {
    throw new InvalidFamilyDefinitionError('canonicalizeFamilyKey: "market" must be a non-empty string');
  }
  validateTargetDefinition(targetDefinition);
  const sortedKeys = Object.keys(targetDefinition).sort();
  const parts = sortedKeys.map((k) => `${k}=${targetDefinition[k]}`);
  return `family:${market}:${parts.join(',')}`;
}

// In-memory, session-scoped cache of known Families (see Future extension
// notes above for why this is not yet a persistent store).
const knownFamilies = [];

/** Record a Family (market, targetDefinition, familyKey) as known this session. */
export function registerKnownFamily({ market, targetDefinition, familyKey }) {
  validateTargetDefinition(targetDefinition);
  if (!familyKey) throw new InvalidFamilyDefinitionError('registerKnownFamily: "familyKey" is required');
  knownFamilies.push({ market, targetDefinition, familyKey });
}

/** All Families registered as known this session (read-only snapshot). */
export function listKnownFamilies() {
  return knownFamilies.slice();
}

/**
 * The function Registration should call: resolves to the familyKey of an
 * existing equivalent Family if one is already known, or mints and records
 * a new canonical key otherwise. This is what prevents cosmetic Target
 * Definition redefinitions from silently fragmenting a Family's FDR budget.
 */
export function resolveOrCreateFamilyKey({ market, targetDefinition, toleranceOverride, oversightApproval } = {}) {
  if (!market || typeof market !== 'string') {
    throw new InvalidFamilyDefinitionError('resolveOrCreateFamilyKey: "market" must be a non-empty string');
  }
  validateTargetDefinition(targetDefinition);

  for (const known of knownFamilies) {
    if (known.market !== market) continue;
    if (targetDefinitionsAreEquivalent(known.targetDefinition, targetDefinition, { toleranceOverride, oversightApproval })) {
      return known.familyKey;
    }
  }

  const familyKey = canonicalizeFamilyKey({ market, targetDefinition });
  registerKnownFamily({ market, targetDefinition, familyKey });
  return familyKey;
}

/** Test-only: clear the in-memory known-Families cache between test cases. */
export function _resetKnownFamiliesForTesting() {
  knownFamilies.length = 0;
}
