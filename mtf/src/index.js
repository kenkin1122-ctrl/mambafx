/**
 * index.js — MTF Structure module entry point.
 *
 * Boot order matters here:
 *   1. Construct the two Panel instances and register them in AppState
 *      (charts/render.js, charts/socket.js, and drawing/interaction.js all
 *      read AppState.panels, so they must exist before those modules' init
 *      functions run).
 *   2. Wire every module's init*() — each one subscribes to the events it
 *      cares about; order between these doesn't matter, they're independent.
 *   3. Expose the handful of window.mtfX functions that inline onclick=""
 *      attributes in generated HTML need (candle-menu buttons, drawing
 *      manager rows). Everything else stays module-private.
 *
 * mtfPageInit() preserves the lazy-boot pattern used when this module is
 * embedded as a dashboard tab (see the pattern used by the Candle Charts
 * page's candlesPageReady flag): the WebSocket connection and initial data
 * fetch don't happen until the tab is actually opened, not at page load.
 */

import { AppState } from './core/AppState.js';
import { eventBus } from './core/EventBus.js';
import { historyManager } from './core/HistoryManager.js';
import { HTF_TFS, LTF_TFS } from './core/constants.js';
import { Panel } from './charts/Panel.js';
import { connect } from './charts/socket.js';
import { initRenderLoop, drawAll } from './charts/render.js';
import { initInteraction } from './drawing/interaction.js';
import { markCandlePart, decomposeCandleFromMenu, exitDecomposition } from './drawing/candleMarking.js';
import { initToolbar } from './ui/toolbar.js';
import { initZonePresets } from './ui/zonePresets.js';
import { initReplayControls } from './ui/replayControls.js';
import { initWorkspacePanel } from './ui/workspacePanel.js';
import { initDrawingManager, renderManager, toggleVisible, toggleLock } from './ui/drawingManager.js';
import { initPropertiesPanel, renderProps } from './ui/propertiesPanel.js';
import { initAnalysisPanel } from './ui/analysisPanel.js';
import { initSmartIntelligencePanel } from './ui/smartIntelligencePanel.js';
import { initHeader, populateSelects } from './ui/header.js';
import { initAutosave, loadDrawings } from './workspace/storage.js';
import { $ } from './utils/dom.js';

let booted = false;

function boot() {
  // 1. Panels
  AppState.registerPanel('htf', new Panel('mtfHtf', 'htf', HTF_TFS));
  AppState.registerPanel('ltf', new Panel('mtfLtf', 'ltf', LTF_TFS));
  AppState.panels.htf.setDefaultView();
  AppState.panels.ltf.setDefaultView();

  // 2. Module wiring
  initRenderLoop();
  initInteraction();
  initToolbar();
  initZonePresets();
  initReplayControls();
  initWorkspacePanel();
  initDrawingManager();
  initPropertiesPanel();
  initAnalysisPanel();
  initSmartIntelligencePanel();
  initHeader();
  initAutosave();

  // Undo/redo history is scoped to the current symbol's drawing set — an
  // undo entry referencing a drawing that no longer exists (because the
  // symbol changed) would be meaningless, so clear it on every switch.
  eventBus.on('symbol:changed', () => historyManager.clear());

  // 3. Global exposures for inline onclick="" handlers
  window.mtfMarkCandlePart = markCandlePart;
  window.mtfDecomposeCandleFromMenu = decomposeCandleFromMenu;
  window.mtfExitDecomposition = exitDecomposition;
  window.mtfToggleVisible = toggleVisible;
  window.mtfToggleLock = toggleLock;
  // mtfSelectAndZoom / mtfDuplicateSelected / mtfDeleteSelected are exposed
  // by ui/propertiesPanel.js's initPropertiesPanel(), since it already needs
  // the same import.

  try {
    populateSelects();
    AppState.setDrawings(loadDrawings(AppState.symbol));
    renderManager();
    renderProps();
    connect();
    setInterval(() => {
      const c = AppState.crosshair;
      if (c) $("mtfSyncTime").textContent = new Date(c.t * 1000).toLocaleString([], { hour12: false });
    }, 1000);
  } catch (err) {
    console.error('[MTF module] boot failed:', err);
    const txt = $("mtfConnText");
    if (txt) txt.textContent = "Boot failed — see console";
  }
}

/** Called from the dashboard's showPage() hook when the MTF tab is opened. Safe to call repeatedly. */
function mtfPageInit() {
  if (booted) {
    // Re-entering the tab: canvases had zero size while display:none, so
    // just refit + redraw rather than reconnecting.
    const { htf, ltf } = AppState.panels;
    if (htf) htf.fitCanvas();
    if (ltf) ltf.fitCanvas();
    drawAll();
    return;
  }
  booted = true;
  boot();
}

window.mtfPageInit = mtfPageInit;

// Also expose eventBus/AppState on window for console debugging — never
// relied on by any module itself, purely a dev convenience.
if (typeof window !== 'undefined') {
  window.__mtfDebug = { AppState, eventBus, historyManager };
}
