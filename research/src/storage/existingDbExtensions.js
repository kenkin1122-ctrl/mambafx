/**
 * research/src/storage/existingDbExtensions.js
 *
 * Purpose:
 *   Implement the Section 5.1 (v10.1) resolution of the cross-database
 *   atomicity defect — PowerAnalyses, Decisions, and Lockbox live INSIDE the
 *   existing `mfx_msd_experiments` database — while ALSO resolving a
 *   verified, real compatibility defect the Phase 1 independent audit
 *   found: the existing, unmodified legacy engine (index.html:5743-5754)
 *   hardcodes `MSD_EXPERIMENT_DB_VERSION = 1` and calls
 *   `indexedDB.open('mfx_msd_experiments', 1)`. IndexedDB rejects an
 *   `open()` call with a VersionError whenever the requested version is
 *   LOWER than the database's current on-disk version. Once this module's
 *   upgrade to version 2 has run once, in ANY session, on ANY machine that
 *   shares that browser's storage, every subsequent legacy `open(name, 1)`
 *   call fails outright — breaking the existing, frozen Experiment
 *   Registry, without a single character of index.html ever being edited.
 *
 *   ROOT CAUSE (fully analyzed): IndexedDB requires a version bump to add
 *   object stores (createObjectStore is only callable inside an
 *   onupgradeneeded transaction, itself only triggered by requesting a
 *   HIGHER version than what's on disk). The legacy engine's requested
 *   version (1) is a hardcoded JS constant baked into index.html; nothing
 *   at runtime can change what version number that already-shipped code
 *   asks for. This means "add stores to mfx_msd_experiments via a version
 *   bump" and "never touch index.html" are, at the IndexedDB-API level,
 *   IN DIRECT CONFLICT unless the actual version bump is deferred until a
 *   coordinated release also updates the legacy constant — see the
 *   SOLUTIONS EVALUATED section below.
 *
 *   SOLUTIONS EVALUATED:
 *     (A) Bump the legacy MSD_EXPERIMENT_DB_VERSION constant in index.html
 *         to 2. REJECTED for Phase 1: this requires editing a Stage 1-4
 *         file, explicitly out of scope for this phase, AND has its own
 *         latent ordering hazard (if the legacy code's own open(name, 2)
 *         call is ever the FIRST to create the database fresh, its
 *         upgrade handler — which only knows how to create `Experiments`
 *         — would leave PowerAnalyses/Decisions/Lockbox never created,
 *         since IndexedDB only fires onupgradeneeded when the requested
 *         version exceeds the on-disk version, and once ANY caller sets
 *         it to 2, no further onupgradeneeded fires for other callers
 *         requesting the same version 2). This solution is NOT a single
 *         safe line — it requires release-level coordination outside
 *         Phase 1's authority. Recorded here as the eventual correct fix,
 *         to be executed as a coordinated release step alongside Phase 3.
 *     (B) Give PowerAnalyses/Decisions/Lockbox their own brand-new
 *         database instead of co-locating them in mfx_msd_experiments.
 *         REJECTED: this reverses the Section 5.1 resolution of the
 *         cross-database atomicity defect that Volume III v10.1 was
 *         specifically frozen around — it would silently reintroduce the
 *         Critical defect the freeze review already fixed once. Not an
 *         acceptable "smallest fix" because it undoes an approved,
 *         frozen architectural decision rather than correcting Phase 1's
 *         implementation of it.
 *     (C, CHOSEN) Never perform an automatic, silent version upgrade.
 *         Probe the database's CURRENT on-disk version first (via a
 *         version-less `open()`, which never triggers an upgrade and
 *         never conflicts with any other caller's requested version).
 *         If the current version already satisfies what Phase 3+ needs
 *         (>= 2 — meaning the coordinated legacy-constant release from
 *         Solution A has already happened), proceed normally. If it does
 *         NOT (still at 1, or 0 fresh) — refuse to upgrade by default,
 *         throwing a clear, actionable error naming exactly what
 *         coordinated release step (Solution A, executed deliberately,
 *         alongside a real release) must happen first. Upgrading anyway
 *         is possible ONLY via an explicit, conscious `{ allowUpgrade:
 *         true }` opt-in — never a default, never silent. This is the
 *         smallest correction that (1) touches zero index.html characters,
 *         (2) does not reverse the frozen atomicity decision, and (3)
 *         makes the previously-silent, previously-undetected failure mode
 *         impossible to trigger by accident.
 *
 *   This module therefore does NOT fully resolve the underlying tension by
 *   itself — full resolution requires the coordinated, one-line legacy
 *   constant change (Solution A) as a deliberate release step, which is
 *   explicitly outside Phase 1's mandate (no Stage 1-4 modification). What
 *   Phase 1 CAN and does guarantee is that its own code will never trigger
 *   the defect silently or automatically.
 *
 * Responsibilities:
 *   - probeExistingDbVersion(): opens mfx_msd_experiments with NO version
 *     argument (never triggers an upgrade, never races any other caller's
 *     version request), reads the current on-disk version and which
 *     stores exist, then IMMEDIATELY CLOSES that connection (never leaks
 *     it — see Fix 5 / connection lifecycle below).
 *   - openExistingDbExtended({ allowUpgrade }): the sanctioned entry point.
 *     Probes first; if the coordinated release has already happened
 *     (version already >= 2), opens and memoizes a long-lived connection
 *     normally. If not, and allowUpgrade is not explicitly true, throws
 *     LegacyVersionCoordinationRequiredError. If allowUpgrade is
 *     explicitly true, performs the versioned upgrade exactly as before
 *     (creating PowerAnalyses/Decisions/Lockbox, never touching
 *     Experiments) and memoizes the resulting connection.
 *   - Connection lifecycle (Required Fix 5): the long-lived connection is
 *     memoized (opened at most once per module lifetime/tab); an
 *     `onversionchange` handler is attached so that if any OTHER
 *     connection (e.g., a future higher-version upgrade) needs this one to
 *     step aside, it closes itself gracefully instead of silently blocking
 *     that future upgrade forever.
 *   - getPowerAnalysesAdapter() / getDecisionsAdapter() / getLockboxAdapter():
 *     Required Fix 2 — the SANCTIONED, stage-facing public interface.
 *     These are the only functions any future Stage 5/6/8 module should
 *     ever call to read or write these stores; each internally obtains the
 *     memoized connection and returns an ALREADY-ADAPTER-WRAPPED object
 *     (writeOnceAdapter, matching each store's declared unique index) —
 *     never the raw IDBDatabase. openExistingDbExtended() itself remains
 *     exported (Phase 1's own tests, and the connection-manager internals,
 *     need it), but is now clearly documented as INFRASTRUCTURE-INTERNAL,
 *     not the stage-facing API — see the module-level bypass note below.
 *
 * KNOWN, DOCUMENTED LIMITATION (Required Fix 2 — raw handle bypass):
 *   Plain ES modules provide no true encapsulation — any module that
 *   imports `openExistingDbExtended` directly still receives the raw
 *   IDBDatabase and COULD construct its own transaction, bypassing every
 *   adapter guarantee. A Proxy-based lockdown of the returned IDBDatabase
 *   was considered and REJECTED: wrapping a native, host-provided
 *   IDBDatabase in a Proxy that traps `.transaction()` is fragile across
 *   browser implementations, would also break this module's OWN internal
 *   need to call `.transaction()` when building adapters, and trades a
 *   real but modest risk for a meaningfully higher maintenance/fragility
 *   cost. The correct, honest posture — and the one implemented here — is:
 *   make the adapter-returning functions the ONLY documented, sanctioned,
 *   promoted public interface; keep the raw opener exported for
 *   infrastructure/test use only; and record this as an accepted,
 *   documented limitation rather than an oversold guarantee. See
 *   tests/phase1/rawDatabaseBypass.test.mjs, which proves (rather than
 *   merely asserts) exactly what is and is not prevented.
 *
 * Inputs: optional injectable `indexedDBFactory` (defaults to
 *   globalThis.indexedDB); `{ allowUpgrade: boolean }` on
 *   openExistingDbExtended().
 * Outputs: Promise<IDBDatabase> (raw, infrastructure-only) from
 *   openExistingDbExtended(); Promise<adapter> from the getXAdapter()
 *   functions.
 * Dependencies: core/constants.js, statistics/indexingStrategy.js,
 *   storage/adapters/writeOnceAdapter.js.
 *
 * Public API: probeExistingDbVersion, openExistingDbExtended,
 *   getPowerAnalysesAdapter, getDecisionsAdapter, getLockboxAdapter,
 *   closeExistingDbConnection (test/lifecycle teardown),
 *   LegacyVersionCoordinationRequiredError.
 * Internal API: buildUpgradeHandler (exported only for direct unit testing
 *   of the upgrade branch in isolation).
 *
 * Error handling: probeExistingDbVersion never throws for a normal,
 *   readable database; openExistingDbExtended throws
 *   LegacyVersionCoordinationRequiredError (a distinct, named error type,
 *   not a generic Error) when an upgrade is needed but not explicitly
 *   authorized. Native IDBOpenDBRequest errors propagate via Promise
 *   rejection, unchanged from Phase 1's original behavior.
 * Performance notes: the version-less probe open is O(1) (no upgrade
 *   transaction). The memoized long-lived connection means every
 *   subsequent call to openExistingDbExtended()/getXAdapter() after the
 *   first is a cheap Promise resolution against the cached connection, not
 *   a new open() call — directly resolving Required Fix 5's leaked-
 *   connection risk.
 * Threading model: main-thread only for the upgrade itself, unchanged.
 * Storage usage: owns PowerAnalyses/Decisions/Lockbox exclusively; never
 *   creates, reads, or writes the pre-existing Experiments store.
 * Complexity analysis: O(1) probe; O(1) memoized reuse; O(1) upgrade cost
 *   (unchanged from Phase 1 original).
 * Future extension notes: once the coordinated Solution-A release has
 *   shipped (legacy constant bumped to 2 alongside Phase 3), a future
 *   Phase 1.x note should update this header to record that
 *   allowUpgrade-gating is now purely defensive/legacy rather than the
 *   primary safety mechanism — but the gate itself should remain in place
 *   indefinitely as cheap insurance against a future accidental re-drift.
 */

