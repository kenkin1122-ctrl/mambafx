/**
 * research/integration/healthMonitor.js
 *
 * Purpose:
 *   Phase 10B, Enhancement 2 — a strictly READ-ONLY observability layer
 *   over the scheduler, the tick-visibility cache, storage, and the
 *   browser environment. Answers "is the integration layer healthy right
 *   now," nothing else.
 *
 * What this module NEVER does (stated explicitly, same discipline as
 *   every other file in research/integration/):
 *   - It never writes to schedulerState (only reads via
 *     getCurrentSnapshotForMonitoring, a read-only accessor).
 *   - It never calls campaignRunner, campaignPrioritization, or any
 *     research/src/discovery or research/src/governance function that
 *     could register a hypothesis, run a funnel round, spend Online FDR
 *     wealth, or change a Publication Status. Its only research/src/
 *     import is knowledgeGraph.js's queryActiveRepresentationFamilies
 *     (a confirmed read-only query, already used identically by
 *     dashboardReadModel.js) purely to report a count.
 *   - Its global error/rejection listeners exist ONLY to increment a
 *     counter and record the message -- they never call
 *     preventDefault() and never suppress or alter default browser error
 *     handling/reporting.
 *   - Its periodic self-diagnostics (queue consistency, DB connectivity,
 *     feature-flag consistency) only ever perform reads (or, for DB
 *     connectivity, an idempotent open() with no transaction) -- never a
 *     write, and never to any mfx_msd_* or mfx_research_governance
 *     store's content.
 *
 * Responsibilities:
 *   - startHealthMonitor(): wires the global error/rejection/online/
 *     offline listeners and starts a bounded-interval self-diagnostic
 *     loop. Idempotent (calling twice does not double-attach).
 *   - stopHealthMonitor(): full teardown (test/rollback use).
 *   - getHealthReport(): the one function dashboardUI.js calls. Gathers
 *     the current scheduler snapshot, tick summary, storage/browser
 *     status, and this module's own exception counters into one object,
 *     plus a computed {level, explanation} health indicator.
 *   - runDiagnosticsOnce(): the self-diagnostic pass, exposed separately
 *     so tests can invoke it deterministically instead of waiting on a
 *     real interval.
 *
 * Inputs: none directly; reads schedulerState.js, tickListener.js,
 *   knowledgeGraph.js (one query), and ambient browser globals
 *   (navigator, document, performance) where available.
 * Outputs: Promise<HealthReport> from getHealthReport(); side-effecting
 *   listener attachment from startHealthMonitor().
 * Dependencies: ./schedulerState.js, ./tickListener.js,
 *   ../src/governance/knowledgeGraph.js (read-only query only).
 *
 * Public API: startHealthMonitor, stopHealthMonitor, getHealthReport,
 *   runDiagnosticsOnce, computeHealthIndicator, _resetForTesting.
 * Internal API: recordException.
 *
 * Error handling: every read is individually try/caught; a failure in
 *   one section (e.g. storage estimate unsupported) degrades that
 *   section to "unavailable," never blanks the whole report.
 * Performance notes: getHealthReport() is O(1) plus one bounded
 *   knowledgeGraph query (already index-bounded); the diagnostic
 *   interval defaults to 30s and does only O(1) checks per tick.
 * Threading model: main thread.
 * Storage usage: read-only against mfx_research_scheduler_state and
 *   mfx_research_governance; opens (never writes to) both purely to
 *   confirm connectivity for the "database connectivity" diagnostic.
 * Complexity analysis: O(1) per report/diagnostic pass.
 * Future extension notes: additional System-section fields (e.g. a
 *   future battery-status API) should feature-detect and degrade to
 *   "unavailable" exactly like memoryWarning/storageEstimate already do
 *   below, never assume browser support.
 */

import {
  getCurrentSnapshotForMonitoring,
  listRecentAuditLog,
  openSchedulerStateDb,
  createDefaultSchedulerState,
} from './schedulerState.js';
import { getLastTickSummary } from './tickListener.js';
import { queryActiveRepresentationFamilies } from '../src/governance/knowledgeGraph.js';
import { openResearchGovernanceDb } from '../src/storage/researchGovernanceDb.js';

