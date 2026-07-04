/**
 * charts/Panel.js
 *
 * One chart panel (HTF or LTF): owns its coordinate transforms, its live
 * candle/tick data, its view window — and, as of Phase 2, TWO stacked
 * canvases instead of one:
 *   - bgCanvas/bgCtx  ("background") — candles, grid, committed drawings.
 *     Repainted only when data or the view actually changes; NOT on every
 *     mousemove. This is charts/render.js's drawBackground().
 *   - ovCanvas/ovCtx  ("overlay") — crosshair, selection handles, the
 *     drag-in-progress preview. Cheap, repainted every mousemove via
 *     charts/render.js's drawOverlay(). Sits visually on top (later in DOM
 *     order) and is the one that actually receives pointer events — the
 *     background canvas is purely a paint target now.
 *
 * Panel itself still only emits events (canvas:*, panel:resized, panel:
 * dataUpdated) — it has no opinion on *how* those trigger a repaint. That
 * decision now lives entirely in charts/render.js's invalidate*() scheduler.
 */

import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { CANDLE_COUNT } from '../core/constants.js';

export class Panel {
  /**
   * @param {string} id     unique DOM id prefix, e.g. "mtfHtf" — expects `${id}Canvas` (background) and `${id}CanvasOv` (overlay) elements
   * @param {string} side   "htf" | "ltf" — logical role, used by scope rules elsewhere (not a DOM id)
   * @param {Array}  tfList the timeframe option list this panel selects from
   */
  constructor(id, side, tfList) {
    this.id = id; this.side = side; this.tfList = tfList;
    this.tf = tfList[side === "htf" ? 1 : 2]; // default 1H / 1min

    this.bgCanvas = $(id + "Canvas");
    this.bgCtx = this.bgCanvas.getContext("2d");
    this.ovCanvas = $(id + "CanvasOv");
    this.ovCtx = this.ovCanvas.getContext("2d");

    this.candles = [];        // {epoch,open,high,low,close}
    this.ticks = [];           // for tick1 line mode: {epoch,price}
    this.viewT0 = null; this.viewT1 = null;   // visible time window
    this.priceLock = null;                     // {p0,p1} if user manually panned price
    this.decompRange = null;                    // {t0,t1} when in candle-decomposition mode
    this.padL = 8; this.padR = 60; this.padT = 14; this.padB = 26;

    this._attachResizeObserver();
    this._attachInteractionEvents();
  }

  _attachInteractionEvents() {
    // Listeners live on the overlay canvas — it's the topmost element and
    // the one under the cursor. The background canvas never receives events.
    const emit = (name) => (e) => eventBus.emit(name, { panel: this, event: e });
    this.ovCanvas.addEventListener("mousedown", emit("canvas:mousedown"));
    this.ovCanvas.addEventListener("mousemove", emit("canvas:mousemove"));
    window.addEventListener("mouseup", emit("canvas:mouseup"));
    this.ovCanvas.addEventListener("wheel", emit("canvas:wheel"), { passive: false });
    this.ovCanvas.addEventListener("dblclick", emit("canvas:dblclick"));
    this.ovCanvas.addEventListener("contextmenu", emit("canvas:contextmenu"));
    this.ovCanvas.addEventListener("mouseleave", () => eventBus.emit("canvas:mouseleave", { panel: this }));
  }

  _attachResizeObserver() {
    const ro = new ResizeObserver(() => this.fitCanvas());
    ro.observe(this.bgCanvas.parentElement);
    this.fitCanvas();
  }

