/**
 * core/AppState.js
 *
 * Single source of truth for cross-module state. Every module that needs to
 * read or mutate shared state goes through this object instead of holding
 * its own copy of a global variable — this is what "removed globals" means
 * concretely: there is now exactly one `drawings` array, one `selectedId`,
 * etc., owned here, with every mutation routed through a setter that emits
 * an event so interested modules (renderer, drawing manager, autosave...)
 * can react without being directly imported by the module making the change.
 *
 * Design note: connection-level state (the raw WebSocket, reconnect timers,
 * pending request callbacks) intentionally does NOT live here — that's an
 * implementation detail private to charts/socket.js, not app-level domain
 * state anything else needs to read. Only genuinely cross-cutting state
 * (symbol, drawings, selection, tool, crosshair, panel registry) belongs in
 * AppState. Dumping everything into one bucket regardless of who owns it is
 * the "global variable" problem wearing a new name.
 */

import { eventBus } from './EventBus.js';

const state = {
  symbol: "1HZ100V",
  drawings: [],
  selectedId: null,
  activeTool: "select",
  snapEnabled: true,
  lockTool: false,
  newScope: "all",         // scope assigned to newly-created drawings: 'all' | 'current'
  pendingPreset: null,      // Phase 10: { zoneType, color, label } armed by a quick-preset click, or null
  crosshair: null,          // { t, p, source }
  draft: null,              // in-progress (not yet committed) drawing
  drag: null,               // active mouse-drag operation descriptor
  panels: {},                // { htf: Panel, ltf: Panel } — LIVE ALIASES into timeframePanels (see registerPanel/setActiveTimeframe below)
  timeframePanels: {},        // { m1: Panel, m3: Panel, ..., d1: Panel } — all 10 MTF Dashboard panels, always live
  activeTimeframeKey: null,    // which timeframePanels key panels.htf currently points to
  compareTimeframeKey: null,    // which timeframePanels key panels.ltf currently points to
};

