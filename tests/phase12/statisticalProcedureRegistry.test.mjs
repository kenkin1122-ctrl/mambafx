/**
 * tests/phase12/statisticalProcedureRegistry.test.mjs
 *
 * Tests for bridge/StatisticalProcedureRegistry.js -- refinement #4:
 * registry-resolved statistical procedure dispatch, replacing what would
 * otherwise become hard-coded type checks in Confirmation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import { runAutomatedConfirmationTest } from '../../research/src/bridge/Phase11AutomatedConfirmation.js';
import {
  StatisticalProcedureRegistry, StatisticalProcedureRegistryError, registerCorePermutationTestProcedures,
} from '../../research/src/bridge/StatisticalProcedureRegistry.js';
import { CANDIDATE_TYPES } from '../../research/src/candidate/Candidate.js';

function makeWalkPrices(seed = 9, length = 200) {
  let state = seed;
  const rng = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const prices = [100];
  for (let i = 0; i < length; i++) prices.push(prices[prices.length - 1] + (rng() < 0.5 ? 1 : -1));
  return prices;
}

// ═══════════════════════════════════════════════════════════════════════════
// Registry contract
// ═══════════════════════════════════════════════════════════════════════════

test('StatisticalProcedureRegistry: register/lookup/has/list/listTypes/unregister', () => {
  const registry = new StatisticalProcedureRegistry();
  const fn = () => 'result';
  registry.register(CANDIDATE_TYPES.INDICATOR_FEATURE, fn);
  assert.equal(registry.size, 1);
  assert.equal(registry.has(CANDIDATE_TYPES.INDICATOR_FEATURE), true);
  assert.equal(registry.lookup(CANDIDATE_TYPES.INDICATOR_FEATURE), fn);
  assert.deepEqual(registry.listTypes(), [CANDIDATE_TYPES.INDICATOR_FEATURE]);
  assert.deepEqual(registry.list(), [fn]);
  assert.equal(registry.unregister(CANDIDATE_TYPES.INDICATOR_FEATURE), true);
  assert.equal(registry.size, 0);
});

test('StatisticalProcedureRegistry: rejects a non-string type, a non-function procedure, and a duplicate registration', () => {
  const registry = new StatisticalProcedureRegistry();
  assert.throws(() => registry.register('', () => {}), StatisticalProcedureRegistryError);
  assert.throws(() => registry.register('SomeType', 'not-a-function'), StatisticalProcedureRegistryError);
  registry.register('SomeType', () => {});
  assert.throws(() => registry.register('SomeType', () => {}), StatisticalProcedureRegistryError);
});

test('StatisticalProcedureRegistry.run(): throws for an unregistered candidate type -- never silently falls back to the wrong test or none at all', () => {
  const registry = new StatisticalProcedureRegistry();
  registry.register(CANDIDATE_TYPES.INDICATOR_FEATURE, () => 'ok');
  assert.throws(() => registry.run({ candidate: { type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE } }), StatisticalProcedureRegistryError);
  assert.throws(() => registry.run({ candidate: {} }), StatisticalProcedureRegistryError);
  assert.throws(() => registry.run({}), StatisticalProcedureRegistryError);
});

test('StatisticalProcedureRegistry.run(): dispatches to the correct registered procedure and passes params through unchanged', () => {
  const registry = new StatisticalProcedureRegistry();
  let receivedParams = null;
  registry.register('TypeA', (params) => { receivedParams = params; return 'result-A'; });
  registry.register('TypeB', () => 'result-B');

  const params = { candidate: { type: 'TypeA' }, extra: 42 };
  const result = registry.run(params);
  assert.equal(result, 'result-A');
  assert.equal(receivedParams, params);
});

// ═══════════════════════════════════════════════════════════════════════════
// registerCorePermutationTestProcedures: zero-behavior-change proof
// ═══════════════════════════════════════════════════════════════════════════

test('registerCorePermutationTestProcedures: registers all 5 pre-Phase-12 candidate types', () => {
  const registry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(registry);
  assert.equal(registry.size, 5);
  assert.deepEqual(registry.listTypes().sort(), [
    CANDIDATE_TYPES.COMPOSITE_CANDIDATE, CANDIDATE_TYPES.CONDITIONAL_HYPOTHESIS,
    CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.MARKET_STATE, CANDIDATE_TYPES.PROXY_CANDIDATE,
  ].sort());
});

test('registerCorePermutationTestProcedures: EventProcessFeature is deliberately NOT registered yet (Null Model Hierarchy does not exist)', () => {
  const registry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(registry);
  assert.equal(registry.has(CANDIDATE_TYPES.EVENT_PROCESS_FEATURE), false);
});

test('zero behavior change: dispatching an IndicatorFeature confirmation through the registry produces a BYTE-IDENTICAL report to calling runAutomatedConfirmationTest directly', () => {
  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const prices = makeWalkPrices();
  const params = {
    candidate: { type: CANDIDATE_TYPES.INDICATOR_FEATURE, indicatorName: 'RSI', period: 14 },
    indicatorRegistry, prices, targetDefinition: { direction: 'Rise', runLength: 5 },
    seed: 77, permutations: 200, bootstrapResamples: 200,
  };

  const direct = runAutomatedConfirmationTest(params);

  const registry = new StatisticalProcedureRegistry();
  registerCorePermutationTestProcedures(registry);
  const viaRegistry = registry.run(params);

  assert.deepEqual(direct, viaRegistry);
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../../research/src/bridge/StatisticalProcedureRegistry.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
});
