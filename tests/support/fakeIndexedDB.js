/**
 * tests/support/fakeIndexedDB.js
 *
 * TEST-ONLY tooling. Not part of the shipped browser application, not
 * imported by anything under research/src/ or index.html. Exists solely so
 * research/src/storage/* can be unit-tested under Node, following the exact
 * precedent already established in this codebase (RESEARCH_DEBT_REGISTER.md:
 * "11 tests for the IndexedDB-backed Generation Registry ... via
 * fake-indexeddb"). This is a minimal, purpose-built fake implementing only
 * the subset of the IndexedDB API the Phase 1 adapters actually use:
 * databases/object stores/indexes (including unique indexes), add/get/
 * getAll/put, index.get, and index.openCursor with a bound key range and
 * 'prev'/'next' direction — enough to exercise every adapter and reconcile
 * path without pulling in an external npm dependency (this repo has no
 * package.json / npm dependency graph today, per MODULE_DEPENDENCIES.md).
 *
 * Deliberately NOT spec-complete. As of this revision (Phase 1 Remediation
 * V3), the fake models:
 *   - Upgrade (versionchange) transaction ABORT, including full reversion
 *     of an implicit "create a brand-new database" side effect — this is
 *     what makes the V-1 fix (probeExistingDbVersion no longer silently
 *     creating an empty database) independently testable, and matches real,
 *     documented IndexedDB behavior (aborting the initial versionchange
 *     transaction of a database that did not previously exist reverts it to
 *     non-existent).
 *   - Regular (readwrite/readonly) transaction COMPLETION (`oncomplete`) via
 *     a best-effort pending-request counter, and a SCOPED, DELIBERATELY
 *     PARTIAL `abort()`/`onabort` for regular transactions: calling abort()
 *     prevents further requests on that transaction and fires `onabort`,
 *     but — unlike real IndexedDB — does NOT retroactively roll back writes
 *     whose requests already fired `_succeed` before the abort call. This
 *     is a conscious, disclosed simplification: no Phase 1 production code
 *     aborts a regular transaction after issuing writes, so full
 *     write-buffering/rollback for the regular-transaction case was judged
 *     disproportionate complexity for zero current benefit. Do not treat a
 *     regular transaction's abort() in this fake as proof of real
 *     mid-transaction rollback semantics — only the upgrade-transaction
 *     abort path is fully, correctly modeled.
 *   - Still NOT modeled: cross-transaction locking/serialization (two
 *     "concurrent" transactions on the same store do not queue behind each
 *     other the way real IndexedDB transactions do), cursor delete/update,
 *     'readonly' transactions rejecting write attempts. None of these are
 *     exercised by any Phase 1 module as of this revision.
 */

function typeRank(v) {
  if (Array.isArray(v)) return 4;
  if (v instanceof Date) return 2;
  if (typeof v === 'string') return 3;
  if (typeof v === 'number') return 1;
  return 0;
}

function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 4) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareKeys(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return compareValues(a, b);
}

function inRange(key, range) {
  if (!range) return true;
  if (range.lower !== undefined) {
    const c = compareKeys(key, range.lower);
    if (c < 0 || (c === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const c = compareKeys(key, range.upper);
    if (c > 0 || (c === 0 && range.upperOpen)) return false;
  }
  return true;
}

function extractKey(record, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((k) => record[k]);
  return record[keyPath];
}

function makeConstraintError(message) {
  const err = new Error(message);
  err.name = 'ConstraintError';
  return err;
}

function makeVersionError(message) {
  const err = new Error(message);
  err.name = 'VersionError';
  return err;
}

function makeAbortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

class FakeIDBRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = undefined;
    this._internalListeners = []; // fired alongside onsuccess/onerror, used internally for transaction pending-request tracking (oncomplete support) -- never overwritten by caller assignment the way onsuccess/onerror can be.
  }
  _addInternalListener(fn) {
    this._internalListeners.push(fn);
  }
  _succeed(result) {
    this.result = result;
    queueMicrotask(() => {
      for (const fn of this._internalListeners) fn(true);
      if (this.onsuccess) this.onsuccess({ target: this });
    });
  }
  _fail(error) {
    this.error = error;
    queueMicrotask(() => {
      for (const fn of this._internalListeners) fn(false);
      if (this.onerror) this.onerror({ target: this, preventDefault() {} });
    });
  }
}

