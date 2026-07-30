# MSD Phase 10C — Governed Scheduler Engine: Implementation & Verification Report

Scope: the remaining Phase 10 work deferred behind Phase 10B (`schedulerState.js`, `healthMonitor.js`). This round delivers the scheduler engine itself — `scheduler.js` and `schedulerPolicies.js` — wires it into `bootstrap.js` in place of the ad-hoc restore logic, and extends the dashboard with a live Scheduler panel.

## 1. What was built

**`research/integration/schedulerPolicies.js`** (136 lines) — pure functions only, no I/O, no imports from `research/src/`. Implements the three trigger policies approved in Revision 2:

- `shouldTriggerEventDriven(state, config)` — fires once `tickSummary.eventsObservedThisSession` has advanced by at least `config.minBatchesSinceLastRun` since the anchor recorded at the last execution.
- `shouldTriggerBatchCount(state, config)` — fires once `tickSummary.totalWrittenThisSession` crosses the next multiple of `config.batchThreshold`.
- `shouldTriggerTimeBased(state, config, now)` — fires once `config.intervalMs` has elapsed since `lastExecutionTime` (or since `bootTime` if nothing has run yet).
- `computeNextScheduledExecution(state, config, now)` — returns a timestamp for time-based policies, `null` otherwise (nothing to display for event-driven/batch-count).
- `validatePolicy(policy)` — returns `{valid, errors}`, never throws; each policy type has its own required-field check (e.g. batch-count requires a positive `batchThreshold`).
- `shouldTrigger(state, policy, now)` — dispatcher; returns `false` (never throws) for any unrecognized policy shape.

**`research/integration/scheduler.js`** (350 lines) — the orchestration engine. Owns one module-scoped in-memory state object plus a handful of coalescing/bookkeeping fields (`_pendingRun`, `_lastExecutionBatchCount`/`_lastExecutionWrittenCount`, `_modeBeforePause`, `_tabHidden`). Exported surface:

- `initScheduler({target})` — restores persisted state via `schedulerState.restoreSchedulerState()`, wires the `mambafx:marketStatesWritten` tick listener and `document.visibilitychange` on `target`, starts a time-based interval if configured. Never throws — any failure degrades to a safe Paused default so it can never block the legacy app's boot.
- `setMode(mode)`, `pause(reason)`, `resume()` (returns to the mode active before pausing), `runOnce()` (works in any mode), `configurePolicy(policy)` (validates first, restarts the time-based interval if needed).
- `getStatus()` — read-only snapshot (`mode`, `schedulerStatus`, `queue`, `policy`, `currentlyRunningCampaign`, `campaignsExecutedThisSession`/`Lifetime`, `lastExecutionTime`, `nextScheduledExecution`, `lastFailure`, `tabHidden`, `initialized`).
- `shutdown()`, `_resetForTesting()` (test-only).

Core serialization logic lives in `attemptRun(reason)`: if a run is already `RUNNING`, it sets a coalesced-not-stacked pending flag and returns immediately rather than starting a second concurrent call. Otherwise it marks `RUNNING`, calls the single approved entry point into the research engine — `campaignRunner.runResearchCampaignStep()` — in a try/catch, always returns to `IDLE` (on success or on caught failure, recording `lastFailure` but never wedging the scheduler), persists the updated snapshot via `schedulerState.saveSchedulerState()`, appends an audit-log entry, and then — if a run was coalesced while it was busy — recurses exactly once for the pending run. `evaluateAndMaybeRun()` is a no-op unless `mode === 'automatic'` and the tab is visible; it defers all trigger logic to `schedulerPolicies.shouldTrigger()`.

