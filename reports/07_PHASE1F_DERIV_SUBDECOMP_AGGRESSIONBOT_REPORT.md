# FUTURE PROJECT — Phase 1f: Deriv Block Sub-Decomposition + Aggression Bot Extraction

This round started by re-confirming the sub-decomposition report's boundaries for the next planned slice ("Deriv login/WS flow," 703 lines) before touching any code, per the standing "re-confirm dependency boundaries before extracting" discipline. That re-confirmation surfaced a finding serious enough to change the plan: the 703-line region is not one subsystem. It's two, interleaved. This report covers both — why the larger one is being deferred, and the smaller one that was extracted instead.

## Discovery: the "Deriv login/WS flow" is actually two interleaved subsystems

Reading the full 703-line region (index.html, banner "DERIV TRADE EXECUTION (authorized WebSocket)" through the line before the next section's banner) line by line, rather than trusting the earlier report's aggregate dependency count, showed it contains:

1. **The Deriv auth/connect/trade-execution flow itself** — `BACKEND_URL`, `ACCTID_KEY`, the `gridWs`/`gridAuthed`/`gridLoginId`/`gridBalance`/`gridCurrency`/`gridIsVirtual`/`gridOpenContracts`/`gridTrades`/`gridReqId`/`gridPending`/`gridConnecting` state declarations, the multiplier helpers, and ~25 functions (`gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade`, session/account-picker handling, etc.).
2. **The Aggression Bot** — a self-contained, unrelated feature (buy/sell aggression scoring within the live 1-minute candle) that happens to sit physically nested between two of the Deriv flow's functions (`gridCheckSession` and `gridHandleRedirectReturn`), under its own internal banner comment.

This matters because of what (1) actually is: **the declaration site** of the `gridWs`/`gridAuthed`/etc. state that the existing `window.*` accessor bridge (built in Phase 1b) already exposes to two already-shipped modules, `mfxBot.js` and `dabBot.js`. The sub-decomposition report characterized this section as "the producer of `gridWs`/`gridAuthed`, not just a consumer" — true, but incomplete. It isn't merely a producer; it's where those bindings are `let`-declared in the first place. Moving that declaration into an ES module would mean the classic-script bridge's `bridgeReadWrite('gridWs', () => gridWs, v => { gridWs = v; })` closures would no longer have a `gridWs` binding to close over anywhere in classic-script scope — the first time anything called `window.gridWs` afterward (from `mfxBot.js`, `dabBot.js`, or the bridge's own initialization) would throw `ReferenceError: gridWs is not defined`. Fixing that requires *inverting* the bridge relationship for 11 already-load-bearing identifiers — a materially different, larger, and riskier change than any slice completed so far, since it has to stay correct for two already-shipped, already-tested modules simultaneously, not just the code being moved.

**This exceeds the project's small-safe-slice criteria.** Per the standing instruction to stop and sub-decompose rather than push through, the Deriv auth/connect/trade-execution flow is deferred, not attempted this round. It needs its own dedicated plan — most likely: decide whether the `grid*` state declarations should ever move at all (they're also heavily read by two still-unextracted later sections, "Digit circles/CSV/digit trading" and the "Trading signal/master-score engine," per the original sub-decomposition report), and if so, design the bridge inversion as an explicit, separately-reviewed step with its own smoke tests for both the read and write paths, before any of the ~25 connect/message/trade functions are touched.

## What was extracted instead: the Aggression Bot

The Aggression Bot has none of the above entanglement. It was verified, independently, to be a clean, small, low-risk slice:

