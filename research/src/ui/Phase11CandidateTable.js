/**
 * research/src/ui/Phase11CandidateTable.js
 *
 * Purpose: renders the "Candidate Explorer" table (directive requirement):
 * candidate ID, lifecycle, evidence tier, importance, confidence,
 * reproducibility, scientific debt count, negative evidence count.
 * Presentation only -- consumes a plain array of row objects the embedding
 * app builds from Phase11Orchestrator.listCandidates() plus whatever debt/
 * negative-evidence counts it looks up per candidate.
 *
 * Selecting a row invokes the supplied onSelect callback with the
 * candidateId, letting Phase11Dashboard.js drive the detail panels --
 * this table never fetches detail data itself.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11CandidateTable.
 * Complexity: O(n) per update, n = number of rows.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

/**
 * @param {Document} doc
 * @param {{ onSelect?: (candidateId: string) => void }} [options]
 */
export function createPhase11CandidateTable(doc, { onSelect } = {}) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Candidate Explorer';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  const COLUMNS = [
    ['id', 'Candidate ID'],
    ['lifecycle', 'Lifecycle'],
    ['evidenceTier', 'Evidence Tier'],
    ['importance', 'Importance'],
    ['confidence', 'Confidence'],
    ['reproducibilityLevel', 'Reproducibility'],
    ['scientificDebtCount', 'Scientific Debt'],
    ['negativeEvidenceCount', 'Negative Evidence'],
  ];

  /**
   * @param {object[]} rows - Each: { id, lifecycle, evidenceTier, importance,
   *   confidence, reproducibilityLevel, scientificDebtCount, negativeEvidenceCount }
   */
  function update(rows) {
    body.textContent = '';
    if (!Array.isArray(rows) || rows.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No candidates generated yet.';
      body.appendChild(empty);
      return;
    }
    const table = doc.createElement('table');
    table.className = PHASE11_CSS.TABLE;
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const [, label] of COLUMNS) {
      const th = doc.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    for (const row of rows) {
      const tr = doc.createElement('tr');
      tr.style.cursor = 'pointer';
      for (const [key] of COLUMNS) {
        const td = doc.createElement('td');
        const value = row[key];
        td.textContent = value === undefined || value === null ? '—' : String(value);
        tr.appendChild(td);
      }
      if (typeof onSelect === 'function') {
        tr.addEventListener('click', () => onSelect(row.id));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  update([]);
  return { element: panel, update };
}