class FakeIndex {
  constructor(store, name, keyPath, unique) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
    this.unique = unique;
  }
  _entries() {
    return [...this.store.rows.values()].map((row) => ({ key: extractKey(row, this.keyPath), value: row }));
  }
  get(key) {
    const req = new FakeIDBRequest();
    const found = this._entries().find((e) => compareKeys(e.key, key) === 0);
    req._succeed(found ? found.value : undefined);
    return req;
  }
  openCursor(range, direction = 'next') {
    const req = new FakeIDBRequest();
    let entries = this._entries().filter((e) => inRange(e.key, range));
    entries.sort((a, b) => compareKeys(a.key, b.key));
    if (direction === 'prev') entries.reverse();
    let index = 0;
    const emitNext = () => {
      if (index >= entries.length) {
        req.result = null;
        // A cursor request fires onsuccess MULTIPLE times (once per
        // cursor.continue()) before real IndexedDB considers the whole
        // read "done" -- this terminal (null) callback always counts as
        // the request settling for transaction-completion/serialization
        // tracking purposes, since reaching it means every prior step was
        // explicitly continued (see the abandonment branch below, which is
        // mutually exclusive with this one firing for the same read).
        queueMicrotask(() => {
          for (const fn of req._internalListeners) fn(true);
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return;
      }
      const entry = entries[index];
      let continued = false;
      const cursor = { value: entry.value, continue() { continued = true; index++; emitNext(); } };
      req.result = cursor;
      queueMicrotask(() => {
        if (req.onsuccess) req.onsuccess({ target: req });
        // FAKE-CURSOR-ABANDONMENT FIX: real IndexedDB requires continue()
        // (if it is going to be called at all) to be invoked SYNCHRONOUSLY
        // within the request's own success callback -- calling it later
        // throws InvalidStateError in a real browser. That means that, by
        // the time this queued callback returns, we already know whether
        // the caller is continuing the cursor or has abandoned it at this
        // row (a legitimate, common pattern -- e.g. queryLatestByIndex(),
        // which deliberately reads only the first matching row and never
        // calls continue()). Previously, an abandoned (non-exhausted)
        // cursor's owning request never fired its internal listener at
        // all, so the owning transaction's pending-request count never
        // reached zero, the transaction never settled, and any LATER
        // transaction queued behind it on the same store (per the RT-1
        // serialization model above) deadlocked forever. Firing the
        // internal listener here, exactly when the cursor is abandoned
        // rather than continued, matches real IndexedDB's actual
        // transaction-completion behavior and is mutually exclusive with
        // the terminal (null) branch above ever also firing for the same
        // logical read (continuing to exhaustion means every intermediate
        // step had continued === true, so none of them reach this branch).
        if (!continued) {
          for (const fn of req._internalListeners) fn(true);
        }
      });
    };
    queueMicrotask(emitNext);
    return req;
  }
}

class FakeObjectStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.rows = new Map(); // stringified primary key -> row
    this.indexSpecs = new Map(); // name -> {keyPath, unique}
    this.indexNames = { contains: (n) => this.indexSpecs.has(n) };
  }
  createIndex(name, keyPath, opts = {}) {
    this.indexSpecs.set(name, { keyPath, unique: !!opts.unique });
  }
  index(name) {
    const spec = this.indexSpecs.get(name);
    if (!spec) throw new Error(`FakeObjectStore: no index "${name}" on store "${this.name}"`);
    return new FakeIndex(this, name, spec.keyPath, spec.unique);
  }
  _pkString(key) { return JSON.stringify(key); }

  add(record) {
    const req = new FakeIDBRequest();
    const pk = extractKey(record, this.keyPath);
    const pkStr = this._pkString(pk);
    if (this.rows.has(pkStr)) {
      req._fail(makeConstraintError(`Key already exists in store "${this.name}"`));
      return req;
    }
    for (const [idxName, spec] of this.indexSpecs) {
      if (!spec.unique) continue;
      const candidateKey = extractKey(record, spec.keyPath);
      const clash = [...this.rows.values()].some((r) => compareKeys(extractKey(r, spec.keyPath), candidateKey) === 0);
      if (clash) {
        req._fail(makeConstraintError(`Unique index "${idxName}" violated on store "${this.name}"`));
        return req;
      }
    }
    this.rows.set(pkStr, record);
    req._succeed(pk);
    return req;
  }

  /**
   * RT-3 REMEDIATION: real IndexedDB enforces unique-index constraints on
   * put() exactly as it does on add() -- the only difference between the
   * two operations is add()'s additional "no overwrite of an existing
   * primary key" check. This fake's put() previously performed NO
   * constraint checking at all, which masked a real (if narrow) risk: a
   * caller error that changes an identity-bearing field via put() (e.g.
   * guardedWrite() applying an `updates` object that includes a different
   * primary key) would silently succeed here even though a real browser
   * would reject it with a ConstraintError. This brings put() in line with
   * real IndexedDB: a write that would create a duplicate under a unique
   * index -- INCLUDING one under a DIFFERENT primary key than any existing
   * row already holding that unique-index value -- is rejected.
   */
  put(record) {
    const req = new FakeIDBRequest();
    const pk = extractKey(record, this.keyPath);
    const pkStr = this._pkString(pk);
    for (const [idxName, spec] of this.indexSpecs) {
      if (!spec.unique) continue;
      const candidateKey = extractKey(record, spec.keyPath);
      const clash = [...this.rows.entries()].some(
        ([otherPkStr, r]) => otherPkStr !== pkStr && compareKeys(extractKey(r, spec.keyPath), candidateKey) === 0
      );
      if (clash) {
        req._fail(makeConstraintError(`Unique index "${idxName}" violated on store "${this.name}" (put)`));
        return req;
      }
    }
    this.rows.set(pkStr, record);
    req._succeed(pk);
    return req;
  }

  get(key) {
    const req = new FakeIDBRequest();
    req._succeed(this.rows.get(this._pkString(key)));
    return req;
  }

  getAll() {
    const req = new FakeIDBRequest();
    req._succeed([...this.rows.values()]);
    return req;
  }
}

