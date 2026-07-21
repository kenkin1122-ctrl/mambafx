# Claude Developer Handoff — Market State Discovery Laboratory

**Project**: Mamba FX / Market State Discovery Laboratory  
**Repository**: `https://github.com/kenkin1122-ctrl/mambafx`  
**Production URL**: `https://kenkin1122-ctrl.github.io/mambafx/`  
**Backend**: `https://mambafx-backend.kenkin1122.workers.dev`  
**Phase**: Phase 8 Integrated  
**Date**: 2026-07-21

---

## 1. How to Read This Document

This is a developer-grade technical handoff for continued development inside Claude. Read it before touching any code. The project has unusual properties — a 36K-line single-file application, zero build step, browser-only database, server-side vm extraction — that will cause confusion if not understood upfront.

---

## 2. Overall Architecture

### The Golden Rule

**`index.html` is the entire application.** It is not an HTML shell that loads a JS bundle. The CSS, all inline JS (~32K lines), all page HTML, all MSD science, all bots, all indicator engines, and all UI live inside this one file. Do not attempt to refactor it into separate files — that is explicitly against project policy.

### Component Map

```
Browser Runtime:
  index.html            — The entire front-end app
  mtf/src/index.js      — ES module entry for MTF/Njanja tabs only
  
Node.js Runtime (Replit / development):
  server.js             — Static file server (port 5000)
  phase8-engine.js      — Phase 8 discovery engine (vm sandbox)
  
Cloudflare Workers (production backend):
  src/index.js          — OAuth session management
  
Browser Storage:
  IndexedDB             — All scientific data (3 databases)
  localStorage          — MTF drawings, user settings
  sessionStorage        — Bot panel drag positions
  
External Services:
  wss://ws.binaryws.com — Deriv WebSocket (tick feed, trading)
  mambafx-backend.*     — Cloudflare Worker (OAuth)
```

### What is NOT present

- No React, Vue, Angular, Svelte, or any framework
- No webpack, Vite, Rollup, or bundler
- No TypeScript (all plain JavaScript)
- No server-side database (IndexedDB is browser-only)
- No test framework (verification is via standalone HTML tools)
- No npm packages in production (server uses Node.js stdlib only)

---

## 3. Folder Structure

```
/
├── index.html          ← DO NOT REFACTOR. The entire app.
├── server.js           ← Minimal Node.js HTTP server (stdlib only)
├── phase8-engine.js    ← Phase 8 server-side engine (vm context)
│
├── mtf/src/            ← ES module tree (MTF Structure + Njanja Analysis)
│   ├── index.js        ← Module entry (booted by index.html script tag)
│   ├── core/           ← AppState, EventBus, HistoryManager, constants
│   ├── charts/         ← Canvas rendering, WebSocket, panels
│   ├── drawing/        ← Drawing objects, interaction, model
│   ├── ui/             ← Panel UIs
│   ├── ai/             ← Commentary, learning, intelligence
│   ├── analysis/       ← Pattern detection, statistics
│   ├── orderflow/      ← Order-flow proxy
│   ├── utils/          ← DOM helpers, color, geometry
│   └── workspace/      ← Storage, workspace management
│
├── src/index.js        ← Cloudflare Worker (OAuth backend)
├── wrangler.jsonc      ← Cloudflare deployment config
│
├── *.html              ← Standalone audit/analysis tools (Phase 7 + Phase 8)
├── *.md                ← Documentation
└── .gitignore
```

### Directories that were removed (pre-release cleanup)

The following were present in earlier commits but removed before this release:
- `mtf-module-5min-commentary/` — development snapshot (obsolete)
- `mtf-module-continuous-learning/` — development snapshot (obsolete)
- `mtf-module-fib-retracement/` — development snapshot (obsolete)
- Root-level duplicate JS files — orphaned copies of `mtf/src/` modules
- `attached_assets/Pasted-*.txt` — pasted conversation prompts

---

## 4. index.html Architecture (Critical)

### Line Map

The file is ~36,134 lines. Major sections (approximate 1-based line numbers):

