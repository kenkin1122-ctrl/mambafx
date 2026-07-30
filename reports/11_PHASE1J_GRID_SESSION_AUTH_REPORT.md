# FUTURE PROJECT — Phase 1j: Deriv Session/Account-Management Extraction

The next tier from Phase 1i's roadmap — session and account-management functions, extracted as one module split around the already-shipped Aggression Bot.

## Extraction plan (produced before any code was touched)

- **Target**: nine functions — `gridPageInit`, `gridStartLogin`, `gridCheckSession`, `gridHandleRedirectReturn`, `gridCheckSessionWithRetry`, `gridLoadAccounts`, `gridBuildPicker`, `gridMergeAccounts`, `gridSelectAccountFromPicker` (175 lines total).
- **Non-contiguous boundary**: this range is physically split by the `src/trading/aggressionBot.js` module tag (Phase 1f), which sits between `gridCheckSession` and `gridHandleRedirectReturn`. Boundaries confirmed precisely: Part A = lines 27926–27962 (`gridPageInit` through the end of `gridCheckSession`, 37 lines), then the untouched Aggression Bot tag and its structural comment lines, then Part B = lines 27967–28104 (`gridHandleRedirectReturn` through the end of `gridSelectAccountFromPicker`, 138 lines). Both parts moved into one module, concatenated in original order; the Aggression Bot tag was left exactly where it was.
- **Reads/writes discovered**:
  - `gridLoggedIn` — previously bridged **read-only** in Phase 1h (which only read it). This slice's `gridCheckSession` **writes** it (`gridLoggedIn = !!(body && body.logged_in);`, `gridLoggedIn = false;`) — the first time a moved function needed to upgrade an existing bridge entry's access mode, not just add a new one.
  - `gridAccounts` — reassigned (`gridAccounts = raw.map(...)`), not just mutated in place — needs read-write, not the getter-only treatment used for objects like `gridPending`/`_acctData`.
  - `gridPageInited` — read and written (`if (gridPageInited) return; gridPageInited = true;`) — read-write.
  - `BACKEND_URL`, `ACCTID_KEY` — both `const`, never reassigned — read-only.
  - `_acctData` — a `const` object (`const _acctData = {};`), only ever mutated in place (`_acctData[a.account_id] = {...}`), never reassigned — read-only, same pattern as `gridPending`.
  - `MARKETS`, `SYMBOL`, `$`, `gridSet`, `gridDiag`, `gridConnState` — all already bridged/exported by earlier slices, no changes needed.
  - `renderSignalTable`, `renderGridTrades`, `showPage` — all top-level `function` declarations in the classic script, auto-attached to `window`, no bridge needed (verified by checking their declaration keyword before assuming).
  - `localStorage`, `fetch`, `URLSearchParams`, `window.location`, `Promise`, `setTimeout` — standard browser/JS globals, always available.
- **Bridge changes**: one upgrade (`gridLoggedIn`: read-only → read-write) plus five new entries (`gridAccounts`, `gridPageInited` read-write; `BACKEND_URL`, `ACCTID_KEY`, `_acctData` read-only). Bridge total: 23 → 28.
- **Closures**: none beyond the functions' own local logic.
- **Hidden global state**: none found beyond what's listed above.
- **Producer-side exports needed**: verified by occurrence count scoped to the actual (split) boundary, not assumed. `gridPageInit` (1 external caller — the page-switch handler), `gridStartLogin` (2 — onclick attributes), `gridHandleRedirectReturn` (1 — the main boot block, after full page load), `gridLoadAccounts` (1 — the not-yet-extracted Accounts-page session-refresh code), `gridMergeAccounts` (1 — the still-inline `gridWsSubscribeAndInit`), `gridSelectAccountFromPicker` (1 — an onchange attribute). `gridCheckSession`, `gridCheckSessionWithRetry`, and `gridBuildPicker` have zero external references (called only by their siblings in this same module) and are not exported.
- **Target path**: `src/trading/gridSessionAuth.js`.

## Verification performed