const DIAGNOSTIC_INTERVAL_MS_DEFAULT = 30000;

let _exceptionCount = 0;
let _lastException = null;
let _errorHandler = null;
let _rejectionHandler = null;
let _diagnosticIntervalHandle = null;
let _bootTime = null;
let _lastDiagnostics = null;

function recordException(message) {
  _exceptionCount += 1;
  _lastException = { message, ts: Date.now() };
}

/** Idempotent: safe to call multiple times (e.g. re-entrant bootstrap). */
export function startHealthMonitor({ target = (typeof window !== 'undefined' ? window : undefined), intervalMs = DIAGNOSTIC_INTERVAL_MS_DEFAULT } = {}) {
  if (_bootTime !== null) return; // already started
  _bootTime = Date.now();

  if (target && typeof target.addEventListener === 'function') {
    _errorHandler = (evt) => recordException((evt && evt.message) || 'unknown error');
    _rejectionHandler = (evt) => recordException((evt && evt.reason && evt.reason.message) || String((evt && evt.reason) || 'unhandled rejection'));
    target.addEventListener('error', _errorHandler);
    target.addEventListener('unhandledrejection', _rejectionHandler);
  }

  if (intervalMs > 0 && typeof setInterval === 'function') {
    _diagnosticIntervalHandle = setInterval(() => {
      runDiagnosticsOnce().catch((err) => recordException(err.message));
    }, intervalMs);
  }
}

/** Full teardown -- test/rollback use. */
export function stopHealthMonitor({ target = (typeof window !== 'undefined' ? window : undefined) } = {}) {
  if (target && typeof target.removeEventListener === 'function') {
    if (_errorHandler) target.removeEventListener('error', _errorHandler);
    if (_rejectionHandler) target.removeEventListener('unhandledrejection', _rejectionHandler);
  }
  if (_diagnosticIntervalHandle !== null) {
    clearInterval(_diagnosticIntervalHandle);
    _diagnosticIntervalHandle = null;
  }
  _errorHandler = null;
  _rejectionHandler = null;
  _bootTime = null;
}

/**
 * Lightweight, read-only self-diagnostic pass. Returns
 * { queueConsistent, persistenceReachable, databaseConnectivity,
 *   featureFlagConsistent, ranAt }.
 */
export async function runDiagnosticsOnce() {
  const result = { queueConsistent: true, persistenceReachable: true, databaseConnectivity: true, featureFlagConsistent: true, ranAt: Date.now() };

  try {
    const { snapshot, available } = await getCurrentSnapshotForMonitoring();
    result.persistenceReachable = available;
    if (available && snapshot) {
      result.queueConsistent = typeof snapshot.queue === 'number' && snapshot.queue >= 0 && snapshot.queue <= 1;
      const liveFlag = typeof window !== 'undefined' ? window.MSD_RESEARCH_ENGINE_ENABLED === true : false;
      result.featureFlagConsistent = snapshot.featureFlagState === liveFlag;
    }
  } catch (err) {
    result.persistenceReachable = false;
    recordException(err.message);
  }

  try {
    await openSchedulerStateDb();
  } catch (err) {
    result.databaseConnectivity = false;
    recordException(err.message);
  }

  _lastDiagnostics = result;
  return result;
}

async function getStorageSection() {
  const section = { indexedDbAvailable: typeof indexedDB !== 'undefined', databaseVersion: null, storageEstimate: null, persistenceAvailable: true };
  try {
    const db = await openResearchGovernanceDb();
    section.databaseVersion = db.version;
  } catch (err) {
    section.persistenceAvailable = false;
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      section.storageEstimate = await navigator.storage.estimate();
    }
  } catch {
    section.storageEstimate = null;
  }
  return section;
}

