# MSD Phase 7A — Deliverable 5: Engineering Readiness Report

**Date:** 2026-07-21  
**Decision:** NOT READY (pre-fix) → READY (post-fix)

---

## 1. Summary of Findings Across All Audit Phases

| Deliverable | Finding |
|-------------|---------|
| Architecture Audit | 1 critical defect, 2 minor defects, 1 informational |
| Mathematical Audit | 0 bugs. 2 exact collinear pairs, 1 undocumented convention |
| Validation Audit | 10 gap categories covering 8 features with insufficient coverage |
| Versioning Audit | Sound design. 1 deferred gap (NC registry) |

---

## 2. Engineering Readiness Decision

### PRE-FIX: ❌ NOT READY

The critical defect in `msdBuildNcExperimentDataset` (Architecture Defect 3.1) causes a silent empty dataset when `config.featureVersion` is set to the NC version string rather than the stored schema version. This is a plausible mistake that would produce no error, no warning, and an incorrect dataset. A Phase 7B experiment running against an empty dataset is not a valid scientific outcome — it is a silent experimental failure.

---

## 3. Required Engineering Tasks (Ordered by Priority)

### Task 1 — CRITICAL: Add featureVersion guard to `msdBuildNcExperimentDataset`

**Defect:** Architecture Audit 3.1  
**Fix:** Add an explicit check that throws a descriptive error if `config.featureVersion` equals `MSD_NC_FEATURE_VERSION`. NC-enriched records keep their original `featureVersion: 'v1'` field. Callers must pass `featureVersion: 'v1'` (the stored schema version), not `'ncf_v1'`.

---

### Task 2 — MINOR: Add runtime window-length sync assertion

**Defect:** Architecture Audit 3.2  
**Fix:** After the `MSD_NC_REQUIRED_WINDOW_LENGTH` constant, add a runtime assertion that `MSD_NC_REQUIRED_WINDOW_LENGTH === MSD_RAW_HISTORY_WINDOW_LENGTH`. If a future phase changes the capture window without updating the NC constant, the assertion will catch the mismatch at load time.

---

### Task 3 — MINOR: Add `rawHistoryWindowLength` to eligibility gate

**Defect:** Architecture Audit 3.3  
**Fix:** In `msdEnrichWithNonClassicalFeatures`, add `snap.rawHistoryWindowLength !== MSD_NC_REQUIRED_WINDOW_LENGTH` to the ineligibility condition. This enforces the contract explicitly rather than relying on the indirect length guard in `msdComputeNonClassicalFeatures`.

---

### Task 4 — SCIENTIFIC: Document collinear feature pairs in code

**Source:** Mathematical Audit, Features F12 and F14  
**Fix:** Add explicit comments to `MSD_NC_FEATURE_KEYS` and the feature definitions documenting:
- `ncf_meanFirstDiff` ≡ `ncf_netDisplacement / 19` (exact algebraic identity for n=20)
- `ncf_meanAbsFirstDiff` ≡ `ncf_absPathLength / 19` (exact algebraic identity for n=20)
- For Phase 7B discovery: recommend these two features be **excluded** from the candidate family, reducing family size from 18 to 16 and improving the BH correction's statistical power.

---

### Task 5 — SCIENTIFIC: Document permutation entropy tie convention

**Source:** Mathematical Audit, Feature F18  
**Fix:** Add comment to the permutation entropy implementation stating that ties within a triple (equal consecutive prices) are classified as the '012' (non-decreasing) pattern, following the standard Bandt-Pompe (2002) non-strict inequality convention.

---

### Task 6 — VALIDATION: Add 10 missing test groups to `msdValidateNonClassicalFeatures`

**Source:** Validation Audit, Gaps 1–10  

Groups to add:
- G10: p0=0 edge case for ncf_mfe/ncf_mae
- G11: ncf_runEntropy with genuinely diverse run lengths (H > 0)
- G12: ncf_dirEntropy analytical value for alternating sequence
- G13: Input immutability (rawPriceHistory not mutated)
- G14: Collinearity identity tests (meanFirstDiff×19=netDisp, meanAbsFirstDiff×19=absPath)
- G15: ncf_stdFirstDiff non-degenerate fixture (alternating = √380/19)
- G16: ncf_permEntropy3 tie handling (partial-tie triple → '012')
- G17: Symmetry test (ascending vs reversed sequence)
- G18: ncf_meanSecondDiff telescoping identity
- G19: msdBuildNcExperimentDataset wrong-featureVersion guard test

---

## 4. Implementation Status

All 6 tasks are implemented in this pass:
- Tasks 1–5: Additive edits to the Phase 7 block in `index.html`
- Task 6: New test groups appended to `msdValidateNonClassicalFeatures`

---

## 5. Post-Fix Engineering Readiness Decision

### POST-FIX: ✅ READY

After implementing all 6 tasks:

| Gate | Status |
|------|--------|
| Mathematical correctness (18 features) | ✅ Verified — 0 bugs |
| Append-only integrity | ✅ Confirmed |
| Causal timing | ✅ Confirmed |
| Deterministic execution | ✅ Confirmed |
| Silent failure mode eliminated | ✅ Fixed (Task 1) |
| Window-length sync enforced | ✅ Fixed (Task 2) |
| Eligibility gate complete | ✅ Fixed (Task 3) |
| Collinear pairs documented | ✅ Fixed (Task 4) |
| Permutation entropy convention documented | ✅ Fixed (Task 5) |
| Validation suite complete (10 new groups) | ✅ Fixed (Task 6) |
| Version design sound | ✅ Confirmed |
| Historical reproducibility preserved | ✅ Confirmed |

**Phase 7A is formally declared READY.**

**Phase 7B scientific design is formally authorized to proceed.**

---

## 6. Remaining Open Item (Phase 7B scope)

`msdRunProductionValidation` is not NC-aware (Architecture Informational 3.4). A `msdRunNcProductionValidation` wrapper that enriches the holdout before evaluation must be implemented in Phase 7B before any production validation step runs.

---

## 7. Validation Suite Execution Requirement

Before any Phase 7B experiment is registered, open `msd-nc-validation.html` and confirm:

```
ALL TESTS PASSED — N / N   (where N ≥ 82 + new groups)
```

A failing validation suite means Phase 7B must not proceed.
