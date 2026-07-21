# MSD Phase 7A — Deliverable 3: Feature Validation Audit

**Date:** 2026-07-21  
**Scope:** Review of existing validation test suite + identification of gaps  
**Verdict:** INSUFFICIENT — 10 gap categories identified, fixes required

---

## 1. Existing Test Suite Summary

The existing `msdValidateNonClassicalFeatures()` function contains 9 test groups:

| Group | Fixture type | Features covered | Count |
|-------|-------------|-----------------|-------|
| G1 | Invalid inputs (null, type, length, NaN, Inf) | guard clause | 9 |
| G2 | Flat sequence [100×20] | all 18 | 18 |
| G3 | Monotone ascending [100..119] | all 18 | 17 |
| G4 | Monotone descending [100..81] | 12 of 18 | 12 |
| G5 | Alternating [100,101,...] | 10 of 18 | 10 |
| G6 | Permutation entropy boundary | ncf_permEntropy3 only | 3 |
| G7 | Determinism | all 18 implicitly | 1 |
| G8 | Key completeness and finiteness | all 18 | 3 |
| G9 | Enrichment pipeline | pipeline | 9 |

**Total existing assertions: ~82**

---

## 2. Coverage Gaps

### GAP 1: Zero-price edge case (MFE/MAE)

**Missing:** `p0 = 0` case for `ncf_mfe` and `ncf_mae`.  
The implementation uses `p0 !== 0 ? ... : 0`. This branch is never tested.  
**Required fixture:** `rawPriceHistory = [0, 1, -1, 2, ...]` — verifies the zero-price fallback returns 0 and not NaN.

---

### GAP 2: `ncf_runEntropy` with genuinely diverse run lengths

**Missing:** Any sequence where run lengths genuinely vary, producing H > 0.  
Existing G2 (all flat, one run, H=0), G3 (one run, H=0), G5 (all runs length 1, H=0).  
All existing tests produce H=0 for ncf_runEntropy. H>0 case is untested.  
**Required fixture:** Sequence with runs of lengths [3, 1, 2, 5, 1, 3, 1, 3] → diverse run lengths → H > 0. Compute expected H analytically.

---

### GAP 3: Independent numerical fixture for `ncf_dirEntropy` at non-degenerate values

**Missing:** Explicit hand-computed dirEntropy assertion for a known non-zero value.  
G5 (alternating, upCount=10, downCount=9) implicitly exercises this, but the assertion only checks `ncf_meanFirstDiff` and `ncf_upTickCount`. dirEntropy for the alternating case is never asserted.  
**Required fixture:** Assert `ncf_dirEntropy` for alternating sequence = −(10/19)ln(10/19) − (9/19)ln(9/19).

---

### GAP 4: Input mutation test

**Missing:** Verification that `msdComputeNonClassicalFeatures` does not mutate its input array.  
The function creates a `diffs` array from the input but never writes back to `rawPriceHistory`. This should be explicitly asserted.  
**Required fixture:** Record `prices[0]` before call, verify after call it is unchanged; also verify the input array length is unchanged.

---

### GAP 5: Collinearity identity tests

**Missing:** Explicit assertion of the two exact linear dependency identities.  
These should be asserted as properties of the engine — not assumptions.  
**Required fixtures:**
- `ncf_meanFirstDiff × 19 === ncf_netDisplacement` for any valid input
- `ncf_meanAbsFirstDiff × 19 === ncf_absPathLength` for any valid input
These confirm both that the identities hold AND that a future implementation change that breaks them will be caught.

---

### GAP 6: `ncf_stdFirstDiff` non-degenerate analytical fixture

**Missing:** Hand-computed stdFirstDiff for a non-trivial sequence.  
G3 verifies std=0 (degenerate). The alternating case has been independently computed as √(380/361) = √380/19 ≈ 1.0270 but is not asserted in the validation suite.  
**Required fixture:** Assert `ncf_stdFirstDiff` for alternating sequence = √380/19 ≈ 1.02699.

---

### GAP 7: `ncf_permEntropy3` tie-handling behavior

