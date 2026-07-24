/**
 * research/src/storage/researchGovernanceDb.js
 *
 * Purpose:
 *   Open the Phase 2 governance database (`mfx_research_governance`),
 *   implementing the storage substrate for Volume IV v3.0 Parts 2, 3, and 7:
 *   the Hypothesis Registry, the Lifecycle Stage transition log, the Data
 *   Access Ledger, and the Compliance Audit log. This database never
 *   participates in a read-then-write transaction against a legacy store or
 *   against mfx_msd_experiments, so it follows the same "brand-new name,
 *   unconditionally safe versioned upgrade" reasoning already established
 *   for mfx_research_monitoring / mfx_research_meta (see
 *   researchMonitoringDb.js) — this module is a deliberate structural copy
 *   of that one, not a new pattern.
 *
 * Responsibilities:
 *   - openResearchGovernanceDb(): memoized versioned opener, four stores
 *     created in one onupgradeneeded pass.
 *   - getHypothesisRegistryAdapter(): append-only adapter (Registration is
 *     add()-only per Part 3 — "No hypothesis may be overwritten"; later
 *     Lifecycle transitions are tracked in a SEPARATE store, never as an
 *     in-place update to the Registry row itself).
 *   - getLifecycleTransitionsAdapter(): append-only adapter — every stage
 *     transition (Part 2) is a new row, never a mutation.
 *   - getDataAccessLedgerAdapter(): append-only adapter (Part 7 — "every
 *     access... is permanently logged").
 *   - getComplianceAuditLogAdapter(): append-only adapter (Part 2's
 *     Automatic Constitutional Compliance Audit — every check outcome,
 *     pass or fail, is permanently logged; see Global Compliance Audit
 *     Failure Counter, Part 5).
 *   - getFamilyWealthLedgerAdapter(): append-only adapter (Part 9's Online
 *     FDR wealth process — see onlineFdr.js).
 *   - getCalibrationCanaryRunsAdapter(): append-only adapter (Part 14/16's
 *     Empirical FDR Calibration Canary — see empiricalFdrCanary.js).
 *   - getPublicationStatusTransitionsAdapter(): append-only adapter
 *     (Part 12's Publication Status state machine — see
 *     publicationStatus.js).
 *   - getReproducibilityManifestsAdapter(): write-once adapter (Part 3's
 *     Reproducibility Manifest — see reproducibilityManifest.js).
 *   - closeResearchGovernanceDb(): lifecycle teardown.
 *
 * Inputs: optional injectable `indexedDBFactory` (defaults to
 *   globalThis.indexedDB), matching the researchMonitoringDb.js convention.
 * Outputs: Promise<IDBDatabase> (raw, infra-only) from the opener;
 *   Promise<adapter> from the getXAdapter() functions.
 * Dependencies: core/constants.js, statistics/indexingStrategy.js,
 *   storage/adapters/appendOnlyAdapter.js.
 *
 * Public API: buildGovernanceUpgradeHandler, openResearchGovernanceDb,
 *   getHypothesisRegistryAdapter, getLifecycleTransitionsAdapter,
 *   getDataAccessLedgerAdapter, getComplianceAuditLogAdapter,
 *   getScientificQuestionsAdapter, closeResearchGovernanceDb,
 *   _resetConnectionCacheForTesting, GovernanceDbConnectionBlockedTimeoutError.
 * Internal API: none beyond the exported upgrade-handler builder (kept
 *   exported for direct unit testing, matching sibling modules).
 *
 * Error handling: reject on error; log (not reject) on blocked, with the
 *   same bounded onblocked timeout pattern as researchMonitoringDb.js.
 * Performance notes: O(1) upgrade cost (four stores, small fixed index
 *   counts); memoization makes repeated opens cheap cached-promise
 *   resolutions.
 * Threading model: main-thread only.
 * Storage usage: four append-only stores; no store here ever needs
 *   put()/delete() semantics, since every governance record this Volume
 *   defines (Registration, a Lifecycle transition, a data-access entry, a
 *   compliance-audit outcome) is, by Constitutional design, an immutable
 *   historical fact once written (Part 1, Principle 8).
 * Complexity analysis: same as researchMonitoringDb.js.
 * Future extension notes: a future store (e.g., a Scientific Oversight
 *   Action Log, Part 8) is added the same way — a new key in
 *   DB.RESEARCH_GOVERNANCE.stores, a new INDEX_SPECS entry, a new branch in
 *   the upgrade handler, and a new getXAdapter() export.
 */

import { DB } from '../core/constants.js';
import { applyIndexSpec, INDEX_SPECS } from '../statistics/indexingStrategy.js';
import { createAppendOnlyAdapter } from './adapters/appendOnlyAdapter.js';
import { createWriteOnceAdapter } from './adapters/writeOnceAdapter.js';

// Defined locally (not imported from researchMonitoringDb.js) to avoid a new
// cross-module dependency edge between sibling storage modules purely for a
// shared error class — same reasoning documented in researchMonitoringDb.js.
export class GovernanceDbConnectionBlockedTimeoutError extends Error {
  constructor(dbName, timeoutMs) {
    super(
      `openMemoized: opening "${dbName}" has been blocked (onblocked) by another open connection for over ` +
      `${timeoutMs}ms without resolving. Close other tabs/connections to this database and retry.`
    );
    this.name = 'GovernanceDbConnectionBlockedTimeoutError';
    this.dbName = dbName;
    this.timeoutMs = timeoutMs;
  }
}

