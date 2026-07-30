# FUTURE PROJECT — Phase 1b: mfxBot Extraction via Live Accessor Bridge

Extracts the `mfxBot` floating trading widget into a real ES module, solving the cross-scope dependency problem flagged in the Phase 1 Slice 1 report without rewriting any of the widget's own logic.

## What changed

**`index.html`**: two additions plus one removal-and-replace, net -63 lines (35,772 → 35,709).

1. A new, self-contained classic `<script>` block ("live window.* accessor bridge") inserted immediately after the main script closes. For each of 19 identifiers the widget needs, it defines an `Object.defineProperty(window, name, {get, set})` accessor. Because this bridge is itself a plain classic script, its getter/setter closures have direct lexical access to the real `let`/`const` bindings in the main script — reading `window.X` returns the live current value, not a one-time snapshot, and writes go through to the real binding.
2. The old inline `mfxBot` script block (~490 lines) removed, replaced with `<script type="module" src="src/ui/widgets/mfxBot.js"></script>`.
3. `src/ui/widgets/mfxBot.js` (new): the widget's code, byte-for-byte identical to the original inline block (verified with `diff`) — nothing inside it was rewritten.

## Why a bridge was needed, and why it's structured this way

`mfxBot`'s code reads 19 identifiers — `MARKETS`, `SYMBOL`, `RUN_LENGTH`, `ticks`, `lastPrice`, `runDir`, `runLen`, `decimals`, `gridWs`, `gridAuthed`, `gridLoginId`, `gridBalance`, `gridCurrency`, `gridIsVirtual`, `gridTrades`, `gridReqId`, `gridPending`, `gridConnecting`, `digTrades` — all declared with `let`/`const` at the top level of the main script. Those bindings live in a shared per-realm declarative scope that classic scripts see but ES modules cannot. All 19 are declared outside the frozen Phase 8 seal region, so adding the bridge is not a Phase 5 (sealed-region) action.

Rather than rewrite `mfxBot`'s bare references to `window.X` (which would turn "move the code" into "rewrite the code," losing the ability to verify equivalence with a plain `diff`), the bridge exposes each identifier as a live accessor property on `window`. Because unqualified identifier lookup in *any* script — module or classic — falls through to the global object (`window`) when nothing more local shadows it, `mfxBot`'s existing bare references keep resolving correctly with zero changes to its own code. `gridReqId++` (used to keep proposal/buy request IDs unique across the whole app) correctly reads, increments, and writes back through the accessor pair, so the main script and the extracted module continue to share one live counter.

Four of the 19 (`MARKETS`, `RUN_LENGTH`, `ticks`, `gridPending`) are `const` and are never reassigned by `mfxBot` (confirmed by inspection — only their contents are read, or, for `gridPending`, individual properties are set on the same object reference) — these get a getter only. The remaining 15 get both accessors.

## How the dependency list was determined (and a bug I caught in my own first pass)

A script cross-referencing every bare identifier in the widget's code against every top-level `let`/`const`/`function`/`var` declaration in the main script produced an initial list of 15 identifiers. Before implementing, I re-ran the check and found my own parser had a bug: it only captured the *first* name in a multi-variable declaration line (`let gridWs = null, gridAuthed = false, gridPing = null;` was recorded as declaring only `gridWs`). Fixing that surfaced 4 more real dependencies — `gridAuthed`, `gridBalance`, `gridCurrency`, `gridIsVirtual` — that the first pass had silently missed. Had I built the bridge from the incomplete list, those four would have thrown `ReferenceError` inside the widget at runtime. A second corrected pass (also stripping comments/strings and excluding the widget's own locally-shadowed names, like a local `let lost=0` that shadows an unrelated outer `lost`) converged on exactly 19 real dependencies, matching what's now bridged.

## Verification performed

- **A standalone Node smoke test** (not part of the automated suite, run before writing any files) simulated the shared-scope semantics with a representative subset of the real declarations, then loaded the actual bridge code verbatim and confirmed: reads return the live value; mutating the bare binding is immediately visible through `window.*`; writing through `window.*` correctly mutates the bare binding; `window.gridReqId++` performs a correct read-increment-write-back round trip. (One assertion — that writing to a getter-only property throws in strict mode — behaved unexpectedly inside Node's `vm` module sandbox; verified separately in plain Node, outside `vm`, that this exact pattern throws exactly as expected. This is a `vm`-module quirk unrelated to real browser/ES-module behavior, noted rather than hidden, and irrelevant in practice since `mfxBot` never attempts to write any of the four getter-only identifiers.)
- **`diff`** confirms `src/ui/widgets/mfxBot.js`'s extracted body is byte-for-byte identical to the original inline block.
- **`node --check`** on `mfxBot.js` and the new test file: pass.
- **Phase 8 seal executed (not assumed)**: `36b45239`, unchanged.
- **New guardrail tests** (`tests/refactor/mfxBotExtraction.test.mjs`, 5 tests): confirms the module reference exists, the old inline function body is gone, all 19 bridged identifiers are present and the bridge is defined *before* the module reference in document order (critical — the widget's first tick would read `undefined` otherwise), the module still exports its expected `window.*` entry points, and the seal markers are unaffected. All 5 pass.
- **Full suite**: 673/673 (668 + 5 new).
- **Independent clean-room pass**: fresh directory, full suite re-run there: 673/673, seal `36b45239` confirmed again.
- **SHA-256 comparison**, delivered files vs. sandbox source of truth: both match byte-for-byte.
- **What was NOT verified**: real-browser behavior — does the widget still drag, minimize, place trades, and refresh its live stats correctly. No browser is available in this sandbox. The Node-level verification (bridge semantics smoke test, byte-identical diff, structural guardrails) is as far as this environment can confirm; an actual click-through in a real browser has not been performed by me.

## What did NOT change

- `mfxBot`'s own logic: zero lines rewritten, confirmed by `diff`.
- Any scientific algorithm, statistical procedure, governance logic, or the Phase 8 sealed region.
- Any IndexedDB schema, database name, or version.
- `research/src/`, `research/integration/`, `mtf/src/`, or `src/dashboard/debugPanel.js` (Phase 1 Slice 1).

## Rollback

`phase1b_mfxbot_index_html.patch` (576 lines, entirely mechanical: add the bridge block, remove the inline widget, add one module tag) plus deleting `src/ui/widgets/mfxBot.js` fully reverts this slice. The bridge and the widget extraction are two logically separate pieces of this one patch — reverting both together is recommended, since the bridge exists specifically to serve this widget and has no other consumer yet.

## Status / next step

Phase 1 Slice 1 (debug panel) and Phase 1b (mfxBot + bridge) are both complete, tested, seal-verified, clean-room-verified. `dabBot` (the second floating-widget script, structurally very similar to `mfxBot`) is the natural next candidate — likely to need a similar but separately-verified dependency list, not assumed to be identical to mfxBot's. Blocks 8/9 (Phase 8 feature-family report + Integrity Module) remain deferred pending a decision on the sealed-region `MSD_LABEL_VERSION` dependency (see the Phase 1 Slice 1 report's continuation findings).
