/**
 * research/src/ui/Phase11ExplainabilityPanel.js
 *
 * Purpose: renders the full explanation object produced by
 * interpretation/ExplainabilityEngine.js (via Phase11Orchestrator.explain()):
 * plain English, mathematics (human-readable + LaTeX + note that the
 * executable formula exists), assumptions/limitations, uncertainty, and the
 * standing PRNG disclaimer. Presentation only -- performs no computation.
 *
 * Dependencies: ui/Phase11Styles.js.
 * Public API: createPhase11ExplainabilityPanel.
 * Complexity: O(1) per update (fixed explanation shape).
 */

import { PHASE11_CSS } from './Phase11Styles.js';

export function createPhase11ExplainabilityPanel(doc) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const title = doc.createElement('div');
  title.className = PHASE11_CSS.PANEL_TITLE;
  title.textContent = 'Explainability';
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(title);
  panel.appendChild(body);

  function block(label, textContent) {
    const wrap = doc.createElement('div');
    const l = doc.createElement('div'); l.className = PHASE11_CSS.LABEL; l.textContent = label;
    const v = doc.createElement('div'); v.className = PHASE11_CSS.VALUE; v.textContent = textContent;
    wrap.appendChild(l); wrap.appendChild(v);
    return wrap;
  }

  /** @param {ReturnType<import('../interpretation/ExplainabilityEngine.js').explainCandidate>|null} explanation */
  function update(explanation) {
    body.textContent = '';
    if (!explanation) {
      const empty = doc.createElement('div');
      empty.className = PHASE11_CSS.EMPTY;
      empty.textContent = 'Select a candidate to view its explanation.';
      body.appendChild(empty);
      return;
    }
    body.appendChild(block('Plain English', explanation.plainEnglish));
    body.appendChild(block('Mathematics (human-readable)', explanation.mathematics.humanReadable));
    body.appendChild(block('Mathematics (LaTeX)', explanation.mathematics.symbolicExpression));
    body.appendChild(block('Units / Domain / Range',
      `${explanation.mathematics.units} — domain: ${explanation.mathematics.domain} — range: ${explanation.mathematics.range}`));
    body.appendChild(block('Context', explanation.contextDescription));
    body.appendChild(block('Interpretation', explanation.interpretation));
    body.appendChild(block('Known limitations', explanation.knownLimitations.join('; ')));
    const u = explanation.uncertainty;
    body.appendChild(block('Uncertainty',
      `estimate=${u.estimate}, se=${u.se}, 95% CI=[${u.ci95[0]}, ${u.ci95[1]}], n=${u.sampleSize}, replications=${u.replicationCount}`));
    if (explanation.scientificImportance !== null) body.appendChild(block('Scientific importance', String(explanation.scientificImportance)));
    if (explanation.tradingImportance !== null) body.appendChild(block('Trading importance', String(explanation.tradingImportance)));
    if (explanation.discoveryStabilityIndex !== null) body.appendChild(block('Discovery stability index', String(explanation.discoveryStabilityIndex)));
    body.appendChild(block('Evidence tier / Implementation maturity', `${explanation.evidenceTier} / ${explanation.implementationMaturity}`));
    if (explanation.operationalTradingNote) body.appendChild(block('Operational note', explanation.operationalTradingNote));

    const disclaimer = doc.createElement('div');
    disclaimer.className = PHASE11_CSS.DISCLAIMER;
    disclaimer.textContent = explanation.disclaimer;
    body.appendChild(disclaimer);
  }

  update(null);
  return { element: panel, update };
}
