# MSD Phase 7A — Deliverable 4: Versioning Audit

**Date:** 2026-07-21

---

## 1. Current Version Architecture

### 1.1 Classical feature versioning (existing)

```
MSD_FEATURE_SCHEMA_VERSION = 'v1'       ← captured on every stored record
MSD_FEATURE_REGISTRY = { 'v1': [...keys] }
msdRegisterFeatureVersion(version, keys) ← enforces no-redefinition
msdComputeFeatureFingerprint(snapshot)   ← FNV-1a hash of present keys
msdValidateVersion(snapshot)             ← checks stored vs registry fingerprint
```

Classical versioning is **stored on the record**. Every MarketState record carries `featureVersion: 'v1'`. Schema changes require a new `MSD_FEATURE_SCHEMA_VERSION` constant and a new `msdRegisterFeatureVersion` call.

### 1.2 NC feature versioning (Phase 7)

```
MSD_NC_FEATURE_VERSION = 'ncf_v1'       ← NOT stored on records
MSD_NC_FEATURE_KEYS = [18 keys]          ← frozen constant
MSD_NC_REQUIRED_WINDOW_LENGTH = 20       ← tied to rawPriceHistory shape
```

NC versioning is **not stored on records**. Instead, it appears only in:
- The `ncf_version` field added transiently by `msdEnrichWithNonClassicalFeatures`
- Experiment registrations and search space definitions written by the researcher

---

## 2. Versioning Design Assessment

### 2.1 Frozen key list

**Verdict: ✅ SOUND**

`MSD_NC_FEATURE_KEYS` is declared as a `const` array with an explicit comment: *"NEVER modified after definition. Introducing new features or changing a formula requires a new version string (ncf_v2, etc.)"*. JavaScript `const` prevents reassignment. The comment creates an explicit contractual obligation for future developers.

### 2.2 Future version extensibility

**Verdict: ✅ NATURALLY SUPPORTED**

To introduce `ncf_v2`:
1. Define `MSD_NC_FEATURE_VERSION_V2 = 'ncf_v2'`
2. Define `MSD_NC_FEATURE_KEYS_V2 = [...]`
3. Define `MSD_NC_REQUIRED_WINDOW_LENGTH_V2 = N` (if window changes)
4. Implement `msdComputeNonClassicalFeaturesV2(rawPriceHistory)`
5. Implement `msdEnrichWithNonClassicalFeaturesV2(snapshots)`
6. Implement `msdBuildNcExperimentDatasetV2(allStates, config)`

None of this requires modifying any existing function. The pattern is additive by construction. Historical experiments using `ncf_v1` remain reproducible because `msdComputeNonClassicalFeatures` is immutable once written.

### 2.3 Reproducibility of ncf_v1 experiments

**Verdict: ✅ REPRODUCIBLE**

`msdComputeNonClassicalFeatures` is a pure function with no external dependencies. The `rawPriceHistory` array is immutably stored in IndexedDB. Running any `ncf_v1` experiment with the same database state at any future time will produce the exact same features.

The search space hash (`msdFreezeSearchSpace`) will record exactly which features were tested, locking the experiment definition permanently before any data is observed.

### 2.4 Missing: formal NC version registry

**Verdict: ⚠️ MINOR GAP**

The classical feature system has `MSD_FEATURE_REGISTRY` — a formal map from version string to key list — enforced by `msdRegisterFeatureVersion`. The NC layer has no analogous registry. A future `ncf_v2` search space could theoretically reference `ncf_v1` feature keys without a runtime check catching the mismatch.

**Assessment:** This gap is acceptable for Phase 7A. The single-version reality (ncf_v1 only) means there is nothing to mismatch against. If ncf_v2 is introduced in a future phase, a registry should be added at that time. Premature registry infrastructure for a system with one version would add complexity without benefit.

**Recommendation:** Document this gap. Add registry infrastructure when ncf_v2 is defined.

### 2.5 Version string isolation

**Verdict: ✅ CONFIRMED**

Three version namespaces coexist without collision:
- Classical: `'v1'` (stored on records)
- NC feature: `'ncf_v1'` (experiment registration only)
- Null calibration: `'nc_v1'` (separate system)

The strings are all distinct. No runtime lookup would confuse them.

---

## 3. Future Version Path

When the research program requires `ncf_v2`:

| Trigger | Example |
|---------|---------|
| New feature added | Adding `ncf_lag1_netDisp` or `ncf_mean_vol_ratio` |
| Formula change | Changing permutation entropy order from 3 to 4 |
| Window length change | Moving from 20 to 30 tick window |
| Scientific redesign | Replacing run entropy with Lempel-Ziv complexity |

**Compatibility:** `ncf_v1` records and `ncf_v2` records can coexist. A researcher can run parallel experiments (one per version) against the same underlying database because the enrichment is stateless and computed on demand.

**Reproducibility guarantee:** `ncf_v1` results remain reproducible indefinitely because the `rawPriceHistory` values in IndexedDB are immutable and the `msdComputeNonClassicalFeatures` function is frozen.

---

## 4. Versioning Audit Verdict

| Property | Status |
|----------|--------|
| Key list frozen | ✅ |
| Future versions additive | ✅ |
| Historical reproducibility | ✅ |
| Version string isolation | ✅ |
| Formal NC registry | ⚠️ Deferred to ncf_v2 introduction |
| Window-length sync assertion | ❌ Missing (see Architecture Audit Defect 3.2) |
