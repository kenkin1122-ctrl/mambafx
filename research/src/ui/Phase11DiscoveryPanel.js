/**
 * research/src/ui/Phase11DiscoveryPanel.js
 *
 * Purpose: renders Round 1/2 funnel results (promoted/rejected counts,
 * excluded-incompatible counts). Presentation only -- consumes the plain
 * objects returned by Phase11Orchestrator.screen()/triage().
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11DiscoveryPanel.
 * Complexity: O(1) per update.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11DiscoveryPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Discovery Funnel';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  function statLine(label, value) {
    const r = doc.createElement('div');
    r.className = PHASE11_CSS.ROW;
    const l = doc.createElement('span'); l.className = PHASE11_CSS.LABEL; l.textContent = label;
    const v = doc.createElement('span'); v.className = PHASE11_CSS.VALUE; v.textContent = String(value);
    r.appendChild(l); r.appendChild(v);
    return r;
  }

  /**
   * @param {{ round1?: {promoted:number, rejected:number, excludedIncompatible:number},
   *           round2?: {promoted:number, rejected:number} }} discoverySummary
   */
  function update(discoverySummary) {
    body.textContent = '';
    if (!discoverySummary || (!discoverySummary.round1 && !discoverySummary.round2)) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No screening/triage results yet.';
      body.appendChild(empty);
      return;
    }
    if (discoverySummary.round1) {
      const h = doc.createElement('div'); h.className = PHASE11_CSS.LABEL; h.textContent = 'Round 1 — Screening';
      body.appendChild(h);
      body.appendChild(statLine('Promoted', discoverySummary.round1.promoted));
      body.appendChild(statLine('Rejected', discoverySummary.round1.rejected));
      body.appendChild(statLine('Excluded (family incompatible)', discoverySummary.round1.excludedIncompatible ?? 0));
    }
    if (discoverySummary.round2) {
      const h = doc.createElement('div'); h.className = PHASE11_CSS.LABEL; h.textContent = 'Round 2 — Triage';
      body.appendChild(h);
      body.appendChild(statLine('Promoted', discoverySummary.round2.promoted));
      body.appendChild(statLine('Rejected', discoverySummary.round2.rejected));
    }
  }

  update(null);
  return { element: panel, update };
}
