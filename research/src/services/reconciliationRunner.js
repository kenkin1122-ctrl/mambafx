/**
 * research/src/services/reconciliationRunner.js
 *
 * Purpose:
 *   Implement the actual correctness mechanism behind Required Change 3
 *   (v10.1 Section 5.5): "events are notifications only; persistence is the
 *   source of truth; every event-driven stage exposes a reconciliation scan
 *   capable of finding unprocessed work after crashes." This module is the
 *   thing that CALLS every stage's reconcile() — it is the one piece of
 *   infrastructure that guarantees a dropped ResearchEventBus notification
 *   degrades to "processed a bit later," never "processed never."
 *
 * Responsibilities:
 *   - registerReconcilable(stageId, reconcileFn): stages register their
 *     reconcile() function here once implemented (Phase 2 onward — Phase 1
 *     ships with zero registrations, which is expected and tested).
 *   - runOnce(): calls every registered reconcile function, IN PARALLEL
 *     (reconciliation scans are independent of each other by construction —
 *     Stage 6's reconcile doesn't need Stage 7's to finish first), collects
 *     {stageId, ok, error?} for each, and publishes a single
 *     'ReconciliationSweepCompleted' notification summarizing the sweep.
 *     One stage's reconcile throwing NEVER prevents any other stage's
 *     reconcile from running — this mirrors the EventBus's own per-listener
 *     error isolation (Section 5.5) at the reconciliation layer.
 *   - start(intervalMs): runs runOnce() immediately, then on a repeating
 *     timer — this is the "boot-time + periodic sweep" behavior specified
 *     in v10.1.
 *   - stop(): clears the timer.
 *
 * Inputs: stageId + reconcile function (registration); intervalMs (start()).
 * Outputs: Promise<{stageId, ok, error?}[]> from runOnce(); publishes
 *   'ReconciliationSweepCompleted' via ResearchEventBus with the same array.
 * Dependencies: ResearchEventBus.js (for the completion notification —
 *   itself just a notification, not load-bearing: nothing downstream
 *   depends on receiving this event for correctness, it exists for
 *   observability/UI/Stage 9's "Evidence Survival" KPI only).
 *
 * Public API: registerReconcilable, unregisterReconcilable, runOnce, start,
 *   stop, getRegisteredReconcilables.
 * Internal API: none.
 *
 * Error handling: a throwing/rejecting reconcile function is caught
 *   per-stage; its failure is recorded in the returned/published result
 *   array as {stageId, ok:false, error} and does not abort the sweep for
 *   other stages.
 * Performance notes: reconcile functions run concurrently
 *   (Promise.allSettled), so total sweep latency is bounded by the SLOWEST
 *   individual stage's reconcile scan, not the sum of all of them.
 * Threading model: main-thread only — reconcile functions themselves may
 *   internally delegate heavy work to a Worker (Stage 0/7), but the runner's
 *   own orchestration is main-thread.
 * Storage usage: none directly — each stage's reconcile function is
 *   responsible for its own IndexedDB reads/writes.
 * Complexity analysis: O(registered stages) orchestration overhead; actual
 *   cost is dominated by each stage's own reconcile scan (which should
 *   itself be index-backed per indexingStrategy.js, not a full table scan).
 * Future extension notes: if a future stage's reconciliation needs a
 *   different cadence than the shared timer, call runOnce() manually for
 *   that one stage's id via a small wrapper — no change needed here.
 */

import { publish } from '../core/ResearchEventBus.js';
import { ResearchState } from '../core/ResearchState.js';

const reconcilables = new Map();
let timerHandle = null;
let sweepInFlight = false; // Required Fix 7: re-entrancy guard

/**
 * Required Fix 7 (defensive improvement): registering a reconcile function
 * for the same stageId twice is now detected and rejected by default,
 * mirroring pipelineRunner.registerStage's same corrective — a silent
 * overwrite here would be even higher-stakes, since it could silently drop
 * a stage's reconciliation coverage entirely if a second, no-op registration
 * ever overwrote a working one. Pass { replace: true } for a deliberate
 * re-registration.
 *
 * @param {string} stageId @param {() => Promise<any>|any} reconcileFn
 */
export function registerReconcilable(stageId, reconcileFn, { replace = false } = {}) {
  if (typeof reconcileFn !== 'function') {
    throw new TypeError(`reconciliationRunner.registerReconcilable: "${stageId}" reconcileFn must be a function`);
  }
  if (reconcilables.has(stageId) && !replace) {
    throw new Error(
      `reconciliationRunner.registerReconcilable: "${stageId}" already has a registered reconcile function. ` +
      'Call unregisterReconcilable(stageId) first, or pass { replace: true } if this is deliberate.'
    );
  }
  reconcilables.set(stageId, reconcileFn);
}

export function unregisterReconcilable(stageId) {
  reconcilables.delete(stageId);
}

export function getRegisteredReconcilables() {
  return [...reconcilables.keys()];
}

/**
 * Runs every registered stage's reconcile() concurrently and independently.
 * Never throws — failures are reported per-stage in the resolved array.
 */
export async function runOnce() {
  // Required Fix 7 (defensive improvement): if a prior sweep is still in
  // flight (e.g., a slow reconcile function took longer than the configured
  // interval), skip this tick entirely rather than starting an overlapping
  // sweep. Overlapping sweeps aren't unsafe in themselves (each stage's own
  // write-once/idempotent adapters absorb any resulting duplicate work —
  // Required Fix 4's consumeOnce, for example), but preventing the overlap
  // at the scheduling layer is strictly better than relying on that as a
  // safety net for every future stage's reconcile function to get right.
  if (sweepInFlight) {
    // Preserve the "runOnce() always resolves to an array of {stageId, ok, ...}"
    // contract even on a skipped tick — extra properties on an array don't
    // break that invariant for any caller iterating/mapping the result, but
    // do let a caller that cares detect the skip explicitly.
    const skippedResult = [];
    skippedResult.skipped = true;
    skippedResult.reason = 'previous sweep still in flight';
    return skippedResult;
  }
  sweepInFlight = true;
  try {
    return await runOnceInternal();
  } finally {
    sweepInFlight = false;
  }
}

async function runOnceInternal() {
  const entries = [...reconcilables.entries()];
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn()));

  const results = entries.map(([stageId], i) => {
    const outcome = settled[i];
    return outcome.status === 'fulfilled'
      ? { stageId, ok: true, value: outcome.value }
      : { stageId, ok: false, error: outcome.reason };
  });

  const overallStatus = results.length === 0
    ? 'ok' // nothing registered yet is a valid, non-failing state (Phase 1)
    : results.every((r) => r.ok)
      ? 'ok'
      : results.some((r) => r.ok)
        ? 'partial'
        : 'failed';

  ResearchState.setReconciliationStatus({ lastRunAt: Date.now(), lastRunStatus: overallStatus });
  publish('ReconciliationSweepCompleted', { results, overallStatus });
  return results;
}

/** Starts the boot-time + periodic reconciliation sweep. Idempotent — calling twice replaces the prior timer. */
export function start(intervalMs) {
  stop();
  // Boot-time sweep runs immediately, per v10.1 Section 5.5's "boot-time +
  // periodic sweep" requirement.
  runOnce();
  timerHandle = setInterval(runOnce, intervalMs);
  return timerHandle;
}

export function stop() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

/** Test-only: clear all registrations and stop any running timer between test cases. */
export function _resetForTesting() {
  stop();
  reconcilables.clear();
}
