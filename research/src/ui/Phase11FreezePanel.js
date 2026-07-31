/**
 * research/src/ui/Phase11FreezePanel.js
 *
 * Purpose: renders ResearchFreeze detail plus the result of
 * Phase11Orchestrator.checkPublicationEligibility() for a selected
 * candidate -- directive's "Publication Eligibility" / "Reproducibility
 * Report" audit requirement. Presentation only.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11FreezePanel.
 * Complexity: O(f) per update, f = number of failure reasons.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

function row(doc, label, value) {
  const r = doc.createElement('div');
  r.className = PHASE11_CSS.ROW;
  const l = doc.createElement('span'); l.className = PHASE11_CSS.LABEL; l.textContent = label;
  const v = doc.createElement('span'); v.className = PHASE11_CSS.VALUE; v.textContent = value === undefined || value === null ? '—' : String(value);
  r.appendChild(l); r.appendChild(v);
  return r;
}

export function createPhase11FreezePanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Research Freeze & Reproducibility';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /**
   * @param {{
   *   freeze: { id: string, ontologyVersion: string, generatorVersion: string, datasetSnapshotId: string|null, frozenAt: number },
   *   gateResult: { passed: boolean, failures: string[] } | null
   * }} data
   */
  function update(data) {
    body.textContent = '';
    if (!data || !data.freeze) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No active research freeze.';
      body.appendChild(empty);
      return;
    }
    const { freeze, gateResult } = data;
    body.appendChild(row(doc, 'Freeze ID', freeze.id));
    body.appendChild(row(doc, 'Ontology Version', freeze.ontologyVersion));
    body.appendChild(row(doc, 'Generator Version', freeze.generatorVersion));
    body.appendChild(row(doc, 'Dataset Snapshot', freeze.datasetSnapshotId));
    body.appendChild(row(doc, 'Frozen At', freeze.frozenAt ? new Date(freeze.frozenAt).toISOString() : '—'));

    if (gateResult) {
      const badge = doc.createElement('span');
      badge.className = `${PHASE11_CSS.BADGE} ${gateResult.passed ? PHASE11_CSS.BADGE_OK : PHASE11_CSS.BADGE_FAIL}`;
      badge.textContent = gateResult.passed ? 'Publication eligible' : 'Publication blocked';
      body.appendChild(badge);
      if (!gateResult.passed) {
        const list = doc.createElement('ul');
        for (const failure of gateResult.failures) {
          const li = doc.createElement('li');
          li.textContent = failure;
          list.appendChild(li);
        }
        body.appendChild(list);
      }
    }
  }

  update(null);
  return { element: panel, update };
}
