/**
 * drawing/objects/LineSegmentDrawing.js
 *
 * Trendline, Ray, Arrow, and Measurement are all geometrically identical —
 * two (time, price) anchor points connected by a line, with optional
 * extend-to-edge behavior. Rather than four classes each reimplementing
 * move/resize/hitTest/getHandles/the shared render body (which is exactly
 * the kind of duplication Phase 3 exists to remove), this file has ONE base
 * class with that shared logic, and each leaf class overrides only the
 * 1-3 lines that actually differ:
 *   - TrendlineDrawing: extend-left/right toggled by the user (properties panel)
 *   - RayDrawing:       always extends right, regardless of the extendRight flag
 *   - ArrowDrawing:     draws an arrowhead at the end point
 *   - MeasurementDrawing: forces a dashed line + computes a Δprice/Δ%/bars label at creation time
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke, drawLabel } from '../renderHelpers.js';
import { distToSeg, decimalsFor } from '../../utils/geometry.js';
import { HIT_PX } from '../../core/constants.js';

export class LineSegmentDrawing extends DrawingObject {
  constructor(type, opts = {}) {
    super(type, opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t2 ?? opts.t1; this.p2 = opts.p2 ?? opts.p1;
  }

  /** Ray overrides this to always return true; Trendline/Arrow/Measurement respect the extendRight flag. */
  get forceExtendRight() { return false; }
  /** Arrow overrides this to draw an arrowhead. */
  drawArrowhead(ctx, x1, y1, x2, y2) { /* no-op by default */ }
  /** Measurement overrides this to force a dashed line regardless of lineStyle. */
  applyExtraLineStyle(ctx) { /* no-op by default */ }

  shiftTime(dt) { this.t1 += dt; this.t2 += dt; }
  move(dt, dp) { this.t1 += dt; this.t2 += dt; this.p1 += dp; this.p2 += dp; }

  resize(handle, t, p) {
    if (handle === 'p1') { this.t1 = t; this.p1 = p; } else { this.t2 = t; this.p2 = p; }
  }

  getHandles(panel) {
    return [
      { x: panel.timeToX(this.t1), y: panel.priceToY(this.p1), h: 'p1' },
      { x: panel.timeToX(this.t2), y: panel.priceToY(this.p2), h: 'p2' },
    ];
  }

  hitTest(panel, mx, my) {
    const x1 = panel.timeToX(this.t1), y1 = panel.priceToY(this.p1);
    const x2 = panel.timeToX(this.t2), y2 = panel.priceToY(this.p2);
    return distToSeg(mx, my, x1, y1, x2, y2) <= HIT_PX;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    let x1 = panel.timeToX(this.t1), y1 = panel.priceToY(this.p1);
    let x2 = panel.timeToX(this.t2), y2 = panel.priceToY(this.p2);
    const dx = x2 - x1, dy = y2 - y1;

    if ((this.extendRight || this.forceExtendRight) && dx !== 0) {
      const k = (panel.W - panel.padR - x1) / dx;
      if (k > 1) { x2 = panel.W - panel.padR; y2 = y1 + dy * k; }
    }
    if (this.extendLeft && dx !== 0) {
      const k = (panel.padL - x1) / dx;
      if (k < 0) { x1 = panel.padL; y1 = y1 + dy * k; }
    }

    ctx.save();
    setStroke(ctx, this, isDraft);
    this.applyExtraLineStyle(ctx);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    this.drawArrowhead(ctx, x1, y1, x2, y2);
    drawLabel(ctx, this, (x1 + x2) / 2, (y1 + y2) / 2 - 8);
    ctx.restore();
  }
}

export class TrendlineDrawing extends LineSegmentDrawing {
  constructor(opts = {}) { super('trend', opts); }
  static get typeIcon() { return '╱'; }
  static get defaultLabel() { return 'Trendline'; }
}

export class RayDrawing extends LineSegmentDrawing {
  constructor(opts = {}) { super('ray', { ...opts, extendRight: true }); }
  static get typeIcon() { return '↗'; }
  static get defaultLabel() { return 'Ray'; }
  get forceExtendRight() { return true; }
}

export class ArrowDrawing extends LineSegmentDrawing {
  constructor(opts = {}) { super('arrow', opts); }
  static get typeIcon() { return '➔'; }
  static get defaultLabel() { return 'Arrow'; }

  drawArrowhead(ctx, x1, y1, x2, y2) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 10 * Math.cos(ang - 0.4), y2 - 10 * Math.sin(ang - 0.4));
    ctx.lineTo(x2 - 10 * Math.cos(ang + 0.4), y2 - 10 * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }
}

export class MeasurementDrawing extends LineSegmentDrawing {
  constructor(opts = {}) { super('measure', opts); }
  static get typeIcon() { return '⤢'; }
  static get defaultLabel() { return 'Measurement'; }

  applyExtraLineStyle(ctx) { ctx.setLineDash([4, 4]); }

  /** Called once when the measurement is finalized (mouseup) — bakes the Δprice/Δ%/bar-count into the label. */
  computeLabel(granSeconds) {
    const dp = this.p2 - this.p1, pct = (dp / this.p1 * 100);
    const bars = Math.round(Math.abs(this.t2 - this.t1) / granSeconds);
    this.label = `${dp >= 0 ? '+' : ''}${dp.toFixed(decimalsFor(this.p1))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars} bars`;
  }
}
