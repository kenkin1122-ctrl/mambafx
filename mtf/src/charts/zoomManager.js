/**
 * charts/zoomManager.js
 *
 * Centralizes every "zoom a panel to a drawing's price/time extent"
 * operation. Three call sites use this:
 *   - ui/drawingManager.js  — clicking a drawing in the sidebar (Phase 1)
 *   - ui/propertiesPanel.js — the "🔍 Zoom both charts here" button
 *   - drawing/interaction.js — Phase 7: selecting a drawing directly on the
 *     HTF chart auto-centers the LTF chart
 *
 * This is the module named "zoomManager" in the original architecture
 * critique's suggested folder structure — pulled out here rather than left
 * duplicated across drawingManager.js and interaction.js, which is exactly
 * the kind of duplication that critique was about.
 */
import { AppState } from '../core/AppState.js';
import { drawAll } from './render.js';

/** @returns {{t0:number,t1:number,p0:number,p1:number}} a drawing's time/price bounding box */
export function extentOf(d) {
  const t0 = Math.min(d.t1, d.t2 ?? d.t1), t1 = Math.max(d.t1, d.t2 ?? d.t1);
  const p0 = Math.min(d.p1, d.p2 ?? d.p1), p1 = Math.max(d.p1, d.p2 ?? d.p1);
  return { t0, t1, p0, p1 };
}

function applyZoom(panel, extent, padFrac) {
  const tspan = Math.max(extent.t1 - extent.t0, panel.granSeconds() * 6);
  panel.zoomToRange(extent.t0, extent.t0 + tspan, padFrac ?? 0.4);
  if (extent.p1 > extent.p0) panel.zoomToPriceRange(extent.p0, extent.p1);
}

/** Zoom BOTH panels to a drawing's extent (Drawing Manager click, "zoom both charts" button). */
export function zoomBothToDrawing(d) {
  const { htf, ltf } = AppState.panels;
  const extent = extentOf(d);
  if (htf) applyZoom(htf, extent);
  if (ltf) applyZoom(ltf, extent);
  drawAll();
}

/**
 * Zoom ONLY the LTF panel to a drawing's extent — Phase 7's automatic-zoom
 * requirement. Deliberately does NOT touch the HTF panel's own view: the
 * user is already looking at the HTF chart at whatever zoom they chose;
 * re-zooming it too on every single selection click would fight their own
 * navigation instead of assisting it. "Center lower timeframe charts" in
 * the spec is read literally here — lower, plural would still just mean
 * this one LTF panel in a 2-panel architecture.
 */
export function zoomLtfToDrawing(d) {
  const { ltf } = AppState.panels;
  if (!ltf) return;
  applyZoom(ltf, extentOf(d));
  drawAll();
}