/**
 * Regular (non-upgrade) transaction wrapper. See the module header for the
 * exact, scoped semantics implemented here: `oncomplete` fires (best-effort,
 * via a pending-request counter) once every request issued through this
 * transaction has settled; `abort()`/`onabort` prevent further requests and
 * fire the callback, but do NOT roll back writes whose requests already
 * succeeded before the abort call (a disclosed simplification -- see
 * module header).
 */
/**
 * RT-1 REMEDIATION (verified Major test-fidelity gap, now closed).
 *
 * Real IndexedDB serializes transactions with overlapping object-store
 * scope in the order they were CREATED: a later transaction's requests do
 * not begin executing until every earlier-created, overlapping-scope
 * transaction has fully committed or aborted. This fake previously had no
 * such model at all -- every request executed immediately, synchronously,
 * regardless of what other transactions existed -- which meant two
 * "concurrent" (not sequentially awaited) readwrite transactions against
 * the same store could interleave in ways a real browser would never
 * allow, masking whether a get-then-put pattern (e.g.
 * writeOnceAdapter.js's guardedWrite()) is actually safe under
 * concurrency. It is safe in a real browser BECAUSE of this serialization
 * guarantee -- so the fake needed to model it for that guarantee to be
 * independently testable at all, rather than merely assumed from reading
 * the specification.
 *
 * Model chosen (smallest correct-enough approximation for Phase 1's
 * needs): every transaction, of EITHER mode, that overlaps in
 * object-store scope with an earlier-created transaction for the same
 * database record is queued strictly behind it -- its requests do not
 * begin real execution until the earlier transaction has settled
 * (oncomplete or onabort). This is a conservative OVER-approximation of
 * the real spec (which allows multiple concurrent READONLY transactions
 * with overlapping scope to interleave with each other) -- Phase 1 has no
 * scenario that depends on concurrent-readonly interleaving, so the
 * simpler, strictly-serial-by-creation-order model is sufficient and
 * never produces a FALSE failure (only ever more serialization than a
 * real browser would apply, never less).
 */
