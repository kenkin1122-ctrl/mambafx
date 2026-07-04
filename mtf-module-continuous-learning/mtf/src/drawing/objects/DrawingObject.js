/**
 * drawing/objects/DrawingObject.js
 *
 * Base class every drawing tool inherits from. This is what replaces the
 * switch-statement-per-behavior pattern from Phases 1-2 (renderDrawing(),
 * bodyHit(), handlesFor(), applyMove(), applyResize() each had a `case` for
 * every type): each subclass implements render()/hitTest()/move()/resize()/
 * getHandles() once, and the call sites (drawing/render.js, drawing/
 * interaction.js) become simple polymorphic dispatch — `d.render(...)`
 * instead of `switch(d.type){ case "rect": ... case "circle": ... }`.
 *
 * Every subclass gets, for free, with zero duplicated code:
 *   Move       -> move(dt, dp)          (subclasses implement this)
 *   Resize     -> resize(handle, t, p)  (subclasses implement this)
 *   Duplicate  -> duplicate(dt)         (implemented HERE, once)
 *   Delete     -> not a method here — AppState.removeDrawing(id) handles it
 *   Lock       -> lock() / unlock()     (implemented HERE, once)
 *   Rename     -> rename(label)         (implemented HERE, once)
 *   Color      -> setColor(color)       (implemented HERE, once)
 *   Opacity    -> setOpacity(opacity)   (implemented HERE, once)
 *   Line Style -> setLineStyle(style)   (implemented HERE, once)
 *   Visibility -> setVisible(v)         (implemented HERE, once)
 *
 * Persistence note: instances serialize via JSON.stringify() exactly like
 * the old plain objects did (methods live on the prototype, not on the
 * instance, so they're never included) — workspace/storage.js's saved data
 * shape is unchanged. Loading requires reconstructing the right subclass
 * from the `type` field, which is what objects/factory.js's
 * deserializeDrawing() does.
 */

import { newId } from '../ids.js';

export class DrawingObject {
  /**
   * @param {string} type
   * @param {object} opts
   */
  constructor(type, opts = {}) {
    this.id = opts.id || newId();
    this.type = type;
    this.symbol = opts.symbol;
    this.createdTF = opts.createdTF || 'htf';
    this.scope = opts.scope || 'all';           // 'all' | 'current'
    this.label = opts.label ?? this.constructor.defaultLabel;
    this.color = opts.color || '#4fb2ff';
    this.opacity = opts.opacity ?? 0.85;
    this.borderWidth = opts.borderWidth ?? 2;
    this.lineStyle = opts.lineStyle || 'solid';  // 'solid' | 'dashed' | 'dotted'
    this.locked = opts.locked ?? false;
    this.visible = opts.visible ?? true;
    this.notes = opts.notes || '';
    this.wickPart = opts.wickPart ?? null;
    this.semanticLabel = opts.semanticLabel ?? null;
    this.createdAt = opts.createdAt || Date.now();

    // Phase 5 metadata — same shape for every type, per the "don't create a
    // class per zone type" instruction. zoneType/status only make practical
    // sense on area-based drawings (rectangles) but live here on the base
    // so the data model stays uniform; the properties panel only shows the
    // Zone Type control when d.type === 'rect', same pattern already used
    // for trendline-only extend-left/right.
    this.zoneType = opts.zoneType ?? null;         // null | 'supply' | 'demand' | ... (see core/constants.js ZONE_TYPES)
    this.status = opts.status ?? 'active';          // 'active' | 'tested' | 'mitigated' | 'broken'
    this.importance = opts.importance ?? 'medium';  // 'low' | 'medium' | 'high'
    this.projection = opts.projection ?? false;     // whether this zone is flagged to project forward (Phase 8/9 build the actual forward-projection rendering on top of this flag)
    this.priority = opts.priority ?? 3;              // 1 (highest) .. 5 (lowest) — Drawing Manager display weight
    this.tags = opts.tags ?? [];                      // free-form string tags
  }

  /** Icon shown in the Drawing Manager / properties panel. Subclasses override. */
  static get typeIcon() { return '●'; }
  /** Default label assigned when none is given. Subclasses override. */
  static get defaultLabel() { return 'Drawing'; }

  // ── Generic property mutators — every subclass gets these for free ────
  rename(label) { this.label = label; return this; }
  setColor(color) { this.color = color; return this; }
  setOpacity(opacity) { this.opacity = opacity; return this; }
  setBorderWidth(w) { this.borderWidth = w; return this; }
  setLineStyle(style) { this.lineStyle = style; return this; }
  setVisible(v) { this.visible = v; return this; }
  setScope(scope) { this.scope = scope; return this; }
  setNotes(notes) { this.notes = notes; return this; }
  lock() { this.locked = true; return this; }
  unlock() { this.locked = false; return this; }

  // ── Phase 5 metadata mutators ───────────────────────────────────────
  setZoneType(zoneType) { this.zoneType = zoneType; return this; }
  setStatus(status) { this.status = status; return this; }
  setImportance(importance) { this.importance = importance; return this; }
  setProjection(projection) { this.projection = projection; return this; }
  setPriority(priority) { this.priority = priority; return this; }
  setTags(tags) { this.tags = tags; return this; }

  /**
   * Clone this drawing with a new id, shifted in time by `dt` (defaults to
   * no shift). Works for every subclass without any of them implementing
   * duplicate() themselves — it relies only on shiftTime(), which each
   * subclass DOES implement (since "shift every anchor point by dt" is
   * inherently type-specific: a rectangle has 2 time anchors, a brush has N).
   */
  duplicate(dt = 0) {
    const plain = JSON.parse(JSON.stringify(this));
    const copy = Object.assign(Object.create(Object.getPrototypeOf(this)), plain);
    copy.id = newId();
    copy.label = this.label + ' copy';
    copy.createdAt = Date.now();
    if (dt) copy.shiftTime(dt);
    return copy;
  }

  // ── Contract every subclass must implement ─────────────────────────
  /** @abstract Shift every time anchor by dt (seconds). Used by duplicate(). */
  shiftTime(dt) { throw new Error(`${this.type}: shiftTime() not implemented`); }
  /** @abstract Translate the whole object by (dt, dp) — used while actively dragging the body. */
  move(dt, dp) { throw new Error(`${this.type}: move() not implemented`); }
  /** @abstract Move a specific handle to an absolute (t, p) — used while resizing. */
  resize(handle, t, p) { throw new Error(`${this.type}: resize() not implemented`); }
  /** @abstract @returns {{x:number,y:number,h:string}[]} handle positions in panel pixel space */
  getHandles(panel) { return []; }
  /** @abstract @returns {boolean} whether (mx,my) in panel pixel space hits this object's body */
  hitTest(panel, mx, my) { return false; }
  /** @abstract Render onto panel.ctx (charts/render.js selects which canvas context "panel.ctx" resolves to before calling this). */
  render(panel, isDraft) { /* no-op */ }
}
