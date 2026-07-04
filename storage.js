/**
 * ui/header.js
 *
 * Owns every DOM element in the panel headers (price, meta, connection dot)
 * plus the symbol/timeframe <select> controls. Subscribes to the events
 * charts/socket.js and charts/Panel.js emit rather than being called
 * directly — this is the module that turns "connection:changed" / "panel:
 * dataUpdated" into actual DOM updates.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { decimalsFor } from '../utils/geometry.js';
import { SYMBOLS, HTF_TFS, LTF_TFS } from '../core/constants.js';
import { requestPanelData, resubscribeAll } from '../charts/socket.js';
import { isReplayActive, exitReplay } from '../charts/replayManager.js';
import { loadDrawings } from '../workspace/storage.js';
import { renderOrderFlow } from '../orderflow/proxy.js';

export function populateSelects() {
  const { htf, ltf } = AppState.panels;
  $("mtfSymbolSel").innerHTML = Object.entries(SYMBOLS).map(([k, v]) => `<option value="${k}" ${k === AppState.symbol ? 'selected' : ''}>${v}</option>`).join("");
  $("mtfHtfTfSel").innerHTML = HTF_TFS.map(t => `<option value="${t.key}" ${t.key === htf.tf.key ? 'selected' : ''}>${t.label}</option>`).join("");
  $("mtfLtfTfSel").innerHTML = LTF_TFS.map(t => `<option value="${t.key}" ${t.key === ltf.tf.key ? 'selected' : ''}>${t.label}</option>`).join("");

  $("mtfSymbolSel").onchange = e => switchSymbol(e.target.value);
  $("mtfHtfTfSel").onchange = e => switchTimeframe(htf, e.target.value);
  $("mtfLtfTfSel").onchange = e => switchTimeframe(ltf, e.target.value);
}

/**
 * Phase 9 fix: this used to unconditionally clear decompRange and hide the
 * banner on ANY timeframe change, including changing the LTF panel's OWN
 * dropdown while already decomposed — which meant you couldn't compare a
 * candle's formation at 1-min vs 10-tick resolution, because switching the
 * LTF granularity kicked you straight back to the live view. That directly
 * defeated "allow independent analysis" from the Phase 9 spec.
 *
 * Now: switching the LTF's own timeframe while decomposed PRESERVES the
 * decomposition and refetches bounded to the same candle at the new
 * granularity. Switching the HTF's timeframe still exits decomposition —
 * the decomposed range is defined relative to a specific candle in a
 * specific HTF granularity, which stops being well-defined the moment that
 * granularity changes.
 */
export function switchTimeframe(panel, tfKey) {
  const { htf, ltf } = AppState.panels;
  panel.tf = panel.tfList.find(t => t.key === tfKey) || panel.tf;
  if (panel === htf && isReplayActive()) exitReplay(); // htf.candles is about to be replaced entirely

  if (panel === htf) {
    // HTF granularity changed — any active decomposition refers to a
    // candle definition that no longer applies. Exit it.
    if (ltf.decompRange) {
      ltf.decompRange = null;
      const banner = $("mtfLtfDecompBanner");
      if (banner) banner.style.display = "none";
    }
    requestPanelData(panel);
    return;
  }

  // panel === ltf
  if (panel.decompRange) {
    // Stay decomposed — just re-fetch the SAME candle's formation at the
    // newly selected LTF granularity.
    requestPanelData(panel, { start: panel.decompRange.t0 - 5, end: panel.decompRange.t1 + 5 });
  } else {
    requestPanelData(panel);
  }
}

export function switchSymbol(sym) {
  if (isReplayActive()) exitReplay();
  AppState.setSymbol(sym);
  AppState.setDrawings(loadDrawings(sym));
  AppState.setSelectedId(null);
  const { htf, ltf } = AppState.panels;
  htf.decompRange = null; ltf.decompRange = null;
  const banner = $("mtfLtfDecompBanner");
  if (banner) banner.style.display = "none";
  resubscribeAll();
}

function updatePanelHeader(panel) {
  const px = panel.lastPrice();
  const pxEl = $(panel.id + "Px");
  if (px != null && pxEl) {
    pxEl.textContent = px.toFixed(decimalsFor(px));
    const vis = panel.isTick() ? panel.ticks : panel.candles;
    if (vis.length >= 2) {
      const prev = panel.isTick() ? vis[vis.length - 2].price : vis[vis.length - 2].close;
      pxEl.className = "px " + (px > prev ? "up" : px < prev ? "dn" : "");
    }
  }
  const metaEl = $(panel.id + "Meta");
  if (metaEl) {
    const n = panel.isTick() ? panel.ticks.length : panel.candles.length;
    metaEl.textContent = `${SYMBOLS[AppState.symbol] || AppState.symbol} · ${panel.tf.label} · ${n} loaded`;
  }
  renderOrderFlow(panel);
}

function setConnDom(state) {
  const dot = $("mtfConnDot"), txt = $("mtfConnText");
  if (!dot || !txt) return;
  dot.className = "d" + (state === "live" ? " on" : "");
  txt.textContent = state === "live" ? "Live" : state === "dead" ? "Reconnecting…" : "Connecting…";
}

/** Wire header DOM updates to the relevant events. Call once at boot. */
export function initHeader() {
  eventBus.on('connection:changed', setConnDom);
  eventBus.on('panel:dataUpdated', ({ panel }) => updatePanelHeader(panel));
  eventBus.on('crosshair:changed', c => {
    if (c) $("mtfSyncTime").textContent = new Date(c.t * 1000).toLocaleString([], { hour12: false });
  });
}
