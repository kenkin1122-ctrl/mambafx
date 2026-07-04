/**
 * charts/render.js
 *
 * Phase 2 rendering engine. Two layers per panel:
 *
 *   BACKGROUND (bgCtx) — grid, candles/tick-line, every COMMITTED drawing
 *     except the one currently being dragged. Expensive-ish (iterates every
 *     drawing + every visible candle), so it's only repainted when
 *     invalidateBackground() is actually called — data updates, resize,
 *     the drawings list changing, or the view (pan/zoom) changing. It is
 *     NOT touched by crosshair movement or by dragging an existing object.
 *
 *   OVERLAY (ovCtx) — crosshair, selection handles, and the "live" object:
 *     either the in-progress draft (a brand new drawing being drawn) or the
 *     drawing currently being moved/resized (rendered here instead of on
 *     the background while a drag is active). Cheap — a handful of lines
 *     and at most one drawing object — so it's fine to repaint on every
 *     mousemove, which is exactly how often it needs to.
 *
 * Both layers are scheduled through a single requestAnimationFrame loop
 * with per-panel, per-layer dirty flags. Calling invalidateBackground()/
 * invalidateOverlay() any number of times before the next frame coalesces
 * into exactly one repaint of each dirty layer — that's the "don't redraw
 * everything on every mouse movement" requirement, made concrete: multiple
 * mousemove events between two animation frames (easily 4-8 on a fast
 * mouse/high refresh-rate display) now cost one overlay repaint, not one
 * repaint per event, and the background layer isn't touched at all unless
 * something that actually affects it changed.
 *
 * Pan and wheel-zoom are the one case that legitimately still repaints the
 * background on every mousemove/wheel tick — the whole coordinate system is
 * shifting, so grid/candles/every drawing's screen position changes. That's
 * inherent to the operation (every real charting library redraws on pan),
 * not a missed optimization.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { decimalsFor } from '../utils/geometry.js';
import { visibleOnPanel } from '../drawing/model.js';
import { renderDrawing, drawSelectionHandles } from '../drawing/render.js';
import { replayCutoffEpoch } from './replayManager.js';
import { MTF_DASHBOARD_TFS } from '../core/constants.js';

const DASHBOARD_PANEL_KEYS = new Set(MTF_DASHBOARD_TFS.map(tf => tf.key));

// ── Dirty-flag + rAF scheduler ──────────────────────────────────────────
// Keyed dynamically by whatever panels are actually registered — works
// correctly whether that's the original 2 (htf/ltf) or the new 10-panel
// MTF Dashboard, with no special-casing. A key simply starts undefined
// (falsy, same as `false`) until something marks it dirty.
const bgDirty = {};
const ovDirty = {};
let rafHandle = null;

function scheduleFrame() {
  if (rafHandle != null) return; // a frame is already pending — coalesce
  rafHandle = requestAnimationFrame(runFrame);
}

function runFrame() {
  rafHandle = null;
  for (const key of Object.keys(AppState.timeframePanels)) {
    const panel = AppState.timeframePanels[key];
    if (!panel) continue;
    if (bgDirty[key]) { paintBackground(panel); bgDirty[key] = false; }
    if (ovDirty[key]) { paintOverlay(panel); ovDirty[key] = false; }
  }
  eventBus.emit('render:complete');
}

/** Mark a panel's background layer (or every registered panel, if no key given) for repaint on the next frame. */
export function invalidateBackground(panelKey) {
  if (panelKey) bgDirty[panelKey] = true;
  else { for (const k of Object.keys(AppState.timeframePanels)) bgDirty[k] = true; }
  scheduleFrame();
}

/** Mark a panel's overlay layer (or every registered panel) for repaint on the next frame. */
export function invalidateOverlay(panelKey) {
  if (panelKey) ovDirty[panelKey] = true;
  else { for (const k of Object.keys(AppState.timeframePanels)) ovDirty[k] = true; }
  scheduleFrame();
}

/** Invalidate both layers on both panels. Fine for infrequent, discrete actions (button clicks, symbol switch) — not for anything firing on mousemove. */
export function drawAll() {
  invalidateBackground();
  invalidateOverlay();
}

