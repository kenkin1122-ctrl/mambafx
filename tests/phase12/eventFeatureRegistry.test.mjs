/**
 * tests/phase12/eventFeatureRegistry.test.mjs
 *
 * Tests for eventProcess/EventFeatureRegistry.js and coreEventFeatures.js
 * -- Phase 12 Milestone 1's first slice: the fifth plugin registry,
 * structurally identical to the other four, with a real, tested,
 * event-local-only feature roster.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EventFeatureRegistry, EventFeatureRegistryError, computeEventLocalFeatures } from '../../research/src/eventProcess/EventFeatureRegistry.js';
import { TimeGapPlugin, TickGapPlugin, AlternatingRunPlugin, CORE_EVENT_FEATURE_PLUGINS, registerCoreEventFeatures } from '../../research/src/eventProcess/coreEventFeatures.js';

const EVENT = { eventId: 'evt-2', timestamp: 1750, tickIndex: 83, runDirection: 'FALL' };
const PREVIOUS = { eventId: 'evt-1', timestamp: 1000, tickIndex: 50, runDirection: 'RISE' };

// ═══════════════════════════════════════════════════════════════════════════
// EventFeatureRegistry itself -- same contract as the other 4 registries
// ═══════════════════════════════════════════════════════════════════════════

test('EventFeatureRegistry: register/lookup/has/list/listNames/unregister behave exactly like the other plugin registries', () => {
  const registry = new EventFeatureRegistry();
  registry.register(TimeGapPlugin);
  assert.equal(registry.size, 1);
  assert.equal(registry.has('TimeGap'), true);
  assert.equal(registry.lookup('TimeGap'), TimeGapPlugin);
  assert.deepEqual(registry.listNames(), ['TimeGap']);
  assert.deepEqual(registry.list(), [TimeGapPlugin]);
  assert.equal(registry.unregister('TimeGap'), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.unregister('TimeGap'), false);
});

test('EventFeatureRegistry: rejects a plugin not conforming to PluginContract, and rejects a duplicate name', () => {
  const registry = new EventFeatureRegistry();
  assert.throws(() => registry.register({ metadata: () => ({ name: 'Incomplete' }) }), EventFeatureRegistryError);
  registry.register(TimeGapPlugin);
  assert.throws(() => registry.register(TimeGapPlugin), EventFeatureRegistryError);
});

test('EventFeatureRegistry: structurally enforces maxLookahead=0, same as every other registry', () => {
  const registry = new EventFeatureRegistry();
  const noncompliant = {
    metadata: () => ({ name: 'FutureLeak', version: '1.0.0', description: 'x', scientificAssumptions: [], dependencies: [], complexity: 'O(1)', validationStatus: 'THEORETICAL', maxLookahead: 1 }),
    validate: () => ({ valid: true, errors: [] }),
    compute: () => ({ signal: 0 }),
    version: () => '1.0.0', dependencies: () => [], tests: () => [], documentation: () => '', scientificAssumptions: () => [],
  };
  assert.throws(() => registry.register(noncompliant), EventFeatureRegistryError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Core event-local feature plugins: real values, honest nulls, no rolling state
// ═══════════════════════════════════════════════════════════════════════════

test('TimeGapPlugin: computes real elapsed wall-clock time, returns null (not zero, not a crash) with no predecessor', () => {
  assert.equal(TimeGapPlugin.compute({ event: EVENT, previousEvent: PREVIOUS }).signal, 750);
  assert.equal(TimeGapPlugin.compute({ event: EVENT, previousEvent: null }).signal, null);
});

test('TickGapPlugin: computes real elapsed tick count, returns null with no predecessor', () => {
  assert.equal(TickGapPlugin.compute({ event: EVENT, previousEvent: PREVIOUS }).signal, 33);
  assert.equal(TickGapPlugin.compute({ event: EVENT, previousEvent: null }).signal, null);
});

test('AlternatingRunPlugin: correctly detects direction change vs. repetition, returns null with no predecessor', () => {
  assert.equal(AlternatingRunPlugin.compute({ event: EVENT, previousEvent: PREVIOUS }).signal, 1); // FALL != RISE
  assert.equal(AlternatingRunPlugin.compute({ event: PREVIOUS, previousEvent: PREVIOUS }).signal, 0); // same direction
  assert.equal(AlternatingRunPlugin.compute({ event: EVENT, previousEvent: null }).signal, null);
});

test('every core event-feature plugin declares maxLookahead=0 and a THEORETICAL validation status (a raw measurement, not yet a validated predictor)', () => {
  for (const plugin of CORE_EVENT_FEATURE_PLUGINS) {
    const meta = plugin.metadata();
    assert.equal(meta.maxLookahead, 0, `${meta.name} must declare maxLookahead=0`);
    assert.equal(meta.validationStatus, 'THEORETICAL');
  }
});

test('registerCoreEventFeatures: registers all 3 core plugins in one call', () => {
  const registry = new EventFeatureRegistry();
  registerCoreEventFeatures(registry);
  assert.equal(registry.size, 3);
  assert.deepEqual(registry.listNames().sort(), ['AlternatingRun', 'TickGap', 'TimeGap']);
});

// ═══════════════════════════════════════════════════════════════════════════
// computeEventLocalFeatures: the ONLY entry point that calls plugin.compute()
// ═══════════════════════════════════════════════════════════════════════════

test('computeEventLocalFeatures: computes every registered feature for a real event pair in one call', () => {
  const registry = new EventFeatureRegistry();
  registerCoreEventFeatures(registry);
  const features = computeEventLocalFeatures(registry, EVENT, PREVIOUS);
  assert.deepEqual(features, { TimeGap: 750, TickGap: 33, AlternatingRun: 1 });
});

test('computeEventLocalFeatures: every feature is honestly null for the first event of a session (no predecessor), never a fabricated default', () => {
  const registry = new EventFeatureRegistry();
  registerCoreEventFeatures(registry);
  const features = computeEventLocalFeatures(registry, PREVIOUS, null);
  assert.deepEqual(features, { TimeGap: null, TickGap: null, AlternatingRun: null });
});

test('computeEventLocalFeatures: throws for a missing registry or missing current event, before attempting any computation', () => {
  assert.throws(() => computeEventLocalFeatures(null, EVENT, PREVIOUS), EventFeatureRegistryError);
  const registry = new EventFeatureRegistry();
  assert.throws(() => computeEventLocalFeatures(registry, null, PREVIOUS), EventFeatureRegistryError);
});

// ═══════════════════════════════════════════════════════════════════════════
// Refinement #1 (event-local only, no rolling/windowed state) -- verified structurally
// ═══════════════════════════════════════════════════════════════════════════

test('refinement #1: no core event-feature plugin accepts or references a window/period-style parameter -- structurally event-local only', () => {
  for (const plugin of CORE_EVENT_FEATURE_PLUGINS) {
    const withExtra = plugin.compute({ event: EVENT, previousEvent: PREVIOUS, windowSize: 999, history: [1, 2, 3] });
    const withoutExtra = plugin.compute({ event: EVENT, previousEvent: PREVIOUS });
    assert.deepEqual(withExtra, withoutExtra, `${plugin.metadata().name} must be unaffected by extraneous windowing-style parameters -- it should never have looked for them`);
  }
});

test('never touches onlineFdr.js/discoveryDecision.js/hypothesisRegistry.js/lockbox.js/randomnessAudit.js/knowledgeGraph.js directly', async () => {
  const fs = await import('node:fs');
  for (const file of ['../../research/src/eventProcess/EventFeatureRegistry.js', '../../research/src/eventProcess/coreEventFeatures.js']) {
    const src = await fs.promises.readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit|knowledgeGraph)\.js['"]/.test(src));
  }
});
