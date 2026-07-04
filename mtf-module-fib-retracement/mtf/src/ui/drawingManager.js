/**
 * ui/drawingManager.js
 *
 * The sidebar listing every drawing for the current symbol. Re-renders
 * itself in response to "drawings:changed" / "selection:changed" — it does
 * not need charts/render.js to know it exists, and vice versa.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $, escapeHtml } from '../utils/dom.js';
import { typeIcon } from '../drawing/model.js';
import { ZONE_TYPES } from '../core/constants.js';
import { zoomBothToDrawing } from '../charts/zoomManager.js';
import { historyManager } from '../core/HistoryManager.js';
import { PropertyChangeCommand } from '../core/commands/DrawingCommands.js';

const ZONE_LABEL_BY_KEY = Object.fromEntries(ZONE_TYPES.map(z => [z.key, z.label]));

export function renderManager() {
  const list = $("mtfManagerList");
  if (!list) return;
  const mine = AppState.drawings.filter(d => d.symbol === AppState.symbol);
  if (!mine.length) {
    list.innerHTML = `<div class="manager-empty">No drawings yet.<br>Pick a tool above and draw on either chart.</div>`;
    return;
  }
  list.innerHTML = mine.slice().reverse().map(d => {
    const zoneBadge = d.zoneType && ZONE_LABEL_BY_KEY[d.zoneType]
      ? `<span style="font-size:8px;font-weight:700;padding:1px 5px;border-radius:4px;background:${d.color}22;color:${d.color};border:1px solid ${d.color}55;white-space:nowrap">${ZONE_LABEL_BY_KEY[d.zoneType]}</span>`
      : '';
    const priorityMark = d.priority <= 2 ? `<span title="Priority ${d.priority}" style="color:#ffc857;font-size:9px">★</span>` : '';
    return `
    <div class="dr-row ${d.id === AppState.selectedId ? 'sel' : ''}" onclick="mtfSelectAndZoom('${d.id}')">
      <span class="ic">${typeIcon(d.type)}</span>
      <span class="sw" style="background:${d.color}"></span>
      ${priorityMark}
      <span class="nm">${escapeHtml(d.label)}</span>
      ${zoneBadge}
      <span class="ic" title="${d.visible ? 'Hide' : 'Show'}" onclick="event.stopPropagation();mtfToggleVisible('${d.id}')">${d.visible ? '👁' : '⦸'}</span>
      <span class="ic" title="${d.locked ? 'Unlock' : 'Lock'}" onclick="event.stopPropagation();mtfToggleLock('${d.id}')">${d.locked ? '🔒' : '🔓'}</span>
    </div>`;
  }).join("");
}

/** Select a drawing and zoom both panels to its price/time extent. */
export function selectAndZoom(id) {
  const d = AppState.getDrawing(id);
  if (!d) return;
  AppState.setSelectedId(id);
  zoomBothToDrawing(d);
}

export function toggleVisible(id) {
  const d = AppState.getDrawing(id);
  if (!d) return;
  historyManager.execute(new PropertyChangeCommand(id, { visible: d.visible }, { visible: !d.visible }, 'visible'));
}

export function toggleLock(id) {
  const d = AppState.getDrawing(id);
  if (!d) return;
  historyManager.execute(new PropertyChangeCommand(id, { locked: d.locked }, { locked: !d.locked }, 'locked'));
}

export function initDrawingManager() {
  eventBus.on('drawings:changed', renderManager);
  eventBus.on('selection:changed', renderManager);
  eventBus.on('symbol:changed', renderManager);
}
