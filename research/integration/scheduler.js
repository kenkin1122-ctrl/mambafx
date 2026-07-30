/**
 * research/integration/scheduler.js
 *
 * Purpose:
 *   The governed automatic scheduler approved in
 *   MSD_PHASE10_ARCHITECTURE_REVISION2_SCHEDULER.md. Orchestration ONLY:
 *   mode management (Manual/Automatic/Paused), trigger evaluation
 *   cadence, serialization (at most one campaign at a time), audit
 *   logging, browser-tab lifecycle, and crash-safe recovery. It contains
 *   zero statistics, zero ranking logic, zero governance logic — every
 *   one of those stays in research/src/.
 *
 * Scope reminder (Revision 2 §1, re-affirmed): "campaign" here means one
 *   call to campaignRunner.runResearchCampaignStep(), which itself only
 *   calls the confirmed read-only prioritizeNextRepresentationFamily().
 *   Automating this automates WHEN the ranking question gets asked, not
 *   WHAT gets scientifically decided — no hypothesis registration, no
 *   FDR wealth spend, no funnel advance, no publication decision ever
 *   happens automatically because of this file. Those remain exactly as
 *   manual as they were before this file existed.
 *
 * What this module NEVER does:
 *   - Import onlineFdr.js, discoveryDecision.js, lockbox.js,
 *     publicationStatus.js, randomnessAudit.js, rngForensics.js,
 *     funnel.js, searchEngine.js, campaignPrioritization.js,
 *     researchPipeline.js, or liveResearchOrchestrator.js. Its only
 *     research-facing call is campaignRunner.runResearchCampaignStep(),
 *     identical to what the dashboard's manual button already called in
 *     Phase 10 v1 — this file adds a governed caller, not a new callee.
 *   - Persist anything itself. All persistence goes through
 *     schedulerState.js (Phase 10B), which lives in its own database,
 *     physically separate from every scientific store.
 *   - Attempt to "catch up" missed executions. A hidden tab or a closed
 *     browser simply means no trigger evaluation happened during that
 *     window; on resume, evaluation resumes from `now`, never rewound.
 *
 * Responsibilities:
 *   - initScheduler(): the one boot-time entry point. Performs exactly
 *     the sequence bootstrap.js's Phase 10B addition used to do inline
 *     (restore -> refresh feature flag -> persist -> log) but now owned
 *     here, plus wires the tick-event listener (event-driven/batch-count
 *     policies), the time-based interval (if configured), and the
 *     document.visibilitychange listener. On a genuine first-ever boot
 *     (nothing ever persisted, persistence healthy) it also applies
 *     window.MSD_RESEARCH_SCHEDULER_CONFIG ({mode?, policy?}), per
 *     Revision 2 §6's "scheduler config beneath the feature flag" --
 *     each field is validated independently and a malformed config can
 *     never throw or block boot. On every later boot the persisted
 *     state (the operator's own dashboard choices) always wins instead;
 *     the static config never overrides a real prior decision.
 *   - setMode(mode) / pause() / resume() / runOnce() / configurePolicy(policy):
 *     the scheduler's public control surface — the exact five actions
 *     the dashboard's Scheduler panel calls.
 *   - getStatus(): read-only snapshot for dashboardUI.js/healthMonitor.js.
 *   - shutdown(): full teardown (tests/rollback).
 *
 * Inputs: window.MSD_RESEARCH_SCHEDULER_CONFIG, read once at
 *   initScheduler() time and only applied on a first-ever boot (see
 *   above); setMode/configurePolicy take their own explicit arguments;
 *   otherwise reads schedulerState.js and tickListener.js internally.
 * Outputs: Promises resolving to status snapshots; side-effecting
 *   listener/interval wiring from initScheduler().
 * Dependencies: ./schedulerState.js, ./schedulerPolicies.js,
 *   ./tickListener.js, ./campaignRunner.js.
 *
 * Public API: initScheduler, setMode, pause, resume, runOnce,
 *   configurePolicy, getStatus, shutdown, SCHEDULER_MODES,
 *   SCHEDULER_STATUSES, _resetForTesting.
 * Internal API: attemptRun, evaluateAndMaybeRun, persistLiveState.
 *
 * Error handling: attemptRun() wraps campaignRunner in try/catch; a
 *   thrown error moves runState to 'error', records lastError, appends
 *   an audit entry, and returns to 'idle' — automatic mode is never
 *   disabled by a single failed/expected-empty prioritization attempt.
 *   Nothing in this file can throw out of initScheduler()'s own top-level
 *   try/catch into bootstrap.js's boot sequence.
 * Performance notes: O(1) per trigger evaluation; campaign execution
 *   cost is entirely campaignRunner's/Phase 9's own, unchanged.
 * Threading model: main thread.
 * Storage usage: read/write via schedulerState.js only (its own
 *   dedicated database).
 * Complexity analysis: O(1) per call plus whatever
 *   runResearchCampaignStep() itself costs (already analyzed in Phase 9).
 * Future extension notes: a fourth control action (e.g. "skip next
 *   scheduled run") is one more exported function calling
 *   persistLiveState() at the end, following the same shape as
 *   pause()/resume() below.
 */

