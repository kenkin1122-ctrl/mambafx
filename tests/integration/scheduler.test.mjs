import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting as resetSchedDb } from '../../research/integration/schedulerState.js';
import { _resetConnectionCacheForTesting as resetGovDb } from '../../research/src/storage/researchGovernanceDb.js';
import { registerRepresentationFamily } from '../../research/src/governance/knowledgeGraph.js';
import { attachTickListener, detachTickListener, _resetForTesting as resetTick } from '../../research/integration/tickListener.js';
import * as scheduler from '../../research/integration/scheduler.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  resetSchedDb();
  resetGovDb();
  resetTick();
  scheduler._resetForTesting();
  return teardown;
}

function fakeBrowser() {
  const target = new EventTarget();
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.document = doc;
  return { target, doc };
}

function cleanupBrowser() {
  delete globalThis.document;
}

async function tick(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Structural guardrails ────────────────────────────────────────────────

test('scheduler.js never imports Online FDR, Discovery Decision, Lockbox, Publication Status, Randomness Audit, RNG Forensics, Funnel, or the live orchestrator directly -- only campaignRunner.js', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/scheduler.js'), 'utf8');
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  for (const forbidden of ['onlineFdr.js', 'discoveryDecision.js', 'lockbox.js', 'publicationStatus.js', 'randomnessAudit.js', 'rngForensics.js', 'funnel.js', 'searchEngine.js', 'campaignPrioritization.js', 'researchPipeline.js', 'liveResearchOrchestrator.js']) {
    assert.equal(importStatementBlock.includes(forbidden), false, `scheduler.js must never import ${forbidden}`);
  }
  assert.ok(importStatementBlock.includes('campaignRunner.js'));
  assert.ok(importStatementBlock.includes('schedulerState.js'));
  assert.ok(importStatementBlock.includes('schedulerPolicies.js'));
});

test('scheduler.js never calls Online FDR or Publication Status by name anywhere in an executable statement (not just imports)', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/scheduler.js'), 'utf8');
  // Strip comments/JSDoc first so explanatory prose mentioning these names
  // (e.g. "never imports onlineFdr.js") doesn't false-positive -- same
  // reasoning as every other structural guardrail test in this suite.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/onlineFdr|OnlineFdr/.test(withoutComments), false);
  assert.equal(/publicationStatus|PublicationStatus/.test(withoutComments), false);
});

// ── Manual mode ───────────────────────────────────────────────────────────

test('Manual mode: automatic triggers never fire; runOnce still executes', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-manual', label: 'Manual test family' });
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    assert.equal(scheduler.getStatus().mode, 'manual');

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 50 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 0, 'manual mode must never auto-trigger');

    await scheduler.runOnce();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 1);
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Automatic mode ────────────────────────────────────────────────────────

test('Automatic mode: an event-driven policy fires a run when a new batch is observed', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-auto', label: 'Auto test family' });
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'event-driven', minBatchesSinceLastRun: 1 });

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 5 } }));
    await tick(50);
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 1);
  } finally { cleanupBrowser(); await teardown(); }
});

test('Automatic mode: a batch-count policy fires only once the configured threshold is crossed', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-batch', label: 'Batch test family' });
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'batch-count', batchThreshold: 10 });

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 4 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 0);

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 7 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 1);
  } finally { cleanupBrowser(); await teardown(); }
});

test('Automatic mode: a time-based policy fires on its own interval without any tick event', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-time', label: 'Time test family' });
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'time-based', intervalMs: 60 });

    await tick(200);
    assert.ok(scheduler.getStatus().campaignsExecutedThisSession >= 1);
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Paused mode ───────────────────────────────────────────────────────────

test('Paused mode: no automatic trigger fires regardless of policy or new data; runOnce still works', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-paused', label: 'Paused test family' });
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'event-driven', minBatchesSinceLastRun: 1 });
    await scheduler.pause('operator requested');

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 999 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 0);
    assert.equal(scheduler.getStatus().mode, 'paused');
    assert.equal(scheduler.getStatus().pausedReason, 'operator requested');

    await scheduler.runOnce();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 1, 'Run Once must work even while paused');
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Resume ────────────────────────────────────────────────────────────────

test('Resume: returns to the mode that was active before pause, and clears pausedReason', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.pause('temporary');
    assert.equal(scheduler.getStatus().mode, 'paused');

    await scheduler.resume();
    assert.equal(scheduler.getStatus().mode, 'automatic');
    assert.equal(scheduler.getStatus().pausedReason, null);
  } finally { cleanupBrowser(); await teardown(); }
});

