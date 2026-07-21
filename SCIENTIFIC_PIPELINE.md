# Scientific Pipeline — Market State Discovery Laboratory

## Overview

The MSD scientific pipeline transforms live Deriv tick data into statistical discoveries about market behavior. It runs entirely in the browser (data capture, labeling, storage) with server-side compute for the Phase 8 discovery campaign.

---

## Pipeline Stages

```
STAGE 1: EVENT DETECTION
    Live tick stream (Deriv WebSocket)
           │
    processTick(price)
           │
    Detect 5-tick consecutive run (rise or fall)
           │
    msdCaptureEvent(direction, epoch, price, indicators)
           │
    Write EventRecord → mfx_msd_events IndexedDB
           │
           ▼

STAGE 2: PROSPECTIVE CAPTURE
    At event detection moment:
           │
    Capture indicator snapshot (all 22 classical features)
    Capture rawPriceHistory[20] (last 20 ticks before event)
           │
    For each lead time τ ∈ {1, 2, 3, 4, 5}:
        Wait τ ticks after event
        Observe outcome (up/down/neutral)
        msdBuildLabeledSnapshot(indicators, { eventId, leadTime, outcome })
        msdCaptureMarketState(snapshot)
           │
    Write MarketState → mfx_msd_states IndexedDB
           │
           ▼

STAGE 3: DATA ACCUMULATION
    (Passive — runs continuously while app is open)
    Target: ≥ 100 NC-eligible states per lead time
           │
    Monitor via Phase 8 Campaign Readiness counters
           │
           ▼

STAGE 4: PRE-FLIGHT VALIDATION
    ph8RunChecklist() → 20-point integrity audit
    Checks: count, NC eligibility, quality, positive control, seal
           │
    All checks must pass (or be acknowledged) before campaign
           │
           ▼

STAGE 5: NC ENRICHMENT
    msdEnrichWithNonClassicalFeatures(states)
           │
    For each state with rawHistoryValid=true:
        msdComputeNcFeatures(rawPriceHistory)
        → Attach 18 ncf_v1 features to state object (in memory only)
           │
    Result: { enriched[], eligible[], ineligible[] }
           │
           ▼

STAGE 6: DISCOVERY DATASET CONSTRUCTION
    msdBuildNcSnapshotRows(enriched)
           │
    Apply uncertainty policies:
        - Exclude states with insufficient history
        - Apply temporal ordering
        - Check deduplication thresholds
           │
    Result: observation matrix (rows × features)
           │
           ▼

STAGE 7: HYPOTHESIS TESTING
    For each hypothesis (feature × leadTime) in search space:
        msdRunPermutationTest(rows, feature, leadTime, opts)
            │
        Compute Mann-Whitney U → rank-biserial correlation
        Run 1,000 permutations (fixed seed=42)
        Compute two-tailed p-value
        Compute effect size
           │
    Result: ranked hypothesis list with p-values, effect sizes
           │
           ▼

STAGE 8: BLOCK REPLICATION
    msdVerifyBlockReplication(states, significantHypotheses)
           │
    Split states into ≥3 temporal blocks
    Re-run hypothesis test in each block
    Check: fraction of blocks where hypothesis replicates ≥ 2/3
           │
           ▼

STAGE 9: KNOWLEDGE BASE UPDATE
    Confirmed hypotheses → msdknowledge page
    Stored as HypothesisRecord in mfx_msd_experiments IndexedDB
           │
    Fields: hypothesis, pValue, effectSize, sampleSize, discoveredAt,
            replicationStatus, notes
```

---

## Positive Control System

Before running any campaign, the pipeline verifies it can detect real effects:

```
msdRunPositiveControlSmoke(states)
    │
    For 30 trials:
        msdBuildPositiveControl(states, effectSize='strong')
        → Inject synthetic effect (Cohen's d ≈ 3.0) into copy of dataset
        Run permutation test on injected copy
        Verify p-value < 0.05
    │
    Pass criterion: ≥ 90% of 30 trials detect the injected effect
```

Effect sizes used in positive control:
- **Strong**: Cohen's d ≈ 3.0 (should always detect)
- **Moderate**: Cohen's d ≈ 1.2 (should usually detect)
- **Borderline**: Cohen's d ≈ 0.5 (sensitivity test)

---

## Data Quality Pipeline

### Corruption Detection

For each state, the following checks run:
1. All 22 classical feature fields present and numeric
2. Bounded indicators in valid range ([0, 100])
3. `rawPriceHistory` is an array of 20 numbers
4. No NaN or Infinity values
5. Price > 0, epoch > 0

States failing any check are flagged as corrupt and excluded.

**Fatal threshold**: If > 10% of states are corrupt, the campaign aborts.

### Deduplication Policy

Before inclusion in the discovery dataset:
1. Compute pairwise feature distance between candidate and existing states
2. If distance < `MSD_DEDUP_POLICY_MATERIAL_DIFFERENCE_THRESHOLD` (2%), mark as duplicate
3. Duplicates are excluded from analysis but retained in IndexedDB

### Temporal Ordering Guarantee

All analysis is performed in time order (`epoch` ascending). No future data is used in any calculation. Train/test partitions always respect the temporal boundary.

---

## Search Space V2 Definition

```javascript
MSD_SEARCH_SPACE_SPEC_VERSION_V2 = 'search_space_spec_v2'

searchSpace = {
  symbol:          '1HZ100V',
  featureVersion:  'ncf_v1',
  features:        [16 active NC features],
  leadTimes:       [1, 2, 3, 4, 5],
  permutations:    1000,
  seed:            42,
  alpha:           0.05,
  practicalThreshold: 0,   // any effect size passes this gate
  totalCardinality: 80     // 16 × 5
}
```

The search space is **frozen at campaign start** (the Seal mechanism). Any modification to the search space definition in `index.html` changes the seal hash and invalidates pending campaigns.

---

## Hypothesis Record Schema

Confirmed hypotheses are stored as `HypothesisRecord` objects:

```javascript
{
  hypothesisId:      'hyp_<timestamp>_<hash>',
  schemaVersion:     'hypothesis_record_v1',
  feature:           'ncf_dirEntropy',
  leadTime:          3,
  pValue:            0.012,
  effectSize:        0.18,
  observedStat:      0.18,
  permutations:      1000,
  sampleSize:        1842,
  ncEligibleCount:   1705,
  symbol:            '1HZ100V',
  searchSpaceHash:   '36b45239',
  discoveredAt:      1784639615437,
  replicationStatus: 'pending',
  notes:             ''
}
```

Required fields: `hypothesisId`, `schemaVersion`, `feature`, `leadTime`, `pValue`, `effectSize`
Optional fields: `notes`, `replicationStatus`, `ncEligibleCount`