class FakeTransaction {
  constructor(record, storeNames) {
    this.record = record;
    this.storeNames = storeNames;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this._pending = 0;
    this._settled = false;
    this._aborted = false;

    // Queue this transaction's START behind every earlier-created
    // transaction with overlapping scope, and register this transaction's
    // own completion as what the NEXT overlapping transaction must wait
    // for.
    if (!record._storeQueueTail) record._storeQueueTail = new Map();
    const previousTails = storeNames.map((name) => record._storeQueueTail.get(name) || Promise.resolve());
    this._turnStart = Promise.all(previousTails).then(() => {});
    let resolveTurnDone;
    this._turnDone = new Promise((resolve) => { resolveTurnDone = resolve; });
    this._resolveTurnDone = resolveTurnDone;
    for (const name of storeNames) record._storeQueueTail.set(name, this._turnDone);
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) {
      throw new Error(`FakeTransaction: store "${name}" is not within this transaction's declared scope (${JSON.stringify(this.storeNames)})`);
    }
    const store = this.record.stores.get(name);
    if (!store) throw new Error(`FakeTransaction: no object store "${name}" on database "${this.record.name}"`);
    return this._wrapStore(store);
  }

  abort() {
    if (this._settled) return; // already completed or aborted -- no-op, matches real IDBTransaction tolerance
    this._aborted = true;
    this._settled = true;
    this._resolveTurnDone();
    queueMicrotask(() => { if (this.onabort) this.onabort({ target: this }); });
  }

  _trackRequest(req) {
    if (this._aborted) {
      throw new Error('FakeTransaction: cannot issue a request on a transaction that has already been aborted');
    }
    this._pending++;
    req._addInternalListener(() => {
      this._pending--;
      this._maybeComplete();
    });
  }

  _maybeComplete() {
    if (this._settled) return;
    if (this._pending > 0) return;
    // Defer one more microtask tick so a caller chaining a SECOND request
    // off the first request's own .onsuccess handler (a common pattern) has
    // a chance to issue it and bump _pending back up before we declare the
    // transaction complete.
    queueMicrotask(() => {
      if (this._settled || this._pending > 0) return;
      this._settled = true;
      this._resolveTurnDone();
      if (this.oncomplete) this.oncomplete({ target: this });
    });
  }

  _wrapStore(store) {
    const tx = this;
    // Every operation is gated behind this transaction's turn (see
    // constructor): the underlying store method is not invoked until every
    // earlier-created, scope-overlapping transaction has fully settled.
    const gated = (run) => {
      const outerReq = new FakeIDBRequest();
      tx._trackRequest(outerReq);
      tx._turnStart.then(() => {
        const innerReq = run();
        innerReq._addInternalListener((success) => {
          if (success) outerReq._succeed(innerReq.result);
          else outerReq._fail(innerReq.error);
        });
      });
      return outerReq;
    };
    return {
      name: store.name,
      keyPath: store.keyPath,
      indexNames: store.indexNames,
      createIndex: (...args) => store.createIndex(...args),
      // RT-1 REMEDIATION: index.get()/index.openCursor() previously bypassed
      // this transaction's request tracking entirely (they called straight
      // through to the raw FakeIndex, never registering with
      // _trackRequest()). A transaction whose ONLY requests were
      // index-based (e.g. writeOnceAdapter's fetchByUniqueKey(), which uses
      // index.get() exclusively) therefore never accumulated any pending
      // count and never settled -- deadlocking any LATER transaction
      // queued behind it. Both index methods are now tracked the same way
      // store methods are; index.get() is additionally turn-gated for full
      // consistency, while index.openCursor() is tracked (so the owning
      // transaction correctly settles once cursor iteration terminates)
      // but not turn-gated, since none of Phase 1's current cursor
      // consumers (queryLatestByIndex/listByIndexRange) participate in a
      // get-then-put race the way guardedWrite() does -- gating a
      // multi-step cursor request behind another transaction's turn is a
      // materially larger change reserved for if/when that need arises.
      index: (name) => {
        const idx = store.index(name);
        return {
          name: idx.name,
          keyPath: idx.keyPath,
          unique: idx.unique,
          get: (key) => gated(() => idx.get(key)),
          openCursor: (range, direction) => {
            const req = idx.openCursor(range, direction);
            tx._trackRequest(req);
            return req;
          },
        };
      },
      add: (record) => gated(() => store.add(record)),
      put: (record) => gated(() => store.put(record)),
      get: (key) => gated(() => store.get(key)),
      getAll: () => gated(() => store.getAll()),
    };
  }
}

