# FUTURE PROJECT — Phase 1e: ML Feature-Engineering Block Extraction

The second candidate from `MSD_FUTURE_PROJECT_PHASE2_SUBDECOMPOSITION.md`'s risk-ordered list is now a real ES module, following the same producer-side pattern established in Phase 1d.

## What moved

`index.html`'s ML feature-engineering block — 712 lines (`_FEAT_DEFS`, the 150+-feature definition table; `_featCache`; and the functions `featComputeAll`, `featMutualInfo`, `featRfImportance`, `featShap`, `featPageInit`, `featCompute`, `featExportCsv`) — is now `src/features/featureEngineering.js`, loaded via `<script type="module" src="src/features/featureEngineering.js"></script>`. `index.html`: 34,910 → 34,201 lines (712 lines removed, 1 module tag added, 2 new bridge lines added — net -709).

The extraction boundary (banner comment to closing brace) was located the same programmatic way as Phase 1d, confirmed exact: lines 29081–29792 (1-based), 712 lines — matching the sub-decomposition report's function count exactly (7 functions: `featComputeAll`, `featMutualInfo`, `featRfImportance`, `featShap`, `featPageInit`, `featCompute`, `featExportCsv`) and closely matching its reported line count (709).

## Dependencies verified in both directions

**This module's own external reads** — the sub-decomposition report flagged 6 raw cross-section dependencies: `SYMBOL`, `$`, `signalRecords`, `count`, plus likely-noisy `n`/`adx`. Checking each against actual usage:

- `SYMBOL`: one genuine bare read (in a CSV filename template string), already bridged read-write since Phase 1b — no new entry needed.
- `$` (the `const $ = id => document.getElementById(id)` DOM helper, flagged in the sub-decomposition report as a new dependency none of the earlier widgets needed): genuine bare calls throughout (`$("featCompBtn")`, etc.). New bridge entry added — getter-only, since it's a `const` function reference, never reassigned.
- `signalRecords`: genuine bare reads (`.length`, `.forEach`) with no local declaration or mutation anywhere in this section. New bridge entry added — getter-only, since this section only reads it (it's reassigned/pushed to elsewhere in the app, but never by this section, so a getter that always reflects the live binding is sufficient and correct).
- `count`: false positive — the flagged occurrence is a locally-declared `let count=0;` inside one of the feature functions, shadowing nothing external.
- `n`, `adx`: false positives, as the sub-decomposition report itself anticipated — every occurrence is either a local variable (`const n=colVals.length`, `const n=sorted.length`) or a string key passed to the internal `g(s, 'adx')` accessor helper, never a bare reference to anything external.

**External reads of this module's own state** (the producer side, checked the same way as Phase 1d — whole-file occurrence counts split by in-section vs. outside): `_FEAT_DEFS` is read once from outside (`const feats=_FEAT_DEFS;` inside a prediction-model-building function elsewhere in the file — a likely preview of the "Trading signal/master-score engine" section slated for a later round); `featComputeAll` is called from 3 separate outside sites; `featMutualInfo`/`featRfImportance`/`featShap` are called together in one feature-selection loop elsewhere; `featPageInit` is called once when the Features page opens (the same `if (which === "...") { ...PageInit(); }` pattern already seen for the 5-tick engine's `engPageReady`); `featCompute`/`featExportCsv` are referenced from `onclick="featCompute()"` / `onclick="featExportCsv('B')"` HTML attributes, which compile into handlers lazily at first click — long after this module has finished executing, so there's no timing risk. All seven are now exported via `window.*` at the module's tail, mirroring Phase 1d's approach. `_featCache`, the module's other top-level declaration, has zero external references and stays fully internal — confirmed by a guardrail test that fails if it's ever exposed on `window`.

## Verification performed

- **The extraction boundary** was located programmatically and confirmed exact (712 lines, banner comment through closing brace).
- **`diff`** confirms the module's extracted body (first 712 lines, before the new export block) is byte-for-byte identical to the original inline block.
- **`node --check`** on `featureEngineering.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/featureEngineeringExtraction.test.mjs`, 6 tests): module reference exists; the old inline `_FEAT_DEFS`/`featComputeAll` are gone from `index.html`; exactly the two expected new getter-only bridge entries (`$`, `signalRecords`) exist; the module defines the `window._FEAT_DEFS` getter and all 7 function exports; `_featCache` is never exposed on `window`; seal markers unaffected. All 6 pass.
- **Full suite**: 655/655 (649 + 6 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 655/655, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth (`featureEngineering.js`, the test file, `index.html`): all match byte-for-byte.
- **What was NOT verified**: real-browser behavior (does the Features page still compute/rank features, do the CSV export buttons still work, does the prediction-model builder elsewhere in the app still read `_FEAT_DEFS`/call `featMutualInfo` etc. correctly). No browser is available in this sandbox. As with every prior slice, the reasoning that classic-script event handlers (bare calls, `onclick` attributes) can only resolve *earlier* relative to a module's completed execution, never later, is architectural, not something this sandbox can directly observe.

## What did NOT change

- The feature-engineering code's own logic: zero lines rewritten in the extracted body, confirmed by `diff`. Only a new, clearly-delimited export block was appended after it.
- `fiveTickSignalEngine.js`, `mfxBot.js`, `dabBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- The existing bridge entries added in Phase 1b/1c: unchanged, only two new lines appended after them.

## Rollback

`phase1e_featureengineering_index_html.patch` (731 lines: two new bridge lines, remove the 712-line inline block, add one module tag) plus deleting `src/features/featureEngineering.js` fully reverts this slice, independent of every prior extraction.

## Status / next step

Per the sub-decomposition report's risk-ordered plan, the next candidate is (3) the Deriv login/WS flow (703 lines) — the first section that *produces* `gridWs`/`gridAuthed`/etc. rather than only consuming them, requiring explicit verification that writing through the existing bidirectional bridge (`window.gridWs = ws`) correctly updates the real binding from a newly-producer module, not just from the classic script side as tested so far. Blocks 8/9 remain deferred, still blocked on the sealed-region `MSD_LABEL_VERSION` dependency.
