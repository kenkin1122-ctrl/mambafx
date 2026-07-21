# Discovery Pipeline — Market State Discovery Laboratory

## What "Discovery" Means in MSD

In the MSD context, **discovery** means identifying market state features that have statistically significant predictive power over 5-tick run outcomes. A discovered feature is one where:

1. The relationship between feature value and outcome is unlikely to be due to chance (p < 0.05 after 1,000 permutations)
2. The effect has practical magnitude (effect size > 0 by rank-biserial correlation)
3. The effect replicates in at least 2 of 3 independent temporal blocks

---

## Discovery Engine: Phase 7B / Phase 8

The discovery engine is `msdRunPhase7bDiscovery()`, defined in `index.html` lines ~4360–12460, and re-executed in the Phase 8 server-side vm context.

### Inputs

```typescript
states: MarketState[]     // All captured snapshots from IndexedDB
opts: {
  searchSpace: SearchSpaceV2,  // Frozen at seal time
  permutations: number,        // 1000
  seed: number,                // 42
  alpha: number,               // 0.05
}
```

### Processing Steps

```
1. msdEnrichWithNonClassicalFeatures(states)
   → Computes 18 ncf_v1 features for each NC-eligible state
   → Returns { enriched: MarketState[], eligible: number, ineligible: number }

2. msdBuildNcSnapshotRows(enriched, opts)
   → Constructs observation matrix
   → Applies uncertainty policy (excludes states with missing NC features)
   → Returns { rows: ObservationRow[], meta }
   
   Each ObservationRow:
   {
     snapshotId:   string,
     leadTime:     1|2|3|4|5,
     outcome:      1|-1,
     epoch:        number,
     features:     { ncf_netDisplacement: 0.02, ncf_dirEntropy: 0.83, ... }
   }

3. For each (feature, leadTime) ∈ searchSpace:
   msdRunPermutationTest(rows, feature, leadTime, opts)
   → Filter rows to current leadTime
   → Split by outcome: pos (outcome=1) and neg (outcome=-1)
   → Compute Mann-Whitney U statistic
   → rank-biserial r = (2U / n₁n₂) - 1
   → Permute outcome labels 1,000 times (seeded RNG)
   → p-value = |{perm_r ≥ |observed_r|}| / 1000
   → Returns { pValue, effectSize, observedStat, n, permDist }

4. Sort hypotheses by pValue ascending
5. Apply significance filter (pValue < alpha && effectSize > practicalThreshold)
6. Return { ok, hypotheses, log, totalTested, significantCount }
```

### Outputs

```typescript
{
  ok: boolean,
  hypotheses: Hypothesis[],    // All 80 results, sorted by p-value
  log: string[],               // Execution trace
  totalTested: number,         // Should be 80
  significantCount: number,    // Hypotheses with p < 0.05
  borderlineCount: number,     // 0.05 ≤ p < 0.10
}
```

---

## NC Discovery Standalone Pages

The laboratory includes standalone HTML pages for each discovery phase. These pages run entirely in the browser and read from the same IndexedDB as the main app.

### `msd-phase7-audit.html`
**Purpose**: Prospective data sufficiency audit.
**Function**: Reads `mfx_msd_states` and checks whether enough valid prospective data has accumulated (≥100 NC-eligible states per lead time, all 5 lead times covered).
**Read-only**: Does not modify IndexedDB.

### `msd-phase7b-discovery.html`
**Purpose**: Phase 7B discovery runner (standalone, without Phase 8 engine).
**Function**: Runs `msdRunPhase7bDiscovery()` client-side against the live IndexedDB. Produces a 9-step discovery report.
**Output**: Discovery results table, permutation p-values, effect sizes.

### `msd-phase7c-verification.html`
**Purpose**: Phase 7C independent verification.
**Function**: Runs 6 pure-computation verification functions to validate the mathematical correctness of the NC feature computations. Does not use IndexedDB.
**Checks**: Shannon entropy formula, permutation entropy formula, Mann-Whitney U formula, rank-biserial correlation, run-length computation, path efficiency.

### `msd-nc-validation.html`
**Purpose**: NC feature validation tool.
**Function**: Interactively validates NC feature computation on sample price history inputs.

### `msd-phase8-campaign.html`
**Purpose**: Phase 8 campaign report viewer.
**Function**: Standalone report for viewing a completed Phase 8 campaign result. Reads seal from `/api/phase8/seal`.

---

## Discovery Session Management

### State Accumulation Strategy

The capture system runs passively whenever the Live Tick Feed tab is open and the market is active:

```
Every detected 5-tick run:
    → 1 EventRecord created
    → 5 MarketState snapshots created (one per lead time)
    → Net: +5 rows in mfx_msd_states per event
```

At Deriv Volatility 100 (1s) with ~60 ticks/minute:
- Expected run frequency: ~6–10 runs/hour in live conditions
- Expected states added: ~30–50 per hour
- Time to accumulate 100 per lead time: ~2–4 hours of active monitoring

### NC Eligibility Gate

A state is NC-eligible if:
```javascript
state.rawHistoryValid === true
  && state.rawPriceHistory.length >= MSD_NC_REQUIRED_WINDOW_LENGTH  // 20
  && state.rawPriceHistory.every(p => typeof p === 'number' && isFinite(p))
```

States captured before Phase 6B (prospective history capture) was added are not NC-eligible.

---

## Experiment System

The Experiment Runner page (`msdexperiment`) allows running parameterized experiments:

```javascript
ExperimentConfig = {
  experimentId:  string,
  name:          string,
  featureSet:    string[],     // subset of features to test
  leadTimes:     number[],     // subset of lead times
  permutations:  number,
  alpha:         number,
  partition:     'full' | 'train' | 'holdout',
  minSampleSize: number
}
```

Experiments are stored in `mfx_msd_experiments` IndexedDB and can be replayed.

---

## Knowledge Base

The Knowledge Base page (`msdknowledge`) maintains a curated record of:
- Confirmed significant hypotheses
- Replication status (pending / confirmed / failed)
- Notes and interpretations
- Links to the campaign that produced each finding

Knowledge records are persisted in `mfx_msd_experiments` IndexedDB under a dedicated `knowledge` partition.
