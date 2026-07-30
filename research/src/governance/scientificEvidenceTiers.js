/**
 * research/src/governance/scientificEvidenceTiers.js
 *
 * Purpose:
 *   Phase 11 scientific evidence tier system (E0–E5) plus a pure mapping
 *   function that translates the existing EVIDENCE_TIERS system
 *   (None/Weak/Moderate/Strong/Extraordinary) to the nearest E-tier.
 *
 * UNKNOWN #1 resolution: mapping function (Option C). The existing
 *   None/Weak/Moderate/Strong/Extraordinary tier system in evidenceStandards.js
 *   is NOT renamed or touched. This module adds the E0–E5 tier set and a pure
 *   legacyTierToE() translation function. Code that needs E-tier numbering calls
 *   the function; the existing system is unchanged.
 *
 * E-tier definitions and mapping from legacy tiers:
 *   E0 ↔ None         — no scientific evidence; discovery conditions not met.
 *   E1 ↔ Weak         — discovery conditions met; no independent replication.
 *   E2 ↔ Moderate     — independently replicated across ≥3 time windows.
 *   E3 ↔ Strong       — lockbox-validated; tolerance-band cleared.
 *   E4 ↔ Extraordinary — out-of-domain replicated with a Scientific Question ref.
 *   E5 (Phase 11 only) — all of E4 PLUS: ReproducibilityGate passed,
 *                         reproducibilityLevel ≥ 3, implementationMaturity ≥ Stable.
 *                         Not achievable via the legacy 5-tier system alone.
 *
 * Monotonic mapping justification:
 *   The legacy ladder is strictly ordered (None < Weak < Moderate < Strong <
 *   Extraordinary) by the TIER_RANK in evidenceStandards.js. The E0–E4 mapping
 *   preserves this ordering. E5 is strictly above E4 and requires additional
 *   Phase 11 conditions not tracked by the legacy system — it cannot be reached
 *   by legacyTierToE(), only by Phase 11's own promotion pathway.
 *
 * Dependencies: governance/evidenceStandards.js (EVIDENCE_TIERS — read-only import).
 * Public API: E_TIERS, E_TIER_RANK, legacyTierToE, eToLegacyTier (partial inverse),
 *   InvalidETierError, UnmappableETierError.
 * Complexity: O(1) for all operations (fixed-size lookup tables).
 */

import { EVIDENCE_TIERS } from './evidenceStandards.js';

/**
 * Phase 11 scientific evidence tier constants.
 * E5 is Phase 11-only and has no equivalent in the legacy system.
 */
export const E_TIERS = Object.freeze({
  E0: 'E0', // No evidence
  E1: 'E1', // Discovery-level (legacy: Weak)
  E2: 'E2', // Replicated (legacy: Moderate)
  E3: 'E3', // Lockbox-validated (legacy: Strong)
  E4: 'E4', // Out-of-domain replicated (legacy: Extraordinary)
  E5: 'E5', // Phase 11 Supreme — not reachable via legacy mapping alone
});

/**
 * Ordinal rank for E-tiers. Higher rank = stronger evidence.
 * Used for comparisons such as "has this candidate reached at least E3?".
 */
export const E_TIER_RANK = Object.freeze({
  [E_TIERS.E0]: 0,
  [E_TIERS.E1]: 1,
  [E_TIERS.E2]: 2,
  [E_TIERS.E3]: 3,
  [E_TIERS.E4]: 4,
  [E_TIERS.E5]: 5,
});

export class InvalidETierError extends Error {
  constructor(tier) {
    super(`"${tier}" is not a recognised E-tier. Valid values: ${Object.values(E_TIERS).join(', ')}`);
    this.name = 'InvalidETierError';
    this.received = tier;
  }
}

export class UnmappableETierError extends Error {
  constructor(eTier) {
    super(
      `E-tier "${eTier}" has no legacy equivalent. ` +
      `E5 is Phase 11-only and is not representable in the None/Weak/Moderate/Strong/Extraordinary system.`
    );
    this.name = 'UnmappableETierError';
    this.eTier = eTier;
  }
}