  fitCanvas() {
    const r = this.bgCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, r.width), h = Math.max(50, r.height);
    for (const [canvas, ctx] of [[this.bgCanvas, this.bgCtx], [this.ovCanvas, this.ovCtx]]) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.W = w; this.H = h;
    this.plotW = this.W - this.padL - this.padR;
    this.plotH = this.H - this.padT - this.padB;
    eventBus.emit("panel:resized", { panel: this });
  }

  isTick() { return this.tf.g === "tick1"; }

  granSeconds() {
    if (this.tf.g === "tick1") return 1;
    if (this.tf.g === "tick10") return 10;
    return this.tf.g;
  }

  // ── coordinate transforms (time in epoch seconds, price in quote units) ──
  timeToX(t) {
    if (this.viewT0 == null) return this.padL;
    const frac = (t - this.viewT0) / (this.viewT1 - this.viewT0 || 1);
    return this.padL + frac * this.plotW;
  }
  xToTime(x) {
    if (this.viewT0 == null) return 0;
    const frac = (x - this.padL) / (this.plotW || 1);
    return this.viewT0 + frac * (this.viewT1 - this.viewT0);
  }
  priceToY(p) {
    const { p0, p1 } = this.currentPriceRange();
    const frac = (p - p0) / (p1 - p0 || 1);
    return this.padT + (1 - frac) * this.plotH;
  }
  yToPrice(y) {
    const { p0, p1 } = this.currentPriceRange();
    const frac = (y - this.padT) / (this.plotH || 1);
    return p1 - frac * (p1 - p0);
  }

  visibleData() {
    if (this.isTick()) return this.ticks.filter(t => t.epoch >= this.viewT0 && t.epoch <= this.viewT1);
    return this.candles.filter(c => c.epoch + this.granSeconds() >= this.viewT0 && c.epoch <= this.viewT1);
  }

  currentPriceRange() {
    if (this.priceLock) return this.priceLock;
    const vis = this.visibleData();
    if (!vis.length) return { p0: 0, p1: 1 };
    let hi, lo;
    if (this.isTick()) { hi = Math.max(...vis.map(t => t.price)); lo = Math.min(...vis.map(t => t.price)); }
    else { hi = Math.max(...vis.map(c => c.high)); lo = Math.min(...vis.map(c => c.low)); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1;
    return { p0: lo - pad, p1: hi + pad };
  }

  lastPrice() {
    if (this.isTick()) return this.ticks.length ? this.ticks[this.ticks.length - 1].price : null;
    return this.candles.length ? this.candles[this.candles.length - 1].close : null;
  }

  setDefaultView() {
    const now = Math.floor(Date.now() / 1000);
    const span = this.granSeconds() * CANDLE_COUNT;
    this.viewT0 = now - span; this.viewT1 = now + this.granSeconds() * 3;
    this.priceLock = null;
  }

  zoomToRange(t0, t1, padFrac) {
    const pad = (t1 - t0) * (padFrac ?? 0.15);
    this.viewT0 = t0 - pad; this.viewT1 = t1 + pad;
    this.priceLock = null;
  }

  zoomToPriceRange(p0, p1, padFrac) {
    const pad = (p1 - p0) * (padFrac ?? 0.25) || (p1 * 0.001);
    this.priceLock = { p0: p0 - pad, p1: p1 + pad };
  }

  applyLiveCandle(ohlc) {
    if (this.isTick()) return;
    const epoch = Number(ohlc.open_time != null ? ohlc.open_time : ohlc.epoch);
    const c = { epoch, open: +ohlc.open, high: +ohlc.high, low: +ohlc.low, close: +ohlc.close };
    const last = this.candles[this.candles.length - 1];
    if (last && last.epoch === epoch) this.candles[this.candles.length - 1] = c;
    else if (!last || epoch > last.epoch) {
      this.candles.push(c);
      if (this.candles.length > CANDLE_COUNT * 2) this.candles.shift();
    }
    eventBus.emit("panel:dataUpdated", { panel: this });
  }

  applyLiveTick(tick) {
    const price = Number(tick.quote);
    const epoch = Number(tick.epoch);
    if (this.isTick()) {
      this.ticks.push({ epoch, price });
      if (this.ticks.length > CANDLE_COUNT * 4) this.ticks.shift();
    } else if (this.tf.g === "tick10") {
      let last = this.candles[this.candles.length - 1];
      if (!last || last._n >= 10) {
        last = { epoch, open: price, high: price, low: price, close: price, _n: 1 };
        this.candles.push(last);
        if (this.candles.length > CANDLE_COUNT * 2) this.candles.shift();
      } else {
        last.high = Math.max(last.high, price); last.low = Math.min(last.low, price);
        last.close = price; last._n++;
      }
    }
    eventBus.emit("panel:dataUpdated", { panel: this });
  }
}