import { DB } from '../core/constants.js';
import { applyIndexSpec } from '../statistics/indexingStrategy.js';
import { createWriteOnceAdapter } from './adapters/writeOnceAdapter.js';

export class LegacyVersionCoordinationRequiredError extends Error {
  constructor(currentVersion, targetVersion) {
    super(
      `openExistingDbExtended: "${DB.EXISTING_EXPERIMENTS.name}" is currently at version ${currentVersion}, but ` +
      `PowerAnalyses/Decisions/Lockbox require version ${targetVersion}. Upgrading automatically here is UNSAFE: ` +
      `the existing legacy engine (index.html, MSD_EXPERIMENT_DB_VERSION) still hardcodes version 1 and will throw ` +
      `a VersionError on its next open() call once this database is upgraded. Before upgrading, coordinate a release ` +
      `that ALSO bumps index.html's MSD_EXPERIMENT_DB_VERSION constant to ${targetVersion} (a single-line change, ` +
      `executed deliberately alongside this upgrade, not by this module). Once that coordinated release has shipped, ` +
      `either call openExistingDbExtended({ allowUpgrade: true }) once to perform the upgrade, or simply call it ` +
      `with no arguments after the legacy constant has already been bumped elsewhere (no further opt-in needed once ` +
      `the database is already at the target version).`
    );
    this.name = 'LegacyVersionCoordinationRequiredError';
    this.currentVersion = currentVersion;
    this.targetVersion = targetVersion;
  }
}

