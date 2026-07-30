/**
 * research/integration/dashboardUI.js
 *
 * Purpose:
 *   Visualization ONLY. Builds and paints the Research Dashboard page.
 *   Every value it renders comes from dashboardReadModel.js's already
 *   governance-guarded snapshot; this file makes zero scientific
 *   decisions and computes zero statistics of its own — it is pure DOM
 *   assembly, exactly the boundary Part 15 / scientificDashboard.js
 *   requires ("the actual dashboard UI... requires a browser/UI context
 *   this sandbox has neither of — these two guard functions are meant to
 *   be called by whatever future UI layer assembles dashboard views, not
 *   a replacement for building that layer").
 *
 * Why the page/nav DOM nodes are built HERE, at runtime, instead of as
 *   static markup in index.html: see bootstrap.js's header for the full
 *   explanation (inserting new static HTML before index.html's line
 *   12460 shifts the Phase 8 seal extraction window and silently
 *   corrupts getSeal()'s frozen hash). Building the nodes here, after
 *   the document has already parsed, means index.html's own static
 *   markup is untouched by this feature at all.
 *
 * Responsibilities:
 *   - initDashboardUI(): builds the nav button + page DOM once, wires
 *     the existing global showPage() function (via a non-invasive wrap,
 *     the same pattern index.html's own Phase 8 Integrity Module already
 *     uses for `window.ph8Boot`) so navigating to it works exactly like
 *     every other page, then renders the first snapshot.
 *   - renderDisabledNotice(): builds the same page shell but shows only
 *     the "integration disabled" notice — used when
 *     window.MSD_RESEARCH_ENGINE_ENABLED is not true, so the nav entry
 *     is never a dead link.
 *
 * Inputs: none directly; reads from dashboardReadModel.js,
 *   tickListener.js, and (Phase 10B) healthMonitor.js on render.
 * Outputs: DOM mutations only.
 * Dependencies: ./dashboardReadModel.js, ./tickListener.js,
 *   ./healthMonitor.js (Phase 10B — read-only getHealthReport() only),
 *   ./campaignRunner.js (indirectly, via the button's onclick already
 *   wired by bootstrap.js to window.mfxRunResearchCampaignStep).
 *
 * Public API: initDashboardUI, renderDisabledNotice.
 * Internal API: buildDomIfMissing, wrapShowPage, render.
 *
 * Error handling: a render failure is caught and shown as an inline
 *   error message inside the dashboard page itself — it must never
 *   throw into the legacy app's own showPage() call chain.
 * Threading model: main thread.
 * Storage usage: none directly.
 * Complexity analysis: O(size of the snapshot) — a small, bounded DOM
 *   paint, not tick-scale.
 * Future extension notes: additional dashboard sections should be added
 *   as additional `<div>`s inside PAGE_HTML plus a matching render*()
 *   helper — keep one render helper per section, mirroring
 *   dashboardReadModel.js's one-metric-per-section shape.
 */

import { buildDashboardSnapshot } from './dashboardReadModel.js';
import { getLastTickSummary } from './tickListener.js';
import { getHealthReport } from './healthMonitor.js';

const PAGE_ID = 'page-researchdashboard';
const NAV_ID = 'navResearchDashboard';