**Missing:** Explicit test of how ties within a triple are classified.  
The non-strict inequality convention collapses ties into '012'. This should be explicitly asserted.  
**Required fixture:** All-flat sequence: `ncf_permEntropy3 = 0` (asserted in G2). But: partial-tie triple — sequence with two equal prices followed by a rise (e.g. [100,100,101,...]) should map to '012' pattern. Assert this explicitly.

---

### GAP 8: Symmetry test (ascending vs. descending)

**Missing:** Explicit symmetric property assertion.  
For a sequence P and its reverse P', certain features should satisfy symmetric relationships:
- ncf_netDisplacement(P') = −ncf_netDisplacement(P)
- ncf_absPathLength(P') = ncf_absPathLength(P)
- ncf_upTickCount(P') = ncf_downTickCount(P)
- ncf_pathEfficiency(P') = ncf_pathEfficiency(P)
- ncf_mfe(P') = ncf_mae(P) and vice versa
These are implied by G3/G4 but never asserted as a symmetric property.

---

### GAP 9: `ncf_meanSecondDiff` telescoping identity

**Missing:** Assertion that `ncf_meanSecondDiff = (prices[19] − prices[18] − prices[1] + prices[0]) / 18`.  
This identity was confirmed in the mathematical audit but is not in the validation suite.

---

### GAP 10: `msdBuildNcExperimentDataset` wrong-featureVersion detection

**Missing:** After the critical defect is fixed (Defect 3.1 in Architecture Audit), a test that verifies the guard throws or warns when `config.featureVersion` is wrong.  
**Required fixture:** Call `msdBuildNcExperimentDataset([...], {featureVersion: 'ncf_v1', ...})` and assert it throws with a descriptive error.

---

## 3. Per-Feature Validation Coverage Assessment

| Feature | Existing tests | G4 missing | G5 missing | Non-degenerate | Status |
|---------|---------------|------------|------------|----------------|--------|
| ncf_netDisplacement | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ✅ COMPLETE |
| ncf_absPathLength | G2,G3,G5 | G4 missing | ✅ | ✅ | ⚠️ Partial |
| ncf_pathEfficiency | G2,G3,G4 | ✅ | ❌ | ✅ | ⚠️ Partial |
| ncf_mfe | G2,G3,G4 | ✅ | ❌ | p0=0 missing | ⚠️ NEEDS GAP 1 |
| ncf_mae | G2,G3,G4 | ✅ | ❌ | p0=0 missing | ⚠️ NEEDS GAP 1 |
| ncf_upTickCount | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ✅ COMPLETE |
| ncf_downTickCount | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ✅ COMPLETE |
| ncf_dirImbalance | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ✅ COMPLETE |
| ncf_currentRunLen | G2,G3,G5 | G4 missing | ✅ | ✅ | ⚠️ Partial |
| ncf_maxRunLen | G2,G3,G5 | G4 missing | ✅ | ✅ | ⚠️ Partial |
| ncf_reversalCount | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ✅ COMPLETE |
| ncf_meanFirstDiff | G2,G3,G4,G5 | ✅ | ✅ | ✅ | ⚠️ NEEDS GAP 5 |
| ncf_stdFirstDiff | G2,G3,G4 | ✅ | ❌ | ❌ non-degenerate | ⚠️ NEEDS GAP 6 |
| ncf_meanAbsFirstDiff | G2,G3,G5 | ❌ | ✅ | ✅ | ⚠️ NEEDS GAP 5 |
| ncf_meanSecondDiff | G2,G3,G4 | ✅ | ❌ | ❌ | ⚠️ NEEDS GAP 9 |
| ncf_dirEntropy | G2,G3,G4 | ✅ | ❌ asserted | ✅ | ⚠️ NEEDS GAP 3 |
| ncf_runEntropy | G2,G3,G5 | ❌ | ✅ | ❌ H>0 case | ⚠️ NEEDS GAP 2 |
| ncf_permEntropy3 | G2,G3,G6 | ✅ | ❌ | tie case | ⚠️ NEEDS GAP 7 |

---

## 4. Required Actions

10 new test fixtures must be added to `msdValidateNonClassicalFeatures()` as Groups G10–G19 before Phase 7A is declared READY.

See implementation in the Engineering Readiness Report (Deliverable 5) for exact test code.