/**
 * Maps a legacy evidence tier (from EVIDENCE_TIERS in evidenceStandards.js)
 * to the nearest Phase 11 E-tier. The mapping is monotonic: higher legacy tiers
 * always produce higher E-tiers.
 *
 * Explicit mapping (chosen to preserve the semantic meaning of each tier):
 *   None          → E0 (no evidence in either system)
 *   Weak          → E1 (discovery conditions met, no replication)
 *   Moderate      → E2 (replicated across multiple windows)
 *   Strong        → E3 (lockbox-validated, tolerance-band cleared)
 *   Extraordinary → E4 (out-of-domain replication with ScientificQuestion ref)
 *
 * E5 is NOT reachable via this mapping — it requires Phase 11-specific conditions
 * (ReproducibilityGate passage, reproducibilityLevel ≥ 3) that the legacy system
 * does not track.
 *
 * O(1) — single table lookup.
 *
 * @param {string} legacyTier - One of EVIDENCE_TIERS values.
 * @returns {string} The corresponding E-tier (one of E0–E4).
 * @throws {Error} If legacyTier is not a recognised legacy tier value.
 */
export function legacyTierToE(legacyTier) {
  const mapping = {
    [EVIDENCE_TIERS.NONE]:          E_TIERS.E0,
    [EVIDENCE_TIERS.WEAK]:          E_TIERS.E1,
    [EVIDENCE_TIERS.MODERATE]:      E_TIERS.E2,
    [EVIDENCE_TIERS.STRONG]:        E_TIERS.E3,
    [EVIDENCE_TIERS.EXTRAORDINARY]: E_TIERS.E4,
  };
  if (!(legacyTier in mapping)) {
    throw new Error(
      `legacyTierToE: "${legacyTier}" is not a recognised legacy evidence tier. ` +
      `Valid values: ${Object.values(EVIDENCE_TIERS).join(', ')}`
    );
  }
  return mapping[legacyTier];
}

/**
 * Partial inverse of legacyTierToE: maps E0–E4 back to a legacy tier.
 * E5 has no legacy equivalent — calling this with E5 throws UnmappableETierError.
 *
 * O(1) — single table lookup.
 *
 * @param {string} eTier - One of E_TIERS values.
 * @returns {string} The corresponding legacy tier (one of EVIDENCE_TIERS values).
 * @throws {InvalidETierError} If eTier is not a recognised E-tier.
 * @throws {UnmappableETierError} If eTier is E5 (Phase 11-only, no legacy equivalent).
 */
export function eToLegacyTier(eTier) {
  if (!Object.values(E_TIERS).includes(eTier)) throw new InvalidETierError(eTier);
  if (eTier === E_TIERS.E5) throw new UnmappableETierError(eTier);
  const reverseMapping = {
    [E_TIERS.E0]: EVIDENCE_TIERS.NONE,
    [E_TIERS.E1]: EVIDENCE_TIERS.WEAK,
    [E_TIERS.E2]: EVIDENCE_TIERS.MODERATE,
    [E_TIERS.E3]: EVIDENCE_TIERS.STRONG,
    [E_TIERS.E4]: EVIDENCE_TIERS.EXTRAORDINARY,
  };
  return reverseMapping[eTier];
}

/**
 * Returns true if eTierA represents at least as strong evidence as eTierB.
 * O(1).
 * @param {string} eTierA
 * @param {string} eTierB
 * @returns {boolean}
 */
export function eIsAtLeast(eTierA, eTierB) {
  if (!Object.values(E_TIERS).includes(eTierA)) throw new InvalidETierError(eTierA);
  if (!Object.values(E_TIERS).includes(eTierB)) throw new InvalidETierError(eTierB);
  return E_TIER_RANK[eTierA] >= E_TIER_RANK[eTierB];
}