/**
 * V-4 REMEDIATION (verified Major defect, now fixed).
 *
 * Root cause (confirmed via code inspection): openRaw()'s onblocked
 * handler previously only invoked an optional caller-supplied callback --
 * it never rejected or resolved the surrounding Promise. If a blocking
 * connection to the same database (e.g. a stale tab, or the legacy engine
 * itself, which registers no onversionchange handler and therefore never
 * voluntarily closes) never went away, the Promise returned by
 * openExistingDbExtended()/openRaw() would hang FOREVER with no way for a
 * caller to detect or recover from the stall.
 *
 * THE FIX: openRaw() now accepts an optional `blockedTimeoutMs` (default
 * 10000ms). If the request is still blocked when the timer fires, the
 * Promise rejects with this named, distinguishable error instead of
 * hanging indefinitely. The timer is cleared on the first of
 * onsuccess/onerror to fire, so it never fires spuriously once the
 * request resolves through the normal path.
 */
export class ConnectionBlockedTimeoutError extends Error {
  constructor(dbName, timeoutMs) {
    super(
      `openRaw: opening "${dbName}" has been blocked (onblocked) by another open connection for over ${timeoutMs}ms ` +
      'without resolving. This usually means another tab/connection to the same database is holding it open and ' +
      'has not responded to an onversionchange close request (the legacy engine registers no onversionchange ' +
      'handler and will not voluntarily close). Close other tabs/connections to this database and retry.'
    );
    this.name = 'ConnectionBlockedTimeoutError';
    this.dbName = dbName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * V-8 REMEDIATION (verified Minor defect, now fixed).
 *
 * There is a real, if narrow, TOCTOU (time-of-check-to-time-of-use) window
 * between probeExistingDbVersion() reporting a version and openRaw()
 * actually opening at the version decided from that report: another
 * connection (a different tab, or a concurrent call in the same context)
 * could bump the on-disk version in between. If that happens, the raw
 * openRaw() request fails with a native VersionError whose message refers
 * only to "requested version N is less than existing version M" -- true,
 * but unhelpful out of context, since the caller never explicitly chose
 * version N; it was computed internally from a now-stale probe. This
 * wraps that specific, race-caused VersionError in a clearer, named error
 * that explains WHY it happened and what to do (retry, which will re-probe
 * against the now-current version). Any OTHER error from openRaw() is
 * re-thrown unwrapped, unchanged.
 */
export class ConcurrentVersionChangeRaceError extends Error {
  constructor(dbName, cause) {
    super(
      `openRaw: opening "${dbName}" failed with a VersionError, most likely because another connection changed ` +
      'this database\'s version concurrently, between this module\'s version probe and this open() call (a ' +
      'time-of-check-to-time-of-use race, not a caller mistake). Retrying openExistingDbExtended() will re-probe ' +
      'the now-current version and should succeed.'
    );
    this.name = 'ConcurrentVersionChangeRaceError';
    this.dbName = dbName;
    this.cause = cause;
  }
}

function getIdbFactory(opts) {
  const idb = opts.indexedDBFactory || globalThis.indexedDB;
  if (!idb) {
    throw new Error('existingDbExtensions: no IndexedDB implementation available (globalThis.indexedDB is undefined)');
  }
  return idb;
}

/**
 * Opens mfx_msd_experiments with NO explicit version and reads the current
 * on-disk version and store presence, WITHOUT ever creating the database as
 * a side effect of merely checking it.
 *
 * REMEDIATION (V-1, verified Critical defect, now fixed): the original
 * version of this function let a version-less open() on a NON-EXISTENT
 * database silently succeed, which — per the IndexedDB specification —
 * creates the database at version 1 with zero object stores. If this probe
 * ever ran before the real legacy engine's own first-ever
 * `indexedDB.open('mfx_msd_experiments', 1)` call (index.html:5754) on a
 * virgin profile, the legacy call would then see oldVersion === newVersion
 * === 1 and IndexedDB would never fire its onupgradeneeded — meaning the
 * legacy `Experiments` object store would never be created. This was
 * independently reproduced (both against this module directly and against
 * the underlying IndexedDB semantics) before this fix.
 *
 * THE FIX: this is a well-established IndexedDB idiom for checking whether
 * a database exists without creating it — abort the upgrade transaction
 * when `oldVersion === 0` (i.e., the database did not exist a moment ago).
 * Per spec, aborting the FIRST versionchange transaction of a database that
 * did not previously exist reverts it to fully non-existent: no database,
 * no version, no stores are left behind. The resulting request fails with
 * an AbortError, which this function catches and translates into the same
 * `{currentVersion: 0, ...}` result callers already expect for "does not
 * exist yet" — the public contract of probeExistingDbVersion() is
 * unchanged; only its internal mechanism no longer has the side effect.
 */
export function probeExistingDbVersion(opts = {}) {
  const idb = getIdbFactory(opts);
  const { name, newStores, preexistingStores } = DB.EXISTING_EXPERIMENTS;
  return new Promise((resolve, reject) => {
    const req = idb.open(name);
    let abortedBecauseNonExistent = false;
    req.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        // The database does not exist yet. Letting IndexedDB silently
        // commit this implicit "create at version 1, zero stores" side
        // effect is exactly the V-1 defect — abort instead, which reverts
        // the database to fully non-existent (see function header).
        abortedBecauseNonExistent = true;
        event.target.transaction.abort();
      }
      // If oldVersion > 0, IndexedDB does not invoke onupgradeneeded at all
      // for a version-less open() against an existing database (no version
      // increase is being requested) — this branch is unreachable in that
      // case. Left here only as defensive documentation of that fact.
    };
    req.onsuccess = () => {
      const db = req.result;
      const info = {
        currentVersion: db.version,
        hasExperiments: db.objectStoreNames.contains(preexistingStores.EXPERIMENTS),
        hasPowerAnalyses: db.objectStoreNames.contains(newStores.POWER_ANALYSES),
        hasDecisions: db.objectStoreNames.contains(newStores.DECISIONS),
        hasLockbox: db.objectStoreNames.contains(newStores.LOCKBOX),
      };
      db.close();
      resolve(info);
    };
    req.onerror = (event) => {
      if (abortedBecauseNonExistent) {
        // Expected outcome of the abort-based existence check, NOT a real
        // error — the database genuinely does not exist. Suppress default
        // error propagation/console noise and report the same shape callers
        // already handle for "nothing exists yet."
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        resolve({ currentVersion: 0, hasExperiments: false, hasPowerAnalyses: false, hasDecisions: false, hasLockbox: false });
        return;
      }
      reject(req.error);
    };
  });
}