| Lines | Content |
|-------|---------|
| 1–50 | `<!DOCTYPE html>`, `<head>`, `<meta>` |
| 51–600 | CSS (`<style>` block) |
| 601–3385 | HTML page divs (all ~30 pages in the DOM simultaneously) |
| 3386–3387 | `<script>` opening tag |
| 3388–4360 | Developer AI Mode (debug broadcaster, vm-excluded) |
| 4361–12460 | **MSD Core** (all MSD functions, constants, IndexedDB ops) |
| 12461–25000 | Live Tracker, Trading Grid, Bot Engines, Indicator charts |
| 25001–25680 | Aggression Bot (global scope — previously inside gridCheckSession, fixed) |
| 25681–26000 | showPage(), session management, OAuth flow |
| 26001–33200 | MSD Lab UI (Explorer, Inspector, Distribution, Correlation, Search, Experiment Runner, Knowledge Base, Validation Suite, Workbench, Phase 8 Campaign) |
| 33201–33787 | Remaining bot UIs (ADX Bot, RFA Bot, Mamba FX Bot, DAB Bot — global scope) |
| 33788 | `</script>` |
| 33789–34908 | `<script type="module" src="mtf/src/index.js">` |
| 34909–36134 | HTML footers, closing tags |

### The `$()` Helper

Inside `index.html`, `$("id")` is defined as `document.getElementById` alias. This is NOT the same as jQuery. It is a plain function defined near the top of the inline script.

```javascript
function $(id) { return document.getElementById(id); }
```

In `mtf/src/utils/dom.js`, the same pattern is used:
```javascript
export const $ = id => document.getElementById(id);
```

These are two separate definitions — the mtf module's `$` is not the same as the inline script's `$`.

### Page System

Pages are toggled via `showPage(key)`:
```javascript
const pages = {
  live: 'page-live',
  candles: 'page-candles',
  // ... ~30 entries
  msdphase8: 'page-msdphase8'
};
```

The active page gets `classList.add('active')` (CSS: `display:block`). All others get `classList.remove('active')` (`display:none`). Each page has an `init` hook called on first navigation.

### Navigation

Navigation buttons are in the HTML with `onclick="showPage('key')"`. There are 4 navigation rows visible via a scrollable nav area. The Phase 8 Campaign button is `id="navMsdPhase8"`.

### Adding New Features

When adding a new page:
1. Add HTML div with `id="page-<key>" class="page"` anywhere in the HTML section
2. Add a nav button: `<button id="nav<Key>" onclick="showPage('<key>')">...</button>`
3. Add `'<key>': 'page-<key>'` to the `pages` object in `showPage()`
4. Add `'<key>': 'nav<Key>'` to the `navs` object in `showPage()`
5. Add an init hook inside `showPage()` if the page needs lazy initialization
6. Add the JavaScript functions for the page anywhere in the inline script

---

## 5. All Engines

### MSD Core Engine (index.html ~lines 4361–12460)

The scientific heart of the application. Contains:

**Capture pipeline**: `msdCaptureMarketState` → `msdBuildLabeledSnapshot` → IndexedDB

**Enrichment**: `msdEnrichWithNonClassicalFeatures` — computes 18 ncf_v1 features from `rawPriceHistory`. Never call for states without `rawHistoryValid=true`.

**Discovery**: `msdRunPhase7bDiscovery(states, opts)` — main discovery function. Calls: enrichment → `msdBuildNcSnapshotRows` → `msdRunPermutationTest` × 80 hypotheses.

**Positive control**: `msdRunPositiveControlSmoke(states)` — injects synthetic effect, verifies detection.

**Validation**: `msdRunIntegrityChecklist(states)` — 20-point pre-flight check.

**Constants** (never change without bumping versions):
- `MSD_FEATURE_SCHEMA_VERSION = 'v1'`
- `MSD_NC_FEATURE_VERSION = 'ncf_v1'`
- `MSD_RAW_HISTORY_WINDOW_LENGTH = 20`
- `MSD_NC_REQUIRED_WINDOW_LENGTH = 20`
- `MSD_SEARCH_SPACE_SPEC_VERSION_V2 = 'search_space_spec_v2'`

### Phase 8 Engine (phase8-engine.js)

Extracts the MSD function library from `index.html` and executes it in a Node.js `vm` sandbox.

**Critical**: The slice range is `[4360, 12460)` (0-indexed). This range was found by binary search as the highest valid parse-and-execute boundary. If `index.html` grows, the range must be recalculated.

