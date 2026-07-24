/**
 * research/src/services/bridgeToLegacyMsd/read.js
 *
 * Purpose:
 *   The READ half of the sole legacy-facing doorway (Dependency Rule 10,
 *   split per v10.1 Recommended Improvement #11: capability-separated from
 *   write.js even though both live behind one public index.js). Confines
 *   every reference to inline `window.msd*` globals (defined in index.html,
 *   documented in ENGINE_MAP.md) that the research tree needs to READ to
 *   this one file.
 *
 * Responsibilities:
 *   - Proxy a narrow, explicit whitelist of existing legacy read functions:
 *     msdGetAllEvents, msdGetAllStates, msdGetStatesByEventId,
 *     msdComputeUnifiedLifecycleStage.
 *   - Never write, mutate, or call any legacy function that has side
 *     effects — this file's every exported function is read-only by
 *     construction (it does not import or reference msdPutEvent, msdPutState,
 *     msdPromoteToProduction, etc. — those live exclusively in write.js).
 *   - Fail loudly and specifically (LegacyBridgeContractError) if a legacy
 *     symbol this module depends on is not present on the injected global,
 *     rather than silently returning undefined — a missing legacy symbol is
 *     an architecture-contract violation, not a normal empty result.
 *
 * Inputs: an injectable `legacyGlobal` (defaults to globalThis, i.e. the
 *   browser `window` that index.html's inline script attaches msd* functions
 *   to) plus whatever arguments the proxied legacy function itself expects.
 * Outputs: whatever the proxied legacy function returns, unchanged.
 * Dependencies: none beyond the injected legacy global — this module
 *   imports nothing else in research/src/, by design (Rule 10: it is itself
 *   the boundary, so it should not also depend on other research/src
 *   internals).
 *
 * Public API: getAllEvents, getAllStates, getStatesByEventId,
 *   computeUnifiedLifecycleStage — all listed above.
 * Internal API: assertLegacyFunction (guard helper), LegacyBridgeContractError.
 *
 * Error handling: throws LegacyBridgeContractError (a plain Error subclass)
 *   naming the exact missing symbol when a required legacy function is
 *   absent from the injected global — this is intentionally loud rather
 *   than defensive-default, since a missing legacy symbol here means either
 *   index.html has not loaded yet or the legacy API surface has drifted
 *   from what this bridge assumes (Rule 10's stated risk).
 * Performance notes: pure pass-through — no overhead beyond a typeof check
 *   per call.
 * Threading model: main-thread only. index.html's inline legacy engine and
 *   its `window.msd*` globals do not exist inside a Worker context — Stage 0
 *   and Stage 7's Workers never import this module.
 * Storage usage: none directly — legacy functions proxied here may
 *   themselves read from the existing mfx_msd_events/mfx_msd_states
 *   IndexedDB databases, but that is the legacy engine's concern, not this
 *   bridge's.
 * Complexity analysis: O(1) per call (a single typeof check plus a
 *   function-call passthrough).
 * Future extension notes: adding a new legacy read function to this
 *   whitelist requires adding one new proxy function following the existing
 *   pattern — never a broad "expose everything on window.msd*" shortcut,
 *   which would defeat the purpose of a narrow, auditable bridge surface.
 */

export class LegacyBridgeContractError extends Error {
  constructor(symbolName, note) {
    super(`bridgeToLegacyMsd/read: legacy symbol "${symbolName}" is not available on the injected global. ${note || ''}`.trim());
    this.name = 'LegacyBridgeContractError';
    this.symbolName = symbolName;
  }
}

function assertLegacyFunction(legacyGlobal, symbolName, note) {
  if (typeof legacyGlobal[symbolName] !== 'function') {
    throw new LegacyBridgeContractError(symbolName, note);
  }
}

/** Proxies the existing inline `msdGetAllEvents()` (ENGINE_MAP.md, MSD Core Engine). */
export function getAllEvents(legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdGetAllEvents');
  return legacyGlobal.msdGetAllEvents();
}

/** Proxies the existing inline `msdGetAllStates()`. */
export function getAllStates(legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdGetAllStates');
  return legacyGlobal.msdGetAllStates();
}

/** Proxies the existing inline `msdGetStatesByEventId(eventId)`. */
export function getStatesByEventId(eventId, legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdGetStatesByEventId');
  return legacyGlobal.msdGetStatesByEventId(eventId);
}

/**
 * Proxies the existing inline `msdComputeUnifiedLifecycleStage(flags)`
 * (documented: takes { hasGenerationRecord, hasValidMarketStateValue,
 * maturityLevel, latestAction }, returns the current Unified Lifecycle
 * stage for those flags).
 */
export function computeUnifiedLifecycleStage(flags, legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdComputeUnifiedLifecycleStage');
  return legacyGlobal.msdComputeUnifiedLifecycleStage(flags);
}
