/**
 * utils/geometry.js
 */

/** Shortest distance from point (px,py) to line segment (x1,y1)-(x2,y2), in the same units as the inputs (pixels here). */
export function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Decimal places to display for a given price magnitude — matches Deriv synthetic index conventions used elsewhere in Mamba FX. */
export function decimalsFor(px) {
  return px < 10 ? 4 : px < 1000 ? 3 : 2;
}
