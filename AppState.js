/**
 * charts/mtfDashboard.js
 *
 * The 11-timeframe MTF Dashboard (1 Day down to 1 Min): one live,
 * independently-updating Panel per entry in MTF_DASHBOARD_TFS, laid out as
 * a stacked list of full-width rows — one row per timeframe, each with its
 * own wide candlestick mini-chart, styled to read as a clean candlestick
 * chart in its own right (matching Deriv's own chart style) rather than a
 * miniature technical dashboard. Each panel is a REAL Panel instance —
 * same class, same rendering path, same drawing-sync mechanism as the
 * original htf/ltf panels — so nothing about candles, drawings, or live
 * updates needed to be reimplemented for these eleven; they get it for
 * free from the existing architecture.
 *
 * The timeframe label renders as an overlay in the chart's own top-left
 * corner (drawn in HTML, absolutely positioned over the canvas), not a
 * separate side column — the chart itself spans the row's full width,
 * matching the reference layout rather than splitting width between a
 * label column and a narrower chart.
 *
 * DESIGN DECISION, STATED DIRECTLY: clicking a row's label calls
 * AppState.setActiveTimeframe(key), which sets which panel the ANALYSIS
 * DISPLAY layer (Smart Market Intelligence, Probability Engine's UI,
 * Continuous Learning) reads via AppState.getAnalysisPanels() — it does
 * NOT reassign AppState.panels.htf/.ltf. That distinction matters: several
 * modules (drawing/candleMarking.js's decomposition, charts/replayManager.js,
 * charts/zoomManager.js) read panels.htf/.ltf freshly on every call to
 * drive interaction with the two VISIBLE chart panels. An earlier version
 * of this reassigned panels.htf directly, which would have silently
 * redirected decomposition/replay/zoom onto an invisible dashboard panel
 * the instant a row was clicked, while the user kept interacting with the
 * visible panel — caught before shipping, not after. The practical result
 * of the corrected design: the row you click becomes what the analysis
 * text is ABOUT, visible in its own live mini-chart in the row; the
 * separate big 2-panel view and its own dropdowns are untouched. The
 * currently-active row gets a visible highlight so this is never
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

function buildRowMarkup() {
  return MTF_DASHBOARD_TFS.map(tf => `
    <div class="mtf-dash-tf-row" data-tf="${tf.key}" id="mtfDashCard_${tf.key}">
      <div class="mtf-dash-tf-chart">
        <canvas id="${canvasIdFor(tf.key)}Canvas"></canvas>
        <canvas id="${canvasIdFor(tf.key)}CanvasOv"></canvas>
        <div class="mtf-dash-tf-label-overlay" data-tf-click="${tf.key}">
          <span class="mtf-dash-tf-name">${tf.label}</span>
        </div>
      </div>
    </div>
  `).join('');
}

function updateActiveHighlight(activeKey) {
  MTF_DASHBOARD_TFS.forEach(tf => {
    const row = $('mtfDashCard_' + tf.key);
    if (row) row.classList.toggle('mtf-dash-tf-row-active', tf.key === activeKey);
  });
}

// Rows are compact relative to a full chart page, so the full CANDLE_COUNT
// (200) default view would compress each candle too thin to read clearly.
// This narrows the view to a small, fixed number of recent candles so each
// one gets meaningful width — matching what a clean candlestick chart is
// supposed to look like at a glance, the same density Deriv's own charts
// use rather than a data-dense technical view. Re-applied on every
// panel:dataUpdated (including live tick/candle updates, not just the
// initial history load), so the window keeps sliding forward with fresh
// data rather than freezing at whatever it was when the row first loaded.
const DASHBOARD_VISIBLE_CANDLES = 40;
function applyDashboardView(panel) {
  if (!panel.candles.length) return;
  const last = panel.candles[panel.candles.length - 1];
  const gran = panel.granSeconds();
  panel.viewT0 = last.epoch - gran * DASHBOARD_VISIBLE_CANDLES;
  panel.viewT1 = last.epoch + gran * 3;
  panel.priceLock = null;
}

export function initMtfDashboard() {
  const row = $('mtfDashboardRow');
  if (!row) return;
  row.innerHTML = buildRowMarkup();

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
    if (MTF_DASHBOARD_TFS.some(tf => tf.key === panel.side)) {
      applyDashboardView(panel);
    }
  });

  // Safe to set immediately at boot: these only affect what the analysis
  // display layer reads (via getAnalysisPanels()), never the interactive
  // htf/ltf panels — see the design note at the top of this file.
  AppState.setActiveTimeframe('h1');
  AppState.setCompareTimeframe('m1');
}
