/**
 * drawing/objects/factory.js
 *
 * The only place that knows the type-string -> class mapping. Two jobs:
 *   - createDrawing(type, t1,p1,t2,p2,extra) — used by every tool when the
 *     user draws something new (same call shape as the old makeDrawing()
 *     factory function, so drawing/model.js can wrap this without any
 *     caller elsewhere needing to change).
 *   - deserializeDrawing(json) — reconstructs the correct subclass from a
 *     plain object (e.g. loaded from localStorage). Works identically for
 *     data saved by the OLD plain-object model (Phases 1-2) and the new
 *     class-based model, since JSON.stringify(instance) produces the exact
 *     same shape as JSON.stringify(plainObject) always did — only the
 *     prototype (added back here) differs.
 */
import { AppState } from '../../core/AppState.js';
import { RectangleDrawing } from './RectangleDrawing.js';
import { HorizontalLineDrawing } from './HorizontalLineDrawing.js';
import { VerticalLineDrawing } from './VerticalLineDrawing.js';
import { CircleDrawing } from './CircleDrawing.js';
import { TextDrawing } from './TextDrawing.js';
import { BrushDrawing } from './BrushDrawing.js';
import { TrendlineDrawing, RayDrawing, ArrowDrawing, MeasurementDrawing } from './LineSegmentDrawing.js';
import { FibRetracementDrawing } from './FibRetracementDrawing.js';

/** type string -> class. 'wick' is intentionally routed to RectangleDrawing (see that file's header comment). */
const REGISTRY = {
  rect: RectangleDrawing,
  wick: RectangleDrawing,
  hline: HorizontalLineDrawing,
  vline: VerticalLineDrawing,
  circle: CircleDrawing,
  text: TextDrawing,
  brush: BrushDrawing,
  trend: TrendlineDrawing,
  ray: RayDrawing,
  arrow: ArrowDrawing,
  measure: MeasurementDrawing,
  fibretracement: FibRetracementDrawing,
};

export function classFor(type) {
  return REGISTRY[type] || null;
}

/**
 * Create a brand-new drawing. Signature matches the tools' call sites
 * exactly (interaction.js, candleMarking.js): (type, t1, p1, t2, p2, extra).
 */
export function createDrawing(type, t1, p1, t2, p2, extra = {}) {
  const Cls = classFor(type);
  if (!Cls) throw new Error(`Unknown drawing type: "${type}"`);
  return new Cls({
    t1, p1, t2: t2 ?? t1, p2: p2 ?? p1,
    symbol: AppState.symbol,
    createdTF: extra._fromPanel || 'htf',
    scope: AppState.newScope,
    points: extra.points || null,
    label: extra.label,
    color: extra.color,
    opacity: extra.opacity,
    borderWidth: extra.borderWidth,
    lineStyle: extra.lineStyle,
    wickPart: extra.wickPart || null,
    semanticLabel: extra.semanticLabel || null,
    // Phase 5/10 metadata — forwarded when the caller provides it (e.g. a
    // zone preset from ui/zonePresets.js sets zoneType+color together).
    // Falls through to DrawingObject's own defaults (?? null / 'active' /
    // 'medium' / etc) when omitted, same as before this fix.
    zoneType: extra.zoneType ?? null,
    status: extra.status,
    importance: extra.importance,
    projection: extra.projection,
    priority: extra.priority,
    tags: extra.tags,
  });
}

/** Reconstruct a class instance from a plain object (e.g. JSON.parse'd from localStorage). */
export function deserializeDrawing(json) {
  const Cls = classFor(json.type);
  if (!Cls) {
    console.warn(`[drawing/factory] unknown saved type "${json.type}" — skipping`);
    return null;
  }
  // Bypass the constructor's defaulting logic entirely: assign every saved
  // field directly onto a correctly-prototyped instance, so nothing saved
  // is silently reset to a constructor default during reload.
  return Object.assign(Object.create(Cls.prototype), json);
}
