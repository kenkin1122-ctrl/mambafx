/**
 * drawing/render.js
 *
 * Phase 3: this file used to have a ~90-line switch statement rendering
 * every drawing type, plus a second switch computing handle positions per
 * type. Both are gone — every DrawingObject subclass implements render()
 * and getHandles() itself (see drawing/objects/), so this file is now just
 * the two call sites: renderDrawing() dispatches to d.render(), and
 * drawSelectionHandles() dispatches to d.getHandles() and draws the dots.
 * Nothing here needs to know what a Rectangle vs a Circle vs a Trendline
 * actually is anymore.
 */

import { HANDLE_R } from '../core/constants.js';

/**
 * @param {import('../charts/Panel.js').Panel} panel
 * @param {import('./objects/DrawingObject.js').DrawingObject} d
 * @param {boolean} [isDraft] true while the object is still being drawn (not yet committed)
 */
export function renderDrawing(panel, d, isDraft) {
  d.render(panel, isDraft);
}

/** @param {import('../charts/Panel.js').Panel} panel @param {import('./objects/DrawingObject.js').DrawingObject} d */
export function drawSelectionHandles(panel, d) {
  const ctx = panel.ctx;
  ctx.save();
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "#4fb2ff"; ctx.lineWidth = 1.5;
  d.getHandles(panel).forEach(h => {
    ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  ctx.restore();
}
