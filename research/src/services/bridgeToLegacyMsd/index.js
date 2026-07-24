/**
 * research/src/services/bridgeToLegacyMsd/index.js
 *
 * Purpose:
 *   The SOLE public re-export surface for the legacy-facing bridge
 *   (Dependency Rule 10). Every other module in research/src/ — including
 *   stage8-lifecycle once it exists (Phase 6) — must import from THIS file,
 *   never with a deep import path into read.js or write.js directly. This
 *   is what keeps the "only Stage 8 may write" rule checkable by a simple
 *   grep during code review (Section 9, v10.1): any `import ... from
 *   '.../bridgeToLegacyMsd/write.js'` outside stage8-lifecycle is a
 *   visible, greppable violation.
 *
 * Responsibilities:
 *   - Re-export the full read.js surface (any stage may import these).
 *   - Re-export the full write.js surface (documented as
 *     stage8-lifecycle-only by convention + the ArchitectureComplianceChecklist,
 *     since the zero-build-step environment cannot mechanically restrict
 *     imports by caller).
 *
 * Inputs/Outputs/Dependencies: pure re-export, no logic of its own.
 *
 * Public API: everything named below.
 * Internal API: none.
 *
 * Error handling: inherited from read.js/write.js.
 * Performance notes: zero overhead (re-export only).
 * Threading model: main-thread only (inherited).
 * Storage usage: none directly (inherited).
 * Complexity analysis: O(1).
 * Future extension notes: if read.js/write.js ever need a third
 *   capability tier (e.g., a narrowly-scoped "admin" tier), add it as
 *   admin.js alongside read.js/write.js and re-export it here too — the
 *   discipline is "one file per capability tier, one shared public
 *   re-export," not "one file per legacy function."
 */

export * from './read.js';
export * from './write.js';
