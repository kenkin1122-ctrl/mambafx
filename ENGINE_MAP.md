# Engine Map — Market State Discovery Laboratory

All engines are implemented as plain JavaScript functions inside `index.html` (inline) or `phase8-engine.js` (server-side). There is no class hierarchy — engines are collections of pure and semi-pure functions.

---

## 1. MSD Core Engine (`index.html` lines ~4360–12460)

The foundational scientific engine of the laboratory. Handles all data capture, labeling, storage, enrichment, and discovery.

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MSD_FEATURE_SCHEMA_VERSION` | `'v1'` | Version tag stored with each snapshot |
| `MSD_LABEL_VERSION` | `'label-v1-5tick-run'` | Labeling protocol identifier |
| `MSD_RAW_HISTORY_VERSION` | `'raw_price_history_v1'` | Raw price history format tag |
| `MSD_RAW_HISTORY_WINDOW_LENGTH` | `20` | Ticks of raw history captured per snapshot |
| `MSD_NC_FEATURE_VERSION` | `'ncf_v1'` | NC enrichment version |
| `MSD_NC_REQUIRED_WINDOW_LENGTH` | `20` | Minimum history length for NC eligibility |
| `MSD_MIN_SEGMENT_SIZE` | `100` | Minimum observations per train/test segment |
| `MSD_CORRUPTION_RATE_FATAL_THRESHOLD` | `0.10` | 10% corruption triggers abort |
| `MSD_SEARCH_SPACE_SPEC_VERSION_V2` | `'search_space_spec_v2'` | Phase 8 search space format |
| `MSD_RUN_LENGTH` | `5` | Target consecutive-tick run length |

### Database Functions

| Function | Description |
|----------|-------------|
| `msdOpenDb(dbName, version, upgrade)` | Opens an IndexedDB database with schema migration |
| `msdGetAllStates()` | Retrieves all MarketState snapshots from `mfx_msd_states` |
| `msdGetStatesByEventId(eventId)` | Fetches snapshots for a specific event |
| `msdPutState(state)` | Writes a MarketState to IndexedDB |
| `msdDeleteState(snapshotId)` | Removes a snapshot by ID |
| `msdGetAllEvents()` | Retrieves all MarketEvent records |
| `msdPutEvent(event)` | Writes a MarketEvent record |
| `msdClearAllStates()` | Truncates the MarketStates store |

### Capture & Labeling Functions

| Function | Description |
|----------|-------------|
| `msdBuildLabeledSnapshot(raw, meta)` | Assembles a labeled MarketState from raw indicators + metadata. Returns record with `snapshotId`, `eventId`, `outcome`, `leadTime`, `labelVersion`, `featureVersion`, `rawPriceHistory` |
| `msdCaptureMarketState(snap, event)` | High-level capture: builds snapshot, deduplicates, persists |
| `msdCheckDuplicate(snap)` | Checks whether a near-identical state already exists |
| `msdComputeLabelIntegrity(states)` | Verifies label consistency across a set of states |

### Enrichment Functions

| Function | Description |
|----------|-------------|
| `msdEnrichWithNonClassicalFeatures(states)` | Computes 18 NC features for states with valid `rawPriceHistory`. Returns `{ enriched, eligible, ineligible }` |
| `msdComputeNcFeatures(rawHistory)` | Pure function: computes all 18 `ncf_v1` features from a 20-tick price array |

### Partitioning Functions

| Function | Description |
|----------|-------------|
| `msdPartitionTrainTest(states, opts)` | Splits states into training and holdout sets with time-ordering guarantee |
| `msdPartitionProductionHoldout(states, opts)` | Strict time-ordered partition for production experiments |

### Discovery Functions

| Function | Description |
|----------|-------------|
| `msdRunPhase7bDiscovery(states, opts)` | Core Phase 7B/8 discovery engine. Builds NC dataset, runs permutation tests across all features × lead-times in `MSD_SEARCH_SPACE_SPEC_V2`. Returns `{ ok, findings, log }` |
| `msdBuildNcSnapshotRows(states, opts)` | Constructs observation matrix for discovery: enriches with NC features, applies uncertainty policies, returns `{ rows, meta }` |
| `msdRunPermutationTest(rows, featureKey, leadTime, opts)` | Runs a single permutation test for one feature × lead-time pair. Returns `{ pValue, effectSize, observedStat, permDist }` |
| `msdRunNcDiscovery(states, opts)` | Orchestrates multi-feature, multi-lead-time discovery loop |

### Positive Control Functions

| Function | Description |
|----------|-------------|
| `msdBuildPositiveControl(states, effectSize)` | Injects a synthetic signal into a copy of the dataset. Used to verify the detection pipeline works |
| `msdRunPositiveControlSmoke(states)` | Runs 30 smoke-test trials with known-effect data to confirm the pipeline can detect real signals |

### Validation Functions

| Function | Description |
|----------|-------------|
| `msdRunIntegrityChecklist(states)` | 20-point integrity checklist including: count, NC eligibility, lead-time coverage, featureVersion consistency, positive control, block replication |
| `msdComputeDataQualityReport(states)` | Returns per-feature completeness and corruption rates |
| `msdVerifyBlockReplication(states, opts)` | Checks that findings replicate across ≥3 temporal blocks |

---

## 2. Phase 8 Campaign Engine (`phase8-engine.js`)

Server-side engine running in a Node.js `vm` sandbox. Executes the full discovery protocol against a user-supplied state array.

### Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `getSeal()` | `() → SealObject` | Computes the frozen search space. Extracts MSD library from `index.html[4360:12460]`, executes in vm, calls `msdBuildSearchSpaceV2()`. Returns `{ searchSpaceId, searchSpaceHash, searchSpaceVersion, totalCardinality, symbol, featureVersion, features, leadTimes, permutations, seed, alpha, practicalThreshold }` |
| `runCampaign(states)` | `(states[]) → CampaignResult` | Runs `msdRunPhase7bDiscovery()` in vm context. Returns `{ ok, hypotheses, log, serverElapsedMs, frozenSearchSpace, engineVersion }` |

### vm Context Stubs

The vm context provides stubs for all browser APIs referenced by the MSD library:
`document`, `window`, `crypto`, `indexedDB`, `sessionStorage`, `localStorage`, `setTimeout`, `setInterval`, `performance`, `navigator`, `location`

---

## 3. Live Tick Engine (`index.html` inline)

Processes the Deriv WebSocket tick stream for the Live Tick Feed page.

| Function | Description |
|----------|-------------|
| `connect()` | Opens WebSocket to Deriv, handles `tick` messages |
| `processTick(price)` | Detects consecutive run direction and length |
| `showBanner(dir)` | Animates the 5-in-a-row flash banner |
| `updateStats()` | Updates run counters, signal counts, price display |
| `buildSelector()` | Populates market dropdown from `MARKETS` map |
| `resetState()` | Clears all tick state and UI for a market switch |

---

## 4. Indicator Engine (`index.html` inline)

Real-time technical indicator computation from the tick stream.

| Indicator | Algorithm |
|-----------|-----------|
| MACD | EMA(12) − EMA(26), signal EMA(9) |
| Choppiness Index | Range / sum of ranges over N periods |
| CCI | (Typical price − SMA) / (0.015 × mean deviation) |
| Bollinger Bands | SMA(20) ± 2σ, %B position |
| ADX / +DI / −DI | Wilder smoothed directional movement |
| RSI | Wilder smoothed relative strength |
| ATR | Average True Range |
| EMA(5,10,20) | Exponential moving averages |
| Stochastic | %K and %D over 14 periods |
| ROC | Rate of change |

---

## 5. Bot Engines (`index.html` inline)

### Prediction Bot (`pbPageInit`)
Pattern-match based contract firing. Matches recent tick sequences against stored pattern library.

### Only Ups/Downs Bot (`ouPageInit`)
Multi-filter bot: requires MACD histogram flip, DI bias alignment, BB%B threshold, ADX minimum, and historical pattern flip before firing. Supports Martingale progression.

### Rise/Fall Autobot (`rfaPageInit`)
ADX + pattern-based Rise/Fall contract automation with cooldown logic.

### ADX Bot (`adxPageInit`)
Fires when ADX > threshold and +DI is rising. Configurable stake and cooldown.

### Aggression Bot (`aggPageInit`, `aggOnTick`)
High-frequency tick-based bot with consecutive signal counting. Previously inaccessible due to structural bug (now fixed: moved to global scope).

### Mamba FX Bot (`mfxInit`)
Position-fixed floating bot panel with drag, double-click minimize, and session-persistent position. Connects to Trading Grid for authorized trading.

### DAB Bot
Position-fixed floating bot panel. Similar architecture to Mamba FX Bot.

---

## 6. MTF Analysis Engines (`mtf/src/analysis/`)

| Engine | Description |
|--------|-------------|
| `patternEngine.js` | Detects structural patterns in OHLCV series |
| `similarity.js` | Pattern similarity scoring |
| `historicalSimilarity.js` | Finds historical matches for the current pattern |
| `candleGenome.js` | Encodes candle sequences as genome strings |
| `candlestickPatterns.js` | Named candlestick pattern recognition (doji, hammer, engulfing, etc.) |
| `structurePatterns.js` | Higher-timeframe structure identification |
| `swingPoints.js` | Swing high/low detection |
| `swingLabels.js` | Labels swings with HH/HL/LH/LL |
| `zonePatterns.js` | Support/resistance zone identification |
| `statistics.js` | Statistical utilities (mean, stddev, percentile, correlation) |

---

## 7. AI/Commentary Engines (`mtf/src/ai/`)

| Engine | Description |
|--------|-------------|
| `probabilityEngine.js` | Estimates outcome probabilities from historical pattern matches |
| `ruleEngine.js` | Rule-based signal generation from indicator combinations |
| `narrativeEngine.js` | Generates textual market structure narratives |
| `candleCommentary.js` | Per-candle commentary from pattern + indicator context |
| `fiveMinCommentary.js` | 5-minute-timeframe commentary aggregation |
| `continuousLearning.js` | Updates pattern weights from observed outcomes |
| `marketIntelligence.js` | Cross-timeframe intelligence aggregation |
