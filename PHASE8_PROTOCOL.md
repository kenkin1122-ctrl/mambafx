# Phase 8 Protocol — Non-Classical Discovery Campaign

## Overview

Phase 8 is the first official scientific discovery campaign of the MSD Laboratory. It tests the 80 Non-Classical hypothesis candidates (16 NC features × 5 lead times) for statistically significant predictive power over 5-tick run outcomes on Deriv Volatility 100 (1s).

The campaign is executed client-side (browser) with server-side computation assist via `phase8-engine.js`.

---

## Campaign Lifecycle

```
1. PRE-FLIGHT (browser)
   │
   ├─ ph8Boot() — boot Phase 8 UI
   │   ├─ ph8LoadSeal()    — GET /api/phase8/seal
   │   └─ ph8RefreshReadiness() — query IndexedDB for state counts
   │
   ├─ ph8RunChecklist()    — 20-point pre-flight integrity checks
   │
   └─ [User clicks "Run Campaign"]
          │
2. CAMPAIGN EXECUTION (browser → server → browser)
   │
   ├─ ph8CollectStates()  — read all states from IndexedDB
   ├─ ph8SendStates()     — POST /api/phase8/run { states }
   │
   └─ phase8-engine.js:runCampaign(states)  [Node.js vm]
       ├─ msdEnrichWithNonClassicalFeatures(states)
       ├─ msdBuildNcSnapshotRows(enriched)
       ├─ msdRunPhase7bDiscovery(rows, searchSpace)
       │   └─ for each feature × leadTime:
       │       msdRunPermutationTest(rows, feature, leadTime, { permutations: 1000, seed: 42 })
       └─ return { ok, hypotheses[], log, serverElapsedMs, frozenSearchSpace }
          │
3. RESULTS (browser)
   │
   └─ ph8RenderResults()  — display hypothesis table sorted by p-value
       ├─ Significant at α=0.05 + practical effect threshold
       ├─ Borderline (0.05 < p < 0.10)
       └─ Non-significant
```

---

## The Seal

The **seal** is a cryptographically-frozen snapshot of the search space definition. It proves that the search space was defined before data was observed — preventing post-hoc hypothesis fishing.

**Seal structure**:
```json
{
  "searchSpaceId":      "searchspace_<hash>_<version>_<timestamp>",
  "searchSpaceHash":    "<8-char hex>",
  "searchSpaceVersion": "search_space_spec_v2",
  "totalCardinality":   80,
  "symbol":             "1HZ100V",
  "featureVersion":     "ncf_v1",
  "features":           ["ncf_netDisplacement", "ncf_absPathLength", ...],
  "leadTimes":          [1, 2, 3, 4, 5],
  "permutations":       1000,
  "seed":               42,
  "alpha":              0.05,
  "practicalThreshold": 0
}
```

**How the seal is computed** (`phase8-engine.js:getSeal()`):
1. Read `index.html` from disk
2. Extract lines `[4360, 12460)` — the MSD function library
3. Strip non-ASCII characters (JSDoc box-drawing chars)
4. Execute in Node.js vm sandbox with DOM stubs
5. Call `msdBuildSearchSpaceV2()` from the extracted library
6. Hash the search space definition with SHA-256 (first 8 hex chars)

**Seal endpoint**: `GET /api/phase8/seal` → always returns same seal for a given `index.html` version.

---

## 20-Point Pre-Flight Integrity Checklist

Run by `ph8RunChecklist()` before campaign launch. Checks are grouped into categories:

### Data Sufficiency (checks #1–5)
1. **Total state count** — minimum threshold for statistical power
2. **NC-eligible count** — states with valid `rawPriceHistory`
3. **Lead-time coverage** — all 5 lead times (1–5) present in dataset
4. **Outcome balance** — both up (+1) and down (−1) outcomes present
5. **Temporal span** — observations spread across calendar time

### Data Quality (checks #6–10)
6. **Feature version consistency** — all NC-eligible states share the same stored `featureVersion` (mixed versions is fatal; detail note: stored is `v1`, ncf_v1 is enrichment-time)
7. **Corruption rate** — < 10% of states corrupt
8. **Bounded indicator ranges** — rsi, adx, stochK, stochD, pdi, ndi, chop all in [0, 100]
9. **Raw history completeness** — eligible states have `rawHistoryWindowLength = 20`
10. **Deduplication** — no near-identical snapshot pairs (similarity > 98%)

### Scientific Controls (checks #11–15)
11. **Positive control smoke test** — pipeline detects injected synthetic signal at 30 trials
12. **Seal loaded** — `GET /api/phase8/seal` returned ok:true
13. **Seal hash** — seal hash matches expected value for current `index.html`
14. **Search space cardinality** — 80 hypotheses (16 features × 5 lead times)
15. **Block replication** — findings expected to replicate across ≥3 temporal blocks

### Protocol Compliance (checks #16–20)
16. **Symbol consistency** — all states from same market symbol
17. **Label version** — all states use `'label-v1-5tick-run'`
18. **Server connectivity** — `phase8-engine.js` reachable at `/api/phase8/run`
19. **Campaign Readiness counters** — NC-eligible count displayed
20. **Seal verified** — seal hash cross-checked post-load (locked after first successful campaign)

---

## Statistical Method

### Permutation Test

For each feature × lead-time pair:

1. Split observations into `outcome=+1` and `outcome=-1` groups
2. Compute **observed statistic**: rank-biserial correlation `r = (U / (n₁×n₂)) × 2 - 1` where U is the Mann-Whitney U statistic
3. Run **1,000 permutations**: randomly shuffle outcome labels, recompute statistic
4. **p-value** = fraction of permutation statistics ≥ |observed statistic| (two-tailed)
5. **Effect size** = |rank-biserial r| (bounded [0, 1])

### Significance Criteria

| Tier | p-value | Effect size | Action |
|------|---------|-------------|--------|
| Strong signal | p < 0.05 | > practical threshold | Hypothesis confirmed |
| Borderline | 0.05 ≤ p < 0.10 | any | Flag for replication |
| Non-significant | p ≥ 0.10 | any | Reject |

### Multiple Comparisons

With 80 hypotheses at α=0.05, ~4 false positives are expected by chance. The campaign uses:
- Fixed random seed (42) for reproducibility
- Block replication check (≥3 temporal blocks)
- Positive control as pipeline integrity check

---

## Campaign Readiness Counters

Displayed on the Phase 8 Campaign page at all times (populated even when seal fails):

| Counter | Source | Meaning |
|---------|--------|---------|
| Total States | `mfx_msd_states` count | All captured MarketState records |
| NC-Eligible | states with `rawHistoryValid=true` | States that can participate in NC discovery |
| Lead-Time Coverage | distinct leadTimes in DB | Which lead times (1–5) have observations |
| Symbol | most common symbol in DB | Primary market under study |

---

## Campaign API Endpoints

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/api/phase8/seal` | — | `{ ok, seal }` |
| POST | `/api/phase8/run` | `{ states: MarketState[] }` | `{ ok, result: CampaignResult }` |

**`CampaignResult` fields**:
```json
{
  "ok": true,
  "hypotheses": [
    {
      "feature": "ncf_dirEntropy",
      "leadTime": 3,
      "pValue": 0.012,
      "effectSize": 0.18,
      "observedStat": 0.18,
      "significant": true
    }
  ],
  "log": ["..."],
  "serverElapsedMs": 4200,
  "frozenSearchSpace": { ... },
  "engineVersion": "phase8-engine-v1"
}
```
