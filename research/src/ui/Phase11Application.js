/**
 * research/src/ui/Phase11Application.js
 *
 * Purpose: the ONE public entry point for the isolated Phase 11 UI --
 * mountPhase11(container, orchestrator, options). Everything else in
 * research/src/ui/ is an implementation detail of this function.
 *
 * Isolation guarantees:
 *   - No import from index.html or any legacy module.
 *   - No direct IndexedDB access -- all data comes from the supplied
 *     Phase11Orchestrator's public methods (getCampaignSummary,
 *     listCandidates, explain, checkPublicationEligibility, etc.) or from
 *     optional caller-supplied callbacks (getExplainInputs,
 *     getKnowledgeGraphChain) -- this file never computes statistics or
 *     duplicates backend logic; if a callback isn't supplied, the relevant
 *     detail panel simply shows "not available" rather than fabricating data.
 *   - Mountable anywhere: `container` only needs to be a DOM element with
 *     an ownerDocument (or the caller can pass `options.document`
 *     explicitly) -- works inside or outside index.html, inside a test
 *     harness, or in a completely separate page.
 *
 * Dependencies: ui/Phase11Dashboard.js (composition root) only.
 * Public API: mountPhase11, Phase11UIError.
 * Complexity: refresh() is O(n) in candidate count (one row/detail lookup
 *   per candidate); selectCandidate() is O(1) plus whatever the supplied
 *   getExplainInputs/getKnowledgeGraphChain callbacks cost.
 */

import { createPhase11Dashboard } from './Phase11Dashboard.js';

export class Phase11UIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11UIError';
  }
}

/**
 * @param {Element} container - Any DOM element to mount the dashboard into.
 * @param {import('../orchestration/Phase11Orchestrator.js').Phase11Orchestrator|null} [orchestrator]
 *   Optional at mount time -- if omitted, the dashboard mounts in an honest
 *   idle state ("no active research cycle") rather than fabricating
 *   placeholder campaign data. Call the returned handle's
 *   attachOrchestrator() once a real Phase11Orchestrator (backed by a real
 *   ResearchFreeze/SAP) becomes available.
 * @param {object} [options]
 * @param {Document} [options.document] - Explicit document, if `container`
 *   doesn't have an `ownerDocument` (e.g. a detached test element).
 * @param {(candidate: object) => object|null} [options.getExplainInputs]
 *   Given a candidate, returns the ExplainabilityEngine input bundle
 *   (plainEnglishSummary, mathDefinition, contextDescription, interpretation,
 *   knownLimitations, uncertainty, ...) for that candidate, or null/undefined
 *   if none is available yet. This app never invents these values itself.
 * @param {(candidateId: string) => Promise<object[]>|object[]} [options.getKnowledgeGraphChain]
 *   Given a candidate id, returns the ordered chain of
 *   { nodeType, label } steps to display in the Knowledge Graph panel.
 * @param {() => object[]} [options.getScientificDebtItems] - Returns the
 *   current open ScientificDebtLog items, if the caller wants them shown.
 * @param {(candidate: object) => {passed: boolean, failures: string[]}|null} [options.checkPublication]
 *   Given a candidate, returns its publication-eligibility result (e.g. via
 *   orchestrator.checkPublicationEligibility(candidate, config)), or null.
 * @returns {{
 *   refresh: () => void, selectCandidate: (id: string) => Promise<void>,
 *   attachOrchestrator: (orchestrator: object) => void, unmount: () => void
 * }}
 */
