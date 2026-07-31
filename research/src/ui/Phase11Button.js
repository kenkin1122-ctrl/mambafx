/**
 * research/src/ui/Phase11Button.js
 *
 * Purpose: a minimal, reusable button used across Phase 11 UI panels.
 * Presentation only -- takes a label and an onClick callback; performs no
 * business logic, no orchestrator calls, no statistics.
 *
 * Dependencies: ui/Phase11Styles.js (class names only).
 * Public API: createPhase11Button.
 * Complexity: O(1).
 */

import { PHASE11_CSS } from './Phase11Styles.js';

/**
 * @param {Document} doc
 * @param {object} params
 * @param {string} params.label
 * @param {() => void} [params.onClick]
 * @param {boolean} [params.primary=false]
 * @param {boolean} [params.disabled=false]
 * @returns {HTMLButtonElement}
 */
export function createPhase11Button(doc, { label, onClick, primary = false, disabled = false } = {}) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = primary ? `${PHASE11_CSS.BUTTON} ${PHASE11_CSS.BUTTON_PRIMARY}` : PHASE11_CSS.BUTTON;
  button.textContent = label ?? '';
  button.disabled = !!disabled;
  if (typeof onClick === 'function') {
    button.addEventListener('click', onClick);
  }
  return button;
}
