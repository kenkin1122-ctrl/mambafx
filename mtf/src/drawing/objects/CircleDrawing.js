/**
 * drawing/objects/CircleDrawing.js — center + edge-point anchored circle.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke, drawLabel, withAlpha } from '../renderHelpers.js';
import { HIT_PX } from '../../core/constants.js';

export class CircleDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('circle', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;   // center
    this.t2 = opts.t2 ?? opts.t1; this.p2 = opts.p2 ?? opts.p1; // edge point (defines radius)
  }

  static get typeIcon() { return '◯'; }
  static get defaultLabel() { return 'Circle'; }

  shiftTime(dt) { this.t1 += dt; this.t2 += dt; }
  move(dt, dp) { this.t1 += dt; this.t2 += dt; this.p1 += dp; this.p2 += dp; }

  resize(handle, t, p) {
    if (handle === 'c') { this.t1 = t; this.p1 = p; } else { this.t2 = t; this.p2 = p; }
  }

  getHandles(panel) {
    return [
      { x: panel.timeToX(this.t1), y: panel.priceToY(this.p1), h: 'c' },
      { x: panel.timeToX(this.t2), y: panel.priceToY(this.p2), h: 'r' },
    ];
  }

  hitTest(panel, mx, my) {
    const cx = panel.timeToX(this.t1), cy = panel.priceToY(this.p1);
    const r = Math.hypot(panel.timeToX(this.t2) - cx, panel.priceToY(this.p2) - cy);
    return Math.abs(Math.hypot(mx - cx, my - cy) - r) <= HIT_PX;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const cx = panel.timeToX(this.t1), cy = panel.priceToY(this.p1);
    const ex = panel.timeToX(this.t2), ey = panel.priceToY(this.p2);
    const r = Math.hypot(ex - cx, ey - cy);
    ctx.save();
    ctx.fillStyle = withAlpha(this.color, 0.12);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    setStroke(ctx, this, isDraft); ctx.stroke();
    drawLabel(ctx, this, cx - 14, cy - r - 8);
    ctx.restore();
  }
}
