/**
 * research/src/storage/adapters/writeOnceAdapter.js
 *
 * Purpose:
 *   Mechanically enforce Rule 6 (Lockbox is write-once) and the v10.1
 *   idempotency amendments for Stage 6 (decisionInputHash) and Stage 8
 *   (triggerId-scoped transitions) — Required Changes 4 and 9. A duplicate
 *   write with the same unique-index key is never silently accepted as a
 *   second row; it is detected and turned into a safe no-op that returns
 *   the ALREADY-EXISTING row.
 *
 *   PHASE 1 CORRECTIONS (post-independent-audit):
 *   - Required Fix 3: markFieldOnce/consumeOnce previously distinguished
 *     `undefined` from `null` when checking whether a guarded field was
 *     still "unset," which could incorrectly reject a row's FIRST
 *     legitimate consumption if that row was created without explicitly
 *     initializing the guarded field to `null`. Both the new consumeOnce()
 *     and the legacy markFieldOnce() shim now canonicalize `undefined` and
 *     `null` to the same "nullish/unset" state before comparing — this is
 *     deterministic and does not depend on how the row happened to be
 *     created.
 *   - Required Fix 4: the guarded field name (and its "unset" sentinel
 *     value) is now pinned ONCE at construction time via `guardField` /
 *     `guardUnsetValue`, rather than being supplied — and therefore
 *     re-typeable, and therefore mistake-prone — on every call. Callers
 *     that need one-time-consumption semantics call the new `consumeOnce()`
 *     method, which takes no field-name argument at all: there is no way
 *     to call it with the "wrong" field, because there is no field
 *     argument to get wrong. The old `markFieldOnce(key, updates, {
 *     preconditionField, preconditionValue })` signature is preserved as a
 *     deprecated backward-compatible shim (nothing outside this module's
 *     own tests called it yet, since no stage exists, but it costs nothing
 *     to keep it working) — it now shares the corrected canonicalization
 *     logic, so even a caller still using the old shape gets the Fix 3
 *     correctness fix.
 *
 * Responsibilities:
 *   - write(record): unique-index-based idempotent add (unchanged from
 *     Phase 1 original).
 *   - consumeOnce(primaryKey, updates): THE sanctioned one-time-consumption
 *     method for adapters constructed with a `guardField`. Atomically
 *     checks the pinned guard field is still unset (treating `undefined`
 *     and `null` identically) and, if so, applies `updates` in the same
 *     transaction as the precondition check.
 *   - markFieldOnce(...): deprecated backward-compatible shim over the same
 *     canonicalized-precondition logic, for any caller still using the
 *     Phase-1-original call shape.
 *   - get / getAll / queryLatestByIndex / listByIndexRange: unchanged read
 *     surface.
 *
 * Inputs: an open IDBDatabase, a store name, the unique index's name, a
 *   uniqueKeyFn, and OPTIONALLY (Required Fix 4) a `guardField` +
 *   `guardUnsetValue` (defaults to `null`) pinned at construction time for
 *   stores that need one-time-consumption semantics (currently: Lockbox).
 * Outputs: { created: boolean, record } from write(); { ok: boolean,
 *   record?, reason? } from consumeOnce()/markFieldOnce().
 * Dependencies: indexingStrategy.js.
 *
 * Public API: createWriteOnceAdapter({db, storeName, uniqueIndexName,
 *   uniqueKeyFn, guardField?, guardUnsetValue?}) -> { write, consumeOnce,
 *   markFieldOnce (deprecated), get, getAll, queryLatestByIndex,
 *   listByIndexRange }.
 * Internal API: isNullish (canonicalization helper).
 *
 * Error handling: write() only swallows a ConstraintError specifically on
 *   the declared unique index. consumeOnce()/markFieldOnce() resolve with
 *   {ok:false, reason:'not-found'|'precondition-failed'} for expected
 *   domain conditions; consumeOnce() throws (synchronously, before any
 *   transaction is opened) if the adapter was not constructed with a
 *   guardField, since calling it on a store with no configured guard is a
 *   programmer error, not a domain outcome.
 * Performance notes: unchanged from Phase 1 original — O(log n) per
 *   operation; the precondition check and its write remain inside one
 *   transaction, so the atomicity guarantee is unchanged by these fixes.
 * Threading model: safe from main thread or Worker.
 * Storage usage: read/write against exactly one named store.
 * Complexity analysis: O(log n) per operation.
 * Future extension notes: any future write-once store that needs one-time-
 *   consumption semantics should be constructed with its own `guardField`
 *   at creation time, exactly like Lockbox — never by calling a generic
 *   field-name-parameterized method, which is precisely the pattern
 *   Required Fix 4 removed.
 */

