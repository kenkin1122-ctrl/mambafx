/**
 * research/src/statistics/indexingStrategy.js
 *
 * Purpose:
 *   Single declarative source of truth for every compound index required by
 *   Volume III v10.1 Section 5.3, plus the shared query helpers that use
 *   them. Exists specifically to prevent the "unbounded historical scan"
 *   defect the freeze review identified (Required Change 6) — no store's
 *   "current/latest" query should ever be implemented as a full scan
 *   in an individual stage module; it should call queryLatestByIndex() here.
 *
 * Responsibilities:
 *   - Declare INDEX_SPECS: for every new store, its keyPath and every index
 *     it needs (name, keyPath, unique flag).
 *   - Provide applyIndexSpec(objectStore, storeName): idempotently creates
 *     every declared index on a store during onupgradeneeded (safe to call
 *     even if some indexes already exist).
 *   - Provide queryLatestByIndex(): opens a cursor on a compound index in
 *     reverse (`prev`) direction bounded to a key range, returning the single
 *     newest matching row without scanning the rest of the store.
 *   - Provide listByIndexRange(): bounded range query for "history over a
 *     window" reads (list*() stage APIs).
 *
 * Inputs: an open IDBObjectStore (upgrade time) or IDBDatabase/transaction
 *   (query time), a store name, and (for queries) an entity key / range.
 * Outputs: created indexes (upgrade time); Promise<row|undefined> or
 *   Promise<row[]> (query time).
 * Dependencies: none beyond the native IndexedDB API.
 *
 * Public API: INDEX_SPECS, applyIndexSpec, queryLatestByIndex, listByIndexRange.
 * Internal API: none.
 *
 * Error handling: query helpers reject the returned Promise on any
 *   IDBRequest error (propagated as-is; callers see the native DOMException).
 * Performance notes: this is precisely the mechanism that keeps "get the
 *   current/latest row for entity X" at O(log n + k) (index seek + small
 *   cursor walk) instead of O(n) (full store scan) as the append-only stores
 *   grow into the millions of rows the v10.1 review's scalability section
 *   assumed.
 * Threading model: safe to call from either the main thread or a Worker —
 *   IndexedDB is available in both contexts.
 * Storage usage: defines index metadata only; owns no rows itself.
 * Complexity analysis: applyIndexSpec is O(number of declared indexes),
 *   run once per schema version at db-open time. queryLatestByIndex is
 *   O(log n) to seek the index plus O(1) for a single-row cursor read.
 *   listByIndexRange is O(log n + k) for k matching rows.
 * Future extension notes: adding a new store's compound index is a new key
 *   in INDEX_SPECS — no change to the helper functions themselves.
 */

