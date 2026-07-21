---
name: Phase 8 Engine VM Line Range
description: Correct index.html slice bounds for the phase8-engine.js vm context, and why they are what they are.
---

## Rule
`phase8-engine.js` must slice `index.html` at **0-indexed [4360, 12460)** (1-based lines 4361–12460).

## Why
Three layers of line-range drift have accumulated since the engine was first authored:

| Layer | Lines added | Effect |
|---|---|---|
| Phase 8 UI div (2966–3385) grew | ~218 lines | Pushed `<script>` tag from ~3169 to 3387 |
| Developer AI Mode section (3388–4360) added AFTER engine | ~973 lines | First JS content after `<script>` is non-MSD code |
| Non-ASCII chars (U+2550 ═, U+2014 —) throughout both sections | — | vm parser rejects them even in comments |

The MSD library starts at 1-based line **4361** (`let msdEventSeq = 0`). Lines 3388–4360 are the Developer AI Mode instrumentation block which must be excluded.

**12460** was determined by binary search as the highest 0-indexed exclusive bound where:
1. `new vm.Script(src)` succeeds (balanced blocks)
2. All 13 CONST_EXPORTS are present
3. `vm.runInContext(src, ctx)` executes without throwing

## How to apply
Whenever `index.html` grows (new page divs, new script sections), re-run the binary search:
```javascript
// Find new start: grep for 'let msdEventSeq' in index.html → subtract 1 for 0-idx
// Find new end: binary search for highest E where new vm.Script(lines.slice(S,E).replace(...)).ok
```
Always strip non-ASCII: `.replace(/[^\x00-\x7F]/g, ' ')` — all MSD identifiers and string literals are pure ASCII; only JSDoc decorators use box-drawing chars.

## Confirmed exports at [4360, 12460)
All 13 CONST_EXPORTS present; `MSD_NC_FEATURE_VERSION = 'ncf_v1'`, `msdRunPhase7bDiscovery: function`, `MSD_PHASE7B_SYMBOL: 1HZ100V`.