export function buildUpgradeHandler() {
  return function onupgradeneeded(event) {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    const { newStores, preexistingStores } = DB.EXISTING_EXPERIMENTS;

    if (oldVersion < 2) {
      void preexistingStores; // documentation-only reference; never created/altered here

      if (!db.objectStoreNames.contains(newStores.POWER_ANALYSES)) {
        const store = db.createObjectStore(newStores.POWER_ANALYSES, { keyPath: 'id' });
        applyIndexSpec(store, 'PowerAnalyses');
      }
      if (!db.objectStoreNames.contains(newStores.DECISIONS)) {
        const store = db.createObjectStore(newStores.DECISIONS, { keyPath: 'id' });
        applyIndexSpec(store, 'Decisions');
      }
      if (!db.objectStoreNames.contains(newStores.LOCKBOX)) {
        const store = db.createObjectStore(newStores.LOCKBOX, { keyPath: 'id' });
        applyIndexSpec(store, 'Lockbox');
      }
    }
  };
}

// ── Connection lifecycle (Required Fix 5): memoized singleton ──────────────
let cachedConnectionPromise = null;

// F-1 FIX (Phase 1 Final Freeze Challenge, Finding F-1, Major):
// openExistingDbExtended() previously read the closure-captured `opts`
// belonging to whichever caller's invocation happened to reach a cold
// cache first, and used THAT caller's allowUpgrade value to decide the
// outcome for every OTHER concurrent caller sharing the same in-flight
// connection attempt -- even ones with an explicitly different
// allowUpgrade of their own. This silently overrode a caller's own
// explicit authorization decision based purely on call order.
//
// Fix: a shared, mutable, OR-accumulated flag (see openExistingDbExtended
// below). Reset to false only after the current attempt fully settles.
let pendingAllowUpgrade = false;

