/**
 * research/src/core/constants.js
 *
 * Purpose:
 *   Single source of truth for every version tag, database/store name, and
 *   tunable threshold used across the research/src tree (Volume III v10.1).
 *   No stage module may hardcode a version string, database name, or
 *   threshold value inline — everything referenceable here must be imported
 *   from here, so a future amendment changes one file, not N call sites.
 *
 * Responsibilities:
 *   - Define API_VERSION per stage (Section 7, v10.1) — independent of the
 *     data-schema version constants below.
 *   - Define data-schema version tags per store (rnd_audit_v1, pwr_v1, etc.).
 *   - Define IndexedDB database/store names, matching the v10.1 Section 5.1
 *     placement decision exactly (PowerAnalyses/Decisions/Lockbox live in the
 *     EXISTING mfx_msd_experiments database; RandomnessAudits/DriftEvents in
 *     the NEW mfx_research_monitoring database; MetaSnapshots in the NEW
 *     mfx_research_meta database).
 *   - Define cross-cutting thresholds (target power, drift hysteresis window
 *     count, storage-quota warning ratio, reconciliation interval).
 *
 * Inputs: none (pure constant definitions).
 * Outputs: frozen constant objects/values, imported by every other module.
 * Dependencies: none.
 *
 * Public API: every named export below.
 * Internal API: none.
 *
 * Error handling: N/A — no runtime behavior, only data.
 * Performance notes: negligible; module-load-time only.
 * Threading model: N/A — pure data, safe to import from a Worker or the
 *   main thread interchangeably.
 * Storage usage: N/A (defines names used by storage modules; owns no data).
 * Complexity analysis: O(1) — static object literals.
 * Future extension notes: adding a new stage's API_VERSION or a new store's
 *   schema-version tag is additive — append a new key, never repurpose an
 *   existing one (per the additive-only discipline of Volume III).
 */

// ── Stage public-API versions (Section 7, v10.1) ───────────────────────────
// Independent of data-schema versions below. Bump the relevant key only when
// that stage's PUBLIC function surface changes in a breaking way; additive
// changes (new optional params, new methods) do not require a bump.
export const API_VERSIONS = Object.freeze({
  stage0: 'v1',
  stage1: 'v1', // existing, unchanged — recorded here for completeness only
  stage2: 'v1', // existing, unchanged
  stage3: 'v1', // existing, unchanged
  stage4: 'v1', // existing, unchanged
  stage5: 'v1',
  stage6: 'v1',
  stage7: 'v1',
  stage8: 'v1',
  stage9: 'v1',
});

// ── Data-schema version tags (stored on every row, per store) ─────────────
export const SCHEMA_VERSIONS = Object.freeze({
  RND_AUDIT_VERSION: 'rnd_audit_v1',
  PWR_ENGINE_VERSION: 'pwr_v1',
  DEC_ENGINE_VERSION: 'dec_v1',
  DRIFT_ENGINE_VERSION: 'drift_v1',
  LIFECYCLE_EXTENSION_VERSION: 'lifecycle_ext_v1', // Suspend/Lockbox states added to existing enum
  META_ENGINE_VERSION: 'meta_v1',
  LOCKBOX_VERSION: 'lockbox_v1',
  GOVERNANCE_VERSION: 'governance_v1', // Volume IV v3.0 Hypothesis Registry / Lifecycle / Data Access Ledger / Compliance Audit
});

