/**
 * research/integration/schedulerState.js
 *
 * Purpose:
 *   Phase 10B, Enhancement 1 — a dedicated persistence layer for the
 *   research scheduler's own operational state (mode, queue, execution
 *   counters, audit trail). This is orchestration bookkeeping, not
 *   scientific memory: it contains no hypothesis, no p-value, no
 *   governance decision, and nothing here is ever read by
 *   research/src/. Deliberately given its OWN, physically separate
 *   IndexedDB database (`mfx_research_scheduler_state`) rather than a
 *   new store inside `mfx_research_governance` — this makes "never
 *   corrupt scientific databases" a structural guarantee (a different
 *   database entirely) rather than a discipline that has to be
 *   maintained by convention inside a shared DB, and keeps this file
 *   from ever needing to touch research/src/storage/researchGovernanceDb.js's
 *   schema-version ladder for a concern that isn't scientific at all.
 *
 * What this module does NOT do:
 *   - It does not decide WHEN to run a campaign (that's schedulerPolicies.js,
 *     not yet built — deferred to the next implementation round per the
 *     approved order). This file only saves/restores/validates state.
 *   - It does not import or call anything from research/src/discovery/ or
 *     research/src/governance/ — it has no scientific dependency at all.
 *   - It does not replay history on restore. Per the explicit requirement
 *     "scheduler recovery must never replay missed executions; restore
 *     only future work," restoreSchedulerState() ALWAYS normalizes
 *     schedulerStatus to 'idle', queue to 0, and currentlyRunningCampaign
 *     to null, regardless of what was persisted — a run that was
 *     mid-flight when the tab closed is gone, not resumed, because
 *     scheduling decisions (Phase 9's prioritizeNextRepresentationFamily)
 *     are stateless reads, not multi-step transactions with partial
 *     progress to resume.
 *
 * Responsibilities:
 *   - openSchedulerStateDb(): memoized versioned opener for the
 *     dedicated database (two stores: SchedulerStateSnapshot,
 *     SchedulerAuditLog), following the exact same
 *     memoized-open/onupgradeneeded/onblocked-timeout pattern already
 *     established by research/src/storage/researchGovernanceDb.js —
 *     reimplemented locally (not imported) specifically so this file
 *     has zero import edge into research/src/storage/ for its DB-opening
 *     logic, keeping the two databases' lifecycles fully independent.
 *   - createDefaultSchedulerState(): the safe, all-zero/idle starting
 *     state, used both for a first-ever boot and as the graceful
 *     fallback when a persisted record cannot be restored or fails
 *     validation.
 *   - validateSchedulerState(candidate): structural + enum + type
 *     validation. Returns {valid, errors}, never throws.
 *   - saveSchedulerState(state): atomic overwrite (IndexedDB put() to
 *     the fixed key 'current' — a single put() is one atomic
 *     transaction) of the live snapshot. Does not itself write an
 *     audit-log entry (callers append explicit, meaningful events via
 *     appendAuditLogEntry — the requirement is "append-only audit
 *     WHERE APPROPRIATE," not on every snapshot write, which could
 *     otherwise grow unbounded on every tick).
 *   - restoreSchedulerState(): the one function bootstrap.js/scheduler.js
 *     call at boot. Always resolves (never rejects) with
 *     { state, restored, persistenceAvailable, recoveryReason }.
 *   - appendAuditLogEntry({event, detail}): append-only (add()-only,
 *     reusing the existing, already-tested
 *     research/src/storage/adapters/appendOnlyAdapter.js rather than
 *     re-implementing append-only semantics — that adapter is generic
 *     IndexedDB infrastructure, not scientific logic, so reusing it here
 *     is the same kind of dependency researchGovernanceDb.js itself has
 *     on it, not a new exception).
 *   - listRecentAuditLog(limit): read-only, newest-first.
 *
 * Inputs: plain SchedulerState-shaped objects (see the exact field list
 *   in JSDoc on createDefaultSchedulerState below); an optional
 *   injectable indexedDBFactory for tests (mirrors
 *   researchGovernanceDb.js's own convention).
 * Outputs: Promises resolving to state objects / arrays / booleans; this
 *   module never throws out of its public API — every failure mode is
 *   caught and turned into a safe, reported default (see
 *   "graceful recovery" above).
 * Dependencies: research/src/storage/adapters/appendOnlyAdapter.js
 *   (generic infra reuse only).
 *
 * Public API: SCHEDULER_STATE_SCHEMA_VERSION, SCHEDULER_MODES,
 *   SCHEDULER_STATUSES, createDefaultSchedulerState,
 *   validateSchedulerState, saveSchedulerState, restoreSchedulerState,
 *   appendAuditLogEntry, listRecentAuditLog,
 *   _resetConnectionCacheForTesting.
 * Internal API: openSchedulerStateDb, migrateSchedulerState.
 *
 * Error handling: every exported function catches its own IndexedDB
 *   failures internally; nothing here ever throws into bootstrap.js's
 *   boot sequence, matching the same "must never break the legacy app"
 *   discipline already established for the rest of research/integration/.
 * Performance notes: snapshot read/write is O(1) (single-key
 *   get/put); audit log append is O(1) amortized (indexed seq assignment,
 *   same pattern as knowledgeGraph.js's edge seq numbering); listing
 *   recent audit entries is bounded by `limit`, never a full scan.
 * Threading model: main thread.
 * Storage usage: exactly two stores in one dedicated database, never
 *   touching mfx_research_governance or any mfx_msd_* store.
 * Complexity analysis: O(1) per operation, O(limit) for log listing.
 * Future extension notes: a schema migration for a hypothetical version 2
 *   payload shape goes in migrateSchedulerState() as an additional
 *   branch, never as an in-place mutation of the version-1 branch —
 *   same additive-only discipline as researchGovernanceDb.js's
 *   onupgradeneeded ladder.
 */