// ── Declarative index specifications (Section 5.3, v10.1) ─────────────────
export const INDEX_SPECS = Object.freeze({
  PowerAnalyses: {
    keyPath: 'id',
    indexes: [
      { name: 'by_discoveryResult_engineVersion', keyPath: ['discoveryResultId', 'engineVersion'], unique: true },
      { name: 'by_discoveryResult_createdAt', keyPath: ['discoveryResultId', 'createdAt'], unique: false },
    ],
  },
  Decisions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_discoveryResult_inputHash', keyPath: ['discoveryResultId', 'decisionInputHash'], unique: true },
      { name: 'by_discoveryResult_createdAt', keyPath: ['discoveryResultId', 'createdAt'], unique: false },
    ],
  },
  Lockbox: {
    keyPath: 'id',
    indexes: [
      { name: 'by_featureKey_generation', keyPath: ['featureKey', 'generation'], unique: true },
    ],
  },
  RandomnessAudits: {
    keyPath: 'id',
    indexes: [
      { name: 'by_stream_createdAt', keyPath: ['streamId', 'createdAt'], unique: false },
    ],
  },
  DriftEvents: {
    keyPath: 'id',
    indexes: [
      { name: 'by_feature_timestamp', keyPath: ['featureOrStream', 'timestamp'], unique: false },
    ],
  },
  MetaSnapshots: {
    keyPath: 'id',
    indexes: [
      { name: 'by_computedAt', keyPath: 'computedAt', unique: false },
    ],
  },

  // ── Volume IV v3.0 governance stores ──────────────────────────────────
  HypothesisRegistry: {
    keyPath: 'hypothesisId',
    indexes: [
      { name: 'by_lineage_generation', keyPath: ['lineageId', 'generationId'], unique: true },
      { name: 'by_family_createdAt', keyPath: ['familyKey', 'birthTimestamp'], unique: false },
    ],
  },
  LifecycleTransitions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_hypothesis_seq', keyPath: ['hypothesisId', 'seq'], unique: true },
      { name: 'by_hypothesis_createdAt', keyPath: ['hypothesisId', 'createdAt'], unique: false },
    ],
  },
  DataAccessLedger: {
    keyPath: 'id',
    indexes: [
      { name: 'by_family_accessedAt', keyPath: ['familyKey', 'accessedAt'], unique: false },
    ],
  },
  ComplianceAuditLog: {
    keyPath: 'id',
    indexes: [
      { name: 'by_hypothesis_createdAt', keyPath: ['hypothesisId', 'createdAt'], unique: false },
    ],
  },
  // Part 6 (Phase 3): one row per registered Scientific Question. A
  // Question groups one or more Family Keys under a single pre-registered
  // research aim; familyKeys is a denormalized array so a Question's full
  // Family membership is readable without a secondary index join.
  ScientificQuestions: {
    keyPath: 'questionId',
    indexes: [
      { name: 'by_market_createdAt', keyPath: ['market', 'createdAt'], unique: false },
      { name: 'by_status_createdAt', keyPath: ['status', 'createdAt'], unique: false },
    ],
  },
  // Part 9 (Phase 4): one append-only row per test decision made against a
  // Family's Online FDR wealth process. by_family_seq gives queryLatestByIndex
  // an O(log n) way to find the current wealth (the most recent row for a
  // Family) without scanning the whole ledger.
  FamilyWealthLedger: {
    keyPath: 'id',
    indexes: [
      { name: 'by_family_seq', keyPath: ['familyKey', 'seq'], unique: true },
      { name: 'by_family_testedAt', keyPath: ['familyKey', 'testedAt'], unique: false },
    ],
  },
  // Part 14/16 (Phase 4): one append-only row per Empirical FDR
  // Calibration Canary computation for a Family. by_family_seq mirrors
  // FamilyWealthLedger's own pattern -- an O(log n) way to find the most
  // recent run, and a stable ordering for the "most recent N runs" scan
  // checkPersistentMaterialDivergence performs.
  CalibrationCanaryRuns: {
    keyPath: 'id',
    indexes: [
      { name: 'by_family_seq', keyPath: ['familyKey', 'seq'], unique: true },
      { name: 'by_family_computedAt', keyPath: ['familyKey', 'computedAt'], unique: false },
    ],
  },
  // Part 12 (Phase 4): one append-only row per Publication Status
  // transition for a hypothesis -- structurally identical to
  // LifecycleTransitions' own index shape, tracking the separate
  // Publication Status axis instead of Lifecycle Stage.
  PublicationStatusTransitions: {
    keyPath: 'id',
    indexes: [
      { name: 'by_hypothesis_seq', keyPath: ['hypothesisId', 'seq'], unique: true },
      { name: 'by_hypothesis_createdAt', keyPath: ['hypothesisId', 'createdAt'], unique: false },
    ],
  },
  // Part 3 (Phase 4): one write-once row per experiment's Reproducibility
  // Manifest, keyed by a unique experimentId -- mirrors the Lockbox/
  // PowerAnalyses write-once index pattern (unique natural-key index,
  // never a mutation after the manifest is recorded complete).
  ReproducibilityManifests: {
    keyPath: 'id',
    indexes: [
      { name: 'by_experimentId', keyPath: 'experimentId', unique: true },
    ],
  },
  // Layer 9 / Section 3 (Phase 4, final Tier 4 item): the Scientific
  // Knowledge Graph. KnowledgeGraphNodes is write-once, one row per
  // distinct (nodeType, refId) pair -- registering the same entity twice
  // is a safe idempotent no-op (mirrors Lockbox/ReproducibilityManifests'
  // "compute/register once" semantics), and by_nodeType_refId doubles as
  // both the write-once uniqueKeyFn's index AND the "list every node of
  // this type" query (listByIndexRange with a 1-element [nodeType] prefix).
  KnowledgeGraphNodes: {
    keyPath: 'id',
    indexes: [
      { name: 'by_nodeType_refId', keyPath: ['nodeType', 'refId'], unique: true },
    ],
  },
  // KnowledgeGraphEdges is append-only, one row per asserted relationship --
  // an edge is a permanent historical fact ("this link was asserted"), the
  // same reasoning already applied to every other relationship-ledger store
  // in this database (FamilyWealthLedger, PublicationStatusTransitions).
  // by_fromNodeId_seq is unique (mirrors FamilyWealthLedger/onlineFdr.js's
  // own seq-assignment pattern) and drives forward traversal; the second,
  // non-unique index enables the reverse direction without a second
  // seq-counter scoped to toNodeId, ordering instead by registeredAt.
  KnowledgeGraphEdges: {
    keyPath: 'id',
    indexes: [
      { name: 'by_fromNodeId_seq', keyPath: ['fromNodeId', 'seq'], unique: true },
      { name: 'by_toNodeId_registeredAt', keyPath: ['toNodeId', 'registeredAt'], unique: false },
    ],
  },
  // Final Core Research Pipeline Implementation, Priority 3: one
  // append-only row per Randomness Audit run for a hypothesis --
  // by_hypothesis_seq mirrors CalibrationCanaryRuns'/PublicationStatusTransitions'
  // own exact index shape (a hypothesis may legitimately be re-audited as
  // more evidence accumulates; each run is its own permanent fact).
  RandomnessAuditResults: {
    keyPath: 'id',
    indexes: [
      { name: 'by_hypothesis_seq', keyPath: ['hypothesisId', 'seq'], unique: true },
    ],
  },
});