const PAGE_HTML = `
  <div class="ph8-wrap" style="max-width:1100px;margin:0 auto;padding:18px">
    <div class="ph8-section-hdr"><span class="ph8-sn" style="background:#8b5cf6">R</span> Scientific Governance Status</div>
    <div class="ph8-card">
      <div id="rd-disabled-notice" style="display:none;color:#eab308;font-size:0.82rem;margin-bottom:10px"></div>
      <div id="rd-governance-status">—</div>
    </div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#6366f1">D</span> Discovery Campaigns &amp; Queue</div>
    <div class="ph8-card">
      <div style="margin-bottom:8px">Current Discovery Phase: <span id="rd-current-phase-value">—</span></div>
      <div style="margin-bottom:8px">Current Candidate Count: <span id="rd-candidate-count-value">—</span></div>
      <div id="rd-campaign-queue"></div>
    </div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#22c55e">F</span> Active Representation Families</div>
    <div class="ph8-card"><div id="rd-representation-families"></div></div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#0ea5e9">S</span> Current Search Strategy</div>
    <div class="ph8-card"><div id="rd-search-strategy">—</div></div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#f59e0b">V</span> Validation Funnel</div>
    <div class="ph8-card"><div id="rd-validation-funnel"></div></div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#ef4444">N</span> RNG Forensics Status</div>
    <div class="ph8-card"><div id="rd-rng-forensics">—</div></div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#a78bfa">R</span> Replication Queue</div>
    <div class="ph8-card"><div id="rd-replication-queue"></div></div>

    <div class="ph8-section-hdr" style="margin-top:24px"><span class="ph8-sn" style="background:#6b7280">M</span> Manual Campaign Execution</div>
    <div class="ph8-card">
      <div style="font-size:0.78rem;color:#6b7280;margin-bottom:10px">
        Per the Phase 10 rollout decision, campaign execution is manual-only for this first integration. Nothing runs automatically or on a timer.
      </div>
      <button class="ph8-launch-btn" id="rd-run-campaign-btn" onclick="if (typeof window.mfxRunResearchCampaignStep === 'function') window.mfxRunResearchCampaignStep();">Run Campaign Step (direct, unserialized)</button>
      <div id="rd-run-campaign-result" style="margin-top:10px;font-size:0.78rem"></div>
    </div>

    <div class="ph8-section-hdr" style="margin-top:24px">
      <span class="ph8-sn" style="background:#0ea5e9">G</span> Scheduler
    </div>
    <div class="ph8-card">
      <div style="font-size:0.78rem;color:#6b7280;margin-bottom:10px">
        The governed scheduler (recommended). Orchestration only -- every action below still routes through campaignRunner.js's read-only prioritization call, exactly like "Run Campaign Step" above, but serialized, audit-logged, and (in Automatic mode) governed by the configured trigger policy.
      </div>
      <div style="font-size:0.8rem;line-height:1.8">
        Mode: <b id="rd-sched-mode">—</b> &nbsp;·&nbsp;
        Status: <b id="rd-sched-status">—</b> &nbsp;·&nbsp;
        Queue: <span id="rd-sched-queue">—</span><br/>
        Policy: <span id="rd-sched-policy">—</span><br/>
        Current Campaign: <span id="rd-sched-current-campaign">—</span><br/>
        Last Execution: <span id="rd-sched-last-execution">—</span> &nbsp;·&nbsp;
        Next Scheduled Execution: <span id="rd-sched-next-execution">—</span><br/>
        Campaigns Executed This Session: <span id="rd-sched-executed-session">—</span> &nbsp;·&nbsp;
        Lifetime: <span id="rd-sched-executed-lifetime">—</span><br/>
        Last Error: <span id="rd-sched-last-error">—</span>
      </div>
      <div style="margin-top:12px">
        <button class="ph8-launch-btn" id="rd-sched-pause-btn" onclick="if (typeof window.mfxSchedulerPause === 'function') window.mfxSchedulerPause('Paused from dashboard');">Pause</button>
        <button class="ph8-launch-btn" id="rd-sched-resume-btn" onclick="if (typeof window.mfxSchedulerResume === 'function') window.mfxSchedulerResume();">Resume</button>
        <button class="ph8-launch-btn" id="rd-sched-runonce-btn" onclick="if (typeof window.mfxSchedulerRunOnce === 'function') window.mfxSchedulerRunOnce();">Run Once</button>
        <select id="rd-sched-mode-select" style="margin-left:10px" onchange="if (typeof window.mfxSchedulerSetMode === 'function') window.mfxSchedulerSetMode(this.value);">
          <option value="manual">Manual</option>
          <option value="automatic">Automatic</option>
          <option value="paused">Paused</option>
        </select>
      </div>
    </div>

    <div class="ph8-section-hdr" style="margin-top:24px">
      <span class="ph8-sn" style="background:#14b8a6">H</span> Health Monitor
      <span id="rd-health-indicator" style="margin-left:10px;font-size:0.9rem">—</span>
    </div>
    <div class="ph8-card">
      <div id="rd-health-explanation" style="font-size:0.78rem;color:#6b7280;margin-bottom:10px">—</div>

      <div style="font-weight:600;margin-bottom:4px">Scheduler</div>
      <div style="font-size:0.8rem;line-height:1.6">
        Mode: <span id="rd-health-mode">—</span> &nbsp;·&nbsp;
        Status: <span id="rd-health-status">—</span> &nbsp;·&nbsp;
        Queue Length: <span id="rd-health-queue">—</span><br/>
        Current Policy: <span id="rd-health-policy">—</span><br/>
        Current Campaign: <span id="rd-health-current-campaign">—</span><br/>
        Last Run: <span id="rd-health-last-run">—</span> &nbsp;·&nbsp;
        Next Run: <span id="rd-health-next-run">—</span>
      </div>

      <div style="font-weight:600;margin:12px 0 4px">Research</div>
      <div style="font-size:0.8rem;line-height:1.6">
        MarketState batches processed: <span id="rd-health-batches">—</span><br/>
        Campaigns completed: <span id="rd-health-campaigns-completed">—</span> &nbsp;·&nbsp;
        Campaigns pending: <span id="rd-health-campaigns-pending">—</span><br/>
        Active Representation Family count: <span id="rd-health-active-family">—</span>
      </div>

      <div style="font-weight:600;margin:12px 0 4px">Storage</div>
      <div style="font-size:0.8rem;line-height:1.6">
        Database healthy: <span id="rd-health-db-healthy">—</span> &nbsp;·&nbsp;
        Scheduler state restored: <span id="rd-health-state-restored">—</span> &nbsp;·&nbsp;
        IndexedDB available: <span id="rd-health-idb-available">—</span>
      </div>

      <div style="font-weight:600;margin:12px 0 4px">System</div>
      <div style="font-size:0.8rem;line-height:1.6">
        Browser: <span id="rd-health-visibility">—</span> &nbsp;·&nbsp;
        Network: <span id="rd-health-online">—</span><br/>
        Last error: <span id="rd-health-last-error">—</span><br/>
        Last recovery: <span id="rd-health-last-recovery">—</span>
      </div>
    </div>
  </div>
`;