function getSystemSection() {
  return {
    lastException: _lastException,
    totalExceptions: _exceptionCount,
    browserVisibilityState: typeof document !== 'undefined' ? document.visibilityState : 'unavailable',
    onlineState: (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') ? navigator.onLine : null,
    memoryWarning: (typeof performance !== 'undefined' && performance.memory)
      ? { usedJSHeapSize: performance.memory.usedJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }
      : 'unavailable',
  };
}

/**
 * Deterministic, documented thresholds -- not a scientific claim, an
 * operational heuristic for the dashboard's traffic light.
 */
export function computeHealthIndicator({ scheduler, storage, system, diagnostics }) {
  const reasons = [];

  if (scheduler.schedulerStatus === 'error') reasons.push('scheduler is in an error state');
  if (!storage.persistenceAvailable) reasons.push('scheduler/governance persistence is unavailable');
  if (diagnostics && diagnostics.databaseConnectivity === false) reasons.push('a database connectivity check failed');
  if (reasons.length) return { level: '🔴', explanation: reasons.join('; ') };

  const warnings = [];
  if (system.onlineState === false) warnings.push('browser is offline');
  if (scheduler.mode === 'automatic' && system.browserVisibilityState === 'hidden') warnings.push('automatic mode is paused because the tab is hidden');
  if (scheduler.queue > 0) warnings.push('a campaign run is queued');
  if (diagnostics && diagnostics.featureFlagConsistent === false) warnings.push('feature flag state does not match persisted scheduler state');
  if (system.totalExceptions > 0) warnings.push(`${system.totalExceptions} exception(s) observed this session`);
  if (warnings.length) return { level: '🟡', explanation: warnings.join('; ') };

  return { level: '🟢', explanation: 'No issues detected.' };
}

/** The one function dashboardUI.js calls to paint the Health Monitor panel. */
export async function getHealthReport() {
  const { snapshot } = await getCurrentSnapshotForMonitoring();
  const schedulerSnapshot = snapshot || createDefaultSchedulerState();
  const tickSummary = getLastTickSummary();
  const storage = await getStorageSection();
  const system = getSystemSection();
  const diagnostics = _lastDiagnostics;

  let activeFamilyCount = 0;
  try {
    activeFamilyCount = (await queryActiveRepresentationFamilies()).length;
  } catch {
    activeFamilyCount = 0;
  }

  const recentAudit = await listRecentAuditLog(20).catch(() => []);
  const durations = recentAudit
    .filter((r) => r.event === 'run_complete' && r.detail && Number.isFinite(r.detail.durationMs))
    .map((r) => r.detail.durationMs);
  const averageExecutionDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  const scheduler = {
    mode: schedulerSnapshot.mode,
    schedulerStatus: schedulerSnapshot.schedulerStatus,
    policy: schedulerSnapshot.schedulingPolicy,
    queue: schedulerSnapshot.queue,
    currentlyRunningCampaign: schedulerSnapshot.currentlyRunningCampaign,
    lastExecutionTime: schedulerSnapshot.lastExecutionTime,
    nextScheduledExecution: schedulerSnapshot.nextScheduledExecution,
    lastSuccessfulExecution: schedulerSnapshot.lastSuccessfulExecution,
    lastFailure: schedulerSnapshot.lastFailure,
    pausedReason: schedulerSnapshot.pausedReason,
    averageExecutionDurationMs,
    uptimeMs: _bootTime !== null ? Date.now() - _bootTime : null,
  };

  const research = {
    featureFlagEnabled: typeof window !== 'undefined' ? window.MSD_RESEARCH_ENGINE_ENABLED === true : false,
    marketStateBatchesObserved: tickSummary.eventsObservedThisSession,
    marketStatesWrittenThisSession: tickSummary.totalWrittenThisSession,
    campaignsExecuted: schedulerSnapshot.campaignsExecutedLifetime,
    campaignsExecutedThisSession: schedulerSnapshot.campaignsExecutedThisSession,
    campaignsPending: schedulerSnapshot.queue,
    activeRepresentationFamilyCount: activeFamilyCount,
    currentDiscoveryCampaign: schedulerSnapshot.currentlyRunningCampaign,
  };

  const indicator = computeHealthIndicator({ scheduler, storage, system, diagnostics });

  return { scheduler, research, storage, system, diagnostics, indicator, generatedAt: Date.now() };
}

/** Test-only: resets module-scoped counters/listeners between test cases. */
export function _resetForTesting() {
  stopHealthMonitor();
  _exceptionCount = 0;
  _lastException = null;
  _lastDiagnostics = null;
}