// ── Database placement (Section 5.1, v10.1 — resolves the cross-database
//    atomicity defect) ──────────────────────────────────────────────────────
//
// Rule applied: stores that participate in a read-then-write transaction
// with an EXISTING legacy store are migrated INTO that existing database via
// a versioned upgrade. Stores that only ever append independently (no atomic
// pairing requirement with a legacy store) live in new, dedicated databases.
export const DB = Object.freeze({
  // EXISTING database (mfx_msd_experiments) — version bumped from 1 to 2 to
  // add three new object stores. The existing 'Experiments' store, its
  // keyPath, and its data are untouched by this upgrade (see
  // existingDbExtensions.js for the exact onupgradeneeded contract).
  EXISTING_EXPERIMENTS: Object.freeze({
    name: 'mfx_msd_experiments',
    version: 2, // was 1 in the pre-v10.1 schema
    newStores: Object.freeze({
      POWER_ANALYSES: 'PowerAnalyses',
      DECISIONS: 'Decisions',
      LOCKBOX: 'Lockbox',
    }),
    preexistingStores: Object.freeze({
      EXPERIMENTS: 'Experiments', // untouched, documented for reference only
    }),
  }),

  // NEW database — Stage 0 + Stage 7 continuous-append output. Grouped
  // together because both are independent, continuous-monitoring outputs
  // with the same growth/retention characteristics (Section 5.1 table).
  RESEARCH_MONITORING: Object.freeze({
    name: 'mfx_research_monitoring',
    version: 1,
    stores: Object.freeze({
      RANDOMNESS_AUDITS: 'RandomnessAudits',
      DRIFT_EVENTS: 'DriftEvents',
    }),
  }),

  // NEW database — Stage 9's pure read-side rollup. Never paired with a
  // write elsewhere, so it does not need to share a connection with any
  // other store.
  RESEARCH_META: Object.freeze({
    name: 'mfx_research_meta',
    version: 1,
    stores: Object.freeze({
      META_SNAPSHOTS: 'MetaSnapshots',
    }),
  }),

  // NEW database — Phase 2 governance layer (Volume IV v3.0). Four
  // append-only stores implementing the Hypothesis Registry (Part 3), the
  // Lifecycle Stage transition log (Part 2), the Data Access Ledger
  // (Part 7), and the Compliance Audit failure/pass log (Part 2's
  // Automatic Constitutional Compliance Audit). Kept in its own database,
  // never paired atomically with mfx_msd_experiments or the monitoring/meta
  // databases, so it follows the same "brand-new name, unconditionally safe
  // versioned upgrade" reasoning as RESEARCH_MONITORING/RESEARCH_META above.
  // Version bumped 1 -> 2 (Phase 3, Part 6): additive-only -- the four
  // original stores are untouched; ScientificQuestions is a new store added
  // in a new onupgradeneeded branch (see researchGovernanceDb.js), per the
  // "append a new key, never repurpose an existing one" discipline.
  // Version bumped 2 -> 3 (Phase 4, Part 9): additive-only -- FamilyWealthLedger
  // is a new append-only store implementing the Family-Level Online FDR
  // wealth process (alpha-investing). No existing store touched.
  // Version bumped 3 -> 4 (Phase 4, Part 14/16): additive-only --
  // CalibrationCanaryRuns is a new append-only store recording each
  // Empirical FDR Calibration Canary computation (empiricalFdrCanary.js).
  // No existing store touched.
  // Version bumped 4 -> 5 (Phase 4, Part 12): additive-only --
  // PublicationStatusTransitions is a new append-only store implementing
  // Part 12's Publication Status state machine (publicationStatus.js),
  // structurally identical to LifecycleTransitions but tracking the
  // SEPARATE "what is the Laboratory's current scientific verdict" axis
  // (Part 2's own distinction), not Lifecycle Stage. No existing store
  // touched.
  // Version bumped 5 -> 6 (Phase 4, Part 3): additive-only --
  // ReproducibilityManifests is a new write-once store implementing Part
  // 3's Reproducibility Manifest requirement (reproducibilityManifest.js),
  // absorbing the design of legacy index.html's proven
  // msdFreezeDatasetSnapshot/msdBuildExperimentManifest mechanism as a
  // fresh, Volume III-compliant implementation (Dependency Rule 10
  // forbids importing legacy functions directly outside
  // bridgeToLegacyMsd/ -- this is a reimplementation carrying the same
  // tested design forward, not a live runtime dependency on legacy code).
  // No existing store touched.
  // Version bumped 6 -> 7 (Phase 4, Layer 9 / Section 3): additive-only --
  // KnowledgeGraphNodes (write-once, one row per distinct entity the graph
  // tracks) and KnowledgeGraphEdges (append-only, one row per asserted
  // relationship) are new stores implementing the Scientific Knowledge
  // Graph (knowledgeGraph.js), the final Tier 4 roadmap item. Absorbs the
  // DESIGN of legacy index.html's DiscoveryLab/EngineeringLab taxonomy
  // chain (Behaviour -> Hypothesis -> Candidate Measurement -> Feature
  // Ontology, msdRegisterBehavior/msdRegisterHypothesis/
  // msdRegisterCandidateMeasurement/msdRegisterFeatureOntology and the
  // msdGetKnowledgeGraphForBehavior traversal it fed) as a fresh,
  // Volume III-compliant reimplementation -- Dependency Rule 10 forbids
  // importing legacy functions directly outside bridgeToLegacyMsd/, so
  // this carries the same proven relational structure forward without a
  // live runtime dependency on legacy code, and links its Hypothesis
  // nodes to THIS codebase's own already-governed HypothesisRegistry
  // (Phase 2) rather than recreating legacy's separate, duplicate-
  // authority hypothesis_registration record type. No existing store
  // touched.
  // Version bumped 7 -> 8 (Final Core Research Pipeline Implementation,
  // Priority 3): additive-only -- RandomnessAuditResults is a new
  // append-only store implementing the Randomness Audit
  // (governance/randomnessAudit.js), the final missing scientific
  // subsystem. No existing store touched.
  RESEARCH_GOVERNANCE: Object.freeze({
    name: 'mfx_research_governance',
    version: 8,
    stores: Object.freeze({
      HYPOTHESIS_REGISTRY: 'HypothesisRegistry',
      LIFECYCLE_TRANSITIONS: 'LifecycleTransitions',
      DATA_ACCESS_LEDGER: 'DataAccessLedger',
      COMPLIANCE_AUDIT_LOG: 'ComplianceAuditLog',
      SCIENTIFIC_QUESTIONS: 'ScientificQuestions',
      FAMILY_WEALTH_LEDGER: 'FamilyWealthLedger',
      CALIBRATION_CANARY_RUNS: 'CalibrationCanaryRuns',
      PUBLICATION_STATUS_TRANSITIONS: 'PublicationStatusTransitions',
      REPRODUCIBILITY_MANIFESTS: 'ReproducibilityManifests',
      KNOWLEDGE_GRAPH_NODES: 'KnowledgeGraphNodes',
      KNOWLEDGE_GRAPH_EDGES: 'KnowledgeGraphEdges',
      RANDOMNESS_AUDIT_RESULTS: 'RandomnessAuditResults',
    }),
  }),
});

