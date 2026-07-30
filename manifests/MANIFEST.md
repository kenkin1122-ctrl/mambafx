# MANIFEST — MSD / Mamba FX ES-Module Refactor, Consolidated Deliverable

This package consolidates every artifact produced by the "FUTURE PROJECT" — the incremental ES-module refactor of `index.html` — from **Phase R0** (marker-based Phase 8 seal re-baseline) through **Phase 1j** (Deriv session/account-management extraction), the most recent completed slice at time of packaging.

**Scope note**: this bundle covers the refactor itself, plus the pre-existing `research/integration/` scheduler/integration layer (Phase 10) that the refactor explicitly builds on and references throughout its reports as architectural precedent. It does **not** include the much larger, separately-delivered scientific-governance research engine (`research/src/governance|discovery|statistics|storage`, Phases 1–9 of the original MSD build) or the unrelated `mtf/` multi-timeframe charting subsystem — those are complete, independent bodies of work outside "this refactoring project," already delivered in their own packages earlier in the engagement.

## 1. Root application files

| File | Purpose | Phase | Status |
|---|---|---|---|
| `index.html` | The main application. Current state after all 11 refactor phases (R0–1j): 33,867 lines (down from an original 36,171 before any refactor work began). Contains the classic main script, the live `window.*` accessor bridge, and `<script type="module">` references to all 10 extracted modules below. | R0–1j (cumulative) | Modified |
| `phase8-engine.js` | Executes the Phase 8 sealed search-space-definition code in a Node `vm` context and computes `getSeal()`. Modified in Phase R0 to extract the sealed region by literal marker comments instead of hardcoded line numbers, removing a fragility where any edit before the seal's old absolute position could silently corrupt the hash. | R0 | Modified |

## 2. Extracted ES modules (`src/`)

Each of these was a verbatim, byte-identical extraction of a previously-inline `<script>` block in `index.html`, verified via `diff` against the original, with a Phase 8 seal check and full regression suite run after every change.

| File | Extracted from | Lines | Phase | Bridge/export summary |
|---|---|---|---|---|
| `src/dashboard/debugPanel.js` | The `Ctrl+Shift+D` developer debug panel | 128 | 1 (Slice 1) | Fully self-contained; no bridge dependency. |
| `src/ui/widgets/mfxBot.js` | The `mfxBot` floating trading widget | 533 | 1b | First slice needing the live accessor bridge (19 identifiers, read-only + read-write). Introduced the bridge pattern used by every subsequent slice. |
| `src/ui/widgets/dabBot.js` | The `dabBot` ("Deriv Auto Bot") auto-fire widget | 414 | 1c | 14 bridged identifiers (13 shared with mfxBot, 1 new: `gridOpenContracts`). |
| `src/trading/fiveTickSignalEngine.js` | The 5-tick signal engine (`ENG` config, `engineOnTick`/`engineMetrics`/`renderEngine`) | 477 | 1d | First **producer**-side slice: exports `window.ENG` (getter), `window.engPageReady` (read-write), plus 3 function exports. |
| `src/features/featureEngineering.js` | The ML feature-engineering block (`_FEAT_DEFS`, 7 ranking/computation functions) | 754 | 1e | Producer-side; exports `_FEAT_DEFS` (getter) + 7 functions. Added `$` and `signalRecords` to the shared bridge (read-only). |
| `src/trading/aggressionBot.js` | The Aggression Bot (buy/sell aggression scoring on the live 1-min candle) | 175 | 1f | First slice needing **zero** new bridge entries. Discovered during sub-decomposition of the (deferred) Deriv trade-execution block. |
| `src/trading/multiplierHelpers.js` | Per-bot stake-multiplier helpers (`gridMult`/`digMult`/`engMult`/`*Strat`) | 43 | 1g | First micro-slice carved out of the deferred Deriv block. Zero new bridge entries. |
| `src/trading/gridStatusUi.js` | `gridConnState`/`gridDiag` connection-status UI helpers | 39 | 1h | First slice needing a genuinely new bridge dependency (`gridLoggedIn`, read-only at the time). |
| `src/trading/gridSetHelper.js` | `gridSet`, a 1-line generic DOM-text-setter used 59 times across the file | 26 | 1i | Kept as its own module (not merged into `gridStatusUi.js`) to preserve independent reversibility. |
| `src/trading/gridSessionAuth.js` | Deriv session/account-management (`gridPageInit`, `gridCheckSession`, `gridLoadAccounts`, account picker, etc. — 9 functions) | 206 | 1j | Split extraction around the already-shipped `aggressionBot.js` module tag. First slice to **upgrade** an existing bridge entry (`gridLoggedIn`: read-only → read-write) and add 5 further new entries. |

