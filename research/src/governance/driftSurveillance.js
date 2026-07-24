/**
 * research/src/governance/driftSurveillance.js
 *
 * Purpose:
 *   The stateful half of Volume IV v3.0 Part 16's Drift Surveillance
 *   Engine (Stage 7): applies the pure KS regime-change test
 *   (statistics/driftDetection.js) to successive rolling windows,
 *   publishes a state transition (stable <-> drifted) only once it has
 *   persisted for a policy-fixed number of consecutive windows (Volume
 *   III's hysteresis rule, THRESHOLDS.DRIFT_HYSTERESIS_WINDOWS, default
 *   5), and permanently records every evaluation to the existing
 *   DriftEvents store (built in Phase 1, unused until now). Its output
 *   is one of the two mandatory, objective inputs to Part 12's
 *   Indeterminate classification (the other being powerEngine.js's
 *   achieved-power figure) and to Operational-status demotion decisions.
 *
 * Why hysteresis, and why derived from stored history rather than
 *   in-memory state: Volume III's Software Architecture explicitly
 *   requires "DriftDetected is only published on a state transition...
 *   that has persisted for a configured minimum of N consecutive
 *   windows" — a single noisy window must never flip the published
 *   state. Rather than keep a mutable in-memory counter (fragile across
 *   reloads, unauditable, and inconsistent with every other governance
 *   module built this session — Online FDR, the Empirical FDR Canary —
 *   all of which derive their current state by querying the store, never
 *   from hidden module state), this module derives the hysteresis
 *   decision from the most recent N-1 already-stored raw evaluations
 *   plus the current one, exactly the same "look at the last N stored
 *   rows" pattern already used in empiricalFdrCanary.js's
 *   checkPersistentMaterialDivergence.
 *
 * Responsibilities:
 *   - evaluateWindow({featureOrStream, referenceWindow, currentWindow,
 *     alpha, timestamp, hysteresisWindows}): runs the KS test for one
 *     rolling-window tick, determines whether this evaluation confirms a
 *     hysteresis-gated state transition, and appends exactly one
 *     permanent DriftEvents row carrying both the raw per-window signal
 *     and the resulting in-effect published state — never mutates a
 *     prior row (DriftEvents is append-only).
 *   - getDriftStatus(featureOrStream): the latest published state for a
 *     feature/stream (Volume III's `stage7.getStatus()`) — defaults to
 *     "stable" if never evaluated, a disclosed, standard default.
 *   - listDriftEvents(featureOrStream, {limit}): a feature/stream's full
 *     evaluation history, oldest first (Volume III's
 *     `stage7.listDriftEvents()`, matching every other list*() function's
 *     ordering convention in this codebase).
 *
 * Inputs: a featureOrStream key, two numeric-array windows (reference and
 *   current), a significance level, and the hysteresis window count.
 * Outputs: Promises resolving to a frozen DriftEvents record, the current
 *   status, or an array of records.
 * Dependencies: statistics/driftDetection.js,
 *   storage/researchMonitoringDb.js (getDriftEventsAdapter),
 *   core/constants.js (THRESHOLDS.DRIFT_HYSTERESIS_WINDOWS).
 *
 * Public API: DRIFT_STATES, InvalidDriftSurveillanceInputError,
 *   evaluateWindow, getDriftStatus, listDriftEvents.
 * Internal API: none.
 *
 * Error handling: malformed inputs throw
 *   InvalidDriftSurveillanceInputError before any read or write (the
 *   underlying KS-test input validation, from driftDetection.js, is
 *   allowed to propagate as-is since it already throws a clear, named
 *   error).
 * Performance notes: evaluateWindow reads at most (hysteresisWindows - 1)
 *   prior rows via the existing by_feature_timestamp index (bounded,
 *   never an unbounded scan) plus one KS-test computation over the
 *   caller-supplied windows; writes exactly one new row.
 * Threading model: main-thread only for the storage/hysteresis logic in
 *   this file — the underlying KS-test computation itself
 *   (driftDetection.js) is pure and Worker-safe, matching Volume III's
 *   own execution-model split (main thread owns window hand-off and
 *   state; the statistical test itself runs wherever called from).
 * Storage usage: append-only writes to the existing DriftEvents store
 *   only; reads only its own store via the existing bounded index.
 * Complexity analysis: O(log n + hysteresisWindows) per evaluateWindow
 *   call; O(1) for getDriftStatus (single queryLatestByIndex read).
 * Future extension notes: once additional regime-change detectors are
 *   added to driftDetection.js (copula audit, spectral coherence, BCPD —
 *   see that module's own Future extension notes), this engine can
 *   combine multiple detectors' verdicts (e.g. require agreement) without
 *   changing its own storage schema — each DriftEvents row already
 *   carries a `method` field for exactly this purpose.
 */

