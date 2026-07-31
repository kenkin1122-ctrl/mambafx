/**
 * research/src/ui/Phase11Dashboard.js
 *
 * Purpose: composes every Phase11* panel into one tabbed dashboard. This is
 * the only file that imports more than one panel module -- it is the
 * "composition root" of the isolated UI, matching the directive's
 * requirement that the UI communicate only with Phase11Orchestrator
 * (through Phase11Application.js's refresh cycle) and never perform its
 * own scientific calculations. Each panel remains independently usable;
 * this file only arranges them and wires row-selection to detail updates.
 *
 * Dependencies: ui/Phase11Styles.js and every ui/Phase11*Panel.js /
 *   Phase11CandidateTable.js module. No legacy dependency, no direct
 *   IndexedDB access, no statistics computed here.
 * Public API: createPhase11Dashboard.
 * Complexity: O(1) structural; individual panel updates are O(n) in their
 *   own data as documented in each panel module.
 */

import { PHASE11_CSS, injectPhase11Styles } from './Phase11Styles.js';
import { createPhase11StatusPanel } from './Phase11StatusPanel.js';
import { createPhase11CampaignPanel } from './Phase11CampaignPanel.js';
import { createPhase11DiscoveryPanel } from './Phase11DiscoveryPanel.js';
import { createPhase11CandidateTable } from './Phase11CandidateTable.js';
import { createPhase11KnowledgeGraphPanel } from './Phase11KnowledgeGraphPanel.js';
import { createPhase11ExplainabilityPanel } from './Phase11ExplainabilityPanel.js';
import { createPhase11AuditPanel } from './Phase11AuditPanel.js';
import { createPhase11ScientificDebtPanel } from './Phase11ScientificDebtPanel.js';
import { createPhase11NegativeEvidencePanel } from './Phase11NegativeEvidencePanel.js';
import { createPhase11ConfigurationPanel } from './Phase11ConfigurationPanel.js';
import { createPhase11FreezePanel } from './Phase11FreezePanel.js';
import { createPhase11ResultsPanel } from './Phase11ResultsPanel.js';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'candidates', label: 'Candidate Explorer' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'campaign', label: 'Campaign' },
  { id: 'debt', label: 'Scientific Debt' },
  { id: 'results', label: 'Results' },
];

/**
 * @param {Document} doc
 * @param {{ onCandidateSelect?: (candidateId: string) => void }} [options]
 *   onCandidateSelect is invoked when a row in the Candidate Explorer is
 *   clicked -- Phase11Application.js uses this to fetch that candidate's
 *   detail (explanation/audit/KG chain/negative evidence) from the
 *   orchestrator and push it into this dashboard's detail panels via the
 *   returned handle's updateCandidateDetail().
 */
export function createPhase11Dashboard(doc, { onCandidateSelect } = {}) {
  injectPhase11Styles(doc);

  const root = doc.createElement('div');
  root.className = PHASE11_CSS.ROOT;

  const tabBar = doc.createElement('div');
  tabBar.className = PHASE11_CSS.TAB_BAR;
  root.appendChild(tabBar);

  const panels = {
    status: createPhase11StatusPanel(doc),
    discovery: createPhase11DiscoveryPanel(doc),
    candidateTable: createPhase11CandidateTable(doc, { onSelect: onCandidateSelect }),
    explainability: createPhase11ExplainabilityPanel(doc),
    knowledgeGraph: createPhase11KnowledgeGraphPanel(doc),
    audit: createPhase11AuditPanel(doc),
    negativeEvidence: createPhase11NegativeEvidencePanel(doc),
    scientificDebt: createPhase11ScientificDebtPanel(doc),
    configuration: createPhase11ConfigurationPanel(doc),
    freeze: createPhase11FreezePanel(doc),
    campaign: createPhase11CampaignPanel(doc),
    results: createPhase11ResultsPanel(doc),
  };

  const tabPanelEls = {};
  function makeTabPanel(id, children) {
    const el = doc.createElement('div');
    el.className = `${PHASE11_CSS.TAB_PANEL} ${PHASE11_CSS.TAB_PANEL_HIDDEN}`;
    for (const child of children) el.appendChild(child);
    tabPanelEls[id] = el;
    root.appendChild(el);
    return el;
  }

  makeTabPanel('dashboard', [panels.status.element, panels.discovery.element]);
  makeTabPanel('candidates', [
    panels.candidateTable.element,
    panels.explainability.element,
    panels.knowledgeGraph.element,
    panels.audit.element,
    panels.negativeEvidence.element,
  ]);
  makeTabPanel('configuration', [panels.configuration.element, panels.freeze.element]);
  makeTabPanel('campaign', [panels.campaign.element]);
  makeTabPanel('debt', [panels.scientificDebt.element]);
  makeTabPanel('results', [panels.results.element]);

  const tabButtons = {};
  function selectTab(tabId) {
    for (const t of TABS) {
      const isActive = t.id === tabId;
      tabPanelEls[t.id].className = `${PHASE11_CSS.TAB_PANEL} ${isActive ? '' : PHASE11_CSS.TAB_PANEL_HIDDEN}`.trim();
      tabButtons[t.id].className = `${PHASE11_CSS.TAB} ${isActive ? PHASE11_CSS.TAB_ACTIVE : ''}`.trim();
    }
  }
  for (const t of TABS) {
    const btn = doc.createElement('div');
    btn.className = PHASE11_CSS.TAB;
    btn.textContent = t.label;
    btn.addEventListener('click', () => selectTab(t.id));
    tabButtons[t.id] = btn;
    tabBar.appendChild(btn);
  }
  selectTab('dashboard');

  return {
    element: root,
    selectTab,
    /** @param {object|null} summary @see Phase11StatusPanel.update */
    updateStatus: (summary) => panels.status.update(summary),
    /** @param {object|null} discoverySummary @see Phase11DiscoveryPanel.update */
    updateDiscovery: (discoverySummary) => panels.discovery.update(discoverySummary),
    /** @param {object[]} rows @see Phase11CandidateTable.update */
    updateCandidates: (rows) => panels.candidateTable.update(rows),
    /** @param {object|null} campaignInfo @see Phase11CampaignPanel.update */
    updateCampaign: (campaignInfo) => panels.campaign.update(campaignInfo),
    /** @param {object[]} items @see Phase11ScientificDebtPanel.update */
    updateScientificDebt: (items) => panels.scientificDebt.update(items),
    /** @param {object[]} results @see Phase11ResultsPanel.update */
    updateResults: (results) => panels.results.update(results),
    /** @param {object|null} data @see Phase11FreezePanel.update */
    updateFreeze: (data) => panels.freeze.update(data),
    /**
     * Pushes per-candidate detail into the Candidate Explorer's detail
     * panels (Explainability / Knowledge Graph / Audit / Negative Evidence).
     * @param {{ explanation: object|null, chain: object[], auditEntries: object[], negativeEvidence: object[] }} detail
     */
    updateCandidateDetail: ({ explanation = null, chain = [], auditEntries = [], negativeEvidence = [] } = {}) => {
      panels.explainability.update(explanation);
      panels.knowledgeGraph.update(chain);
      panels.audit.update(auditEntries);
      panels.negativeEvidence.update(negativeEvidence);
    },
  };
}
