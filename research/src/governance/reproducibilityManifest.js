/**
 * research/src/governance/reproducibilityManifest.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 3's Reproducibility Manifest
 *   requirement: "any experiment in this Laboratory's history must be
 *   exactly rerunnable, months or years later, from its permanent record
 *   alone," with a hard gate — "no experiment's results may be used in
 *   any statistical accounting... or contribute to any Lifecycle Stage
 *   transition... until its Reproducibility Manifest is complete."
 *
 * Absorbs, as a fresh implementation, the design of legacy index.html's
 *   proven dataset-snapshot freezing and experiment-manifest mechanism
 *   (`msdFreezeDatasetSnapshot`, `msdReviseDatasetSnapshot`,
 *   `msdBuildExperimentManifest`, `msdCaptureEnvironmentInfo`,
 *   `msdCompareExperimentManifests` — read directly from the real,
 *   restored repository before writing anything here, per the Repository
 *   Recovery Directive's standing rule against reconstructing from
 *   memory). This is a PORT, not a live dependency: Dependency Rule 10
 *   confines the research/src <-> legacy crossing to
 *   `services/bridgeToLegacyMsd/` and forbids importing legacy functions
 *   directly anywhere else, so the proven design (immutable freezing,
 *   fingerprint-required, parent-linked revision chains, field-by-field
 *   manifest diffing) is carried forward as new, Volume III-compliant
 *   code, not called into.
 *
 * Responsibilities:
 *   - captureEnvironmentInfo(): userAgent + capture timestamp, ported
 *     directly (already environment-agnostic — guards `typeof
 *     navigator !== 'undefined'` exactly as the legacy version does, so
 *     it behaves correctly in this Node test environment too).
 *   - freezeDatasetSnapshot(params): the exact required-field
 *     completeness check and Object.freeze pattern from
 *     `msdFreezeDatasetSnapshot`, adapted to a locally-generated id
 *     scheme (the legacy version keys off a legacy session-counter
 *     global that has no equivalent in research/src — replaced with the
 *     same random-suffix scheme already used in
 *     dataAccessLedger.js's logAccess()).
 *   - reviseDatasetSnapshot(priorSnapshot, changes): the exact
 *     parent-chain revision logic — a snapshot is never mutated; any
 *     change produces a NEW frozen snapshot pointing at the prior one.
 *   - buildExperimentManifest({...}): assembles Part 3's seven required
 *     fields (feature definitions, preprocessing pipeline, model
 *     configuration/hyperparameters, software/dependency versions,
 *     random seed(s), a unique experiment identifier, a unique dataset
 *     identifier) into one frozen manifest record, defaulting
 *     `environment` via captureEnvironmentInfo() if not supplied.
 *   - checkManifestCompleteness(manifest): a non-throwing diagnostic
 *     returning exactly which of Part 3's seven required fields are
 *     missing — designed as the natural input to
 *     complianceAudit.js's existing `context.extraChecks` extension
 *     point (already documented, since Phase 2, as accepting a
 *     Reproducibility Manifest completeness check without that file
 *     needing to change).
 *   - compareExperimentManifests(manifestA, manifestB): field-by-field
 *     diff, ported verbatim from `msdCompareExperimentManifests` — a
 *     pure, generic, already-correct algorithm with no legacy-storage
 *     coupling, safe to carry forward unchanged.
 *   - recordManifest(manifest): the concrete enforcement of Part 3's
 *     hard gate — refuses to persist (throws IncompleteManifestError)
 *     any manifest that fails checkManifestCompleteness(), then writes
 *     it via the write-once ReproducibilityManifests store, keyed by a
 *     unique experimentId. A manifest, once recorded, is never mutated.
 *   - getManifest(experimentId): read-through lookup.
 *
 * Inputs: plain objects per function (see each function's own doc
 *   comment).
 * Outputs: Promises resolving to a frozen record, a {complete,
 *   missingFields} diagnostic, or a {identical, diffs} comparison.
 * Dependencies: storage/researchGovernanceDb.js
 *   (getReproducibilityManifestsAdapter).
 *
 * Public API: REQUIRED_MANIFEST_FIELDS, InvalidManifestInputError,
 *   IncompleteManifestError, captureEnvironmentInfo,
 *   freezeDatasetSnapshot, reviseDatasetSnapshot, buildExperimentManifest,
 *   checkManifestCompleteness, compareExperimentManifests, recordManifest,
 *   getManifest, buildManifestCompletenessCheck.
 * Internal API: generateSnapshotId.
 *
 * Error handling: freezeDatasetSnapshot/buildExperimentManifest throw
 *   InvalidManifestInputError for malformed input BEFORE freezing (an
 *   incomplete or malformed record must never be frozen and mistaken for
 *   permanent). recordManifest throws IncompleteManifestError — a
 *   distinct type — specifically for Part 3's substantive completeness
 *   gate, so callers can tell "you gave me garbage" apart from "this is
 *   well-formed but Constitutionally incomplete."
 * Performance notes: recordManifest/getManifest are O(log n) write-once
 *   store operations; checkManifestCompleteness/compareExperimentManifests
 *   are O(k) in the number of manifest fields (small, fixed).
 * Threading model: main-thread only for the storage half; the pure
 *   functions (freezeDatasetSnapshot, compareExperimentManifests, etc.)
 *   are synchronous and side-effect-free.
 * Storage usage: write-once writes to the new ReproducibilityManifests
 *   store only.
 * Complexity analysis: see Performance notes above.
 * Future extension notes: Priority 1.3 (Final Core Research Pipeline
 *   Implementation) closed the previously-disclosed wiring gap --
 *   buildManifestCompletenessCheck(experimentId) is the ready-made
 *   {name, fn} object complianceAudit.js's context.extraChecks was always
 *   designed to accept (no change needed in complianceAudit.js itself).
 *   governance/researchPipeline.js includes it for every governed
 *   transition tied to a real experimentId, which is what enforces Part
 *   3's hard gate ("no experiment's results may... contribute to any
 *   Lifecycle Stage transition until its manifest is complete")
 *   automatically rather than as an opt-in per call site.
 */

