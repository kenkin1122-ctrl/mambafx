/**
 * core/commands/Command.js
 *
 * Base contract for every undoable operation. A Command knows how to do
 * itself (execute) and how to undo itself (undo) — nothing else needs to
 * know HOW a given action reverses; HistoryManager just calls these two
 * methods and manages the stacks.
 *
 * Design note on granularity: a Command represents one user-meaningful
 * GESTURE, not one low-level mutation. Dragging a rectangle across the
 * screen is ONE Command (before-geometry -> after-geometry), not one
 * Command per mousemove tick — the live drag still mutates the object
 * directly every frame (unchanged from Phase 2/3, for responsiveness), and
 * exactly one Command is pushed to history when the drag ends. Same for
 * property-panel sliders/text fields: typing a label or dragging an
 * opacity slider is ONE undo step from start-of-edit to commit, not one
 * per keystroke/per percent. See drawing/interaction.js and
 * ui/propertiesPanel.js for where that before/after capture happens.
 */
export class Command {
  /** Perform the action. Called once when the command is first run, and again on redo(). */
  execute() { throw new Error('execute() not implemented'); }
  /** Reverse the action performed by execute(). */
  undo() { throw new Error('undo() not implemented'); }
  /** Human-readable description, for a future "Undo: Move Rectangle" style UI. */
  get label() { return 'Action'; }
}
