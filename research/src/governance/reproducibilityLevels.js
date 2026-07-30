/**
 * research/src/governance/reproducibilityLevels.js
 *
 * Purpose:
 *   Defines the six-level reproducibility scale (0–5) for Phase 11 candidates,
 *   and implements the ReproducibilityGate — the mandatory pre-publication check
 *   that verifies identical computational conditions between discovery time and
 *   publication time.
 *
 * Scientific rationale for the reproducibility scale:
 *   Reproducibility is not binary. Ioannidis (2005) and the Open Science
 *   Collaboration (2015) demonstrated that most published findings fail to
 *   replicate. The six-level scale captures the full spectrum from "not yet
 *   attempted" (0) to "independently reproduced across multiple organisations"
 *   (5), making the reproducibility status of each candidate explicit and
 *   auditable at every stage of the research pipeline.
 *
 * Reproducibility levels:
 *   0 — Not reproduced: only the original result; no reproduction attempted.
 *   1 — Self-reproduced: the original researcher reproduced the result on a
 *       different random seed or data subsample.
 *   2 — Cross-window: reproduced on a non-overlapping time window by any researcher.
 *   3 — Cross-regime: reproduced across at least 2 distinct market regimes.
 *       ReproducibilityGate minimum for publication.
 *   4 — Cross-domain: reproduced on a different instrument or asset class.
 *   5 — Independent: reproduced by an independent researcher/team with no access
 *       to the original researcher's analysis files.
 *
 * ReproducibilityGate:
 *   Mandatory pre-publication check. Returns { passed: boolean, failures: string[] }.
 *   Never throws. Verifies:
 *     1. configHash in publish-time config === freeze.configHash
 *     2. ontologyVersion in publish-time config === freeze.ontologyVersion
 *     3. generatorVersion in publish-time config === freeze.generatorVersion
 *     4. proxyVersions deep-equal between publish-time config and freeze
 *     5. candidate.fingerprint is present in freeze.candidateFingerprints
 *     6. candidate.configHash === freeze.configHash (candidate was generated under frozen config)
 *     7. (optional) dataset snapshot ID matches, if freeze has a datasetSnapshotId
 *     8. candidate.reproducibilityLevel ≥ 3 (cross-regime minimum)
 *     9. candidate.implementationMaturity ≥ Stable
 *
 * Dependencies: governance/implementationMaturity.js.
 * Public API: REPRODUCIBILITY_LEVELS, REPRODUCIBILITY_DESCRIPTIONS,
 *   MIN_PUBLICATION_REPRODUCIBILITY_LEVEL, ReproducibilityGate.
 * Complexity: O(k) in the number of proxy versions (small, bounded);
 *   O(f) in candidateFingerprints array size for membership test.
 */

import { IMPLEMENTATION_MATURITY, isAtLeastMaturity } from './implementationMaturity.js';

export const REPRODUCIBILITY_LEVELS = Object.freeze({
  LEVEL_0: 0,
  LEVEL_1: 1,
  LEVEL_2: 2,
  LEVEL_3: 3,
  LEVEL_4: 4,
  LEVEL_5: 5,
});

export const REPRODUCIBILITY_DESCRIPTIONS = Object.freeze({
  0: 'Not reproduced — only the original result exists; no reproduction attempted.',
  1: 'Self-reproduced — original researcher reproduced on a different seed/subsample.',
  2: 'Cross-window — reproduced on a non-overlapping time window.',
  3: 'Cross-regime — reproduced across ≥2 distinct market regimes. Publication minimum.',
  4: 'Cross-domain — reproduced on a different instrument or asset class.',
  5: 'Independent — reproduced by an independent researcher with no access to original files.',
});

/**
 * Minimum reproducibility level required to pass ReproducibilityGate.
 * Cross-regime (level 3) is the minimum: a finding that only holds in the
 * exact market regime it was discovered in has a high prior probability of
 * being a regime-specific artefact rather than a genuine market structure.
 */
export const MIN_PUBLICATION_REPRODUCIBILITY_LEVEL = 3;

/**
 * ReproducibilityGate: mandatory pre-publication check.
 *
 * Verifies that the computational environment at publication time is identical
 * to the environment captured in the ResearchFreeze at discovery time.
 * Returns { passed: boolean, failures: string[] } — never throws.
 *
 * O(k) in the number of proxy version keys.
 */