import { queryLatestByIndex, listByIndexRange } from '../../statistics/indexingStrategy.js';
import { normalizeDbSource } from './resolveDb.js';

/** Treats `null` and `undefined` as the same "unset" state — Required Fix 3. */
function isNullish(v) {
  return v === null || v === undefined;
}

/** Canonicalizes a value for guard-precondition comparison: nullish values collapse to `null`, everything else passes through unchanged. */
function canonicalizeForGuard(v) {
  return isNullish(v) ? null : v;
}

/**
 * V-2 REMEDIATION (verified Major defect, now fixed structurally).
 *
 * The independent adversarial audit found that consumeOnce()/markFieldOnce()
 * trusted the CALLER's `updates` object to actually move the guarded field
 * away from its "unset" sentinel. If `updates` omitted the guard field
 * entirely (an easy, realistic mistake -- e.g. a caller meaning only to set
 * `consumedBy` and forgetting `consumedAt`), the row was written back with
 * the guard field STILL unset, and a second consumeOnce() call succeeded
 * again -- a real, reproduced defeat of "Lockbox is write-once" requiring no
 * malice, just an omission.
 *
 * THE FIX: write-once enforcement must be owned by the ADAPTER, not by
 * caller discipline. This function computes the final guard-field value
 * for a successful consumption UNCONDITIONALLY -- regardless of what (if
 * anything) `updates` says about that field:
 *   - If the caller's `updates` explicitly sets the guard field to a value
 *     that is NOT the unset sentinel, that value is honored (preserves
 *     every existing correct caller's behavior, e.g. explicit
 *     `{consumedAt: Date.now()}`).
 *   - In EVERY other case -- the field is omitted from `updates` entirely,
 *     or `updates` explicitly (accidentally or otherwise) sets it back to
 *     the unset sentinel -- the field is forced to `Date.now()` (or a
 *     caller-supplied `consumedMarker`, see consumeOnce()'s signature),
 *     guaranteeing the guard ALWAYS moves to a genuinely-consumed state on
 *     every successful call. There is no code path through this function
 *     that can produce a "successful consume" result while leaving the
 *     guard field equal to its unset sentinel.
 */
function computeGuardedUpdate(record, updates, field, unsetSentinel, consumedMarker) {
  const proposedHasOwn = Object.prototype.hasOwnProperty.call(updates, field);
  const proposedCanonical = proposedHasOwn ? canonicalizeForGuard(updates[field]) : canonicalizeForGuard(undefined);
  const sentinelCanonical = canonicalizeForGuard(unsetSentinel);
  const finalGuardValue = (proposedHasOwn && proposedCanonical !== sentinelCanonical)
    ? updates[field]
    : consumedMarker;
  return { ...record, ...updates, [field]: finalGuardValue };
}

