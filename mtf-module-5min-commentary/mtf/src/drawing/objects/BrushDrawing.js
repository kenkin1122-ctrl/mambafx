/**
 * drawing/objects/BrushDrawing.js — freehand polyline through an arbitrary
 * number of (time, price) points. No resize handles by design (matches the
 * original tool's behavior — a freehand sketch doesn't have a meaningful
 * "corner" to drag); move and hit-test both operate on the point array.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke } from '../renderHelpers.js';
import { distToSeg } from '../../utils/geometry.js';
import { HIT_PX } from '../../core/constants.js';

export class BrushDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('brush', opts);
    this.points = opts.points || [];
    // t1/p1/t2/p2 kept for shape symmetry with other types (e.g. zoom-to-drawing extent calc)
    this.t1 = this.points[0]?.t ?? opts.t1;
    this.p1 = this.points[0]?.p ?? opts.p1;
    const last = this.points[this.points.length - 1];
    this.t2 = last?.t ?? this.t1;
    this.p2 = last?.p ?? this.p1;
  }

  static get typeIcon() { return '✎'; }
  static get defaultLabel() { return 'Sketch'; }

  addPoint(t, p) {
    this.points.push({ t, p });
    this.t2 = t; this.p2 = p;
  }

  shiftTime(dt) {
    this.points = this.points.map(pt => ({ t: pt.t + dt, p: pt.p }));
    this.t1 += dt; this.t2 += dt;
  }

  move(dt, dp) {
    this.points = this.points.map(pt => ({ t: pt.t + dt, p: pt.p + dp }));
    this.t1 += dt; this.t2 += dt; this.p1 += dp; this.p2 += dp;
  }

  resize() { /* no handles — nothing to resize */ }
  getHandles() { return []; }

  hitTest(panel, mx, my) {
    if (!this.points || this.points.length < 2) return false;
    for (let i = 1; i < this.points.length; i++) {
      const x1 = panel.timeToX(this.points[i - 1].t), y1 = panel.priceToY(this.points[i - 1].p);
      const x2 = panel.timeToX(this.points[i].t), y2 = panel.priceToY(this.points[i].p);
      if (distToSeg(mx, my, x1, y1, x2, y2) <= HIT_PX) return true;
    }
    return false;
  }

  render(panel, isDraft) {
    if (!this.points || this.points.length < 2) return;
    const ctx = panel.ctx;
    ctx.save();
    setStroke(ctx, this, isDraft);
    ctx.beginPath();
    this.points.forEach((pt, i) => {
      const x = panel.timeToX(pt.t), y = panel.priceToY(pt.p);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }
}
