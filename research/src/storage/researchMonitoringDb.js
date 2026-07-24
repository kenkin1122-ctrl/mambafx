/**
 * research/src/storage/researchMonitoringDb.js
 *
 * Purpose:
 *   Open the two genuinely NEW IndexedDB databases defined in v10.1 Section
 *   5.1 — `mfx_research_monitoring` (RandomnessAudits, DriftEvents) and
 *   `mfx_research_meta` (MetaSnapshots). Neither database ever participates
 *   in a read-then-write transaction against a legacy store or against
 *   mfx_msd_experiments, so the version-coordination hazard fixed in
 *   existingDbExtensions.js (Required Fix 1) does not apply here — these
 *   are brand-new database names with no pre-existing consumer to collide
 *   with, so a normal versioned upgrade is unconditionally safe.
 *
 *   IMPLEMENTATION NOTE ON FILE CONSOLIDATION: unchanged from the original
 *   Phase 1 delivery — both database openers live in this one file rather
 *   than a separate `researchMetaDb.js`, since the approved Phase 1 file
 *   list named only `researchMonitoringDb`. No storage placement decision
 *   is affected; MetaSnapshots still lives in its own separate database.
 *
 *   PHASE 1 CORRECTIONS (post-independent-audit):
 *   - Required Fix 5 (connection lifecycle): both openers are now memoized
 *     singletons — each database is opened at most once per module
 *     lifetime; an `onversionchange` handler closes the connection
 *     gracefully if a future higher-version upgrade elsewhere needs it to
 *     step aside, instead of silently blocking that upgrade forever.
 *   - Required Fix 2 (raw handle bypass): getRandomnessAuditsAdapter(),
 *     getDriftEventsAdapter(), and getMetaSnapshotsAdapter() are now the
 *     SANCTIONED, stage-facing public interface — each returns an
 *     already-adapter-wrapped store (appendOnlyAdapter, matching these
 *     stores' genuinely append-only nature — none of them have a
 *     one-time-consumption or idempotent-recompute requirement the way
 *     PowerAnalyses/Decisions/Lockbox do), never the raw IDBDatabase. The
 *     raw openers remain exported for infrastructure/test use, with the
 *     same documented, accepted bypass limitation as
 *     existingDbExtensions.js (see that module's header for the full
 *     reasoning on why a Proxy-based lockdown was considered and
 *     rejected).
 *
 * Responsibilities: (see original Phase 1 description — unchanged)
 *   - openResearchMonitoringDb() / openResearchMetaDb(): memoized versioned
 *     openers.
 *   - getRandomnessAuditsAdapter() / getDriftEventsAdapter() /
 *     getMetaSnapshotsAdapter(): sanctioned adapter-returning accessors.
 *   - closeResearchMonitoringDb() / closeResearchMetaDb(): lifecycle
 *     teardown, mirroring existingDbExtensions.js's
 *     closeExistingDbConnection().
 *
 * Inputs: optional injectable `indexedDBFactory` (defaults to
 *   globalThis.indexedDB).
 * Outputs: Promise<IDBDatabase> (raw, infra-only) from the openers;
 *   Promise<adapter> from the getXAdapter() functions.
 * Dependencies: core/constants.js, statistics/indexingStrategy.js,
 *   storage/adapters/appendOnlyAdapter.js.
 *
 * Public API: buildMonitoringUpgradeHandler, buildMetaUpgradeHandler,
 *   openResearchMonitoringDb, openResearchMetaDb, getRandomnessAuditsAdapter,
 *   getDriftEventsAdapter, getMetaSnapshotsAdapter,
 *   closeResearchMonitoringDb, closeResearchMetaDb.
 * Internal API: none beyond the exported upgrade-handler builders (kept
 *   exported for direct unit testing, per Phase 1 original convention).
 *
 * Error handling: unchanged from Phase 1 original — reject on error, log
 *   (not reject) on blocked.
 * Performance notes: O(1) upgrade cost; memoization means repeated calls
 *   after the first are cheap cached-promise resolutions.
 * Threading model: main-thread only for the initial open/upgrade; Stage 0
 *   and Stage 7's Workers open their OWN connections independently.
 * Storage usage: unchanged from Phase 1 original.
 * Complexity analysis: unchanged from Phase 1 original.
 * Future extension notes: unchanged from Phase 1 original.
 */

import { DB } from '../core/constants.js';
import { applyIndexSpec } from '../statistics/indexingStrategy.js';
import { createAppendOnlyAdapter } from './adapters/appendOnlyAdapter.js';

export function buildMonitoringUpgradeHandler() {
  return function onupgradeneeded(event) {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    const { stores } = DB.RESEARCH_MONITORING;

    if (oldVersion < 1) {
      if (!db.objectStoreNames.contains(stores.RANDOMNESS_AUDITS)) {
        const store = db.createObjectStore(stores.RANDOMNESS_AUDITS, { keyPath: 'id' });
        applyIndexSpec(store, 'RandomnessAudits');
      }
      if (!db.objectStoreNames.contains(stores.DRIFT_EVENTS)) {
        const store = db.createObjectStore(stores.DRIFT_EVENTS, { keyPath: 'id' });
        applyIndexSpec(store, 'DriftEvents');
      }
    }
  };
}

