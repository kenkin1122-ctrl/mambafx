/**
 * drawing/objects/VerticalLineDrawing.js — movable-horizontally time marker.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke, drawLabel } from '../renderHelpers.js';
import { HIT_PX } from '../../core/constants.js';

export class VerticalLineDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('vline', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t1; this.p2 = opts.p1; // unused, kept for shape symmetry
  }

  static get typeIcon() { return '❘'; }
  static get defaultLabel() { return 'Time Marker'; }

  shiftTime(dt) { this.t1 += dt; this.t2 = this.t1; }
  move(dt, dp) { this.t1 += dt; this.t2 = this.t1; }
  resize(handle, t, p) { this.t1 = t; this.t2 = t; }

  getHandles(panel) {
    return [{ x: panel.timeToX(this.t1), y: panel.padT + 20, h: 't1' }];
  }

  hitTest(panel, mx, my) {
    return Math.abs(mx - panel.timeToX(this.t1)) <= HIT_PX;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const x = panel.timeToX(this.t1);
    ctx.save();
    setStroke(ctx, this, isDraft);
    ctx.beginPath(); ctx.moveTo(x, panel.padT); ctx.lineTo(x, panel.H - panel.padB); ctx.stroke();
    drawLabel(ctx, this, x + 5, panel.padT + 12);
    ctx.restore();
  }
}
