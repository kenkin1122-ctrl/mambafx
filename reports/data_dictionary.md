# BAZU signal data dictionary

| Field | Meaning |
|---|---|
| `signal_id` | UUID for this exported signal record. |
| `schema_version` | Signal-record schema version. |
| `config_hash`, `config`, `flags` | Deterministic config fingerprint and full decision-time effective config/flag snapshot. |
| `decision_time_iso`, `decision_time_epoch_ms` | UTC decision timestamp and Unix epoch milliseconds. |
| `contract_id`, `traded`, `account_type` | Deriv contract identity and whether the signal resulted in a real or demo contract. No account identity is logged. |
| `market`, `market_class`, `tick_interval_s` | Market symbol/class and median interval from the recent ticks, in seconds. |
| `software`, `created_iso`, `created_epoch_ms` | Injected build/commit metadata, if present, and record creation time. |
| `A` | Signal direction/playbook/duration/score, decision/entry timestamps, display label and signal-book lifecycle transitions. |
| `B` | Last 20 point-in-time candles for each active timeframe role, indicators (ATR/ADX/RSI/EMA/Bollinger and range readings), price-path tick-flow proxy and freshness/tick-gap data. Volume is null because volume is unavailable. |
| `C` | Decision price, forming candle geometry, immediate momentum, regime and volatility percentile. |
| `D` | Support/resistance zones, target/invalidation, available room and named PASS/FAIL/VETO checks with measurements. |
| `E.prediction` | Family/factor votes, score contributions, lifetime estimators, snapped duration, expected move, quote and break-even. |
| `E.e2` | Disagreement, non-trivial neutral readings, omitted factors, near misses and unapplied checks. |
| `E.e3` | Opposite playbook candidate score where one was generated, opposite family agreement, and closest indicators to flipping. |
| `E.e4` | Threshold margins and leave-one-out/flip-one sensitivity results. This is a deterministic local perturbation of recorded factor/family evidence, not a full rerun of every downstream gate. |
| `E.inputs` | Stored deterministic inputs for E2-E4, allowing the local computations to be reproduced without fetching future data. |
| `F.contract` | Deriv contract id/status/result, buy price, payout, stake, and raw profit field. These raw P/L details are confined to the signal package and are not included in Performance log reports. |
| `F` | Post-settlement Deriv fields, entry/exit tick outcome, first touch, excursions, in-trade candles, retrospective vote labels, and opposite/neighboring-duration shadow outcomes. This section is hindsight. |
| `G` | Post-expiry candles/prices/regime and reversal test using the record's saved reversal thresholds. This section is hindsight. |
| `available_at_decision` | `true` for A-E; `false` for F-G. |
| `null_reasons` | Section-local map describing unavailable, inapplicable, or unimplemented values. Null does not mean zero. |

## Outcomes and units

`Rise`/`Fall` identify the traded contract direction. Durations carry their Deriv unit (`t`, `s`, `m`, `h`, or `d`); `duration.seconds` is the configured lifetime in seconds. Prices, ATR, distance, slippage, and excursions are in the instrument's quote-price units unless the field says `_atr`. Epochs inside candle arrays are Unix seconds. Rates and confidence bounds are fractions from 0 to 1.

`Win`, `Loss`, and `Tie` preserve contract-result semantics. A tie is a non-win under the Deriv Rise/Fall rule. The `hindsight` classification is anecdotal per trade; use the aggregate calibration dissent report for comparisons, and do not interpret small groups as evidence.

Performance reports group by market/playbook and account type. `demo`, `real`, and `shadow` are distinct categories; the report never combines demo and real contracts in a row. `MIN_N_FOR_RANK` defaults to 30 and can be changed in the Performance log control.

The Calibration export reports expiry-probability results both as a descriptive overall curve and separately by `demo` and `real` account type. The account-specific groups should be preferred when comparing execution environments; do not interpret demo calibration as live evidence.

## Data sources and caveats

The selected Deriv contract fields are authoritative for a traded result. Shadow results use real ticks with entry at the first tick after decision and the same duration/tie rules; they are not live contracts. Tick-flow/delta and any rate estimates are price-path proxies. Overlapping signal windows are dependent. An unavailable field has a reason in `null_reasons`; it must not be imputed as zero.