**How to recalculate the range**:
```bash
node -e "
const fs=require('fs'),vm=require('vm');
const lines=fs.readFileSync('index.html','utf8').split('\n');
function trySlice(s,e){const raw=lines.slice(s,e).join('\n').replace(/[^\x00-\x7F]/g,' ');try{new vm.Script(raw);return true;}catch(e2){return e2.message.slice(0,30);}}
// Find new start: grep for 'let msdEventSeq' → subtract 1
// Binary search for highest valid E
for(const e of [12450,12460,12470,12480]){console.log(s+'-'+e+':',trySlice(4360,e));}
"
```

**Start line**: The first line of the MSD library (`let msdEventSeq = 0`). If the Developer AI Mode section grows, this shifts. Grep for `let msdEventSeq` to find the new 1-based line number, then subtract 1 for 0-indexed start.

**vm stubs**: The engine stubs `document`, `window`, `crypto`, `indexedDB`, `sessionStorage`, `localStorage`, `setTimeout`, `setInterval`, `performance`, `navigator`, `location`. These stubs return safe no-ops. Any new MSD function that uses browser APIs will fail silently in the vm (which is correct — MSD functions should be pure).

### Live Tick Engine (index.html inline, ~lines 12461–14000)

Processes the Deriv WebSocket tick stream:
- `connect()` — opens WebSocket, handles `tick` messages
- `processTick(price)` — detects 5-in-a-row runs, fires capture
- `showBanner(dir)` — animates the #banner div (in page-live only)
- `resetState()` — clears UI and tick state on market switch

**WebSocket protocol**: Deriv API v3. Subscribes to `ticks` after connection. Uses OTP from `/ws/otp` for authenticated feeds.

### Bot Engines

All bots are independent systems sharing only the WebSocket feed and the Trading Grid authenticated connection:

| Bot | Init function | Tick hook | Notes |
|-----|--------------|-----------|-------|
| Prediction Bot | `pbPageInit()` | `pbOnTick()` | Pattern-match based |
| Only Ups/Downs | `ouPageInit()` | `ouOnTick()` | Multi-filter |
| Rise/Fall Autobot | `rfaPageInit()` | `rfaOnTick()` | ADX+pattern |
| ADX Bot | `adxPageInit()` | `adxOnTick()` | ADX threshold |
| Aggression Bot | `aggPageInit()` | `aggOnTick()` | High-frequency |
| Mamba FX Bot | `mfxInit()` | via grid connection | Floating panel |
| DAB Bot | (initialized inline) | via grid connection | Floating panel |

**Important bug history**: Prior to Phase 8 release, `aggPageInit` and `aggOnTick` were accidentally scoped inside `gridCheckSession()`, making them globally inaccessible. This was fixed — they are now at global scope. Do not put code inside `gridCheckSession()`.

### MTF Module Engines

The MTF/Njanja pages use the `mtf/src/` ES module tree. These are the only pages that use ES modules:

- **Pattern Engine** (`mtf/src/analysis/patternEngine.js`) — detects candle/structure patterns
- **Render Engine** (`mtf/src/charts/render.js`) — `requestAnimationFrame` render loop
- **Probability Engine** (`mtf/src/ai/probabilityEngine.js`) — outcome probability from historical matches
- **Continuous Learning** (`mtf/src/ai/continuousLearning.js`) — updates pattern weights

---

## 6. All Databases

### IndexedDB: `mfx_msd_events` (v1)

Store: `EventDatabase`, keyPath: `eventId`

Stores market run events (5-consecutive-tick detections). One record per detected run.

### IndexedDB: `mfx_msd_states` (v1)

Store: `MarketStates`, keyPath: `snapshotId`

**The scientific dataset.** One record per (event × lead time) pair. The 36 classical field + `rawPriceHistory[20]`. See `DATABASE_SCHEMA.md` for full field list.

**NC features are NOT stored here.** They are computed at query time.

### IndexedDB: `mfx_msd_experiments` (v1)

Store: `Experiments`, keyPath: `experimentId`

Stores experiment configs, results, and knowledge base entries.

### localStorage

Used by `mtf/src/workspace/storage.js` for drawing persistence. Keys: `mfx_drawings_<symbol>`, `mfx_last_market`, `mfx_workspace_<id>`.

