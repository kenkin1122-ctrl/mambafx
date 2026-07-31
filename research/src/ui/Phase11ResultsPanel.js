/**
 * research/src/ui/Phase11ResultsPanel.js
 *
 * Purpose: renders the final "Results" list -- candidates that have passed
 * checkPublicationEligibility(), for a quick overview of what's actually
 * publication-ready in the current research cycle. Presentation only.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11ResultsPanel.
 * Complexity: O(n) per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11ResultsPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Results';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /** @param {{id: string, fingerprint: string, evidenceTier: string}[]} results */
  function update(results) {
    body.textContent = '';
    if (!Array.isArray(results) || results.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No publication-eligible candidates yet.';
      body.appendChild(empty);
      return;
    }
    const table = doc.createElement('table');
    table.className = PHASE11_CSS.TABLE;
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Candidate ID', 'Fingerprint', 'Evidence Tier']) {
      const th = doc.createElement('th'); th.textContent = label; headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = doc.createElement('tbody');
    for (const r of results) {
      const tr = doc.createElement('tr');
      for (const v of [r.id, r.fingerprint, r.evidenceTier]) {
        const td = doc.createElement('td'); td.textContent = v ?? '—'; tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  update([]);
  return { element: panel, update };
}
