/**
 * charts/mtfDashboard.js
 *
 * The 10-timeframe MTF Dashboard: one live, independently-updating Panel
 * per entry in MTF_DASHBOARD_TFS (m1 through d1), laid out in a single
 * responsive horizontal row. Each panel is a REAL Panel instance — same
 * class, same rendering path, same drawing-sync mechanism as the original
 * htf/ltf panels — so nothing about candles, drawings, or live updates
 * needed to be reimplemented for these ten; they get it for free from the
 * existing architecture.
 *
 * DESIGN DECISION, STATED DIRECTLY: clicking a card's header calls
 * AppState.setActiveTimeframe(key), which sets which panel the ANALYSIS
 * DISPLAY layer (Smart Market Intelligence, Probability Engine's UI,
 * Continuous Learning) reads via AppState.getAnalysisPanels() — it does
 * NOT reassign AppState.panels.htf/.ltf. That distinction matters: several
 * modules (drawing/candleMarking.js's decomposition, charts/replayManager.js,
 * charts/zoomManager.js) read panels.htf/.ltf freshly on every call to
 * drive interaction with the two VISIBLE chart panels. An earlier version
 * of this reassigned panels.htf directly, which would have silently
 * redirected decomposition/replay/zoom onto an invisible dashboard panel
 * the instant a card was clicked, while the user kept interacting with the
 * visible panel — caught before shipping, not after. The practical result
 * of the corrected design: the dashboard card you click becomes what the
 * analysis text is ABOUT, visible in its own live mini-chart in the row;
 * the separate big 2-panel view and its own dropdowns are untouched. The
 * currently-active card gets a visible highlight so this is never
 * ambiguous, and Smart Market Intelligence states which timeframe it's
 * analyzing at the top of its report.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { Panel } from './Panel.js';
import { requestPanelData } from './socket.js';
import { MTF_DASHBOARD_TFS } from '../core/constants.js';
import { $ } from '../utils/dom.js';

function canvasIdFor(key) {
  return 'mtfDash' + key.charAt(0).toUpperCase() + key.slice(1);
}

function buildCardMarkup() {
  return MTF_DASHBOARD_TFS.map(tf => `
    <div class="mtf-dash-card" data-tf="${tf.key}" id="mtfDashCard_${tf.key}">
      <div class="mtf-dash-card-head" data-tf-click="${tf.key}">
        <span class="mtf-dash-card-label">${tf.label}</span>
        <span class="mtf-dash-card-meta" id="mtfDashMeta_${tf.key}">—</span>
      </div>
      <div class="mtf-dash-card-chart">
        <canvas id="${canvasIdFor(tf.key)}Canvas"></canvas>
        <canvas id="${canvasIdFor(tf.key)}CanvasOv"></canvas>
      </div>
    </div>
  `).join('');
}

function updateActiveHighlight(activeKey) {
  MTF_DASHBOARD_TFS.forEach(tf => {
    const card = $('mtfDashCard_' + tf.key);
    if (card) card.classList.toggle('mtf-dash-card-active', tf.key === activeKey);
  });
}

function updateCardMeta(panel) {
  const meta = $('mtfDashMeta_' + panel.side);
  if (!meta) return;
  const last = panel.candles[panel.candles.length - 1];
  meta.textContent = last ? last.close.toFixed(2) : '—';
}

export function initMtfDashboard() {
  const row = $('mtfDashboardRow');
  if (!row) return;
  row.innerHTML = buildCardMarkup();

  MTF_DASHBOARD_TFS.forEach(tf => {
    const panel = new Panel(canvasIdFor(tf.key), tf.key, [tf]);
    AppState.registerTimeframePanel(tf.key, panel);
    requestPanelData(panel);
  });

  row.addEventListener('click', e => {
    const head = e.target.closest('[data-tf-click]');
    if (!head) return;
    const key = head.getAttribute('data-tf-click');
    AppState.setActiveTimeframe(key);
  });

  eventBus.on('activeTimeframe:changed', updateActiveHighlight);
  eventBus.on('panel:dataUpdated', ({ panel }) => {
    if (MTF_DASHBOARD_TFS.some(tf => tf.key === panel.side)) updateCardMeta(panel);
  });

  // Safe to set immediately at boot: these only affect what the analysis
  // display layer reads (via getAnalysisPanels()), never the interactive
  // htf/ltf panels — see the design note at the top of this file.
  AppState.setActiveTimeframe('h1');
  AppState.setCompareTimeframe('m1');
}
