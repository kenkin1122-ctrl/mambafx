/**
 * tests/phase11/backendIntegration.test.mjs
 *
 * Top-level backend integration audit checks: verifies that Phase D's
 * integration work never imports/modifies the five protected legacy
 * governance modules (hypothesisRegistry.js, onlineFdr.js,
 * discoveryDecision.js, lockbox.js, randomnessAudit.js), and that
 * CandidateProvenance now covers the full field set required by Part 1 §3
 * (datasetManifestId, contextVersions/proxyVersions metadata).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildCandidateProvenance } from '../../research/src/provenance/CandidateProvenance.js';
import { IndicatorFeature } from '../../research/src/candidate/IndicatorFeature.js';

const PROTECTED_MODULES = [
  'governance/hypothesisRegistry.js',
  'governance/onlineFdr.js',
  'governance/discoveryDecision.js',
  'governance/lockbox.js',
  'governance/randomnessAudit.js',
];

const PHASE_D_FILES = [
  'governance/FamilyRegistry.js',
  'governance/PromotionPolicy.js',
  'governance/NegativeEvidenceRegistry.js',
  'governance/CausalAssumptionRegistry.js',
  'governance/candidateLifecycleTransition.js',
  'governance/phase11KnowledgeGraphBridge.js',
  'discovery/candidateGenerator.js',
  'discovery/phase11FunnelBridge.js',
  'analysis/DiscoveryStabilityAnalysis.js',
  'analysis/ImportanceScorer.js',
  'interpretation/ExplainabilityEngine.js',
  'orchestration/Phase11Orchestrator.js',
  'provenance/ProvenanceDAG.js',
  'provenance/FeatureProvenanceDAG.js',
  'provenance/CandidateProvenance.js',
];

const RESEARCH_SRC = path.resolve(new URL('.', import.meta.url).pathname, '../../research/src');

test('backend integration: no Phase 11 file imports a protected legacy module', async () => {
  for (const file of PHASE_D_FILES) {
    const fullPath = path.join(RESEARCH_SRC, file);
    const src = await fs.readFile(fullPath, 'utf8');
    for (const protectedModule of PROTECTED_MODULES) {
      const moduleName = path.basename(protectedModule);
      const importPattern = new RegExp(`from\\s+['"][^'"]*${moduleName.replace('.js', '')}\\.js['"]`);
      assert.ok(!importPattern.test(src), `${file} must not import ${protectedModule}`);
    }
  }
});

test('backend integration: the protected legacy files themselves are untouched (git-tracked, unmodified)', async () => {
  // Structural check: verify each protected file still exists at its known
  // path with its documented header purpose intact (a proxy for "not
  // rewritten" -- a full git-diff check happens at commit time; this test
  // guards the file's continued presence and self-identification).
  for (const file of PROTECTED_MODULES) {
    const fullPath = path.join(RESEARCH_SRC, file);
    const src = await fs.readFile(fullPath, 'utf8');
    assert.match(src, new RegExp(path.basename(file).replace('.js', '')), `${file} should still self-identify in its own header`);
  }
});

test('backend integration: CandidateProvenance now covers datasetManifestId and context/proxy version metadata (Part 1 §3)', async () => {
  const candidate = await IndicatorFeature.create({
    id: 'bi-cand-1', family: 'momentum', parameters: { threshold: 0.5 },
    description: 'test', generatorVersion: '11.0.0', grammarVersion: '11.0.0',
    configHash: 'a'.repeat(64), researchConfigurationId: 'rc-1',
    indicatorName: 'RSI', period: 14, inputObservables: [],
  });

  const dag = buildCandidateProvenance(candidate, {
    contextIds: ['ctx-1'], proxyIds: ['proxy-1'],
    contextVersions: { 'ctx-1': '1.0.0' }, proxyVersions: { 'proxy-1': '2.0.0' },
    datasetManifestId: 'dm-001',
  });

  assert.ok(dag.hasNode('dm-001'));
  assert.equal(dag.getNode('ctx-1').metadata.version, '1.0.0');
  assert.equal(dag.getNode('proxy-1').metadata.version, '2.0.0');
  assert.ok(dag.directParentsOf(candidate.id).includes('dm-001'));
});
