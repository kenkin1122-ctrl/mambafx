/**
 * research/src/storage/adapters/appendOnlyAdapter.js
 *
 * Purpose:
 *   Mechanically enforce the append-only discipline (Volume III Rule 6/13
 *   family, v10.1 Section 9) at the runtime level, not just by convention.
 *   Any store wrapped by this adapter can only ever grow via add(); the
 *   wrapper deliberately does not define put()/delete() at all, so a caller
 *   attempting one gets an immediate "not a function" error rather than a
 *   silent mutation of history.
 *
 * Responsibilities:
 *   - add(record): writes a new row via IDBObjectStore.add() (never .put()),
 *     which itself throws a native ConstraintError if the keyPath value
 *     already exists — a second layer of protection against accidental key
 *     reuse, on top of never exposing an update method.
 *   - get(key): read a single row by primary key.
 *   - getAll(): read every row (bounded use only — callers needing "latest"
 *     semantics should use indexingStrategy.queryLatestByIndex instead of
 *     getAll(), to avoid the "unbounded scan" defect the freeze review
 *     flagged).
 *   - queryLatestByIndex / listByIndexRange: thin pass-throughs to
 *     indexingStrategy.js, scoped to this store.
 *
 * Inputs: an open IDBDatabase, a store name, an array of transaction mode
 *   ('readwrite' for add, 'readonly' for reads).
 * Outputs: Promises resolving to the written key, a row, or an array of rows.
 * Dependencies: indexingStrategy.js (for indexed reads).
 *
 * Public API: createAppendOnlyAdapter({db, storeName}) -> { add, get, getAll,
 *   queryLatestByIndex, listByIndexRange }.
 * Internal API: none.
 *
 * Error handling: every method rejects its returned Promise with the native
 *   IDBRequest error (e.g., ConstraintError on a duplicate `add()` key) —
 *   errors are never swallowed.
 * Performance notes: add()/get() are O(log n) IndexedDB B-tree operations;
 *   getAll() is O(n) and is intentionally not used internally by any other
 *   Phase 1+ module for "current state" queries (see indexingStrategy.js).
 * Threading model: safe to use from the main thread or a Worker — the
 *   IDBDatabase handle must belong to the calling context (IDBDatabase
 *   handles are not transferable across postMessage; each context opens its
 *   own connection to the same named database instead).
 * Storage usage: read/write against exactly one object store, addressed by
 *   name; never touches any other store in the same database.
 * Complexity analysis: see Performance notes above.
 * Future extension notes: if a future store needs a bulk-append operation,
 *   add addMany(records) here (looping add() calls inside one transaction)
 *   rather than exposing put()/delete() as a workaround.
 */

import { queryLatestByIndex, listByIndexRange } from '../../statistics/indexingStrategy.js';
import { normalizeDbSource } from './resolveDb.js';

export function createAppendOnlyAdapter({ db, getDb, storeName }) {
  if (!storeName) throw new TypeError('createAppendOnlyAdapter: storeName is required');
  const resolveDb = normalizeDbSource({ db, getDb }, 'createAppendOnlyAdapter');

  function add(record) {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

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

  return Object.freeze({
    add,
    get,
    getAll,
    queryLatestByIndex: queryLatestByIndexOnThisStore,
    listByIndexRange: listByIndexRangeOnThisStore,
  });
}
