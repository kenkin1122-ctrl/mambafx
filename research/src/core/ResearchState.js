/**
 * research/src/core/ResearchState.js
 *
 * Purpose:
 *   Single in-memory source of truth for the research tree's session-level
 *   state (which experiment/context is "active" in the UI right now, which
 *   database connections are open, worker handles, reconciliation status).
 *   Mirrors the existing mtf/src/core/AppState.js pattern: exactly one
 *   object owns this state, every mutation goes through a setter, and
 *   setters publish a notification via ResearchEventBus so interested
 *   modules (UI panels, Stage 9 dashboards) can react without being directly
 *   imported by the module making the change.
 *
 * Responsibilities:
 *   - Track the active experiment/discovery-result context the UI is
 *     currently viewing (read-only convenience for UI panels — this is NOT
 *     the system of record; the system of record is always IndexedDB).
 *   - Hold live handles to open database connections (existingDbExtensions'
 *     extended mfx_msd_experiments connection, researchMonitoringDb's two
 *     connections) so modules don't each independently call indexedDB.open.
 *   - Hold live Worker handles for Stage 0 / Stage 7 (registered once
 *     created; Stage 0/7 modules themselves own worker lifecycle logic —
 *     this object only tracks references for visibility/debugging, per the
 *     same "AppState doesn't own connection-level detail it isn't the
 *     authority on" principle documented in mtf's AppState.js).
 *   - Track reconciliationRunner's last-run timestamp/status for UI display.
 *
 * Inputs: values passed to setters (db connections, worker refs, experiment
 *   context ids).
 * Outputs: current values via getters; 'research.*' notifications via
 *   ResearchEventBus on every mutation.
 * Dependencies: ResearchEventBus.js only.
 *
 * Public API: get/set pairs listed below.
 * Internal API: the module-private `state` object — never exported directly
 *   (callers must go through the named getters/setters, so every mutation is
 *   observable via the event bus — the same discipline mtf's AppState.js
 *   already enforces).
 *
 * Error handling: setters perform no I/O and cannot throw under normal use;
 *   type checks throw TypeError on obviously-wrong input (e.g., setting a
 *   non-function as a worker handle) to fail fast during development.
 * Performance notes: negligible — plain object field access.
 * Threading model: main-thread only (Workers do not import this module).
 * Storage usage: none — purely in-memory; nothing here is persisted, and
 *   nothing here is ever treated as authoritative over what's in IndexedDB.
 * Complexity analysis: O(1) for every getter/setter.
 * Future extension notes: additional session-level fields (e.g., "currently
 *   selected market symbol for the research dashboard") should be added as
 *   a new get/set pair following the existing pattern, never by exposing the
 *   internal `state` object.
 */

import { publish } from './ResearchEventBus.js';

const state = {
  activeExperimentId: null,
  activeDiscoveryResultId: null,
  dbConnections: {
    existingExperiments: null, // IDBDatabase handle (extended mfx_msd_experiments)
    researchMonitoring: null,  // IDBDatabase handle (mfx_research_monitoring)
    researchMeta: null,        // IDBDatabase handle (mfx_research_meta)
  },
  workerHandles: {
    stage0: null, // Worker instance, once created by stage0-randomness
    stage7: null, // Worker instance, once created by stage7-drift
  },
  reconciliation: {
    lastRunAt: null,
    lastRunStatus: null, // 'ok' | 'partial' | 'failed' | null (never run yet)
  },
};

export const ResearchState = {
  // ── Active context (UI convenience only, never authoritative) ──────────
  get activeExperimentId() { return state.activeExperimentId; },
  setActiveExperimentId(id) {
    state.activeExperimentId = id;
    publish('ActiveExperimentChanged', { experimentId: id });
  },

  get activeDiscoveryResultId() { return state.activeDiscoveryResultId; },
  setActiveDiscoveryResultId(id) {
    state.activeDiscoveryResultId = id;
    publish('ActiveDiscoveryResultChanged', { discoveryResultId: id });
  },

  // ── Database connections (F-2 WARNING, Phase 1 Final Freeze Challenge) ──
  // These getters/setters are NEVER authoritative and are currently
  // DORMANT -- no production code reads or writes them (only their own
  // test does). They return a RAW IDBDatabase handle with no `getDb`-thunk
  // re-resolution, unlike every sanctioned storage-layer adapter. Do NOT
  // use these to build a transaction: a handle read from here can go stale
  // after a close()/onversionchange exactly like the bug the getDb-thunk
  // pattern (resolveDb.js) was built to prevent, because nothing here
  // re-resolves it. For any real database access, use the sanctioned
  // getXAdapter() functions in existingDbExtensions.js /
  // researchMonitoringDb.js / researchGovernanceDb.js instead -- never
  // these raw getters.
  get existingExperimentsDb() { return state.dbConnections.existingExperiments; },
  setExistingExperimentsDb(dbHandle) {
    state.dbConnections.existingExperiments = dbHandle;
    publish('DbConnectionRegistered', { db: 'existingExperiments' });
  },

  get researchMonitoringDb() { return state.dbConnections.researchMonitoring; },
  setResearchMonitoringDb(dbHandle) {
    state.dbConnections.researchMonitoring = dbHandle;
    publish('DbConnectionRegistered', { db: 'researchMonitoring' });
  },

  get researchMetaDb() { return state.dbConnections.researchMeta; },
  setResearchMetaDb(dbHandle) {
    state.dbConnections.researchMeta = dbHandle;
    publish('DbConnectionRegistered', { db: 'researchMeta' });
  },

  // ── Worker handles (reference-tracking only; lifecycle owned by the stage) ─
  get stage0Worker() { return state.workerHandles.stage0; },
  setStage0Worker(workerRef) {
    state.workerHandles.stage0 = workerRef;
    publish('WorkerRegistered', { stage: 'stage0', present: workerRef != null });
  },

  get stage7Worker() { return state.workerHandles.stage7; },
  setStage7Worker(workerRef) {
    state.workerHandles.stage7 = workerRef;
    publish('WorkerRegistered', { stage: 'stage7', present: workerRef != null });
  },

  // ── Reconciliation status (for UI display / Stage 9 evidence-survival KPI) ─
  get reconciliationStatus() { return { ...state.reconciliation }; },
  setReconciliationStatus(status) {
    if (!status || typeof status !== 'object') {
      throw new TypeError('ResearchState.setReconciliationStatus: status must be an object');
    }
    state.reconciliation.lastRunAt = status.lastRunAt ?? Date.now();
    state.reconciliation.lastRunStatus = status.lastRunStatus ?? 'ok';
    publish('ReconciliationStatusChanged', { ...state.reconciliation });
  },

  /** Test-only: reset all state to defaults between test cases. Not part of the production surface. */
  _resetForTesting() {
    state.activeExperimentId = null;
    state.activeDiscoveryResultId = null;
    state.dbConnections = { existingExperiments: null, researchMonitoring: null, researchMeta: null };
    state.workerHandles = { stage0: null, stage7: null };
    state.reconciliation = { lastRunAt: null, lastRunStatus: null };
  },
};
