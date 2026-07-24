/**
 * research/src/services/bridgeToLegacyMsd/write.js
 *
 * Purpose:
 *   The WRITE half of the sole legacy-facing doorway. This is the ONLY file
 *   in the entire research/src tree permitted to mutate legacy state
 *   (Dependency Rule 9: only Stage 8 extends the legacy Unified Lifecycle;
 *   Rule 10: confined to one file). Only stage8-lifecycle (Phase 6) may
 *   import from this file — no other stage has a documented reason to.
 *
 * Responsibilities:
 *   - Proxy the existing legacy governance functions: msdPromoteToProduction,
 *     msdDeprecateFeature, msdArchiveFeature.
 *   - Proxy TWO NEW legacy functions required by v10.0/v10.1 Stage 8
 *     (Section 3.5): msdSuspendFeature and msdLockboxRevalidate. These do
 *     NOT exist in index.html yet — they are added to the legacy inline
 *     engine as part of Phase 6 (Stage 8 implementation), following the
 *     existing msd* naming/API convention, per the frozen v10.0 architecture
 *     ("add msdSuspendFeature and msdLockboxRevalidate alongside them").
 *     This module defines the CALLING CONTRACT now (Phase 1); the functions
 *     themselves must be added to index.html before Phase 6 wires stage8's
 *     write path to call them for real. Calling suspendFeature()/
 *     lockboxRevalidate() before that lands throws the same
 *     LegacyBridgeContractError as any other missing legacy symbol — this
 *     is intentional: it makes the Phase 1→Phase 6 dependency an explicit,
 *     loud runtime contract rather than an implicit assumption.
 *
 * Inputs: an injectable `legacyGlobal` (defaults to globalThis) plus
 *   whatever arguments the proxied legacy function expects.
 * Outputs: whatever the proxied legacy function returns.
 * Dependencies: none beyond the injected legacy global (same isolation
 *   discipline as read.js).
 *
 * Public API: promoteToProduction, deprecateFeature, archiveFeature,
 *   suspendFeature, lockboxRevalidate.
 * Internal API: none (reuses read.js's LegacyBridgeContractError/assert
 *   helper via its own local copy, kept independent so read.js and write.js
 *   have zero import coupling to each other — only index.js depends on
 *   both).
 *
 * Error handling: same LegacyBridgeContractError pattern as read.js.
 * Performance notes: pure pass-through.
 * Threading model: main-thread only.
 * Storage usage: none directly — the proxied legacy functions write to the
 *   existing Unified Lifecycle ledger themselves.
 * Complexity analysis: O(1) per call.
 * Future extension notes: if a future stage other than Stage 8 is ever
 *   found to need a legitimate legacy write, that is itself a v10.x
 *   architecture amendment (a new Rule 9 exception) — not something to
 *   route around by importing this file from elsewhere without updating
 *   Volume III first.
 */

class LegacyBridgeContractError extends Error {
  constructor(symbolName, note) {
    super(`bridgeToLegacyMsd/write: legacy symbol "${symbolName}" is not available on the injected global. ${note || ''}`.trim());
    this.name = 'LegacyBridgeContractError';
    this.symbolName = symbolName;
  }
}

function assertLegacyFunction(legacyGlobal, symbolName, note) {
  if (typeof legacyGlobal[symbolName] !== 'function') {
    throw new LegacyBridgeContractError(symbolName, note);
  }
}

/** Proxies the existing inline `msdPromoteToProduction(...)` (Unified Lifecycle governance action). */
export function promoteToProduction(args, legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdPromoteToProduction');
  return legacyGlobal.msdPromoteToProduction(args);
}

/** Proxies the existing inline `msdDeprecateFeature(featureKey, reason)`. */
export function deprecateFeature(featureKey, reason, legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdDeprecateFeature');
  return legacyGlobal.msdDeprecateFeature(featureKey, reason);
}

/** Proxies the existing inline `msdArchiveFeature(featureKey, reason)`. */
export function archiveFeature(featureKey, reason, legacyGlobal = globalThis) {
  assertLegacyFunction(legacyGlobal, 'msdArchiveFeature');
  return legacyGlobal.msdArchiveFeature(featureKey, reason);
}

/**
 * Proxies `msdSuspendFeature(featureKey, reason)` — NEW legacy function,
 * added to index.html in Phase 6 (Stage 8). See module header.
 */
export function suspendFeature(featureKey, reason, legacyGlobal = globalThis) {
  assertLegacyFunction(
    legacyGlobal,
    'msdSuspendFeature',
    'This function is introduced in Phase 6 (Stage 8 implementation) — see Volume III v10.0 Section 3.5.'
  );
  return legacyGlobal.msdSuspendFeature(featureKey, reason);
}

/**
 * Proxies `msdLockboxRevalidate(featureKey)` — NEW legacy function, added to
 * index.html in Phase 6 (Stage 8). See module header.
 */
export function lockboxRevalidate(featureKey, legacyGlobal = globalThis) {
  assertLegacyFunction(
    legacyGlobal,
    'msdLockboxRevalidate',
    'This function is introduced in Phase 6 (Stage 8 implementation) — see Volume III v10.0 Section 3.5.'
  );
  return legacyGlobal.msdLockboxRevalidate(featureKey);
}