function openRaw(idb, version, opts) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(opts.blockedTimeoutMs) ? opts.blockedTimeoutMs : 10000;
    let settled = false;
    let timeoutHandle = null;

    const clearBlockedTimeout = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const req = idb.open(DB.EXISTING_EXPERIMENTS.name, version);
    req.onupgradeneeded = buildUpgradeHandler();
    req.onsuccess = () => {
      if (settled) {
        // Already rejected via the blocked timeout, but the blocking
        // connection has since gone away and this request succeeded late.
        // Close the now-unreferenced connection immediately rather than
        // leaking an open IDBDatabase handle nobody holds.
        try { req.result.close(); } catch { /* already closed/unusable — ignore */ }
        return;
      }
      settled = true;
      clearBlockedTimeout();
      const db = req.result;
      // If another connection (e.g. a future higher-version upgrade)
      // requests a version change, close gracefully instead of blocking it
      // indefinitely — directly addresses the audit's "blocked forever"
      // risk noted alongside Finding 5.
      db.onversionchange = () => {
        db.close();
        cachedConnectionPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearBlockedTimeout();
      // V-8 REMEDIATION: a VersionError here (as opposed to one caught
      // synchronously by probeExistingDbVersion()) can only be caused by a
      // TOCTOU race against this module's own probe -> decide -> open
      // sequence, since every openRaw() call already passes either
      // `undefined` (current version) or the exact target version compiled
      // from constants.js -- never an arbitrary/stale caller-supplied
      // value. Wrap it for clarity; anything else passes through unchanged.
      if (req.error && req.error.name === 'VersionError') {
        reject(new ConcurrentVersionChangeRaceError(DB.EXISTING_EXPERIMENTS.name, req.error));
        return;
      }
      reject(req.error);
    };
    req.onblocked = () => {
      if (typeof opts.onBlocked === 'function') opts.onBlocked();
      // V-4 REMEDIATION: start (or restart) a timeout the first time we
      // observe a blocked state. If the request is still unresolved when
      // it fires, reject with a clear, named error instead of hanging
      // forever. `timeoutMs <= 0` disables the timeout entirely (opt-out
      // for callers/tests that intentionally want to wait unboundedly).
      if (timeoutMs > 0 && timeoutHandle === null) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new ConnectionBlockedTimeoutError(DB.EXISTING_EXPERIMENTS.name, timeoutMs));
        }, timeoutMs);
      }
    };
  });
}

