# FUTURE PROJECT — Phase 1c: dabBot Extraction (+ Sandbox Reconstruction Note)

## Sandbox reconstruction (housekeeping, disclosed for transparency)

Before this round's work could start, the sandbox's working copy of the repository (everything under `/tmp/repo_work/baseline`) was found to be gone — the sandbox environment had been reset between turns, which is expected of this ephemeral scratch space but meant the accumulated Phase 9/10/10B/10C/R0/Slice-1/Phase-1b state no longer existed anywhere in the sandbox.

It was rebuilt, not re-derived from memory: a full git export of the repository (`MambaFX_Repository_Full_Export.zip`, already sitting in the outputs folder from an earlier delivery) turned out to be at exactly the right base commit (`2608cf8`, "Integration 5: wire Positive Control detection into the governed Randomness Audit" — the same commit this whole engagement has used as its Phase 9 starting point, confirmed by matching `index.html`'s exact original line count, 36,171). From there, every previously-delivered file and patch already sitting in the outputs folder was re-applied in the original order: the Phase 9 v3 zip, the Phase 10 v1 `index.html` patch, the current `research/integration/*.js` files (already reflecting Phase 10C), the Phase R0 seal patch plus updated `phase8-engine.js`, the Phase 1 Slice 1 patch, and the Phase 1b patch. After each step, the file's line count was checked against the exact number recorded in that step's original report — every single one matched exactly. The reconstructed tree was then fully verified: 637/637 tests, Phase 8 seal `36b45239`. Nothing in this reconstruction was guessed or reconstructed from summary/memory — every byte came from a file that was already delivered to you and sitting in the outputs folder; the rebuild's job was only to put those pieces back together in the right order and confirm they still fit.

This is disclosed because it's the honest sequence of events, not because it changes anything about the work below — the current, live `index.html`/`phase8-engine.js`/`research/*` state was independently re-verified (line counts, seal hash, full suite) after reconstruction and before this round's dabBot work began.

## What changed (dabBot extraction)

`index.html`'s second floating-widget script block (`dabBot`, a Deriv-style auto-fire/martingale trading bot, structurally similar to `mfxBot` but not identical) is now `src/ui/widgets/dabBot.js`. One line was added to the existing window.* accessor bridge (from Phase 1b); the rest of the extraction followed the same verbatim-move pattern as `mfxBot`.

## Independent dependency verification (not assumed from mfxBot)

Per the standing note at the end of the Phase 1b report, `dabBot`'s dependency list was mapped independently rather than assumed identical to `mfxBot`'s. This surfaced two things:

1. **A tooling failure, caught before it caused harm.** The same automated comment/string-stripping cross-reference script used for `mfxBot` was run against `dabBot` first, and returned only one flagged dependency (`lost`) — implausible for code this structurally similar to `mfxBot`, which needed 19. Investigating why revealed the script's naive regex-based string-stripper had choked on an unbalanced-looking apostrophe pattern somewhere in `dabBot`'s ~370 lines, causing it to silently treat more than half the code (14,212 characters down to 5,773) as "inside a string literal" and skip it entirely. Had this gone unnoticed, the resulting bridge would have been missing most of what the widget actually needs, and the extracted module would have thrown `ReferenceError` on its very first tick.
2. **The corrected approach**: since this codebase consistently guards every cross-scope read with an explicit `typeof X !== 'undefined'` pattern (confirmed by `mfxBot`'s own code, which uses the identical convention and even comments on why), grepping for that exact guard — plus a full manual read of all ~370 lines — was used instead. This found 14 real dependencies: `MARKETS`, `SYMBOL`, `decimals`, `gridAuthed`, `gridCurrency`, `gridIsVirtual`, `gridPending`, `gridReqId`, `gridWs`, `lastPrice`, `runDir`, `runLen`, `ticks`, and one `mfxBot` never needed — `gridOpenContracts` (a `let`-declared object, mutated only via property assignment like `gridOpenContracts[row.id] = row`, never reassigned — a getter-only bridge entry, matching `gridPending`'s existing pattern). Thirteen of the fourteen were already covered by Phase 1b's bridge; only `gridOpenContracts` needed a new one-line addition.

## Verification performed

- `diff` confirms `src/ui/widgets/dabBot.js`'s extracted body is byte-for-byte identical to the original inline block.
- `node --check` on `dabBot.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**, both immediately after extending the bridge and again after the full extraction: `36b45239`, unchanged both times.
- **New guardrail tests** (`tests/refactor/dabBotExtraction.test.mjs`, 5 tests): module reference exists, old inline `dabFire` function body is gone, all 14 bridged identifiers (including the new `gridOpenContracts`) are present and defined before the module reference, the module still exports its expected `window.*` entry points, seal markers unaffected. All 5 pass.
- **Full suite**: 642/642 (637 + 5 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 642/642, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth: both match byte-for-byte.
- **What was NOT verified**: real-browser behavior (drag, minimize, auto-fire, martingale stake capping, trade placement). No browser is available in this sandbox.

## What did NOT change

- `dabBot`'s own logic: zero lines rewritten, confirmed by `diff`.
- `mfxBot.js`, `src/dashboard/debugPanel.js`, `research/*`, `mtf/src/*`: untouched.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.

## Rollback

`phase1c_dabbot_index_html.patch` (392 lines: one bridge-line addition, remove the inline widget, add one module tag) plus deleting `src/ui/widgets/dabBot.js` fully reverts this slice, independent of `mfxBot`'s extraction.

## Status / next step

Both floating widgets (`mfxBot`, `dabBot`) and the debug panel are now real ES modules, all byte-identical moves, all independently verified. Remaining Phase 1 candidates: Phase 8 blocks 8/9 (still blocked on the sealed-region `MSD_LABEL_VERSION` dependency), and eventually Phase 2/3/4 of the roadmap (IndexedDB access consolidation, then the pre-seal config/state/chart code once Phase R0's protection is trusted for that zone too).