### sessionStorage

Used for bot panel drag persistence. Keys: `mfxBotPos`, `dabBotPos`.

---

## 7. All Pipelines

### Live Data Capture Pipeline

```
Deriv WS tick → processTick() → detect 5-run → msdCaptureMarketState()
    → msdBuildLabeledSnapshot() → msdPutState() → mfx_msd_states
```

Runs on the Live Tick Feed page. Capture fires at the moment a 5-in-a-row run is detected.

### NC Enrichment Pipeline

```
msdGetAllStates() → filter NC-eligible → msdEnrichWithNonClassicalFeatures()
    → in-memory enriched states (not persisted)
```

Runs at campaign start. NC features are computed but not written back to IndexedDB.

### Phase 8 Campaign Pipeline

```
Browser: ph8Boot() → ph8LoadSeal() → ph8RunChecklist() → [user clicks Run]
    → ph8CollectStates() → POST /api/phase8/run {states}
    
Server: phase8-engine.js:runCampaign(states)
    → vm.runInContext(msdLibrary) → msdRunPhase7bDiscovery()
    → {ok, hypotheses, log, serverElapsedMs}
    
Browser: ph8RenderResults() → display hypothesis table
```

### MTF Data Pipeline

```
Deriv WS → mtf/src/charts/socket.js → AppState.panels
    → mtf/src/charts/render.js (rAF loop) → Canvas draw
    → mtf/src/analysis/* → mtf/src/ui/* panels
```

Runs on MTF Structure / Njanja Analysis pages. Completely independent of MSD pipeline.

---

## 8. All Discovery Engines

### Phase 7B Discovery (`msdRunPhase7bDiscovery`)

The core discovery function. Tests NC features against outcomes using permutation tests.

**Location**: `index.html` ~lines 4360–12460 (exact location shifts as file grows)

**Signature**: `msdRunPhase7bDiscovery(states, opts) → { ok, hypotheses, log }`

**Called by**: Phase 8 engine (via vm context) and standalone Phase 7B HTML tool.

### Phase 7C Verification (`msd-phase7c-verification.html`)

6 pure-computation verification functions that validate the math:
1. Shannon entropy formula
2. Permutation entropy (Bandt-Pompe)
3. Mann-Whitney U statistic
4. Rank-biserial correlation
5. Run-length computation
6. Path efficiency

These are test functions — they do not use real data.

### NC Discovery Orchestrator

`msdRunNcDiscovery(states, opts)` — orchestrates the full NC discovery loop including enrichment, dataset construction, and permutation testing. Wraps `msdRunPhase7bDiscovery` with additional bookkeeping.

---

## 9. All Experiment Engines

### Experiment Runner (`msdexperiment` page)

Runs parameterized sub-campaigns with configurable:
- Feature subset
- Lead time subset
- Partition (full / train / holdout)
- Permutation count
- Alpha threshold

Results are stored in `mfx_msd_experiments` IndexedDB.

### Research Validation Suite (`msdvalidation` page)

Runs the 20-point integrity checklist. Each check is categorized:
- Data sufficiency (counts, coverage)
- Data quality (corruption, range, dedup)
- Scientific controls (positive control, seal, cardinality)
- Protocol compliance (symbol consistency, label version, connectivity)

---

## 10. All Integrity Systems

### 20-Point Integrity Checklist (`msdRunIntegrityChecklist`)

Runs before every Phase 8 campaign. Checks are numbered 1–20. See `PHASE8_PROTOCOL.md` for full list.

**Key check #6**: Feature version consistency. Checks that all NC-eligible states share the same stored `featureVersion`. The stored version is `'v1'` by design — NC enrichment version (`ncf_v1`) is computed at query time, not stored. A mixed-version dataset (e.g., half `v1`, half `v2`) is fatal.

**Key check #11**: Positive control smoke test. 30 trials with injected effect size Cohen's d ≈ 3.0. Must pass ≥ 90% of trials. This confirms the permutation test pipeline actually works.

**Key check #12–13**: Seal integrity. The seal must load (`ok:true`) and its hash must match the expected hash for the current `index.html` version.

### Data Quality Report (`msdComputeDataQualityReport`)

Returns per-feature completeness and corruption rates. Used by the Research Validation Suite page.

