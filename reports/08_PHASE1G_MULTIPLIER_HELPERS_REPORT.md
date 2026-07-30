# FUTURE PROJECT — Phase 1g: Multiplier-Helpers Micro-Slice

A correction to Phase 1f's risk assessment, and the first slice carved out of the previously-deferred Deriv trade-execution block.

## Correction to Phase 1f: the risk was in moving the declarations, not the functions

Phase 1f deferred the whole Deriv auth/connect/trade-execution subsystem (565 lines, 24 functions) because it owns the `gridWs`/`gridAuthed`/etc. `let` declarations that the existing bridge already exposes to `mfxBot.js`/`dabBot.js`. On closer analysis before writing any code this round, that risk is specifically about **moving the declaration site** — if `let gridWs = null, ...` moves into a module, the bridge's `() => gridWs` closures lose their binding and throw `ReferenceError` on first read.

That risk does not apply to extracting *functions* from the same block, as long as the declarations stay exactly where they are. A function can move into a module and keep reading/writing `gridWs` correctly through the same bridge `mfxBot.js`/`dabBot.js` already use — multiple modules sharing one bridged accessor is exactly what the bridge was built for. This is architecturally identical to every extraction already completed; the only new wrinkle is that some Deriv-flow functions also need fresh producer-side `window.*` exports (the same pattern as `fiveTickSignalEngine.js`), since large parts of the remaining safe zone (Digit circles, the master-score engine) call them by bare name.

A full occurrence-count pass across the whole 565-line block confirmed this and revealed the scale of entanglement precisely: `gridWs` has 44 external references still inside `index.html`, `gridSet` has 59. Extracting the block that contains those identifiers is still not attempted whole — that scale of external dependency needs its own careful, function-by-function staged plan, not one slice. But it identified a genuinely small, clean sub-slice within the block: the multiplier-helper functions.

## Extraction plan (produced before any code was touched)

- **Target**: `gridMult`/`digMult`/`engMult`/`gridMultStrat`/`digMultStrat`/`engMultStrat` plus their private lazy-singleton state `_gridMult`/`_digMult`/`_engMult` — index.html lines 27914–27922 (9 lines), located and confirmed exact the same programmatic way as every prior slice.
- **Reads/writes**: the six functions read/write only their own private state and call two external names: `makeMultiplier` (a top-level `function` declaration elsewhere in the classic script — auto-attaches to `window`, no bridge needed) and `$` (already bridged read-only since Phase 1e). No writes to anything external.
- **Bridge requirements**: none. This is the second slice (after Aggression Bot) needing zero new bridge entries.
- **Closures**: none beyond the module's own lazy-singleton pattern (`_gridMult||(_gridMult=makeMultiplier(...))`), unchanged from the original.
- **Hidden global state**: none found beyond the above.
- **Producer-side exports needed**: all six functions, confirmed by a fresh occurrence count against this specific 9-line boundary (not the whole Deriv-flow boundary, which would have been too coarse): `gridMult`/`gridMultStrat` are called from `gridPlaceTrade` (still inline) and a shared multiplier-record callback near the end of the main script; `digMult`/`digMultStrat` and `engMult`/`engMultStrat` are called from the still-inline digit-trading and engine-adjacent auto-fire stake calculations and the same shared callback. All of these remaining callers are classic-script functions that only run at actual trade-firing time, long after module load — no execution-order risk.
- **What stays untouched**: `gridWs`/`gridAuthed`/etc. declarations, `gridArmed`/`gridAutoCount`/`gridLastAutoAt`/etc. (the block immediately following), and all 24 connect/session/message/trade functions remain exactly where they were, fully inline.
- **Target path**: `src/trading/multiplierHelpers.js`, consistent with the existing `src/trading/` convention.

## Verification performed

- **Extraction boundary** located programmatically and confirmed exact (9 lines).
- **`diff`** confirms the module's extracted body (first 9 lines, before the export block) is byte-for-byte identical to the original inline block.
- **`node --check`** on `multiplierHelpers.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/multiplierHelpersExtraction.test.mjs`, 7 tests): module reference exists; old inline multiplier-helper code is gone; the deliberately-untouched `gridWs`/`gridAuthed` declaration, `gridPlaceTrade`, and the immediately-following `gridArmed` declaration are all confirmed still present inline (a direct check that this slice's boundary was respected exactly); the bridge still has exactly 22 entries (this slice added none); the module exports all six functions on `window`; the three private state variables are never exposed; seal markers unaffected. All 7 pass.
- **Full suite**: 669/669 (662 + 7 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 669/669, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`multiplierHelpers.js`, the test file, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (do stake multipliers still compute and apply correctly on live trades across all three bots). No browser is available in this sandbox.

## Risks discovered

- The scale of `gridSet`'s external usage (59 references across the file, mostly in not-yet-analyzed later sections) confirms that the remaining Deriv-flow functions vary enormously in blast radius — `gridSet` is a much bigger commitment to extract correctly than, say, `gridDiag` (3 external references) or `gridConnState` (0). Any future slice from this block should re-run this same occurrence-count check per-function before proceeding, rather than assuming similar risk across the whole remaining block.
- No new risks specific to this slice were found; it is fully isolated from the state-ownership problem.

## What did NOT change

- The multiplier-helpers' own logic: zero lines rewritten, confirmed by `diff`.
- `gridWs`/`gridAuthed`/etc. and all 24 remaining Deriv-flow functions: untouched, confirmed by guardrail test.
- `aggressionBot.js`, `fiveTickSignalEngine.js`, `featureEngineering.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- The shared bridge: zero lines added or changed this round (still 22 entries).

## Rollback

`phase1g_multiplierhelpers_index_html.patch` (19 lines, entirely mechanical: remove the 9-line inline block, add one module tag) plus deleting `src/trading/multiplierHelpers.js` fully reverts this slice, independent of every prior extraction.

## Status / next step

The remaining Deriv-flow block is now 556 lines / 18 functions (`gridSet`, `gridConnState`, `gridDiag`, `gridPageInit`, `gridStartLogin`, `gridCheckSession`, `gridHandleRedirectReturn`, `gridCheckSessionWithRetry`, `gridLoadAccounts`, `gridBuildPicker`, `gridMergeAccounts`, `gridSelectAccountFromPicker`, `gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade`) plus the `gridWs`/`gridAuthed`/etc. state declarations, `gridArmed`/`gridAutoCount`/`gridLastAutoAt`/`gridPageInited`/`gridLoggedIn`/`gridAccounts`. Per this round's occurrence-count data, the lowest-risk next candidates within it are the pure UI helpers with few or zero external references — `gridConnState` (0 external references) and `gridDiag` (3) — as a possible next micro-slice, followed by session/account-management functions, leaving the WebSocket connect/message/trade-execution functions (`gridConnect`, `gridWsSubscribeAndInit`, `gridHandleMsg`, `gridPlaceTrade`) for last, given they are both the highest-traffic (highest external reference counts) and most operationally sensitive (real-money trade execution) code in the block.
