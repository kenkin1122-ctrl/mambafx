# FUTURE PROJECT — index.html ES-Module Refactor: Planning Deliverables

Status: **planning only.** No line of `index.html` has been changed. This document is the 8 deliverables the original spec required before any implementation, produced against the real, current state of the repository (facts below were gathered by direct inspection of the sandbox, not assumed).

## 0. Ground truth, gathered before writing this plan

- `index.html` is 36,216 lines / ~2.10 MB (2,147,402 bytes) — close to, not identical to, the "~2.2 MB" figure in the original brief; treated as the same target.
- It contains 9 `<script>` blocks. In document order:

| # | Lines | Size | Content (identified by inspection) |
|---|---|---|---|
| 1 | 3387–33534 | ~30,147 lines | The legacy MSD/trading engine: config, state, WebSocket, candle/line charts, Phase 6/6B/7/7B/7C discovery pipeline + governance + ledger, Research Session Manager, Market State Search Tool, a full technical-indicator trading signal engine (BOS/CHoCH, EMA, MACD, RSI, DMI/ADX, CCI, wick strength, liquidity sweep, master score), 5-tick signal engine, Deriv API login/WS flow. |
| 2 | 33824–34313 | ~490 lines | "mfxBot" floating widget (drag/position persistence, minimize). Self-contained IIFE. |
| 3 | 34569–34942 | ~374 lines | "dabBot" — a second, near-identical floating widget IIFE. |
| 4 | 34944 | 1 line | `<script type="module" src="mtf/src/index.js">` — **already an ES module**, already shipping. |
| 5 | 34945–34952 | ~8 lines | Small debug-panel toggle glue. |
| 6 | 34953 | 1 line | `<script type="module" src="research/integration/bootstrap.js">` — **already an ES module** (this project's own Phase 10 work). |
| 7 | 34965–35054 | ~90 lines | Debug panel renderer (reads globals, formats a small HTML table). |
| 8 | 35057–35700 | ~644 lines | Phase 8 feature-family reference data + a report/labeling module, reads Phase 8 results via `window._ph8GetResult()`. |
| 9 | 35703–36214 | ~512 lines | "Phase 8 Integrity Module" — self-check that recomputes expected seed/perms/alpha/cardinality/null-model/correction against `window._ph8GetSeal()`/`window._ph8GetResult()`. |

- **The frozen Phase 8 seal (`phase8-engine.js`'s `getSeal()`) extracts `index.html` lines `[4361,12460]` (1-based) verbatim and hashes them → `36b45239`.** That range sits entirely inside script block #1. There is no inline marker comment (`/* SEAL START */` or similar) delimiting it — it is purely an absolute line-number window hardcoded in `phase8-engine.js`. Confirmed by reading the actual lines at both boundaries (4355–4365, 12455–12465): ordinary code flows across both cuts with nothing marking them.
- Because the extraction is by **absolute line number**, inserting or deleting even a single line **anywhere at or before line 12460** — including well before line 4361 — silently shifts the window and changes what physically occupies it, corrupting the hash even if the "sealed" lines themselves are never edited. This is not a new discovery: it's the exact bug already caught and fixed once during Phase 10 v1 (a dashboard nav-button insertion landed before the boundary and shifted the hash), which is why every dashboard addition since has been built at runtime via `dashboardUI.js` rather than as static markup.
- Content strictly **after line 12460** can be freely moved, edited, or deleted without affecting the seal at all, because nothing shifts the window's absolute position from below.
- 954 top-level `function`/`async function` declarations and 417 top-level `var`/`let`/`const` declarations live in script block #1 alone.
- 9 legacy IndexedDB databases are opened from `index.html`: `mfx_msd_events`, `mfx_msd_states`, `mfx_msd_experiments`, `mfx_msd_knowledge`, `mfx_msd_discovery_lab`, `mfx_msd_discovery_ledger`, `mfx_msd_engineering_lab`, `mfx_msd_positive_control`, `mfx_msd_negative_control`, plus `mfx_martingale_x` — separate from the three already-modularized databases (`mfx_research_governance`, `mfx_research_monitoring`, `mfx_research_scheduler_state`).
- **This project already has a large, working, already-shipping ES-module precedent inside this exact app**: `mtf/src/` (67 files: `analysis/`, `ui/`, `core/`, `core/commands/`, `utils/`, `orderflow/`, `charts/`, `workspace/`, `drawing/`, `drawing/objects/`, `ai/`), `research/src/` (47 files: `services/`, `storage/`, `storage/adapters/`, `core/`, `statistics/`, `governance/`, `discovery/`), and `research/integration/` (9 files, this project's Phase 9/10 work). All three trees are loaded via `<script type="module" src="...">`, all are GitHub-Pages-compatible (no build step), and all are exercised by the 659-test suite. The FUTURE PROJECT's target architecture is not a bet on an unproven pattern — 123 files of it already exist and ship.

This last point reframes the whole roadmap: the goal is not "introduce ES modules to this app" (already done, twice) but "finish decomposing the one remaining monolith — script block #1, plus the small widget/debug/reporting blocks #2/3/7/8/9 — into that same, already-proven pattern."

## 1. Refactoring roadmap

Ordered by risk, cheapest and safest first. Each phase is independently shippable and testable; nothing in a later phase is required for an earlier phase to be complete and correct on its own.

- **Phase R0 (prerequisite, not optional): re-baseline the seal mechanism itself.** Before any code that currently sits at or before line 12460 can ever move, `phase8-engine.js`'s `getSeal()` must stop being line-number-addressed and become marker-addressed (explicit `/* MSD-PHASE8-SEAL-START */` / `/* MSD-PHASE8-SEAL-END */` comments surrounding the exact same content, extracted by string search instead of by absolute index). This is a one-time, carefully-audited change: the new marker-based extraction must be proven byte-identical to the current line-based extraction (same `36b45239` hash) before it replaces the old mechanism, and the change itself must be treated with the same rigor as every other Phase 8-adjacent change in this project (re-verify the hash after, not just diff the code). **Nothing else in this roadmap depends on Phase R0 except Phase 5** (touching anything currently inside or before the sealed window). Phases 1–4 below need none of this and can start immediately.
- **Phase 1 (lowest risk): extract the self-contained widget/debug/reporting blocks.** Script blocks #2 (`mfxBot`), #3 (`dabBot`), #5, #7 (debug panel), #8 (Phase 8 feature-family labels/report), #9 (Phase 8 Integrity Module) — all sit after line 33534 or 35054, entirely outside the sealed window, are each already a self-contained IIFE with a small, enumerable set of DOM-element and `window.*` dependencies, and have zero dependency on each other. Each becomes one ES module in `src/ui/widgets/` (mfxBot, dabBot), `src/dashboard/` (debug panel, Phase 8 report), following the exact runtime-DOM-injection and `window.*`-thin-pass-through patterns already established and tested in `research/integration/`.
- **Phase 2: extract the "safe zone" of script block #1 — everything after line 12460.** This is the largest single win: roughly 21,000 of script block #1's ~30,000 lines (Research Session Manager, Market State Search Tool, the full trading signal engine, Deriv API login/WS flow, UI update glue) sit after the sealed window and can be moved freely. Target folders per the suggested tree: `src/api/` (Deriv login/WS), `src/charts/` (candle/line chart renderers — note some chart code also appears before line 4361; see Phase 4), `src/ui/` (market selector, UI update glue), `src/discovery/`-adjacent trading logic where it genuinely overlaps research concerns, and a new `src/trading/` (not in the original suggested list, but warranted — the BOS/CHoCH/EMA/MACD/RSI/master-score signal engine and the 5-tick signal engine are a distinct, cohesive concern with no natural home in `discovery/`, `statistics/`, or `governance/` as scoped; recommend adding it, or folding it into `ml/` if that's judged a closer fit — an open question for approval, see §open decisions below).
- **Phase 3: extract IndexedDB access into `src/storage/`.** The 9 legacy database-opening call sites, once their surrounding logic has moved in Phases 1–2, become straightforward to consolidate into typed adapter modules mirroring the pattern `research/src/storage/adapters/` already established (e.g. `appendOnlyAdapter.js`'s reuse precedent). Database names, versions, and object-store schemas are preserved byte-for-byte — this phase is a pure "move the access code," never a schema change.
- **Phase 4 (higher risk, still before the seal): extract config/state/WebSocket/chart code that sits in script block #1 before line 4361** (the `Config`/`State`/`Persistence`/`WebSocket`/candle-and-line-chart-rendering sections identified at lines 3493–4154). This code is outside the sealed range itself but sits *before* it — meaning removing it from `index.html` shifts every line number after it, including the seal's boundaries. **This phase cannot happen until Phase R0 (marker-based seal) is complete**, because only then does removing these lines stop silently corrupting the hash. Target: `src/app/` (bootstrap/config/state), `src/charts/` (chart renderers, joining the already-modularized chart code arriving from `mtf/src/charts/` — a consolidation opportunity worth flagging for a future decision, not this phase).
- **Phase 5 (highest risk, explicitly out of scope for now): the sealed region itself, lines 4361–12460.** This is the core MSD scientific engine (Phase 6/6B/7/7B/7C discovery, governance, ledger, hypothesis lifecycle). Recommend this phase remain **explicitly deferred** past everything else in this document, and only be attempted as its own separately-scoped, separately-approved future effort — not because it's impossible (Phase R0's marker-based extraction makes it technically tractable), but because "zero behavioral changes" is hardest to prove exactly where the stakes are highest, and every other phase already delivers the overwhelming majority of the maintainability benefit (roughly 29,000 of the file's 36,216 lines, or about 80%, are addressed by Phases 1–4 without ever touching the sealed core).

## 2. Dependency graph

Current state:

```
index.html (36,216 lines)
 ├─ <script> #1  [3387–33534]  legacy monolith
 │    ├─ [3387–4360]   config/state/WebSocket/charts          (Phase 4 target)
 │    ├─ [4361–12460]  ★ FROZEN — Phase 8 sealed core          (Phase 5, deferred)
 │    └─ [12461–33534] research session mgr / signal engine /  (Phase 2 target)
 │                      login-WS / market search / UI glue
 ├─ <script> #2  [33824–34313] mfxBot widget                   (Phase 1 target)
 ├─ <script> #3  [34569–34942] dabBot widget                   (Phase 1 target)
 ├─ <script type="module" src="mtf/src/index.js">               ← ALREADY MODULAR (67 files)
 ├─ <script> #5  [34945–34952] debug-panel glue                (Phase 1 target)
 ├─ <script type="module" src="research/integration/bootstrap.js"> ← ALREADY MODULAR (9 files)
 │    └─ imports research/src/ (governance, discovery, statistics, storage) ← ALREADY MODULAR (47 files)
 ├─ <script> #7  [34965–35054] debug panel renderer            (Phase 1 target)
 ├─ <script> #8  [35057–35700] Phase 8 feature-family/report   (Phase 1 target)
 └─ <script> #9  [35703–36214] Phase 8 Integrity Module        (Phase 1 target)
```

Target state after Phases 1–4 (Phase 5 deferred, sealed core stays inline):

```
index.html (much smaller: bootstrap + the still-frozen [4361,12460] block + <script type="module"> tags)
 └─ <script type="module" src="src/app/bootstrap.js">
      ├─ src/app/            (config, state, top-level wiring)
      ├─ src/ui/             (market selector, debug panel, widgets)
      ├─ src/charts/         (candle/line chart renderers -- + existing mtf/src/charts/)
      ├─ src/api/            (Deriv login/WS)
      ├─ src/storage/        (legacy IndexedDB adapters, 9 DBs)
      ├─ src/trading/ or ml/ (signal engine -- see open decision)
      ├─ src/dashboard/      (Phase 8 feature-family report, Integrity Module)
      ├─ mtf/src/            (unchanged -- already modular)
      ├─ research/src/       (unchanged -- already modular)
      └─ research/integration/ (unchanged -- already modular)
```

Every arrow in both diagrams is a static ES module `import`/`<script type="module" src="...">` reference — no bundler, no build step, matching the constraint already proven three times over in this repository.

## 3. Module decomposition plan

Mapped against the suggested tree from the original brief, with a status column reflecting what's already done vs. what Phases 1–4 would add:

| Folder | Status today | What Phases 1–4 add |
|---|---|---|
| `app/` | does not exist | bootstrap, config, top-level state (from script #1's pre-seal zone; Phase 4) |
| `ui/` | `mtf/src/ui/` exists | market selector, debug panel, mfxBot/dabBot widgets (Phases 1, 2) |
| `charts/` | `mtf/src/charts/` exists | candle/line chart renderers currently in script #1 (Phases 2, 4) |
| `dashboard/` | `research/integration/dashboardUI.js` exists (Research Dashboard) | Phase 8 feature-family report + Integrity Module (Phase 1) |
| `api/` | does not exist | Deriv login/WS flow (Phase 2) |
| `storage/` | `research/src/storage/` exists (governance DBs) | legacy 9-database adapters (Phase 3) |
| `workers/` | does not exist | not identified as needed by anything inspected so far — no existing Web Worker usage found in `index.html`; flag as "no action" unless a specific need surfaces |
| `research/` | `research/src/` + `research/integration/` exist | no change — already complete |
| `discovery/` | `research/src/discovery/` exists | no change — already complete |
| `statistics/` | `research/src/statistics/` exists | no change — already complete |
| `governance/` | `research/src/governance/` exists | no change — already complete |
| `ml/` | does not exist | candidate home for the trading signal engine (open decision, see below) |
| `utilities/` | `mtf/src/utils/`, `research/src/core/` exist | any remaining generic helpers from script #1 not otherwise categorized |

**Open decision to flag for approval, not resolved by this plan**: the ~1,900-line technical-indicator trading signal engine (BOS/CHoCH, EMA/MACD/RSI/DMI/ADX/CCI, master score, 5-tick signal engine) doesn't map cleanly onto any folder in the suggested tree. Recommend either adding `src/trading/` as a thirteenth top-level folder, or placing it under `ml/` if its scoring/weighting logic is considered close enough to "ML" in spirit. This needs a decision before Phase 2 starts, not before this plan is approved.

## 4. Migration strategy

- **Marker-based seal re-baseline first (Phase R0).** Replace `phase8-engine.js`'s absolute-line-number extraction with explicit begin/end marker comments inserted immediately around the existing (unmoved, unedited) sealed lines. Verify the new extraction produces the identical `36b45239` hash before relying on it for anything. This decouples all future `index.html` edits before line 12460 from accidental hash corruption, without requiring the sealed code itself to move.
- **Extract outward-in, never touch the sealed core directly.** Every phase in §1 above only ever removes code from `index.html` that sits entirely outside `[4361,12460]`, replacing it with a `<script type="module" src="...">` reference — the exact substitution pattern already used for `mtf/src/index.js` and `research/integration/bootstrap.js`.
- **Compatibility shims during transition, not permanently.** Code being extracted almost always exposes and consumes `window.*` globals (e.g. `window.mfxToggleDebugPanel`, `window._ph8GetSeal`). Each extracted module keeps assigning to the same `window.*` names it always did, exactly as `research/integration/bootstrap.js` already does for `window.mfxSchedulerPause` etc. — nothing downstream (including the not-yet-extracted parts of script #1, or blocks #8/#9 which read `window._ph8GetSeal`/`window._ph8GetResult`) needs to change in the same commit. A later, separate cleanup phase (not scoped here) could replace `window.*` globals with real module interfaces once every consumer has itself been identified and migrated — but that is a bigger, riskier change than "move the code" and should stay a distinct, later decision.
- **One extraction = one commit = one reversible, testable step**, per the original brief's PROCESS section. No phase above is itself atomic at the "whole phase" level; each phase is a sequence of single-block-or-single-concern extractions.
- **IndexedDB compatibility is migration-transparent.** Because Phase 3 only relocates the *access code*, not the database names, versions, or object-store schemas, existing users' saved data (all 9 legacy databases plus the 3 already-modularized ones) is untouched by construction — there is no data migration step in this plan at all.

## 5. Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Any line added/removed before line 12460 silently shifts and corrupts the Phase 8 seal hash | Critical | Phase R0 (marker-based re-baseline) before Phase 4; Phases 1–3 never touch anything before line 12460 in the first place |
| A `window.*` global an unmigrated caller depends on gets renamed or dropped during extraction | High | Compatibility-shim strategy (§4); a structural test per extracted module asserting the same `window.*` names are still assigned, mirroring the guardrail-test pattern already used throughout `research/integration/` |
| 954 top-level functions and 417 top-level declarations in script #1 have undocumented cross-references (function A calls function B thirty thousand lines away) | High | Extraction order in §1 is deliberately outside-in specifically so the least-connected code (self-contained widgets) moves first, building confidence before attempting more entangled sections; each extraction step re-runs the full suite plus a manual dependency grep, not just a diff |
| "Zero behavioral changes" is unverifiable without a real browser | Medium–High | This sandbox has no browser/GUI; the existing Node-side harness pattern (`phase8-engine.js`'s vm-context extraction) can be extended for non-DOM logic, but any DOM-dependent behavior (chart rendering, widget dragging) genuinely needs a human or a real-browser check this environment cannot perform — flagged honestly rather than claimed as done |
| IndexedDB schema drift during Phase 3 relocation | Medium | Phase 3 is scoped as "move access code only," with a test asserting database names/versions/schemas are byte-identical before and after each relocation |
| Scope creep into Phase 5 (the sealed core) because "just this one function" seems safe | Medium | Explicit standing rule for this whole effort: Phase 5 does not start without its own separate, dedicated approval, exactly like every other high-stakes step in this project's history |
| The suggested 13-folder tree doesn't have a clean home for the trading signal engine | Low | Flagged as an open decision in §3, resolved before Phase 2 rather than blocking approval of this plan |

## 6. Validation checklist

Per extraction step:

- `node --check` on every new/modified file.
- Full repository test suite (currently 659/659) re-run and must stay green.
- Phase 8 seal re-verified by actually executing `getSeal()` (not diffed/assumed) after every single step that touches anything before line 12460 — which, per this plan, should be zero times until Phase R0 and Phase 4/5 are separately approved.
- A structural guardrail test per extracted module confirming its previously-existing `window.*` assignments are still present (reusing the import-block-check / comment-stripped-executable-check pattern already established in this project).
- An independent clean-room copy re-run of the full suite after each phase (not each individual commit), matching the rigor already applied to every Phase 9/10 delivery.
- **Explicitly not claimed as done without a browser**: real-user-facing behavior (chart rendering pixel-for-pixel, widget drag interactions, the live trading signal panel's visual output) cannot be verified by me in this sandbox. Any claim of "verified identical behavior" for DOM-visible features would need an actual human or real-browser check — this plan does not promise that verification will happen automatically, and any report produced during implementation will say so honestly rather than assume it.

## 7. Rollback strategy

- Because every phase is scoped as "one commit per extraction," rollback at any point is `git revert` of the specific commit(s) for that extraction — the `<script type="module" src="...">` line and the extracted file are removed/reverted together.
- No phase in §1 (Phases 1–4) touches `index.html`'s sealed region or changes any IndexedDB schema, so no phase requires a data-migration rollback plan — reverting code is sufficient in every case.
- Phase R0 (seal re-baseline) is itself reversible: until the new marker-based `getSeal()` is verified to reproduce `36b45239`, the old line-number-based version stays the source of truth; the switch only happens after that verification passes, and can be reverted by reverting `phase8-engine.js` alone.
- Each phase can be individually halted or reverted without blocking or unwinding any other phase, since Phases 1–4 have no dependency on each other (only Phase 4 depends on Phase R0, and Phase 5 is out of scope entirely).

## 8. Incremental implementation plan (first slice, not yet started)

If and when implementation is separately approved, the recommended first concrete step is the single smallest, most self-contained extraction available: **script block #5 (the ~8-line debug-panel glue) or block #2 (`mfxBot`, ~490 lines)** — both sit well after line 33534, have a small enumerable DOM/`window.*` surface, and would let the very first commit prove out the whole toolchain (module file placement, `<script type="module">` substitution, compatibility shim, guardrail test, full-suite re-run, clean-room re-verification, seal re-check) at minimum risk before attempting anything larger. Each subsequent step in Phase 1, then Phase 2, then Phase 3, follows the same one-extraction-per-commit shape.

## Status

This document fulfills the FUTURE PROJECT's own DELIVERABLES requirement (roadmap, dependency graph, decomposition plan, migration strategy, risk analysis, validation checklist, rollback strategy, incremental implementation plan). **No implementation has started.** Per this project's established pattern (every prior phase — Phase 10's original integration, Revision 2's scheduler architecture, Phase 10B's two infrastructure components — began with a reviewed and approved plan before any code was written), this plan is presented for review before Phase R0 or Phase 1 begins.
