# FUTURE PROJECT — Phase 1d: 5-Tick Signal Engine Extraction

The top-ranked candidate from `MSD_FUTURE_PROJECT_PHASE2_SUBDECOMPOSITION.md` is now a real ES module. This is the first extraction in this project where the section being moved is a **producer** of state/functions consumed elsewhere, not just a consumer — that distinction shaped the approach below.

## What moved

`index.html`'s 5-tick signal engine block — 428 lines, exactly matching the sub-decomposition report's line count (`const ENG = {...}` config, engine state, `engineOnTick`/`engineMetrics`/`renderEngine` and their rendering helpers) — is now `src/trading/fiveTickSignalEngine.js`, loaded via `<script type="module" src="src/trading/fiveTickSignalEngine.js"></script>`. `index.html`: 35,337 → 34,910 lines (-427 net: 428 lines removed, 1 module tag added).

The extraction boundary was located precisely (banner comment to closing brace) via a small Node script rather than manual line counting, to avoid an off-by-one error — confirmed to land exactly on lines 27784–28211 (1-based), matching the sub-decomposition report's "428 lines" figure exactly.

## Why this slice needed a new pattern, not just the existing bridge

Every extraction so far (`debugPanel`, `mfxBot`, `dabBot`) moved code that only *reads* main-script state — the existing accessor bridge (a classic `<script>` block with closure access to the main script's `let`/`const` bindings) solved that by exposing those bindings as `window.*` accessors for the moved-out ES module to read.

This section is different: the classic main script reads and writes **this section's own** state from outside it:

- `ENG` (a `const` config object) — read via `ENG.K`/`ENG[key]` and its properties are **written** by the engine's threshold sliders (`ENG[key] = Number(s.value)`, `ENG.NOISE = ...`, at what were index.html lines 33508/33517/33520).
- `engPageReady` (a `let` boolean) — **set** to `true` when the Engine page is opened (former line 25736) and **read** by the slider handlers (former lines 33510, 33520).
- `engineOnTick`, `engineMetrics`, `renderEngine` — called by bare name from the tick handler (`engineOnTick(price, epoch, dir);`, former line 3715) and the page-open/slider handlers.

An ES module's top-level declarations don't auto-attach to `window` the way a classic script's top-level `function`/`var` declarations do, and aren't visible by bare name to other classic scripts the way classic-script `let`/`const` declarations are. So once this code left the classic script, all five of these would break at their *external* call sites, not just internally.

The fix is the mirror image of the existing bridge: since the module now *owns* this state, the module itself defines the `window.*` accessors/exports its external callers need, at its own tail end — rather than adding entries to the shared bridge script (which only has closure access to the *main script's* bindings, not this module's). `ENG` gets a getter only (never reassigned, only mutated in place — same reasoning already used for `gridPending` in Phase 1b). `engPageReady` gets both accessors, since it's genuinely written from outside. The three functions get plain `window.fn = fn;` assignments, matching the export pattern already used for e.g. `window.dabFire = dabFire;` in `dabBot.js`.

## Verifying what does and doesn't need exporting

The sub-decomposition report flagged 4 raw cross-section `let`/`const` dependencies for this section: `RUN_LENGTH`, `runDir`, `decimals`, and a likely-noisy `n`. Rather than trust that count directly, each was checked against its actual usage inside the section:

- `RUN_LENGTH` and `decimals`: genuine bare reads (e.g. `if(len>=RUN_LENGTH)`, `gp.toFixed(decimals)`), no local shadowing declaration found — both were already added to the Phase 1b bridge, so **no new bridge entries were needed** for this module's own external reads.
- `runDir`: every occurrence inside the section is a property access (`m.runDir`, `out.runDir`) or object-literal key (`runDir:0`) — never a bare reference to the external `runDir` variable. Confirmed a false positive from the tokenizer's identifier-name matching (it can't distinguish a property name from a variable reference of the same spelling). No bridge entry needed.
- `n`: the sub-decomposition report already flagged this as a likely false positive (common local variable name); not present as a real dependency in this section.

