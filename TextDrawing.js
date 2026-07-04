/**
 * drawing/interaction.js
 *
 * All mouse-driven drawing interaction: creating new drawings, hit-testing,
 * selecting, moving, resizing, panning, and zooming. Subscribes to the
 * "canvas:*" events Panel.js emits — this module never touches a canvas
 * element's addEventListener directly, which is what keeps charts/ fully
 * decoupled from drawing/.
 *
 * Phase 3 change: hit-testing and move/resize no longer switch on d.type —
 * they call d.hitTest()/d.move()/d.resize()/d.getHandles() polymorphically.
 * One consequence worth flagging: the OLD move-drag snapshotted the
 * pre-drag object via JSON.parse(JSON.stringify(obj)) and computed each
 * frame as "orig + total delta from drag start". That approach would
 * silently break now — JSON round-tripping a class instance strips its
 * prototype, so the snapshot would lose every method. Move-drag now tracks
 * the last mouse position and applies an INCREMENTAL delta each tick
 * (obj.move(t - lastT, p - lastP)) directly on the real instance instead,
 * which sidesteps the problem entirely and is arguably simpler besides.
 *
 * Redraw ordering note (unchanged from Phase 2): mutate first, set the
 * crosshair last — its change event is what triggers the overlay repaint,
 * so it must fire after this tick's mutation or the paint shows one frame
 * stale.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { HANDLE_R } from '../core/constants.js';
import { makeDrawing, visibleOnPanel } from './model.js';
import { drawAll, invalidateBackground, invalidateOverlay } from '../charts/render.js';
import { zoomLtfToDrawing } from '../charts/zoomManager.js';
import { decomposeCandle, openCandleMenu } from './candleMarking.js';
import { replayCutoffEpoch } from '../charts/replayManager.js';
import { historyManager } from '../core/HistoryManager.js';
import { CreateDrawingCommand, GeometryChangeCommand } from '../core/commands/DrawingCommands.js';

/** Small before/after geometry capture for history — {t1,p1,t2,p2[,points]}. */
function snapshotGeometry(obj) {
  const s = { t1: obj.t1, p1: obj.p1, t2: obj.t2, p2: obj.p2 };
  if (obj.points) s.points = obj.points.map(pt => ({ ...pt }));
  return s;
}