/**
 * RT-3 REMEDIATION (defense-in-depth, in addition to the fake's now-fixed
 * put() constraint enforcement -- see tests/support/fakeIndexedDB.js).
 *
 * The independent red-team audit found that guardedWrite() applied the
 * caller's `updates` via an unrestricted `{ ...record, ...updates }`
 * spread, with nothing stopping `updates` from silently changing the
 * PRIMARY KEY or the fields backing the adapter's own unique index. A
 * caller mistake (e.g. `consumeOnce(key, { id: 'different-id', ... })`)
 * would then have store.put() write to a DIFFERENT primary key than the
 * row that was just precondition-checked, leaving the ORIGINAL row
 * permanently unconsumed and creating a PHANTOM row holding the consumed
 * state -- a duplicate-evidence / split-identity defect.
 *
 * In a real browser this exact scenario is independently caught by
 * IndexedDB's native unique-index constraint enforcement on put() (now
 * also correctly modeled by the test fake, closing that specific
 * verification gap) -- but relying SOLELY on a downstream native
 * ConstraintError, with no explicit guard at the call site, is fragile:
 * it depends on the store actually having a unique index covering every
 * identity-bearing field, produces a generic, less actionable error, and
 * was, prior to this fix, completely unverified by any test in this
 * codebase. This adds an explicit, named, adapter-level rejection that
 * fires BEFORE any write is attempted, independent of whether the
 * underlying store happens to have a unique index that would also catch
 * it.
 */
export class IdentityMutationError extends Error {
  constructor(storeName, field, currentValue, attemptedValue) {
    super(
      `guardedWrite: updates for store "${storeName}" attempted to change identity-bearing field "${field}" from ` +
      `${JSON.stringify(currentValue)} to ${JSON.stringify(attemptedValue)}. consumeOnce()/markFieldOnce() updates ` +
      'must not change the primary key or any field backing this adapter\'s unique index -- doing so would split ' +
      'one logical row into two (an orphaned original plus a phantom), silently defeating write-once enforcement.'
    );
    this.name = 'IdentityMutationError';
    this.storeName = storeName;
    this.field = field;
    this.currentValue = currentValue;
    this.attemptedValue = attemptedValue;
  }
}

function assertNoIdentityMutation(storeName, keyPath, uniqueKeyFn, record, updates) {
  const keyPathFields = Array.isArray(keyPath) ? keyPath : [keyPath];
  for (const field of keyPathFields) {
    if (Object.prototype.hasOwnProperty.call(updates, field) && updates[field] !== record[field]) {
      throw new IdentityMutationError(storeName, field, record[field], updates[field]);
    }
  }
  if (typeof uniqueKeyFn === 'function') {
    const currentUniqueKey = uniqueKeyFn(record);
    const proposedUniqueKey = uniqueKeyFn({ ...record, ...updates });
    const changed = Array.isArray(currentUniqueKey)
      ? currentUniqueKey.some((v, i) => v !== proposedUniqueKey[i]) || currentUniqueKey.length !== proposedUniqueKey.length
      : currentUniqueKey !== proposedUniqueKey;
    if (changed) {
      throw new IdentityMutationError(storeName, '(unique index key)', currentUniqueKey, proposedUniqueKey);
    }
  }
}

