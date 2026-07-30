/**
 * research/integration/schedulerPolicies.js
 *
 * Purpose:
 *   Pure, side-effect-free trigger-decision functions for scheduler.js.
 *   Every function here answers one question — "should a campaign step
 *   run right now, given this state and this config?" — and nothing
 *   else. No timers, no DOM access, no storage, no research/src/ import
 *   of any kind. This isolation is deliberate: swapping which policy
 *   drives Automatic mode is a config change (which function scheduler.js
 *   calls), never a change to scheduler.js's own orchestration logic.
 *
 * Responsibilities:
 *   - shouldTriggerEventDriven: true once at least `minBatchesSinceLastRun`
 *     new tick-completion events have been observed since the batch count
 *     recorded at the last execution.
 *   - shouldTriggerBatchCount: true once total MarketStates written has
 *     crossed the next multiple of `batchThreshold` since the last
 *     execution's recorded count.
 *   - shouldTriggerTimeBased: true once `intervalMs` has elapsed since
 *     `lastExecutionTime` (or since `bootTime` if nothing has run yet).
 *   - computeNextScheduledExecution: the dashboard-display-only projected
 *     next run time for a time-based policy (null for any other policy
 *     type — there is nothing to project).
 *   - validatePolicy: structural validation of a policy config object,
 *     mirroring schedulerState.js's validateSchedulerState discipline
 *     (returns {valid, errors}, never throws).
 *
 * Inputs: plain state/config objects and (where relevant) a `now`
 *   timestamp, always explicitly passed in — nothing here reads
 *   Date.now() implicitly except as a default parameter, so every
 *   function is deterministic and trivially unit-testable.
 * Outputs: booleans, a timestamp-or-null, or a {valid, errors} object.
 * Dependencies: none.
 *
 * Public API: POLICY_TYPES, shouldTriggerEventDriven,
 *   shouldTriggerBatchCount, shouldTriggerTimeBased,
 *   computeNextScheduledExecution, validatePolicy.
 * Internal API: none.
 *
 * Error handling: malformed config never throws — a missing/invalid
 *   parameter simply makes the trigger function return false (never
 *   trigger) rather than crash the caller's evaluation loop.
 * Performance notes: O(1) per call.
 * Threading model: none — pure functions, safe anywhere.
 * Storage usage: none.
 * Complexity analysis: O(1).
 * Future extension notes: a fourth policy type is one more exported pure
 *   function plus one branch in POLICY_TYPES — never a change to any
 *   existing policy function or to scheduler.js's orchestration shape.
 */

export const POLICY_TYPES = Object.freeze({
  EVENT_DRIVEN: 'event-driven',
  BATCH_COUNT: 'batch-count',
  TIME_BASED: 'time-based',
});

/**
 * @param {{ tickSummary: {eventsObservedThisSession:number}, lastExecutionBatchCount: number }} state
 * @param {{ minBatchesSinceLastRun?: number }} config
 */
export function shouldTriggerEventDriven(state, config = {}) {
  const minBatches = Number.isFinite(config.minBatchesSinceLastRun) ? config.minBatchesSinceLastRun : 1;
  const observed = (state && state.tickSummary && state.tickSummary.eventsObservedThisSession) || 0;
  const lastCount = (state && Number.isFinite(state.lastExecutionBatchCount)) ? state.lastExecutionBatchCount : 0;
  return (observed - lastCount) >= minBatches;
}

/**
 * @param {{ tickSummary: {totalWrittenThisSession:number}, lastExecutionWrittenCount: number }} state
 * @param {{ batchThreshold?: number }} config
 */
export function shouldTriggerBatchCount(state, config = {}) {
  const threshold = Number.isFinite(config.batchThreshold) && config.batchThreshold > 0 ? config.batchThreshold : null;
  if (!threshold) return false;
  const written = (state && state.tickSummary && state.tickSummary.totalWrittenThisSession) || 0;
  const lastCount = (state && Number.isFinite(state.lastExecutionWrittenCount)) ? state.lastExecutionWrittenCount : 0;
  return Math.floor(written / threshold) > Math.floor(lastCount / threshold);
}

/**
 * @param {{ lastExecutionTime: number|null, bootTime: number }} state
 * @param {{ intervalMs?: number }} config
 * @param {number} now
 */
export function shouldTriggerTimeBased(state, config = {}, now = Date.now()) {
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0 ? config.intervalMs : null;
  if (!intervalMs) return false;
  const anchor = (state && Number.isFinite(state.lastExecutionTime)) ? state.lastExecutionTime : ((state && state.bootTime) || now);
  return (now - anchor) >= intervalMs;
}

/**
 * Dashboard-display-only projection. Returns null for any policy type
 * other than time-based -- there is nothing meaningful to project for
 * event-driven/batch-count policies (they fire on data arrival, not a
 * clock).
 */
export function computeNextScheduledExecution(state, config = {}, now = Date.now()) {
  if (!config || config.type !== POLICY_TYPES.TIME_BASED) return null;
  const intervalMs = Number.isFinite(config.intervalMs) && config.intervalMs > 0 ? config.intervalMs : null;
  if (!intervalMs) return null;
  const anchor = (state && Number.isFinite(state.lastExecutionTime)) ? state.lastExecutionTime : ((state && state.bootTime) || now);
  return anchor + intervalMs;
}

const VALID_POLICY_TYPES = Object.values(POLICY_TYPES);

/** Structural validation only -- never throws. */
export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return { valid: false, errors: ['policy must be an object'] };
  if (!VALID_POLICY_TYPES.includes(policy.type)) errors.push(`policy.type must be one of ${VALID_POLICY_TYPES.join(', ')}`);
  if (policy.type === POLICY_TYPES.EVENT_DRIVEN && policy.minBatchesSinceLastRun !== undefined && (!Number.isFinite(policy.minBatchesSinceLastRun) || policy.minBatchesSinceLastRun <= 0)) {
    errors.push('policy.minBatchesSinceLastRun must be a positive number when provided');
  }
  if (policy.type === POLICY_TYPES.BATCH_COUNT && (!Number.isFinite(policy.batchThreshold) || policy.batchThreshold <= 0)) {
    errors.push('policy.batchThreshold must be a positive number for batch-count policies');
  }
  if (policy.type === POLICY_TYPES.TIME_BASED && (!Number.isFinite(policy.intervalMs) || policy.intervalMs <= 0)) {
    errors.push('policy.intervalMs must be a positive number for time-based policies');
  }
  return { valid: errors.length === 0, errors };
}

/** Dispatches to the correct trigger function by policy.type. Returns false for an unrecognized/invalid policy rather than throwing. */
export function shouldTrigger(state, policy, now = Date.now()) {
  if (!policy || typeof policy !== 'object') return false;
  switch (policy.type) {
    case POLICY_TYPES.EVENT_DRIVEN: return shouldTriggerEventDriven(state, policy);
    case POLICY_TYPES.BATCH_COUNT: return shouldTriggerBatchCount(state, policy);
    case POLICY_TYPES.TIME_BASED: return shouldTriggerTimeBased(state, policy, now);
    default: return false;
  }
}
