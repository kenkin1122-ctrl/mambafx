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
.${PHASE11_CSS.ROOT} { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; color: #cdd6f4 !important; font-size: 14px !important; background: #0a0e1a !important; border-radius: 8px !important; padding: 8px !important; }
.${PHASE11_CSS.PANEL} { border: 1px solid #1e2d55 !important; border-radius: 10px !important; margin: 8px 0 !important; background: #11162a !important; }
.${PHASE11_CSS.PANEL_TITLE} { font-weight: 700 !important; font-size: 12px !important; text-transform: uppercase !important; letter-spacing: .05em !important; padding: 10px 12px !important; border-bottom: 1px solid #1e2d55 !important; background: #0d1120 !important; color: #cba6f7 !important; border-radius: 10px 10px 0 0 !important; }
.${PHASE11_CSS.PANEL_BODY} { padding: 10px 12px !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.BUTTON} { border: 1px solid #313866 !important; border-radius: 6px !important; background: #0d1120 !important; color: #cdd6f4 !important; padding: 6px 12px !important; cursor: pointer !important; font-size: 13px !important; }
.${PHASE11_CSS.BUTTON_PRIMARY} { background: #89b4fa !important; color: #0a0e1a !important; border-color: #89b4fa !important; font-weight: 600 !important; }
.${PHASE11_CSS.TABLE} { width: 100% !important; border-collapse: collapse !important; font-size: 13px !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.TABLE} th, .${PHASE11_CSS.TABLE} td { text-align: left !important; padding: 6px 8px !important; border-bottom: 1px solid #1e2d55 !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.TABLE} th { color: #89b4fa !important; font-size: 11px !important; text-transform: uppercase !important; letter-spacing: .05em !important; }
.${PHASE11_CSS.TAB_BAR} { display: flex !important; gap: 4px !important; border-bottom: 1px solid #1e2d55 !important; padding: 8px 4px 0 !important; background: #0d1120 !important; border-radius: 8px 8px 0 0 !important; }
.${PHASE11_CSS.TAB} { padding: 8px 12px !important; cursor: pointer !important; border-bottom: 2px solid transparent !important; font-size: 13px !important; color: #7f849c !important; background: transparent !important; }
.${PHASE11_CSS.TAB_ACTIVE} { border-bottom-color: #cba6f7 !important; font-weight: 700 !important; color: #cba6f7 !important; }
.${PHASE11_CSS.TAB_PANEL_HIDDEN} { display: none !important; }
.${PHASE11_CSS.BADGE} { display: inline-block !important; padding: 2px 8px !important; border-radius: 10px !important; font-size: 11px !important; background: #1e2d55 !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.BADGE_WARN} { background: #45341a !important; color: #f9c96a !important; }
.${PHASE11_CSS.BADGE_OK} { background: #1c3a2a !important; color: #a6e3a1 !important; }
.${PHASE11_CSS.BADGE_FAIL} { background: #3a1c22 !important; color: #f38ba8 !important; }
.${PHASE11_CSS.DISCLAIMER} { font-size: 11px !important; color: #6c7086 !important; border-top: 1px dashed #1e2d55 !important; margin-top: 8px !important; padding-top: 6px !important; }
.${PHASE11_CSS.EMPTY} { color: #6c7086 !important; font-style: italic !important; padding: 8px 0 !important; }
.${PHASE11_CSS.ROW} { display: flex !important; justify-content: space-between !important; padding: 3px 0 !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.LABEL} { color: #7f849c !important; }
.${PHASE11_CSS.VALUE} { font-weight: 500 !important; color: #cdd6f4 !important; }
.${PHASE11_CSS.GRID} { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important; gap: 8px !important; }
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