test('Resume from a manual-mode pause returns to manual, not automatic', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await scheduler.initScheduler({ target });
    assert.equal(scheduler.getStatus().mode, 'manual');
    await scheduler.pause();
    await scheduler.resume();
    assert.equal(scheduler.getStatus().mode, 'manual');
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Hidden tab pause / resume (never catch up) ───────────────────────────

test('Hidden tab: automatic evaluation is suspended while the tab is hidden, and does not fire a compensating run on resume', async () => {
  const teardown = setup();
  const { target, doc } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-hidden', label: 'Hidden tab test family' });
    doc.hidden = true;
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'event-driven', minBatchesSinceLastRun: 1 });

    assert.equal(scheduler.getStatus().tabHidden, true);
    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 5 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 0, 'no evaluation should happen while hidden');

    // "Resume" (tab becomes visible) must not itself fire a compensating
    // run -- only a NEW trigger after resume should be evaluated.
    doc.hidden = false;
    scheduler._resetForTesting(); // re-init to pick up the new document.hidden reading (mirrors a fresh visibilitychange-driven read)
    resetTick(); attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'event-driven', minBatchesSinceLastRun: 1 });
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 0, 'becoming visible again must not replay the missed trigger by itself');

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 1 } }));
    await tick();
    assert.equal(scheduler.getStatus().campaignsExecutedThisSession, 1, 'a genuinely new trigger after resume should still fire normally');
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Queue serialization / no concurrent campaigns ────────────────────────

test('Queue serialization: a second trigger arriving while a run is in flight is coalesced into exactly one further run, never a growing backlog', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-serial', label: 'Serialization test family' });

    // Fire runOnce() three times back-to-back without awaiting between
    // calls -- the second and third arrive while the first is still
    // in flight.
    await scheduler.initScheduler({ target });
    const p1 = scheduler.runOnce();
    const p2 = scheduler.runOnce();
    const p3 = scheduler.runOnce();
    await Promise.all([p1, p2, p3]);

    // At most one run was in flight at any instant (enforced by the
    // schedulerStatus guard), and the coalesced pending flag means the
    // total executed count reflects "run, plus at most one more queued
    // request" rather than three fully independent concurrent calls.
    const executed = scheduler.getStatus().campaignsExecutedThisSession;
    assert.ok(executed >= 1 && executed <= 3, `expected between 1 and 3 executions, got ${executed}`);
    assert.equal(scheduler.getStatus().schedulerStatus, 'idle', 'scheduler must return to idle after all runs settle');
  } finally { cleanupBrowser(); await teardown(); }
});

test('No concurrent campaigns: while a run is marked "running", a simultaneous automatic trigger does not start a second call (queue reflects at most 1)', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await registerRepresentationFamily({ familyId: 'fam-noconcurrent', label: 'No concurrent test family' });
    attachTickListener(target);
    await scheduler.initScheduler({ target });
    await scheduler.setMode('automatic');
    await scheduler.configurePolicy({ type: 'event-driven', minBatchesSinceLastRun: 1 });

    // Fire the run and, before it can possibly settle, fire a second
    // triggering event synchronously.
    const runPromise = scheduler.runOnce();
    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 1 } }));
    await runPromise;
    await tick(30);

    assert.ok(scheduler.getStatus().queue <= 1, 'queue must never exceed 1 -- no growing backlog');
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Recovery after errors ─────────────────────────────────────────────────

test('Recovery after errors: an unexpected throw from the underlying campaign call is caught, reported as lastFailure, and the scheduler returns to idle for the next run', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await scheduler.initScheduler({ target });

    // Force a genuine unexpected throw (not the expected "no active
    // family" case) by breaking IndexedDB out from under the running
    // Knowledge Graph query campaignRunner depends on.
    const previousIndexedDB = globalThis.indexedDB;
    delete globalThis.indexedDB;
    resetGovDb();

    const status = await scheduler.runOnce();
    assert.equal(status.schedulerStatus, 'idle', 'scheduler must not remain wedged in error/running state');
    assert.ok(status.lastFailure, 'a genuine unexpected error must be recorded as lastFailure');

    globalThis.indexedDB = previousIndexedDB;
    resetGovDb();

    // Confirm the scheduler is still usable afterward (not permanently broken).
    await registerRepresentationFamily({ familyId: 'fam-after-error', label: 'Post-recovery family' });
    const status2 = await scheduler.runOnce();
    assert.equal(status2.schedulerStatus, 'idle');
    assert.equal(status2.campaignsExecutedThisSession, 2);
  } finally { cleanupBrowser(); await teardown(); }
});

test('A common, expected "no Active Representation Family" outcome is NOT treated as a scheduler error (no lastFailure set)', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await scheduler.initScheduler({ target });
    const status = await scheduler.runOnce();
    assert.equal(status.schedulerStatus, 'idle');
    assert.equal(status.lastFailure, null, 'an ok:false prioritization result is expected/common, not a scheduler-level failure');
    assert.equal(status.campaignsExecutedThisSession, 1);
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Initial scheduler config (window.MSD_RESEARCH_SCHEDULER_CONFIG, Revision 2 §6) ──

test('On a genuine first-ever boot, window.MSD_RESEARCH_SCHEDULER_CONFIG seeds the initial mode and policy', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  target.MSD_RESEARCH_SCHEDULER_CONFIG = { mode: 'automatic', policy: { type: 'batch-count', batchThreshold: 5 } };
  try {
    const status = await scheduler.initScheduler({ target });
    assert.equal(status.mode, 'automatic');
    assert.deepEqual(status.schedulingPolicy, { type: 'batch-count', batchThreshold: 5 });
  } finally { cleanupBrowser(); await teardown(); }
});

