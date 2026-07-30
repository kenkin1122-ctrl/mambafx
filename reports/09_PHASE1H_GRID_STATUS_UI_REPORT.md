# FUTURE PROJECT — Phase 1h: gridConnState / gridDiag UI-Status Helpers

The second micro-slice carved out of the deferred Deriv trade-execution block, per Phase 1g's recommendation to take the pure UI helpers next.

## Extraction plan (produced before any code was touched)

- **Target**: `gridConnState` and `gridDiag` — index.html lines 27924–27943 (20 lines), located and confirmed exact the same programmatic way as every prior slice.
- **Reads**: `$` (already bridged read-only since Phase 1e) and, newly, `gridLoggedIn` inside `gridConnState` (`!gridLoggedIn` gates the Connect button's disabled state). `gridLoggedIn` is a `let` declared inline (`let gridLoggedIn = false;`, still in the classic script, written by `gridCheckSession` and `gridHandleMsg`/`gridDisconnect`, none of which are extracted this round) — this is the first genuinely new bridge dependency since Phase 1e; neither `mfxBot.js` nor `dabBot.js` needed it.
- **Writes**: none. Both functions only read state and mutate DOM elements.
- **Bridge requirement**: one new getter-only entry, `bridgeReadOnly('gridLoggedIn', () => gridLoggedIn)` — getter-only because this module only reads the value; the writer (`gridCheckSession`) stays inline and continues to update the real binding directly.
- **Closures**: none beyond the functions' own local DOM lookups.
- **Hidden global state**: none beyond the above.
- **Producer-side exports needed**: both functions, confirmed by occurrence counts scoped to this specific 20-line boundary (not the whole deferred block): `gridConnState` has 8 external call sites, all inside still-inline `gridConnect`/`gridHandleMsg`/`gridDisconnect`/`gridLogout`; `gridDiag` has 13 external call sites, including two in a not-yet-analyzed area further down the file (a "Matches" trading section, likely part of the still-unassessed Digit-trading/master-score territory). All call sites are inside classic-script functions that only execute at runtime events (WS connect, message receipt, trade placement), long after this module has finished loading — no execution-order risk despite the higher call counts than earlier slices.
- **Deliberately left untouched**: `gridSet` (the adjacent one-line helper, deferred — its 59 external call sites warrant its own dedicated verification pass before moving it), `gridWs`/`gridAuthed`/etc. state, and all remaining connect/session/message/trade functions.
- **Target path**: `src/trading/gridStatusUi.js`.

## Verification performed

- **Extraction boundary** located programmatically and confirmed exact (20 lines).
- **`diff`** confirms the module's extracted body (first 20 lines, before the export block) is byte-for-byte identical to the original inline block.
- **`node --check`** on `gridStatusUi.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/gridStatusUiExtraction.test.mjs`, 6 tests): module reference exists; old inline `gridConnState`/`gridDiag` are gone; `gridSet` and the untouched Deriv state/functions are confirmed still present inline; the bridge grew by exactly one entry (now 23, with the new `gridLoggedIn` getter-only entry explicitly checked); the module exports both functions on `window`; seal markers unaffected. All 6 pass.
- **Full suite, first run**: 673/675 — **2 pre-existing tests failed**, both from earlier slices (`aggressionBotExtraction.test.mjs`, `multiplierHelpersExtraction.test.mjs`), each asserting the bridge had *exactly* 22 entries. That assertion was correct at the time those tests were written but became stale the moment this round's new `gridLoggedIn` entry brought the total to 23 — not a real regression, but a test that over-specified an exact count instead of a floor. Fixed by changing both assertions from "exactly 22" to "at least 22, with a note that later slices may add more," and re-running: **675/675 pass.** This is disclosed rather than silently patched over, since a failing test briefly existed mid-round.
- **Full suite, after fix**: 675/675 (669 after Phase 1g, plus 6 new tests this round, all passing once the two stale assertions were corrected).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 675/675, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`gridStatusUi.js`, the new test file, the two amended test files, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (does the connection status dot/text still update, do the CORS/network diagnostic messages still render). No browser is available in this sandbox.

## Risks discovered

- **Stale exact-count assertions are a maintenance hazard for this style of guardrail test.** Two earlier tests asserted the bridge's total entry count with strict equality; each new bridge addition in a later slice invalidates them. Both have now been loosened to a floor check. Future bridge-count assertions in new tests should default to a floor (`>=`) rather than exact equality, unless the test is specifically about verifying zero-growth for its own slice (in which case it should check its own slice added nothing, not assert a global historical total).
- `gridDiag`'s two call sites in the not-yet-analyzed "Matches" trading section (further down the file, likely inside the Digit-trading or master-score territory) are a preview of how widely some of these small helpers reach — worth keeping in mind when planning that section's own future analysis.

## What did NOT change

- `gridConnState`/`gridDiag`'s own logic: zero lines rewritten, confirmed by `diff`.
- `gridSet`, `gridWs`/`gridAuthed`/etc., and all remaining Deriv-flow functions: untouched, confirmed by guardrail test.
- `multiplierHelpers.js`, `aggressionBot.js`, `fiveTickSignalEngine.js`, `featureEngineering.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region (re-confirmed: sealed markers are at lines 4361/4362 area, nowhere near this round's edits in the 27900s/32000s).
- Any IndexedDB schema, database name, or version.

## Rollback

`phase1h_gridstatusui_index_html.patch` (38 lines: one new bridge line, remove the 20-line inline block, add one module tag) plus deleting `src/trading/gridStatusUi.js` fully reverts this slice, independent of every prior extraction. The bridge addition and the function extraction are both mechanical and can be reverted together via this one patch.

## Status / next step

The remaining Deriv-flow block is now 536 lines / 16 functions. `gridSet` (59 external references, still deferred) is the next logical UI-helper candidate but needs its own dedicated per-caller review given its reach. After that, session/account-management functions (`gridPageInit`, `gridStartLogin`, `gridCheckSession`, `gridHandleRedirectReturn`, `gridCheckSessionWithRetry`, `gridLoadAccounts`, `gridBuildPicker`, `gridMergeAccounts`, `gridSelectAccountFromPicker`) are the next tier, followed last by the WebSocket connect/message/trade-execution functions (`gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade`), which remain the highest-risk, highest-traffic, and most operationally sensitive code in the entire safe zone.
