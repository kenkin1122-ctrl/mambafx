/**
 * research/src/ui/Phase11Styles.js
 *
 * Purpose:
 *   Shared CSS class-name constants and a single idempotent style-injection
 *   function for the isolated Phase 11 UI layer. Every Phase11* component
 *   imports its class names from here rather than hardcoding strings, so
 *   the whole UI can be restyled from one place without touching any
 *   component's structure/logic.
 *
 * Isolation: this module never touches index.html's styles, never reads
 *   global CSS variables from the legacy page, and injects its own <style>
 *   element scoped under the `.phase11-root` class so nothing here can leak
 *   into or be affected by legacy styling. Safe to mount inside or outside
 *   index.html.
 *
 * Dependencies: none (DOM only, injected as a parameter — no global
 *   `document` reference at module scope, so this file has zero import-time
 *   side effects and is trivially unit-testable with any document-like object).
 * Public API: PHASE11_CSS, injectPhase11Styles.
 * Complexity: O(1).
 */

/** CSS class name constants used across all Phase11* UI components. */
export const PHASE11_CSS = Object.freeze({
  ROOT: 'phase11-root',
  PANEL: 'phase11-panel',
  PANEL_TITLE: 'phase11-panel-title',
  PANEL_BODY: 'phase11-panel-body',
  BUTTON: 'phase11-button',
  BUTTON_PRIMARY: 'phase11-button-primary',
  TABLE: 'phase11-table',
  TAB_BAR: 'phase11-tab-bar',
  TAB: 'phase11-tab',
  TAB_ACTIVE: 'phase11-tab-active',
  TAB_PANEL: 'phase11-tab-panel',
  TAB_PANEL_HIDDEN: 'phase11-tab-panel-hidden',
  BADGE: 'phase11-badge',
  BADGE_WARN: 'phase11-badge-warn',
  BADGE_OK: 'phase11-badge-ok',
  BADGE_FAIL: 'phase11-badge-fail',
  DISCLAIMER: 'phase11-disclaimer',
  EMPTY: 'phase11-empty',
  ROW: 'phase11-row',
  LABEL: 'phase11-label',
  VALUE: 'phase11-value',
  GRID: 'phase11-grid',
});

const STYLE_MARKER_ATTR = 'data-phase11-styles';

const CSS_TEXT = `
.${PHASE11_CSS.ROOT} { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; font-size: 14px; background: #f7f8fa; border-radius: 8px; padding: 8px; }
.${PHASE11_CSS.PANEL} { border: 1px solid #d8dce1; border-radius: 8px; margin: 8px 0; background: #fff; }
.${PHASE11_CSS.PANEL_TITLE} { font-weight: 600; font-size: 13px; padding: 10px 12px; border-bottom: 1px solid #eef0f2; background: #f7f8fa; border-radius: 8px 8px 0 0; }
.${PHASE11_CSS.PANEL_BODY} { padding: 10px 12px; }
.${PHASE11_CSS.BUTTON} { border: 1px solid #c9ccd1; border-radius: 6px; background: #fff; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.${PHASE11_CSS.BUTTON_PRIMARY} { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
.${PHASE11_CSS.TABLE} { width: 100%; border-collapse: collapse; font-size: 13px; }
.${PHASE11_CSS.TABLE} th, .${PHASE11_CSS.TABLE} td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef0f2; }
.${PHASE11_CSS.TAB_BAR} { display: flex; gap: 4px; border-bottom: 1px solid #d8dce1; padding: 8px 4px 0; background: #fff; border-radius: 8px 8px 0 0; }
.${PHASE11_CSS.TAB} { padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; font-size: 13px; color: #4b5563; }
.${PHASE11_CSS.TAB_ACTIVE} { border-bottom-color: #2b6cb0; font-weight: 600; color: #1a1a1a; }
.${PHASE11_CSS.TAB_PANEL_HIDDEN} { display: none; }
.${PHASE11_CSS.BADGE} { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: #eef0f2; }
.${PHASE11_CSS.BADGE_WARN} { background: #fdf3d4; color: #92620a; }
.${PHASE11_CSS.BADGE_OK} { background: #dcf5e3; color: #15703d; }
.${PHASE11_CSS.BADGE_FAIL} { background: #fbe1e1; color: #a3231f; }
.${PHASE11_CSS.DISCLAIMER} { font-size: 11px; color: #6b7280; border-top: 1px dashed #d8dce1; margin-top: 8px; padding-top: 6px; }
.${PHASE11_CSS.EMPTY} { color: #8b909a; font-style: italic; padding: 8px 0; }
.${PHASE11_CSS.ROW} { display: flex; justify-content: space-between; padding: 3px 0; }
.${PHASE11_CSS.LABEL} { color: #6b7280; }
.${PHASE11_CSS.VALUE} { font-weight: 500; }
.${PHASE11_CSS.GRID} { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
`;

/**
 * Injects the Phase 11 UI stylesheet into the given document, once.
 * Idempotent: repeated calls on the same document are a no-op (checked via
 * a marker attribute on the injected <style> element).
 *
 * @param {Document} doc
 */
export function injectPhase11Styles(doc) {
  if (doc.querySelector(`style[${STYLE_MARKER_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_MARKER_ATTR, 'true');
  style.textContent = CSS_TEXT;
  doc.head ? doc.head.appendChild(style) : doc.appendChild(style);
}
