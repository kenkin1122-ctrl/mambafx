/**
 * core/commands/DrawingCommands.js
 *
 * The four Command types that cover every operation Phase 4 requires:
 *   - CreateDrawingCommand   — new drawing (from a tool, or a duplicate)
 *   - DeleteDrawingCommand   — removing a drawing
 *   - GeometryChangeCommand  — move/resize (before/after t1,p1,t2,p2[,points])
 *   - PropertyChangeCommand  — rename/color/opacity/borderWidth/lineStyle/
 *                              extendLeft/extendRight/scope/lock/unlock/
 *                              visibility/notes — every one of these is
 *                              structurally identical (old value -> new
 *                              value for a small set of fields), so ONE
 *                              command class covers all of them rather than
 *                              a class per property, which is exactly the
 *                              kind of duplication Phase 3's DrawingObject
 *                              hierarchy was about avoiding — the same
 *                              principle applies here.
 *
 * Every command mutates through AppState's own addDrawing/removeDrawing/
 * restoreDrawing/updateDrawing — never by touching AppState.drawings
 * directly — so drawings:changed keeps firing correctly and autosave/
 * redraw/Drawing-Manager-refresh all keep working with zero changes to
 * those modules.
 */
import { Command } from './Command.js';
import { AppState } from '../AppState.js';

export class CreateDrawingCommand extends Command {
  constructor(drawing) {
    super();
    this.drawing = drawing;
  }
  execute() {
    AppState.addDrawing(this.drawing);
    AppState.setSelectedId(this.drawing.id);
  }
  undo() {
    AppState.removeDrawing(this.drawing.id);
    AppState.setSelectedId(null);
  }
  get label() { return `Create ${this.drawing.type}`; }
}

export class DeleteDrawingCommand extends Command {
  constructor(drawing) {
    super();
    this.drawing = drawing;
  }
  execute() {
    AppState.removeDrawing(this.drawing.id);
    AppState.setSelectedId(null);
  }
  undo() {
    AppState.restoreDrawing(this.drawing);
    AppState.setSelectedId(this.drawing.id);
  }
  get label() { return `Delete ${this.drawing.type}`; }
}

/**
 * Move/resize. `before`/`after` are small plain snapshots — {t1,p1,t2,p2}
 * for anchor-based types, plus `points` (deep-copied) for brush. Applied via
 * AppState.updateDrawing() so it fires the normal drawings:changed event.
 *
 * Note: by the time this command is constructed, the drag has ALREADY been
 * applied live (Phase 2/3 behavior, unchanged, for a responsive drag). So
 * this is pushed to history via HistoryManager.record() — logged without
 * re-running execute() — not HistoryManager.execute(). See interaction.js.
 */
export class GeometryChangeCommand extends Command {
  constructor(id, before, after, typeLabel) {
    super();
    this.id = id; this.before = before; this.after = after; this._label = typeLabel;
  }
  execute() { AppState.updateDrawing(this.id, this.after); }
  undo() { AppState.updateDrawing(this.id, this.before); }
  get label() { return `Move/resize ${this._label || ''}`.trim(); }
}

/** Covers every simple property edit — see file header. */
export class PropertyChangeCommand extends Command {
  constructor(id, before, after, typeLabel) {
    super();
    this.id = id; this.before = before; this.after = after; this._label = typeLabel;
  }
  execute() { AppState.updateDrawing(this.id, this.after); }
  undo() { AppState.updateDrawing(this.id, this.before); }
  get label() { return this._label || 'Edit property'; }
}
