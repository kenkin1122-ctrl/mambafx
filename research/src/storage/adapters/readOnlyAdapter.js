/**
 * research/src/storage/adapters/readOnlyAdapter.js
 *
 * Purpose:
 *   Mechanically enforce Dependency Rules 1, 2, 3, 13 (Stage 5 doesn't
 *   modify Stage 3 outputs; Stage 9 is strictly read-only; Stage 7 cannot
 *   alter historical experiments; reports/ has no side effects) at the
 *   runtime level. A module handed a readOnlyAdapter-wrapped store has NO
 *   write method available on the object at all — not a permission check
 *   that could be bypassed, an actually-absent method.
 *
 * Responsibilities:
 *   - Expose exactly: get, getAll, queryLatestByIndex, listByIndexRange.
 *   - Define nothing else — no add, no put, no delete, on the returned
 *     object, regardless of what the underlying store supports.
 *
 * Inputs: an open IDBDatabase (any store in it, including ones this stage
 *   does not own), a store name.
 * Outputs: Promises resolving to rows.
 * Dependencies: indexingStrategy.js.
 *
 * Public API: createReadOnlyAdapter({db, storeName}) -> { get, getAll,
 *   queryLatestByIndex, listByIndexRange }.
 * Internal API: none.
 *
 * Error handling: same as appendOnlyAdapter's read methods — native
 *   IDBRequest errors propagate via Promise rejection.
 * Performance notes: identical characteristics to appendOnlyAdapter's reads.
 * Threading model: safe from main thread or Worker.
 * Storage usage: read-only against one named store.
 * Complexity analysis: same as appendOnlyAdapter reads.
 * Future extension notes: if a genuinely new read pattern is needed (e.g.,
 *   a count-only query for a dashboard), add it here as a new read-only
 *   method — never add a write method to this factory under any
 *   circumstance; that would silently undermine every rule this adapter
 *   exists to enforce.
 */

import { queryLatestByIndex, listByIndexRange } from '../../statistics/indexingStrategy.js';
import { normalizeDbSource } from './resolveDb.js';

export function createReadOnlyAdapter({ db, getDb, storeName }) {
  if (!storeName) throw new TypeError('createReadOnlyAdapter: storeName is required');
  const resolveDb = normalizeDbSource({ db, getDb }, 'createReadOnlyAdapter');

  function get(key) {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function getAll() {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function queryLatestByIndexOnThisStore(indexName, keyPrefix) {
    return resolveDb().then((database) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      return queryLatestByIndex(store, indexName, keyPrefix);
    });
  }

  function listByIndexRangeOnThisStore(indexName, keyPrefix, opts) {
    return resolveDb().then((database) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      return listByIndexRange(store, indexName, keyPrefix, opts);
    });
  }

  // Object.freeze here is the enforcement mechanism: no write method exists
  // on this object, and none can be added to this specific instance later.
  return Object.freeze({
    get,
    getAll,
    queryLatestByIndex: queryLatestByIndexOnThisStore,
    listByIndexRange: listByIndexRangeOnThisStore,
  });
}
