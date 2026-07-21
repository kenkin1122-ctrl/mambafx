---
name: Phase 7C Verification
description: Phase 7C independent scientific verification — 6 supporting functions in index.html + runner page
---

## Phase 7C: Independent Scientific Verification

### What Was Built (additive only to index.html Part 13, lines 9941–10422)

6 pure-computation functions — zero IDB writes in any of them:

1. `msdRunPhase7cControlPipeline(rows, frozenSearchSpace, options)`
   - Identical evaluation loop to msdRunPhase7bDiscovery but zero persistence writes
   - Accepts pre-built rows directly (allows modified rows for controls)
   - Returns {hypothesisSummaries, candidateResults, correction, significantCount}

2. `msdRunPhase7cNegativeControl(rows, frozenSpace, controlType, options)`
   - controlType: 'random_labels' | 'random_features' | 'constant_features'
   - Uses seeded RNG offset (+0xBEEF) so corruption RNG never shares state with permutation-test seed
   - Returns {controlType, discoveryCount, evaluatedOkCount, result}

3. `msdRunPhase7cPositiveControl(rows, frozenSpace, options)`
   - Box-Muller injection: positive outcomes get signalStrength+N(0,0.5), negatives get 0+N(0,0.5)
   - Mock search space: 1 synthetic feature × 1 lead time = 1 candidate, NEVER recorded to ledger
   - Mock space frozen with msdFreezeSearchSpace (pure), not recorded with msdRecordSearchSpaceSpecification

4. `msdValidatePhase7cReproducibility(run1, run2)`
   - Matches candidates by candidateHash (deterministic)
   - Compares effectSize, rawPValue, adjustedPValue, rejected, sampleSize for bit-equality

5. `msdComputePhase7cFeatureDiagnostics(rows, featureKeys)`
   - Welford's algorithm for numerically stable mean/variance
   - Per-feature: n, mean, variance, std, min, max, skewness (Fisher), excess kurtosis, missingRate, histogram(10 bins)
   - 16×16 Pearson matrix using msdPearsonCorrelation
   - 16×16 MI matrix using msdMutualInformation(xs, ys, 8) (bits)

6. `msdGeneratePhase7cManifest(params)` — plain object with all 19 required fields

### Runner Page: msd-phase7c-verification.html (827 lines)

9-step sequential verification with progress bar:
- Step 1: Reproducibility (run pipeline twice, compare bit-for-bit)
- Step 2: Completeness (80→80→80→80 chain)
- Step 3: Negative controls (random_labels, random_features, constant_features)
- Step 4: Positive control (synthetic signal, signalStrength=1.5, detection check)
- Step 5: Sensitivity (500/1000/2000 permutations, stability table)
- Step 6: Seed stability (seeds 42/123/999, max Δ per candidate)
- Step 7: Feature diagnostics (stats table + Pearson heatmap + MI heatmap)
- Step 8: Manifest (JSON with copy button)
- Step 9: READY_FOR_PHASE8_DISCOVERY or NOT_READY with blocking issue list

**Why:** runner page must be opened from Phase 7B runner or main app via window.open() — uses window.opener for all MSD functions; cannot be navigated to directly.

### Validation: 115/115 assertions pass after Part 13 insertion. All 16 runner page MOP references resolve to defined functions.
