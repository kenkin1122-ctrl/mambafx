/**
 * core/EventBus.js
 *
 * Minimal publish/subscribe bus. This is what lets modules react to state
 * changes without importing and calling each other directly — e.g. workspace/
 * storage.js can autosave on "drawings:changed" without charts/render.js
 * needing to know storage exists at all.
 *
 * Phase 1 scope: synchronous emit, no batching/coalescing yet. Phase 2's
 * rendering engine will listen on these events and decide *when* to actually
 * repaint (via requestAnimationFrame), rather than each emit triggering an
 * immediate redraw the way the old drawAll()-everywhere pattern did.
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe function
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** Subscribe once; auto-unsubscribes after the first emit. */
  once(event, fn) {
    const off = this.on(event, payload => { off(); fn(payload); });
    return off;
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  /**
   * Emit an event. Listener errors are caught and logged individually so one
   * broken listener can't take down every other subscriber of the same event.
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] listener for "${event}" threw:`, err); }
    }
  }

  /** Remove every listener for an event, or every listener entirely if no event given. Mostly for tests/teardown. */
  clear(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
  }
}

/** Singleton bus shared by the whole MTF module. */
export const eventBus = new EventBus();
