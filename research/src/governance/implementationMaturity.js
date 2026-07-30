/**
 * research/src/governance/implementationMaturity.js
 *
 * Purpose:
 *   Implementation maturity level system for Phase 11 candidates.
 *   Tracks how production-ready a candidate's computational implementation is,
 *   independently of its scientific evidence strength.
 *
 * Scientific rationale:
 *   A candidate can have strong scientific evidence (E4) but a fragile
 *   implementation (e.g., a proof-of-concept script with no error handling).
 *   Conversely, a well-engineered implementation with full test coverage may
 *   have only preliminary evidence (E1). Separating implementation maturity
 *   from evidence tier prevents premature productionisation of well-tested
 *   but scientifically unvalidated ideas, and prevents blocking publication
 *   of scientifically validated but prototype-stage implementations.
 *
 *   ReproducibilityGate requires implementationMaturity ≥ Stable before
 *   publication — a candidate with only Prototype-level implementation cannot
 *   be reliably reproduced (insufficient error handling, non-deterministic
 *   behaviour, etc.).
 *
 * Levels (ordered from least to most mature):
 *   Prototype   — proof-of-concept; may not be deterministic or handle errors.
 *   Experimental— functional but not production-hardened; some test coverage.
 *   Stable      — reliable, deterministic, tested; suitable for ReproducibilityGate.
 *   Validated   — independently validated by a second researcher/reviewer.
 *   Production  — deployed in live research infrastructure with monitoring.
 *
 * Dependencies: none.
 * Public API: IMPLEMENTATION_MATURITY, MATURITY_RANK, isAtLeastMaturity,
 *   InvalidMaturityError.
 * Complexity: O(1) for all operations.
 */

export const IMPLEMENTATION_MATURITY = Object.freeze({
  PROTOTYPE:    'Prototype',
  EXPERIMENTAL: 'Experimental',
  STABLE:       'Stable',
  VALIDATED:    'Validated',
  PRODUCTION:   'Production',
});

/**
 * Ordinal rank for implementation maturity levels.
 * Higher rank = more mature implementation.
 */
export const MATURITY_RANK = Object.freeze({
  [IMPLEMENTATION_MATURITY.PROTOTYPE]:    0,
  [IMPLEMENTATION_MATURITY.EXPERIMENTAL]: 1,
  [IMPLEMENTATION_MATURITY.STABLE]:       2,
  [IMPLEMENTATION_MATURITY.VALIDATED]:    3,
  [IMPLEMENTATION_MATURITY.PRODUCTION]:   4,
});

export class InvalidMaturityError extends Error {
  constructor(received) {
    super(
      `"${received}" is not a recognised implementation maturity level. ` +
      `Valid values: ${Object.values(IMPLEMENTATION_MATURITY).join(', ')}`
    );
    this.name = 'InvalidMaturityError';
    this.received = received;
  }
}

/**
 * Returns true if maturityA is at least as mature as maturityB.
 * O(1).
 *
 * @param {string} maturityA - Current maturity level.
 * @param {string} maturityB - Minimum required maturity level.
 * @returns {boolean}
 */
export function isAtLeastMaturity(maturityA, maturityB) {
  if (!(maturityA in MATURITY_RANK)) throw new InvalidMaturityError(maturityA);
  if (!(maturityB in MATURITY_RANK)) throw new InvalidMaturityError(maturityB);
  return MATURITY_RANK[maturityA] >= MATURITY_RANK[maturityB];
}

/**
 * Returns the maturity level that follows the given one in the progression.
 * Returns null if the given level is already Production (terminal).
 * O(1).
 *
 * @param {string} current
 * @returns {string|null}
 */
export function nextMaturityLevel(current) {
  if (!(current in MATURITY_RANK)) throw new InvalidMaturityError(current);
  const levels = Object.values(IMPLEMENTATION_MATURITY);
  const idx = levels.indexOf(current);
  return idx < levels.length - 1 ? levels[idx + 1] : null;
}
