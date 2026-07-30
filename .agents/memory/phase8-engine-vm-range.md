---
name: Phase 8 Engine VM Line Range
description: How phase8-engine.js extracts the sealed MSD region from index.html for the vm context.
---

## Rule
`phase8-engine.js` uses **marker-based extraction** (Phase R0):
```javascript
const sealStartIdx = htmlLines.findIndex(l => l.includes('MSD-PHASE8-SEAL-START'));
const sealEndIdx   = htmlLines.findIndex(l => l.includes('MSD-PHASE8-SEAL-END'));
const rawSrc = htmlLines.slice(sealStartIdx + 1, sealEndIdx).join('\n').replace(/[^\x00-\x7F]/g, ' ');
```

## Why
Hardcoded line numbers (`slice(4360, 12460)`) were fragile: every insertion or deletion above the
sealed region shifted the start/end of the JS content, requiring a manual binary-search recalibration.
The DB v1→v2 migration pushed the SEAL-START marker from line ~4361 to ~4590, making the old start
index (4360) include 229 lines of pre-MSD content with a net brace imbalance that vm.Script rejected
at ALL end values — no valid end existed when starting at 4360.

The correct extraction has always been content between the two sentinel comments:
- `// MSD-PHASE8-SEAL-START — DO NOT EDIT OR MOVE THIS LINE.`
- `// MSD-PHASE8-SEAL-END — DO NOT EDIT OR MOVE THIS LINE.`

These sentinels are immovable by project discipline, so the extraction is inherently immune to any
future insertions/deletions outside the sealed region.

**Why:** `MSD-PHASE8-SEAL-END` (0-idx ~12715) is considerably past the old hardcoded 12460. The old
12460 was an approximation that happened to fall inside the balanced range; the markers define the
true canonical boundary.

## How to apply
Never update the hardcoded line number. If `vm.Script` ever fails again, the first check is
whether a sentinel comment was accidentally edited or duplicated. The test suite (sealExtraction.test.mjs)
verifies exactly one of each marker exists and they are correctly ordered.

Always strip non-ASCII: `.replace(/[^\x00-\x7F]/g, ' ')` — all MSD identifiers and string literals
are pure ASCII; only JSDoc decorators and comment block-drawing chars are non-ASCII.

## Confirmed exports (marker-based)
All CONST_EXPORTS present; `MSD_NC_FEATURE_VERSION = 'ncf_v1'`, `msdRunPhase7bDiscovery: function`,
`MSD_PHASE7B_SYMBOL: 1HZ100V`. 211/211 tests pass after this change.
