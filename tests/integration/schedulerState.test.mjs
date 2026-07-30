import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import {
  SCHEDULER_STATE_SCHEMA_VERSION,
  SCHEDULER_MODES,
  SCHEDULER_STATUSES,
  createDefaultSchedulerState,
  validateSchedulerState,
  saveSchedulerState,
  restoreSchedulerState,
  getCurrentSnapshotForMonitoring,
  appendAuditLogEntry,
  listRecentAuditLog,
  _resetConnectionCacheForTesting,
} from '../../research/integration/schedulerState.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

// ── Structural guardrail: zero scientific dependency ─────────────────────

test('schedulerState.js imports nothing from research/src/discovery or research/src/governance -- only the generic append-only adapter', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/schedulerState.js'), 'utf8');
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  assert.equal(/research\/src\/discovery/.test(importStatementBlock), false);
  assert.equal(/research\/src\/governance/.test(importStatementBlock), false);
  assert.ok(importStatementBlock.includes('appendOnlyAdapter.js'));
});

test('schedulerState.js uses its own dedicated IndexedDB database name and never imports researchGovernanceDb.js (structurally cannot open the scientific DB)', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = fs.readFileSync(path.join(__dirname, '../../research/integration/schedulerState.js'), 'utf8');
  // The dedicated DB name constant must be present (this is the DB it
  // actually opens); prose comments are free to mention the *other*
  // databases by name when explaining why there's no dependency on them
  // (same "inspect only real import statements, not whole-file prose"
  // reasoning already established by campaignPrioritization.test.mjs's
  // own structural guardrail) -- so the real, meaningful check is the
  // import statement block, not a blanket whole-file substring search.
  assert.match(source, /mfx_research_scheduler_state/);
  const importStatementBlock = [...source.matchAll(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm)].map((m) => m[0]).join('\n');
  assert.equal(importStatementBlock.includes('researchGovernanceDb.js'), false);
  assert.equal(importStatementBlock.includes('existingDbExtensions.js'), false);
});

// ── save / restore ────────────────────────────────────────────────────────

test('restoreSchedulerState on a completely fresh DB returns the safe default state, restored:false', async () => {
  const teardown = setup();
  try {
    const { state, restored, persistenceAvailable, recoveryReason } = await restoreSchedulerState();
    assert.equal(restored, false);
    assert.equal(persistenceAvailable, true);
    assert.equal(recoveryReason, null);
    assert.equal(state.mode, SCHEDULER_MODES.MANUAL);
    assert.equal(state.schedulerStatus, SCHEDULER_STATUSES.IDLE);
    assert.equal(state.version, SCHEDULER_STATE_SCHEMA_VERSION);
  } finally { await teardown(); }
});

test('saveSchedulerState then restoreSchedulerState round-trips historical facts (mode, lifetime counters, timestamps)', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.mode = SCHEDULER_MODES.AUTOMATIC;
    s.campaignsExecutedLifetime = 12;
    s.lastSuccessfulExecution = 1000;
    s.lastFailure = { message: 'transient', ts: 999 };
    await saveSchedulerState(s);

    const { state, restored } = await restoreSchedulerState();
    assert.equal(restored, true);
    assert.equal(state.mode, SCHEDULER_MODES.AUTOMATIC);
    assert.equal(state.campaignsExecutedLifetime, 12);
    assert.equal(state.lastSuccessfulExecution, 1000);
    assert.deepEqual(state.lastFailure, { message: 'transient', ts: 999 });
  } finally { await teardown(); }
});

// ── "never replay missed executions; restore only future work" ──────────

test('restoreSchedulerState always resets an in-flight run to idle/empty-queue/no-campaign, regardless of what was persisted (simulated crash mid-run)', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.schedulerStatus = SCHEDULER_STATUSES.RUNNING; // simulate a crash mid-run
    s.queue = 1;
    s.currentlyRunningCampaign = 'fam-crashed';
    s.campaignsExecutedThisSession = 3;
    await saveSchedulerState(s);

    const { state } = await restoreSchedulerState();
    assert.equal(state.schedulerStatus, SCHEDULER_STATUSES.IDLE);
    assert.equal(state.queue, 0);
    assert.equal(state.currentlyRunningCampaign, null);
    assert.equal(state.campaignsExecutedThisSession, 0, 'a new session must start its session counter at 0');
    assert.equal(state.nextScheduledExecution, null, 'a stale scheduled time must never be trusted after restart');
  } finally { await teardown(); }
});

// ── corrupted state ────────────────────────────────────────────────────────

test('restoreSchedulerState gracefully falls back to a safe Paused-explaining default when the persisted record fails validation', async () => {
  const teardown = setup();
  try {
    await saveSchedulerState({ mode: 'not-a-real-mode', schedulerStatus: 'idle', queue: -5 });
    const { state, restored, recoveryReason } = await restoreSchedulerState();
    assert.equal(restored, false);
    assert.ok(recoveryReason);
    assert.ok(state.pausedReason);
    assert.equal(state.mode, SCHEDULER_MODES.MANUAL);
  } finally { await teardown(); }
});

