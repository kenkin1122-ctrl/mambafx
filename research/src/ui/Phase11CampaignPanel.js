/**
 * research/src/ui/Phase11CampaignPanel.js
 *
 * Purpose: renders campaign-level settings (SAP identity, registered
 * hypothesis families, promotion quantiles/thresholds). Presentation only.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11CampaignPanel.
 * Complexity: O(f) in number of registered families per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11CampaignPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Campaign';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /**
   * @param {{ sapId: string, hypothesisFamilies: string[], effectSizeThresholds: object,
   *   registeredFamilies: {familyName: string, version: string, allowedCandidateTypes: string[]}[] }} campaignInfo
   */
  function update(campaignInfo) {
    body.textContent = '';
    if (!campaignInfo) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No campaign configured.';
      body.appendChild(empty);
      return;
    }
    const sapLine = doc.createElement('div');
    sapLine.className = PHASE11_CSS.ROW;
    sapLine.innerHTML = '';
    const l1 = doc.createElement('span'); l1.className = PHASE11_CSS.LABEL; l1.textContent = 'SAP';
    const v1 = doc.createElement('span'); v1.className = PHASE11_CSS.VALUE; v1.textContent = campaignInfo.sapId;
    sapLine.appendChild(l1); sapLine.appendChild(v1);
    body.appendChild(sapLine);

    const famTitle = doc.createElement('div');
    famTitle.className = PHASE11_CSS.LABEL;
    famTitle.textContent = 'Registered families:';
    body.appendChild(famTitle);

    const list = doc.createElement('ul');
    for (const fam of campaignInfo.registeredFamilies || []) {
      const li = doc.createElement('li');
      li.textContent = `${fam.familyName} v${fam.version} — ${fam.allowedCandidateTypes.join(', ')}`;
      list.appendChild(li);
    }
    if (!(campaignInfo.registeredFamilies || []).length) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No families registered.';
      body.appendChild(empty);
    } else {
      body.appendChild(list);
    }
  }

  update(null);
  return { element: panel, update };
}
