/**
 * drawing/objects/TextDrawing.js — single-anchor text label.
 */
import { DrawingObject } from './DrawingObject.js';
import { withAlpha } from '../renderHelpers.js';

export class TextDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('text', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t1; this.p2 = opts.p1; // unused
    this._bbox = null; // computed during render(), used by hitTest()
  }

  static get typeIcon() { return 'T'; }
  static get defaultLabel() { return 'Note'; }

  shiftTime(dt) { this.t1 += dt; this.t2 = this.t1; }
  move(dt, dp) { this.t1 += dt; this.t2 = this.t1; this.p1 += dp; this.p2 = this.p1; }
  resize(handle, t, p) { this.t1 = t; this.t2 = t; this.p1 = p; this.p2 = p; }

  getHandles(panel) {
    return [{ x: panel.timeToX(this.t1), y: panel.priceToY(this.p1), h: 'p1' }];
  }

  hitTest(panel, mx, my) {
    const b = this._bbox;
    if (!b) return false;
    return mx >= b.x - 3 && mx <= b.x + b.w + 3 && my >= b.y - 3 && my <= b.y + b.h + 3;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const x = panel.timeToX(this.t1), y = panel.priceToY(this.p1);
    ctx.save();
    ctx.fillStyle = withAlpha(this.color, this.opacity);
    ctx.font = "700 12px IBM Plex Mono, monospace";
    ctx.fillText(this.label, x, y);
    this._bbox = { x, y: y - 12, w: ctx.measureText(this.label).width, h: 16 };
    ctx.restore();
  }
}