// renderDrawing()/drawSelectionHandles() (drawing/render.js) read `panel.ctx`.
// Phase 2 gives Panel two contexts (bgCtx/ovCtx) instead of one, so these
// thin per-panel view objects pick which context "panel.ctx" resolves to for
// a given call, without changing drawing/render.js's signature at all.
function withBgCtx(panel) {
  if (!panel._bgView) panel._bgView = Object.create(panel);
  panel._bgView.ctx = panel.bgCtx;
  return panel._bgView;
}
function withOvCtx(panel) {
  if (!panel._ovView) panel._ovView = Object.create(panel);
  panel._ovView.ctx = panel.ovCtx;
  return panel._ovView;
}

// ── Background layer ─────────────────────────────────────────────────
function paintBackground(panel) {
  const ctx = panel.bgCtx;
  ctx.clearRect(0, 0, panel.W, panel.H);
  drawGrid(panel);
  if (panel.isTick()) drawTickLine(panel);
  else drawCandles(panel);

  const excludeId = AppState.draggingDrawingId;
  const view = withBgCtx(panel);
  AppState.drawings
    .filter(d => d.id !== excludeId && visibleOnPanel(d, panel))
    .forEach(d => renderDrawing(view, d));
}

function drawGrid(panel) {
  const ctx = panel.bgCtx;
  ctx.strokeStyle = "#141c2c"; ctx.lineWidth = 1;
  const { p0, p1 } = panel.currentPriceRange();
  const dec = decimalsFor(p1);
  ctx.font = "9.5px IBM Plex Mono, monospace";
  // MTF Dashboard rows: horizontal price gridlines only, no vertical time
  // gridlines and no date/time labels on the x-axis — "clean candlestick
  // data exactly as they appear on Deriv," per the spec, not a full
  // technical chart. This is keyed to WHICH panel this is, not to its
  // pixel height, deliberately: an earlier version used panel.H < 100 as
  // the signal, which would have silently stopped applying the moment the
  // dashboard rows got taller for legibility — a real bug avoided by
  // asking "is this a dashboard panel" instead of "is this short."
  const isDashboardPanel = DASHBOARD_PANEL_KEYS.has(panel.side);
  const hDivisions = isDashboardPanel ? 3 : 4;
  for (let i = 0; i <= hDivisions; i++) {
    const p = p1 - (p1 - p0) * i / hDivisions;
    const y = panel.priceToY(p);
    ctx.beginPath(); ctx.moveTo(panel.padL, y); ctx.lineTo(panel.W - panel.padR, y); ctx.stroke();
    ctx.fillStyle = "#5c6b82"; ctx.fillText(p.toFixed(dec), panel.W - panel.padR + 5, y + 3);
  }
  if (isDashboardPanel) return;
  for (let i = 0; i <= 4; i++) {
    const t = panel.viewT0 + (panel.viewT1 - panel.viewT0) * i / 4;
    const x = panel.timeToX(t);
    ctx.beginPath(); ctx.moveTo(x, panel.padT); ctx.lineTo(x, panel.H - panel.padB); ctx.stroke();
    const d = new Date(t * 1000);
    const lbl = panel.granSeconds() >= 3600 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour12: false });
    ctx.fillStyle = "#5c6b82"; ctx.fillText(lbl, x - 20, panel.H - 8);
  }
}