**`research/integration/bootstrap.js`** — updated so `boot()` calls `await scheduler.initScheduler({target: window})` (replacing Phase 10B's direct `restoreSchedulerState`/`saveSchedulerState` calls, which now live inside `scheduler.js` itself) and exposes `window.mfxSchedulerPause/Resume/RunOnce/SetMode/ConfigurePolicy` as thin pass-throughs, each refreshing the dashboard panel afterward. All of this remains inside the existing `if (!isEnabled()) { renderDisabledNotice(); return; }` early-return gate — the scheduler is never initialized unless `MSD_RESEARCH_ENGINE_ENABLED === true`.

**`research/integration/dashboardUI.js`** — added a new "Scheduler" panel (built at runtime, per the established DOM-injection principle — see §3), between the existing "Manual Campaign Execution" section and "Health Monitor" section. Displays mode, status, queue length, policy, current campaign, last/next execution, session and lifetime execution counts, and last error; provides Pause/Resume/Run Once buttons and a mode selector, all wired to the `bootstrap.js` pass-throughs above. Exports `refreshSchedulerPanel()`, called after every control action.

The pre-existing standalone "Run Campaign Step" button (Phase 10 v1) was intentionally left in place rather than removed, now labeled "(direct, unserialized)" to make the distinction visible: it still calls `campaignRunner.runResearchCampaignStep()` directly and bypasses the scheduler's serialization/audit trail. This keeps the Phase 10B/10C rollout additive rather than a breaking change to an already-shipped control, at the cost of two possible entry points into the same read-only prioritization call — a UI nuisance, not a correctness risk, since `prioritizeNextRepresentationFamily()` is stateless and read-only regardless of which path invokes it.

## 2. Dependency graph (delta from Phase 10B)

```
index.html
  └─ <script type="module" src="research/integration/bootstrap.js">
        ├─ dashboardUI.js        (+ new refreshSchedulerPanel(), Scheduler panel markup)
        ├─ tickListener.js       (unchanged)
        ├─ campaignRunner.js     (unchanged — still the only entry point into research/src/)
        ├─ scheduler.js          (NEW)
        │     ├─ schedulerPolicies.js   (NEW, pure functions, zero imports)
        │     ├─ schedulerState.js      (Phase 10B, unchanged)
        │     └─ campaignRunner.js      (same shared import, not duplicated)
        └─ healthMonitor.js      (Phase 10B, unchanged)
```

`scheduler.js` and `schedulerPolicies.js` import nothing from `research/src/discovery/` or `research/src/governance/` directly — confirmed structurally by the guardrail tests in `scheduler.test.mjs` (import-statement-block check, plus a comment-stripped executable-statement check specifically for `onlineFdr`/`publicationStatus`). The scheduler's only path into the research engine is the same `campaignRunner.runResearchCampaignStep()` call already used by the Phase 10 v1 manual button.

## 3. Architectural principles preserved

- **No new statistical/governance logic.** `scheduler.js` and `schedulerPolicies.js` contain zero calls into `research/src/discovery/` or `research/src/governance/`'s decision surface; every "should I run now" decision is a pure function over counters and timestamps, not p-values or evidence tiers.
- **Runtime DOM injection only.** The Scheduler panel is built by `dashboardUI.js` at runtime, exactly like every other Phase 10 dashboard section — nothing was added to `index.html`'s static markup, which is why the Phase 8 seal is unaffected (§4).
- **Serialize, never stack.** `attemptRun()`'s `_pendingRun` flag guarantees at most one queued follow-up run, never a growing backlog.
- **Never replay missed work on recovery.** `schedulerState.restoreSchedulerState()` (Phase 10B, unchanged) still forces `schedulerStatus → idle`, `queue → 0`, `currentlyRunningCampaign → null` on every restore — `scheduler.initScheduler()` builds on top of that guarantee rather than re-deciding it.
- **Errors return to idle, never wedge.** A thrown error inside `attemptRun()` is caught, recorded as `lastFailure`, and the scheduler returns to `IDLE` — confirmed by a dedicated test that forces a genuine throw (deleting `globalThis.indexedDB` mid-run) and checks recovery.
- **No tab-hidden catch-up.** `evaluateAndMaybeRun()` is a no-op while `document.hidden`; no queued executions accumulate while the tab is backgrounded, matching the "never catch up" requirement.

## 4. Phase 8 seal verification

Executed (not assumed) in both the primary sandbox and the independent clean-room copy (§6):

```
node -e "const e=require('./phase8-engine.js'); console.log(e.getSeal().searchSpaceHash);"
→ 36b45239
```

This matches the frozen hash from every prior phase. No `index.html` edits were made in Phase 10C, so this result was expected, but it was verified by actually running `getSeal()`, not by inference from the (correct) assumption that no lines were touched.

## 5. Test results

New tests this round:

| File | Tests | Result |
|---|---|---|
| `tests/integration/schedulerPolicies.test.mjs` | 8 | 8/8 pass |
| `tests/integration/scheduler.test.mjs` | 16 | 16/16 pass |

`scheduler.test.mjs` covers every item from the original Revision 2 checklist: structural guardrails (import-block check + comment-stripped statement check against `onlineFdr`/`publicationStatus`), Manual mode, Automatic mode under all three trigger policies (event-driven, batch-count, time-based — three separate tests), Paused mode, Resume from both automatic-triggered and manual pause, hidden-tab pause/resume/no-catch-up, queue serialization (no concurrent campaigns), error recovery (forced genuine throw), the "empty result is not an error" distinction, the feature-flag structural gate check on `bootstrap.js`, and `getStatus()` default-safety before `initScheduler()` has run.

Full integration suite (`tests/integration/**/*.test.mjs`): **70/70 pass.**
Full repository suite (`tests/**/*.test.mjs`): **653/653 pass.**

## 6. Verification performed

- `node --check` on every new/modified file: `bootstrap.js`, `dashboardUI.js`, `scheduler.js`, `schedulerPolicies.js`, `scheduler.test.mjs`, `schedulerPolicies.test.mjs` — all pass.
- Full suite run in the primary sandbox: 653/653.
- **Independent clean-room pass**: a separate, freshly-copied directory (`/tmp/repo_cleanroom`, distinct from the working sandbox) with the same file set, `node --check` re-run there, full suite re-run there independently: 653/653, seal `36b45239`. This is a fresh-directory/fresh-process re-verification, not a re-clone from a remote origin (no network access to the project's actual git remote is available in this sandbox) — noted explicitly so this claim isn't overstated.
- **SHA-256 comparison**, delivered-file copies vs. sandbox source of truth, all six new/modified files: all match byte-for-byte (hashes recorded in the delivery message).
- **What was NOT verified**: real-browser rendering of the new Scheduler dashboard panel. No browser/GUI is available in this sandbox. This is a known, open verification gap carried forward honestly from Phase 10B (the Health Monitor panel had the same gap) — structural correctness (DOM node creation, event wiring, `refreshSchedulerPanel()` reading `scheduler.getStatus()` correctly) was reasoned about and unit-tested via jsdom-free direct module tests, but a human/browser check of the actual rendered page has not been performed by me.

## 7. Bug fixed during this round (test-only, not production)

`scheduler.test.mjs`'s feature-flag structural check originally located `initScheduler(` via a plain `indexOf` scan of the raw file, which matched a mention of `scheduler.initScheduler()` inside `bootstrap.js`'s own JSDoc header comment — a comment that appears earlier in the file than the real `if (!isEnabled())` guard, causing a false-positive test failure even though `bootstrap.js`'s actual code is correct. This is the same class of false-positive as an earlier `schedulerState.test.mjs` issue (Phase 10B) where a whole-file substring check tripped on an explanatory comment. Fixed by stripping block and line comments from the source before running the index comparison — the same "check executable code, not prose" pattern already established in this project. No production file was changed to fix this; only the test.

## 8. Rollback

Phase 10C is purely additive to the integration layer and fully gated behind `MSD_RESEARCH_ENGINE_ENABLED`. To roll back:

1. Set `window.MSD_RESEARCH_ENGINE_ENABLED = false` (or leave unset) — the entire scheduler/dashboard layer goes inert immediately, no code removal needed.
2. If a full revert is wanted: delete `research/integration/scheduler.js` and `schedulerPolicies.js`, and restore `bootstrap.js` to its Phase 10B form (direct `restoreSchedulerState`/`saveSchedulerState` calls, no `scheduler.js` import) and `dashboardUI.js` to its Phase 10B form (no Scheduler panel section, no `refreshSchedulerPanel` export). Remove the corresponding `mfxScheduler*` window functions.
3. `index.html` requires no changes in either direction — it was not touched this round.
4. The scheduler's persisted state lives in its own IndexedDB database (`mfx_research_scheduler_state`, Phase 10B) — deleting that database (browser devtools → Application → IndexedDB) resets scheduler state independent of any code rollback, and cannot affect `mfx_research_governance` or the legacy `mfx_msd_*` databases.

## 9. Status

Phase 10 (manual integration, Phase 10 v1) → Phase 10 Revision 2 (scheduler architecture, approved) → Phase 10B (dedicated persistence + read-only health monitor) → **Phase 10C (scheduler engine + dashboard panel) — complete, tested, seal-verified, clean-room-verified.** The "FUTURE PROJECT" (index.html ES-module refactor) remains explicitly untouched, per standing instruction not to start it until separately authorized.

## 10. Addendum — window.MSD_RESEARCH_SCHEDULER_CONFIG wiring

Reviewing my own Phase 10C delivery surfaced a gap: `bootstrap.js`'s docstring already claimed the layer "reads `window.MSD_RESEARCH_SCHEDULER_CONFIG` at load time" (per Revision 2 §6, "scheduler config beneath the feature flag"), but `scheduler.js` never actually read it — the initial mode/policy always came from `schedulerState.js`'s hardcoded default (Manual mode, event-driven policy). Not unsafe (Manual mode never auto-runs), but the doc overclaimed what the code did.

Fixed in `scheduler.js`: `initScheduler()` now reads `window.MSD_RESEARCH_SCHEDULER_CONFIG` (`{mode?, policy?}`) via a new `safeReadInitialConfig()`/`applyInitialConfig()` pair, and applies it **only on a genuine first-ever boot** — nothing ever persisted, and persistence itself healthy (no fallback-to-safe-default in play). On every later boot, the persisted state — the operator's own dashboard choices — always wins; the static config can never override a real prior decision on refresh. Each field (`mode`, `policy`) is validated and applied independently (an invalid mode doesn't block a valid policy or vice versa), and a malformed or missing config can never throw. `_modeBeforePause` is also now correctly seeded from the resulting boot-time mode, so calling `resume()` immediately after boot (before any explicit `setMode()`) returns to the config-seeded mode rather than incorrectly falling back to Manual.

Six new tests added to `scheduler.test.mjs` (fresh-boot config application, resume-seeding correctness, malformed-config rejection, partial-validity field independence, restored-boot config-is-ignored, missing/non-object config handling) — all pass. Full suite: **659/659** (up from 653, +6). Clean-room pass repeated independently in a second fresh directory: 659/659, seal `36b45239` confirmed again. SHA-256 of the two changed files (`scheduler.js`, `scheduler.test.mjs`) verified byte-for-byte against the sandbox.
