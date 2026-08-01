/**
 * research/src/bridge/Phase11ConfirmationReadiness.js
 *
 * Purpose:
 *   A pure USABILITY layer, computed BEFORE Round 3 confirmation starts.
 *   It answers "is there enough real data yet to even attempt a
 *   scientifically meaningful confirmation test?" and, if not, exactly
 *   why not and how much more data is needed — without running, altering,
 *   or duplicating any part of the actual statistical procedure.
 *
 *   This module changes NO statistical logic and NO thresholds. It reuses
 *   bridge/Phase11AutomatedConfirmation.js's own EXPORTED, UNCHANGED
 *   functions verbatim:
 *     - computeIndicatorSeries() / computeOutcomeSeries() — the exact same
 *       lookback/forward-window computation the real confirmation test
 *       uses, called here ONLY to count how many valid (indicator, outcome)
 *       pairs currently exist — never to compute a p-value or run a
 *       permutation test.
 *     - MIN_ALIGNED_PAIRS — the exact same minimum-sample-size constant
 *       the real test enforces (now exported from that module, a purely
 *       additive change with no effect on its own behavior — confirmed by
 *       running the full existing test suite immediately after that
 *       specific one-line change, before writing anything on top of it).
 *   The "minimum ticks required" estimate below is an ANALYTICAL
 *   APPROXIMATION for progress-bar purposes only (period + forward
 *   runLength + MIN_ALIGNED_PAIRS) — it is explicitly documented as an
 *   estimate, and the READY/NOT-READY decision itself is always taken
 *   from the real, exact aligned-pair count, never from the estimate.
 *
 * Dependencies: bridge/Phase11AutomatedConfirmation.js (computeIndicatorSeries,
 *   computeOutcomeSeries, MIN_ALIGNED_PAIRS — all unmodified, reused).
 * Public API: computeCandidateReadiness, computeOverallReadiness.
 * Complexity: O(n) per candidate (n = price series length) — identical
 *   cost profile to the indicator/outcome computation step the real test
 *   already performs, just without the permutation test or bootstrap.
 */

import { computeIndicatorSeries, computeOutcomeSeries, MIN_ALIGNED_PAIRS } from './Phase11AutomatedConfirmation.js';

/**
 * Computes confirmation readiness for a single candidate against the
 * current (real, live) price series.
 *
 * @param {object} params
 * @param {object} params.candidate - Provides indicatorName/period.
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} params.indicatorRegistry
 *   The canonical Indicator Registry -- resolves indicatorName exactly as
 *   Confirmation itself does, since readiness is a preview of the same
 *   real computation, not a separate approximation of it.
 * @param {number[]} params.prices - The current real price series.
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} params.targetDefinition
 * @returns {{
 *   candidateId: string, indicatorName: string, period: number,
 *   currentTickCount: number, usableObservations: number,
 *   minAlignedPairsRequired: number, minTicksRequired: number,
 *   remainingTicksNeeded: number, readinessPercentage: number,
 *   ready: boolean, reason: string|null
 * }}
 */
export function computeCandidateReadiness({ candidate, indicatorRegistry, prices, targetDefinition } = {}) {
  const currentTickCount = Array.isArray(prices) ? prices.length : 0;
  const period = candidate?.period ?? 14;
  const runLength = targetDefinition?.runLength ?? 5;

  let usableObservations = 0;
  if (currentTickCount > 0) {
    const indicatorSeries = computeIndicatorSeries(indicatorRegistry, candidate.indicatorName, period, prices);
    const outcomeSeries = computeOutcomeSeries(prices, targetDefinition);
    for (let i = 0; i < prices.length; i++) {
      if (Number.isFinite(indicatorSeries[i]) && Number.isFinite(outcomeSeries[i])) usableObservations++;
    }
  }

  // Analytical estimate for progress-bar purposes only -- see module
  // header. The actual READY decision below uses usableObservations
  // (the real, exact count), never this estimate.
  const minTicksRequired = period + runLength + MIN_ALIGNED_PAIRS;
  const remainingTicksNeeded = Math.max(0, minTicksRequired - currentTickCount);

  const ready = usableObservations >= MIN_ALIGNED_PAIRS;
  const readinessPercentage = Math.min(100, (usableObservations / MIN_ALIGNED_PAIRS) * 100);

  const reason = ready
    ? null
    : `Only ${usableObservations}/${MIN_ALIGNED_PAIRS} aligned (indicator, outcome) pairs available after applying the ` +
      `${period}-tick ${candidate.indicatorName} lookback and ${runLength}-tick forward outcome window -- ` +
      `at least ${MIN_ALIGNED_PAIRS} are required for a scientifically meaningful permutation-test null distribution.`;

  return {
    candidateId: candidate?.id, indicatorName: candidate?.indicatorName, period,
    currentTickCount, usableObservations, minAlignedPairsRequired: MIN_ALIGNED_PAIRS,
    minTicksRequired, remainingTicksNeeded, readinessPercentage, ready, reason,
  };
}

/**
 * Computes readiness for a batch of candidates and an overall summary.
 * Overall readiness is "ready" once AT LEAST ONE candidate has enough
 * data (matching how the Confirm button's own loop already handles
 * per-candidate insufficient-data failures individually) -- not "every
 * candidate ready", since confirming whichever candidates ARE ready is
 * both scientifically valid and operationally useful without waiting on
 * the slowest one.
 *
 * @param {object} params
 * @param {object[]} params.candidates
 * @param {import('../indicator/IndicatorRegistry.js').IndicatorRegistry} params.indicatorRegistry
 * @param {number[]} params.prices
 * @param {{ direction: 'Rise'|'Fall', runLength: number }} params.targetDefinition
 * @returns {{
 *   perCandidate: ReturnType<typeof computeCandidateReadiness>[],
 *   overallReadinessPercentage: number, overallReady: boolean,
 *   readyCount: number, totalCount: number
 * }}
 */
export function computeOverallReadiness({ candidates, indicatorRegistry, prices, targetDefinition } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const perCandidate = list.map((candidate) => computeCandidateReadiness({ candidate, indicatorRegistry, prices, targetDefinition }));
  const readyCount = perCandidate.filter((r) => r.ready).length;
  const overallReadinessPercentage = perCandidate.length
    ? perCandidate.reduce((a, r) => a + r.readinessPercentage, 0) / perCandidate.length
    : 0;

  return {
    perCandidate,
    overallReadinessPercentage,
    overallReady: readyCount > 0,
    readyCount,
    totalCount: perCandidate.length,
  };
}