- **Boundary**: index.html lines 27992–28131 (140 lines), located programmatically (banner-comment-to-closing-brace), confirmed exact.
- **Declarations**: `AGG_TF`, `AGG_HIST_MAX`, `AGG_ROLL_N` (consts), `aggCur`/`aggHistory`/`aggLastPrice`/`aggPageReady`/`aggAlerts` (state), `aggNewCandle`/`aggScoreOf`/`aggFinalizeCandle`/`aggRenderAll` (functions) — a whole-file occurrence count (total references vs. references strictly inside the section) confirmed **zero** external references to any of these nine identifiers.
- **Producer-side exports needed** (same pattern as Phase 1d/1e): `aggOnTick` (1 external call site — the main tick handler, guarded by `typeof aggOnTick === "function"`), `aggPageInit` (1 external call site — the page-switch handler, same guard style), `aggManualTrade` (2 external call sites — `onclick="aggManualTrade(1)"`/`onclick="aggManualTrade(-1)"` on the manual buy/sell buttons, which compile lazily at first click).
- **External reads this module makes**: `decimals` (already bridged read-write since Phase 1b — no change needed) and `drawCandleChart` (a top-level `function` declaration in the classic script, which auto-attaches to `window` — bare-name fallthrough resolves it with zero bridge changes, same reasoning as `msdSafeMin`/`msdSafeMax` in Phase 1d).
- **Hidden global state check**: `aggManualTrade` calls `gridPlaceTrade` (from the *deferred* Deriv flow) via the same `typeof`-guard convention. `gridPlaceTrade` is a top-level `function` declaration, not `let`/`const` — already implicitly on `window`, so this dependency needed no bridge work either, and is unaffected by the Deriv flow remaining un-extracted.
- **Closures**: none beyond the module's own internals; `aggRenderAll` defines its own local `$id` helper (`const $id = id => document.getElementById(id);`), distinct from and not colliding with the shared bridged `$`.
- **Net result: zero new bridge entries.** This is the first slice in the project needing none at all.

Module placed at `src/trading/aggressionBot.js`, consistent with the existing `src/trading/` convention (`fiveTickSignalEngine.js`).

## Verification performed

- **Extraction boundary** located programmatically and confirmed exact (140 lines).
- **`diff`** confirms the module's extracted body (first 140 lines, before the export block) is byte-for-byte identical to the original inline block.
- **`node --check`** on `aggressionBot.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/aggressionBotExtraction.test.mjs`, 7 tests): module reference exists; old inline Aggression Bot code is gone; the deliberately-untouched `gridWs`/`gridAuthed` declaration and `gridPlaceTrade` function are confirmed still present inline (a direct check that this slice did NOT touch the deferred subsystem); the bridge has exactly the 22 entries accumulated through Phase 1e (this slice added none); the module exports `window.aggOnTick`/`window.aggPageInit`/`window.aggManualTrade`; none of the 9 purely-internal identifiers are exposed on `window`; seal markers unaffected. All 7 pass (one initial test-authoring mistake — a bridge-entry regex that accidentally matched the two `bridgeReadOnly`/`bridgeReadWrite` function *definitions* in addition to their call sites, giving 24 instead of 22 — was caught by the test itself failing, then fixed to match only actual call sites).
- **Full suite**: 662/662 (655 + 7 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 662/662, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`aggressionBot.js`, the test file, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (does the Aggression page still render live scores, do the manual buy/sell buttons still fire trades via `gridPlaceTrade`, does the candle chart still draw). No browser is available in this sandbox.

## What did NOT change

- The Aggression Bot's own logic: zero lines rewritten, confirmed by `diff`.
- **The Deriv auth/connect/trade-execution flow: entirely untouched**, by design — `gridWs`/`gridAuthed`/etc. remain declared exactly where they were, `gridPlaceTrade` and all ~25 other functions remain inline. This is the deferred subsystem described above.
- `fiveTickSignalEngine.js`, `featureEngineering.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- The shared `window.*` accessor bridge: zero lines added or changed this round.

## Rollback

`phase1f_aggressionbot_index_html.patch` (150 lines, entirely mechanical: remove the 140-line inline block, add one module tag — no bridge lines touched) plus deleting `src/trading/aggressionBot.js` fully reverts this slice, independent of every prior extraction.

## Status / next step

Per the sub-decomposition report's original ordering, "Digit circles/CSV/digit trading" and the "Trading signal/master-score engine" were already recommended only *after* the Deriv flow, specifically because they also depend on `grid*` state. Given the Deriv flow itself is now deferred pending its own bridge-inversion plan, those two remain blocked on the same prerequisite and should not be attempted next either. The "Market State Search Tool" and "Research Session Manager" remain explicitly not recommended (per the original report). Blocks 8/9 remain deferred, still blocked on the sealed-region `MSD_LABEL_VERSION` dependency.

At this point, every remaining un-extracted section in the safe zone is coupled to `grid*` state in some way except ones already done. The responsible next step is not another extraction, but the dedicated Deriv-flow decomposition/bridge-inversion plan this report identifies as the prerequisite — recommended as the next unit of work, separate from and prior to any further widget/engine-style extraction.
