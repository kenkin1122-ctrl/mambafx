/**
 * core/HistoryManager.js
 *
 * Undo/redo stack. Two ways a Command enters history, matching the two
 * real situations in this app:
 *
 *   execute(command) — the action has NOT happened yet. Runs command.
 *     execute(), then pushes it. Used for discrete, single-step actions:
 *     creating a drawing, deleting one, a color-swatch click, a lock
 *     toggle, a select-dropdown change.
 *
 *   record(command)  — the action ALREADY happened (a drag or a slider/
 *     text-field edit was applied live, frame by frame, for
 *     responsiveness — see Command.js's header comment on gesture
 *     granularity). This just logs it onto the undo stack without calling
 *     execute() again, since re-applying the same after-state would be
 *     redundant (harmless, since it's idempotent, but pointless).
 *
 * Either way: any new entry clears the redo stack (standard undo/redo
 * semantics — redoing a stale future after a new action doesn't make
 * sense), and both are capped at maxSize (default 100) so history can't
 * grow unbounded over a long session.
 */
import { eventBus } from './EventBus.js';

const MAX_SIZE = 100;

class HistoryManager {
  constructor(maxSize = MAX_SIZE) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = maxSize;
  }

  /** Run a not-yet-applied command, then push it. */
  execute(command) {
    command.execute();
    this._push(command);
  }

  /** Log an already-applied command (see file header) without re-running it. */
  record(command) {
    this._push(command);
  }

  _push(command) {
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
    this._emit();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    this._emit();
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this.undoStack.push(cmd);
    this._emit();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** Clear all history — used when switching symbols, since undo referencing a different symbol's drawings would be meaningless. */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this._emit();
  }

  _emit() {
    eventBus.emit('history:changed', { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}

export const historyManager = new HistoryManager();