/**
 * Idempotently create every index declared for `storeName` on the given
 * IDBObjectStore (call only from inside an onupgradeneeded handler).
 */
export function applyIndexSpec(objectStore, storeName) {
  const spec = INDEX_SPECS[storeName];
  if (!spec) {
    throw new Error(`indexingStrategy: no INDEX_SPEC declared for store "${storeName}"`);
  }
  for (const idx of spec.indexes) {
    if (!objectStore.indexNames.contains(idx.name)) {
      objectStore.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique });
    }
  }
}

/**
 * Return the single newest row for a compound-index prefix match, e.g.
 * queryLatestByIndex(store, 'by_discoveryResult_createdAt', ['abc123']) finds
 * the latest row whose discoveryResultId === 'abc123', without scanning the
 * rest of the store.
 *
 * `store` must be an IDBObjectStore opened within an active transaction.
 * `keyPrefix` is an array matching a PREFIX of the compound index's keyPath
 * (IndexedDB compound-key range bounding on a prefix works via a bound range
 * from [...keyPrefix, -Infinity-equivalent] to [...keyPrefix, +Infinity]).
 */
/**
 * Required Fix 7 (defensive improvement): validates that the supplied
 * keyPrefix has exactly one FEWER element than the target index's declared
 * compound keyPath. queryLatestByIndex/listByIndexRange build their range by
 * appending exactly one sentinel element to keyPrefix — this silently
 * assumed every compound index has exactly `keyPrefix.length + 1` fields.
 * A future stage declaring a 3+-field compound index and calling these
 * helpers with a mismatched prefix length would previously get a silently
 * wrong range instead of a clear error — exactly the kind of "phantom
 * validation" failure mode this lab has already been burned by once
 * (R-060). This reads the index's own native `.keyPath` property (real
 * IndexedDB indexes expose this), so it is correct regardless of which
 * INDEX_SPECS entry, if any, happens to describe the store.
 */
function assertPrefixArity(index, keyPrefix, callerName) {
  const keyPath = index.keyPath;
  if (!Array.isArray(keyPath)) {
    throw new Error(`${callerName}: index "${index.name}" is not a compound index (keyPath is not an array) — these helpers are for compound-index prefix queries only`);
  }
  if (keyPrefix.length !== keyPath.length - 1) {
    throw new Error(
      `${callerName}: index "${index.name}" has a ${keyPath.length}-field compound keyPath (${JSON.stringify(keyPath)}), ` +
      `so keyPrefix must have exactly ${keyPath.length - 1} element(s) — received ${keyPrefix.length} ` +
      `(${JSON.stringify(keyPrefix)}). A mismatched prefix length would silently query the wrong range rather than ` +
      'the intended one; refusing to proceed rather than risk a silently-wrong result.'
    );
  }
}

