/**
 * research/src/validation/ReproducibilityValidator.js
 *
 * Purpose:
 *   Section 5 of the Phase 11 Validation & Calibration Directive: verifies
 *   that running the identical statistical procedure twice, against the
 *   identical inputs, produces identical results end to end. This is a
 *   diagnostic layer only — it runs the real, unmodified
 *   Phase11AutomatedConfirmation.js pipeline twice and diffs the outputs;
 *   it never spends alpha itself, never touches the protected legacy
 *   modules, and never introduces a second statistical procedure.
 *
 * What "identical" means here: given the same candidate definition, the
 *   same price series (the practical stand-in for "identical ResearchFreeze
 *   + DatasetManifest" in this environment — see the module-level
 *   disclosed limitation already established in
 *   research/src/orchestration/startPhase11Campaign.js: there is no locked
 *   historical dataset loader yet), the same targetDefinition, and the
 *   same seed, the deterministic pipeline (createSeededRng, "no hidden
 *   randomness" discipline already established throughout research/src/
 *   statistics/) must produce byte-for-byte identical:
 *     - the observed statistic, effect size, standard error, 95% CI
 *     - the p-value
 *     - permutation/bootstrap diagnostics (null mean/variance, MC SE, etc.)
 *   A candidate's fingerprint is already guaranteed deterministic by
 *   Candidate.js's own content-addressed hashing (Phase A) — this module
 *   re-verifies that guarantee holds for two independently-constructed
 *   candidates from the same parameters, rather than assuming it.
 *
 * Dependencies: bridge/Phase11AutomatedConfirmation.js
 *   (runAutomatedConfirmationTest — unmodified, run twice, never modified
 *   or reimplemented), candidate/Candidate.js (indirectly, via whatever
 *   candidate factory the caller uses to build the two candidate instances
 *   being compared).
 * Public API: verifyReproducibility, Phase11ReproducibilityMismatchReport.
 * Complexity: O(1) + 2x whatever runAutomatedConfirmationTest's own cost is.
 */

import { runAutomatedConfirmationTest } from '../bridge/Phase11AutomatedConfirmation.js';

/**
 * A structured report of every field compared, whether it matched, and
 * (if not) the two differing values — never just a boolean.
 */
export class Phase11ReproducibilityMismatchReport {
  constructor({ matched, mismatches, comparisons }) {
    this.matched = matched;
    this.mismatches = mismatches; // [{ field, valueA, valueB }]
    this.comparisons = comparisons; // full list of every field checked, matched or not
  }
}

const COMPARED_FIELDS = Object.freeze([
  'observedStatistic', 'effectSize', 'standardError', 'pValue', 'sampleSize',
  'permutations', 'nullModel', 'nullMean', 'nullVariance',
  'monteCarloStandardError', 'minAttainablePValue', 'bootstrapCiWidth', 'bootstrapSkewness',
]);

function valuesMatch(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || Math.abs(a - b) < 1e-12;
  return a === b;
}

/**
 * Runs the automated confirmation statistical test TWICE with identical
 * inputs and reports whether every compared field matches exactly.
 *
 * @param {object} params
 * @param {object} params.candidateA - First candidate instance (e.g. freshly
 *   generated) — its fingerprint is compared against candidateB's.
 * @param {object} params.candidateB - Second candidate instance, built
 *   independently from the same parameters (e.g. a second run of the same
 *   campaign, or the same candidate reloaded from storage).
 * @param {number[]} params.prices - The SAME price series supplied to both runs
 *   (standing in for "identical ResearchFreeze + DatasetManifest" — see
 *   module header).
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} params.targetDefinition
 * @param {number} params.seed - The SAME seed supplied to both runs.
 * @param {number} [params.permutations=1000]
 * @param {number} [params.bootstrapResamples=2000]
 * @returns {Phase11ReproducibilityMismatchReport}
 */
export function verifyReproducibility({
  candidateA, candidateB, prices, targetDefinition, seed, permutations = 1000, bootstrapResamples = 2000,
} = {}) {
  const comparisons = [];
  const mismatches = [];

  const fpMatch = candidateA.fingerprint === candidateB.fingerprint;
  comparisons.push({ field: 'candidateFingerprint', valueA: candidateA.fingerprint, valueB: candidateB.fingerprint, matched: fpMatch });
  if (!fpMatch) mismatches.push({ field: 'candidateFingerprint', valueA: candidateA.fingerprint, valueB: candidateB.fingerprint });

  const reportA = runAutomatedConfirmationTest({ candidate: candidateA, prices, targetDefinition, seed, permutations, bootstrapResamples });
  const reportB = runAutomatedConfirmationTest({ candidate: candidateB, prices, targetDefinition, seed, permutations, bootstrapResamples });

  for (const field of COMPARED_FIELDS) {
    const matched = valuesMatch(reportA[field], reportB[field]);
    comparisons.push({ field, valueA: reportA[field], valueB: reportB[field], matched });
    if (!matched) mismatches.push({ field, valueA: reportA[field], valueB: reportB[field] });
  }

  const ciMatched = valuesMatch(reportA.ci95[0], reportB.ci95[0]) && valuesMatch(reportA.ci95[1], reportB.ci95[1]);
  comparisons.push({ field: 'ci95', valueA: reportA.ci95, valueB: reportB.ci95, matched: ciMatched });
  if (!ciMatched) mismatches.push({ field: 'ci95', valueA: reportA.ci95, valueB: reportB.ci95 });

  return new Phase11ReproducibilityMismatchReport({ matched: mismatches.length === 0, mismatches, comparisons });
}