### Block Replication (`msdVerifyBlockReplication`)

Splits observations into temporal thirds and re-runs each significant hypothesis in each block. A hypothesis that appears significant only in one block is flagged for replication failure.

### Capture Deduplication (`msdCheckDuplicate`)

Before writing a new MarketState, checks for near-identical existing states. Threshold: 2% feature distance. Duplicates are excluded from analysis but not deleted from the DB.

---

## 11. All UI Modules

### Inline UI (index.html)

Every page UI is implemented as inline HTML + JavaScript in `index.html`. There are no separate CSS files or component files.

**Pattern for page initialization**:
```javascript
// In showPage():
if (which === 'mypage') {
  if (typeof myPageInit === 'function') myPageInit();
}

// Init function (called once, guarded by booted flag):
let myPageBooted = false;
function myPageInit() {
  if (myPageBooted) return;
  myPageBooted = true;
  // ... setup code
}
```

### MTF Module UI (`mtf/src/ui/`)

Panels for the MTF Structure and Njanja Analysis tabs:
- `toolbar.js` — drawing tool selection
- `header.js` — symbol/timeframe selectors
- `analysisPanel.js` — pattern analysis display
- `decompPanel.js` — candle decomposition
- `drawingManager.js` — drawing object list
- `propertiesPanel.js` — selected drawing properties
- `smartIntelligencePanel.js` — AI pattern intelligence
- `workspacePanel.js` — workspace management
- `zonePresets.js` — supply/demand zone presets
- `replayControls.js` — historical replay controls
- `floatingPanel.js` — draggable floating panel base
- `candleCommentaryPanel.js` — AI candle commentary
- `fiveMinCommentaryPanel.js` — 5-min timeframe commentary

---

## 12. How the Application Starts

### Server Start

```bash
node server.js
```

1. HTTP server starts on port 5000, binding `0.0.0.0`
2. `phase8-engine.js` is NOT loaded yet (lazy-loaded on first API call)
3. Server serves all static files

### Browser Load

1. Browser fetches `index.html` from `http://localhost:5000/`
2. `<style>` block sets up all CSS variables and page classes
3. HTML: all ~30 page divs are created, all `display:none` except `#page-live` (default active page)
4. `<script>` block (inline): 
   - Developer AI Mode is initialized
   - MSD constants and functions are defined
   - All bot engines are defined (global scope)
   - `showPage('live')` is called (already default active)
   - Session check fires: `gridCheckSession()` → `GET /me/session` → if logged in, enables Trading Grid features
   - Live Tick Feed WebSocket connection starts
5. `<script type="module" src="mtf/src/index.js">` is parsed and loaded asynchronously
   - `mtf/src/index.js` registers `window.mtfPageInit` but does NOT boot yet
   - MTF boot happens lazily when user navigates to MTF Structure or Njanja Analysis

### Phase 8 Engine Start (lazy)

On first call to `GET /api/phase8/seal` or `POST /api/phase8/run`:
1. `server.js` calls `require('./phase8-engine')`
2. `phase8-engine.js` reads `index.html` from disk
3. Extracts lines `[4360, 12460)`, strips non-ASCII, runs in vm context
4. Exports `getSeal()` and `runCampaign()`
5. Subsequent calls reuse the cached `_engine` module

---

## 13. How Data Flows

### Tick Data Flow

```
Deriv WS ─► raw tick price
    │
    ├─► processTick()
    │       └─► 5-run detected ─► msdCaptureMarketState()
    │                                   └─► mfx_msd_states IndexedDB
    │
    ├─► Indicator computation (MACD, BB, CCI, ADX, RSI, ATR, Stoch, EMA, ROC)
    │       └─► updateIndicatorDisplay()
    │
    ├─► Bot engines
    │       └─► ouOnTick(), rfaOnTick(), adxOnTick(), aggOnTick(), pbOnTick()
    │               └─► contract fire if conditions met
    │
    └─► rawPriceHistory buffer (last 20 prices)
            └─► captured with each MarketState snapshot
```

### Discovery Data Flow