/**
 * The sanctioned entry point for obtaining the (raw, infrastructure-only —
 * see module header) connection. Memoized: the first successful call opens
 * and caches the connection; every subsequent call reuses it.
 *
 * @param {{ allowUpgrade?: boolean, indexedDBFactory?: IDBFactory, onBlocked?: () => void }} [opts]
 */
export function openExistingDbExtended(opts = {}) {
  // F-1 fix: contribute this caller's own allowUpgrade to the shared,
  // OR-accumulated flag BEFORE checking/joining the cache -- covers both
  // "joining an in-flight attempt" and "starting a fresh attempt" with
  // one line, since pendingAllowUpgrade is guaranteed false at the start
  // of any fresh attempt (reset once the attempt settles, below).
  if (opts.allowUpgrade) pendingAllowUpgrade = true;

  if (cachedConnectionPromise) return cachedConnectionPromise;

  const idb = getIdbFactory(opts);
  const targetVersion = DB.EXISTING_EXPERIMENTS.version;

  cachedConnectionPromise = probeExistingDbVersion(opts).then((info) => {
    if (info.currentVersion >= targetVersion) {
      // Coordinated release has already happened (or this is a fresh test
      // database) — safe to open at the current/target version, no
      // further upgrade will fire.
      return openRaw(idb, undefined, opts);
    }
    // F-1 fix: decide from the shared, OR-accumulated flag -- not this
    // call's own closure-captured opts -- so every caller sharing this
    // in-flight attempt converges on the same outcome, and the upgrade
    // proceeds if ANY of them explicitly authorized it.
    if (!pendingAllowUpgrade) {
      throw new LegacyVersionCoordinationRequiredError(info.currentVersion, targetVersion);
    }
    return openRaw(idb, targetVersion, opts);
  });

  // If opening fails/refuses, don't poison future calls with a rejected cache.
  cachedConnectionPromise.catch(() => { cachedConnectionPromise = null; });
  // F-1 fix: once this attempt fully settles (resolve or reject), reset
  // the shared flag so it cannot leak into a later, unrelated fresh
  // attempt. Attached after the cache-clear catch above so both side
  // effects are visible, in order, before any caller's own `await`
  // continuation resumes (same ordering guarantee the cache-clear catch
  // above already relies on).
  cachedConnectionPromise.then(
    () => { pendingAllowUpgrade = false; },
    () => { pendingAllowUpgrade = false; }
  );

  return cachedConnectionPromise;
}