export const AppState = {
  // ── Symbol ────────────────────────────────────────────────────────
  get symbol() { return state.symbol; },
  setSymbol(sym) {
    if (sym === state.symbol) return;
    state.symbol = sym;
    eventBus.emit('symbol:changed', sym);
  },

  // ── Drawings (the shared, price/time-anchored object list) ─────────
  get drawings() { return state.drawings; },
  setDrawings(list) {
    state.drawings = list;
    eventBus.emit('drawings:changed', { reason: 'replace' });
  },
  addDrawing(d) {
    state.drawings.push(d);
    eventBus.emit('drawings:changed', { reason: 'create', drawing: d });
    eventBus.emit('drawing:created', d);
  },
  removeDrawing(id) {
    const removed = state.drawings.find(d => d.id === id);
    state.drawings = state.drawings.filter(d => d.id !== id);
    eventBus.emit('drawings:changed', { reason: 'delete', id });
    eventBus.emit('drawing:deleted', removed);
    return removed;
  },
  /** Re-insert a previously-removed drawing — used by DeleteDrawingCommand.undo(). */
  restoreDrawing(drawing) {
    state.drawings.push(drawing);
    eventBus.emit('drawings:changed', { reason: 'restore', drawing });
    eventBus.emit('drawing:created', drawing);
  },
  updateDrawing(id, patch) {
    const d = state.drawings.find(x => x.id === id);
    if (!d) return null;
    Object.assign(d, patch);
    eventBus.emit('drawings:changed', { reason: 'update', id, patch });
    eventBus.emit('drawing:updated', { id, patch, drawing: d });
    return d;
  },
  getDrawing(id) {
    return state.drawings.find(d => d.id === id) || null;
  },

  // ── Selection ─────────────────────────────────────────────────────
  get selectedId() { return state.selectedId; },
  setSelectedId(id) {
    if (id === state.selectedId) return;
    state.selectedId = id;
    eventBus.emit('selection:changed', id);
  },
  get selectedDrawing() {
    return state.selectedId ? this.getDrawing(state.selectedId) : null;
  },

  /**
   * The id of the drawing currently being moved or resized, if any — used by
   * the Phase 2 background layer to exclude that object from its (expensive,
   * data/grid/every-other-drawing) repaint while dragging. The live preview
   * of the object being dragged is drawn on the cheap overlay layer instead.
   * Returns null for draft (new, not-yet-committed) drawings — those never
   * touch the background layer at all until they're added to AppState.
   */
  get draggingDrawingId() {
    const d = state.drag;
    if (d && (d.mode === 'move' || d.mode === 'resize') && d.obj) return d.obj.id;
    return null;
  },

  // ── Active tool ───────────────────────────────────────────────────
  get activeTool() { return state.activeTool; },
  setActiveTool(tool) {
    if (tool === state.activeTool) return;
    state.activeTool = tool;
    eventBus.emit('tool:changed', tool);
  },

  // ── Drawing behavior toggles ─────────────────────────────────────
  get snapEnabled() { return state.snapEnabled; },
  setSnapEnabled(v) { state.snapEnabled = v; eventBus.emit('snap:changed', v); },

  get lockTool() { return state.lockTool; },
  setLockTool(v) { state.lockTool = v; eventBus.emit('lockTool:changed', v); },

  get newScope() { return state.newScope; },
  setNewScope(v) { state.newScope = v; },

  /**
   * Phase 10: the zone preset armed by clicking a quick-preset button
   * (Supply/Demand/FVG/etc). Consumed by drawing/interaction.js when the
   * next rectangle is created (merges zoneType + a matching default color
   * into it), then cleared — unless lockTool is on, in which case it stays
   * armed for drawing several zones of the same type in a row, mirroring
   * how lockTool already governs whether the active TOOL reverts after
   * one use.
   */
  get pendingPreset() { return state.pendingPreset; },
  setPendingPreset(preset) {
    state.pendingPreset = preset;
    eventBus.emit('pendingPreset:changed', preset);
  },

  /**
   * Phase 15: replay state. `index` is a position into the HTF panel's own
   * candles[] array — see charts/replayManager.js for why replay is a
   * render-time filter (candles beyond this cutoff simply aren't drawn)
   * rather than a mutation of panel.candles: it means exiting replay is
   * instant, with zero refetch, and the live WS feed can keep running
   * underneath replay without any special-casing.
   */
  get replay() { return state.replay; },
  setReplay(r) { state.replay = r; eventBus.emit('replay:changed', r); },
  updateReplay(patch) { state.replay = { ...state.replay, ...patch }; eventBus.emit('replay:changed', state.replay); },

  // ── Crosshair (synced across both panels) ───────────────────────
  get crosshair() { return state.crosshair; },
  setCrosshair(c) {
    state.crosshair = c;
    eventBus.emit('crosshair:changed', c);
  },

  // ── Transient draft/drag (in-progress interaction, not persisted) ──
  get draft() { return state.draft; },
  setDraft(d) { state.draft = d; },

  get drag() { return state.drag; },
  setDrag(d) { state.drag = d; },

  // ── Panel registry ────────────────────────────────────────────────
  // `panels` (.htf / .ltf) are the two INTERACTIVE chart panels — the ones
  // behind candle decomposition, replay, zoom-to-drawing, and every mouse
  // interaction. drawing/candleMarking.js, charts/replayManager.js, and
  // charts/zoomManager.js all read AppState.panels.htf/.ltf freshly on
  // every call (not a cached reference), which means these two MUST stay
  // pointed at the panels the user can actually see and click on. Never
  // reassign them to a dashboard panel — doing so would silently redirect
  // decomposition/replay/zoom onto an invisible panel while the user
  // keeps interacting with the visible one, a confusing, hard-to-diagnose
  // bug that's worse than not having the feature at all.
  get panels() { return state.panels; },
  registerPanel(key, panel) {
    state.panels[key] = panel;
    state.timeframePanels[key] = panel;
    eventBus.emit('panel:registered', { key, panel });
  },

  /** All 10 MTF Dashboard panels, keyed by timeframe (m1, m3, m5, m10, m30, h1, h4, h8, h12, d1) — always live, always updating. Also includes 'htf'/'ltf' under those same keys, since registerPanel() adds to both registries. */
  get timeframePanels() { return state.timeframePanels; },
  registerTimeframePanel(key, panel) {
    state.timeframePanels[key] = panel;
    eventBus.emit('timeframePanel:registered', { key, panel });
  },

  get activeTimeframeKey() { return state.activeTimeframeKey; },
  get compareTimeframeKey() { return state.compareTimeframeKey; },

  /**
   * Which timeframe the ANALYSIS DISPLAY layer (Smart Market Intelligence,
   * Probability Engine's UI, Continuous Learning's snapshot) should read —
   * NOT the same thing as AppState.panels.htf, and deliberately so. This
   * lets clicking a dashboard card redirect what the analysis text is
   * ABOUT without ever touching the two panels every interactive tool
   * depends on. Falls back to the original panels.htf/.ltf when no
   * dashboard card has been activated yet (e.g. app just booted).
   */
  getAnalysisPanels() {
    const htf = state.activeTimeframeKey ? state.timeframePanels[state.activeTimeframeKey] : null;
    const ltf = state.compareTimeframeKey ? state.timeframePanels[state.compareTimeframeKey] : null;
    return { htf: htf || state.panels.htf, ltf: ltf || state.panels.ltf };
  },

  /** Make `key`'s panel the one the analysis display layer reads via getAnalysisPanels(). Does NOT touch panels.htf — see the note above. */
  setActiveTimeframe(key) {
    if (!state.timeframePanels[key]) return false;
    state.activeTimeframeKey = key;
    eventBus.emit('activeTimeframe:changed', key);
    return true;
  },

  /** Make `key`'s panel the analysis-comparison timeframe (mirrors setActiveTimeframe for the "ltf" role). */
  setCompareTimeframe(key) {
    if (!state.timeframePanels[key]) return false;
    state.compareTimeframeKey = key;
    eventBus.emit('compareTimeframe:changed', key);
    return true;
  },
};
