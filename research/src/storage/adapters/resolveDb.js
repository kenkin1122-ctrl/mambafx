/**
 * research/src/storage/adapters/resolveDb.js
 *
 * V-3 REMEDIATION (verified Major defect, now fixed).
 *
 * Purpose:
 *   Shared helper used by all three storage adapters (appendOnlyAdapter,
 *   readOnlyAdapter, writeOnceAdapter) to eliminate the "stale closed-db
 *   capture" defect found by Adversarial Audit V3.
 *
 *   Root cause (confirmed via reproduction): every adapter factory
 *   captured a single resolved `db` (an IDBDatabase instance) in its
 *   closure at construction time. If the underlying connection was later
 *   closed (e.g. via closeExistingDbConnection(), or a native
 *   onversionchange auto-close), any adapter instance obtained BEFORE that
 *   closure kept using the now-dead handle forever -- every subsequent
 *   operation threw "cannot start a transaction on a closed connection,"
 *   with no self-healing path, even though a freshly-obtained adapter
 *   (calling the same getXAdapter() factory function again) worked fine.
 *
 *   THE FIX: adapter factories now accept EITHER a resolved `db` (an
 *   IDBDatabase -- preserved for backward compatibility and tests that
 *   construct adapters directly against a fake/short-lived db) OR a
 *   `getDb` thunk (`() => IDBDatabase | Promise<IDBDatabase>`). This
 *   module normalizes both shapes into a single `resolveDb()` function
 *   that every adapter operation calls immediately before opening its
 *   transaction. When callers use the thunk form, each operation
 *   re-resolves the CURRENT live connection (e.g. by calling back into
 *   openExistingDbExtended()'s memoized connection accessor), so a closed
 *   connection is transparently replaced by the next real open on the very
 *   next call -- no adapter instance can be left permanently stale.
 *
 * Public API: normalizeDbSource({ db, getDb }, callerName) -> resolveDb()
 *   -> Promise<IDBDatabase>.
 * Error handling: throws synchronously (construction-time, not per-call) if
 *   neither `db` nor `getDb` is supplied.
 * Threading model: pure, synchronous normalization; the returned
 *   resolveDb() function is safe to call repeatedly and concurrently.
 * Storage usage: none -- no I/O of its own.
 * Complexity analysis: O(1).
 * Future extension notes: if a future adapter needs connection-health
 *   checks (e.g. verifying `db.objectStoreNames` before use), add them
 *   inside resolveDb() here so every adapter benefits uniformly.
 */

export function normalizeDbSource({ db, getDb }, callerName) {
  if (!db && !getDb) {
    throw new TypeError(`${callerName}: either db or getDb is required`);
  }
  if (getDb && typeof getDb !== 'function') {
    throw new TypeError(`${callerName}: getDb, if provided, must be a function`);
  }
  if (getDb) {
    // Thunk form: re-resolve on every call, so a closed/replaced connection
    // is picked up transparently instead of being captured once and reused
    // forever.
    return () => Promise.resolve(getDb());
  }
  // Static form: preserved for backward compatibility (existing direct
  // constructions and tests that pass an already-open db with no notion of
  // a reconnect path).
  return () => Promise.resolve(db);
}
