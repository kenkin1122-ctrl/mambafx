/**
 * ui/toolbar.js
 *
 * Tool selection buttons, the snap-to-candle and keep-tool-active toggles,
 * Undo/Redo buttons, and keyboard shortcuts (V, Escape, Delete/Backspace,
 * Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z). Listens for "tool:requestSelect" from
 * drawing/interaction.js, which fires after a one-shot draw completes —
 * keeps interaction.js from needing to know how tool-button UI state is
 * represented.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { historyManager } from '../core/HistoryManager.js';

export function setTool(tool, opts = {}) {
  AppState.setActiveTool(tool);
  if (!opts.preservePreset && AppState.pendingPreset) AppState.setPendingPreset(null);
  document.querySelectorAll("#page-mtf .tool-btn").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
}

function deleteSelected() {
  eventBus.emit('command:deleteSelected');
}

function updateHistoryButtons() {
  const undoBtn = $("mtfUndoBtn"), redoBtn = $("mtfRedoBtn");
  if (undoBtn) undoBtn.disabled = !historyManager.canUndo;
  if (redoBtn) redoBtn.disabled = !historyManager.canRedo;
}

export function initToolbar() {
  document.querySelectorAll("#page-mtf .tool-btn").forEach(b =>
    b.addEventListener("click", () => setTool(b.dataset.tool))
  );

  const snapToggle = $("mtfSnapToggle");
  if (snapToggle) snapToggle.addEventListener("click", function () {
    const cb = this.querySelector("input");
    cb.checked = !cb.checked;
    AppState.setSnapEnabled(cb.checked);
    this.classList.toggle("on", cb.checked);
  });

  const lockToggle = $("mtfLockToolToggle");
  if (lockToggle) lockToggle.addEventListener("click", function () {
    const cb = this.querySelector("input");
    cb.checked = !cb.checked;
    AppState.setLockTool(cb.checked);
    this.classList.toggle("on", cb.checked);
  });

  const scopeSel = $("mtfNewScopeSel");
  if (scopeSel) scopeSel.addEventListener("change", e => AppState.setNewScope(e.target.value));

  const undoBtn = $("mtfUndoBtn");
  if (undoBtn) undoBtn.addEventListener("click", () => historyManager.undo());
  const redoBtn = $("mtfRedoBtn");
  if (redoBtn) redoBtn.addEventListener("click", () => historyManager.redo());
  eventBus.on('history:changed', updateHistoryButtons);
  updateHistoryButtons(); // reflect initial (empty) state

  eventBus.on('tool:requestSelect', () => setTool("select"));

  window.addEventListener("keydown", e => {
    const mtfPageEl = document.getElementById("page-mtf");
    if (!mtfPageEl || !mtfPageEl.classList.contains("active")) return;

    // Every shortcut below is intentionally skipped while a text field has
    // focus — inside an <input>/<textarea>, Ctrl+Z should trigger the
    // browser's own native text-undo, not jump to the drawing history.
    if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); historyManager.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); historyManager.redo(); return; }
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "Escape") { setTool("select"); AppState.setSelectedId(null); }
      if ((e.key === "Delete" || e.key === "Backspace") && AppState.selectedId) deleteSelected();
    }
  });
}
