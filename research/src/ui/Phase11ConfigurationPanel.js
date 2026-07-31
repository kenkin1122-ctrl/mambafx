/**
 * research/src/ui/Phase11ConfigurationPanel.js
 *
 * Purpose: renders the "Configuration" dashboard requirement: Research
 * Configuration, Research Freeze, SAP, Dataset Manifest, Generator/
 * Ontology versions. Presentation only.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11ConfigurationPanel.
 * Complexity: O(1) per update.
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

export function createPhase11ConfigurationPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Configuration';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /**
   * @param {{
   *   researchConfigurationId: string, ontologyVersion: string, generatorVersion: string,
   *   researchFreezeId: string, sapId: string, datasetManifestId: string|null
   * }} configBundle
   */
  function update(configBundle) {
    body.textContent = '';
    if (!configBundle) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No configuration bundle available.';
      body.appendChild(empty);
      return;
    }
    body.appendChild(row(doc, 'Research Configuration', configBundle.researchConfigurationId));
    body.appendChild(row(doc, 'Ontology Version', configBundle.ontologyVersion));
    body.appendChild(row(doc, 'Generator Version', configBundle.generatorVersion));
    body.appendChild(row(doc, 'Research Freeze', configBundle.researchFreezeId));
    body.appendChild(row(doc, 'Statistical Analysis Plan', configBundle.sapId));
    body.appendChild(row(doc, 'Dataset Manifest', configBundle.datasetManifestId));
  }

  update(null);
  return { element: panel, update };
}