- **Extraction boundaries** (both parts) located and confirmed exact via precise line-content checks, not manual counting.
- **`diff`** confirms both extracted parts, concatenated with a single joining blank line, are byte-for-byte identical to the original inline code (modulo that one intentional joining line, itself confirmed necessary since the two parts were separated by the Aggression Bot tag in the original file).
- **`node --check`** on `gridSessionAuth.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **Aggression Bot tag integrity**: explicitly re-confirmed present, untouched, and still positioned correctly relative to the new module tag (`gridSessionAuth.js` before `aggressionBot.js`, preserving original document order).
- **New guardrail tests** (`tests/refactor/gridSessionAuthExtraction.test.mjs`, 7 tests): module reference exists and precedes the untouched Aggression Bot tag; old inline functions are gone; remaining Deriv state/connect functions confirmed untouched; all six bridge changes (the upgrade plus five new entries) are present and the old read-only `gridLoggedIn` entry is confirmed gone (not duplicated); bridge total is exactly 28; the six functions with real external callers are exported, the three internal-only ones are not; seal markers unaffected. All 7 pass.
- **Full suite, first run**: 687/689 — **two more pre-existing tests failed**, the same class of staleness as Phase 1i: `gridSetHelperExtraction.test.mjs` had asserted `gridPageInit` remained inline (true when Phase 1i shipped, false now that this round moved it), and `gridStatusUiExtraction.test.mjs` had asserted the bridge held exactly 23 entries (true after Phase 1h, false now that this round added five more and changed one). Both fixed: the `gridPageInit` check removed from the first (with an explanatory note), the bridge-count assertion loosened to a floor check plus a "still has *a* `gridLoggedIn` entry, in whatever form" check in the second.
- **Full suite, after fix**: 689/689 (682 after Phase 1i, plus 7 new tests this round).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 689/689, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`gridSessionAuth.js`, the new test file, both amended test files, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (does the Deriv login flow, session check, account picker, and redirect-return handling still work end-to-end against the live backend). No browser is available in this sandbox.

## Risks discovered

- **Bridge-entry access-mode upgrades are a new, distinct risk category from adding new entries.** Upgrading `gridLoggedIn` from read-only to read-write required removing the old entry rather than just adding a new one alongside it — a duplicate `Object.defineProperty` call for the same `window` property would either throw (if the first definition wasn't `configurable`) or silently have the second definition win, depending on order. This was handled correctly here (old entry replaced, not duplicated), and a guardrail test explicitly checks the old read-only form is gone. Future slices that need to upgrade an existing bridge entry should follow this same replace-don't-duplicate pattern and add the same kind of check.
- **Third consecutive round where an earlier slice's guardrail test broke from a later, legitimate change.** This is now a established, expected pattern for this block specifically (state and functions keep moving further out of the classic script, invalidating "still inline" assertions from earlier rounds) — worth explicitly scanning prior `tests/refactor/*.test.mjs` for assertions about any identifier before starting the next slice, rather than discovering it via a failing suite each time.
- The split-boundary mechanics (extracting a non-contiguous range around an existing module tag) worked cleanly, but required extra care in the line-splice script (removing the later range first, to avoid invalidating the earlier range's indices) — worth remembering for any future slice that also needs to route around an already-shipped module tag sitting in the middle of a target range.

## What did NOT change

- All nine functions' own logic: zero lines rewritten, confirmed by `diff`.
- `aggressionBot.js` and its module tag: completely untouched, explicitly re-verified.
- The remaining Deriv-flow state (`gridWs`/`gridAuthed`/etc.) and connect/message/trade-execution functions (`gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade`): untouched, confirmed by guardrail test.
- `gridSetHelper.js`, `gridStatusUi.js`, `multiplierHelpers.js`, `fiveTickSignalEngine.js`, `featureEngineering.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region (re-confirmed at lines 4361/4362, unaffected by edits in the 27900s/28000s/32200s).
- Any IndexedDB schema, database name, or version.

## Rollback

`phase1j_gridsessionauth_index_html.patch` (203 lines: the bridge upgrade plus five new bridge lines, removal of both non-contiguous code ranges, addition of one module tag) plus deleting `src/trading/gridSessionAuth.js` fully reverts this slice, independent of every prior extraction — including Phase 1f's Aggression Bot, which this patch does not touch.

## Status / next step

The remaining Deriv-flow block is now down to state declarations plus six functions: `gridConnect`, `gridWsSubscribeAndInit`, `gridLogout`, `gridDisconnect`, `gridHandleMsg`, `gridPlaceTrade` — the WebSocket connect/message/trade-execution core. This is the highest-risk, highest-traffic, and most operationally sensitive remaining code in the entire safe zone (real-money trade placement, live WebSocket lifecycle). Per the standing discipline, this should not be attempted as a single slice without first re-running the same fresh dependency analysis on each function individually — several of them (`gridConnect` especially) are long and likely to have a wide dependency footprint given everything seen so far in this block.
