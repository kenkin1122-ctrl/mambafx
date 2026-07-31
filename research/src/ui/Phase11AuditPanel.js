/**
 * research/src/ui/Phase11AuditPanel.js
 *
 * Purpose: renders a candidate's DecisionAuditLog trail (decisionType,
 * reason, timestamp, actor). Presentation only -- consumes the plain array
 * returned by DecisionAuditLog.forCandidate(id).map(e => e.toJSON()).
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11AuditPanel.
 * Complexity: O(n) per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11AuditPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Decision Audit';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /** @param {{decisionType:string, reason:string, timestamp:number, actor:string}[]} entries */
  function update(entries) {
    body.textContent = '';
    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No decisions recorded yet.';
      body.appendChild(empty);
      return;
    }
    const table = doc.createElement('table');
    table.className = PHASE11_CSS.TABLE;
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['When', 'Decision', 'Actor', 'Reason']) {
      const th = doc.createElement('th'); th.textContent = label; headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = doc.createElement('tbody');
    for (const entry of entries) {
      const tr = doc.createElement('tr');
      const cells = [
        new Date(entry.timestamp).toISOString(),
        entry.decisionType,
        entry.actor,
        entry.reason,
      ];
      for (const c of cells) {
        const td = doc.createElement('td'); td.textContent = c; tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  update([]);
  return { element: panel, update };
}