function mousePos(panel, e) {
  const r = panel.ovCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function snapPrice(panel, t, p) {
  if (!AppState.snapEnabled || panel.isTick()) return p;
  const gran = panel.granSeconds();
  const c = panel.candles.find(c => Math.abs((c.epoch + gran / 2) - t) < gran);
  if (!c) return p;
  return Math.abs(p - c.high) < Math.abs(p - c.low) ? c.high : c.low;
}

function hitTestPanel(panel, mx, my) {
  const sel = AppState.selectedDrawing;
  if (sel && visibleOnPanel(sel, panel)) {
    for (const h of sel.getHandles(panel)) {
      if (Math.hypot(mx - h.x, my - h.y) <= HANDLE_R + 3) return { obj: sel, handle: h.h };
    }
  }
  const list = AppState.drawings.filter(d => visibleOnPanel(d, panel)).slice().reverse();
  for (const d of list) {
    if (d.hitTest(panel, mx, my)) return { obj: d, handle: null };
  }
  return null;
}

function onCanvasDown({ panel, event: e }) {
  const { x, y } = mousePos(panel, e);
  const t = panel.xToTime(x), p = panel.yToPrice(y);

  if (AppState.activeTool !== "select") {
    if (AppState.activeTool === "brush") {
      AppState.setDraft(makeDrawing("brush", t, p, t, p, { points: [{ t, p }], _fromPanel: panel.side }));
      AppState.setDrag({ mode: "brush", panel });
      return;
    }
    const sp = snapPrice(panel, t, p);
    const extra = { _fromPanel: panel.side };
    // Phase 10: a zone preset (Supply/Demand/FVG/etc) only applies to
    // rectangles — the tool it arms is always "rect" (see ui/zonePresets.js),
    // but guard on both tool and preset presence in case that ever changes.
    if (AppState.activeTool === "rect" && AppState.pendingPreset) {
      const preset = AppState.pendingPreset;
      extra.zoneType = preset.zoneType;
      extra.color = preset.color;
      extra.label = preset.label;
    }
    AppState.setDraft(makeDrawing(AppState.activeTool, t, sp, t, sp, extra));
    AppState.setDrag({ mode: "draft", panel, startT: t, startP: sp });
    return;
  }

  const hit = hitTestPanel(panel, x, y);
  if (hit) {
    const isNewSelection = AppState.selectedId !== hit.obj.id;
    if (hit.obj.locked && hit.handle) {
      AppState.setSelectedId(hit.obj.id);
      if (isNewSelection && panel.side === "htf") zoomLtfToDrawing(hit.obj); // Phase 7 — no drag possible on a locked handle, so this IS the final action
      return;
    }
    AppState.setSelectedId(hit.obj.id);
    if (!hit.obj.locked) {
      if (hit.handle) {
        AppState.setDrag({ mode: "resize", panel, obj: hit.obj, handle: hit.handle, before: snapshotGeometry(hit.obj), isNewSelection });
      } else {
        // Incremental delta tracking — see file header for why this replaced
        // the old JSON-clone-based "orig" snapshot. `before` here is for
        // history only (Phase 4) — the drag itself doesn't use it.
        AppState.setDrag({ mode: "move", panel, obj: hit.obj, lastT: t, lastP: p, before: snapshotGeometry(hit.obj), isNewSelection });
      }
      // The object is about to be excluded from the background paint (see
      // charts/render.js's draggingDrawingId check) and shown on the overlay
      // instead — this is the one-time background repaint that removes it.
      invalidateBackground(panel.side);
      invalidateOverlay(panel.side);
    } else if (isNewSelection && panel.side === "htf") {
      zoomLtfToDrawing(hit.obj); // locked object, clicked its body (not a handle) — also no drag possible
    }
    return;
  }
  AppState.setSelectedId(null);
  AppState.setDrag({
    mode: "pan", panel, startX: x, startY: y, startT0: panel.viewT0, startT1: panel.viewT1,
    startPriceLock: panel.priceLock, startRange: panel.currentPriceRange(),
  });
}

function onCanvasMove({ panel, event: e }) {
  const { x, y } = mousePos(panel, e);
  const t = panel.xToTime(x), p = panel.yToPrice(y);
  const drag = AppState.drag, draft = AppState.draft;

  if (drag) {
    if (drag.mode === "draft" && draft) {
      const sp = snapPrice(panel, t, p);
      draft.t2 = t; draft.p2 = sp;
      if (draft.type === "hline") draft.p1 = sp;
      if (draft.type === "vline") draft.t1 = t;
      invalidateOverlay(panel.side); // draft never touches the background layer
    } else if (drag.mode === "brush" && draft) {
      draft.addPoint(t, p);
      invalidateOverlay(panel.side);
    } else if (drag.mode === "resize") {
      drag.obj.resize(drag.handle, t, p);
      invalidateOverlay(panel.side); // object already excluded from background since drag start
    } else if (drag.mode === "move") {
      drag.obj.move(t - drag.lastT, p - drag.lastP);
      drag.lastT = t; drag.lastP = p;
      invalidateOverlay(panel.side);
    } else if (drag.mode === "pan") {
      const dxFrac = (x - drag.startX) / panel.plotW;
      const span = drag.startT1 - drag.startT0;
      panel.viewT0 = drag.startT0 - dxFrac * span;
      panel.viewT1 = drag.startT1 - dxFrac * span;
      if (e.shiftKey || drag.panMode === "price") {
        const pr = drag.startRange;
        const dyFrac = (y - drag.startY) / panel.plotH;
        const pspan = pr.p1 - pr.p0;
        panel.priceLock = { p0: pr.p0 + dyFrac * pspan, p1: pr.p1 + dyFrac * pspan };
      }
      // Panning shifts every screen coordinate — grid, candles, and every
      // drawing's position all change, so the background genuinely needs a
      // full repaint here. This is the one interaction that can't avoid it.
      invalidateBackground(panel.side);
      invalidateOverlay(panel.side);
    }
  }

  AppState.setCrosshair({ t, p, source: panel.id });
}

function onCanvasUp() {
  const drag = AppState.drag, draft = AppState.draft;

  if (drag && (drag.mode === "move" || drag.mode === "resize")) {
    const after = snapshotGeometry(drag.obj);
    const panel = drag.panel;
    // Pixel-distance threshold, not exact geometric equality — a slightly
    // shaky click can produce a sub-pixel geometric delta that shouldn't
    // count as a real drag (would otherwise push a spurious near-zero
    // history entry AND suppress the Phase 7 auto-zoom below). Checked
    // across BOTH anchor points — a resize on the br/tr handle only moves
    // t2/p2, so checking t1/p1 alone would misreport a real resize as "no
    // movement".
    const dist = (ax, ay, bx, by) => Math.hypot(panel.timeToX(ax) - panel.timeToX(bx), panel.priceToY(ay) - panel.priceToY(by));
    const movedPx = Math.max(
      dist(after.t1, after.p1, drag.before.t1, drag.before.p1),
      dist(after.t2, after.p2, drag.before.t2, drag.before.p2)
    );
    const wasRealDrag = movedPx >= 4 || JSON.stringify(after.points) !== JSON.stringify(drag.before.points);

    if (wasRealDrag) {
      historyManager.record(new GeometryChangeCommand(drag.obj.id, drag.before, after, drag.obj.type));
    } else if (drag.isNewSelection && panel.side === "htf") {
      // Phase 7: this mousedown->mouseup was a plain click (no real drag),
      // and it selected something new on the HTF chart — auto-zoom the LTF.
      // Deferred here (rather than at mousedown) specifically so starting a
      // genuine drag never gets interrupted by a mid-drag re-zoom.
      zoomLtfToDrawing(drag.obj);
    }
  }

  if (drag && (drag.mode === "draft" || drag.mode === "brush") && draft) {
    const panel = drag.panel;
    const tiny = draft.type !== "brush" &&
      Math.hypot(panel.timeToX(draft.t2) - panel.timeToX(draft.t1), panel.priceToY(draft.p2) - panel.priceToY(draft.p1)) < 4;

    if (!tiny && typeof draft.computeLabel === "function") {
      draft.computeLabel(panel.granSeconds()); // MeasurementDrawing only — duck-typed, no import needed
    }
    if (draft.type === "text") {
      const txt = prompt("Label text:", "Note");
      if (txt === null) { AppState.setDraft(null); AppState.setDrag(null); drawAll(); return; }
      draft.label = txt || "Note";
    }
    if (!tiny || ["hline", "vline", "text", "brush"].includes(draft.type)) {
      historyManager.execute(new CreateDrawingCommand(draft)); // performs AppState.addDrawing + selects it
    }
    AppState.setDraft(null);
    if (!AppState.lockTool) eventBus.emit('tool:requestSelect');
  }
  AppState.setDrag(null);
  drawAll();
}

function onCanvasWheel({ panel, event: e }) {
  e.preventDefault();
  const { x, y } = mousePos(panel, e);
  if (e.shiftKey) {
    const pr = panel.currentPriceRange();
    const anchor = panel.yToPrice(y);
    const factor = e.deltaY < 0 ? 0.85 : 1.18;
    panel.priceLock = { p0: anchor - (anchor - pr.p0) * factor, p1: anchor + (pr.p1 - anchor) * factor };
  } else {
    const anchorT = panel.xToTime(x);
    const factor = e.deltaY < 0 ? 0.85 : 1.18;
    panel.viewT0 = anchorT - (anchorT - panel.viewT0) * factor;
    panel.viewT1 = anchorT + (panel.viewT1 - anchorT) * factor;
  }
  drawAll();
}

function onCanvasDblClick({ panel, event: e }) {
  if (panel.side !== "htf" || panel.isTick()) return;
  const { x } = mousePos(panel, e);
  const t = panel.xToTime(x);
  const c = panel.candles.find(c => t >= c.epoch && t <= c.epoch + panel.granSeconds());
  if (!c) return;
  const cutoff = replayCutoffEpoch();
  if (cutoff !== null && c.epoch >= cutoff) return; // hidden by replay — don't act on a candle the user can't actually see
  decomposeCandle(c, panel.granSeconds());
  drawAll();
}

function onCanvasContext({ panel, event: e }) {
  e.preventDefault();
  if (panel.isTick()) return;
  const { x } = mousePos(panel, e);
  const t = panel.xToTime(x);
  const c = panel.candles.find(c => t >= c.epoch && t <= c.epoch + panel.granSeconds());
  if (!c) return;
  const cutoff = replayCutoffEpoch();
  if (cutoff !== null && c.epoch >= cutoff) return; // hidden by replay
  openCandleMenu(panel, c, e.clientX, e.clientY);
}

function onCanvasMouseLeave() {
  AppState.setCrosshair(null);
}

/** Wire every canvas interaction handler. Call once at boot. */
export function initInteraction() {
  eventBus.on('canvas:mousedown', onCanvasDown);
  eventBus.on('canvas:mousemove', onCanvasMove);
  eventBus.on('canvas:mouseup', onCanvasUp);
  eventBus.on('canvas:wheel', onCanvasWheel);
  eventBus.on('canvas:dblclick', onCanvasDblClick);
  eventBus.on('canvas:contextmenu', onCanvasContext);
  eventBus.on('canvas:mouseleave', onCanvasMouseLeave);
}