/** Test/lifecycle teardown: closes the memoized connection (if any) and clears the cache. */
export async function closeExistingDbConnection() {
  if (!cachedConnectionPromise) return;
  try {
    const db = await cachedConnectionPromise;
    db.close();
  } catch {
    // already failed/never opened — nothing to close
  } finally {
    cachedConnectionPromise = null;
  }
}

// ── Sanctioned, stage-facing adapters (Required Fix 2) ──────────────────────
// These are the ONLY functions Stage 5/6/8 modules should call. Each returns
// an already-wrapped adapter, never the raw IDBDatabase.

// V-3 REMEDIATION: each factory still eagerly calls openExistingDbExtended()
// once up front (preserving the existing "throws immediately if legacy
// coordination is required" behavior every caller already depends on), but
// the adapter itself is constructed with a `getDb` THUNK -- not the
// resolved db -- so every individual operation the returned adapter later
// performs re-resolves the CURRENT connection via the same memoized
// openExistingDbExtended() cache. If the connection is closed in the
// meantime (closeExistingDbConnection(), or a native onversionchange
// auto-close), the memoized cache is cleared as a side effect (see
// openRaw()/closeExistingDbConnection() above), so the very next operation
// on an already-obtained adapter transparently re-opens instead of being
// permanently stuck against a dead handle.
export async function getPowerAnalysesAdapter(opts = {}) {
  await openExistingDbExtended(opts);
  return createWriteOnceAdapter({
    getDb: () => openExistingDbExtended(opts),
    storeName: DB.EXISTING_EXPERIMENTS.newStores.POWER_ANALYSES,
    uniqueIndexName: 'by_discoveryResult_engineVersion',
    uniqueKeyFn: (r) => [r.discoveryResultId, r.engineVersion],
  });
}

export async function getDecisionsAdapter(opts = {}) {
  await openExistingDbExtended(opts);
  return createWriteOnceAdapter({
    getDb: () => openExistingDbExtended(opts),
    storeName: DB.EXISTING_EXPERIMENTS.newStores.DECISIONS,
    uniqueIndexName: 'by_discoveryResult_inputHash',
    uniqueKeyFn: (r) => [r.discoveryResultId, r.decisionInputHash],
  });
}

export async function getLockboxAdapter(opts = {}) {
  await openExistingDbExtended(opts);
  return createWriteOnceAdapter({
    getDb: () => openExistingDbExtended(opts),
    storeName: DB.EXISTING_EXPERIMENTS.newStores.LOCKBOX,
    uniqueIndexName: 'by_featureKey_generation',
    uniqueKeyFn: (r) => [r.featureKey, r.generation],
    guardField: 'consumedAt',
    guardUnsetValue: null,
  });
}

/** Test-only: reset the memoized connection cache between test cases without closing a real connection. */
export function _resetConnectionCacheForTesting() {
  cachedConnectionPromise = null;
}
