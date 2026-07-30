# FUTURE PROJECT — Phase 1, Slice 1: Debug Panel Extraction (+ Two Corrections to the Roadmap)

The first real code-moving step of the ES-module refactor. One inline script block moved to a real ES module. Along the way, inspection of the actual code surfaced two findings that revise the roadmap — reported honestly rather than glossed over, since both change what "safe to extract next" means.

## What moved

`index.html`'s debug-panel-renderer block (`window.mfxToggleDebugPanel`/`window.mfxRenderDebugPanel`, the `Ctrl+Shift+D` developer panel) is now `src/dashboard/debugPanel.js`, loaded via `<script type="module" src="src/dashboard/debugPanel.js"></script>`. The extracted code is byte-for-byte identical to the original inline block — verified with `diff`, not assumed. `index.html` shrank from 36,218 to 36,129 lines (net: -90 lines of inline code, +1 module reference line).

This block was chosen as the first slice because inspection showed it has no dependency on anything except `window.__mfxDebug` (already window-qualified) and its own DOM elements (`mfxDebugPanel`, `mfxDebugPanelBody`) — no bare cross-script identifier reads at all.

## Correction 1: mfxBot/dabBot are not safe to extract as-is (the plan's Phase 1 assumption was wrong)

The refactor plan originally listed the `mfxBot`/`dabBot` floating-widget scripts alongside the debug panel as "self-contained, safe first extractions." Reading their actual ~490/~374 lines before touching them showed that's wrong for these two specifically: they read dozens of bare identifiers — `lastPrice`, `gridWs`, `gridAuthed`, `SYMBOL`, `decimals`, `MARKETS`, `runLen`, `runDir`, `RUN_LENGTH`, `gridTrades`, `gridCurrency`, `gridPending`, `ticks`, `gridPlaceTrade`, and more — that are declared with `let`/`const` at the top level of index.html's main script.

Top-level `let`/`const` declarations in a classic `<script>` tag are visible to *other classic scripts on the same page* (they live in a shared per-realm script-scope record), but they are **not** `window.*` properties, and that shared scope is invisible to ES modules. The code even says as much in its own comment: *"gridWs and gridAuthed are let-declared in the main script — accessible by name from any script on the same page, but NOT via window.gridWs."* Converting `mfxBot`/`dabBot` to `<script type="module">` as-is would make every one of those reads throw `ReferenceError` immediately.

This is fixable, but it's a separate, slightly larger step than "just move the code": index.html's main script needs additive `window.X = X;` mirror-assignment lines next to each such declaration (never edits to the existing `let`/`const` lines — pure additions), so the extracted widget can read `window.X` instead of the bare name. Thanks to Phase R0 (the marker-based seal), adding these mirror lines anywhere in the main script — even before the old line-12460 boundary — no longer risks corrupting the Phase 8 seal, since the seal now tracks its content by marker, not by absolute position. But it's still a distinct step, worth its own review before starting, rather than something to fold silently into "Phase 1."

**Recommendation**: treat mfxBot/dabBot extraction as its own slice (call it Phase 1b), scoped specifically as "add window-mirror assignments for N identifiers in the main script, then extract the widget," and decide separately whether to proceed.

## Correction 2: a `src/` directory already exists, for something unrelated

The repository already has a top-level `src/` directory containing one file, `src/index.js` — a small standalone Cloudflare Worker script (a mock API with `/health`, `/signal`, `/auth` endpoints) that has nothing to do with `index.html` and isn't referenced by it. The FUTURE PROJECT's suggested target tree (`src/{app,ui,charts,dashboard,api,storage,workers,...}`) also wants to live under `src/`. This extraction placed the new module at `src/dashboard/debugPanel.js`, which doesn't collide at the file level, but the shared top-level directory name is worth flagging: a future decision might be to house the browser-app module tree somewhere else (e.g. `web/src/`) to keep it unambiguous from the Worker script, or to just proceed as-is since the two trees don't actually overlap. Not resolved here — flagged for the next time this comes up.

## Verification performed

- `diff` of the extracted content against the original inline block: byte-for-byte identical.
- `node --check` on `src/dashboard/debugPanel.js`: pass.
- **Phase 8 seal executed (not assumed)** after the change: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/debugPanelExtraction.test.mjs`, 5 tests): confirms the module reference exists in `index.html`, the old inline function body is gone (not duplicated), the module still exports both expected `window.*` entry points, the module's *executable code* (comments stripped, after one self-caught false-positive — see below) never references any of the bare cross-script identifiers that ruled out mfxBot, and the seal markers are unaffected. All 5 pass.
- **Full suite**: 668/668 (663 + 5 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 668/668, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth: both match byte-for-byte.
- **Self-caught test bug**: the first draft of the "no bare cross-script identifiers" guardrail test checked the whole file text, including this module's own header comment — which explains, in prose, exactly which identifiers ruled out extracting mfxBot, and so contains the literal string `gridWs`. That tripped the check against nothing but my own explanatory comment. Fixed by stripping comments before the check, the same fix already applied twice before in this project (`schedulerState.test.mjs`, `scheduler.test.mjs`) — worth noting only because it's a fitting confirmation of why that discipline exists.
- **What was NOT verified**: real-browser behavior (does `Ctrl+Shift+D` still toggle the panel, does the button still work, does the panel render identically). No browser is available in this sandbox. The static `onclick="mfxToggleDebugPanel()"` attribute resolves the function name dynamically at click time against the global object, and `<script type="module">` execution timing (deferred, after full parse) can only make the function available *earlier relative to a user's first possible click* than before, never later in any way that would matter — but this reasoning has not been confirmed by an actual click in an actual browser.

## Rollback

`git diff` / `phase1_slice1_index_html.patch` is a 100-line, purely mechanical patch (remove the inline block, add one module tag). Revert it and delete `src/dashboard/debugPanel.js` to fully undo this slice; nothing else depends on it yet.

## Status / next step

Slice 1 (debug panel) is complete, tested, seal-verified, clean-room-verified. Recommended next candidates, per the corrected picture above: the Phase 8 feature-family report and Integrity Module (script blocks #8/#9) — both already read Phase 8 data via `window._ph8GetSeal()`/`window._ph8GetResult()`, i.e. already window-qualified, and are therefore likely (not yet confirmed by inspection) to be as safe as this slice was. mfxBot/dabBot remain deferred pending a decision on the window-mirroring approach in Correction 1.
