/**
 * research/src/config/VersionSchema.js
 *
 * Purpose:
 *   Single source of truth for Phase 11 version constants and version-string
 *   validation. No Phase 11 module may hardcode a version string inline —
 *   every version tag is imported from here, so a future amendment touches
 *   one file, not N call sites. Mirrors the additive-only discipline already
 *   established in research/src/core/constants.js for the broader research tree.
 *
 * Version format: MAJOR.MINOR.PATCH (semver-compatible subset; no pre-release
 *   or build-metadata suffixes — Phase 11 modules are always in a specific,
 *   committed state, never a rolling pre-release).
 *
 * Dependencies: none.
 * Public API: PHASE11_SCHEMA_VERSION, PHASE11_GRAMMAR_VERSION,
 *   PHASE11_GENERATOR_VERSION, PHASE11_ONTOLOGY_VERSION,
 *   isValidVersion, parseVersion, compareVersions, isAtLeastVersion,
 *   InvalidVersionError.
 * Complexity: O(1) for all operations (fixed-length string parse and comparison).
 */

/** Current schema version for all Phase 11 immutable records. Bump on breaking changes. */
export const PHASE11_SCHEMA_VERSION = '11.0.0';

/** Current candidate grammar version. Governs how candidate parameters are parsed. */
export const PHASE11_GRAMMAR_VERSION = '11.0.0';

/** Current candidate generator version. Identifies the algorithm that produced a candidate. */
export const PHASE11_GENERATOR_VERSION = '11.0.0';

/** Current feature ontology version. Governs the feature namespace and type hierarchy. */
export const PHASE11_ONTOLOGY_VERSION = '11.0.0';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Returns true if the string is a valid MAJOR.MINOR.PATCH version string.
 * O(1) — single regex test on a short string.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidVersion(str) {
  return typeof str === 'string' && SEMVER_RE.test(str);
}

/**
 * Parses a version string into its numeric components.
 * Throws InvalidVersionError if the string is malformed.
 * O(1).
 * @param {string} str
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseVersion(str) {
  if (!isValidVersion(str)) throw new InvalidVersionError(str);
  const [major, minor, patch] = str.split('.').map(Number);
  return Object.freeze({ major, minor, patch });
}

/**
 * Lexicographic-then-numeric comparison of two version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Throws InvalidVersionError if either argument is malformed.
 * O(1).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] < pb[key]) return -1;
    if (pa[key] > pb[key]) return 1;
  }
  return 0;
}

/**
 * Returns true if version a is at least as recent as version b.
 * Throws InvalidVersionError if either argument is malformed.
 * O(1).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isAtLeastVersion(a, b) {
  return compareVersions(a, b) >= 0;
}

export class InvalidVersionError extends Error {
  /**
   * @param {string} received - The invalid string that was rejected.
   */
  constructor(received) {
    super(`"${received}" is not a valid MAJOR.MINOR.PATCH version string`);
    this.name = 'InvalidVersionError';
    this.received = received;
  }
}