// ── Thresholds & tunables ───────────────────────────────────────────────────
export const THRESHOLDS = Object.freeze({
  ALPHA_DEFAULT: 0.05,
  TARGET_POWER: 0.80,                 // 1 - β, per the Power Decision Protocol
  DRIFT_HYSTERESIS_WINDOWS: 5,        // Stage 7: consecutive windows required before publishing DriftDetected
  STORAGE_QUOTA_WARNING_RATIO: 0.80,  // Section 5.2: usage/quota warning threshold
  RECONCILIATION_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes — periodic reconciliationRunner sweep
  META_SNAPSHOT_INTERVAL_MS: 24 * 60 * 60 * 1000, // daily scheduled Stage 9 snapshot
});

// ── Volume IV v3.0 governance thresholds (policy-fixed per Constitution
//    Principle 12 — "no hidden flexibility after Registration"; every value
//    below is the Laboratory-wide default and may only be overridden by a
//    logged Scientific Oversight decision, never by a registering
//    researcher — see research/src/governance/hypothesisRegistry.js) ──────
export const GOVERNANCE = Object.freeze({
  // Part 4: default max generations per lineage absent an Oversight-approved
  // non-default N_max.
  DEFAULT_N_MAX: 5,
  // Part 12/16: minimum achieved statistical power (1-β) below which a
  // Discovery/Replication test is *eligible* for Indeterminate
  // classification (still requires drift confirmation + Oversight approval
  // on top of this — see hypothesisRegistry.js classifyIndeterminate()).
  MIN_STATISTICAL_POWER: 0.80,
  // Part 13/16: minimum decorrelation gap (in ticks) required between
  // chronological Replication blocks before they may be treated as
  // independent for aggregation purposes, per Family/Target-Definition
  // class default (Scientific-Oversight-overridable per class).
  DEFAULT_REPLICATION_DECORRELATION_GAP_TICKS: 500,
  // Part 13/16: Strong Evidence tolerance-band multiplier z, per
  // Family/Target-Definition class default.
  DEFAULT_TOLERANCE_BAND_Z: 2,
  // Part 12: minimum replication blocks required for Moderate Evidence.
  MIN_REPLICATION_BLOCKS: 3,
  // Part 6: Laboratory-wide default Target Definition tolerance band for the
  // 5-consecutive-tick Rise target (percentage points of the canonical
  // tick-count threshold that count as the "same" Family) — Scientific
  // Question / Family-specific overrides require Oversight approval.
  DEFAULT_TARGET_DEFINITION_TOLERANCE: 0.0,

  // Part 9/16: Family-Level Online FDR wealth process (generalized
  // alpha-investing, Foster & Stine 2008 / Aharoni & Rosset 2014). Each
  // Family starts with this much "wealth" (a fraction of the Laboratory's
  // per-Family alpha budget) — see onlineFdr.js.
  ONLINE_FDR_INITIAL_WEALTH: 0.025,
  // Fraction of CURRENT wealth invested (bid) as the significance
  // threshold for the next test in a Family. Never bids more than the
  // wealth actually available, so cumulative alpha spend is bounded by
  // construction, independent of how many tests are ever run.
  ONLINE_FDR_INVESTMENT_FRACTION: 0.5,
  // Bonus added to a Family's wealth on a genuine rejection (a Discovery
  // that clears its bid), rewarding real discoveries with more future
  // testing budget while every non-rejection strictly depletes wealth.
  ONLINE_FDR_REJECTION_BONUS: 0.025,

  // Part 14/16: Empirical FDR Calibration Canary. EDR_F(T) = #{Supported
  // AND Replicated} / #{Supported}, compared against the online
  // procedure's implied 1 - alpha_F (alpha_F = ONLINE_FDR_INITIAL_WEALTH,
  // the Family's wealth-process guarantee bound). "Persistent, material
  // divergence" (Part 14) is not itself formally defined by the
  // Constitution -- these three constants are this module's own disclosed,
  // policy-fixed operational definition, Scientific-Oversight-overridable
  // per Family like every other threshold in this section, never silently
  // hardcoded per-call.
  //
  // Minimum number of Supported hypotheses before an EDR reading is
  // considered a meaningful calibration signal at all (an EDR computed
  // from 1-2 Supported hypotheses is too noisy to act on -- the same
  // "don't conclude from an underpowered sample" discipline Part 12's
  // Indeterminate concept applies elsewhere).
  EMPIRICAL_FDR_CANARY_MIN_SUPPORTED_FOR_SIGNAL: 5,
  // A run's |EDR - impliedTarget| beyond this margin (percentage points,
  // expressed as a fraction) is flagged "material" for that single run.
  EMPIRICAL_FDR_CANARY_MATERIAL_DIVERGENCE_TOLERANCE: 0.10,
  // Number of most-recent, sufficiently-sampled runs that must ALL be
  // materially divergent (same below-target direction) before the canary
  // flags "persistent" divergence requiring mandatory Scientific Oversight
  // review (Part 14). A single divergent run is disclosed but not itself
  // an escalation -- only a sustained pattern is.
  EMPIRICAL_FDR_CANARY_MIN_CONSECUTIVE_RUNS_FOR_PERSISTENCE: 3,

  // Feature Importance Stability Index (Final Laboratory Architecture v1.0
  // Section 11 -- a Meta-Science metric identified in architecture review
  // as a genuinely discovery-relevant addition beyond Volume IV's own
  // Part 14 metric list, not itself given a formal equation by either
  // document. This module's own disclosed operational definition mirrors
  // Part 16's already-Constitutional Multiverse Stability Ratio (a
  // fraction of observations preserving sign, anchored on a caller-
  // supplied reference -- typically the Lockbox estimate, per Part 11's
  // "the mandatory reported effect size" rule), extended with a magnitude-
  // tolerance band. Policy-fixed default, Scientific-Oversight-overridable
  // per Family/feature class like every other threshold in this section.
  FEATURE_STABILITY_MAGNITUDE_TOLERANCE_RATIO: 0.5,

  // Part 14 (Meta-Science): "hypotheses sitting in Provisionally
  // Supported, Replicated, or Deprecated status longer than a
  // policy-defined maximum dwell time without progressing" accrue
  // Scientific Debt. The Constitution names the concept but leaves the
  // dwell-time threshold itself policy-fixed, undefined numerically --
  // this default (30 days), like every other threshold in this section,
  // is Scientific-Oversight-overridable per Family, never silently
  // hardcoded per call.
  SCIENTIFIC_DEBT_MAX_DWELL_MS: 30 * 24 * 60 * 60 * 1000,
});

// ── EventBus namespace prefix (Section 5.5 — independent bus, namespaced
//    event names as a second layer of protection against accidental
//    cross-subscription with the mtf/ chart tree) ─────────────────────────
export const EVENT_NAMESPACE = 'research';

/** Prefix a bare event name with the research namespace, e.g. 'PowerComputed' -> 'research.PowerComputed'. */
export function namespacedEvent(name) {
  return `${EVENT_NAMESPACE}.${name}`;
}