function drawCandles(panel) {
  const ctx = panel.bgCtx;
  const cutoff = replayCutoffEpoch();
  const vis = panel.candles.filter(c =>
    c.epoch + panel.granSeconds() >= panel.viewT0 && c.epoch <= panel.viewT1 &&
    (cutoff === null || c.epoch < cutoff));
  if (!vis.length) return;
  const bw = Math.max(1.5, Math.min(panel.plotW / Math.max(vis.length, 1) * 0.66, 16));
  vis.forEach(c => {
    const x = panel.timeToX(c.epoch + panel.granSeconds() / 2);
    const bull = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = bull ? "#1fdf9b" : "#ff4d6a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, panel.priceToY(c.high)); ctx.lineTo(x, panel.priceToY(c.low)); ctx.stroke();
    const yT = panel.priceToY(Math.max(c.open, c.close)), yB = panel.priceToY(Math.min(c.open, c.close));
    const bodyPx = yB - yT;
    if (bodyPx < 2) {
      // Near-flat (doji-like) candle: a real candlestick chart draws this as
      // a horizontal cross spanning the candle's full width at the open/
      // close level, not an invisible sliver forced to 1px — that's the
      // difference between "you can tell this candle showed indecision at
      // a glance" and "you can't see it happened at all."
      const yMid = (yT + yB) / 2;
      ctx.beginPath(); ctx.moveTo(x - bw / 2, yMid); ctx.lineTo(x + bw / 2, yMid); ctx.stroke();
    } else {
      ctx.fillRect(x - bw / 2, yT, bw, bodyPx);
    }
    c._x = x; c._bw = bw; // cached for interaction.js hit-testing
  });
}

