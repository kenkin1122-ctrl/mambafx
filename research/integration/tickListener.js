/**
 * research/integration/tickListener.js
 *
 * Purpose:
 *   Requirement 4's actual, correctly-scoped implementation ("ensure
 *   every completed tick reaches the discovery engine" — translated, per
 *   MSD_PHASE10_INTEGRATION_ARCHITECTURE_REVIEW.md §1.1 Correction C,
 *   into "every completed MarketState becomes visible to the research
 *   data layer," since raw per-tick execution would spend Online FDR's
 *   statistical wealth uncontrollably and is explicitly out of scope).
 *
 * What this module does NOT do:
 *   - It does not run any discovery, campaign, funnel, or RNG-forensics
 *     step. Execution is manual-only (campaignRunner.js, dashboard
 *     button), per the approved rollout decision.
 *   - It does not read or duplicate legacy's QA/version-validation
 *     logic. It reacts to the *result* of
 *     `mambafx:marketStatesWritten` (index.html's one new, purely
 *     additive CustomEvent — see the module header of
 *     `msdDispatchMarketStatesWritten` in index.html) and then re-reads
 *     fresh data through the existing, unmodified
 *     bridgeToLegacyMsd.getAllMarketStates() — never trusting the
 *     event's own payload as authoritative, since IndexedDB is the one
 *     source of truth.
 *
 * Responsibilities:
 *   - attachTickListener(): subscribes to window's
 *     'mambafx:marketStatesWritten' event (dispatched by index.html
 *     after every msdProcessLabeledSnapshots() batch — both the
 *     positive/qualified-run path and the negative-sampling path).
 *   - getLastTickSummary(): read-only accessor for the dashboard,
 *     returning the most recent event's counts plus a running session
 *     total — used only for display (Current Candidate Count context),
 *     never as an input to any statistical decision.
 *
 * Inputs: none directly (subscribes to a DOM CustomEvent).
 * Outputs: none (updates an internal, module-scoped cache read by
 *   getLastTickSummary()).
 * Dependencies: none — deliberately does not import
 *   bridgeToLegacyMsd/campaignPrioritization/etc. itself; forwarding a
 *   "new data may be available" signal is this module's only job.
 *   dashboardReadModel.js is what actually re-queries the data layer,
 *   on its own explicit refresh, not automatically from here.
 *
 * Public API: attachTickListener, detachTickListener (test-only
 *   teardown), getLastTickSummary.
 * Internal API: none.
 *
 * Error handling: a malformed/missing event detail is treated as
 *   "0 written," never thrown — a listener must never be able to break
 *   the tick pipeline it is observing.
 * Threading model: main thread, event-driven.
 * Storage usage: none — in-memory session cache only, exactly mirroring
 *   the precedent already set by index.html's own
 *   msdQaRejectionTally/msdVersionRejectionTally (session-scoped,
 *   resets on reload, not one of the four permanent stores).
 * Complexity analysis: O(1) per event.
 * Future extension notes: if a future phase wants tick-level detail
 *   (not just counts), extend the event detail in index.html's
 *   msdDispatchMarketStatesWritten and this module's cache together —
 *   do not have this module reach back into legacy internals directly.
 */

const EVENT_NAME = 'mambafx:marketStatesWritten';

let _cache = {
  lastEvent: null, // { written, qaRejected, versionRejected, dbRejected, ts }
  totalWrittenThisSession: 0,
  eventsObservedThisSession: 0,
};

let _handler = null;

function handleEvent(evt) {
  const detail = (evt && evt.detail) || {};
  const written = Number.isFinite(detail.written) ? detail.written : 0;
  const qaRejected = Number.isFinite(detail.qaRejected) ? detail.qaRejected : 0;
  const versionRejected = Number.isFinite(detail.versionRejected) ? detail.versionRejected : 0;
  const dbRejected = Number.isFinite(detail.dbRejected) ? detail.dbRejected : 0;
  const ts = Number.isFinite(detail.ts) ? detail.ts : Date.now();

  _cache.lastEvent = { written, qaRejected, versionRejected, dbRejected, ts };
  _cache.totalWrittenThisSession += written;
  _cache.eventsObservedThisSession += 1;
}

/** Subscribes to the legacy tick pipeline's completion signal. Safe to call once at boot; idempotent (re-attaching first detaches). */
export function attachTickListener(target = (typeof window !== 'undefined' ? window : undefined)) {
  if (!target || typeof target.addEventListener !== 'function') return;
  detachTickListener(target);
  _handler = handleEvent;
  target.addEventListener(EVENT_NAME, _handler);
}

/** Test/teardown-only: removes the listener. */
export function detachTickListener(target = (typeof window !== 'undefined' ? window : undefined)) {
  if (!target || typeof target.removeEventListener !== 'function') return;
  if (_handler) {
    target.removeEventListener(EVENT_NAME, _handler);
    _handler = null;
  }
}

/** Read-only snapshot for the dashboard. Never used as a statistical input. */
export function getLastTickSummary() {
  return {
    lastEvent: _cache.lastEvent ? { ..._cache.lastEvent } : null,
    totalWrittenThisSession: _cache.totalWrittenThisSession,
    eventsObservedThisSession: _cache.eventsObservedThisSession,
  };
}

/** Test-only: resets the module-scoped cache between test cases. */
export function _resetForTesting() {
  _cache = { lastEvent: null, totalWrittenThisSession: 0, eventsObservedThisSession: 0 };
}
