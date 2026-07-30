# FUTURE PROJECT — Phase 1i: gridSet DOM-Text Helper

The third micro-slice carved out of the deferred Deriv trade-execution block — the one Phase 1h flagged as needing its own dedicated per-caller review before moving, given its 59 external call sites.

## Extraction plan (produced before any code was touched)

- **Target**: `gridSet` — a single line, index.html line 27923: `function gridSet(id, txt){ const e = $(id); if (e) e.textContent = txt; }`.
- **Reads**: `$` only (already bridged read-only since Phase 1e).
- **Writes**: none external — only mutates the DOM element it looks up.
- **Bridge requirement**: none new.
- **Closures**: none.
- **Hidden global state**: none.
- **Per-caller review** (the specific diligence this slice needed): all 59 call sites were enumerated and their locations checked against the Phase 8 sealed region (lines 4361–4362 — nowhere near any of them) and against every already-shipped module (`mfxBot.js`, `dabBot.js`, `aggressionBot.js`, `fiveTickSignalEngine.js`, `featureEngineering.js`, `multiplierHelpers.js`, `gridStatusUi.js` — none reference `gridSet` directly). The 59 sites span the RFA "Risk-Free Auto" scanner, the still-inline Deriv connect/session/trade flow, engine and digit auto-fire status displays, chart indicator readouts, and OU payout statistics — all classic-script functions invoked only at runtime (page load, ticks, clicks, WS messages), confirmed to execute only after this module would have finished loading.
- **Producer-side export needed**: `window.gridSet`, the same pattern as every prior producer slice.
- **Independent-reversibility decision**: rather than append `gridSet` to the just-shipped `gridStatusUi.js` (Phase 1h) despite the thematic overlap (both are trivial grid-UI helpers), it was kept as its own new module, `src/trading/gridSetHelper.js`. Appending to an already-verified, already-delivered file would have entangled this slice's rollback with Phase 1h's, violating the standing "each extraction independently reversible" rule.
- **Target path**: `src/trading/gridSetHelper.js`.

## Verification performed

- **`diff`**: the module's single line of extracted code is byte-for-byte identical to the original inline line.
- **`node --check`** on `gridSetHelper.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/gridSetHelperExtraction.test.mjs`, 7 tests): module reference exists; old inline `gridSet` is gone; `gridSetHelper.js` and `gridStatusUi.js` both still appear, independently, in original document order at the old code's location; the bridge is unchanged (still ≥23 entries, none added); the module exports `window.gridSet`; the remaining Deriv-flow state/functions are confirmed untouched; seal markers unaffected. All 7 pass.
- **Full suite, first run**: 681/682 — **one pre-existing test failed**: Phase 1h's own `gridStatusUiExtraction.test.mjs` had asserted "`gridSet` must remain inline" as part of confirming *that* round's boundary. That assertion was true when Phase 1h shipped it, and became false the moment this round deliberately moved `gridSet` out — not a real regression, just a test whose premise was time-bound and needed updating once the thing it was checking legitimately changed. Fixed by removing the now-superseded `gridSet`-specific assertion from that test (the `gridWs`/`gridPlaceTrade` checks, which are still true, were kept), with an explanatory comment pointing to this round. Disclosed rather than silently patched.
- **Full suite, after fix**: 682/682 (675 after Phase 1h, plus 7 new tests this round).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 682/682, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`gridSetHelper.js`, the new test file, the amended `gridStatusUiExtraction.test.mjs`, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (do all 59 status displays across the RFA scanner, Deriv flow, engine/digit auto-fire, chart readouts, and OU payout stats still update correctly). No browser is available in this sandbox.

## Risks discovered

- **This is now the second time a guardrail test from an earlier slice broke because a *later*, legitimate slice moved something the earlier test had asserted "stays inline for now."** This is an expected, not concerning, pattern given how this project's guardrail tests double as point-in-time boundary snapshots — but it means every future slice in this block should explicitly grep prior `tests/refactor/*.test.mjs` files for assertions about the specific identifiers it's about to move, before extracting, to catch this class of staleness proactively rather than reactively via a failing suite.
- No new correctness risks specific to `gridSet` itself were found — it is the simplest possible function (no state, no branching beyond an existence check) and the highest-call-count identifier in this project's extraction history is also its lowest-complexity one.

## What did NOT change

- `gridSet`'s own logic: unchanged, confirmed by `diff`.
- All remaining Deriv-flow functions and state (`gridConnState`/`gridDiag` now live in `gridStatusUi.js`; everything else — `gridWs`/`gridAuthed`/etc., `gridPageInit`, `gridStartLogin`, `gridCheckSession`, and the connect/message/trade-execution functions — is still inline, confirmed by guardrail test.
- `gridStatusUi.js`, `multiplierHelpers.js`, `aggressionBot.js`, `fiveTickSignalEngine.js`, `featureEngineering.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- The shared bridge: zero lines added or changed this round.

## Rollback

`phase1i_gridsethelper_index_html.patch` (a 1-for-1 line swap: the inline function line replaced with one module tag) plus deleting `src/trading/gridSetHelper.js` fully reverts this slice — independent of Phase 1h and every other prior extraction, by design.

## Status / next step

The remaining Deriv-flow block is now 535 lines / 15 functions, all state declarations, and no more standalone UI-status helpers. The next tier is session/account-management (`gridPageInit`, `gridStartLogin`, `gridCheckSession`, `gridHandleRedirectReturn`, `gridCheckSessionWithRetry`, `gridLoadAccounts`, `gridBuildPicker`, `gridMergeAccounts`, `gridSelectAccountFromPicker`), followed last by the WebSocket connect/message/trade-execution functions (`gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade`), which remain the highest-risk, highest-traffic, and most operationally sensitive code in the entire safe zone.