export function createWriteOnceAdapter({ db, getDb, storeName, uniqueIndexName, uniqueKeyFn, guardField = null, guardUnsetValue = null }) {
  if (!storeName) throw new TypeError('createWriteOnceAdapter: storeName is required');
  if (!uniqueIndexName) throw new TypeError('createWriteOnceAdapter: uniqueIndexName is required');
  if (typeof uniqueKeyFn !== 'function') throw new TypeError('createWriteOnceAdapter: uniqueKeyFn must be a function');
  const resolveDb = normalizeDbSource({ db, getDb }, 'createWriteOnceAdapter');

  function fetchByUniqueKey(keyArray) {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(uniqueIndexName);
      const req = index.get(keyArray);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function write(record) {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.add(record);
      req.onsuccess = () => resolve({ created: true, record });
      req.onerror = (ev) => {
        const err = req.error;
        if (err && err.name === 'ConstraintError') {
          ev.preventDefault();
          const keyArray = uniqueKeyFn(record);
          fetchByUniqueKey(keyArray)
            .then((existing) => resolve({ created: false, record: existing }))
            .catch(reject);
        } else {
          reject(err);
        }
      };
    }));
  }

  /**
   * Shared implementation behind both consumeOnce() and the deprecated
   * markFieldOnce() shim.
   *
   * V-2 REMEDIATION: the final written record's guard field is computed via
   * computeGuardedUpdate(), NOT via a naive `{ ...record, ...updates }`
   * spread. This structurally guarantees that on every successful
   * transition (the `ok: true` path), the guard field is moved to a
   * definite, non-unset value -- regardless of whether the caller's
   * `updates` included that field at all. Caller-supplied `updates` for
   * every OTHER field are still honored unchanged.
   */
  function guardedWrite(primaryKey, updates, field, unsetSentinel) {
    return resolveDb().then((database) => new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const getReq = store.get(primaryKey);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) {
          resolve({ ok: false, reason: 'not-found' });
          return;
        }
        const currentCanonical = canonicalizeForGuard(record[field]);
        const sentinelCanonical = canonicalizeForGuard(unsetSentinel);
        if (currentCanonical !== sentinelCanonical) {
          resolve({ ok: false, reason: 'precondition-failed', record });
          return;
        }
        // RT-3 REMEDIATION: reject BEFORE any write is attempted if updates
        // would change the primary key or the fields backing this
        // adapter's unique index -- see assertNoIdentityMutation() above.
        // Thrown synchronously within this handler; propagates as a
        // rejection of the returned Promise (uncaught synchronous throws
        // inside a Promise executor/then-callback reject the Promise).
        try {
          assertNoIdentityMutation(storeName, store.keyPath, uniqueKeyFn, record, updates);
        } catch (err) {
          reject(err);
          return;
        }
        const updated = computeGuardedUpdate(record, updates, field, unsetSentinel, Date.now());
        const putReq = store.put(updated);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => resolve({ ok: true, record: updated });
      };
    }));
  }

  /**
   * THE sanctioned one-time-consumption method (Required Fix 4). Only
   * usable on an adapter constructed with `guardField`. Correctly treats an
   * uninitialized (`undefined`) guarded field the same as an explicitly
   * `null` one (Required Fix 3). Per V-2 remediation, the guard field is
   * structurally forced off its unset sentinel on every successful call --
   * see computeGuardedUpdate()/guardedWrite() above -- so callers can no
   * longer defeat one-time-consumption by omitting the guard field from
   * `updates`.
   */
  function consumeOnce(primaryKey, updates) {
    if (!guardField) {
      throw new Error(
        `consumeOnce: this writeOnceAdapter for store "${storeName}" was not constructed with a guardField — ` +
        `one-time-consumption semantics are not configured for this store. Pass { guardField, guardUnsetValue } ` +
        'to createWriteOnceAdapter() at construction time if this store needs them.'
      );
    }
    return guardedWrite(primaryKey, updates, guardField, guardUnsetValue);
  }

  /**
   * @deprecated Use consumeOnce(key, updates) on an adapter constructed
   * with a pinned guardField instead. This shim exists only for backward
   * compatibility with the Phase 1 pre-correction call shape and applies
   * the same Required-Fix-3 canonicalization. Logs a one-time-per-call
   * deprecation warning.
   */
  function markFieldOnce(primaryKey, updates, opts = {}) {
    const field = opts.preconditionField || guardField;
    if (!field) {
      throw new TypeError(
        'markFieldOnce: preconditionField is required when the adapter has no configured guardField ' +
        '(preferred: construct the adapter with { guardField, guardUnsetValue } and call consumeOnce() instead).'
      );
    }
    const unsetSentinel = 'preconditionValue' in opts ? opts.preconditionValue : guardUnsetValue;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `writeOnceAdapter.markFieldOnce is deprecated for store "${storeName}" — construct the adapter with ` +
        '{ guardField } and call consumeOnce(key, updates) instead. This shim will be removed in a future phase.'
      );
    }
    return guardedWrite(primaryKey, updates, field, unsetSentinel);
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
    write,
    consumeOnce,
    markFieldOnce,
    get,
    getAll,
    queryLatestByIndex: queryLatestByIndexOnThisStore,
    listByIndexRange: listByIndexRangeOnThisStore,
  });
}