function buildDomIfMissing() {
  if (document.getElementById(PAGE_ID)) return;

  const nav = document.querySelector('nav');
  if (nav) {
    const btn = document.createElement('button');
    btn.id = NAV_ID;
    btn.textContent = '🔭 Research Dashboard';
    btn.setAttribute('onclick', "window.mfxShowResearchDashboard && window.mfxShowResearchDashboard();");
    nav.appendChild(btn);
  }

  const page = document.createElement('div');
  page.id = PAGE_ID;
  page.className = 'page';
  page.innerHTML = PAGE_HTML;
  document.body.appendChild(page);
}

/**
 * Non-invasive extension of the existing global showPage(), mirroring
 * index.html's own established precedent for extending a global
 * function from a separate module (see the "BOOT EXTENSION" wrapping
 * window.ph8Boot near the end of index.html). Because 'researchdashboard'
 * is not a key in showPage()'s own pages{}/navs{} maps (deliberately, to
 * avoid the static-HTML/seal-range hazard — see bootstrap.js), this page
 * needs its own show/hide step layered on top of, not inside, the
 * existing function.
 */
function wrapShowPage() {
  if (typeof window.showPage !== 'function' || window.__mfxShowPageWrapped) return;
  const originalShowPage = window.showPage;
  window.showPage = function (which) {
    const dashboardPage = document.getElementById(PAGE_ID);
    const dashboardNav = document.getElementById(NAV_ID);
    if (which === 'researchdashboard') {
      document.querySelectorAll('.page.active').forEach((el) => {
        if (el.id !== PAGE_ID) el.classList.remove('active');
      });
      document.querySelectorAll('nav button.active').forEach((el) => el.classList.remove('active'));
      if (dashboardPage) dashboardPage.classList.add('active');
      if (dashboardNav) dashboardNav.classList.add('active');
      render();
      return;
    }
    if (dashboardPage) dashboardPage.classList.remove('active');
    if (dashboardNav) dashboardNav.classList.remove('active');
    return originalShowPage(which);
  };
  window.mfxShowResearchDashboard = function () { window.showPage('researchdashboard'); };
  window.__mfxShowPageWrapped = true;
}