test('validateSchedulerState reports every structural violation, never throws', () => {
  assert.equal(validateSchedulerState(null).valid, false);
  assert.equal(validateSchedulerState(undefined).valid, false);
  assert.equal(validateSchedulerState({}).valid, false);
  const { valid, errors } = validateSchedulerState({ version: 1, mode: 'bogus', schedulerStatus: 'idle', queue: -1, campaignsExecutedThisSession: 0, campaignsExecutedLifetime: 0, timestamp: Date.now() });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('mode')));
  assert.ok(errors.some((e) => e.includes('queue')));
});

// ── schema migration seam ──────────────────────────────────────────────────

test('a persisted record already at the current schema version passes through restoreSchedulerState unchanged (no spurious migration)', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.version = SCHEDULER_STATE_SCHEMA_VERSION;
    s.campaignsExecutedLifetime = 7;
    await saveSchedulerState(s);
    const { state } = await restoreSchedulerState();
    assert.equal(state.version, SCHEDULER_STATE_SCHEMA_VERSION);
    assert.equal(state.campaignsExecutedLifetime, 7);
  } finally { await teardown(); }
});

// ── "browser refresh" simulation: two independent restore cycles ────────

test('simulated browser refresh: restore, mutate, save, reset connection cache, restore again -- historical facts survive, live-run fields do not carry over', async () => {
  const teardown = setup();
  try {
    const first = await restoreSchedulerState();
    const mutated = { ...first.state, mode: SCHEDULER_MODES.AUTOMATIC, campaignsExecutedLifetime: 1, schedulerStatus: SCHEDULER_STATUSES.RUNNING, queue: 1 };
    await saveSchedulerState(mutated);

    // Simulate a fresh page load: force a brand-new DB connection.
    _resetConnectionCacheForTesting();

    const second = await restoreSchedulerState();
    assert.equal(second.state.mode, SCHEDULER_MODES.AUTOMATIC);
    assert.equal(second.state.campaignsExecutedLifetime, 1);
    assert.equal(second.state.schedulerStatus, SCHEDULER_STATUSES.IDLE);
    assert.equal(second.state.queue, 0);
  } finally { await teardown(); }
});

// ── paused recovery ─────────────────────────────────────────────────────

test('a persisted Paused state with a pausedReason restores with that reason intact', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState({ pausedReason: 'operator paused for maintenance' });
    s.mode = SCHEDULER_MODES.PAUSED;
    await saveSchedulerState(s);
    const { state } = await restoreSchedulerState();
    assert.equal(state.mode, SCHEDULER_MODES.PAUSED);
    assert.equal(state.pausedReason, 'operator paused for maintenance');
  } finally { await teardown(); }
});

// ── persistence unavailable ──────────────────────────────────────────────

test('restoreSchedulerState never throws even when IndexedDB is entirely unavailable', async () => {
  const previousIndexedDB = globalThis.indexedDB;
  delete globalThis.indexedDB;
  _resetConnectionCacheForTesting();
  try {
    const { state, restored, persistenceAvailable, recoveryReason } = await restoreSchedulerState();
    assert.equal(restored, false);
    assert.equal(persistenceAvailable, false);
    assert.ok(recoveryReason);
    assert.ok(state.pausedReason);
  } finally {
    globalThis.indexedDB = previousIndexedDB;
    _resetConnectionCacheForTesting();
  }
});

// ── audit log ───────────────────────────────────────────────────────────

test('appendAuditLogEntry is append-only and listRecentAuditLog returns newest-first, bounded by limit', async () => {
  const teardown = setup();
  try {
    for (let i = 0; i < 5; i += 1) {
      await appendAuditLogEntry({ event: 'run_complete', detail: { i } });
    }
    const log = await listRecentAuditLog(3);
    assert.equal(log.length, 3);
    assert.equal(log[0].detail.i, 4);
    assert.equal(log[1].detail.i, 3);
    assert.equal(log[2].detail.i, 2);
  } finally { await teardown(); }
});

test('getCurrentSnapshotForMonitoring returns the live snapshot as-is (does not apply restore-time session resets)', async () => {
  const teardown = setup();
  try {
    const s = createDefaultSchedulerState();
    s.schedulerStatus = SCHEDULER_STATUSES.RUNNING;
    s.queue = 1;
    await saveSchedulerState(s);
    const { snapshot, available } = await getCurrentSnapshotForMonitoring();
    assert.equal(available, true);
    assert.equal(snapshot.schedulerStatus, SCHEDULER_STATUSES.RUNNING, 'monitoring must see the true live status, not a boot-time reinterpretation');
    assert.equal(snapshot.queue, 1);
  } finally { await teardown(); }
});
