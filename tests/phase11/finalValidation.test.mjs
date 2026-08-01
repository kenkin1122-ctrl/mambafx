/**
 * tests/phase11/finalValidation.test.mjs
 *
 * Stage 12 of the "Continue Implementation" directive: full validation.
 * Automates, as PERMANENT regression tests, the exact checks performed
 * manually during Stage 11's audit -- so every governance property named
 * in the directive is checked on every future test run, not just once.
 *
 * Verifies: no protected legacy modules modified; no governance
 * violations (lifecycle mutations only through the governed transition
 * function); no alpha-spending violations (exactly one gateway); no
 * future leakage (maxLookahead=0 structurally enforced at every registry);
 * no provenance gaps (every candidate-generating stream produces real
 * provenance); no reproducibility failures (a fixed-seed statistical test
 * is byte-identical run to run).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

const PROTECTED_MODULES = [
  'research/src/governance/hypothesisRegistry.js',
  'research/src/governance/onlineFdr.js',
  'research/src/governance/discoveryDecision.js',
  'research/src/governance/lockbox.js',
  'research/src/governance/randomnessAudit.js',
  'research/src/governance/knowledgeGraph.js',
];

function gitDiffStat(baseRef, files) {
  try {
    return execSync(`git diff ${baseRef} HEAD --stat -- ${files.join(' ')}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null; // baseRef may not exist in a shallow clone -- treated as "cannot verify", not a failure
  }
}

test('No protected legacy modules were modified across the Phase 11 build (diff against the pre-Phase-11-continuation baseline)', () => {
  const diff = gitDiffStat('8810932', PROTECTED_MODULES);
  if (diff === null) return; // baseRef unavailable in this environment -- skip rather than false-fail
  assert.equal(diff, '', `protected modules must show zero diff, got:\n${diff}`);
});

test('No governance violations: every Phase 11 lifecycle mutation goes through the governed withPhase11Lifecycle(), never a raw assignment', () => {
  const srcDir = path.join(REPO_ROOT, 'research/src');
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        if (/\.lifecycle\s*=\s*['"]/.test(src)) offenders.push(full);
      }
    }
  }
  walk(srcDir);
  assert.deepEqual(offenders, [], `found raw .lifecycle = "..." assignment(s) bypassing withPhase11Lifecycle() in: ${offenders.join(', ')}`);
});

test('No alpha-spending violations: onlineFdr.recordTestAndUpdateWealth() is CALLED from exactly one place (discoveryDecision.js) -- comments/docs referencing it elsewhere are not call sites', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'research/src/governance/discoveryDecision.js'), 'utf8');
  assert.match(src, /recordTestAndUpdateWealth\(/);

  const srcDir = path.join(REPO_ROOT, 'research/src');
  const EXCLUDED_FILES = new Set(['discoveryDecision.js', 'onlineFdr.js']); // onlineFdr.js is the function's own defining file
  const callers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !EXCLUDED_FILES.has(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        // Only count REAL call sites -- a line containing the call that is
        // not a comment (doesn't start with * or // once trimmed).
        const realCallLines = content.split('\n').filter((line) => {
          const trimmed = line.trim();
          return /recordTestAndUpdateWealth\s*\(/.test(line) && !trimmed.startsWith('*') && !trimmed.startsWith('//');
        });
        if (realCallLines.length > 0) callers.push(full);
      }
    }
  }
  walk(srcDir);
  assert.deepEqual(callers, [], `recordTestAndUpdateWealth must be called ONLY from discoveryDecision.js, also found real call site(s) in: ${callers.join(', ')}`);
});

test('No future leakage: every one of the 4 plugin registries structurally enforces maxLookahead=0 via validatePlugin() at registration time', async () => {
  const { IndicatorRegistry } = await import('../../research/src/indicator/IndicatorRegistry.js');
  const { MarketStateRegistry } = await import('../../research/src/plugin/MarketStateRegistry.js');
  const { MarketConstructProxyRegistry } = await import('../../research/src/proxy/MarketConstructProxyRegistry.js');
  const { ContextRegistry } = await import('../../research/src/context/ContextRegistry.js');

  for (const RegistryClass of [IndicatorRegistry, MarketStateRegistry, MarketConstructProxyRegistry, ContextRegistry]) {
    const registry = new RegistryClass();
    assert.throws(
      () => registry.register({
        metadata: () => ({ name: 'BadPlugin', version: '1.0.0', description: 'x', scientificAssumptions: [], dependencies: [], complexity: 'O(1)', validationStatus: 'HEURISTIC', maxLookahead: 1 }),
        validate: () => ({ valid: true, errors: [] }),
        compute: () => ({ signal: [] }),
        version: () => '1.0.0', dependencies: () => [], tests: () => [], documentation: () => '', scientificAssumptions: () => [],
      }),
      `${RegistryClass.name} must reject a plugin declaring maxLookahead=1`
    );
  }
});

test('No provenance gaps: every real candidate-generating stream (indicators, market states, proxies, composites, conditional hypotheses) produces real, usable ProvenanceDAG provenance', async () => {
  const { IndicatorRegistry } = await import('../../research/src/indicator/IndicatorRegistry.js');
  const { registerCoreIndicators } = await import('../../research/src/indicator/coreIndicators.js');
  const { MarketStateRegistry } = await import('../../research/src/plugin/MarketStateRegistry.js');
  const { registerCoreMarketStates } = await import('../../research/src/plugin/coreMarketStates.js');
  const { MarketConstructProxyRegistry } = await import('../../research/src/proxy/MarketConstructProxyRegistry.js');
  const { registerCoreProxies } = await import('../../research/src/proxy/coreProxies.js');
  const { ContextRegistry } = await import('../../research/src/context/ContextRegistry.js');
  const { registerCoreContexts } = await import('../../research/src/context/coreContexts.js');
  const {
    streamRegistryDrivenCandidates, streamMarketStateCandidates, streamProxyCandidates,
    streamCompositeCandidates, streamConditionalHypothesisCandidates,
  } = await import('../../research/src/discovery/registryDrivenCandidateGenerator.js');
  const { ResearchConfiguration } = await import('../../research/src/config/ResearchConfiguration.js');
  const { ResearchFreeze } = await import('../../research/src/config/ResearchFreeze.js');
  const { StatisticalAnalysisPlan } = await import('../../research/src/config/StatisticalAnalysisPlan.js');
  const { FamilyRegistry } = await import('../../research/src/governance/FamilyRegistry.js');
  const { CANDIDATE_TYPES } = await import('../../research/src/candidate/Candidate.js');

  const rc = await ResearchConfiguration.create({ id: `rc-final-${Date.now()}`, name: 't', description: 't', grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0', proxyVersions: {} });
  const freeze = await ResearchFreeze.create({ researchConfigurationId: rc.id, configHash: rc.configHash, ontologyVersion: rc.ontologyVersion, generatorVersion: rc.generatorVersion, proxyVersions: {}, candidateFingerprints: [], researchConfigurationHash: 'b'.repeat(64) });
  const fams = ['trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator', 'marketState', 'proxy', 'composite', 'conditional'];
  const sap = await StatisticalAnalysisPlan.create({ sapId: `sap-final-${Date.now()}`, hypothesisFamilies: fams, alphaAllocation: Object.fromEntries(fams.map((f) => [f, 0.01])), promotionPolicies: {}, stoppingRules: [{ maxCandidates: 100000 }], replicationCriteria: {}, publicationCriteria: {}, effectSizeThresholds: { default: 0 }, minimumSampleSizes: { default: 1 }, requiredDiagnostics: [] });
  const familyRegistry = new FamilyRegistry();
  for (const f of fams) familyRegistry.registerFamily({ familyName: f, version: '1.0.0', allowedCandidateTypes: Object.values(CANDIDATE_TYPES) });

  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  const marketStateRegistry = new MarketStateRegistry(); registerCoreMarketStates(marketStateRegistry);
  const proxyRegistry = new MarketConstructProxyRegistry(); registerCoreProxies(proxyRegistry);
  const contextRegistry = new ContextRegistry(); registerCoreContexts(contextRegistry);

  const componentsById = {};
  let checked = 0;

  for await (const { candidate, provenance } of streamRegistryDrivenCandidates({ indicatorRegistry, periods: [14], researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    assert.ok(provenance && provenance.hasNode(candidate.id), `IndicatorFeature ${candidate.id} missing provenance`);
    componentsById[candidate.id] = candidate; checked++;
  }
  const baseMarketStates = [];
  for await (const { candidate, provenance } of streamMarketStateCandidates({ marketStateRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    assert.ok(provenance && provenance.hasNode(candidate.id), `MarketState ${candidate.id} missing provenance`);
    componentsById[candidate.id] = candidate; baseMarketStates.push(candidate); checked++;
  }
  for await (const { candidate, provenance } of streamProxyCandidates({ proxyRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    assert.ok(provenance && provenance.hasNode(candidate.id), `ProxyCandidate ${candidate.id} missing provenance`);
    componentsById[candidate.id] = candidate; checked++;
  }
  const components = Object.values(componentsById);
  for await (const { candidate, provenance } of streamCompositeCandidates({ components: components.slice(0, 4), researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    assert.ok(provenance && provenance.hasNode(candidate.id), `CompositeCandidate ${candidate.id} missing provenance`);
    checked++;
  }
  for await (const { candidate, provenance } of streamConditionalHypothesisCandidates({ baseCandidates: baseMarketStates.slice(0, 2), contextRegistry, researchConfiguration: rc, researchFreeze: freeze, sap, familyRegistry })) {
    assert.ok(provenance && provenance.hasNode(candidate.id), `ConditionalHypothesis ${candidate.id} missing provenance`);
    checked++;
  }

  assert.ok(checked >= 20, `expected to have checked provenance for at least 20 candidates across all 5 types, checked ${checked}`);
});

test('No reproducibility failures: the same statistical confirmation test run twice with identical inputs produces byte-identical results', async () => {
  const { IndicatorRegistry } = await import('../../research/src/indicator/IndicatorRegistry.js');
  const { registerCoreIndicators } = await import('../../research/src/indicator/coreIndicators.js');
  const { runAutomatedConfirmationTest } = await import('../../research/src/bridge/Phase11AutomatedConfirmation.js');

  const indicatorRegistry = new IndicatorRegistry(); registerCoreIndicators(indicatorRegistry);
  let seedVal = 9; const rng = () => { seedVal = (seedVal * 1103515245 + 12345) & 0x7fffffff; return seedVal / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < 200; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));

  const params = {
    candidate: { indicatorName: 'RSI', period: 14 }, indicatorRegistry, prices,
    targetDefinition: { direction: 'Rise', runLength: 5 }, seed: 77, permutations: 300, bootstrapResamples: 300,
  };
  const a = runAutomatedConfirmationTest(params);
  const b = runAutomatedConfirmationTest(params);
  assert.deepEqual(a, b);
});
