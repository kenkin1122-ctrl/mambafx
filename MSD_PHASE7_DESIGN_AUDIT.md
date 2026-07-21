# MSD Phase 7 — Non-Classical Feature Engineering
## Architecture Audit · Scientific Design Decision · Execution Readiness Report

**Code version at time of audit:** `mambafx-2026.07-phase7e`  
**Audit date:** 2026-07-21  
**Status:** IMPLEMENTATION COMPLETE — PENDING VALIDATION RUN

---

## 1. Architecture Audit

### 1.1 What already exists and is fully reusable

| Component | Location | Role in Phase 7 |
|-----------|----------|-----------------|
| `msdCaptureRawPriceHistory(centerIndex, w)` | index.html ~4552 | Source of rawPriceHistory — already captures 20-tick causal window |
| `rawPriceHistory` field (Phase 6B) | All post-6B MarketState records | Input to all 18 non-classical feature computations |
| `msdGetAllMarketStates()` | index.html ~5014 | Read path — fetches the record set for enrichment |
| `msdBuildExperimentDataset(states, config)` | index.html ~6972 | Dataset builder — reused unchanged; Phase 7 wraps it |
| `msdPartitionProductionHoldout()` | index.html ~6930 | Holdout partition — applied before enrichment |
| `msdFreezeSearchSpace()` + v2 schema | index.html ~7890 | Search space governance — used as-is for NC search spaces |
| `msdRegisterFeatureVersion(version, keys)` | index.html ~4899 | Version registry — not used directly (NC features are not stored on records) |
| `msdSimpleHash()` / `msdComputeFeatureFingerprint()` | index.html ~4224 | Hashing — reusable for future NC schema fingerprinting |
| `msdProcessLabeledSnapshots()` | index.html ~4971 | Write pipeline — unchanged, NC features bypass it (not persisted) |
| Mutual Information + BH + Circular Shift | index.html Phase 4 | Statistical engine — reused for NC feature discovery |
| `msdRegisterDiscoveryAnalyzer()` | index.html ~10894 | Analyzer registration — NC analyzers can be added here |
| `MSD_SEARCH_SPACE_V2_ADDITIONAL_REQUIRED_FIELDS` | index.html ~7867 | `individualFeatures` field covers NC feature keys |
| `_msdExpectedFingerprintCache` + version registry | index.html ~4852 | Clean versioning model — NC version ('ncf_v1') is separate |
| `msdIsRowCorrupted()` | index.html ~4206 | QA gate — only checks MSD_KNOWN_FEATURE_KEYS (classical); NC fields not affected |

### 1.2 Dependencies

```
rawPriceHistory (Phase 6B)
    ↓
msdComputeNonClassicalFeatures(rawPriceHistory)   ← NEW (pure, Phase 7)
    ↓
msdEnrichWithNonClassicalFeatures(snapshots)       ← NEW (pure, Phase 7)
    ↓
msdBuildNcExperimentDataset(allStates, config)     ← NEW (wraps existing)
    ↓
msdBuildExperimentDataset(eligibleOnly, config)    ← EXISTING (unchanged)
    ↓
[existing discovery pipeline: MI, BH, circular shift, governance]
```

### 1.3 Identified risks

| Risk | Mitigation |
|------|-----------|
| rawHistoryValid=false records cannot contribute NC features | `msdEnrichWithNonClassicalFeatures` marks these `ncf_eligible: false` and excludes them from the dataset |
| NC features computed at dataset-build time, not stored — reproducibility concern | All 18 features are pure deterministic functions of rawPriceHistory. Same input → same output always. Reproducibility is guaranteed by rawPriceHistory immutability in IndexedDB. |
| Naming collision with existing 'nc_v1' (null calibration version) | NC feature version is 'ncf_v1' (with 'f') — explicitly different |
| Feature values for entropy features may be poorly scaled | All entropy features return natural-log nats; this is consistent and documented. Scaling is a discovery-time concern, not an engineering one. |
| Window length of 20 ticks limits permutation entropy order | Order 3 chosen deliberately (18 patterns possible from 20 ticks). Higher orders would produce sparse pattern counts. |
| msdIsRowCorrupted only checks classical keys | NC keys are not in MSD_KNOWN_FEATURE_KEYS → not checked by the corruption gate → acceptable, since NC features are derived post-write and are never stored on the raw record |

### 1.4 What is NOT needed

- No new IndexedDB store
- No modification to the QA Engine or Version Validator
- No modification to msdBuildExperimentDataset
- No modification to msdProcessLabeledSnapshots
- No modification to any stored MarketState record
- No new data capture mechanism

