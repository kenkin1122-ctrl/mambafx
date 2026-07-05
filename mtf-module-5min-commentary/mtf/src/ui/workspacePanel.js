/**
 * ui/workspacePanel.js
 *
 * UI binding + the actual apply-a-workspace orchestration (sequencing logic
 * that doesn't belong in workspaceManager.js, since it needs header.js's
 * switchSymbol/switchTimeframe and replayManager's exitReplay).
 *
 * Sequencing note on view (layout) restoration: switchTimeframe() triggers
 * an ASYNC WebSocket round-trip, and its response handler
 * (charts/socket.js's handleCandlesHistory/handleTicksHistory) calls
 * panel.setDefaultView() once new data arrives — which would silently
 * overwrite any view we set synchronously right after switching. There's
 * no clean synchronous hook into "the fetch this triggered has completed"
 * without deeper socket.js changes. Given that, view restoration here is
 * explicitly best-effort: applied once immediately (correct if the
 * timeframe didn't need to change) and again after a fixed delay (correct
 * in the common case where the WS round-trip finishes first, which it
 * almost always does on Deriv's public feed) — stated honestly rather than
 * presented as guaranteed-exact.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { drawAll } from '../charts/render.js';
import { exitReplay, isReplayActive } from '../charts/replayManager.js';
import { switchSymbol, switchTimeframe } from './header.js';
import { listWorkspaces, saveWorkspace, deleteWorkspace, getWorkspace, deserializeWorkspaceDrawings } from '../workspace/workspaceManager.js';

function applyView(panel, view) {
  if (!panel || !view) return;
  panel.viewT0 = view.viewT0;
  panel.viewT1 = view.viewT1;
  panel.priceLock = view.priceLock;
}

/** Restore a named workspace: symbol, timeframes, drawings, and (best-effort) view. */
export function applyWorkspace(name) {
  const w = getWorkspace(name);
  if (!w) return false;

  if (isReplayActive()) exitReplay();

  const applyRest = () => {
    const restoredDrawings = deserializeWorkspaceDrawings(w);
    AppState.setDrawings(restoredDrawings);
    AppState.setSelectedId(null);

    const { htf, ltf } = AppState.panels;
    if (htf && w.htfTimeframe && htf.tf.key !== w.htfTimeframe) switchTimeframe(htf, w.htfTimeframe);
    if (ltf && w.ltfTimeframe && ltf.tf.key !== w.ltfTimeframe) switchTimeframe(ltf, w.ltfTimeframe);

    applyView(htf, w.htfView);
    applyView(ltf, w.ltfView);
    drawAll();
    setTimeout(() => { applyView(htf, w.htfView); applyView(ltf, w.ltfView); drawAll(); }, 700);
  };

  if (w.symbol !== AppState.symbol) {
    switchSymbol(w.symbol);
    setTimeout(applyRest, 50);
  } else {
    applyRest();
  }
  return true;
}

function renderList() {
  const sel = $("mtfWorkspaceSel");
  if (!sel) return;
  const workspaces = listWorkspaces();
  const current = sel.value;
  sel.innerHTML = workspaces.length
    ? workspaces.map(w => `<option value="${w.name}">${w.name} (${w.symbol})</option>`).join('')
    : `<option value="">— no saved workspaces —</option>`;
  if (workspaces.some(w => w.name === current)) sel.value = current;
}

export function initWorkspacePanel() {
  renderList();
  eventBus.on('workspaces:changed', renderList);

  const saveBtn = $("mtfWorkspaceSaveBtn");
  if (saveBtn) saveBtn.addEventListener('click', () => {
    const name = prompt("Save current symbol, timeframes, view, and drawings as a workspace named:");
    if (name && name.trim()) saveWorkspace(name.trim());
  });

  const loadBtn = $("mtfWorkspaceLoadBtn");
  if (loadBtn) loadBtn.addEventListener('click', () => {
    const sel = $("mtfWorkspaceSel");
    if (sel && sel.value) applyWorkspace(sel.value);
  });

  const deleteBtn = $("mtfWorkspaceDeleteBtn");
  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    const sel = $("mtfWorkspaceSel");
    if (sel && sel.value && confirm(`Delete workspace "${sel.value}"? This cannot be undone.`)) {
      deleteWorkspace(sel.value);
    }
  });
}
