/**
 * ui/propertiesPanel.js
 *
 * The right-hand panel for editing whichever drawing is currently selected.
 * Re-renders on "selection:changed", "symbol:changed", and (Phase 4)
 * "history:changed" — the last one is what keeps the panel in sync after
 * an undo/redo changes the selected drawing's properties, without needing
 * it to also listen on "drawings:changed" directly (which fires on every
 * keystroke while typing a label — subscribing to that would blow away the
 * input's focus/cursor position mid-edit via the innerHTML rebuild).
 *
 * History granularity (Phase 4): sliders and text fields apply live on
 * every 'input' event (unchanged UX), but commit exactly ONE history entry
 * on 'change' (fires once — slider released, or field blurred), capturing
 * the value from the FIRST 'input' since the last commit as "before".
 * Discrete controls (color swatch, checkboxes, selects) commit immediately
 * on click/change, since each one is already a single atomic action.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $, escapeHtml } from '../utils/dom.js';
import { decimalsFor } from '../utils/geometry.js';
import { COLORS, ZONE_TYPES, ZONE_STATUSES, IMPORTANCE_LEVELS } from '../core/constants.js';
import { typeIcon } from '../drawing/model.js';
import { selectAndZoom } from './drawingManager.js';
import { drawAll } from '../charts/render.js';
import { historyManager } from '../core/HistoryManager.js';
import { CreateDrawingCommand, DeleteDrawingCommand, PropertyChangeCommand } from '../core/commands/DrawingCommands.js';

function fmtCoord(d) {
  if (d.type === "hline") return `Price ${d.p1.toFixed(decimalsFor(d.p1))}`;
  if (d.type === "vline") return `Time ${new Date(d.t1 * 1000).toLocaleString([], { hour12: false })}`;
  if (d.type === "brush") return `${d.points?.length || 0} points`;
  return `${new Date(d.t1 * 1000).toLocaleString([], { hour12: false })} → ${new Date(d.t2 * 1000).toLocaleString([], { hour12: false })}`;
}

export function renderProps() {
  const body = $("mtfPropsBody");
  if (!body) return;
  const d = AppState.selectedDrawing;
  if (!d) {
    body.innerHTML = `<div class="props-empty">Select a drawing (click it on a chart or in the Drawing Manager) to edit its label, color, opacity, thickness, scope, lock state and notes.<br><br>Or pick a tool above and draw directly on either chart — every object is stored by real price &amp; time, so it appears correctly positioned on both panels automatically.</div>`;
    return;
  }
  const showExtend = d.type === "trend";
  const showLineStyle = ["rect", "hline", "vline", "trend", "ray", "arrow", "circle"].includes(d.type);
  const showZoneType = d.type === "rect"; // zoneType/projection are area concepts — a zone, not a line/text
  body.innerHTML = `
    <div class="type-badge">${typeIcon(d.type)} ${d.type.toUpperCase()}${d.wickPart ? " · " + d.wickPart : ""}</div>
    ${showZoneType ? `
    <div class="pf"><label>Zone type</label>
      <select id="mtfPZoneType">
        <option value="" ${!d.zoneType ? 'selected' : ''}>— none —</option>
        ${ZONE_TYPES.map(z => `<option value="${z.key}" ${d.zoneType === z.key ? 'selected' : ''}>${z.label}</option>`).join("")}
      </select></div>` : ""}
    <div class="pf"><label>Status</label>
      <select id="mtfPStatus">
        ${ZONE_STATUSES.map(s => `<option value="${s.key}" ${d.status === s.key ? 'selected' : ''}>${s.label}</option>`).join("")}
      </select></div>
    <div class="pf row2">
      <div><label>Importance</label>
        <select id="mtfPImportance">
          ${IMPORTANCE_LEVELS.map(i => `<option value="${i.key}" ${d.importance === i.key ? 'selected' : ''}>${i.label}</option>`).join("")}
        </select></div>
      <div><label>Priority (1 highest – 5 lowest)</label>
        <input type="number" id="mtfPPriority" min="1" max="5" step="1" value="${d.priority}"></div>
    </div>
    ${showZoneType ? `
      <div class="pf-toggle"><span class="lbl">Project forward</span><label class="switch"><input type="checkbox" id="mtfPProjection" ${d.projection ? 'checked' : ''}><span class="trk"></span></label></div>
    ` : ""}
    <div class="pf"><label>Label</label><input type="text" id="mtfPLabel" value="${escapeHtml(d.label)}"></div>
    <div class="pf"><label>Color</label>
      <div class="swatches" id="mtfPColors">${COLORS.map(c => `<div class="sw-btn ${c === d.color ? 'sel' : ''}" style="background:${c}" data-c="${c}"></div>`).join("")}</div>
    </div>
    <div class="pf"><label>Opacity — <span id="mtfPOpVal">${Math.round(d.opacity * 100)}%</span></label>
      <input type="range" id="mtfPOpacity" min="10" max="100" value="${Math.round(d.opacity * 100)}"></div>
    <div class="pf"><label>Border / line width — <span id="mtfPBwVal">${d.borderWidth}px</span></label>
      <input type="range" id="mtfPBorderW" min="1" max="6" value="${d.borderWidth}"></div>
    ${showLineStyle ? `<div class="pf"><label>Line style</label>
      <select id="mtfPLineStyle">
        <option value="solid" ${d.lineStyle === 'solid' ? 'selected' : ''}>Solid</option>
        <option value="dashed" ${d.lineStyle === 'dashed' ? 'selected' : ''}>Dashed</option>
        <option value="dotted" ${d.lineStyle === 'dotted' ? 'selected' : ''}>Dotted</option>
      </select></div>` : ""}
    ${showExtend ? `
      <div class="pf-toggle"><span class="lbl">Extend left</span><label class="switch"><input type="checkbox" id="mtfPExtL" ${d.extendLeft ? 'checked' : ''}><span class="trk"></span></label></div>
      <div class="pf-toggle"><span class="lbl">Extend right</span><label class="switch"><input type="checkbox" id="mtfPExtR" ${d.extendRight ? 'checked' : ''}><span class="trk"></span></label></div>
    ` : ""}
    <div class="pf"><label>Visible on</label>
      <select id="mtfPScope">
        <option value="all" ${d.scope === 'all' ? 'selected' : ''}>All timeframes</option>
        <option value="current" ${d.scope === 'current' ? 'selected' : ''}>Current timeframe only (${d.createdTF.toUpperCase()})</option>
      </select></div>
    <div class="pf-toggle"><span class="lbl">Locked</span><label class="switch"><input type="checkbox" id="mtfPLocked" ${d.locked ? 'checked' : ''}><span class="trk"></span></label></div>
    <div class="pf-toggle"><span class="lbl">Visible</span><label class="switch"><input type="checkbox" id="mtfPVisible" ${d.visible ? 'checked' : ''}><span class="trk"></span></label></div>
    <div class="pf"><label>Notes</label><textarea id="mtfPNotes" placeholder="Optional notes…">${escapeHtml(d.notes || "")}</textarea></div>
    <div class="pf" style="font-size:9.5px;color:var(--muted);line-height:1.7">
      Symbol ${d.symbol} · Created on ${d.createdTF.toUpperCase()}<br>
      ${fmtCoord(d)}
    </div>
    <div class="pf-btns">
      <button class="pf-btn" onclick="mtfDuplicateSelected()">⧉ Duplicate</button>
      <button class="pf-btn danger" onclick="mtfDeleteSelected()">🗑 Delete</button>
      <button class="pf-btn wide" onclick="mtfSelectAndZoom('${d.id}')">🔍 Zoom both charts here</button>
    </div>
  `;
  bindPropsEvents(d);
}

let currentDrawingId = null;

/** Wire a continuous field (slider/text): live-apply on 'input', commit ONE history entry on 'change'. */
function bindContinuous(el, applyLive, snapshotKey, snapshotFn) {
  let before = null;
  el.oninput = e => {
    if (before === null) before = { [snapshotKey]: snapshotFn() };
    applyLive(e);
    save();
    drawAll();
  };
  el.onchange = () => {
    if (before) {
      historyManager.record(new PropertyChangeCommand(currentDrawingId, before, { [snapshotKey]: snapshotFn() }, snapshotKey));
      before = null;
    }
  };
}

