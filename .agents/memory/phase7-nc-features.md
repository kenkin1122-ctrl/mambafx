---
name: Phase 7 Non-Classical Feature Engineering
description: Architecture decisions, constants, and entry-point functions for the MSD ncf_v1 feature layer
---

## Rule
Non-classical features are NEVER stored in IndexedDB. They are computed from rawPriceHistory at dataset-build time via `msdComputeNonClassicalFeatures()` and attached transiently by `msdEnrichWithNonClassicalFeatures()`.

**Why:** Append-only constraint prevents modifying existing records. Features are deterministic pure functions of stored rawPriceHistory, so computing them at query time is scientifically equivalent and immediately uses existing post-6B data.

**How to apply:** For Phase 7+ discovery experiments, use `msdBuildNcExperimentDataset(allStates, config)` instead of `msdBuildExperimentDataset`. Pass `featureVersion: 'v1'` in config (that's the stored schema version on the records); the nc feature version 'ncf_v1' appears only in experiment registrations and search spaces.

## Key identifiers
- `MSD_NC_FEATURE_VERSION = 'ncf_v1'` — distinct from null-calibration 'nc_v1' (with 'f')
- `MSD_NC_FEATURE_KEYS` — 18 keys, ncf_netDisplacement … ncf_permEntropy3
- `MSD_NC_REQUIRED_WINDOW_LENGTH = 20`
- Validation: `msdValidateNonClassicalFeatures()` — 9 groups, 50+ assertions
- Validation UI: `msd-nc-validation.html` (standalone, self-contained)
- Design audit: `MSD_PHASE7_DESIGN_AUDIT.md`

## Insertion point in index.html
Code was inserted between the dataset-builder stubs (`msdBuildFeatureAnalysisDataset` stub) and the Phase 7F Research Governance comment (~line 7075 at time of writing). Additive only — no existing function modified.

## Eligibility gate
A record is ncf-eligible only if `rawHistoryValid === true` AND `rawPriceHistory` is a 20-element finite array. Records from before Phase 6B (rawHistoryValid=false) are excluded from NC experiments automatically.
