/**
 * drawing/objects/HorizontalLineDrawing.js — movable-vertically horizontal price level.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke, drawLabel } from '../renderHelpers.js';
import { HIT_PX } from '../../core/constants.js';

export class HorizontalLineDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('hline', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t1; this.p2 = opts.p1; // kept for shape symmetry with other types; unused
  }

  static get typeIcon() { return '―'; }
  static get defaultLabel() { return 'Level'; }

  shiftTime(dt) { /* a horizontal line has no time anchor to shift */ }
  move(dt, dp) { this.p1 += dp; this.p2 = this.p1; }
  resize(handle, t, p) { this.p1 = p; this.p2 = p; }

  getHandles(panel) {
    return [{ x: panel.padL + 20, y: panel.priceToY(this.p1), h: 'p1' }];
  }

  hitTest(panel, mx, my) {
    return Math.abs(my - panel.priceToY(this.p1)) <= HIT_PX;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const y = panel.priceToY(this.p1);
    ctx.save();
    setStroke(ctx, this, isDraft);
    ctx.beginPath(); ctx.moveTo(panel.padL, y); ctx.lineTo(panel.W - panel.padR, y); ctx.stroke();
    drawLabel(ctx, this, panel.W - panel.padR - 90, y - 6);
    ctx.restore();
  }
}
