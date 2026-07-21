# Feature Registry — Market State Discovery Laboratory

## Overview

The MSD Laboratory distinguishes two categories of features:

1. **Classical features (v1)** — Real-time technical indicators computed from the live tick stream and stored directly in each MarketState snapshot.
2. **Non-Classical features (ncf_v1)** — Derived from the raw 20-tick price history captured with each snapshot. Computed at query time (not stored) via `msdEnrichWithNonClassicalFeatures()`.

---

## Classical Features (Schema Version: `v1`)

Captured live from the Deriv WebSocket tick stream at the moment a market event is detected.

| Feature Key | Full Name | Type | Domain | Notes |
|-------------|-----------|------|--------|-------|
| `epoch` | Market Epoch | integer | ℤ≥0 | Unix timestamp of tick |
| `price` | Price | float | ℝ>0 | Raw tick price |
| `macd` | MACD Line | float | ℝ | EMA(12) − EMA(26) |
| `signal` | MACD Signal | float | ℝ | EMA(9) of MACD |
| `hist` | MACD Histogram | float | ℝ | macd − signal |
| `chop` | Choppiness Index | float | [0, 100] | Bounded; higher = choppier |
| `cci` | Commodity Channel Index | float | ℝ | Typically [−200, +200] |
| `bbPctB` | BB %B | float | [0, 1] | Bollinger Band position |
| `bbUpper` | BB Upper Band | float | ℝ>0 | price + 2σ |
| `bbMid` | BB Midline | float | ℝ>0 | SMA(20) |
| `bbLower` | BB Lower Band | float | ℝ>0 | price − 2σ |
| `pdi` | +DI | float | [0, 100] | Positive Directional Indicator |
| `ndi` | −DI | float | [0, 100] | Negative Directional Indicator |
| `adx` | ADX | float | [0, 100] | Average Directional Index |
| `rsi` | RSI | float | [0, 100] | Relative Strength Index |
| `atr` | ATR | float | ℝ≥0 | Average True Range |
| `ema5` | EMA(5) | float | ℝ>0 | 5-period exponential MA |
| `ema10` | EMA(10) | float | ℝ>0 | 10-period exponential MA |
| `ema20` | EMA(20) | float | ℝ>0 | 20-period exponential MA |
| `stochK` | Stochastic %K | float | [0, 100] | Stochastic oscillator |
| `stochD` | Stochastic %D | float | [0, 100] | Signal of %K |
| `roc` | Rate of Change | float | ℝ | Percentage price change |

**Bounded indicators** (used for special validation): `rsi`, `adx`, `stochK`, `stochD`, `pdi`, `ndi`, `chop`

**Raw Price History** (auxiliary, required for NC enrichment):

| Field | Type | Description |
|-------|------|-------------|
| `rawPriceHistory` | float[20] | Last 20 tick prices before snapshot moment |
| `rawHistoryValid` | boolean | True if history passes quality checks |
| `rawHistoryWindowLength` | integer | Always 20 when valid |

---

## Non-Classical Features (Schema Version: `ncf_v1`)

Computed at query time from `rawPriceHistory` by `msdComputeNcFeatures()`. Requires `rawHistoryValid = true` and `rawHistoryWindowLength ≥ 20`.

These features capture **path-dependent** and **entropy-based** properties of the 20-tick price sequence — information not contained in any single indicator snapshot.

| Feature Key | Description | Formula / Method | Domain |
|-------------|-------------|-----------------|--------|
| `ncf_netDisplacement` | Net price movement over 20 ticks | `last − first` | ℝ |
| `ncf_absPathLength` | Total distance traveled | `Σ|Δp_i|` | ℝ≥0 |
| `ncf_pathEfficiency` | Straightness of price path | `|netDisplacement| / absPathLength` | [0, 1] |
| `ncf_mfe` | Maximum Favorable Excursion | Max gain from entry in run direction | ℝ≥0 |
| `ncf_mae` | Maximum Adverse Excursion | Max loss from entry | ℝ≥0 |
| `ncf_upTickCount` | Count of up ticks | `#{Δp_i > 0}` | ℤ≥0 |
| `ncf_downTickCount` | Count of down ticks | `#{Δp_i < 0}` | ℤ≥0 |
| `ncf_dirImbalance` | Directional imbalance | `(up − down) / (up + down)` | [−1, 1] |
| `ncf_currentRunLen` | Run at snapshot end | Length of final consecutive-direction streak | ℤ≥0 |
| `ncf_maxRunLen` | Longest run in history | Max consecutive-direction streak | ℤ≥0 |
| `ncf_reversalCount` | Direction changes | `#{sign(Δp_i) ≠ sign(Δp_{i-1})}` | ℤ≥0 |
| `ncf_meanFirstDiff` | Mean tick-to-tick change | `mean(Δp_i)` | ℝ |
| `ncf_stdFirstDiff` | Volatility of tick changes | `std(Δp_i)` | ℝ≥0 |
| `ncf_meanAbsFirstDiff` | Mean absolute change | `mean(|Δp_i|)` | ℝ≥0 |
| `ncf_meanSecondDiff` | Mean acceleration | `mean(Δ²p_i)` | ℝ |
| `ncf_dirEntropy` | Entropy of direction distribution | `H(up, down, flat proportions)` | [0, log₂3] normalized |
| `ncf_runEntropy` | Entropy of run-length distribution | Shannon entropy over run-length histogram | ℝ≥0 |
| `ncf_permEntropy3` | Permutation entropy (dim=3) | Bandt-Pompe PE with embedding dim=3 | [0, 1] |

**Total NC features**: 18

---

## Phase 8 Search Space

The Phase 8 campaign tests all NC features across all lead times.

| Dimension | Values |
|-----------|--------|
| Features | 16 active NC features (subset of 18; `ncf_meanFirstDiff` and `ncf_meanAbsFirstDiff` are reserved) |
| Lead times | 1, 2, 3, 4, 5 ticks |
| Total hypotheses | 16 × 5 = **80 candidate hypotheses** |
| Permutations | 1,000 per hypothesis |
| Statistical seed | 42 (fixed for reproducibility) |
| Alpha | 0.05 |
| Practical threshold | Effect size > 0 (Cohen's d / rank-biserial r) |

---

## Feature Versioning Policy

| Version | Features | Storage | Enrichment |
|---------|----------|---------|------------|
| `v1` | 22 classical features + raw history | Stored in IndexedDB | None required |
| `ncf_v1` | 18 NC features | Never stored | Computed at query time from `rawPriceHistory` |

**Rule**: The `featureVersion` field in stored records is always `'v1'`. The NC enrichment version (`ncf_v1`) is a computation-time tag — it identifies which NC computation was applied, not what was captured. Mixing stored records with different `featureVersion` values within a single discovery run is a fatal data quality error (detected by integrity check #6).

---

## Feature Data Quality Constraints

| Check | Threshold | Action on failure |
|-------|-----------|-------------------|
| Raw history present | `rawHistoryValid = true` | State excluded from NC discovery |
| Raw history length | `rawHistoryWindowLength = 20` | State excluded from NC discovery |
| NC-eligible fraction | > 0 | Warning logged |
| Bounded indicators in range | [0, 100] | Corruption flag |
| Corruption rate | < 10% | Below 10%: warning; above 10%: fatal abort |
| Feature completeness | 100% of classical fields present | Corrupt state excluded |