```
mfx_msd_states IndexedDB
    │
    └─► msdGetAllStates()
            │
            └─► POST /api/phase8/run {states}
                    │
                    └─► phase8-engine.js vm context
                            │
                            ├─► msdEnrichWithNonClassicalFeatures()
                            │       └─► 18 ncf_v1 features (in memory)
                            │
                            ├─► msdBuildNcSnapshotRows()
                            │       └─► observation matrix
                            │
                            └─► msdRunPhase7bDiscovery()
                                    └─► 80 permutation tests
                                            └─► {hypotheses, pValues, effectSizes}
                                                    │
                                                    └─► ph8RenderResults() (browser)
```

### Authentication Data Flow

```
User clicks Login
    │
    └─► browser redirect → BACKEND/auth/start
            │
            └─► Deriv OAuth PKCE flow
                    │
                    └─► BACKEND/auth/callback (Cloudflare Worker)
                            │
                            └─► KV SESSION store (HttpOnly cookie)
                                    │
                                    └─► browser /me/session → authenticated
                                            │
                                            └─► /ws/otp → WS token
                                                    │
                                                    └─► wss://ws.binaryws.com (authorized)
```

---

## 14. Where Every Major Component Lives

| Component | Location |
|-----------|----------|
| All CSS | `index.html` `<style>` block, lines ~51–600 |
| All page HTML | `index.html` lines ~601–3385 |
| Developer AI Mode | `index.html` lines ~3388–4360 |
| MSD constants | `index.html` lines ~4390–4500 |
| MSD functions (all) | `index.html` lines ~4360–12460 |
| Live Tick Feed JS | `index.html` lines ~12461–14000 |
| Trading Grid JS | `index.html` lines ~14000–18000 |
| Bot Engines | `index.html` lines ~18000–25680 |
| showPage() + session | `index.html` lines ~25681–26000 |
| MSD Lab UI | `index.html` lines ~26000–33200 |
| Mamba FX Bot, DAB Bot | `index.html` lines ~33200–33787 |
| Phase 8 seal computation | `phase8-engine.js:getSeal()` |
| Phase 8 campaign execution | `phase8-engine.js:runCampaign()` |
| vm line range constant | `phase8-engine.js` line ~65: `htmlLines.slice(4360, 12460)` |
| MTF panel rendering | `mtf/src/charts/render.js` |
| MTF WebSocket | `mtf/src/charts/socket.js` |
| MTF drawing objects | `mtf/src/drawing/objects/` |
| MTF workspace storage | `mtf/src/workspace/storage.js` |
| OAuth backend | `src/index.js` (Cloudflare Worker) |
| HTTP server | `server.js` |

---

## 15. Known Issues

### Pre-Release Bugs Fixed (Phase 8 Release)

1. **`gridCheckSession()` structural defect** — `aggPageInit`, `aggOnTick`, and ~150 lines of Aggression Bot code were accidentally trapped inside `gridCheckSession()`, making them globally inaccessible. **Fixed**: moved to global scope.

2. **`aggPageInit()` unguarded in `showPage()`** — Called bare with no `typeof` guard, causing `ReferenceError` before Fix #1. **Fixed**: added `if (typeof aggPageInit === "function")` guard.

3. **Bot panels covering Phase 8 nav button** — MambaFX Bot and DAB Bot are `position:fixed; z-index:9999/9998`. Drag positions persist in `sessionStorage` across OAuth redirects. After login, bot dragged upward before login would restore at same position, covering the last nav row. **Fixed**: added nav-bottom clamping to both bots' `mousemove`, `touchmove`, and `loadPos` handlers.

4. **Feature version check always failing** — Integrity check #6 compared stored `featureVersion` against `'ncf_v1'`, but stored version is always `'v1'`. **Fixed**: check now verifies consistency (all states same version) not equality to `ncf_v1`.

5. **Seal endpoint `Unexpected token` error** — `phase8-engine.js` slice range was stale (referred to old line numbers before Developer AI Mode section was added). **Fixed**: range updated to `[4360, 12460)` with binary search validation.

6. **Campaign Readiness counters stuck at `—`** — `ph8Boot` only called `ph8RefreshReadiness()` on the success path after seal load. **Fixed**: added `ph8RefreshReadiness()` call in the catch block.

7. **Duplicate `id="banner"`** — Both page-live and page-oubot had `id="banner"`. The second one was unreachable by `$("banner")`. **Fixed**: second banner renamed to `id="ouBanner"`.