import { detectRegimeChange } from '../statistics/driftDetection.js';
import { getDriftEventsAdapter } from '../storage/researchMonitoringDb.js';
import { THRESHOLDS } from '../core/constants.js';

export const DRIFT_STATES = Object.freeze({
  STABLE: 'stable',
  DRIFTED: 'drifted',
});

export class InvalidDriftSurveillanceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDriftSurveillanceInputError';
  }
}

function assertValidFeatureOrStream(featureOrStream, label) {
  if (!featureOrStream || typeof featureOrStream !== 'string') {
    throw new InvalidDriftSurveillanceInputError(`${label}: "featureOrStream" must be a non-empty string`);
  }
}

/**
 * The latest published drift status for a feature/stream. Defaults to
 * "stable" if never evaluated -- a disclosed, standard default (a
 * feature/stream is assumed stable until evidence accumulates otherwise).
 */
export async function getDriftStatus(featureOrStream) {
  assertValidFeatureOrStream(featureOrStream, 'getDriftStatus');
  const adapter = await getDriftEventsAdapter();
  const latest = await adapter.queryLatestByIndex('by_feature_timestamp', [featureOrStream]);
  if (!latest) {
    return Object.freeze({
      featureOrStream,
      state: DRIFT_STATES.STABLE,
      statistic: null,
      pValue: null,
      asOf: null,
      neverEvaluated: true,
    });
  }
  return Object.freeze({
    featureOrStream,
    state: latest.stateAfter,
    statistic: latest.statistic,
    pValue: latest.pValue,
    asOf: latest.timestamp,
    neverEvaluated: false,
  });
}

/** A feature/stream's full evaluation history, oldest first. */
export async function listDriftEvents(featureOrStream, { limit = Infinity } = {}) {
  assertValidFeatureOrStream(featureOrStream, 'listDriftEvents');
  const adapter = await getDriftEventsAdapter();
  const rows = await adapter.listByIndexRange('by_feature_timestamp', [featureOrStream], { limit });
  return rows.slice().sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Evaluates one rolling-window tick for a feature/stream: runs the KS
 * test, determines whether this evaluation -- combined with the most
 * recent (hysteresisWindows - 1) already-stored raw evaluations -- forms
 * a full hysteresis-confirmed streak in a NEW direction, and permanently
 * records the result. See module header for the full hysteresis
 * rationale.
 */
export async function evaluateWindow({
  featureOrStream,
  referenceWindow,
  currentWindow,
  alpha = THRESHOLDS.ALPHA_DEFAULT,
  timestamp,
  hysteresisWindows = THRESHOLDS.DRIFT_HYSTERESIS_WINDOWS,
} = {}) {
  assertValidFeatureOrStream(featureOrStream, 'evaluateWindow');
  if (!Number.isInteger(hysteresisWindows) || hysteresisWindows < 1) {
    throw new InvalidDriftSurveillanceInputError('evaluateWindow: "hysteresisWindows" must be a positive integer');
  }

  // Let driftDetection.js's own InvalidDriftDetectionInputError propagate
  // for malformed windows/alpha -- it is already a clear, named error and
  // duplicating its validation here would risk the two definitions
  // silently drifting apart.
  const { statistic, pValue, driftDetected: rawDriftDetected } = detectRegimeChange({ referenceWindow, currentWindow, alpha });

  const [currentStatus, priorRows] = await Promise.all([
    getDriftStatus(featureOrStream),
    (async () => {
      if (hysteresisWindows <= 1) return [];
      const adapter = await getDriftEventsAdapter();
      return adapter.listByIndexRange('by_feature_timestamp', [featureOrStream], { limit: hysteresisWindows - 1 });
    })(),
  ]);

  const candidateNewState = rawDriftDetected ? DRIFT_STATES.DRIFTED : DRIFT_STATES.STABLE;
  const streak = [rawDriftDetected, ...priorRows.map((row) => row.rawDriftDetected)];
  const fullStreakAgrees = streak.length === hysteresisWindows && streak.every((v) => v === rawDriftDetected);
  const transitionConfirmed = fullStreakAgrees && candidateNewState !== currentStatus.state;

  const resolvedTimestamp = timestamp ?? Date.now();
  const record = {
    id: `de_${featureOrStream}_${resolvedTimestamp}_${Math.random().toString(36).slice(2, 10)}`,
    featureOrStream,
    timestamp: resolvedTimestamp,
    method: 'ks-two-sample',
    statistic,
    pValue,
    alpha,
    rawDriftDetected,
    hysteresisWindows,
    published: transitionConfirmed,
    stateAfter: transitionConfirmed ? candidateNewState : currentStatus.state,
  };

  const adapter = await getDriftEventsAdapter();
  await adapter.add(record);

  return Object.freeze(record);
}
