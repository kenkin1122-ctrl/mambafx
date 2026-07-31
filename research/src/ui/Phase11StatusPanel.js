/**
 * research/src/ui/Phase11StatusPanel.js
 *
 * Purpose: renders the top-level Dashboard summary (directive's "Dashboard"
 * requirements): research cycle, current stage counts, confirmation/
 * replication/publication counts, scientific status. Presentation only --
 * consumes the plain object returned by Phase11Orchestrator.getCampaignSummary()
 * and never computes anything itself.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11StatusPanel.
 * Complexity: O(1) per update (fixed number of fields).
 */

import { PHASE11_CSS } from './Phase11Styles.js';

function row(doc, label, value) {
  const r = doc.createElement('div');
  r.className = PHASE11_CSS.ROW;
  const l = doc.createElement('span'); l.className = PHASE11_CSS.LABEL; l.textContent = label;
  const v = doc.createElement('span'); v.className = PHASE11_CSS.VALUE; v.textContent = String(value);
  r.appendChild(l); r.appendChild(v);
  return r;
}

/**
 * @param {Document} doc
 * @returns {{ element: HTMLElement, update: (summary: object) => void }}
 */
export function createPhase11StatusPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Research Cycle Status';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /**
   * @param {{
   *   researchFreezeId: string, sapId: string, candidateCount: number,
   *   countsByStage: object, confirmedCount: number, replicationCount: number,
   *   publicationCount: number
   * }} summary
   */
  function update(summary) {
    body.textContent = '';
    if (!summary) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No active research cycle.';
      body.appendChild(empty);
      return;
    }
    body.appendChild(row(doc, 'Research Freeze', summary.researchFreezeId));
    body.appendChild(row(doc, 'Statistical Analysis Plan', summary.sapId));
    body.appendChild(row(doc, 'Current Candidate Count', summary.candidateCount));
    body.appendChild(row(doc, 'Confirmation Count', summary.confirmedCount));
    body.appendChild(row(doc, 'Replication Count', summary.replicationCount));
    body.appendChild(row(doc, 'Publication Count', summary.publicationCount));

    const stageTitle = doc.createElement('div');
    stageTitle.className = PHASE11_CSS.LABEL;
    stageTitle.textContent = 'By stage:';
    body.appendChild(stageTitle);
    const grid = doc.createElement('div');
    grid.className = PHASE11_CSS.GRID;
    for (const [stage, count] of Object.entries(summary.countsByStage || {})) {
      grid.appendChild(row(doc, stage, count));
    }
    body.appendChild(grid);

    const status = doc.createElement('div');
    status.className = PHASE11_CSS.BADGE + ' ' + (summary.publicationCount > 0 ? PHASE11_CSS.BADGE_OK : PHASE11_CSS.BADGE_WARN);
    status.textContent = summary.publicationCount > 0 ? 'Active — has published discoveries' : 'Active — no publications yet';
    body.appendChild(status);
  }

  update(null);
  return { element: panel, update };
}