### Current Known Limitations

1. **Single-browser-tab architecture**: IndexedDB data is per-browser. Moving to a different browser or device loses all captured data. No data export/import feature yet.

2. **No data persistence across clears**: Clearing browser storage or IndexedDB loses the entire scientific dataset. Consider a periodic JSON export feature.

3. **Phase 8 engine line range drift**: Every time the `index.html` file grows (new features added), the `phase8-engine.js` slice range may become invalid. Monitor for this after each major addition. See `.agents/memory/phase8-engine-vm-range.md` for the binary search procedure.

4. **Deriv OAuth CORS in development**: The Cloudflare Worker backend is configured to allow only `https://kenkin1122-ctrl.github.io`. Authentication does not work at `http://localhost:5000` — expected behavior for development. All trading features require the production GitHub Pages URL.

5. **`gridCheckSession()` duplicate removal**: A duplicate dangling session-check block was removed. If future refactoring touches the session check area, verify there is exactly one `gridCheckSession` function in the file.

6. **`mtf/src/utils/dom.js` false positive**: A naive brace-counter incorrectly flags this file due to regex `[&<>"']` containing brackets. The file is syntactically correct.

### `phase8-engine.js` Header Stale Comment

The file's JSDoc comment at lines 5 and 10 still references "lines 3170–12000" — the old range before the Developer AI Mode section was added. This is cosmetically stale but does not affect behavior. Update when convenient.

---

## 16. Future Work

See `RESEARCH_ROADMAP.md` and `RESEARCH_DEBT_REGISTER.md` for full lists. Key items:

### Near-term
- **Run Phase 8 Campaign**: Now that the seal endpoint works and the checklist is passing, run the first official campaign against live-accumulated data on the production GitHub Pages instance.
- **Data export/import**: Add JSON export of `mfx_msd_states` for backup and analysis in external tools.
- **Phase 8 results storage**: Persist campaign results in `mfx_msd_experiments` for comparison across runs.

### Medium-term
- **Block replication verification**: Implement automated replication of discovered hypotheses across temporal blocks.
- **Multi-symbol expansion**: Extend MSD capture to Volatility 25 (1s), Volatility 50 (1s).
- **Feature engineering Phase 9**: Add microstructure features (tick velocity, acceleration, asymmetry).

### Scientific
- **Multiple comparisons correction**: Implement Benjamini-Hochberg FDR correction for the 80-hypothesis test.
- **Cross-symbol replication**: Test Phase 8 findings on a held-out symbol.
- **Causal analysis**: Investigate whether discovered features are causal or merely correlated via a common driver.

---

## 17. Development Guidelines

### Absolute Rules (from `replit.md`)

1. **Do NOT rewrite, refactor, or alter any existing functionality**
2. **Only add new code / new features**
3. **Existing code was built with Claude and is working correctly — treat it as stable**

### Safe Development Patterns

**Adding a new MSD analysis function**: Add it anywhere in the MSD Core section (`index.html` lines ~4360–12460). Keep functions pure (no DOM access) so they remain vm-compatible.

**Adding a new bot**: Add the bot's HTML in the HTML section, add a nav button, add `'botkey': 'page-botkey'` to `showPage()`, add the JS in the bot section. Follow the floating panel pattern (fix:position, sessionStorage drag position, nav-bottom clamping) for panel bots.

**Adding a new MSD Lab page**: Same pattern as any page, but also add to the `pages` and `navs` objects in `showPage()`. Lab pages go in the 4th nav row.

**Extending the NC feature set**: Add new `ncf_*` keys to `msdComputeNcFeatures()`. Update `MSD_PHASE7B_INDIVIDUAL_FEATURES`. Increment `MSD_NC_FEATURE_VERSION` to `'ncf_v2'`. Recalculate Phase 8 search space cardinality. New seal will be generated.

**Modifying the MTF module**: The `mtf/src/` tree is fully independent. Standard ES module development rules apply. Run `node --input-type=module < mtf/src/index.js` (from workspace root, pointing to the entry) as a parse check.

### What Breaks Phase 8