/**
 * Mirrors the real IndexedDB distinction between a DATABASE (the persistent
 * record: name, version, stores/data — survives across connections) and a
 * CONNECTION (what open() returns — has its own independent open/closed
 * state; closing one connection does not affect the underlying data or any
 * OTHER connection to the same database). Earlier versions of this fake
 * conflated the two, which made connection-lifecycle tests (Required Fix 5)
 * unable to correctly distinguish "the database is at version 2" from "THIS
 * particular connection object is still usable."
 */
class FakeIDBDatabaseRecord {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
  }
}

class FakeIDBDatabase {
  constructor(record) {
    this._record = record;
    this.closed = false;
    this.onversionchange = null;
  }
  get name() { return this._record.name; }
  get version() { return this._record.version; }
  get objectStoreNames() { return { contains: (n) => this._record.stores.has(n) }; }
  createObjectStore(name, opts = {}) {
    const store = new FakeObjectStore(name, opts.keyPath);
    this._record.stores.set(name, store);
    return store;
  }
  transaction(storeNames, _mode) {
    if (this.closed) throw new Error(`FakeIDBDatabase: cannot start a transaction on a closed connection to "${this.name}"`);
    const scope = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new FakeTransaction(this._record, scope);
  }
  /** Mirrors the real IDBDatabase.close() — marks ONLY this connection closed; the underlying database record and any other open connection are unaffected. */
  close() {
    this.closed = true;
  }
}

class FakeIDBFactory {
  constructor() {
    this.records = new Map(); // name -> FakeIDBDatabaseRecord (persistent, shared across connections)
    this._hangOpenAtCall = null; // V-4 test support: { name, callNumber } -- see simulateIndefiniteBlockOnOpen()
    this._openCallCounts = new Map(); // name -> number of open() calls observed so far
  }

  /**
   * V-4 test support ONLY (not used by production code). Marks the Nth
   * (1-based, default 1) open() call for `name` to fire onblocked (if the
   * caller registered a handler) and then hang indefinitely -- never
   * firing onupgradeneeded, onsuccess, or onerror -- simulating another
   * connection/tab that never releases the database. Callers of
   * openExistingDbExtended() actually issue TWO open() calls per attempt
   * (a version-less probe via probeExistingDbVersion(), then the real
   * openRaw() call), so tests targeting openRaw()'s blocked-timeout
   * behavior specifically must target callNumber: 2. This exists
   * specifically to let existingDbExtensions.js's blocked-timeout logic
   * (V-4 remediation) be exercised deterministically without modeling
   * true multi-connection concurrency in this fake, which Phase 1 does
   * not otherwise need.
   */
  simulateIndefiniteBlockOnOpen(name, callNumber = 1) {
    this._hangOpenAtCall = { name, callNumber };
    this._openCallCounts.set(name, 0); // count callNumber relative to THIS point forward, not lifetime calls
  }

  /**
   * V-8 test support ONLY (not used by production code). Simulates a
   * genuine TOCTOU race: just before the Nth (1-based) open() call for
   * `name` proceeds, the database's on-disk version is bumped to
   * `newVersion` as if a concurrent connection had just upgraded it. If
   * that open() call's own requested version is lower than the new
   * version, it will fail with a native VersionError exactly as real
   * IndexedDB would -- letting existingDbExtensions.js's V-8 wrapping
   * logic be exercised deterministically without modeling true
   * multi-connection concurrency in this fake.
   */
  simulateConcurrentVersionBumpBeforeOpen(name, callNumber, newVersion) {
    this._bumpBeforeOpen = { name, callNumber, newVersion };
    this._openCallCounts.set(name, 0);
  }

