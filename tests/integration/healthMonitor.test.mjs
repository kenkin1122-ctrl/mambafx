import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting as resetSchedDb, saveSchedulerState, createDefaultSchedulerState, SCHEDULER_MODES, SCHEDULER_STATUSES } from '../../research/integration/schedulerState.js';
import { _resetConnectionCacheForTesting as resetGovDb } from '../../research/src/storage/researchGovernanceDb.js';
import {
  getHealthReport,
  runDiagnosticsOnce,
  computeHealthIndicator,
  startHealthMonitor,
  stopHealthMonitor,
  _resetForTesting,
} from '../../research/integration/healthMonitor.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  resetSchedDb();
  resetGovDb();
  _resetForTesting();
  return teardown;
}

// ── Structural guardrail: read-only, no scientific decision imports ─────

test('healthMonitor.js never imports a discovery/funnel/onlineFdr/publicationStatus/lockbox/randomnessAudit EXECUTION module -- only knowledgeGraph.js\'s read-only query export', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/healthMonitor.js'), 'utf8');
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  for (const forbidden of ['onlineFdr.js', 'discoveryDecision.js', 'lockbox.js', 'publicationStatus.js', 'funnel.js', 'rngForensics.js', 'randomnessAudit.js', 'liveResearchOrchestrator.js', 'campaignPrioritization.js', 'searchEngine.js']) {
    assert.equal(importStatementBlock.includes(forbidden), false, `healthMonitor.js must never import ${forbidden}`);
  }
  assert.ok(importStatementBlock.includes('knowledgeGraph.js'));
});

// ── computeHealthIndicator: pure function, deterministic thresholds ─────

test('computeHealthIndicator: healthy system reports green with no issues', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'manual', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟢');
});

test('computeHealthIndicator: scheduler error state reports red', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'error', mode: 'manual', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🔴');
  assert.match(r.explanation, /error state/);
});

test('computeHealthIndicator: persistence unavailable reports red', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'manual', queue: 0 },
    storage: { persistenceAvailable: false },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🔴');
});

test('computeHealthIndicator: offline reports yellow', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'manual', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: false, totalExceptions: 0, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟡');
  assert.match(r.explanation, /offline/);
});

test('computeHealthIndicator: automatic mode + hidden tab reports yellow (expected pause, not an error)', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'automatic', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'hidden' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟡');
});

test('computeHealthIndicator: paused mode + hidden tab is healthy (no automatic work is expected anyway)', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'paused', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'hidden' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟢');
});

test('computeHealthIndicator: queue growth (queue > 0) reports yellow', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'automatic', queue: 1 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 0, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟡');
  assert.match(r.explanation, /queued/);
});

test('computeHealthIndicator: exceptions observed reports yellow with a count in the explanation', () => {
  const r = computeHealthIndicator({
    scheduler: { schedulerStatus: 'idle', mode: 'manual', queue: 0 },
    storage: { persistenceAvailable: true },
    system: { onlineState: true, totalExceptions: 3, browserVisibilityState: 'visible' },
    diagnostics: { databaseConnectivity: true, featureFlagConsistent: true },
  });
  assert.equal(r.level, '🟡');
  assert.match(r.explanation, /3 exception/);
});

// ── getHealthReport() integration with schedulerState ────────────────────

test('getHealthReport reflects a persisted scheduler snapshot (mode, queue, campaign counters)', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.mode = SCHEDULER_MODES.AUTOMATIC;
    s.campaignsExecutedLifetime = 9;
    s.currentlyRunningCampaign = 'fam-health-test';
    await saveSchedulerState(s);

    const report = await getHealthReport();
    assert.equal(report.scheduler.mode, SCHEDULER_MODES.AUTOMATIC);
    assert.equal(report.research.campaignsExecuted, 9);
    assert.equal(report.research.currentDiscoveryCampaign, 'fam-health-test');
    assert.ok(report.indicator.level);
  } finally { await teardown(); }
});

test('getHealthReport degrades gracefully (does not throw) when no scheduler state has ever been saved', async () => {
  const teardown = setup();
  try {
    const report = await getHealthReport();
    assert.equal(report.scheduler.mode, SCHEDULER_MODES.MANUAL);
    assert.equal(report.scheduler.schedulerStatus, SCHEDULER_STATUSES.IDLE);
  } finally { await teardown(); }
});

// ── exception reporting via startHealthMonitor/stopHealthMonitor ────────

test('startHealthMonitor records a window error event as an exception, without suppressing default handling', async () => {
  const teardown = setup();
  try {
    const target = new EventTarget();
    startHealthMonitor({ target, intervalMs: 0 });

    let defaultPrevented = false;
    const evt = new Event('error', { cancelable: true });
    evt.message = 'synthetic test error';
    target.dispatchEvent(evt);
    defaultPrevented = evt.defaultPrevented;

    const report = await getHealthReport();
    assert.equal(report.system.totalExceptions, 1);
    assert.equal(report.system.lastException.message, 'synthetic test error');
    assert.equal(defaultPrevented, false, 'the health monitor must never call preventDefault on an error event');

    stopHealthMonitor({ target });
  } finally { await teardown(); }
});

test('stopHealthMonitor fully detaches listeners (no further exceptions recorded after stop)', async () => {
  const teardown = setup();
  try {
    const target = new EventTarget();
    startHealthMonitor({ target, intervalMs: 0 });
    stopHealthMonitor({ target });

    const evt = new Event('error');
    evt.message = 'should not be recorded';
    target.dispatchEvent(evt);

    const report = await getHealthReport();
    assert.equal(report.system.totalExceptions, 0);
  } finally { await teardown(); }
});

// ── runDiagnosticsOnce ────────────────────────────────────────────────────

test('runDiagnosticsOnce reports queue consistency and feature-flag consistency against a real persisted snapshot', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.queue = 0;
    s.featureFlagState = true;
    await saveSchedulerState(s);
    globalThis.window = { MSD_RESEARCH_ENGINE_ENABLED: true };

    const diag = await runDiagnosticsOnce();
    assert.equal(diag.queueConsistent, true);
    assert.equal(diag.persistenceReachable, true);
    assert.equal(diag.databaseConnectivity, true);
    assert.equal(diag.featureFlagConsistent, true);

    delete globalThis.window;
  } finally { await teardown(); }
});

test('runDiagnosticsOnce flags feature-flag inconsistency when the live flag and persisted snapshot disagree', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.featureFlagState = true;
    await saveSchedulerState(s);
    globalThis.window = { MSD_RESEARCH_ENGINE_ENABLED: false };

    const diag = await runDiagnosticsOnce();
    assert.equal(diag.featureFlagConsistent, false);

    delete globalThis.window;
  } finally { await teardown(); }
});
