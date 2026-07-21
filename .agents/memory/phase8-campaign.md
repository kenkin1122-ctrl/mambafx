---
name: Phase 8 Campaign
description: Phase 8 server-side execution engine + campaign runner; GET /api/phase8/seal, POST /api/phase8/run; standalone page.
---

## Phase 8: First Official Non-Classical Discovery Campaign

### What Was Built (Server-Side Execution Path)

Three files created/updated; zero new functions in index.html:

| File | Role |
|---|---|
| `phase8-engine.js` | Node.js vm engine — loads MSD functions from index.html lines 3170–11287 |
| `server.js` | Added GET /api/phase8/seal + POST /api/phase8/run endpoints |
| `msd-phase8-campaign.html` | Standalone runner — no window.opener needed |

### vm Extraction Details (CRITICAL)

- Extract **HTML lines 3170–11287** (`slice(3169, 11287)`) — all MSD functions, no UI code.
- Cut at 11287 because it's the last clean balanced-block parse boundary before non-ASCII chars (U+2550 ═, U+2014 —) in JSDoc comments starting at line 11443.
- `const` declarations are NOT accessible via `ctx.CONST_NAME` — the EXPORT_IIFE suffix captures them.
- `MSD_CODE_VERSION` and `MSD_STATISTICAL_ENGINE_VERSION` are at lines 12672-12673 (past cut) — pre-define them on the context object.
- `window.addEventListener` is called at top-level (line 3272) — must add `ctx.addEventListener = () => {}` BEFORE setting `ctx.window = ctx`.
- `msdBuildPhase7bSearchSpaceDefinition()` is missing `featureFamilies` field required by `msdFreezeSearchSpace` — patch it in the engine after loading: `featureFamilies: ['non_classical']`.

**Why:** `function` declarations become context properties; `const`/`let` do NOT — they live in the script's lexical scope only. The EXPORT_IIFE suffix runs in the SAME script's lexical scope so it CAN read those bindings and copy them to `this`.

### IDB Override Strategy

- `msdWriteFinding`, `msdWriteDiscoveryLedgerEntry` → `async () => ({ ok: true })`
- `msdGetAllFindings`, `msdGetAllDiscoveryLedgerEntries` → `async () => []`
- `msdRecordHypothesisRecord` → bypass provenance check, return `{ ok: true, entryId: 'server_...' }`
- `msdGetSearchSpaceSpecifications`, `msdGetDatasetSnapshots` → `async () => []`

### Protocol Seal (verified in production)

- searchSpaceVersion: search_space_spec_v2
- totalCardinality: 80 (16 features × 5 lead times)
- symbol: 1HZ100V, featureVersion: ncf_v1
- seed: 42, permutations: 1000, alpha: 0.05, practicalThreshold: 0.01 nats
- nullModel: circular_shift_permutation, correction: benjamini_hochberg

### 8-Step Report Structure

| Step | Content |
|---|---|
| 1 | Pre-registration record |
| 2 | Dataset snapshot |
| 3 | Discovery evaluation |
| 4 | Multiplicity correction chain |
| 5 | Full scientific report |
| 6 | Scientific interpretation |
| 7 | Discovery decisions (4 categories) |
| 8 | Final authorization |

### Discovery Decision Logic (pre-registered)
- **DISCOVERY CANDIDATE**: BH adj-p < 0.05 AND MI ≥ 0.01 nats
- **STAT-SIG ONLY**: adj-p < 0.05 but MI < 0.01 nats  
- **PRAC-SIG ONLY**: MI ≥ 0.01 nats but adj-p ≥ 0.05
- **NOT SIGNIFICANT**: neither criterion met

### CSS Gotcha
`#seal-section { display:none; }` is a CSS rule — use `style.display = 'block'` (not `''`) to override it from JS. Setting `''` only removes inline styles, not CSS-class or ID-rule display.

### featureFamilies Bug in Phase 7B Runner
`msdBuildPhase7bSearchSpaceDefinition()` does NOT include `featureFamilies` but `msdFreezeSearchSpace` requires it. Fixed in phase8-engine.js by patching the function post-load. The same bug exists in `msd-phase7b-discovery.html` line 303 — fix by adding `featureFamilies: ['non_classical']` to spaceDef after calling msdBuildPhase7bSearchSpaceDefinition().
