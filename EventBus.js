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

// ── Dirty-flag + rAF scheduler ──────────────────────────────────────────
const bgDirty = { htf: false, ltf: false };
const ovDirty = { htf: false, ltf: false };
let rafHandle = null;

function scheduleFrame() {
  if (rafHandle != null) return; // a frame is already pending — coalesce
  rafHandle = requestAnimationFrame(runFrame);
}

function runFrame() {
  rafHandle = null;
  for (const key of ['htf', 'ltf']) {
    const panel = AppState.panels[key];
    if (!panel) continue;
    if (bgDirty[key]) { paintBackground(panel); bgDirty[key] = false; }
    if (ovDirty[key]) { paintOverlay(panel); ovDirty[key] = false; }
  }
  eventBus.emit('render:complete');
}

/** Mark a panel's background layer (or both, if no key given) for repaint on the next frame. */
export function invalidateBackground(panelKey) {
  if (panelKey) bgDirty[panelKey] = true;
  else { bgDirty.htf = true; bgDirty.ltf = true; }
  scheduleFrame();
}

/** Mark a panel's overlay layer (or both) for repaint on the next frame. */
export function invalidateOverlay(panelKey) {
  if (panelKey) ovDirty[panelKey] = true;
  else { ovDirty.htf = true; ovDirty.ltf = true; }
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
  for (let i = 0; i <= 4; i++) {
    const p = p1 - (p1 - p0) * i / 4;
    const y = panel.priceToY(p);
    ctx.beginPath(); ctx.moveTo(panel.padL, y); ctx.lineTo(panel.W - panel.padR, y); ctx.stroke();
    ctx.fillStyle = "#5c6b82"; ctx.fillText(p.toFixed(dec), panel.W - panel.padR + 5, y + 3);
  }
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
    ctx.fillRect(x - bw / 2, yT, bw, Math.max(1, yB - yT));
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
}
