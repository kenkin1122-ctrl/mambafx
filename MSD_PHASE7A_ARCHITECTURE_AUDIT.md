# MSD Phase 7A — Deliverable 1: Architecture Audit

**Auditor:** Independent review pass  
**Audit date:** 2026-07-21  
**Code version inspected:** `mambafx-2026.07-phase7e` + Phase 7 additive block (lines 7077–7580)  
**Audit method:** Full code read + independent simulation of critical code paths

---

## 1. Scope

This audit examines every architectural claim made for the Phase 7 Non-Classical Feature Engineering layer and independently verifies whether the implementation fulfills those claims.

---

## 2. Claims vs. Reality

### 2.1 Append-only integrity: existing records not modified

**Claim:** NC features are never persisted back to IndexedDB.  
**Verdict:** ✅ CONFIRMED

`msdEnrichWithNonClassicalFeatures` constructs new plain objects via `Object.assign({}, snap, ncf, {...})`. The original `snap` object is never mutated. The validation suite includes a mutation test (`G9 original object not mutated`). IndexedDB write paths (`msdWriteMarketState`, `msdProcessLabeledSnapshots`) are entirely bypassed. There is no path from `msdComputeNonClassicalFeatures` or `msdEnrichWithNonClassicalFeatures` to any database write.

---

### 2.2 Derived enrichment at dataset-build time

**Claim:** Features computed on-demand, never at capture time.  
**Verdict:** ✅ CONFIRMED

`msdComputeNonClassicalFeatures` is not called from `recordIndicatorTick`, `msdLabelQualifiedEvent`, `msdSampleNegativeSnapshots`, `msdBuildLabeledSnapshot`, or any other capture-time path. It is called only from `msdEnrichWithNonClassicalFeatures`, which is called only from `msdBuildNcExperimentDataset`. The capture pipeline is completely untouched.

---

### 2.3 Deterministic execution

**Claim:** Same input → identical output, always.  
**Verdict:** ✅ CONFIRMED

`msdComputeNonClassicalFeatures` reads only its argument. It calls no `Math.random()`, `Date.now()`, or any global mutable state. All operations are pure floating-point arithmetic. The validation suite explicitly tests this (G7 determinism).

---

### 2.4 Causal timing

**Claim:** NC features depend only on prices observed ≤ snapshot tick.  
**Verdict:** ✅ CONFIRMED

`rawPriceHistory` is produced by `msdCaptureRawPriceHistory(centerIndex, 20)`, which slices `indHistory[centerIndex-19 : centerIndex+1]` — a backward-only window ending at the snapshot tick (line 4568: "oldest → newest, current tick inclusive"). NC features are pure functions of this already-causal array. No future price enters the computation.

---

### 2.5 Existing experiment infrastructure reused

**Claim:** `msdBuildExperimentDataset` called unchanged.  
**Verdict:** ✅ CONFIRMED with one architectural gap (see Section 3.1)

`msdBuildNcExperimentDataset` calls `msdBuildExperimentDataset(eligibleOnly, config)` unmodified. All holdout partitioning, deduplication, segmentation, boundary purging, and chronological splitting are inherited from the existing function.

---

### 2.6 Governance unchanged

**Claim:** Search space freezing, pre-registration, MI, BH correction, circular-shift null model all apply without modification.  
**Verdict:** ✅ CONFIRMED

The NC feature layer adds no new statistical methodology. The discovery path (`msdFreezeSearchSpace` → `msdRegisterExperiment` → `msdRunExperiment` / `msdRunDiscoveryCompetition`) is untouched and fully functional for NC experiments.

---

### 2.7 Historical discoveries remain reproducible

**Claim:** Phase 5 null result is unaffected.  
**Verdict:** ✅ CONFIRMED

Phase 5 experiments reference `featureVersion: 'v1'` and use `msdBuildExperimentDataset` directly. The NC layer inserts no code in that path. The `MSD_FEATURE_REGISTRY` and `MSD_KNOWN_FEATURE_KEYS` are not modified. Phase 5's exact datasets can be rebuilt identically from the same DB state.

---

### 2.8 Version string isolation

**Claim:** `'ncf_v1'` is distinct from `'nc_v1'` (null calibration).  
**Verdict:** ✅ CONFIRMED

`MSD_NC_FEATURE_VERSION = 'ncf_v1'` (with 'f'). The null calibration version (`MSD_NULL_CALIBRATION_FEATURE_VERSION = 'nc_v1'`) is a different string. No collision.

---

### 2.9 No hidden coupling

**Verdict:** ✅ NO HIDDEN COUPLING FOUND

`_msdShannonEntropy` is a new private helper with underscore prefix, not called from any existing code. `MSD_NC_FEATURE_KEYS` is not referenced by `MSD_KNOWN_FEATURE_KEYS`, `msdIsRowCorrupted`, or any existing data quality gate.