A whole-file occurrence count (total references vs. references strictly inside lines 27784–28212) was also run for all 19 identifiers this section declares, to find every *outside* reference in the other direction (external code reading/calling something this section defines) — this is what surfaced the `ENG`/`engPageReady`/`engineOnTick`/`engineMetrics`/`renderEngine` exports above. The other 14 declared identifiers (`engTicks`, `engCarryDir`, `engPending`, `engStats`, `engLog`, `ENG_BASE`, `engPrevTDabove`, `engPrevAccelPos`, `engTDbrokeAge`, `engAccelPosAge`, `setDivBar`, `renderEngineLog`, `drawEngLine`, `drawEngTickCandles`) had zero references outside the section and are not exported — confirmed by a guardrail test that fails if any of them appears after `window.`.

`msdSafeMin`/`msdSafeMax` (called inside this section) needed no bridge entry either: both are `function` declarations at the main script's top level, which already auto-attach to `window` in a classic script, so bare-identifier fallthrough already resolves them correctly from the new module with no changes required.

## Verification performed

- **The extraction boundary** was located programmatically (banner-comment/closing-brace search), not by manual line counting, avoiding the off-by-one risk that manual `sed` line-range math carries.
- **`diff`** confirms the module's extracted body (its first 428 lines, before the new export block) is byte-for-byte identical to the original inline block.
- **`node --check`** on `fiveTickSignalEngine.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/fiveTickSignalEngineExtraction.test.mjs`, 7 tests): module reference exists; the old inline `const ENG = {` / `function engineOnTick(...)` are gone from `index.html`; the module defines the `window.ENG` getter and `window.engPageReady` read-write accessor; the module assigns `window.engineOnTick`/`window.engineMetrics`/`window.renderEngine`; none of the 14 purely-internal identifiers are exposed on `window`; `index.html` already has the pre-existing `RUN_LENGTH`/`decimals` bridge entries from Phase 1b (confirming no new bridge entries were needed); seal markers unaffected. All 7 pass.
- **Full suite**: 649/649 (642 + 7 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 649/649, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`fiveTickSignalEngine.js`, the test file, `index.html`): all match byte-for-byte.
- **`<script`/`</script>` tag-count sanity check**: the pre-existing imbalance (13 open / 10 close before this change, from string literals elsewhere in the file that happen to contain the substring `<script`, unrelated to this edit) shifted by exactly +1/+1 after this change (14/11) — confirming the edit added exactly one open/close pair and disturbed nothing else.
- **What was NOT verified**: real-browser behavior (does the Engine page still render live metrics, do the threshold sliders still re-tune and repaint, does `engineOnTick` still fire on live ticks). No browser is available in this sandbox.

## What did NOT change

- The 5-tick engine's own logic: zero lines rewritten in the extracted body, confirmed by `diff`. Only a new, clearly-delimited export block was appended after it.
- `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- The shared `window.*` accessor bridge script itself: no lines added or changed (this slice needed zero new bridge entries).

## Rollback

`phase1d_engine_index_html.patch` (438 lines, entirely mechanical: remove the 428-line inline block, add one module tag) plus deleting `src/trading/fiveTickSignalEngine.js` fully reverts this slice, independent of every prior extraction.

## Open decision resolved

The original refactor plan flagged an undecided question — whether trading-signal code belongs under `src/trading/` or `src/ml/` in the target tree. This extraction resolves it in practice: `src/trading/` was used, consistent with the sub-decomposition report's own section label ("Trading signal / master-score engine") for the larger, related section slated for a later round.

## Status / next step

Per the sub-decomposition report's risk-ordered plan, the next candidates are: (2) Feature definitions/computation (709 lines, small footprint, comparable risk to this slice), then (3) the Deriv login/WS flow (703 lines — the first section that *produces* `gridWs`/`gridAuthed` rather than only consuming them, needing its own explicit write-path verification of the existing bridge). Blocks 8/9 remain deferred, still blocked on the sealed-region `MSD_LABEL_VERSION` dependency.
