/**
 * drawing/objects/RectangleDrawing.js
 *
 * Two-corner-anchored zone (Supply/Demand/FVG/Order Block/etc — Phase 10
 * builds named presets on top of this same class via metadata, not new
 * subclasses, per the Phase 5 metadata-not-subclasses instruction). Also
 * used for candle-component ("wick") marking — that's the same rectangle
 * geometry with a dashed border, so it's a render-time flag on this class
 * rather than a whole separate class.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke, drawLabel, withAlpha } from '../renderHelpers.js';
import { HIT_PX } from '../../core/constants.js';
import { ZONE_TYPES } from '../../core/constants.js';

const ZONE_LABEL_BY_KEY = Object.fromEntries(ZONE_TYPES.map(z => [z.key, z.label]));

export class RectangleDrawing extends DrawingObject {
  constructor(opts = {}) {
    super(opts.wickPart ? 'wick' : 'rect', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t2 ?? opts.t1; this.p2 = opts.p2 ?? opts.p1;
  }

  static get typeIcon() { return '▭'; }
  static get defaultLabel() { return 'Zone'; }

  shiftTime(dt) { this.t1 += dt; this.t2 += dt; }
  move(dt, dp) { this.t1 += dt; this.t2 += dt; this.p1 += dp; this.p2 += dp; }

  resize(handle, t, p) {
    if (handle === 'tl') { this.t1 = t; this.p1 = p; }
    else if (handle === 'tr') { this.t2 = t; this.p1 = p; }
    else if (handle === 'bl') { this.t1 = t; this.p2 = p; }
    else if (handle === 'br') { this.t2 = t; this.p2 = p; }
  }

  getHandles(panel) {
    const x1 = panel.timeToX(this.t1), x2 = panel.timeToX(this.t2);
    const y1 = panel.priceToY(this.p1), y2 = panel.priceToY(this.p2);
    return [{ x: x1, y: y1, h: 'tl' }, { x: x2, y: y1, h: 'tr' }, { x: x1, y: y2, h: 'bl' }, { x: x2, y: y2, h: 'br' }];
  }

  hitTest(panel, mx, my) {
    const x1 = panel.timeToX(this.t1), x2 = panel.timeToX(this.t2);
    const y1 = panel.priceToY(this.p1), y2 = panel.priceToY(this.p2);
    const xa = Math.min(x1, x2) - HIT_PX, xb = Math.max(x1, x2) + HIT_PX;
    const ya = Math.min(y1, y2) - HIT_PX, yb = Math.max(y1, y2) + HIT_PX;
    return mx >= xa && mx <= xb && my >= ya && my <= yb;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const x1 = panel.timeToX(this.t1), x2 = panel.timeToX(this.t2);
    const y1 = panel.priceToY(this.p1), y2 = panel.priceToY(this.p2);
    const xa = Math.min(x1, x2), ya = Math.min(y1, y2);
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);

    // Metadata-driven visual weight — this is what makes zoneType/status/
    // importance more than inert tags: a mitigated zone genuinely LOOKS
    // different from an active one, matching how professional SMC/ICT
    // charting tools grey out invalidated zones rather than deleting them.
    const isInvalidated = this.status === 'mitigated' || this.status === 'broken';
    const importanceWidthDelta = this.importance === 'high' ? 1 : this.importance === 'low' ? -1 : 0;
    const fillAlpha = (isDraft ? 0.12 : 0.16) * (isInvalidated ? 0.45 : 1);
    const effectiveBorderWidth = Math.max(1, this.borderWidth + importanceWidthDelta);

    ctx.save();
    ctx.fillStyle = withAlpha(this.color, fillAlpha);
    ctx.fillRect(xa, ya, w, h);

    setStroke(ctx, this, isDraft);
    ctx.lineWidth = effectiveBorderWidth;
    if (this.type === 'wick') ctx.setLineDash([5, 4]);
    else if (isInvalidated) ctx.setLineDash([2, 3]); // invalidated zones always render dotted, regardless of the user's own lineStyle choice — a deliberately strong "no longer active" signal
    if (this.importance === 'high' && !isInvalidated) { ctx.shadowColor = this.color; ctx.shadowBlur = 6; }
    ctx.strokeRect(xa, ya, w, h);
    ctx.shadowBlur = 0;

    drawLabel(ctx, this, xa + 4, ya - 6);

    // Zone-type badge, top-right corner — lets you scan a chart full of
    // zones at a glance without opening the properties panel for each one.
    if (this.zoneType && ZONE_LABEL_BY_KEY[this.zoneType]) {
      const badge = ZONE_LABEL_BY_KEY[this.zoneType];
      ctx.font = "700 9px IBM Plex Mono, monospace";
      const bw = ctx.measureText(badge).width + 10;
      const bx = xa + w - bw - 2, by = ya + 2;
      ctx.fillStyle = withAlpha(this.color, isInvalidated ? 0.3 : 0.85);
      ctx.fillRect(bx, by, bw, 14);
      ctx.fillStyle = "#04101a";
      ctx.fillText(badge, bx + 5, by + 10);
    }
    ctx.restore();
  }
}