function renderList(container, items, formatFn, emptyMessage) {
  if (!container) return;
  if (!items || items.length === 0) {
    container.innerHTML = `<div style="color:#6b7280;font-size:0.78rem">${emptyMessage}</div>`;
    return;
  }
  container.innerHTML = items.map(formatFn).join('');
}

async function render() {
  const page = document.getElementById(PAGE_ID);
  if (!page) return;
  try {
    const snapshot = await buildDashboardSnapshot();
    const tickSummary = getLastTickSummary();

    const $ = (id) => page.querySelector(`#${id}`);

    $('rd-governance-status').innerHTML =
      `Active Families: <b>${snapshot.activeFamilies.value}</b> &nbsp;·&nbsp; ` +
      `Failed Families: <b>${snapshot.failedFamilies.value}</b> &nbsp;·&nbsp; ` +
      `Unexplored Search Space Versions: <b>${snapshot.unexploredSearchSpaceVersions.value}</b> &nbsp;·&nbsp; ` +
      `MarketStates written this session: <b>${tickSummary.totalWrittenThisSession}</b> (${tickSummary.eventsObservedThisSession} batches)`;

    $('rd-current-phase-value').textContent = snapshot.currentPhase.value;
    $('rd-candidate-count-value').textContent = String(snapshot.candidateCount.value);
    $('rd-search-strategy').textContent = `Configured method: ${snapshot.searchStrategy} (Phase 9 campaignPrioritization; ranking/selection only, never a discovery decision)`;

    renderList(
      $('rd-representation-families'),
      snapshot.activeFamilies.families,
      (f) => `<div style="padding:4px 0;border-bottom:1px solid #222736">${f.label || f.familyId}</div>`,
      'No Active Representation Families registered yet.'
    );

    renderList(
      $('rd-campaign-queue'),
      snapshot.campaignQueue.value,
      (q) => `<div style="padding:4px 0;border-bottom:1px solid #222736">Family "${q.familyId}": ${q.campaigns.length} campaign(s)</div>`,
      'No campaigns queued for any Active Representation Family.'
    );

    const vf = snapshot.validationFunnel.value;
    $('rd-validation-funnel').innerHTML = vf && vf.evaluated
      ? `Evaluated: <b>${vf.evaluated}</b> &nbsp;·&nbsp; Promoted: <b>${vf.promoted}</b> across ${vf.perCampaign.length} campaign(s) with recorded rounds.`
      : `<div style="color:#6b7280;font-size:0.78rem">No funnel round metrics recorded yet.</div>`;

    renderList(
      $('rd-rng-forensics'),
      snapshot.rngForensics.value,
      (r) => `<div style="padding:4px 0;border-bottom:1px solid #222736">${r.hypothesisId}: ${r.classification || '(no classification recorded)'}</div>`,
      'No RNG Forensics results recorded yet for any active family hypothesis.'
    );

    renderList(
      $('rd-replication-queue'),
      snapshot.replicationQueue.value,
      (r) => `<div style="padding:4px 0;border-bottom:1px solid #222736">${r.hypothesisId}: ${r.history.length} replication record(s)</div>`,
      'No replication history recorded yet.'
    );
  } catch (err) {
    page.querySelector('#rd-governance-status').textContent = `Dashboard render error: ${err.message}`;
  }

  // Health Monitor is rendered in its own try/catch: a failure here must
  // never blank the scientific-metric sections above (and vice versa) --
  // the two data sources (dashboardReadModel.js vs healthMonitor.js) are
  // deliberately independent (see module header).
  try {
    await renderHealthSection(page);
  } catch (err) {
    const el = page.querySelector('#rd-health-explanation');
    if (el) el.textContent = `Health monitor render error: ${err.message}`;
  }
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

async function renderHealthSection(page) {
  const $ = (id) => page.querySelector(`#${id}`);
  const report = await getHealthReport();

  $('rd-health-indicator').textContent = report.indicator.level;
  $('rd-health-explanation').textContent = report.indicator.explanation;

  $('rd-health-mode').textContent = report.scheduler.mode;
  $('rd-health-status').textContent = report.scheduler.schedulerStatus;
  $('rd-health-queue').textContent = String(report.scheduler.queue);
  $('rd-health-policy').textContent = report.scheduler.policy ? JSON.stringify(report.scheduler.policy) : '—';
  $('rd-health-current-campaign').textContent = report.scheduler.currentlyRunningCampaign || '(none)';
  $('rd-health-last-run').textContent = fmtTime(report.scheduler.lastExecutionTime);
  $('rd-health-next-run').textContent = fmtTime(report.scheduler.nextScheduledExecution);

  $('rd-health-batches').textContent = String(report.research.marketStateBatchesObserved);
  $('rd-health-campaigns-completed').textContent = String(report.research.campaignsExecuted);
  $('rd-health-campaigns-pending').textContent = String(report.research.campaignsPending);
  $('rd-health-active-family').textContent = String(report.research.activeRepresentationFamilyCount);

  $('rd-health-db-healthy').textContent = report.storage.persistenceAvailable ? 'yes' : 'no';
  $('rd-health-state-restored').textContent = report.storage.persistenceAvailable ? 'yes' : 'no';
  $('rd-health-idb-available').textContent = report.storage.indexedDbAvailable ? 'yes' : 'no';

  $('rd-health-visibility').textContent = report.system.browserVisibilityState;
  $('rd-health-online').textContent = report.system.onlineState === null ? 'unknown' : (report.system.onlineState ? 'online' : 'offline');
  $('rd-health-last-error').textContent = report.system.lastException ? `${report.system.lastException.message} (${fmtTime(report.system.lastException.ts)})` : '(none)';
  $('rd-health-last-recovery').textContent = report.scheduler.pausedReason || '(none)';
}

/** Wires window.mfxRunResearchCampaignStep's result back into the dashboard's own result area (bootstrap.js calls the campaignRunner function; this just paints its outcome once done). */
export function reportCampaignStepResult(result) {
  const el = document.getElementById('rd-run-campaign-result');
  if (!el) return;
  el.style.color = result.ok ? '#22c55e' : '#eab308';
  el.textContent = result.message;
  render();
}

export function initDashboardUI() {
  buildDomIfMissing();
  wrapShowPage();
  render();
}

export function renderDisabledNotice() {
  buildDomIfMissing();
  const notice = document.getElementById('rd-disabled-notice');
  if (notice) {
    notice.style.display = 'block';
    notice.textContent = 'The research engine integration is currently disabled (window.MSD_RESEARCH_ENGINE_ENABLED = false). This dashboard shows no live data until it is enabled. See MSD_PHASE10_INTEGRATION_ARCHITECTURE_REVIEW.md.';
  }
  wrapShowPage();
  const btn = document.getElementById('rd-run-campaign-btn');
  if (btn) btn.disabled = true;
}

// Test-only export so integration tests can render without a full boot.
export { render as _renderForTesting };

// Re-renders the full dashboard (including the Scheduler panel) after any
// scheduler control action. Called by bootstrap.js's window.mfxScheduler*
// wrappers via .then(() => refreshSchedulerPanel()).
export { render as refreshSchedulerPanel };
