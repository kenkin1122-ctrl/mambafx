/**
 * drawing/model.js
 *
 * Phase 3 note: the actual drawing-type behavior (move/resize/render/
 * hitTest) now lives in the DrawingObject class hierarchy under
 * drawing/objects/ — see objects/factory.js for the type registry. This
 * file is now a thin compatibility layer: makeDrawing() keeps the exact
 * call signature every existing caller (drawing/interaction.js, drawing/
 * candleMarking.js) already uses, so Phase 3 required zero changes at
 * those call sites — it just delegates to the factory instead of building
 * a plain object by hand. visibleOnPanel() is unchanged from Phase 1 — it's
 * not drawing-type-specific behavior, so it didn't need to move into the
 * class hierarchy. (Phase 17: removed a stale, unused duplicate of
 * candleMarking.js's SEMANTIC constant that had been dead-copied here since
 * Phase 1 — candleMarking.js is its only real consumer.)
 */

import { AppState } from '../core/AppState.js';
import { createDrawing } from './objects/factory.js';
import { newId } from './ids.js';

export { newId };

/** Create a new drawing instance. Same signature as the old plain-object factory: (type, t1, p1, t2, p2, extra). */
export function makeDrawing(type, t1, p1, t2, p2, extra = {}) {
  return createDrawing(type, t1, p1, t2, p2, extra);
}

export function typeIcon(type) {
  return { rect: "▭", hline: "―", vline: "❘", trend: "╱", ray: "↗", arrow: "➔", brush: "✎", circle: "◯", text: "T", measure: "⤢", wick: "🕯" }[type] || "●";
}

/** Should this drawing be shown on the given panel, given its symbol/visibility/scope? */
export function visibleOnPanel(d, panel) {
  if (!d.visible) return false;
  if (d.symbol !== AppState.symbol) return false;
  if (d.scope === "current") return d.createdTF === panel.side;
  return true; // 'all'
}
