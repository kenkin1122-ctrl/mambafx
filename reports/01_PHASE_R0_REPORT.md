# FUTURE PROJECT — Phase R0: Marker-Based Phase 8 Seal Re-Baseline

Implements the prerequisite step identified in `MSD_FUTURE_PROJECT_ESMODULE_REFACTOR_PLAN.md`: before any code before the old line-12460 boundary can ever be extracted into an ES module, the Phase 8 seal's extraction mechanism must stop depending on absolute line numbers. This is that change, and only that change — no code was moved, no scientific logic was touched, and Phases 1–5 of the refactor roadmap have not been started.

## What changed

**`index.html`** (+2 lines, 36,216 → 36,218): two literal comment lines were inserted immediately around the existing sealed content, at what were previously absolute lines 4361 and 12460 (1-based):

- `// MSD-PHASE8-SEAL-START — DO NOT EDIT OR MOVE THIS LINE. ...` — inserted immediately before the line that was previously the first sealed line (`let msdEventSeq = 0;`).
- `// MSD-PHASE8-SEAL-END — DO NOT EDIT OR MOVE THIS LINE. ...` — inserted immediately after the line that was previously the last sealed line (a blank line at former line 12460).

Nothing between the two markers was added, removed, or reordered — the diff (`phase_r0_index_html.patch`) is exactly these two added lines and nothing else, confirmed by `diff -u` against the pre-change file.

**`phase8-engine.js`**: `buildContext()`'s extraction logic changed from `htmlLines.slice(4360, 12460)` (hardcoded absolute indices) to locating the two marker lines by string search and extracting everything strictly between them. If either marker is missing, duplicated, or out of order, it now throws a clear error rather than silently falling back to a guessed line range. The module header docstring was also updated so it no longer describes the old line-number mechanism.

**`tests/phase8/sealExtraction.test.mjs`** (new): 4 tests — exactly one of each marker exists, START precedes END, `getSeal()` still returns hash `36b45239` (a regression pin, not a new computation), and the extracted region still starts/ends with the expected identifiers and is still several thousand lines long.

## Why this matters (the problem being fixed)

The seal was previously computed by executing `htmlLines.slice(4360, 12460)` — index.html lines 4361–12460 (1-based) — inside a Node vm context, then hashing the resulting search-space *definition* (not the raw text; `getSeal()` runs `msdBuildPhase7bSearchSpaceDefinition()`/`msdFreezeSearchSpace()` on the extracted code and reads `frozen.searchSpaceHash`). Because the extraction was by absolute index, inserting or removing so much as one line **anywhere before line 12460** — not only inside the sealed range itself — would shift what physically occupied that fixed window, changing what got executed and potentially changing the resulting hash, without a single "sealed" line ever being edited. This is the exact class of bug already caught once during Phase 10 v1 (a dashboard nav-button insertion that landed before the boundary), which is why every dashboard addition since has been built at runtime instead of as static markup.

Marker-based extraction removes this hazard structurally: the markers travel with their content. Content can now be added or removed anywhere else in the file — including, going forward, in Phase 4 of the refactor roadmap (the pre-seal config/state/chart code) — without any risk of silently shifting what `getSeal()` captures.

## Verification performed

- **`node --check`** on `phase8-engine.js` and `tests/phase8/sealExtraction.test.mjs`: both pass.
- **`getSeal()` executed (not diffed/assumed)** immediately after the change: `searchSpaceHash: '36b45239'`, `totalCardinality: 80`, `features.length: 16` — all identical to the pre-Phase-R0 values.
- **`runCampaign([])` executed**: completes without throwing, confirming the same marker-based extraction also works correctly for the full discovery-campaign code path (not just `getSeal()`'s narrower search-space-definition path), since both share `buildContext()`.
- **New regression suite** (`tests/phase8/sealExtraction.test.mjs`): 4/4 pass.
- **Full repository suite**: 663/663 pass (up from 659 — the +4 new tests).
- **Independent clean-room pass**: a separate, freshly-copied directory, `node --check` re-run there, full suite re-run there independently: 663/663, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered-file copies vs. sandbox source of truth (`phase8-engine.js`, `sealExtraction.test.mjs`): both match byte-for-byte.
- **The index.html diff itself was inspected**, not assumed: `diff -u` against the pre-change copy shows exactly the two marker-comment lines added, nothing else.
- **What was NOT verified**: real-browser execution of the modified `index.html`. The two inserted lines are plain JS comments in a position already confirmed to be a clean statement boundary (between two `let ...;` declarations, and after a blank line before a `/** ... */` comment), so they should be inert in the browser exactly as in Node — but this sandbox has no browser, so that has not been directly observed by me.

## What did NOT change

- No scientific algorithm, statistical procedure, or governance logic — the extracted code between the markers is byte-identical to what `slice(4360, 12460)` extracted before.
- No IndexedDB schema, database name, or version.
- No test file outside the one new `tests/phase8/sealExtraction.test.mjs` addition.
- No file under `research/src/`, `research/integration/`, or `mtf/src/`.
- Phases 1–5 of the ES-module refactor roadmap: not started. This is exclusively the prerequisite that makes Phase 4 (and, eventually, a separately-approved Phase 5) safe to attempt later.

## Rollback

Revert `phase8-engine.js` to `phase8-engine.js.before_r0` and `index.html` to `index.html.before_r0` (both preserved in the sandbox for this exact purpose) — a single two-file revert, no data migration involved.

## Status / next step

Phase R0 is complete, tested, and verified. Per the roadmap, the next candidate step (not started, not scoped by this document) is Phase 1: extracting the smallest, most self-contained script blocks (the `mfxBot`/`dabBot` widgets, the debug-panel glue) into real ES modules — none of which touch anything before the now-marker-protected sealed region.