---

### 2.10 No unnecessary duplication

**Verdict:** ✅ CONFIRMED

The enrichment layer does not re-implement deduplication, segmentation, holdout partitioning, or statistical testing. These are delegated entirely to existing infrastructure.

---

## 3. Defects Found

### 3.1 CRITICAL: Silent empty dataset from wrong `config.featureVersion`

**Location:** `msdBuildNcExperimentDataset` (line 7381)  
**Severity:** Critical — produces incorrect, silent result

**Mechanism:** Enriched records retain `featureVersion: 'v1'` from the stored record — the enrichment only adds `ncf_*` fields, it does not change `featureVersion`. The downstream `msdBuildExperimentDataset` call invokes `msdPartitionProductionHoldout(eligibleOnly, config.featureVersion, config.symbol)`, which filters by `s.featureVersion === config.featureVersion`. If a caller passes `config.featureVersion = 'ncf_v1'` (the NC version string, which would be a natural mistake), the filter returns 0 records and produces a silently empty dataset.

**Verified by simulation:** With 2 eligible records having `featureVersion: 'v1'`:
- `config.featureVersion = 'ncf_v1'` → 0 records passed to partition → empty dataset
- `config.featureVersion = 'v1'` → 2 records passed → correct

**Fix required:** Add an explicit guard to `msdBuildNcExperimentDataset` that verifies `config.featureVersion` is the stored schema version (`'v1'`), not the NC version string. If wrong, throw a descriptive error.

---

### 3.2 MINOR: No runtime assertion that window-length constants are synchronized

**Location:** After `MSD_NC_REQUIRED_WINDOW_LENGTH` definition (line 7107)  
**Severity:** Minor — future-proofing gap, not a current bug

`MSD_NC_REQUIRED_WINDOW_LENGTH = 20` is documented as "must equal `MSD_RAW_HISTORY_WINDOW_LENGTH`" but there is no runtime enforcement. If `MSD_RAW_HISTORY_WINDOW_LENGTH` is changed in a future phase, new records would have a different window length. The `msdComputeNonClassicalFeatures` length guard would correctly mark them ineligible (correct behavior), but the mismatch would be silent.

**Fix required:** Add `if (MSD_NC_REQUIRED_WINDOW_LENGTH !== MSD_RAW_HISTORY_WINDOW_LENGTH) throw new Error(...)` at module load time.

---

### 3.3 MINOR: `msdEnrichWithNonClassicalFeatures` does not check `rawHistoryWindowLength`

**Location:** Lines 7343-7350  
**Severity:** Minor — defense-in-depth gap

The eligibility check verifies `rawHistoryValid === true` and `Array.isArray(rawPriceHistory)` but does not explicitly check `snap.rawHistoryWindowLength === MSD_NC_REQUIRED_WINDOW_LENGTH`. Protection currently relies indirectly on the length check in `msdComputeNonClassicalFeatures`. This is correct in behavior but does not enforce the contract at the boundary.

**Fix required:** Add `snap.rawHistoryWindowLength === MSD_NC_REQUIRED_WINDOW_LENGTH` to the eligibility gate.

---

### 3.4 INFORMATIONAL: `msdRunProductionValidation` is not NC-aware

**Location:** Line 7920  
**Severity:** Informational — does not affect Phase 7A, relevant for Phase 7B

`msdRunProductionValidation(feature, threshold, direction, featureVersion, symbol)` calls `msdPartitionProductionHoldout` and then accesses `s[feature]` directly on stored records. For NC features (`ncf_*`), those fields do not exist on stored records — enrichment is required first. Calling this function with an NC feature key would silently treat all records as `s[feature] = undefined`, making `msdMeetsThreshold` always return false.

**Fix required in Phase 7B:** A `msdRunNcProductionValidation` wrapper that enriches the holdout before evaluation.

---

## 4. Summary

| Claim | Verdict |
|-------|---------|
| Append-only integrity | ✅ Confirmed |
| Derived enrichment only | ✅ Confirmed |
| Deterministic execution | ✅ Confirmed |
| Causal timing | ✅ Confirmed |
| Infrastructure reuse | ✅ Confirmed (with guard gap) |
| Governance unchanged | ✅ Confirmed |
| Historical reproducibility | ✅ Confirmed |
| Version string isolation | ✅ Confirmed |
| No hidden coupling | ✅ Confirmed |
| No duplication | ✅ Confirmed |
| config.featureVersion guard | ❌ MISSING — Critical defect |
| Window-length sync assertion | ❌ MISSING — Minor |
| rawHistoryWindowLength check | ❌ MISSING — Minor |
| NC production validation path | ❌ NOT IMPLEMENTED — Phase 7B |