/** Wire a discrete control (checkbox/select/swatch): one history entry per interaction, applied through the Command itself. */
function bindDiscrete(el, eventName, buildAfter, snapshotKey, snapshotBefore) {
  el[eventName === 'click' ? 'onclick' : 'onchange'] = e => {
    const before = { [snapshotKey]: snapshotBefore() };
    historyManager.execute(new PropertyChangeCommand(currentDrawingId, before, buildAfter(e), snapshotKey));
  };
}

function bindPropsEvents(d) {
  currentDrawingId = d.id;

  if ($("mtfPZoneType")) bindDiscrete($("mtfPZoneType"), 'change', e => ({ zoneType: e.target.value || null }), 'zoneType', () => d.zoneType);
  bindDiscrete($("mtfPStatus"), 'change', e => ({ status: e.target.value }), 'status', () => d.status);
  bindDiscrete($("mtfPImportance"), 'change', e => ({ importance: e.target.value }), 'importance', () => d.importance);
  bindContinuous($("mtfPPriority"),
    e => { d.priority = Math.max(1, Math.min(5, +e.target.value || 3)); },
    'priority', () => d.priority);
  if ($("mtfPProjection")) bindDiscrete($("mtfPProjection"), 'change', e => ({ projection: e.target.checked }), 'projection', () => d.projection);

  bindContinuous($("mtfPLabel"), e => { d.label = e.target.value; }, 'label', () => d.label);

  document.querySelectorAll("#mtfPColors .sw-btn").forEach(el => {
    bindDiscrete(el, 'click', () => ({ color: el.dataset.c }), 'color', () => d.color);
  });

  bindContinuous($("mtfPOpacity"),
    e => { d.opacity = +e.target.value / 100; $("mtfPOpVal").textContent = e.target.value + "%"; },
    'opacity', () => d.opacity);

  bindContinuous($("mtfPBorderW"),
    e => { d.borderWidth = +e.target.value; $("mtfPBwVal").textContent = e.target.value + "px"; },
    'borderWidth', () => d.borderWidth);

  if ($("mtfPLineStyle")) bindDiscrete($("mtfPLineStyle"), 'change', e => ({ lineStyle: e.target.value }), 'lineStyle', () => d.lineStyle);
  if ($("mtfPExtL")) bindDiscrete($("mtfPExtL"), 'change', e => ({ extendLeft: e.target.checked }), 'extendLeft', () => d.extendLeft);
  if ($("mtfPExtR")) bindDiscrete($("mtfPExtR"), 'change', e => ({ extendRight: e.target.checked }), 'extendRight', () => d.extendRight);
  bindDiscrete($("mtfPScope"), 'change', e => ({ scope: e.target.value }), 'scope', () => d.scope);
  bindDiscrete($("mtfPLocked"), 'change', e => ({ locked: e.target.checked }), 'locked', () => d.locked);
  bindDiscrete($("mtfPVisible"), 'change', e => ({ visible: e.target.checked }), 'visible', () => d.visible);

  bindContinuous($("mtfPNotes"), e => { d.notes = e.target.value; }, 'notes', () => d.notes);
}

