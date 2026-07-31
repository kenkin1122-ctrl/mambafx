/**
 * research/src/ui/Phase11NegativeEvidencePanel.js
 *
 * Purpose: renders a candidate's rejection history (stage rejected, reason,
 * effect size, CI, replication status) -- constraint #9, "Negative Findings
 * Are First-Class Outputs." Presentation only -- consumes the plain array
 * returned by NegativeEvidenceRegistry.byFingerprint(fingerprint).
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11NegativeEvidencePanel.
 * Complexity: O(n) per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11NegativeEvidencePanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Negative Evidence';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /** @param {{stageRejected:string, reason:string, effectSize:number|null, confidenceInterval:object|null, replicationStatus:string|null, timestamp:number}[]} entries */
  function update(entries) {
    body.textContent = '';
    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No rejections recorded for this candidate.';
      body.appendChild(empty);
      return;
    }
    const table = doc.createElement('table');
    table.className = PHASE11_CSS.TABLE;
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Stage', 'Reason', 'Effect Size', 'Replication', 'When']) {
      const th = doc.createElement('th'); th.textContent = label; headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = doc.createElement('tbody');
    for (const entry of entries) {
      const tr = doc.createElement('tr');
      const cells = [
        entry.stageRejected,
        entry.reason,
        entry.effectSize === null || entry.effectSize === undefined ? '—' : String(entry.effectSize),
        entry.replicationStatus ?? '—',
        new Date(entry.timestamp).toISOString(),
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