export class ReproducibilityGate {
  /**
   * Runs all reproducibility checks for a candidate about to be published.
   *
   * @param {object} candidate - A Phase 11 Candidate instance (or plain object with same fields).
   * @param {object} publishTimeConfig - The ResearchConfiguration active at publication time.
   * @param {object} freeze - The ResearchFreeze created at discovery time.
   * @param {object} [options={}]
   * @param {string|null} [options.currentDatasetSnapshotId=null] - Current dataset snapshot ID.
   * @returns {{ passed: boolean, failures: string[] }}
   */
  static check(candidate, publishTimeConfig, freeze, { currentDatasetSnapshotId = null } = {}) {
    const failures = [];

    // ── Check 1: configHash must match ──────────────────────────────────────
    // Scientific rationale: if the configuration has changed since the discovery
    // freeze, the discovery was made under different conditions and cannot be
    // attributed to the current configuration.
    if (!publishTimeConfig || !freeze) {
      failures.push('check failed: publishTimeConfig and freeze are both required');
      return { passed: false, failures };
    }

    if (publishTimeConfig.configHash !== freeze.configHash) {
      failures.push(
        `configHash mismatch: current="${publishTimeConfig.configHash}", frozen="${freeze.configHash}". ` +
        `The ResearchConfiguration has changed since the discovery freeze.`
      );
    }

    // ── Check 2: ontologyVersion must match ─────────────────────────────────
    if (publishTimeConfig.ontologyVersion !== freeze.ontologyVersion) {
      failures.push(
        `ontologyVersion mismatch: current="${publishTimeConfig.ontologyVersion}", frozen="${freeze.ontologyVersion}". ` +
        `A different ontology version classifies features differently and invalidates the original discovery.`
      );
    }

    // ── Check 3: generatorVersion must match ────────────────────────────────
    if (publishTimeConfig.generatorVersion !== freeze.generatorVersion) {
      failures.push(
        `generatorVersion mismatch: current="${publishTimeConfig.generatorVersion}", frozen="${freeze.generatorVersion}". ` +
        `A different generator version may produce non-deterministic candidate sampling.`
      );
    }

    // ── Check 4: proxyVersions must match exactly ────────────────────────────
    // O(k) in number of proxy keys.
    const currentProxies = publishTimeConfig.proxyVersions || {};
    const frozenProxies = freeze.proxyVersions || {};
    const allProxyKeys = new Set([...Object.keys(currentProxies), ...Object.keys(frozenProxies)]);
    for (const key of allProxyKeys) {
      if (currentProxies[key] !== frozenProxies[key]) {
        failures.push(
          `proxyVersions["${key}"] mismatch: current="${currentProxies[key]}", frozen="${frozenProxies[key]}". ` +
          `Proxy version changes may alter feature computation in ways that affect p-values.`
        );
      }
    }

    // ── Check 5: candidate fingerprint must be in freeze ────────────────────
    // O(f) in number of frozen fingerprints.
    if (candidate && candidate.fingerprint) {
      const frozenFingerprints = new Set(freeze.candidateFingerprints || []);
      if (!frozenFingerprints.has(candidate.fingerprint)) {
        failures.push(
          `candidate fingerprint "${candidate.fingerprint}" is not in freeze.candidateFingerprints. ` +
          `This candidate was not part of the discovery freeze — it may have been generated after the freeze.`
        );
      }
    } else {
      failures.push('candidate is missing a fingerprint field');
    }

    // ── Check 6: candidate was generated under the frozen config ─────────────
    if (candidate && candidate.configHash !== freeze.configHash) {
      failures.push(
        `candidate.configHash "${candidate.configHash}" does not match freeze.configHash "${freeze.configHash}". ` +
        `The candidate was generated under a different configuration than the one that was frozen.`
      );
    }

    // ── Check 7: dataset snapshot ID (if freeze recorded one) ───────────────
    if (freeze.datasetSnapshotId !== null && freeze.datasetSnapshotId !== undefined) {
      if (currentDatasetSnapshotId !== freeze.datasetSnapshotId) {
        failures.push(
          `datasetSnapshotId mismatch: current="${currentDatasetSnapshotId}", frozen="${freeze.datasetSnapshotId}". ` +
          `The dataset has changed since the discovery freeze.`
        );
      }
    }

    // ── Check 8: reproducibility level ≥ 3 (cross-regime minimum) ───────────
    const repLevel = candidate ? (candidate.reproducibilityLevel ?? 0) : 0;
    if (repLevel < MIN_PUBLICATION_REPRODUCIBILITY_LEVEL) {
      failures.push(
        `reproducibilityLevel ${repLevel} < ${MIN_PUBLICATION_REPRODUCIBILITY_LEVEL} (cross-regime minimum). ` +
        `The candidate must be reproduced across ≥2 distinct market regimes before publication.`
      );
    }

    // ── Check 9: implementationMaturity ≥ Stable ────────────────────────────
    const maturity = candidate ? (candidate.implementationMaturity ?? IMPLEMENTATION_MATURITY.PROTOTYPE) : IMPLEMENTATION_MATURITY.PROTOTYPE;
    if (!isAtLeastMaturity(maturity, IMPLEMENTATION_MATURITY.STABLE)) {
      failures.push(
        `implementationMaturity "${maturity}" is below Stable. ` +
        `Publication requires at least Stable implementation (deterministic, tested, no known errors).`
      );
    }

    return { passed: failures.length === 0, failures };
  }
}
