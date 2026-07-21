---
name: Phase 8 Checklist featureVersion Design
description: Why check #6 (feature_version) verifies consistency not a specific value, and why stored records keep featureVersion=v1.
---

## Rule
Check #6 in `ph8RunChecklist` must verify **consistency** of the stored `featureVersion` field, not that it equals `'ncf_v1'`.

## Why
By design (comment at index.html line ~7655):
> NC-enriched records keep their original stored featureVersion ('v1'), not the NC computation version ('ncf_v1'). If a caller passes config.featureVersion = MSD_NC_FEATURE_VERSION, msdPartitionProductionHoldout's featureVersion filter…

States captured under the ML pipeline are stored with `featureVersion = 'v1'`. The `ncf_v1` features are **computed at enrichment time** from `rawPriceHistory` by `msdEnrichWithNonClassicalFeatures`, not stored in the record. Requiring stored `featureVersion === 'ncf_v1'` is a category error — it conflates the storage version with the computation version.

## How to apply
The check uses `fvSet` (Set of distinct featureVersions in NC-eligible states):
- **PASS** if `fvSet.size <= 1` (all same version, or none)
- **FAIL** if `fvSet.size > 1` (mixed versions — fatal data quality problem)
- Detail message: "NC-compatible: stored featureVersion=v1; ncf_v1 features enriched at query time from rawPriceHistory"