---

## 2. Scientific Design Decision

### 2.1 Core architectural decision

**Non-classical features are computed as a pure, additive enrichment layer applied at dataset-build time — not at capture time, and not stored in IndexedDB.**

Rationale:
- rawPriceHistory is already stored causally on all post-6B records (featureVersion='v1')
- NC features are deterministic pure functions of rawPriceHistory
- Computing them at dataset-build time is scientifically equivalent to storing them — the same input produces the same output
- This avoids any new data accumulation delay
- This preserves append-only integrity (no records are touched)
- This preserves backward compatibility (existing v1 discovery experiments are unchanged)

### 2.2 Feature version

The NC feature computation layer is versioned as **`ncf_v1`**. This version string appears only in experiment registrations and search space definitions — it does NOT replace or conflict with the classical `featureVersion` stored on raw snapshots (which remains `'v1'`).

### 2.3 Feature families and mathematical definitions

All features operate on `rawPriceHistory = [p₀, p₁, ..., p₁₉]` (oldest → newest, 20 ticks).

Let `dᵢ = pᵢ₊₁ − pᵢ` for i = 0…18 (19 first differences).

#### Family A — Path Geometry (5 features)

| Key | Formula | Range |
|-----|---------|-------|
| `ncf_netDisplacement` | p₁₉ − p₀ | (−∞, +∞) price units |
| `ncf_absPathLength` | Σᵢ |dᵢ| | [0, +∞) price units |
| `ncf_pathEfficiency` | |netDisplacement| / absPathLength; 0 if path flat | [0, 1] |
| `ncf_mfe` | (max(pᵢ) − p₀) / |p₀| | [0, +∞) fraction |
| `ncf_mae` | (p₀ − min(pᵢ)) / |p₀| | [0, +∞) fraction |

#### Family B — Directional Structure (6 features)

Let `dirᵢ = sign(dᵢ)` ∈ {−1, 0, +1}.

| Key | Formula | Range |
|-----|---------|-------|
| `ncf_upTickCount` | #{i : dᵢ > 0} | [0, 19] integer |
| `ncf_downTickCount` | #{i : dᵢ < 0} | [0, 19] integer |
| `ncf_dirImbalance` | (up − down) / 19 | [−1, +1] |
| `ncf_currentRunLen` | Length of final monotone run in dir sequence | [1, 19] integer |
| `ncf_maxRunLen` | Length of longest monotone run | [1, 19] integer |
| `ncf_reversalCount` | Direction changes in non-flat dir sequence | [0, 18] integer |

#### Family C — Price Dynamics (4 features)

| Key | Formula | Range |
|-----|---------|-------|
| `ncf_meanFirstDiff` | mean(dᵢ) | (−∞, +∞) |
| `ncf_stdFirstDiff` | std(dᵢ), Bessel-corrected | [0, +∞) |
| `ncf_meanAbsFirstDiff` | mean(|dᵢ|) | [0, +∞) |
| `ncf_meanSecondDiff` | mean(dᵢ₊₁ − dᵢ), i=0…17 | (−∞, +∞) |

#### Family D — Complexity / Entropy (3 features)

All entropy values are in natural units (nats).

| Key | Formula | Range |
|-----|---------|-------|
| `ncf_dirEntropy` | Shannon H of {up, down, flat} counts | [0, ln(3)] ≈ [0, 1.099] |
| `ncf_runEntropy` | Shannon H of run-length distribution | [0, ln(19)] ≈ [0, 2.944] |
| `ncf_permEntropy3` | Permutation entropy, order 3 (18 consecutive triples, 6 ordinal patterns) | [0, ln(6)] ≈ [0, 1.791] |

**Total: 18 candidate non-classical features**

### 2.4 Causal validity

- rawPriceHistory was captured by `msdCaptureRawPriceHistory(centerIndex, 20)` at snapshot time
- The slice `indHistory[centerIndex-19 : centerIndex+1]` contains only prices observed ≤ centerIndex
- No future price (index > centerIndex) is included
- NC features are functions only of rawPriceHistory → causal validity is inherited
- This is verified in the validation suite (Test 2: monotone ascent has MFE=19/100, MAE=0)

### 2.5 Symmetry

- Both positive and negative records receive NC enrichment via the identical `msdEnrichWithNonClassicalFeatures` path
- Eligibility criterion is identical: `rawHistoryValid === true AND rawPriceHistory.length === 20`
- There is no class-specific enrichment logic

### 2.6 What this phase does NOT authorize