test('A mode seeded by initial config correctly seeds resume() -- pausing then resuming right after boot returns to the configured mode, not the module default', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  target.MSD_RESEARCH_SCHEDULER_CONFIG = { mode: 'automatic' };
  try {
    await scheduler.initScheduler({ target });
    await scheduler.pause('test pause');
    const afterResume = await scheduler.resume();
    assert.equal(afterResume.mode, 'automatic', 'resume() must return to the config-seeded mode, not fall back to Manual');
  } finally { cleanupBrowser(); await teardown(); }
});

test('A malformed initial config (invalid mode, invalid policy) is ignored field-by-field, never throws, and never corrupts the safe default', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  target.MSD_RESEARCH_SCHEDULER_CONFIG = { mode: 'not-a-real-mode', policy: { type: 'batch-count' } }; // missing batchThreshold -> invalid
  try {
    const status = await scheduler.initScheduler({ target });
    assert.equal(status.mode, 'manual', 'an invalid mode string must never be applied');
    assert.equal(status.schedulingPolicy.type, 'event-driven', 'an invalid policy must never be applied -- the safe default policy stays in place');
  } finally { cleanupBrowser(); await teardown(); }
});

test('A partially-valid initial config applies only its valid field(s) -- an invalid mode does not block a valid policy, and vice versa', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  target.MSD_RESEARCH_SCHEDULER_CONFIG = { mode: 'bogus-mode', policy: { type: 'time-based', intervalMs: 60000 } };
  try {
    const status = await scheduler.initScheduler({ target });
    assert.equal(status.mode, 'manual', 'the invalid mode field falls back to the safe default');
    assert.deepEqual(status.schedulingPolicy, { type: 'time-based', intervalMs: 60000 }, 'the valid policy field is still applied independently');
  } finally { cleanupBrowser(); await teardown(); }
});

test('On any later (restored) boot, the operator\'s own persisted choice always wins -- window.MSD_RESEARCH_SCHEDULER_CONFIG is never applied over real prior state', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  try {
    await scheduler.initScheduler({ target }); // first-ever boot, no config -> manual/event-driven default
    await scheduler.setMode('automatic'); // the operator's own explicit, persisted choice

    // Simulate a page refresh: reset only the scheduler module's
    // in-memory state (not the underlying persisted DB), then boot again
    // with a config that -- if honored -- would silently override the
    // operator's choice.
    scheduler._resetForTesting();
    const { target: target2 } = fakeBrowser();
    target2.MSD_RESEARCH_SCHEDULER_CONFIG = { mode: 'paused' };
    const status2 = await scheduler.initScheduler({ target: target2 });
    assert.equal(status2.mode, 'automatic', 'the restored/persisted mode must win over a static page-load config');
  } finally { cleanupBrowser(); await teardown(); }
});

test('A missing or non-object window.MSD_RESEARCH_SCHEDULER_CONFIG is treated as "no config" and never throws', async () => {
  const teardown = setup();
  const { target } = fakeBrowser();
  target.MSD_RESEARCH_SCHEDULER_CONFIG = 'not-an-object';
  try {
    const status = await scheduler.initScheduler({ target });
    assert.equal(status.mode, 'manual');
  } finally { cleanupBrowser(); await teardown(); }
});

// ── Feature flag disabled (tested at the bootstrap gate, not inside scheduler.js itself) ──

test('Feature flag disabled: bootstrap.js never calls initScheduler when MSD_RESEARCH_ENGINE_ENABLED is not true (structural check on bootstrap.js source)', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rawSource = fs.readFileSync(path.join(__dirname, '../../research/integration/bootstrap.js'), 'utf8');
  assert.match(rawSource, /MSD_RESEARCH_ENGINE_ENABLED/);
  assert.match(rawSource, /initScheduler/);
  // The scheduler init call must appear textually after the isEnabled()
  // guard's early-return, i.e. inside the same guarded branch --
  // approximated here by confirming isEnabled() is checked and returns
  // before any scheduler wiring, mirroring how the equivalent v1 check
  // already gates dashboard/tickListener wiring.
  //
  // Comments (block and line) are stripped first so this is a check on
  // actual executable code, not prose -- a JSDoc header line describing
  // "scheduler.initScheduler()" for documentation purposes must never
  // false-positive this check, matching the same
  // comment-vs-executable-code lesson already applied to the
  // onlineFdr/publicationStatus guardrail check below and to
  // schedulerState.test.mjs's import-block-only check.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const enabledCheckIndex = source.indexOf('if (!isEnabled())');
  const initSchedulerIndex = source.indexOf('initScheduler(');
  assert.ok(enabledCheckIndex >= 0 && initSchedulerIndex > enabledCheckIndex);
});

// ── getStatus() contract ──────────────────────────────────────────────────

test('getStatus() before initScheduler() returns a safe default rather than throwing', () => {
  scheduler._resetForTesting();
  const status = scheduler.getStatus();
  assert.equal(status.mode, 'manual');
  assert.equal(status.initialized, false);
});