export function buildMetaUpgradeHandler() {
  return function onupgradeneeded(event) {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    const { stores } = DB.RESEARCH_META;

    if (oldVersion < 1) {
      if (!db.objectStoreNames.contains(stores.META_SNAPSHOTS)) {
        const store = db.createObjectStore(stores.META_SNAPSHOTS, { keyPath: 'id' });
        applyIndexSpec(store, 'MetaSnapshots');
      }
    }
  };
}

/**
 * V-4 REMEDIATION (parity fix with existingDbExtensions.js's openRaw()).
 * Named, distinguishable error for a versionchange request that stays
 * blocked (onblocked) longer than `blockedTimeoutMs` without resolving --
 * see existingDbExtensions.js's ConnectionBlockedTimeoutError for the full
 * rationale. Defined locally (rather than imported) to avoid introducing a
 * new cross-module dependency edge between the two sibling storage
 * modules purely for a shared error class.
 */
export class MonitoringDbConnectionBlockedTimeoutError extends Error {
  constructor(dbName, timeoutMs) {
    super(
      `openMemoized: opening "${dbName}" has been blocked (onblocked) by another open connection for over ` +
      `${timeoutMs}ms without resolving. Close other tabs/connections to this database and retry.`
    );
    this.name = 'MonitoringDbConnectionBlockedTimeoutError';
    this.dbName = dbName;
    this.timeoutMs = timeoutMs;
  }
}

function openMemoized(dbConfig, upgradeHandler, cacheRef, opts = {}) {
  if (cacheRef.promise) return cacheRef.promise;

  const idb = opts.indexedDBFactory || globalThis.indexedDB;
  if (!idb) {
    throw new Error(`openMemoized(${dbConfig.name}): no IndexedDB implementation available (globalThis.indexedDB is undefined)`);
  }

  cacheRef.promise = new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(opts.blockedTimeoutMs) ? opts.blockedTimeoutMs : 10000;
    let settled = false;
    let timeoutHandle = null;
    const clearBlockedTimeout = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const req = idb.open(dbConfig.name, dbConfig.version);
    req.onupgradeneeded = upgradeHandler;
    req.onsuccess = () => {
      if (settled) {
        try { req.result.close(); } catch { /* already closed/unusable — ignore */ }
        return;
      }
      settled = true;
      clearBlockedTimeout();
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        cacheRef.promise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearBlockedTimeout();
      reject(req.error);
    };
    req.onblocked = () => {
      if (typeof opts.onBlocked === 'function') opts.onBlocked();
      if (timeoutMs > 0 && timeoutHandle === null) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new MonitoringDbConnectionBlockedTimeoutError(dbConfig.name, timeoutMs));
        }, timeoutMs);
      }
    };
  });

  cacheRef.promise.catch(() => { cacheRef.promise = null; });
  return cacheRef.promise;
}

const monitoringCache = { promise: null };
const metaCache = { promise: null };

export function openResearchMonitoringDb(opts = {}) {
  return openMemoized(DB.RESEARCH_MONITORING, buildMonitoringUpgradeHandler(), monitoringCache, opts);
}

export function openResearchMetaDb(opts = {}) {
  return openMemoized(DB.RESEARCH_META, buildMetaUpgradeHandler(), metaCache, opts);
}

export async function closeResearchMonitoringDb() {
  if (!monitoringCache.promise) return;
  try { (await monitoringCache.promise).close(); } catch { /* never opened */ }
  monitoringCache.promise = null;
}

export async function closeResearchMetaDb() {
  if (!metaCache.promise) return;
  try { (await metaCache.promise).close(); } catch { /* never opened */ }
  metaCache.promise = null;
}

// ── Sanctioned, stage-facing adapters (Required Fix 2) ──────────────────────

// V-3 REMEDIATION: parity fix with existingDbExtensions.js's getXAdapter()
// factories -- each still eagerly opens once up front (preserving prior
// eager-failure behavior), but the adapter is constructed with a `getDb`
// thunk so a later close/reopen of the underlying connection is picked up
// transparently by the next operation instead of leaving the adapter
// permanently bound to a dead handle.
export async function getRandomnessAuditsAdapter(opts = {}) {
  await openResearchMonitoringDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchMonitoringDb(opts), storeName: DB.RESEARCH_MONITORING.stores.RANDOMNESS_AUDITS });
}

export async function getDriftEventsAdapter(opts = {}) {
  await openResearchMonitoringDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchMonitoringDb(opts), storeName: DB.RESEARCH_MONITORING.stores.DRIFT_EVENTS });
}

export async function getMetaSnapshotsAdapter(opts = {}) {
  await openResearchMetaDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchMetaDb(opts), storeName: DB.RESEARCH_META.stores.META_SNAPSHOTS });
}

/** Test-only: reset both memoized connection caches between test cases. */
export function _resetConnectionCachesForTesting() {
  monitoringCache.promise = null;
  metaCache.promise = null;
}