import { createAppendOnlyAdapter } from '../src/storage/adapters/appendOnlyAdapter.js';

export const SCHEDULER_STATE_SCHEMA_VERSION = 1;

export const SCHEDULER_MODES = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
  PAUSED: 'paused',
});

export const SCHEDULER_STATUSES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  ERROR: 'error',
});

const DB_NAME = 'mfx_research_scheduler_state';
const DB_VERSION = 1;
const SNAPSHOT_STORE = 'SchedulerStateSnapshot';
const AUDIT_STORE = 'SchedulerAuditLog';
const SNAPSHOT_KEY = 'current';

class SchedulerStateDbBlockedTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`schedulerState: opening "${DB_NAME}" has been blocked by another connection for over ${timeoutMs}ms.`);
    this.name = 'SchedulerStateDbBlockedTimeoutError';
  }
}

function createStoreIfMissing(db) {
  if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
    db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(AUDIT_STORE)) {
    const store = db.createObjectStore(AUDIT_STORE, { keyPath: 'id' });
    store.createIndex('by_seq', 'seq', { unique: true });
  }
}

const dbCache = { promise: null };

/**
 * Memoized opener for the dedicated scheduler-state database.
 * Deliberately NOT shared code with researchGovernanceDb.js's opener —
 * see module header for why this independence is intentional.
 */
export function openSchedulerStateDb(opts = {}) {
  if (dbCache.promise) return dbCache.promise;

  const idb = opts.indexedDBFactory || (typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined);
  if (!idb) {
    return Promise.reject(new Error('schedulerState: no IndexedDB implementation available'));
  }

  dbCache.promise = new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(opts.blockedTimeoutMs) ? opts.blockedTimeoutMs : 10000;
    let settled = false;
    let timeoutHandle = null;

    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      createStoreIfMissing(event.target.result);
    };
    req.onsuccess = () => {
      if (settled) { try { req.result.close(); } catch { /* ignore */ } return; }
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      const db = req.result;
      db.onversionchange = () => { db.close(); dbCache.promise = null; };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      reject(req.error);
    };
    req.onblocked = () => {
      if (timeoutMs > 0 && timeoutHandle === null) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new SchedulerStateDbBlockedTimeoutError(timeoutMs));
        }, timeoutMs);
      }
    };
  });

  dbCache.promise.catch(() => { dbCache.promise = null; });
  return dbCache.promise;
}