Any of the following will invalidate the Phase 8 seal:
- Modifying `msdBuildSearchSpaceV2()` in index.html
- Changing `MSD_PHASE7B_INDIVIDUAL_FEATURES`
- Changing `MSD_PHASE7B_MAX_CANDIDATES`
- Changing `MSD_PHASE7B_SYMBOL`
- Modifying any NC feature computation in `msdComputeNcFeatures()`
- Adding lines before `let msdEventSeq` (shifts the vm slice start)
- Adding lines in the MSD Core section that cause parse-time failure in vm context

After any change to the MSD Core section, always verify:
```bash
curl http://localhost:5000/api/phase8/seal | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).ok)"
```

---

## 18. Memory Files

The `.agents/memory/` directory contains persistent development notes. Key files:

| File | Contents |
|------|----------|
| `MEMORY.md` | Index of all memory topics |
| `phase8-engine-vm-range.md` | How to find the correct vm slice range after index.html grows |
| `phase8-checklist-featureversion.md` | Why check #6 tests consistency not equality |
| `phase8-campaign.md` | Phase 8 engine architecture |
| `phase8-capture-pipeline-repair.md` | History of the capture pipeline integrity fix |
| `phase7-nc-features.md` | NC feature engineering decisions |
| `phase7a-review.md` | Phase 7A audit results |
| `phase7b-implementation.md` | Phase 7B implementation notes |
| `phase7c-verification.md` | Phase 7C verification approach |

These files are in `.gitignore` and are not pushed to GitHub. They are Replit-local notes for the development agent.

---

## 19. Cloudflare Worker Backend

### Source: `src/index.js`

A minimal Cloudflare Worker that handles Deriv OAuth:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/start` | GET | Initiates OAuth PKCE flow, redirects to Deriv |
| `/auth/callback` | GET | Exchanges code for tokens, creates session |
| `/me/session` | GET | Checks session validity (HttpOnly cookie) |
| `/me/accounts` | GET | Returns authenticated user's accounts |
| `/ws/otp` | GET | Returns a one-time WebSocket token |
| `/logout` | POST | Clears session from KV store |

### Deployment

```bash
npx wrangler deploy    # from project root
```

**KV namespace**: `SESSION` (binding: `session`, ID: `17e093b1eeb844069a1ee1a8e98837eb`)

**Environment variables** (set in Cloudflare dashboard):
- `REDIRECT_URI`: `https://mambafx-backend.kenkin1122.workers.dev/auth/callback`
- `SPA_URL`: `https://kenkin1122-ctrl.github.io/mambafx/`
- `ALLOWED_ORIGIN`: `https://kenkin1122-ctrl.github.io`
- `DERIV_APP_ID`: (set in Cloudflare dashboard, not in wrangler.jsonc)

---

## 20. Quick Reference

### Key IDs in index.html

| ID | Purpose |
|----|---------|
| `#banner` | 5-in-a-row flash banner (page-live only) |
| `#ouBanner` | Only Ups/Downs Bot visual banner (page-oubot) |
| `#navMsdPhase8` | Phase 8 Campaign nav button |
| `#page-msdphase8` | Phase 8 Campaign page div |
| `#ph8ChecklistBody` | Phase 8 checklist table body |
| `#ph8ReadinessNC` | NC-eligible count counter |
| `#ph8SealStatus` | Seal load status badge |

### Key Functions to Know

| Function | Purpose |
|----------|---------|
| `showPage(key)` | Navigate to a page |
| `$("id")` | `document.getElementById` alias |
| `msdCaptureMarketState(snap, event)` | Capture a labeled snapshot |
| `msdEnrichWithNonClassicalFeatures(states)` | Add NC features to states |
| `msdRunPhase7bDiscovery(states, opts)` | Run the discovery engine |
| `msdRunIntegrityChecklist(states)` | Run 20-point pre-flight check |
| `ph8Boot()` | Initialize Phase 8 Campaign page |
| `ph8RunChecklist()` | Run Phase 8 pre-flight |
| `gridCheckSession()` | Check Deriv session status |
| `mtfPageInit()` | Boot MTF/Njanja module |

### Server Commands

```bash
node server.js                            # Start server on port 5000
curl http://localhost:5000/api/phase8/seal  # Test seal endpoint
curl -X POST http://localhost:5000/api/phase8/run \
  -H 'Content-Type: application/json' \
  -d '{"states": []}'                    # Test run endpoint (empty)
```
