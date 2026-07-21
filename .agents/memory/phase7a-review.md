---
name: Phase 7A Master Review
description: Audit findings, fixes applied, and Phase 7B authorization for the ncf_v1 non-classical feature layer.
---

## Verdict: Phase 7A COMPLETE. Phase 7B AUTHORIZED.

All 6 deliverables produced as standalone Markdown files. All 3 engineering defects fixed additively in index.html. 10 validation gaps patched in both index.html and msd-nc-validation.html.

---

## Engineering Defects Fixed (index.html, additive edits)

1. **Critical: featureVersion guard in `msdBuildNcExperimentDataset`**  
   Config with `featureVersion: 'ncf_v1'` now throws a clear error. Previously produced a silent empty dataset because stored records have `featureVersion: 'v1'`, not `'ncf_v1'`.
   **Why:** Stored records keep their original featureVersion; enrichment only adds ncf_* fields. Caller must always pass the stored schema version ('v1') to the NC dataset builder.

2. **Minor: Runtime window-length sync assertion**  
   After `MSD_NC_REQUIRED_WINDOW_LENGTH = 20`, a load-time check throws if `MSD_RAW_HISTORY_WINDOW_LENGTH` differs.
   **Why:** Future phase could change capture window without updating NC constant — silent eligibility mismatch would result.

3. **Minor: rawHistoryWindowLength added to eligibility gate in `msdEnrichWithNonClassicalFeatures`**  
   Gate now explicitly requires `snap.rawHistoryWindowLength === MSD_NC_REQUIRED_WINDOW_LENGTH`.
   **Important:** `eligibleSnap` in msd-nc-validation.html's G9 test fixture also required `rawHistoryWindowLength: 20` to match — this was updated.

---

## Mathematical Notes (no bugs, documentation added)

- `ncf_meanFirstDiff` ≡ `ncf_netDisplacement / 19` (exact identity for n=20)
- `ncf_meanAbsFirstDiff` ≡ `ncf_absPathLength / 19` (exact identity for n=20)
- Permutation entropy tie convention documented: non-strict ≤ per Bandt-Pompe (2002)
- Both collinear features commented in MSD_NC_FEATURE_KEYS

**Phase 7B decision:** Exclude `ncf_meanFirstDiff` and `ncf_meanAbsFirstDiff` → 16-feature candidate family (not 18).

---

## Phase 7B Design (see MSD_PHASE7B_SCIENTIFIC_DESIGN.md)

- 16 candidates: all 18 ncf_v1 features minus the 2 exact collinear features
- Entry point: `msdBuildNcExperimentDataset(allStates, { featureVersion: 'v1', ... })`
- featureVersion MUST be 'v1' (stored schema), not 'ncf_v1'
- Pre-registration required before examining any dataset output
- Statistical protocol: MI + circular shift null (n=1000) + BH at α=0.05 + practical effect size gate (same as Phase 5)
- `msdRunNcProductionValidation` wrapper needed in Phase 7B (enrich holdout before access)

---

## Deliverable Files Produced

| File | Content |
|------|---------|
| MSD_PHASE7A_ARCHITECTURE_AUDIT.md | 10 claims verified; 4 defects found |
| MSD_PHASE7A_MATHEMATICAL_AUDIT.md | Per-feature audit; 0 bugs; 4 notes |
| MSD_PHASE7A_VALIDATION_AUDIT.md | 10 gap categories identified |
| MSD_PHASE7A_VERSIONING_AUDIT.md | Versioning design assessed |
| MSD_PHASE7A_ENGINEERING_READINESS.md | NOT READY → READY after fixes |
| MSD_PHASE7B_SCIENTIFIC_DESIGN.md | Complete Phase 7B protocol |