function getAuditAdapter(opts) {
  return createAppendOnlyAdapter({ getDb: () => openSchedulerStateDb(opts), storeName: AUDIT_STORE });
}

/**
 * @returns {{
 *   version: number, mode: 'manual'|'automatic'|'paused',
 *   schedulerStatus: 'idle'|'running'|'error',
 *   schedulingPolicy: object|null, queue: number,
 *   currentlyRunningCampaign: string|null,
 *   campaignsExecutedThisSession: number, campaignsExecutedLifetime: number,
 *   lastExecutionTime: number|null, nextScheduledExecution: number|null,
 *   lastSuccessfulExecution: number|null, lastFailure: object|null,
 *   pausedReason: string|null, lastResumeTime: number|null,
 *   featureFlagState: boolean, timestamp: number,
 * }}
 */
export function createDefaultSchedulerState({ pausedReason = null } = {}) {
  return {
    version: SCHEDULER_STATE_SCHEMA_VERSION,
    mode: SCHEDULER_MODES.MANUAL,
    schedulerStatus: SCHEDULER_STATUSES.IDLE,
    schedulingPolicy: { type: 'event-driven', minBatchesSinceLastRun: 1 },
    queue: 0,
    currentlyRunningCampaign: null,
    campaignsExecutedThisSession: 0,
    campaignsExecutedLifetime: 0,
    lastExecutionTime: null,
    nextScheduledExecution: null,
    lastSuccessfulExecution: null,
    lastFailure: null,
    pausedReason,
    lastResumeTime: null,
    featureFlagState: false,
    timestamp: Date.now(),
  };
}

const VALID_MODES = Object.values(SCHEDULER_MODES);
const VALID_STATUSES = Object.values(SCHEDULER_STATUSES);

/** Structural + enum validation. Never throws. */
export function validateSchedulerState(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['state is not an object'] };
  }
  if (typeof candidate.version !== 'number') errors.push('version must be a number');
  if (!VALID_MODES.includes(candidate.mode)) errors.push(`mode must be one of ${VALID_MODES.join(', ')}`);
  if (!VALID_STATUSES.includes(candidate.schedulerStatus)) errors.push(`schedulerStatus must be one of ${VALID_STATUSES.join(', ')}`);
  if (typeof candidate.queue !== 'number' || candidate.queue < 0) errors.push('queue must be a non-negative number');
  if (typeof candidate.campaignsExecutedThisSession !== 'number') errors.push('campaignsExecutedThisSession must be a number');
  if (typeof candidate.campaignsExecutedLifetime !== 'number') errors.push('campaignsExecutedLifetime must be a number');
  if (typeof candidate.timestamp !== 'number') errors.push('timestamp must be a number');
  return { valid: errors.length === 0, errors };
}

/**
 * Migrates a raw persisted payload to the current SCHEDULER_STATE_SCHEMA_VERSION.
 * Only version 1 exists today; this function exists so a future version 2
 * has one obvious, additive place to add a branch (mirrors
 * researchGovernanceDb.js's own additive-only upgrade ladder, applied at
 * the payload level instead of the IndexedDB schema level).
 */
function migrateSchedulerState(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.version === SCHEDULER_STATE_SCHEMA_VERSION) return raw;
  // No prior versions exist yet -- nothing to migrate from. A future
  // version bump adds `if (raw.version === 1) { return { ...raw, version: 2, <new field default> }; }` here.
  return raw;
}

