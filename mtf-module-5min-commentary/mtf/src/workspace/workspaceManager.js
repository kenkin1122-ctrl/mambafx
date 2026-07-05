/**
 * workspace/workspaceManager.js
 *
 * Named, explicit workspace snapshots — distinct from workspace/storage.js's
 * automatic per-edit autosave. A workspace is something the user creates
 * deliberately ("save this as 'ICT Setup'") and can restore later, possibly
 * after editing drawings under a different name or switching symbols many
 * times in between. The autosave keeps the CURRENT/live symbol's drawings
 * safe across reloads; workspaces are point-in-time snapshots the user
 * controls explicitly.
 *
 * What a workspace captures, mapped to the Phase 16 spec's list:
 *   Drawings   — full snapshot of AppState.drawings at save time
 *   Timeframes — the HTF/LTF timeframe keys selected at save time
 *   Layouts    — each panel's view (viewT0/viewT1/priceLock) — best-effort
 *                restoration, see applyWorkspace()'s docblock for why
 *   Indicators — reserved, always empty: no indicator system exists in this
 *                module (candles/drawings/order-flow proxies only) — stated
 *                honestly rather than fabricating data to fill the field
 *   Metadata   — already part of each drawing (Phase 5's zoneType/status/
 *                importance/etc), included automatically as part of Drawings
 *   Notes      — a free-text note about the workspace itself
 *   Analysis   — deliberately NOT persisted. Pattern/rule-engine findings
 *                (Phases 11/14) are derived from live candle data; saving a
 *                stale snapshot of them would risk misleading the user after
 *                the market has moved. Re-running the scan against restored
 *                data reproduces them deterministically, which is safer than
 *                storing a decaying cache.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { deserializeDrawing } from '../drawing/objects/factory.js';

const WORKSPACES_KEY = 'mtf_workspaces_v1';

function loadAll() {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn('[workspaceManager] failed to read saved workspaces:', err);
    return [];
  }
}

function saveAll(list) {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[workspaceManager] failed to save workspaces (localStorage unavailable or full):', err);
  }
}

/** @returns {Array<{name:string,symbol:string,updatedAt:number}>} lightweight list for populating a picker — not the full drawing data */
export function listWorkspaces() {
  return loadAll()
    .map(w => ({ name: w.name, symbol: w.symbol, updatedAt: w.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Snapshot current state as a named workspace. Overwrites an existing
 * workspace of the same name (preserving its original createdAt).
 */
export function saveWorkspace(name, notes = '') {
  if (!name || !name.trim()) return null;
  const { htf, ltf } = AppState.panels;

  const workspace = {
    name: name.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    symbol: AppState.symbol,
    htfTimeframe: htf ? htf.tf.key : null,
    ltfTimeframe: ltf ? ltf.tf.key : null,
    htfView: htf ? { viewT0: htf.viewT0, viewT1: htf.viewT1, priceLock: htf.priceLock } : null,
    ltfView: ltf ? { viewT0: ltf.viewT0, viewT1: ltf.viewT1, priceLock: ltf.priceLock } : null,
    drawings: JSON.parse(JSON.stringify(AppState.drawings)),
    indicators: [],
    notes,
  };

  const list = loadAll();
  const existingIdx = list.findIndex(w => w.name === workspace.name);
  if (existingIdx >= 0) {
    workspace.createdAt = list[existingIdx].createdAt;
    list[existingIdx] = workspace;
  } else {
    list.push(workspace);
  }
  saveAll(list);
  eventBus.emit('workspaces:changed', listWorkspaces());
  return workspace;
}

export function deleteWorkspace(name) {
  const list = loadAll().filter(w => w.name !== name);
  saveAll(list);
  eventBus.emit('workspaces:changed', listWorkspaces());
}

/** Raw stored workspace by name, or null. Callers that need to actually APPLY it should go through applyWorkspace() in ui/workspacePanel.js, which handles the symbol/timeframe-switch sequencing. */
export function getWorkspace(name) {
  return loadAll().find(w => w.name === name) || null;
}

/** Reconstruct a workspace's drawings as real class instances (Phase 3), same as workspace/storage.js's loadDrawings(). */
export function deserializeWorkspaceDrawings(workspace) {
  return (workspace.drawings || []).map(deserializeDrawing).filter(Boolean);
}
