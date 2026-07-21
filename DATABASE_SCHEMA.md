# Database Schema — Market State Discovery Laboratory

All persistence uses browser IndexedDB (three databases) plus localStorage and sessionStorage. There is no server-side database.

---

## IndexedDB Database 1: `mfx_msd_events` (version 1)

**Purpose**: Stores MarketEvent records — detections of 5-in-a-row consecutive tick runs.

**Object Store**: `EventDatabase`

| Property | Type | Description |
|----------|------|-------------|
| `eventId` | string (keyPath) | Unique event ID, format: `evt_<timestamp>_<random>` |
| `runStartEpoch` | number (index) | Unix epoch when the run started |
| `detectedAt` | number (index) | Unix epoch when the event was detected |
| `direction` | number | `1` = rise, `-1` = fall |
| `symbol` | string | Deriv market symbol (e.g., `1HZ100V`) |
| `runLength` | number | Consecutive ticks in the run (always ≥ 5) |
| `triggerPrice` | number | Price at detection moment |
| `indicatorSnapshot` | object | All indicator values at detection time |

**Indexes**:
- `runStartEpoch` (non-unique)
- `detectedAt` (non-unique)

---

## IndexedDB Database 2: `mfx_msd_states` (version 1)

**Purpose**: Stores labeled MarketState snapshots — the core scientific dataset. Each snapshot is one observation at a specific lead time after a market event.

**Object Store**: `MarketStates`

| Property | Type | Description |
|----------|------|-------------|
| `snapshotId` | string (keyPath) | Unique ID: `snap_<eventId>_lt<leadTime>_<random>` |
| `eventId` | string (index) | Links to parent event in `mfx_msd_events` |
| `leadTime` | number (index) | Ticks after event: 1, 2, 3, 4, or 5 |
| `outcome` | number (index) | `1` = up, `-1` = down, `0` = neutral |
| `featureVersion` | string (index) | Schema version, always `'v1'` for stored records |
| `labelVersion` | string | Labeling protocol: `'label-v1-5tick-run'` |
| `capturedAt` | number | Unix timestamp of capture |
| `symbol` | string | Market symbol |
| `epoch` | number | Market epoch at snapshot time |
| `price` | number | Price at snapshot time |
| `macd` | number | MACD line value |
| `signal` | number | MACD signal line value |
| `hist` | number | MACD histogram value |
| `chop` | number | Choppiness Index (0–100) |
| `cci` | number | Commodity Channel Index |
| `bbPctB` | number | Bollinger Band %B (0–1) |
| `bbUpper` | number | Bollinger Band upper value |
| `bbMid` | number | Bollinger Band midline (SMA) |
| `bbLower` | number | Bollinger Band lower value |
| `pdi` | number | Positive Directional Indicator (+DI) |
| `ndi` | number | Negative Directional Indicator (−DI) |
| `adx` | number | Average Directional Index |
| `rsi` | number | Relative Strength Index (0–100) |
| `atr` | number | Average True Range |
| `ema5` | number | EMA over 5 periods |
| `ema10` | number | EMA over 10 periods |
| `ema20` | number | EMA over 20 periods |
| `stochK` | number | Stochastic %K (0–100) |
| `stochD` | number | Stochastic %D (0–100) |
| `roc` | number | Rate of Change |
| `rawPriceHistory` | number[] | Last 20 tick prices before snapshot (prospective capture) |
| `rawHistoryValid` | boolean | Whether `rawPriceHistory` meets quality standards |
| `rawHistoryWindowLength` | number | Length of `rawPriceHistory` (always 20 when valid) |

**Indexes**:
- `eventId` (non-unique) — fetch all snapshots for one event
- `leadTime` (non-unique) — filter by lead time
- `outcome` (non-unique) — filter by outcome direction
- `featureVersion` (non-unique) — partition by schema version

**Notes**:
- NC (Non-Classical) features (`ncf_*`) are NOT stored. They are computed at query time via `msdEnrichWithNonClassicalFeatures()` from `rawPriceHistory`.
- The `featureVersion` stored is `'v1'` even when states are used in NC discovery (which uses `ncf_v1` features). This is by design — stored version tracks the capture schema, not the enrichment version.

---

## IndexedDB Database 3: `mfx_msd_experiments` (version 1)

**Purpose**: Stores experiment configurations, parameters, and results.

**Object Store**: `Experiments`

| Property | Type | Description |
|----------|------|-------------|
| `experimentId` | string (keyPath) | Unique experiment ID |
| `name` | string | Human-readable experiment name |
| `createdAt` | number | Unix timestamp |
| `config` | object | Experiment configuration parameters |
| `results` | object | Stored experiment results |
| `status` | string | `'pending'`, `'running'`, `'complete'`, `'failed'` |

---

## localStorage

Used by the MTF module system (`mtf/src/workspace/storage.js`):

| Key | Contents |
|-----|----------|
| `mfx_drawings_<symbol>` | JSON array of drawing objects for each market symbol |
| `mfx_last_market` | Last selected market symbol |
| `mfx_workspace_<id>` | Named workspace snapshots |

---

## sessionStorage

Used for floating bot panel persistence:

| Key | Contents |
|-----|----------|
| `mfxBotPos` | Mamba FX Bot panel drag position `{x, y}` |
| `dabBotPos` | DAB Bot panel drag position `{x, y}` |

---

## NC Feature Schema (Computed at Query Time)

When states are enriched for discovery, `msdEnrichWithNonClassicalFeatures()` computes these 18 features from `rawPriceHistory`:

| Feature Key | Description | Domain |
|-------------|-------------|--------|
| `ncf_netDisplacement` | Net price displacement over 20 ticks | ℝ |
| `ncf_absPathLength` | Sum of absolute tick-to-tick changes | ℝ≥0 |
| `ncf_pathEfficiency` | |netDisplacement| / absPathLength | [0, 1] |
| `ncf_mfe` | Maximum Favorable Excursion from entry | ℝ≥0 |
| `ncf_mae` | Maximum Adverse Excursion from entry | ℝ≥0 |
| `ncf_upTickCount` | Count of positive tick-to-tick changes | ℤ≥0 |
| `ncf_downTickCount` | Count of negative tick-to-tick changes | ℤ≥0 |
| `ncf_dirImbalance` | (up − down) / (up + down) | [−1, 1] |
| `ncf_currentRunLen` | Length of final consecutive run at snapshot | ℤ≥0 |
| `ncf_maxRunLen` | Longest consecutive run in history | ℤ≥0 |
| `ncf_reversalCount` | Number of direction changes | ℤ≥0 |
| `ncf_meanFirstDiff` | Mean of first differences | ℝ |
| `ncf_stdFirstDiff` | Standard deviation of first differences | ℝ≥0 |
| `ncf_meanAbsFirstDiff` | Mean of absolute first differences | ℝ≥0 |
| `ncf_meanSecondDiff` | Mean of second differences (acceleration) | ℝ |
| `ncf_dirEntropy` | Entropy of up/down tick distribution | [0, 1] |
| `ncf_runEntropy` | Entropy of run-length distribution | [0, 1] |
| `ncf_permEntropy3` | Permutation entropy with embedding dim 3 | [0, 1] |
