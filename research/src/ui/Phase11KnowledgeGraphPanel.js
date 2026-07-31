/**
 * research/src/ui/Phase11KnowledgeGraphPanel.js
 *
 * Purpose: visualizes the Measurement -> Feature -> Context -> Proxy ->
 * Candidate -> Discovery chain for a selected candidate, directive's
 * "Knowledge Graph" dashboard requirement. Presentation only -- this panel
 * never queries IndexedDB or knowledgeGraph.js itself; the embedding app
 * fetches the chain via governance/phase11KnowledgeGraphBridge.js and
 * governance/knowledgeGraph.js's own read functions, then passes the
 * already-resolved chain in as a plain array.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11KnowledgeGraphPanel.
 * Complexity: O(n) per update, n = chain length.
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11KnowledgeGraphPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Knowledge Graph';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  /**
   * @param {{ nodeType: string, label: string }[]} chain - Ordered from
   *   Measurement through Discovery/Publication for one candidate.
   */
  function update(chain) {
    body.textContent = '';
    if (!Array.isArray(chain) || chain.length === 0) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'No chain available for this selection.';
      body.appendChild(empty);
      return;
    }
    const list = doc.createElement('div');
    chain.forEach((step, i) => {
      const stepEl = doc.createElement('div');
      stepEl.className = PHASE11_CSS.ROW;
      const badge = doc.createElement('span');
      badge.className = PHASE11_CSS.BADGE;
      badge.textContent = step.nodeType;
      const label = doc.createElement('span');
      label.className = PHASE11_CSS.VALUE;
      label.textContent = step.label;
      stepEl.appendChild(badge);
      stepEl.appendChild(label);
      list.appendChild(stepEl);
      if (i < chain.length - 1) {
        const arrow = doc.createElement('div');
        arrow.textContent = '↓';
        arrow.style.textAlign = 'center';
        arrow.style.color = '#8b909a';
        list.appendChild(arrow);
      }
    });
    body.appendChild(list);
  }

  update([]);
  return { element: panel, update };
}