import {
  SCHEDULER_MODES,
  SCHEDULER_STATUSES,
  createDefaultSchedulerState,
  saveSchedulerState,
  restoreSchedulerState,
  appendAuditLogEntry,
} from './schedulerState.js';
import { shouldTrigger, computeNextScheduledExecution, validatePolicy } from './schedulerPolicies.js';
import { getLastTickSummary, attachTickListener } from './tickListener.js';
import { runResearchCampaignStep } from './campaignRunner.js';

const TICK_EVENT_NAME = 'mambafx:marketStatesWritten';

let _state = null;           // live in-memory state (superset of the persisted snapshot's fields)
let _bootTime = null;
let _tabHidden = false;
let _modeBeforePause = SCHEDULER_MODES.MANUAL;
let _lastExecutionBatchCount = 0;   // tickSummary.eventsObservedThisSession as of the last execution
let _lastExecutionWrittenCount = 0; // tickSummary.totalWrittenThisSession as of the last execution
let _pendingRun = false;     // coalesced "one more run is due" flag -- never a growing backlog
let _tickHandler = null;
let _visibilityHandler = null;
let _timeBasedIntervalHandle = null;
let _initialized = false;
let _target = null;

function isBrowserLike(target) {
  return target && typeof target.addEventListener === 'function';
}

/**
 * Phase 10C: reads window.MSD_RESEARCH_SCHEDULER_CONFIG (Revision 2 §6,
 * "scheduler config beneath the feature flag"). Never throws -- a missing
 * or malformed global is simply treated as "no initial config."
 */