function createStoreIfMissing(db, storeName) {
  if (!db.objectStoreNames.contains(storeName)) {
    const keyPath = INDEX_SPECS[storeName]?.keyPath || 'id';
    const store = db.createObjectStore(storeName, { keyPath });
    applyIndexSpec(store, storeName);
  }
}

export function buildGovernanceUpgradeHandler() {
  return function onupgradeneeded(event) {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    const { stores } = DB.RESEARCH_GOVERNANCE;

    // v1: original four Phase 2 stores. Guarded by contains-check (not just
    // oldVersion < 1) so a fresh v2 install still creates all five stores
    // in one pass, matching the idempotent-creation discipline used
    // throughout this database's upgrade path.
    if (oldVersion < 1) {
      createStoreIfMissing(db, stores.HYPOTHESIS_REGISTRY);
      createStoreIfMissing(db, stores.LIFECYCLE_TRANSITIONS);
      createStoreIfMissing(db, stores.DATA_ACCESS_LEDGER);
      createStoreIfMissing(db, stores.COMPLIANCE_AUDIT_LOG);
    }
    // v2 (Phase 3, Part 6): additive — ScientificQuestions only. An
    // existing v1 database upgrades straight to having this new store
    // without touching any of the four original ones.
    if (oldVersion < 2) {
      createStoreIfMissing(db, stores.SCIENTIFIC_QUESTIONS);
    }
    // v3 (Phase 4, Part 9): additive — FamilyWealthLedger only.
    if (oldVersion < 3) {
      createStoreIfMissing(db, stores.FAMILY_WEALTH_LEDGER);
    }
    // v4 (Phase 4, Part 14/16): additive — CalibrationCanaryRuns only.
    if (oldVersion < 4) {
      createStoreIfMissing(db, stores.CALIBRATION_CANARY_RUNS);
    }
    // v5 (Phase 4, Part 12): additive — PublicationStatusTransitions only.
    if (oldVersion < 5) {
      createStoreIfMissing(db, stores.PUBLICATION_STATUS_TRANSITIONS);
    }
    // v6 (Phase 4, Part 3): additive — ReproducibilityManifests only.
    if (oldVersion < 6) {
      createStoreIfMissing(db, stores.REPRODUCIBILITY_MANIFESTS);
    }
    // v7 (Phase 4, Layer 9): additive — KnowledgeGraphNodes and
    // KnowledgeGraphEdges only (the Scientific Knowledge Graph).
    if (oldVersion < 7) {
      createStoreIfMissing(db, stores.KNOWLEDGE_GRAPH_NODES);
      createStoreIfMissing(db, stores.KNOWLEDGE_GRAPH_EDGES);
    }
    // v8 (Final Core Research Pipeline Implementation, Priority 3):
    // additive — RandomnessAuditResults only.
    if (oldVersion < 8) {
      createStoreIfMissing(db, stores.RANDOMNESS_AUDIT_RESULTS);
    }
  };
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
          reject(new GovernanceDbConnectionBlockedTimeoutError(dbConfig.name, timeoutMs));
        }, timeoutMs);
      }
    };
  });

  cacheRef.promise.catch(() => { cacheRef.promise = null; });
  return cacheRef.promise;
}

const governanceCache = { promise: null };

export function openResearchGovernanceDb(opts = {}) {
  return openMemoized(DB.RESEARCH_GOVERNANCE, buildGovernanceUpgradeHandler(), governanceCache, opts);
}

export async function closeResearchGovernanceDb() {
  if (!governanceCache.promise) return;
  try { (await governanceCache.promise).close(); } catch { /* never opened */ }
  governanceCache.promise = null;
}

export async function getHypothesisRegistryAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.HYPOTHESIS_REGISTRY });
}

export async function getLifecycleTransitionsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.LIFECYCLE_TRANSITIONS });
}

export async function getDataAccessLedgerAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.DATA_ACCESS_LEDGER });
}

export async function getComplianceAuditLogAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.COMPLIANCE_AUDIT_LOG });
}

export async function getScientificQuestionsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.SCIENTIFIC_QUESTIONS });
}

export async function getFamilyWealthLedgerAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.FAMILY_WEALTH_LEDGER });
}

export async function getCalibrationCanaryRunsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.CALIBRATION_CANARY_RUNS });
}

export async function getPublicationStatusTransitionsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.PUBLICATION_STATUS_TRANSITIONS });
}

export async function getReproducibilityManifestsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createWriteOnceAdapter({
    getDb: () => openResearchGovernanceDb(opts),
    storeName: DB.RESEARCH_GOVERNANCE.stores.REPRODUCIBILITY_MANIFESTS,
    uniqueIndexName: 'by_experimentId',
    uniqueKeyFn: (r) => r.experimentId,
  });
}

export async function getKnowledgeGraphNodesAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createWriteOnceAdapter({
    getDb: () => openResearchGovernanceDb(opts),
    storeName: DB.RESEARCH_GOVERNANCE.stores.KNOWLEDGE_GRAPH_NODES,
    uniqueIndexName: 'by_nodeType_refId',
    uniqueKeyFn: (r) => [r.nodeType, r.refId],
  });
}

export async function getKnowledgeGraphEdgesAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.KNOWLEDGE_GRAPH_EDGES });
}

export async function getRandomnessAuditResultsAdapter(opts = {}) {
  await openResearchGovernanceDb(opts);
  return createAppendOnlyAdapter({ getDb: () => openResearchGovernanceDb(opts), storeName: DB.RESEARCH_GOVERNANCE.stores.RANDOMNESS_AUDIT_RESULTS });
}

/** Test-only: reset the memoized connection cache between test cases. */
export function _resetConnectionCacheForTesting() {
  governanceCache.promise = null;
}
