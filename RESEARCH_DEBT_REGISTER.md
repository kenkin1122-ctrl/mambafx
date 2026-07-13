# MambaFX — Research Debt Register

*Permanent, append-only in spirit: entries get a Resolved date, not a deletion, once fixed — consistent with how everything else in this codebase treats its own history.*

Each entry: ID, description, location, severity, status, recommendation.

---

**R-001 — UI text overstates analyzer count**
Location: Statistical Research Workbench panel copy (`index.html`, near the Discovery Repository header).
Description: The panel text reads "Five analyzers are currently registered" but names and the code confirm only four (`msdSingleFeatureAnalyzer`, `msdThresholdAnalyzer`, `msdFeatureCombinationAnalyzer`, `msdMarketStateAnalyzer`).
Severity: Cosmetic. Confirmed by direct code inspection (exactly four `msdRegisterDiscoveryAnalyzer(...)` calls exist) during the Phase 1 review.
Status: Open.
Recommendation: One-word fix ("Four"). Trivial but worth doing before it's cited in a provenance record.

**R-002 — Unused dataset-builder stubs**
Location: `msdBuildResearchDataset`, `msdBuildClusterDataset`, `msdBuildFeatureAnalysisDataset`.
Description: Each explicitly throws "not yet implemented"; confirmed via code search that nothing downstream calls any of them.
Severity: None currently (dead code, not on any live path) — but a future caller could invoke one expecting it to work.
Status: Open.
Recommendation: Either wire them up when a real caller needs them, or remove them so an unimplemented stub can't be mistaken for a forgotten wire-up.

**R-003 — Raw-tick MSD pipeline: `ngram` candidates have no reproducibility test**
Location: Hidden Market State Discovery (Phase 2 of the *raw-tick* pipeline, distinct from the Workbench), candidate classification logic.
Description: Already disclosed honestly in the code's own comments — candidates of `checkType !== 'lag'/'cmi'` get `reproducible: null` and classify only as "Evidence-Supported Hypothesis (reproducibility not yet tested for this candidate type)."
Severity: Low — honestly disclosed, doesn't silently overstate confidence, but blocks any `ngram` candidate from ever reaching Verified.
Status: Open, pre-existing (not introduced by Phase 2).
Recommendation: A split-half test for n-gram frequency candidates, mirroring the existing lag/CMI reproducibility checks.

**R-004 — Transition Dynamics excluded from the production set**
Location: Scientific Validation (raw-tick pipeline Implementation Phase 5).
Description: Phase 1C's k-th-order Markov work never implemented a formal per-context significance test; honestly excluded from production rather than papered over.
Severity: Low — disclosed, not a correctness bug.
Status: Open, pre-existing.
Recommendation: Tracked as Generation 2 (Transition Dynamics) work in the Roadmap — the significance test should be built as part of formally registering that generation, not bolted on separately.

**R-005 — Matched-Null control does not regenerate real feature values**
Location: `msdBuildMatchedNullDataset` (Phase 2, this session).
Description: By design, this method keeps real engineered-feature values exactly as recorded and only regenerates which ordinal position counts as a synthetic "event." It does not simulate price or indicator values from a matched generative model.
Severity: Medium, scientifically — a full matched-null generative model (synthetic OHLC/tick stream with matched volatility/autocorrelation structure feeding real indicator computation) would be a stronger control, since it would also exercise the feature-computation code path, not just the event-labeling path.
Status: Open — explicitly deferred, not an oversight.
Recommendation: Logged in the Roadmap as future work, separate from Phase 2, since it's a genuinely large undertaking (a synthetic price-generation model is itself something that would need its own validation).

**R-006 — Cross-browser/engine reproducibility not yet empirically verified**
Location: `msdCaptureEnvironmentInfo`, `msdCompareExperimentManifests` (Phase 2, this session).
Description: Phase 2 adds the *mechanism* (recording `navigator.userAgent` on every experiment, and a manifest-diff tool) but no actual multi-browser run has been performed yet.
Severity: Unknown until tested — this platform's statistical compute is entirely client-side, so floating-point drift across engines is a real, untested risk flagged since Phase 1.
Status: Open.
Recommendation: Re-run one frozen experiment (fixed seed, fixed dataset) in at least two browsers/engines and diff the resulting manifests with `msdCompareExperimentManifests`. This is an operational task, not a code task.