- Does not authorize discovery (finding predictive signal)
- Does not authorize modifying any stored records
- Does not authorize changing the event definition
- Does not authorize changing the labeling logic
- Does not authorize statistical testing against real data

Discovery begins only when this engineering phase passes validation and a separate pre-registered experiment is registered.

---

## 3. Implementation Summary

### 3.1 New functions added to index.html (additive only)

| Function | Purpose |
|----------|---------|
| `_msdShannonEntropy(counts, total)` | Internal: Shannon entropy from frequency counts |
| `msdComputeNonClassicalFeatures(rawPriceHistory)` | Pure: compute all 18 NC features |
| `msdEnrichWithNonClassicalFeatures(snapshots)` | Enrich a batch of snapshots from rawPriceHistory |
| `msdBuildNcExperimentDataset(allStates, config)` | Wrapper: enrich → filter eligible → msdBuildExperimentDataset |
| `msdValidateNonClassicalFeatures()` | Deterministic validation suite (9 test groups, 50+ assertions) |

### 3.2 New constants added

| Constant | Value |
|----------|-------|
| `MSD_NC_FEATURE_VERSION` | `'ncf_v1'` |
| `MSD_NC_FEATURE_KEYS` | Array of 18 `ncf_*` strings |
| `MSD_NC_REQUIRED_WINDOW_LENGTH` | `20` |

### 3.3 Files NOT modified

- No existing function bodies changed
- No constants redefined
- No stored records touched
- No IndexedDB schema changed

---

## 4. Validation Report

Validation is executed by `msdValidateNonClassicalFeatures()`, callable from `msd-nc-validation.html`.

### 4.1 Test groups

| # | Group | What it verifies |
|---|-------|-----------------|
| 1 | Invalid inputs | null, non-array, wrong length, NaN, Infinity → all return null |
| 2 | Flat prices | All 18 features for a 20-tick flat sequence have analytically derivable values |
| 3 | Monotone ascending | netDisplacement=19, absPathLength=19, pathEfficiency=1, upTicks=19, stdFirstDiff=0, permEntropy=0 |
| 4 | Monotone descending | netDisplacement=-19, dirImbalance=-1, mae=19/100, mfe=0 |
| 5 | Alternating up-down | upTicks=10, downTicks=9, reversalCount=18, maxRunLen=1, meanFirstDiff=1/19 |
| 6 | Permutation entropy | Monotone ascending → all triples pattern '012' → permEntropy=0 |
| 7 | Determinism | Same rawPriceHistory array → identical output on two calls |
| 8 | Key completeness | All 18 ncf_* keys present; all values finite for valid input |
| 9 | Enrichment pipeline | Eligible/ineligible snap counts; ncf_eligible flags; ncf_version field |

### 4.2 Running validation

Open `msd-nc-validation.html` in the same browser as the main app and click **Run Validation**. The page must report:

```
Tests passed: N   Tests failed: 0
```

for the implementation to be considered validated.

---

## 5. Execution Readiness Report

### 5.1 Gates

| Gate | Criterion | Status |
|------|-----------|--------|
| Implementation complete | All 18 features implemented and defined | ✅ |
| No existing code modified | Verified by diff — additive insert only | ✅ |
| Causal validity | rawPriceHistory captured backward-only; features pure functions of it | ✅ |
| Symmetry | Identical enrichment path for positive and negative records | ✅ |
| Version isolation | 'ncf_v1' does not conflict with 'nc_v1' (null calibration) | ✅ |
| Validation suite | msdValidateNonClassicalFeatures() implemented with 9 test groups | ✅ |
| Validation run | **Must be executed — run msd-nc-validation.html** | ⏳ PENDING |

### 5.2 What happens after validation passes

1. Run Phase 7 audit (`msd-phase7-audit.html`) to confirm sufficient prospective data has accumulated
2. If READY_FOR_FEATURE-ENGINEERING DESIGN: proceed to Phase 8 pre-registration
3. Register a search space using `msdFreezeSearchSpace()` with `individualFeatures: MSD_NC_FEATURE_KEYS`
4. Register experiments via `msdRegisterExperiment()` BEFORE any data is evaluated
5. Run discovery using `msdBuildNcExperimentDataset()` as the dataset source

### 5.3 What does NOT happen

- No discovery is run in this phase
- No statistical test is executed against real data
- No NC feature is assumed to be predictive
- Null results are valid scientific outcomes

---

*A null result for non-classical features is as scientifically valuable as a null result for classical features. Phase 5 already demonstrated this with the classical indicator family.*
