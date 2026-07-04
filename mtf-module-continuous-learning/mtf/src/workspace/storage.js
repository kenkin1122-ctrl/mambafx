/**
 * workspace/storage.js
 *
 * Phase 1 scope: localStorage persistence of the drawings list, per symbol —
 * functionally identical to the old saveDrawings()/loadDrawings(), but now
 * event-driven: this module subscribes to "drawings:changed" itself and
 * autosaves on a debounce, so nothing else needs to remember to call save().
 *
 * Phase 16 will extend this into named, multi-symbol "workspaces" (drawings +
 * timeframes + layout + notes as one restorable unit) — the storeKey()
 * function below is deliberately isolated so that extension doesn't require
 * touching call sites elsewhere.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { STORAGE_PREFIX } from '../core/constants.js';
import { deserializeDrawing } from '../drawing/objects/factory.js';

function storeKey(symbol) {
  return STORAGE_PREFIX + symbol;
}

export function saveDrawings() {
  try {
    localStorage.setItem(storeKey(AppState.symbol), JSON.stringify(AppState.drawings));
  } catch (err) {
    console.warn('[workspace/storage] save failed (localStorage unavailable or full):', err);
  }
}

/**
 * Load and reconstruct drawings for a symbol as proper DrawingObject
 * subclass instances (Phase 3) — a plain JSON.parse() would return objects
 * with none of the move()/resize()/render() methods, which everything else
 * in the app now expects to exist. Compatible with data saved by Phases 1-2
 * (plain objects) as well as Phase 3+ (class instances) — the JSON shape on
 * disk is identical either way; only the reconstructed prototype differs.
 */
export function loadDrawings(symbol) {
  try {
    const raw = localStorage.getItem(storeKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map(deserializeDrawing).filter(Boolean);
  } catch (err) {
    console.warn('[workspace/storage] load failed, starting with an empty drawing set:', err);
    return [];
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDrawings, 300);
}

/** Wire autosave. Call once at module boot. */
export function initAutosave() {
  eventBus.on('drawings:changed', scheduleSave);
}
