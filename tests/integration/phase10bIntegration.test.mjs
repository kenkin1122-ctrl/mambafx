/**
 * tests/integration/phase10bIntegration.test.mjs
 *
 * Cross-cutting checks for Phase 10B: schedulerState.js and
 * healthMonitor.js composed together the same way bootstrap.js's boot()
 * sequence composes them, plus a lightweight contract check on
 * dashboardUI.js's exports.
 *
 * Scope note: this repository deliberately has zero external npm
 * dependencies (pure-JS, `node --test` only), so there is no DOM
 * implementation available to actually execute bootstrap.js's boot()
 * or dashboardUI.js's render() (both touch `document`/`window` DOM
 * APIs a real browser provides). Rather than add a new dependency
 * (e.g. jsdom) to work around that, this file verifies the exact
 * *data-flow sequence* bootstrap.js's Phase 10B addition performs
 * (restore -> refresh feature flag -> persist -> health report reads it
 * back) directly, and confirms dashboardUI.js's public API shape is
 * intact. Real-DOM behavior (does the Health Monitor panel actually
 * paint in a browser) has NOT been executed anywhere in this test
 * suite or by hand -- this sandbox has no browser/GUI available. That
 * remains an open, honestly-flagged verification gap; see the
 * verification report's "Scope honesty note."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting as resetSchedDb } from '../../research/integration/schedulerState.js';
import { _resetConnectionCacheForTesting as resetGovDb } from '../../research/src/storage/researchGovernanceDb.js';
import {
  restoreSchedulerState,
  saveSchedulerState,
  SCHEDULER_MODES,
} from '../../research/integration/schedulerState.js';
import { getHealthReport, startHealthMonitor, stopHealthMonitor, _resetForTesting } from '../../research/integration/healthMonitor.js';
import * as dashboardUI from '../../research/integration/dashboardUI.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  resetSchedDb();
  resetGovDb();
  _resetForTesting();
  return teardown;
}

test('bootstrap-equivalent sequence: restore -> refresh feature flag -> persist -> health report reflects the restored+refreshed state', async () => {
  const teardown = setup();
  try {
    // Mirrors bootstrap.js's boot(): first-ever boot restores the default.
    const { state, persistenceAvailable } = await restoreSchedulerState();
    const refreshed = { ...state, featureFlagState: true };
    assert.equal(persistenceAvailable, true);
    await saveSchedulerState(refreshed);

    startHealthMonitor({ target: new EventTarget(), intervalMs: 0 });
    const report = await getHealthReport();

    assert.equal(report.research.featureFlagEnabled, false, 'featureFlagEnabled reflects window.MSD_RESEARCH_ENGINE_ENABLED, unset in this Node test context');
    assert.equal(report.scheduler.mode, SCHEDULER_MODES.MANUAL);
    assert.equal(report.storage.persistenceAvailable, true);
    stopHealthMonitor();
  } finally { await teardown(); }
});

test('a second boot (simulated refresh) after the first restores the persisted mode and does not replay a stale running status', async () => {
  const teardown = setup();
  try {
    const first = await restoreSchedulerState();
    await saveSchedulerState({ ...first.state, mode: SCHEDULER_MODES.AUTOMATIC, featureFlagState: true, schedulerStatus: 'running', queue: 1 });

    resetSchedDb(); // simulate the DB connection a fresh page load would open
    const second = await restoreSchedulerState();
    assert.equal(second.state.mode, SCHEDULER_MODES.AUTOMATIC);
    assert.equal(second.state.schedulerStatus, 'idle');
    assert.equal(second.state.queue, 0);

    // Mirrors bootstrap.js's own boot() sequence: the normalized restore
    // result is persisted back immediately, so healthMonitor.js's
    // getCurrentSnapshotForMonitoring() (a raw, un-normalized read) also
    // reflects the safe idle state, not the pre-restore "running" record.
    await saveSchedulerState(second.state);

    const report = await getHealthReport();
    assert.equal(report.scheduler.mode, SCHEDULER_MODES.AUTOMATIC);
    assert.equal(report.scheduler.schedulerStatus, 'idle');
  } finally { await teardown(); }
});

test('dashboardUI.js exports its expected public API shape (contract check only -- real DOM rendering has not been executed; see verification report)', () => {
  assert.equal(typeof dashboardUI.initDashboardUI, 'function');
  assert.equal(typeof dashboardUI.renderDisabledNotice, 'function');
  assert.equal(typeof dashboardUI.reportCampaignStepResult, 'function');
});