  open(name, version) {
    const req = new FakeIDBRequest();

    const callNumber = (this._openCallCounts.get(name) || 0) + 1;
    this._openCallCounts.set(name, callNumber);

    if (this._bumpBeforeOpen && this._bumpBeforeOpen.name === name && this._bumpBeforeOpen.callNumber === callNumber) {
      const { newVersion } = this._bumpBeforeOpen;
      this._bumpBeforeOpen = null; // one-shot
      const existingRecord = this.records.get(name);
      if (existingRecord) existingRecord.version = newVersion;
    }

    if (this._hangOpenAtCall && this._hangOpenAtCall.name === name && this._hangOpenAtCall.callNumber === callNumber) {
      this._hangOpenAtCall = null; // one-shot
      queueMicrotask(() => {
        if (req.onblocked) req.onblocked({});
      });
      return req; // deliberately never resolves further
    }
    const record = this.records.get(name);
    const oldVersion = record ? record.version : 0;
    const isNewRecord = !record;

    // Faithfully models the real IndexedDB behavior the Phase 1 audit relies
    // on: requesting an explicit version LOWER than the database's current
    // on-disk version fails with a VersionError. This is what makes the
    // "legacy VersionError scenario" test meaningful rather than assumed.
    if (record && version !== undefined && version < record.version) {
      req._fail(makeVersionError(
        `The requested version (${version}) is less than the existing version (${record.version}) for database "${name}".`
      ));
      return req;
    }

    const targetVersion = version || (record ? record.version : 1);
    const rec = record || new FakeIDBDatabaseRecord(name);
    if (isNewRecord) this.records.set(name, rec);

    // Always a NEW connection object, even when reopening a database that
    // already existed — matching real IndexedDB, where close() + open()
    // yields a distinct IDBDatabase instance backed by the same data.
    const connection = new FakeIDBDatabase(rec);

    if (targetVersion > oldVersion) {
      // Snapshot store names BEFORE the upgrade handler runs, so an abort()
      // can precisely revert only what THIS upgrade attempt created.
      const storeNamesBefore = new Set(rec.stores.keys());
      let aborted = false;
      const upgradeTransaction = {
        abort() { aborted = true; },
      };

      rec.version = targetVersion;
      queueMicrotask(() => {
        if (req.onupgradeneeded) {
          req.onupgradeneeded({
            oldVersion,
            newVersion: targetVersion,
            target: { result: connection, transaction: upgradeTransaction },
          });
        }

        if (aborted) {
          // Faithful to real IndexedDB: aborting the (first) versionchange
          // transaction of a database that did not previously exist reverts
          // it to fully non-existent -- this is the exact mechanism the V-1
          // fix depends on (probeExistingDbVersion no longer leaves behind
          // an empty, unusable database as a side effect of merely checking
          // whether one exists).
          if (isNewRecord) {
            this.records.delete(name);
          } else {
            // Upgrading a PRE-EXISTING record that was aborted: revert the
            // version number and remove any stores created during this
            // specific upgrade attempt (stores that existed before are left
            // untouched).
            rec.version = oldVersion;
            for (const storeName of [...rec.stores.keys()]) {
              if (!storeNamesBefore.has(storeName)) rec.stores.delete(storeName);
            }
          }
          req._fail(makeAbortError(`The versionchange transaction for database "${name}" was aborted.`));
          return;
        }

        req._succeed(connection);
      });
    } else {
      req._succeed(connection);
    }
    return req;
  }
  deleteDatabase(name) {
    const req = new FakeIDBRequest();
    this.records.delete(name);
    req._succeed(undefined);
    return req;
  }
}

class FakeIDBKeyRange {
  static bound(lower, upper, lowerOpen = false, upperOpen = false) {
    return { lower, upper, lowerOpen, upperOpen };
  }
  static only(value) {
    return { lower: value, upper: value, lowerOpen: false, upperOpen: false };
  }
}

/**
 * Installs a fresh, isolated fake IndexedDB implementation onto
 * globalThis.indexedDB / globalThis.IDBKeyRange, for the duration of one
 * test. Returns a teardown function that restores whatever was there before
 * (undefined, in a plain Node environment).
 */
export function installFakeIndexedDB() {
  const previousIndexedDB = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  const factory = new FakeIDBFactory();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
  return {
    indexedDB: factory,
    teardown() {
      globalThis.indexedDB = previousIndexedDB;
      globalThis.IDBKeyRange = previousKeyRange;
    },
  };
}
