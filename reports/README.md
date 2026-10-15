# BAZU quant-analysis export

The Signal log download contains one JSON record per BAZU signal. Header fields identify the software build, config snapshot, decision timestamp, market, and whether Deriv actually accepted a contract. The account type (`demo` or `real`) and contract id are intentionally included; tokens, account numbers, loginids, balances, and secrets are never recorded.

Sections **A-E** are the information available at decision/buy time: A is signal metadata and lifecycle; B contains point-in-time candles and market-condition readings; C captures the current market state; D records structure and room checks; E contains the predictions, factor/family dissent, opposite-direction comparison, and sensitivity analysis. Sections **F-G** are appended later. They describe contract settlement, tick-path outcomes, excursions, hindsight attribution, and post-expiry context. **F and G did not exist at decision time and must never be used as predictors** in a backtest or model.

Deriv synthetic-index candle volume is not available as traded volume in this application. Tick-flow, tick delta, and intensity are proxies derived from the price path/tick timestamps, not order flow or real volume. The displayed score is a rule-based confluence score, not a probability.

The app uses the first tick after the decision as the hypothetical entry and the duration's tick/time expiry rule for the exit. Deriv's contract result is the source of truth for a traded contract. A tie (exit equals entry) loses. Logged shadow outcomes use real tick history and are labelled separately from traded contracts. Decision-to-entry slippage and latency come from Deriv entry fields when available; censored windows and unavailable readings are explicitly identified.

The browser app stores records locally in its versioned `bazu_siglog` IndexedDB database; it does not upload them to a server. The existing research DB extension is deliberately not reused because it is specific to `mfx_msd_experiments` and its experiment stores; BAZU instead uses an isolated database with guarded versioned upgrades. `SIGNAL_LOGGING_ENABLED` is the kill switch (default on), untraded records are off by default, completed records are capped at 5,000 with a 60-day retention default, and pending windows are kept for up to two days unless the hard record cap requires eviction. Storage/quota failures are surfaced in the Signal log status and never feed trading decisions. Export downloads are the only app-created files; the optional folder picker is user initiated.

Known limitations: samples may be small, signals can overlap and are not independent, markets/sessions may be underrepresented, demo outcomes are not proof of live execution, quote and contract execution may differ from a shadow path, and outcomes from small dissent groups are not evidence. The signal-time expiry probability is the unadjusted zero-drift analytic baseline (decision price as both spot and entry); it is not a calibrated probability. The Calibration report uses the existing live-contract half-time reliability curve when available. Build id and commit hash are null unless injected with `globalThis.MAMBAFX_BUILD`. The manifest hashes every package member other than `manifest.json` itself because a manifest cannot contain a stable hash of its own final bytes.

## Package files

- `logs/signals/YYYY-MM-DD/<market>/signal_<uuid>.json`: individual validated records.
- `signals_summary.csv`: one compact row per exported signal.
- `signals.ndjson`: the same records as newline-delimited JSON.
- `manifest.json`: schema/build/config/date metadata and SHA-256 hashes of package files other than the manifest itself.
- `schema/signal.schema.json`: JSON Schema; the app's `validateRecord` additionally checks that every null has a reason.
- `data_dictionary.md`: field overview and outcome semantics.
- `samples/`: synthetic fixtures for format and loader verification. They are not live Deriv trades or evidence of strategy performance.
- `samples/performance_results.json`: one synthetic browser benchmark run for logger overhead and export main-thread long tasks; it is not a live-market performance claim.

## Statistical interpretation

Wilson intervals are used for rates. Calibration's expiry-probability bins include Wilson intervals for observed rates, and Brier scores include deterministic bootstrap intervals when samples are available. Aggregate factor/family dissent tables include N, confidence intervals, and same-duration opposite-direction shadow outcomes. Groups below `MIN_N_FOR_RANK` are marked insufficient sample. Group differences at small N are not evidence of an edge.

The Performance log partitions traded outcomes by demo/real account type and labels hypothetical rows as `shadow`; it never pools demo and real results in one row. With no account filter, those account categories remain separate in the output.