**R-007 — Unified Lifecycle's pre-evidence stages need a convenience aggregator**
Location: `msdComputeUnifiedLifecycleStage` (Phase 2, this session).
Description: The function itself is pure and tested, but it takes pre-computed flags (`hasGenerationRecord`, `hasValidMarketStateValue`, `maturityLevel`, `latestAction`) as input — there's no single function yet that walks every known feature/discoveryKey and assembles a full "everything's current unified stage" report.
Severity: Low — a UI/convenience gap, not a correctness gap.
Status: Open.
Recommendation: A small Phase 3 task once Generation 1 is registered and there's real data to report on.

**R-008 — Calibration tolerance (3× nominal alpha) is a stated heuristic, not a formal test**
Location: `msdEvaluateControlCalibration` (Phase 2, this session).
Description: The Pass/Fail line uses `verifiedRate <= nominalAlpha * 3`, explicit and documented, but not derived from a formal binomial confidence interval around the expected false-positive count for the actual number of discoveryKeys tested.
Severity: Low-medium — a single control run's Verified count is small-sample, so a fixed multiplier can be too strict or too lenient depending on how many discoveryKeys happened to be generated that run.
Status: Open.
Recommendation: Once several control runs have accumulated (across methods and trial counts), replace the fixed 3× multiplier with a binomial test against the nominal rate, sized to the actual `discoveryKeyCount`.

**R-009 — Generation Registry currently has zero registered generations**
Location: Generation Registry (Phase 2, this session).
Description: The registry is built and tested, but nothing has been registered into it yet — every feature currently in production (`v1`) is technically "un-Proposed" under the new unified lifecycle until Generation 1 is registered.
Severity: Medium — blocks any meaningful use of the unified lifecycle's early stages until resolved.
Status: Open — flagged as the literal first action item in the Roadmap's "immediate next step."
Recommendation: Register Generation 1 immediately after the first negative-control calibration run passes.

**R-010 — `msdRegisterExperiment`/Phase 2 API-shape inconsistency**
Location: Pre-existing `msdRegisterExperiment` (no top-level `ok` on success) vs. the newer Phase 2 action functions (`msdPromoteToProduction`, `msdDeprecateFeature`, `msdArchiveFeature`, `msdRegisterGeneration` — all explicit `ok:true`/`ok:false`).
Description: A caller checking `.ok` uniformly across both APIs would need to know which convention applies where.
Severity: Low — stylistic, not a bug; caught by contrast during Phase 2's own test-writing (an initial version of `msdRegisterGeneration` had this same gap and was fixed before delivery).
Status: Open for the pre-existing function; resolved for everything written in Phase 2.
Recommendation: Leave `msdRegisterExperiment` alone (no functional bug, and it's exercised by existing tests) — note the inconsistency here rather than silently "fixing" working code outside this phase's scope.

**R-011 — No null-model test for cluster/latent-state existence itself** *(carried over from the Phase 1 review, not yet addressed)*
Location: Market-State Pattern analyzer (`msdMarketStateAnalyzer`).
Description: Tests whether a *found* cluster's positive rate is significant, but doesn't first test whether k-means found genuine structure versus partitioning noise.
Severity: Medium — flagged in Phase 1 as the top validation gap for any future Latent Market State work; not addressed by Phase 2, since Phase 2's scope was the pipeline-level negative control, generation registry, lifecycle, and manifest infrastructure specifically.
Status: Open — scheduled as its own Roadmap phase (Phase 5).
Recommendation: A permutation/gap-statistic test for cluster structure, run before any per-cluster significance test, as scoped in the Roadmap.

---

## Verification note for this session

Every new function introduced in Phase 2 was tested against its *exact shipped source* (extracted directly from the delivered `index.html`, not re-typed) using a standalone Node harness: 34 tests for the pure relabeling/lifecycle/manifest functions, and 11 tests for the IndexedDB-backed Generation Registry and ledger-isolation behavior (via `fake-indexeddb`), all passing. The full HTML file's embedded scripts were also syntax-checked end-to-end after every edit.

This is **not** a substitute for the project's own 472-test / 27-suite harness, which was not available in this session. Before merging, run that full suite against the delivered file — particularly anything touching `msdRecordDiscoveryEvidence`, `msdRunResearchSession`, and `msdRunExperiment`, since those three existing functions were modified (each in a backward-compatible, additive way — new optional parameters/fields only, no existing call site's behavior changed) rather than left untouched.
