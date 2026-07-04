/**
 * drawing/objects/FibRetracementDrawing.js
 *
 * Fibonacci Retracement: two anchor points (t1,p1) and (t2,p2) define a
 * price move; the tool renders horizontal lines at the standard
 * retracement ratios between them, each labeled with its ratio and price.
 *
 * CONVENTION, STATED EXPLICITLY (matches TradingView's own tool): point 1
 * is where the move starts, point 2 is where it ends. 0% sits AT point 2
 * (the end of the move — "no retracement yet"), 100% sits AT point 1 (the
 * start of the move — "fully retraced"). This is why the formula below is
 * `p2 + (p1 - p2) * ratio`, not the more naive-looking `p1 + (p2-p1)*ratio`
 * — getting this backwards would silently swap which end is "0%" and
 * "100%", which is exactly the kind of thing worth stating and testing
 * explicitly rather than assuming everyone would derive it the same way.
 *
 * Geometrically this reuses the same 2-point move/resize/handle pattern as
 * LineSegmentDrawing (trendline/ray/arrow/measurement), but the render is
 * fundamentally different (N horizontal levels + labels, not one line), so
 * it extends DrawingObject directly rather than LineSegmentDrawing.
 */
import { DrawingObject } from './DrawingObject.js';
import { setStroke } from '../renderHelpers.js';
import { decimalsFor } from '../../utils/geometry.js';
import { HIT_PX } from '../../core/constants.js';

export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export class FibRetracementDrawing extends DrawingObject {
  constructor(opts = {}) {
    super('fibretracement', opts);
    this.t1 = opts.t1; this.p1 = opts.p1;
    this.t2 = opts.t2 ?? opts.t1; this.p2 = opts.p2 ?? opts.p1;
  }

  /** Price at a given retracement ratio — see file header for the 0%=point2 / 100%=point1 convention. */
  levelPrice(ratio) {
    return this.p2 + (this.p1 - this.p2) * ratio;
  }

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
    const x1 = panel.timeToX(this.t1), x2 = panel.timeToX(this.t2);
    const xLo = Math.min(x1, x2), xHi = Math.max(x1, x2);
    if (mx < xLo - HIT_PX || mx > xHi + HIT_PX) return false;
    for (const ratio of FIB_RETRACEMENT_LEVELS) {
      const y = panel.priceToY(this.levelPrice(ratio));
      if (Math.abs(my - y) <= HIT_PX) return true;
    }
    return false;
  }

  render(panel, isDraft) {
    const ctx = panel.ctx;
    const x1 = panel.timeToX(this.t1), x2 = panel.timeToX(this.t2);
    const xLo = Math.min(x1, x2), xHi = Math.max(x1, x2);
    const dec = decimalsFor(this.p1);

    setStroke(ctx, this, isDraft);
    ctx.font = "10px IBM Plex Mono, monospace";

    FIB_RETRACEMENT_LEVELS.forEach(ratio => {
      const price = this.levelPrice(ratio);
      const y = panel.priceToY(price);
      ctx.beginPath();
      ctx.moveTo(xLo, y);
      ctx.lineTo(xHi, y);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${(ratio * 100).toFixed(1)}%  ${price.toFixed(dec)}`, xHi + 4, y + 3);
    });
  }
}