/** Atomic overwrite of the live snapshot (single put() to a fixed key). */
export async function saveSchedulerState(state, opts = {}) {
  const db = await openSchedulerStateDb(opts);
  const record = { id: SNAPSHOT_KEY, ...state, timestamp: Date.now() };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
    const req = tx.objectStore(SNAPSHOT_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return record;
}

/**
 * The one function callers use at boot. ALWAYS resolves. Never replays
 * a stale in-flight run -- schedulerStatus/queue/currentlyRunningCampaign
 * are unconditionally reset to their safe idle values regardless of what
 * was persisted (see module header).
 */
export async function restoreSchedulerState(opts = {}) {
  let raw;
  try {
    const db = await openSchedulerStateDb(opts);
    raw = await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
      const req = tx.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return {
      state: createDefaultSchedulerState({ pausedReason: `Scheduler persistence unavailable (${err.message}); starting Paused for safety.` }),
      restored: false,
      persistenceAvailable: false,
      recoveryReason: err.message,
    };
  }

  if (!raw) {
    // First-ever boot -- not an error, just nothing to restore yet.
    return {
      state: createDefaultSchedulerState(),
      restored: false,
      persistenceAvailable: true,
      recoveryReason: null,
    };
  }

  const migrated = migrateSchedulerState(raw);
  const { valid, errors } = validateSchedulerState(migrated);
  if (!valid) {
    return {
      state: createDefaultSchedulerState({ pausedReason: `Persisted scheduler state failed validation (${errors.join('; ')}); starting Paused for safety.` }),
      restored: false,
      persistenceAvailable: true,
      recoveryReason: errors.join('; '),
    };
  }

  // Restore historical facts (counters, timestamps, mode, policy) but
  // NEVER replay in-flight work -- "restore only future work."
  const state = {
    ...migrated,
    schedulerStatus: SCHEDULER_STATUSES.IDLE,
    queue: 0,
    currentlyRunningCampaign: null,
    campaignsExecutedThisSession: 0, // a new session has begun
    nextScheduledExecution: null,    // recomputed fresh by schedulerPolicies once resumed, never trusted stale
  };

  return { state, restored: true, persistenceAvailable: true, recoveryReason: null };
}

/** Explicit, meaningful audit trail entries (mode changes, run outcomes, recovery events) -- not one per snapshot save. */
export async function appendAuditLogEntry({ event, detail } = {}, opts = {}) {
  if (!event || typeof event !== 'string') {
    throw new TypeError('appendAuditLogEntry: "event" is required');
  }
  const adapter = getAuditAdapter(opts);
  const existing = await adapter.getAll();
  const seq = existing.length ? Math.max(...existing.map((r) => r.seq)) + 1 : 0;
  const record = { id: `sched_audit_${seq}`, seq, ts: Date.now(), event, detail: detail || {} };
  await adapter.add(record);
  return record;
}

/** Read-only, newest-first, bounded by `limit`. */
export async function listRecentAuditLog(limit = 50, opts = {}) {
  const adapter = getAuditAdapter(opts);
  const all = await adapter.getAll();
  return all.sort((a, b) => b.seq - a.seq).slice(0, limit);
}

/**
 * Read-only accessor for healthMonitor.js's periodic polling. Unlike
 * restoreSchedulerState() (boot-time only, which deliberately resets
 * session counters/queue/running-campaign), this returns the snapshot
 * exactly as persisted -- healthMonitor needs to observe the LIVE
 * in-memory scheduler's own reported state, not a boot-time
 * reinterpretation of it. Never throws; returns { snapshot: null,
 * available: false, error } on any failure so a health check can report
 * "persistence unavailable" rather than crash the monitor.
 */
export async function getCurrentSnapshotForMonitoring(opts = {}) {
  try {
    const db = await openSchedulerStateDb(opts);
    const snapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
      const req = tx.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return { snapshot, available: true, error: null };
  } catch (err) {
    return { snapshot: null, available: false, error: err.message };
  }
}

/** Test-only: forces a fresh DB connection on next call. */
export function _resetConnectionCacheForTesting() {
  dbCache.promise = null;
}
