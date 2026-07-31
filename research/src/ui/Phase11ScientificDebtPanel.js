/**
 * research/src/ui/Phase11ScientificDebtPanel.js
 *
 * Purpose: renders open ScientificDebtLog items (type, description,
 * priority, status). Presentation only -- consumes the plain array
 * returned by ScientificDebtLog.listOpen().
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11ScientificDebtPanel.
 * Complexity: O(n) per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

const PRIORITY_BADGE = { CRITICAL: 'BADGE_FAIL', HIGH: 'BADGE_WARN', MEDIUM: 'BADGE', LOW: 'BADGE' };

export function createPhase11ScientificDebtPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Scientific Debt';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /** @param {{id:string, type:string, description:string, priority:string, status:string}[]} items */
  function update(items) {
    body.textContent = '';
    if (!Array.isArray(items) || items.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No open scientific debt items.';
      body.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = doc.createElement('div');
      row.className = PHASE11_CSS.PANEL;
      row.style.margin = '4px 0';
      const inner = doc.createElement('div');
      inner.className = PHASE11_CSS.PANEL_BODY;
      const badge = doc.createElement('span');
      badge.className = `${PHASE11_CSS.BADGE} ${PHASE11_CSS[PRIORITY_BADGE[item.priority]] || ''}`;
      badge.textContent = `${item.priority} — ${item.type}`;
      const desc = doc.createElement('div');
      desc.textContent = item.description;
      inner.appendChild(badge);
      inner.appendChild(desc);
      row.appendChild(inner);
      body.appendChild(row);
    }
  }

  update([]);
  return { element: panel, update };
}