export function queryLatestByIndex(store, indexName, keyPrefix) {
  return new Promise((resolve, reject) => {
    const index = store.index(indexName);
    assertPrefixArity(index, keyPrefix, 'queryLatestByIndex');
    const lower = [...keyPrefix, -Infinity];
    const upper = [...keyPrefix, []]; // an array sorts after any number/string/date in IndexedDB key ordering
    const range = IDBKeyRange.bound(lower, upper, false, false);
    const req = index.openCursor(range, 'prev');
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Return every row matching a compound-index prefix, newest first, optionally
 * bounded by `limit`. Used for list*(range) stage read APIs.
 */
export function listByIndexRange(store, indexName, keyPrefix, { limit = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const index = store.index(indexName);
    assertPrefixArity(index, keyPrefix, 'listByIndexRange');
    const lower = [...keyPrefix, -Infinity];
    const upper = [...keyPrefix, []];
    const range = IDBKeyRange.bound(lower, upper, false, false);
    const results = [];
    const req = index.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}


/**
 * Required Fix 7 (defensive improvement) — schema/index self-validation.
 * Given an OPEN IDBDatabase and the store names it is expected to contain
 * (per constants.js's DB definitions), verifies that every store exists and
 * that every index declared for it in INDEX_SPECS was actually created.
 * Intended for use in tests and, optionally, as a one-time post-upgrade
 * sanity check — NOT on every request path (it opens its own transactions
 * and would be wasteful to run per-operation).
 *
 * Returns { ok: boolean, problems: string[] } rather than throwing, so a
 * caller can decide whether a schema mismatch is fatal in its context.
 */
/**
 * RT-2 REMEDIATION (verified Major defect, now fixed).
 *
 * Root cause: this function previously verified only that an index with
 * the expected NAME exists on a store -- it never compared the index's
 * actual `keyPath` or `unique` flag against what INDEX_SPECS declares. A
 * same-named index that had drifted to a different `unique` setting (the
 * exact property enforcing idempotency for PowerAnalyses/Decisions/
 * Lockbox) or a different `keyPath` (array field order/length) would be
 * reported as `ok: true` -- a false all-clear for exactly the class of
 * drift this function exists to catch. Reproduced directly: a `Decisions`
 * store whose unique index was created with `unique: false` reported
 * `ok: true`, and two logically-duplicate writes both succeeded as
 * `created: true` as a direct, demonstrated consequence.
 *
 * THE FIX: for every declared index that IS present by name, additionally
 * compare its actual `unique` flag and `keyPath` (array-aware, so field
 * ORDER and LENGTH both matter, not just set membership) against the
 * INDEX_SPECS entry, reporting a specific problem for either kind of
 * mismatch rather than treating name-presence as sufficient.
 */
function keyPathsMatch(actual, expected) {
  const a = Array.isArray(actual) ? actual : [actual];
  const b = Array.isArray(expected) ? expected : [expected];
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function validateSchemaConsistency(db, expectedStoreNames) {
  const problems = [];
  for (const storeName of expectedStoreNames) {
    if (!db.objectStoreNames.contains(storeName)) {
      problems.push(`store "${storeName}" is expected (per constants.js) but does not exist on database "${db.name}"`);
      continue;
    }
    const spec = INDEX_SPECS[storeName];
    if (!spec) {
      problems.push(`store "${storeName}" exists but has no INDEX_SPECS entry — schema/spec drift`);
      continue;
    }
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    for (const idx of spec.indexes) {
      if (!store.indexNames.contains(idx.name)) {
        problems.push(`store "${storeName}" is missing declared index "${idx.name}" — INDEX_SPECS and the actual schema have drifted apart`);
        continue;
      }
      // RT-2: name presence alone is not proof of correctness -- verify the
      // properties that actually determine the index's behavior.
      const actualIndex = store.index(idx.name);
      if (!keyPathsMatch(actualIndex.keyPath, idx.keyPath)) {
        problems.push(
          `store "${storeName}" index "${idx.name}" has keyPath ${JSON.stringify(actualIndex.keyPath)} but INDEX_SPECS declares ` +
          `${JSON.stringify(idx.keyPath)} — same-named index with drifted keyPath (order or field set differs)`
        );
      }
      const expectedUnique = !!idx.unique;
      if (!!actualIndex.unique !== expectedUnique) {
        problems.push(
          `store "${storeName}" index "${idx.name}" has unique:${!!actualIndex.unique} but INDEX_SPECS declares unique:${expectedUnique} — ` +
          'a drifted uniqueness flag silently disables the idempotency/write-once guarantee this index is meant to enforce'
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