function safeReadInitialConfig(target) {
  try {
    const cfg = target && target.MSD_RESEARCH_SCHEDULER_CONFIG;
    return (cfg && typeof cfg === 'object') ? cfg : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Applies an initial {mode?, policy?} config onto a freshly-defaulted
 * state, in place. Each field is validated independently -- an invalid
 * mode does not prevent a valid policy from being applied, and vice
 * versa. Never throws; any failure just leaves the field at its safe
 * default.
 */
function applyInitialConfig(state, config) {
  if (!config) return;
  try {
    if (typeof config.mode === 'string' && Object.values(SCHEDULER_MODES).includes(config.mode)) {
      state.mode = config.mode;
      if (config.mode === SCHEDULER_MODES.PAUSED) {
        state.pausedReason = state.pausedReason || 'Paused by initial scheduler config.';
      }
    }
  } catch (_err) { /* leave state.mode at its safe default */ }
  try {
    if (config.policy && typeof config.policy === 'object') {
      const { valid } = validatePolicy(config.policy);
      if (valid) {
        state.schedulingPolicy = config.policy;
      }
    }
  } catch (_err) { /* leave state.schedulingPolicy at its safe default */ }
}

async function persistLiveState() {
  if (!_state) return;
  await saveSchedulerState(_state).catch(() => { /* schedulerState.js already degrades internally; nothing further to do here */ });
}

function buildPolicyEvalState(now) {
  const tickSummary = getLastTickSummary();
  return {
    tickSummary,
    lastExecutionBatchCount: _lastExecutionBatchCount,
    lastExecutionWrittenCount: _lastExecutionWrittenCount,
    lastExecutionTime: _state ? _state.lastExecutionTime : null,
    bootTime: _bootTime || now,
  };
}

/** The single serialization point. At most one in-flight call to campaignRunner at a time; a trigger arriving while running is coalesced into `_pendingRun`, never stacked. */
async function attemptRun(reason) {
  if (!_state) return;
  if (_state.schedulerStatus === SCHEDULER_STATUSES.RUNNING) {
    _pendingRun = true;
    _state.queue = 1;
    await persistLiveState();
    return;
  }

  _state.schedulerStatus = SCHEDULER_STATUSES.RUNNING;
  _state.queue = 0;
  await persistLiveState();

  const startedAt = Date.now();
  let result;
  let threw = null;
  try {
    result = await runResearchCampaignStep();
    _state.currentlyRunningCampaign = result && result.prioritization ? result.prioritization.armId : null;
  } catch (err) {
    threw = err;
  }
  const durationMs = Date.now() - startedAt;

  const tickSummary = getLastTickSummary();
  _lastExecutionBatchCount = tickSummary.eventsObservedThisSession;
  _lastExecutionWrittenCount = tickSummary.totalWrittenThisSession;
  _state.lastExecutionTime = startedAt;
  _state.campaignsExecutedThisSession += 1;
  _state.campaignsExecutedLifetime += 1;
  _state.currentlyRunningCampaign = null;

  if (threw) {
    _state.schedulerStatus = SCHEDULER_STATUSES.ERROR;
    _state.lastFailure = { message: threw.message, ts: startedAt };
    await appendAuditLogEntry({ event: 'run_error', detail: { reason, message: threw.message, durationMs } });
  } else {
    _state.schedulerStatus = SCHEDULER_STATUSES.IDLE;
    _state.lastSuccessfulExecution = startedAt;
    await appendAuditLogEntry({ event: 'run_complete', detail: { reason, ok: result.ok, message: result.message, durationMs } });
  }

  // Always return to idle so the next trigger (or a queued one below) can
  // proceed -- an error is a reported, expected outcome (see module
  // header), never a state that wedges the scheduler shut.
  _state.schedulerStatus = SCHEDULER_STATUSES.IDLE;
  _state.nextScheduledExecution = computeNextScheduledExecution(
    { lastExecutionTime: _state.lastExecutionTime, bootTime: _bootTime },
    _state.schedulingPolicy
  );
  await persistLiveState();

  if (_pendingRun) {
    _pendingRun = false;
    // Coalesced: at most one further run, evaluated against CURRENT
    // state -- never a replay of the specific trigger(s) that arrived
    // while busy.
    await attemptRun('coalesced');
  }
}

function evaluateAndMaybeRun(reason, now = Date.now()) {
  if (!_state) return;
  if (_state.mode !== SCHEDULER_MODES.AUTOMATIC) return;
  if (_tabHidden) return; // never catch up -- simply does not evaluate while hidden
  const evalState = buildPolicyEvalState(now);
  if (shouldTrigger(evalState, _state.schedulingPolicy, now)) {
    attemptRun(reason).catch(() => { /* attemptRun itself never throws past its own try/catch; defensive only */ });
  }
}

function onTickEvent() {
  evaluateAndMaybeRun('event-driven-or-batch-count');
}

function onVisibilityChange() {
  _tabHidden = typeof document !== 'undefined' ? document.hidden : false;
  // Resuming visibility never triggers a compensating run by itself --
  // it only re-enables future evaluation. The next real trigger (a tick
  // event, or the next time-based interval tick) decides, using current
  // state, exactly like any other evaluation.
}

function maybeStartTimeBasedInterval() {
  if (_timeBasedIntervalHandle !== null) {
    clearInterval(_timeBasedIntervalHandle);
    _timeBasedIntervalHandle = null;
  }
  if (!_state || _state.schedulingPolicy.type !== 'time-based') return;
  const intervalMs = Number.isFinite(_state.schedulingPolicy.intervalMs) ? _state.schedulingPolicy.intervalMs : null;
  if (!intervalMs || typeof setInterval !== 'function') return;
  // Checked at a bounded granularity (never coarser than the configured
  // interval itself), not a second independent clock -- shouldTriggerTimeBased
  // is still the sole source of truth for "is it actually due."
  _timeBasedIntervalHandle = setInterval(() => evaluateAndMaybeRun('time-based'), Math.min(intervalMs, 5000));
}

/** Boot-time entry point. Never throws. */
export async function initScheduler({ target = (typeof window !== 'undefined' ? window : undefined) } = {}) {
  if (_initialized) return getStatus();
  _bootTime = Date.now();
  _target = target;

  try {
    const { state, restored, persistenceAvailable, recoveryReason } = await restoreSchedulerState();
    _state = { ...state, featureFlagState: true };

    // Phase 10C: apply window.MSD_RESEARCH_SCHEDULER_CONFIG, but ONLY on a
    // genuine first-ever boot -- nothing was ever persisted, and
    // persistence itself is healthy (no fallback-to-safe-default in
    // play). On every later boot the persisted state already reflects
    // the operator's own choices made via the dashboard, and those must
    // always win: overriding them from a static page-load config on
    // every refresh would defeat "recover cleanly after restart" and
    // could silently re-enable Automatic mode against the operator's
    // last explicit decision.
    if (!restored && persistenceAvailable && !recoveryReason) {
      applyInitialConfig(_state, safeReadInitialConfig(_target));
    }

    // Seed _modeBeforePause to match the state the scheduler is actually
    // booting into (restored OR just-applied initial config), not the
    // module's static Manual default -- otherwise a resume() called
    // before any explicit setMode() would incorrectly drop back to
    // Manual instead of the Automatic mode it actually booted into.
    if (_state.mode !== SCHEDULER_MODES.PAUSED) {
      _modeBeforePause = _state.mode;
    }

    await saveSchedulerState(_state);
    if (recoveryReason) {
      await appendAuditLogEntry({ event: 'recovery', detail: { reason: recoveryReason } });
    }
    await appendAuditLogEntry({ event: 'boot', detail: { mode: _state.mode, policy: _state.schedulingPolicy } });
  } catch (err) {
    // schedulerState.js already degrades internally and should not throw,
    // but this is a defense-in-depth backstop: never let scheduler init
    // break the legacy app.
    _state = { ...createDefaultSchedulerState({ pausedReason: `Scheduler init failed unexpectedly (${err.message}); starting Paused.` }), featureFlagState: true };
  }

  if (isBrowserLike(_target)) {
    _tickHandler = onTickEvent;
    _target.addEventListener(TICK_EVENT_NAME, _tickHandler);
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    _visibilityHandler = onVisibilityChange;
    document.addEventListener('visibilitychange', _visibilityHandler);
    _tabHidden = document.hidden === true;
  }

  maybeStartTimeBasedInterval();
  _initialized = true;
  return getStatus();
}

/** Sets the scheduler's mode. Validates against SCHEDULER_MODES; unknown modes are rejected (no-op) rather than silently accepted. */
export async function setMode(mode) {
  if (!_state) return getStatus();
  if (!Object.values(SCHEDULER_MODES).includes(mode)) return getStatus();
  const previous = _state.mode;
  if (mode !== SCHEDULER_MODES.PAUSED && previous !== SCHEDULER_MODES.PAUSED) {
    _modeBeforePause = mode;
  }
  if (previous === SCHEDULER_MODES.PAUSED && mode !== SCHEDULER_MODES.PAUSED) {
    _state.pausedReason = null;
  }
  _state.mode = mode;
  if (mode === SCHEDULER_MODES.PAUSED) {
    _state.pausedReason = _state.pausedReason || 'Paused by operator.';
  }
  await appendAuditLogEntry({ event: 'mode_changed', detail: { from: previous, to: mode } });
  maybeStartTimeBasedInterval();
  await persistLiveState();
  return getStatus();
}

/** Shorthand: pause with an explicit, human-readable reason. */
export async function pause(reason = 'Paused by operator.') {
  if (_state) _state.pausedReason = reason;
  return setMode(SCHEDULER_MODES.PAUSED);
}

/** Resumes into whichever mode (Manual or Automatic) was active before the most recent pause. */
export async function resume() {
  if (!_state) return getStatus();
  _state.lastResumeTime = Date.now();
  const target = _modeBeforePause === SCHEDULER_MODES.PAUSED ? SCHEDULER_MODES.MANUAL : _modeBeforePause;
  return setMode(target);
}

/** Manual, explicit, one-time execution. Works regardless of current mode (Manual/Automatic/Paused) -- an operator's direct request is never blocked by the mode selector. */
export async function runOnce() {
  if (!_state) return getStatus();
  await attemptRun('manual-run-once');
  return getStatus();
}

/** Updates the active scheduling policy. Rejects (no-op) an invalid policy shape rather than adopting one that could never trigger correctly. */
export async function configurePolicy(policy) {
  if (!_state) return getStatus();
  const { valid } = validatePolicy(policy);
  if (!valid) return getStatus();
  _state.schedulingPolicy = policy;
  _state.nextScheduledExecution = computeNextScheduledExecution({ lastExecutionTime: _state.lastExecutionTime, bootTime: _bootTime }, policy);
  await appendAuditLogEntry({ event: 'policy_changed', detail: { policy } });
  maybeStartTimeBasedInterval();
  await persistLiveState();
  return getStatus();
}

/** Read-only snapshot for dashboardUI.js / healthMonitor.js. */
export function getStatus() {
  if (!_state) {
    return { ...createDefaultSchedulerState(), tabHidden: false, initialized: false };
  }
  return { ..._state, tabHidden: _tabHidden, initialized: _initialized };
}

/** Full teardown -- tests/rollback. */
export function shutdown() {
  if (_target && _tickHandler) _target.removeEventListener(TICK_EVENT_NAME, _tickHandler);
  if (typeof document !== 'undefined' && _visibilityHandler) document.removeEventListener('visibilitychange', _visibilityHandler);
  if (_timeBasedIntervalHandle !== null) clearInterval(_timeBasedIntervalHandle);
  _tickHandler = null;
  _visibilityHandler = null;
  _timeBasedIntervalHandle = null;
  _target = null;
  _initialized = false;
}

export { SCHEDULER_MODES, SCHEDULER_STATUSES };

/** Test-only: full reset of module-scoped state between test cases. */
export function _resetForTesting() {
  shutdown();
  _state = null;
  _bootTime = null;
  _tabHidden = false;
  _modeBeforePause = SCHEDULER_MODES.MANUAL;
  _lastExecutionBatchCount = 0;
  _lastExecutionWrittenCount = 0;
  _pendingRun = false;
}