import { getReproducibilityManifestsAdapter } from '../storage/researchGovernanceDb.js';

export class InvalidManifestInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidManifestInputError';
  }
}

export class IncompleteManifestError extends Error {
  constructor(message, missingFields) {
    super(message);
    this.name = 'IncompleteManifestError';
    this.missingFields = missingFields;
  }
}

// Part 3's own seven required fields, mapped to this module's field
// names. Order matches the Constitution's own bullet list.
export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'featureDefinitions',
  'preprocessingPipeline',
  'modelConfig',
  'softwareVersions',
  'randomSeeds',
  'experimentId',
  'datasetId',
]);

// Ported verbatim from legacy msdFreezeDatasetSnapshot's own required-field
// list -- the proven, working definition of "a dataset identifier
// sufficient to reconstruct it."
const REQUIRED_SNAPSHOT_FIELDS = Object.freeze([
  'sourceScope', 'symbolScope', 'timeRangeStart', 'timeRangeEnd',
  'eventDefinitionVersion', 'schemaVersion', 'searchSpaceId',
  'featureSchemaVersion', 'labelConfidencePolicy', 'datasetFingerprint',
]);

function generateSnapshotId() {
  return `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** userAgent + capture timestamp, ported directly from msdCaptureEnvironmentInfo -- already environment-agnostic. */
export function captureEnvironmentInfo() {
  return {
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : 'unknown',
    capturedAt: Date.now(),
  };
}

/**
 * Freezes a dataset snapshot record. Requires every field in
 * REQUIRED_SNAPSHOT_FIELDS (ported from msdFreezeDatasetSnapshot) --
 * refuses to proceed with any missing, since an untraceable snapshot is
 * exactly what this exists to prevent.
 */
export function freezeDatasetSnapshot(params = {}) {
  const missing = REQUIRED_SNAPSHOT_FIELDS.filter((k) => params[k] == null);
  if (missing.length > 0) {
    throw new InvalidManifestInputError(`freezeDatasetSnapshot: cannot freeze an incomplete dataset snapshot -- missing: ${missing.join(', ')}`);
  }
  return Object.freeze({
    datasetSnapshotId: params.datasetSnapshotId || generateSnapshotId(),
    parentSnapshotId: params.parentSnapshotId || null,
    creationTimestamp: Date.now(),
    ...params,
  });
}

/**
 * A snapshot never changes after creation -- any change to underlying
 * data, schema, or processing logic must produce a NEW snapshot with
 * parentSnapshotId pointing at this one, never an in-place edit. Ported
 * directly from msdReviseDatasetSnapshot.
 */
export function reviseDatasetSnapshot(priorSnapshot, changes = {}) {
  if (!priorSnapshot || !Object.isFrozen(priorSnapshot)) {
    throw new InvalidManifestInputError('reviseDatasetSnapshot: cannot revise a dataset snapshot that was never frozen');
  }
  const revised = { ...priorSnapshot, ...changes };
  delete revised.datasetSnapshotId;
  delete revised.parentSnapshotId;
  delete revised.creationTimestamp;
  return freezeDatasetSnapshot({ ...revised, parentSnapshotId: priorSnapshot.datasetSnapshotId });
}

/**
 * Assembles Part 3's seven required fields into one frozen manifest
 * record. Field names match REQUIRED_MANIFEST_FIELDS; `environment`
 * defaults via captureEnvironmentInfo() if not supplied (matching the
 * legacy manifest's own optional-with-sensible-default treatment of this
 * field).
 */
export function buildExperimentManifest({
  experimentId,
  datasetId,
  featureDefinitions,
  preprocessingPipeline,
  modelConfig,
  softwareVersions,
  randomSeeds,
  environment,
  ...extra
} = {}) {
  const candidate = { experimentId, datasetId, featureDefinitions, preprocessingPipeline, modelConfig, softwareVersions, randomSeeds };
  const missing = REQUIRED_MANIFEST_FIELDS.filter((k) => candidate[k] == null);
  if (missing.length > 0) {
    throw new InvalidManifestInputError(`buildExperimentManifest: missing required field(s): ${missing.join(', ')}`);
  }
  return Object.freeze({
    ...candidate,
    environment: environment || captureEnvironmentInfo(),
    ...extra,
    builtAt: Date.now(),
  });
}

/** Non-throwing diagnostic: which of Part 3's seven required fields (if any) are missing from `manifest`. */
export function checkManifestCompleteness(manifest) {
  const source = manifest || {};
  const missingFields = REQUIRED_MANIFEST_FIELDS.filter((k) => source[k] == null);
  return Object.freeze({ complete: missingFields.length === 0, missingFields: Object.freeze(missingFields) });
}

/**
 * Field-by-field diff between two manifests. Surfaces facts; does not
 * judge whether a given mismatch matters (ported verbatim from
 * msdCompareExperimentManifests -- a pure, generic, already-correct
 * algorithm).
 */
export function compareExperimentManifests(manifestA, manifestB) {
  const a = manifestA || {};
  const b = manifestB || {};
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const diffs = [];
  for (const k of keys) {
    const aStr = JSON.stringify(a[k]);
    const bStr = JSON.stringify(b[k]);
    if (aStr !== bStr) diffs.push({ field: k, a: a[k], b: b[k] });
  }
  return Object.freeze({ identical: diffs.length === 0, diffs: Object.freeze(diffs) });
}

/**
 * The concrete enforcement of Part 3's hard gate: refuses to persist any
 * manifest that fails checkManifestCompleteness(), then writes it
 * write-once, keyed by a unique experimentId. Idempotent-safe: a repeat
 * call for the same experimentId returns the ORIGINAL record (the
 * adapter's own write-once contract), never a silent overwrite.
 */
export async function recordManifest(manifest) {
  const { complete, missingFields } = checkManifestCompleteness(manifest);
  if (!complete) {
    throw new IncompleteManifestError(
      `recordManifest: refusing to record an incomplete Reproducibility Manifest -- missing: ${missingFields.join(', ')} (Part 3)`,
      missingFields
    );
  }
  const adapter = await getReproducibilityManifestsAdapter();
  const record = { id: `rm_${manifest.experimentId}`, ...manifest };
  return adapter.write(record); // { created, record } -- idempotent-safe per the write-once adapter's own contract
}

/** Read-through lookup for a previously recorded manifest by its unique experimentId. */
export async function getManifest(experimentId) {
  const adapter = await getReproducibilityManifestsAdapter();
  return adapter.get(`rm_${experimentId}`);
}

/**
 * Priority 1.3 wiring (Final Core Research Pipeline Implementation): the
 * ready-made {name, fn} Compliance Audit extraCheck this module's own
 * header already named as the sanctioned extension point ("wiring
 * checkManifestCompleteness() into complianceAudit.js's extraChecks
 * extension point... left as a deliberate next slice"). complianceAudit.js
 * itself requires NO change -- context.extraChecks was built for exactly
 * this. A Stage-level caller (see governance/researchPipeline.js) includes
 * this check for every governed transition tied to a real experimentId,
 * which is what makes manifest completeness "automatic" rather than
 * opt-in per call site.
 *
 * Per Part 3's hard gate ("an experiment's results may not contribute to
 * any Lifecycle Stage transition until its manifest is complete"), a
 * MISSING manifest fails the check exactly like an incomplete one --
 * there is no "not applicable yet" pass-through.
 */
export function buildManifestCompletenessCheck(experimentId) {
  return {
    name: 'reproducibility-manifest-complete',
    fn: async () => {
      if (!experimentId) {
        return { passed: false, detail: 'no experimentId supplied -- Part 3 requires a complete Reproducibility Manifest before this hypothesis may progress' };
      }
      const manifest = await getManifest(experimentId);
      if (!manifest) {
        return { passed: false, detail: `no Reproducibility Manifest recorded for experimentId "${experimentId}" (Part 3)` };
      }
      const { complete, missingFields } = checkManifestCompleteness(manifest);
      return {
        passed: complete,
        detail: complete ? null : `Reproducibility Manifest for "${experimentId}" is incomplete -- missing: ${missingFields.join(', ')} (Part 3)`,
      };
    },
  };
}