function save() {
  eventBus.emit('drawings:changed', { reason: 'edit' }); // triggers workspace/storage.js's debounced autosave
}

export function duplicateSelected() {
  const d = AppState.selectedDrawing;
  if (!d) return;
  const { htf } = AppState.panels;
  const shift = (htf.viewT1 - htf.viewT0) * 0.05;
  const copy = d.duplicate(shift); // DrawingObject.duplicate() — one implementation, every subclass gets it
  historyManager.execute(new CreateDrawingCommand(copy));
}

export function deleteSelected() {
  const d = AppState.selectedDrawing;
  if (!d) return;
  historyManager.execute(new DeleteDrawingCommand(d));
}

export function initPropertiesPanel() {
  eventBus.on('selection:changed', renderProps);
  eventBus.on('symbol:changed', renderProps);
  // Refreshes the panel after any history-tracked change (discrete commits,
  // continuous-field commits on 'change', and every undo/redo) — deliberately
  // NOT subscribed to raw "drawings:changed", since that fires on every
  // keystroke while typing and would blow away input focus mid-edit.
  eventBus.on('history:changed', renderProps);
  eventBus.on('command:deleteSelected', deleteSelected);
  window.mtfSelectAndZoom = selectAndZoom;
  window.mtfDuplicateSelected = duplicateSelected;
  window.mtfDeleteSelected = deleteSelected;
}
