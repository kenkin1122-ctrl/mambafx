/**
 * drawing/renderHelpers.js — tiny helpers shared by every DrawingObject
 * subclass's render() method, so stroke-style and label-drawing logic
 * exists in exactly one place rather than being copy-pasted per subclass.
 */
import { withAlpha } from '../utils/color.js';

export function setStroke(ctx, d, isDraft) {
  ctx.strokeStyle = withAlpha(d.color, isDraft ? d.opacity * 0.7 : d.opacity);
  ctx.lineWidth = d.borderWidth;
  ctx.setLineDash(d.lineStyle === "dashed" ? [7, 5] : d.lineStyle === "dotted" ? [2, 4] : []);
}

export function drawLabel(ctx, d, x, y) {
  if (!d.label) return;
  ctx.font = "700 10px IBM Plex Mono, monospace";
  ctx.fillStyle = withAlpha(d.color, Math.min(1, d.opacity + 0.15));
  ctx.fillText(d.label, x, y);
}

export { withAlpha };