function drawTickLine(panel) {
  const ctx = panel.bgCtx;
  const cutoff = replayCutoffEpoch();
  const vis = panel.ticks.filter(t => t.epoch >= panel.viewT0 && t.epoch <= panel.viewT1 && (cutoff === null || t.epoch < cutoff));
  if (vis.length < 2) return;
  ctx.strokeStyle = "#4fb2ff"; ctx.lineWidth = 1.6; ctx.beginPath();
  vis.forEach((t, i) => {
    const x = panel.timeToX(t.epoch), y = panel.priceToY(t.price);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ── Overlay layer ────────────────────────────────────────────────────
function paintOverlay(panel) {
  const ctx = panel.ovCtx;
  ctx.clearRect(0, 0, panel.W, panel.H);

  // The object being actively created (not yet committed) or actively
  // dragged (already committed, but excluded from the background above)
  // both render here, on top of the (untouched) background.
  const draft = AppState.draft;
  if (draft) renderDrawing(withOvCtx(panel), draft, true);

  const draggingId = AppState.draggingDrawingId;
  if (draggingId) {
    const live = AppState.getDrawing(draggingId);
    if (live && visibleOnPanel(live, panel)) renderDrawing(withOvCtx(panel), live);
  }

  drawCrosshair(panel);

  const selected = AppState.selectedDrawing;
  if (selected && visibleOnPanel(selected, panel)) drawSelectionHandles(withOvCtx(panel), selected);

  drawPriceTag(panel);
  drawProgressIndicator(panel);
}

/** Live price tag anchored at the right edge of the plot, at the last price's actual y-position (not a fixed grid interval) — colored by the last candle's direction, matching how real trading platforms flag "this is where price is right now." */
function drawPriceTag(panel) {
  const ctx = panel.ovCtx;
  const isTickMode = panel.isTick();
  const last = isTickMode ? panel.ticks[panel.ticks.length - 1] : panel.candles[panel.candles.length - 1];
  if (!last) return;
  const price = isTickMode ? last.price : last.close;
  if (price == null || Number.isNaN(price)) return;

  const dec = decimalsFor(price);
  const label = price.toFixed(dec);
  const bull = isTickMode ? null : last.close >= last.open;
  const color = bull === null ? "#56b6ff" : (bull ? "#1fdf9b" : "#ff4d6a");

  ctx.font = "10px IBM Plex Mono, monospace";
  const textW = ctx.measureText(label).width;
  const padX = 5, tagH = 15;
  const tagW = textW + padX * 2;
  const x = panel.W - panel.padR;
  const rawY = panel.priceToY(price);
  // Clamp so the tag never renders half off-screen at the top/bottom edge
  // of the plot area — it should always be fully visible even when the
  // last price sits right at the edge of the current view.
  const y = Math.max(panel.padT + tagH / 2, Math.min(panel.H - panel.padB - tagH / 2, rawY));

  ctx.fillStyle = color;
  ctx.fillRect(x, y - tagH / 2, tagW, tagH);
  ctx.fillStyle = "#0a0e17";
  ctx.fillText(label, x + padX, y + 3.5);
}

function formatRemaining(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s left`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (sec < 3600) return `${m}m ${s}s left`;
  const h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60);
  return `${h}h ${mm}m left`;
}

/**
 * Progress indicator for the currently-forming (incomplete) candle,
 * adapted to the candle type:
 *   - tick10 candles: "N / 10 ticks" from the forming candle's own _n count
 *     (already tracked by charts/socket.js's tick10 aggregation).
 *   - Time-based candles (every MTF Dashboard timeframe, and the HTF
 *     panel): time remaining until this candle closes, computed from the
 *     wall clock against the candle's own epoch + granularity — not a
 *     one-shot value, since it needs to keep counting down even with no
 *     new data arriving. See the setInterval in initRenderLoop() below,
 *     which re-invalidates the overlay every second specifically so this
 *     keeps ticking.
 *   - Plain tick1 (line) mode: no discrete candle exists, so no progress
 *     indicator applies — there's nothing to show progress "of".
 */
function drawProgressIndicator(panel) {
  const ctx = panel.ovCtx;
  let label = null;

  if (panel.tf.g === "tick10") {
    const last = panel.candles[panel.candles.length - 1];
    if (last && last._n != null && last._n < 10) label = `${last._n} / 10 ticks`;
  } else if (!panel.isTick()) {
    const last = panel.candles[panel.candles.length - 1];
    if (last) {
      const gran = panel.granSeconds();
      const closesAt = last.epoch + gran;
      const remaining = closesAt - Date.now() / 1000;
      if (remaining > 0 && remaining < gran) label = formatRemaining(remaining);
    }
  }
  if (!label) return;

  ctx.font = "9px IBM Plex Mono, monospace";
  const textW = ctx.measureText(label).width;
  const x = panel.W - panel.padR - textW - 4;
  const y = panel.padT + 10;
  ctx.fillStyle = "rgba(10,14,23,.78)";
  ctx.fillRect(x - 4, y - 10, textW + 8, 14);
  ctx.fillStyle = "#9aa7bd";
  ctx.fillText(label, x, y);
}

function drawCrosshair(panel) {
  const crosshair = AppState.crosshair;
  if (!crosshair) return;
  const ctx = panel.ovCtx;
  const x = panel.timeToX(crosshair.t);
  if (x < panel.padL || x > panel.W - panel.padR) return;
  ctx.save();
  ctx.strokeStyle = "rgba(79,178,255,.55)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, panel.padT); ctx.lineTo(x, panel.H - panel.padB); ctx.stroke();
  if (crosshair.source === panel.id && crosshair.p != null) {
    const y = panel.priceToY(crosshair.p);
    ctx.beginPath(); ctx.moveTo(panel.padL, y); ctx.lineTo(panel.W - panel.padR, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#0a0e17"; ctx.fillRect(panel.W - panel.padR, y - 9, panel.padR - 2, 18);
    ctx.fillStyle = "#4fb2ff"; ctx.font = "10px IBM Plex Mono";
    ctx.fillText(crosshair.p.toFixed(decimalsFor(crosshair.p)), panel.W - panel.padR + 4, y + 3);
  }
  ctx.restore();
}

/** Wire the scheduler to fire on every state change that visibly affects a chart. Call once at boot. */
export function initRenderLoop() {
  // Background: only data/view/drawing-set changes.
  eventBus.on('panel:dataUpdated', ({ panel }) => invalidateBackground(panel.side));
  eventBus.on('panel:resized', ({ panel }) => { invalidateBackground(panel.side); invalidateOverlay(panel.side); });
  eventBus.on('drawings:changed', () => invalidateBackground());

  // Overlay: crosshair and selection are cheap and change constantly.
  eventBus.on('crosshair:changed', () => invalidateOverlay());
  eventBus.on('selection:changed', () => invalidateOverlay());
  eventBus.on('replay:changed', () => invalidateBackground());

  // The progress indicator's "time remaining" text needs to count down
  // even when no new candle/tick data has arrived — a quiet 12h or 8h
  // panel could otherwise go long stretches with no repaint trigger at
  // all, leaving a stale countdown on screen. This is deliberately on the
  // overlay (cheap: crosshair + selection + one or two small text draws),
  // not the background, so a once-a-second tick across every panel stays
  // negligible.
  setInterval(() => invalidateOverlay(), 1000);
}
