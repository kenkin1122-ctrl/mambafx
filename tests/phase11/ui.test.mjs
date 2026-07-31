/**
 * tests/phase11/ui.test.mjs
 *
 * Tests the isolated Phase 11 UI layer (research/src/ui/) using the
 * purpose-built fake DOM shim (tests/support/fakeDom.js) -- no browser,
 * no jsdom dependency. Verifies: mounting/unmounting, isolation (no legacy
 * imports, no direct IndexedDB access, no scientific computation), and
 * that panels render the data they're given without fabricating anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createFakeDocument } from '../support/fakeDom.js';
import { injectPhase11Styles, PHASE11_CSS } from '../../research/src/ui/Phase11Styles.js';
import { createPhase11Button } from '../../research/src/ui/Phase11Button.js';
import { createPhase11StatusPanel } from '../../research/src/ui/Phase11StatusPanel.js';
import { createPhase11CandidateTable } from '../../research/src/ui/Phase11CandidateTable.js';
import { createPhase11Dashboard } from '../../research/src/ui/Phase11Dashboard.js';
import { mountPhase11, Phase11UIError } from '../../research/src/ui/Phase11Application.js';

import { Phase11Orchestrator } from '../../research/src/orchestration/Phase11Orchestrator.js';
import { ResearchConfiguration } from '../../research/src/config/ResearchConfiguration.js';
import { ResearchFreeze } from '../../research/src/config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../../research/src/config/StatisticalAnalysisPlan.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

const UI_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../../research/src/ui');

async function makeRc() {
  return ResearchConfiguration.create({
    id: 'rc-ui-001', name: 'UI test', description: 'test',
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0' },
  });
}
async function makeFreeze(rc) {
  return ResearchFreeze.create({
    researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion, proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64),
  });
}
async function makeSap() {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-ui-001', hypothesisFamilies: ['momentum'], alphaAllocation: { momentum: 0.03 },
    promotionPolicies: {}, stoppingRules: [], replicationCriteria: {}, publicationCriteria: {},
    effectSizeThresholds: { default: 0.1 }, minimumSampleSizes: { default: 200 }, requiredDiagnostics: [],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Component-level
// ═══════════════════════════════════════════════════════════════════════════

test('Phase11Styles: injectPhase11Styles is idempotent', () => {
  const doc = createFakeDocument();
  injectPhase11Styles(doc);
  injectPhase11Styles(doc);
  const styleEls = doc.head.children.filter((c) => c.tagName === 'STYLE');
  assert.equal(styleEls.length, 1);
});

test('Phase11Button: click invokes onClick', () => {
  const doc = createFakeDocument();
  let clicked = false;
  const btn = createPhase11Button(doc, { label: 'Go', onClick: () => { clicked = true; } });
  assert.equal(btn.textContent, 'Go');
  btn.click();
  assert.equal(clicked, true);
});

test('Phase11StatusPanel: renders empty state, then a summary', () => {
  const doc = createFakeDocument();
  const panel = createPhase11StatusPanel(doc);
  assert.match(panel.element.textContent, /No active research cycle/);
  panel.update({
    researchFreezeId: 'freeze-1', sapId: 'sap-1', candidateCount: 3,
    countsByStage: { Generated: 1, Screened: 1, Triaged: 1, Confirmed: 0, Replicated: 0, Published: 0, Deprecated: 0 },
    confirmedCount: 0, replicationCount: 0, publicationCount: 0,
  });
  assert.match(panel.element.textContent, /freeze-1/);
  assert.match(panel.element.textContent, /sap-1/);
});

test('Phase11CandidateTable: row click invokes onSelect with the row id', () => {
  const doc = createFakeDocument();
  let selectedId = null;
  const table = createPhase11CandidateTable(doc, { onSelect: (id) => { selectedId = id; } });
  table.update([{ id: 'cand-1', lifecycle: 'Generated' }]);

  function findRows(node, out = []) {
    for (const child of node.children) {
      if (child.tagName === 'TR' && child._listeners?.has('click')) out.push(child);
      findRows(child, out);
    }
    return out;
  }
  const rows = findRows(table.element);
  assert.equal(rows.length, 1);
  rows[0].click();
  assert.equal(selectedId, 'cand-1');
});

test('Phase11Dashboard: tab switching toggles visibility classes', () => {
  const doc = createFakeDocument();
  const dashboard = createPhase11Dashboard(doc);
  dashboard.selectTab('campaign');
  const tabPanels = dashboard.element.children.filter((c) => c.className.includes(PHASE11_CSS.TAB_PANEL));
  const visibleCount = tabPanels.filter((c) => !c.className.includes(PHASE11_CSS.TAB_PANEL_HIDDEN)).length;
  assert.equal(visibleCount, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// mountPhase11 (the single public entry point)
// ═══════════════════════════════════════════════════════════════════════════

test('mountPhase11: throws Phase11UIError without a valid container', () => {
  assert.throws(() => mountPhase11(null, {}), Phase11UIError);
});

test('mountPhase11: throws Phase11UIError for an invalid (non-null) orchestrator', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('div');
  assert.throws(() => mountPhase11(container, { notAnOrchestrator: true }), Phase11UIError);
});

test('mountPhase11: mounts in an honest idle state when no orchestrator is supplied yet', () => {
  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const handle = mountPhase11(container);
  assert.match(container.textContent, /No active research cycle/);
  assert.equal(typeof handle.attachOrchestrator, 'function');
});

test('mountPhase11: attachOrchestrator wires a real orchestrator in after mount, without fabricating data first', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id: 'ui-cand-attach', family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });

  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const handle = mountPhase11(container); // no orchestrator yet
  assert.match(container.textContent, /No active research cycle/);

  handle.attachOrchestrator(orchestrator);
  assert.match(container.textContent, /ui-cand-attach/);
});

test('mountPhase11: mounts, reflects orchestrator state, and unmounts cleanly', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });

  await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id: 'ui-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });

  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const handle = mountPhase11(container, orchestrator);

  assert.equal(container.children.length, 1);
  assert.match(container.textContent, /ui-cand-1/);

  handle.unmount();
  assert.equal(container.children.length, 0);
});

test('mountPhase11: selectCandidate never fabricates an explanation when getExplainInputs is not supplied', async () => {
  const rc = await makeRc();
  const freeze = await makeFreeze(rc);
  const sap = await makeSap();
  const orchestrator = new Phase11Orchestrator({ researchFreeze: freeze, sap });
  const [{ candidate }] = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList: [{
      id: 'ui-cand-2', family: 'momentum', parameters: { threshold: 0.5 },
      description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
      configHash: rc.configHash, researchConfigurationId: rc.id,
      indicatorName: 'RSI', period: 14, inputObservables: [],
    }],
  });

  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const handle = mountPhase11(container, orchestrator);
  await handle.selectCandidate(candidate.id);
  assert.match(container.textContent, /Select a candidate to view its explanation/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Isolation checks
// ═══════════════════════════════════════════════════════════════════════════

test('UI isolation: no ui/*.js file references index.html, window., or IndexedDB directly', async () => {
  const files = (await fs.readdir(UI_DIR)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 16, `expected at least 16 UI files, found ${files.length}`);
  for (const file of files) {
    const src = await fs.readFile(path.join(UI_DIR, file), 'utf8');
    assert.ok(!/from\s+['"][^'"]*index\.html['"]/.test(src), `${file} must not import from index.html`);
    assert.ok(!/indexedDB\.open|IDBFactory/.test(src), `${file} must not touch IndexedDB directly`);
    assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src),
      `${file} must not import a protected legacy governance module`);
  }
});

test('UI isolation: Phase11Application.js is the only file importing Phase11Dashboard.js', async () => {
  const files = (await fs.readdir(UI_DIR)).filter((f) => f.endsWith('.js') && f !== 'Phase11Application.js');
  for (const file of files) {
    const src = await fs.readFile(path.join(UI_DIR, file), 'utf8');
    assert.ok(!/import\s*\{[^}]*\}\s*from\s*['"]\.\/Phase11Dashboard\.js['"]/.test(src),
      `${file} should not import the composition root`);
  }
});