export function mountPhase11(container, orchestrator = null, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Phase11UIError('mountPhase11: "container" must be a DOM element with appendChild()');
  }
  if (orchestrator && typeof orchestrator.getCampaignSummary !== 'function') {
    throw new Phase11UIError('mountPhase11: "orchestrator", if supplied, must be a Phase11Orchestrator instance');
  }
  const doc = options.document || container.ownerDocument;
  if (!doc) {
    throw new Phase11UIError('mountPhase11: no Document available; pass options.document explicitly');
  }

  const { getExplainInputs, getKnowledgeGraphChain, getScientificDebtItems, checkPublication } = options;
  let activeOrchestrator = orchestrator;
  let selectedCandidateId = null;

  const dashboard = createPhase11Dashboard(doc, {
    onCandidateSelect: (candidateId) => { selectCandidate(candidateId); },
  });
  container.appendChild(dashboard.element);

  function buildCandidateRows() {
    return activeOrchestrator.listCandidates().map((c) => ({
      id: c.id,
      lifecycle: c.lifecycle,
      evidenceTier: c.evidenceTier,
      importance: c.scientificImportance ?? '—',
      confidence: c.confidenceLevel ?? '—',
      reproducibilityLevel: c.reproducibilityLevel ?? '—',
      scientificDebtCount: '—',
      negativeEvidenceCount: activeOrchestrator.negativeEvidenceRegistry.rejectionCount(c.fingerprint),
    }));
  }

  async function selectCandidate(candidateId) {
    selectedCandidateId = candidateId;
    if (!activeOrchestrator) return;
    const candidate = activeOrchestrator.getCandidate(candidateId);
    if (!candidate) {
      dashboard.updateCandidateDetail({});
      return;
    }

    const auditEntries = activeOrchestrator.decisionAuditLog.forCandidate(candidateId).map((e) => e.toJSON());
    const negativeEvidence = activeOrchestrator.negativeEvidenceRegistry
      .byFingerprint(candidate.fingerprint)
      .map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e));

    let explanation = null;
    if (typeof getExplainInputs === 'function') {
      const inputs = getExplainInputs(candidate);
      if (inputs) {
        try {
          explanation = activeOrchestrator.explain(candidate, inputs);
        } catch {
          explanation = null; // insufficient/invalid inputs -- show "not available" rather than a partial/misleading explanation
        }
      }
    }

    let chain = [];
    if (typeof getKnowledgeGraphChain === 'function') {
      chain = (await getKnowledgeGraphChain(candidateId)) || [];
    }

    dashboard.updateCandidateDetail({ explanation, chain, auditEntries, negativeEvidence });

    if (typeof checkPublication === 'function') {
      const gateResult = checkPublication(candidate);
      dashboard.updateFreeze({ freeze: activeOrchestrator.researchFreeze, gateResult });
    }
  }

  function refresh() {
    if (!activeOrchestrator) {
      dashboard.updateStatus(null); // honest idle state -- "No active research cycle"
      dashboard.updateCandidates([]);
      dashboard.updateCampaign(null);
      dashboard.updateFreeze(null);
      return;
    }
    dashboard.updateStatus(activeOrchestrator.getCampaignSummary());
    dashboard.updateCandidates(buildCandidateRows());
    dashboard.updateCampaign({
      sapId: activeOrchestrator.sap.sapId,
      registeredFamilies: activeOrchestrator.familyRegistry ? activeOrchestrator.familyRegistry.listFamilies() : [],
    });
    dashboard.updateFreeze({ freeze: activeOrchestrator.researchFreeze, gateResult: null });
    if (typeof getScientificDebtItems === 'function') {
      dashboard.updateScientificDebt(getScientificDebtItems());
    }
    if (selectedCandidateId) {
      selectCandidate(selectedCandidateId);
    }
  }

  refresh();

  return {
    refresh,
    selectCandidate,
    /**
     * Wires a real Phase11Orchestrator in after mount (e.g. once a
     * research cycle actually starts) and immediately refreshes.
     * @param {object} newOrchestrator
     */
    attachOrchestrator: (newOrchestrator) => {
      if (!newOrchestrator || typeof newOrchestrator.getCampaignSummary !== 'function') {
        throw new Phase11UIError('attachOrchestrator: a Phase11Orchestrator instance is required');
      }
      activeOrchestrator = newOrchestrator;
      refresh();
    },
    unmount: () => {
      if (dashboard.element.parentNode === container) {
        container.removeChild(dashboard.element);
      }
    },
  };
}
