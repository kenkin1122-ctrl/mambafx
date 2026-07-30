/**
 * research/integration/bootstrap.js
 *
 * Purpose:
 *   The single entry point for the Phase 10 research-engine integration
 *   layer. Loaded from index.html as a second `<script type="module">`
 *   tag (the exact same pattern already used for mtf/src/index.js — see
 *   MSD_PHASE10_INTEGRATION_ARCHITECTURE_REVIEW.md §1.3/§3), so it needs
 *   zero build step and is GitHub-Pages-compatible by construction.
 *
 * What this file deliberately does NOT do:
 *   - It does not implement any statistical or governance logic. Every
 *     import below is an unmodified export from research/src/, already
 *     shipped and tested (583/583) in the Phase 9 delivery.
 *   - It does not touch index.html's existing showPage() dispatch table.
 *     Wrapping showPage() from here (see §"non-invasive page wiring"
 *     below) was chosen specifically because inserting a new page's ID
 *     into index.html's own pages{}/navs{} maps requires the page's DOM
 *     node to exist as static HTML *before* line 12460 (the end of the
 *     Phase 8 seal extraction range) — and any new static HTML inserted
 *     before that boundary silently shifts every absolute line number
 *     phase8-engine.js's getSeal() extracts by, corrupting the frozen
 *     search-space hash. Building the page's DOM node here at runtime,
 *     after the document has already parsed, avoids that hazard
 *     entirely and keeps 100% of the new UI out of index.html's static
 *     markup.
 *   - It does not run anything automatically. Per the approved rollout
 *     decision, campaign execution in this first integration is
 *     strictly manual (a dashboard button click), and the whole layer
 *     is inert unless `window.MSD_RESEARCH_ENGINE_ENABLED === true`.
 *
 * Responsibilities:
 *   - Check the feature flag; if not explicitly `true`, do nothing
 *     beyond injecting a disabled dashboard page (so navigating to it
 *     shows an honest "disabled" notice instead of a missing page).
 *   - Build the dashboard's DOM (nav button + page) via dashboardUI.js.
 *   - Attach the tick-visibility listener (tickListener.js) so the
 *     dashboard's cached view of "how many new MarketStates have
 *     arrived" stays current — this never triggers discovery execution.
 *   - Expose `window.mfxRunResearchCampaignStep` (defined in
 *     campaignRunner.js) as the one manual trigger the dashboard's
 *     button calls.
 *   - Phase 10C: start the governed scheduler (scheduler.js), which owns
 *     its own full boot sequence internally (restore SchedulerState ->
 *     validate integrity -> resume if appropriate -> otherwise enter
 *     Paused mode with explanation — all inside
 *     scheduler.initScheduler(), which itself delegates the
 *     restore/validate/persist steps to schedulerState.js exactly as
 *     Phase 10B established). Exposes window.mfxSchedulerPause /
 *     mfxSchedulerResume / mfxSchedulerRunOnce / mfxSchedulerSetMode /
 *     mfxSchedulerConfigurePolicy as the dashboard Scheduler panel's
 *     control surface — every one of these is a thin pass-through to
 *     scheduler.js's own exported function, nothing new is decided here.
 *   - Phase 10B: start healthMonitor.js's listeners + diagnostic loop.
 *
 * Inputs: none (reads window.MSD_RESEARCH_ENGINE_ENABLED and
 *   window.MSD_RESEARCH_SCHEDULER_CONFIG at load time).
 * Outputs: none (side-effecting DOM/window wiring only).
 * Dependencies: ./dashboardUI.js, ./tickListener.js, ./campaignRunner.js,
 *   ./scheduler.js, ./healthMonitor.js.
 *
 * Public API: none (module-side-effect only, like mtf/src/index.js).
 * Internal API: none.
 *
 * Error handling: every step is wrapped so a failure in the (optional,
 *   dormant-by-default) research layer can never throw into or block
 *   the legacy application's own boot sequence.
 * Threading model: main thread, deferred module execution (native
 *   `<script type="module">` semantics — runs after the document has
 *   been parsed, same timing guarantee mtf/src/index.js already relies
 *   on).
 * Storage usage: none directly — see the individual imported modules.
 * Complexity analysis: O(1) at load time; see individual modules for
 *   their own per-call costs.
 * Future extension notes: if a second dashboard-adjacent module is
 *   needed, import and wire it here — bootstrap.js is meant to remain
 *   the only file index.html's markup needs to reference.
 */

import { initDashboardUI, renderDisabledNotice, reportCampaignStepResult, refreshSchedulerPanel } from './dashboardUI.js';
import { attachTickListener } from './tickListener.js';
import { runResearchCampaignStep } from './campaignRunner.js';
import * as scheduler from './scheduler.js';
import { startHealthMonitor } from './healthMonitor.js';

function isEnabled() {
  return typeof window !== 'undefined' && window.MSD_RESEARCH_ENGINE_ENABLED === true;
}

async function boot() {
  try {
    if (!isEnabled()) {
      // Still build the page shell so navigating to it is not a dead
      // link — but it shows the disabled notice and nothing live.
      renderDisabledNotice();
      return;
    }
    initDashboardUI();
    attachTickListener();
    window.mfxRunResearchCampaignStep = function () {
      runResearchCampaignStep()
        .then((result) => reportCampaignStepResult(result))
        .catch((err) => {
          console.error('[Phase10 research integration] campaign step failed:', err);
        });
    };

    // Phase 10C: scheduler.js owns its own full restore/validate/resume
    // sequence internally (see scheduler.initScheduler()'s own header).
    await scheduler.initScheduler({ target: window });
    startHealthMonitor();

    // Thin pass-throughs only -- the dashboard's Scheduler panel buttons
    // call these; every one of them is a direct call to scheduler.js's
    // own exported control function, with no new decision made here.
    window.mfxSchedulerPause = function (reason) {
      scheduler.pause(reason).then(() => refreshSchedulerPanel()).catch((err) => console.error('[Phase10 scheduler] pause failed:', err));
    };
    window.mfxSchedulerResume = function () {
      scheduler.resume().then(() => refreshSchedulerPanel()).catch((err) => console.error('[Phase10 scheduler] resume failed:', err));
    };
    window.mfxSchedulerRunOnce = function () {
      scheduler.runOnce().then(() => refreshSchedulerPanel()).catch((err) => console.error('[Phase10 scheduler] runOnce failed:', err));
    };
    window.mfxSchedulerSetMode = function (mode) {
      scheduler.setMode(mode).then(() => refreshSchedulerPanel()).catch((err) => console.error('[Phase10 scheduler] setMode failed:', err));
    };
    window.mfxSchedulerConfigurePolicy = function (policy) {
      scheduler.configurePolicy(policy).then(() => refreshSchedulerPanel()).catch((err) => console.error('[Phase10 scheduler] configurePolicy failed:', err));
    };
  } catch (err) {
    // The research integration layer must never be able to break the
    // legacy application it is attached to.
    console.error('[Phase10 research integration] bootstrap failed (legacy app unaffected):', err);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

// Exposed only for the integration test suite (jsdom-free unit tests
// import this module directly and call boot() themselves); not part of
// the module's real public API in the browser.
export { boot as _bootForTesting };
