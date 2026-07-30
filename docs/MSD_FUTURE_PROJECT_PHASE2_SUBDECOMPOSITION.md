# FUTURE PROJECT — Phase 2 Sub-Decomposition Assessment

Planning only — nothing in `index.html` was touched for this round. Phase 2 (the ~21,000-line "safe zone" after the Phase 8 seal boundary) is too large and too internally varied to treat as one slice, so this maps its actual structure and proposes a risk-ordered extraction sequence before any code moves.

## Method (and why the mfxBot/dabBot approach needed an upgrade first)

The regex-based comment/string-stripping analysis that broke silently on `dabBot` (Phase 1c report) was not patched — it was replaced. This round installed `acorn` (a real JS tokenizer, already used by countless production toolchains) and tokenized each candidate section properly: comments, strings, and template literals are handled by an actual lexer, not a chain of regex substitutions that can misfire on things like an apostrophe inside a comment. Declarations across all ~30,000 lines of the main script were mapped the same way as before (top-level `let`/`const`/`var`/`function`, multi-declaration lines split correctly) — 1,382 total. For each section, every identifier the tokenizer found was checked against that map; anything declared outside the section's own line range and typed `let`/`const` counts as a cross-section dependency.

One caveat, stated plainly: this is not full scope-aware analysis (no per-function shadowing resolution). A handful of very generic names (`n`, `adx`, `pdi`, `ndi`) show up as "cross-section dependencies" in almost every section purely because they're common local variable names in many separate functions (ADX/+DI/-DI are standard technical-indicator abbreviations, plausibly re-declared locally inside dozens of unrelated functions) that happen to coincide with one real `let` declaration elsewhere. These are flagged in the counts below but are very likely false positives — real per-function scope resolution would be needed to be certain, and is worth doing at implementation time for whichever section is picked, not for this planning pass.

## Section-by-section findings

| Section | Lines | Functions | Cross-section `let`/`const` deps (raw count) | Notable dependencies |
|---|---|---|---|---|
| 5-tick signal engine | 428 | 7 | 4 | `RUN_LENGTH`, `runDir`, `decimals` (+ likely-noisy `n`) |
| Feature definitions/computation | 709 | 7 | 6 | `SYMBOL`, `$`, `signalRecords`, `count` (+ likely-noisy `n`, `adx`) |
| Deriv login/WS flow | 703 | 31 | 7 | `MARKETS`, `SYMBOL`, `ticks`, `decimals`, `$`, `digAutoArmed`, `_acctData` — **this section is the producer of `gridWs`/`gridAuthed`/etc., not just a consumer** |
| Digit circles / CSV export / digit trading | 717 | 26 | 20 | Heavy `grid*` coupling (`gridWs`, `gridAuthed`, `gridLoginId`, `gridCurrency`, `gridOpenContracts`, `gridReqId`, `gridPending`) |
| Trading signal / master-score engine | 1,505 | 52 | 27 | `gridWs`, `gridAuthed`, `gridCurrency`, `gridBalance`, `gridReqId`, `gridPending`, plus several chart/candle state variables (`liveCandles`, `live5mCandles`, `indSnapshot`, `chop`, `macdHist`, `indHistory`) |
| Market State Search Tool | 3,539 | 91 | 36 | Overlaps heavily with MSD_* research constants also used by Research Session Manager — likely belongs conceptually with that section, not standalone |
| Research Session Manager | 9,385 | 276 | 24 (deceptively low) | Enormous size relative to its cross-section footprint — internally self-cohesive (mostly calls its own functions), but far too large for one slice; needs its own internal sub-decomposition pass before any extraction is planned |

A new shared dependency shows up here that neither `mfxBot` nor `dabBot` needed: **`$`** — `const $ = id => document.getElementById(id);` (declared at line 3525, a tiny DOM-lookup helper used throughout). Any of these sections would need it added to the existing window.* bridge (getter only, since it's a `const` function reference, never reassigned).

## Risk-ordered recommendation

1. **5-tick signal engine** (428 lines, smallest real footprint) — the clear next candidate, comparable in shape to the widgets already done.
2. **Feature definitions/computation** (709 lines, small footprint) — a reasonable second slice.
3. **Deriv login/WS flow** (703 lines) — needs one important distinction from every extraction so far: this section *writes* to `gridWs`, `gridAuthed`, and friends (it's where the WebSocket connection is actually established), not just reads them. The existing bidirectional accessor bridge already supports this correctly in principle (a write through `window.gridWs = ws` goes through the setter and updates the real binding, exactly like `window.gridReqId++` already does for `mfxBot`) — but this needs to be explicitly verified with its own smoke test before trusting it, since a producer moving is a meaningfully different risk than a consumer moving.
4. **Digit circles/CSV/digit trading** and **Trading signal/master-score engine** — larger, more heavily coupled to `grid*` state; recommend attempting only after #3 is done and verified, since both depend on the connection state #3 produces.
5. **Market State Search Tool** and **Research Session Manager** — not recommended for direct extraction yet. The search tool's dependency overlap with MSD_* constants suggests it may belong with the Research Session Manager conceptually, and the Research Session Manager itself (9,385 lines) needs its own internal sub-decomposition pass — a smaller version of this same exercise, scoped to just that one section — before any slice plan can be proposed for it.

## What this round did NOT do

No extraction, no bridge changes, no test additions. This is purely the structural map needed to pick a safe, well-understood first slice for the next round, per the "analyze first" direction.