## 3. Scheduler / integration modules (`research/integration/`)

Pre-existing Phase 10 infrastructure, included here as reference/context because the refactor's own reports repeatedly cite it as the established precedent for the `<script type="module">` pattern used throughout this project. Not modified by the refactor itself (with the exception of a docstring/config-wiring fix to `scheduler.js`, documented in the Phase 10C report).

| File | Purpose |
|---|---|
| `bootstrap.js` | Phase 10 integration entry point; wires the research pipeline into the live page. |
| `scheduler.js` | Governed research scheduler; mode/policy state machine. Includes the `window.MSD_RESEARCH_SCHEDULER_CONFIG` first-boot wiring fix. |
| `schedulerPolicies.js` | Policy validation logic for the scheduler. |
| `schedulerState.js` | Persisted scheduler state (mode, pause/resume history). |
| `healthMonitor.js` | Runtime health monitoring for the research pipeline. |
| `campaignRunner.js` | Drives discovery campaigns on a schedule. |
| `dashboardReadModel.js` | Read-only projection of research state for dashboard display. |
| `dashboardUI.js` | Dashboard rendering glue. |
| `tickListener.js` | Live tick ingestion adapter feeding the research pipeline. |

## 4. Tests (`tests/`)

| Directory | Contents | Count |
|---|---|---|
| `tests/refactor/` | Guardrail tests for every extraction (module reference exists, old inline code is gone, bridge entries correct, exports correct, seal markers unaffected). One file per extracted module. | 10 files |
| `tests/phase8/` | `sealExtraction.test.mjs` — regression-pins the Phase 8 seal hash (`36b45239`) and validates the marker-based extraction mechanism introduced in Phase R0. | 1 file |
| `tests/integration/` | Tests for the `research/integration/` scheduler/integration modules bundled above. | 8 files |

## 5. Patches (`patches/`)

One `git diff`-format patch per phase, each independently reversible (`git apply -R` or manual revert per that phase's own report). Organized into one subfolder per phase, in chronological order:

1. `phase_r0_seal_rebaseline/` — the 2-line marker insertion.
2. `phase1_slice1_debugpanel/`
3. `phase1b_mfxbot/`
4. `phase1c_dabbot/`
5. `phase1d_fivetick_engine/`
6. `phase1e_feature_engineering/`
7. `phase1f_aggression_bot/`
8. `phase1g_multiplier_helpers/`
9. `phase1h_grid_status_ui/`
10. `phase1i_grid_set_helper/`
11. `phase1j_grid_session_auth/`

Applying all 11 patches in order to the pre-refactor `index.html` (36,171 lines, commit `2608cf8`) reproduces the current 33,867-line file exactly.

## 6. Documentation (`docs/`)

| File | Purpose |
|---|---|
| `MSD_FUTURE_PROJECT_ESMODULE_REFACTOR_PLAN.md` | The original planning document: roadmap, dependency graph, module decomposition plan, migration strategy, risk analysis, validation checklist, rollback strategy. |
| `MSD_FUTURE_PROJECT_PHASE2_SUBDECOMPOSITION.md` | Structural analysis of the ~21,000-line "safe zone" (everything after the Phase 8 seal), with a risk-ordered extraction sequence, produced using a real JS tokenizer (`acorn`) rather than regex. |

## 7. Reports (`reports/`)

One implementation/verification report per phase, numbered in chronological order (`01`–`11`), each containing: what changed, dependency analysis, bridge changes, risks discovered, verification performed, what did NOT change, and rollback instructions. `reports/reference_phase10_scheduler_integration/` holds the two Phase 10B/10C reports for the scheduler layer referenced in section 3, included for context.

## 8. Manifests and verification

- `manifests/MANIFEST.md` — this file.
- `verification/VERIFICATION_SUMMARY.md` — latest test counts, Phase 8 seal hash, clean-room verification results, SHA-256 manifest of every file in this package.
- `RELEASE_NOTES.md` (package root) — high-level summary of what's complete, what's remaining, and current project status.
