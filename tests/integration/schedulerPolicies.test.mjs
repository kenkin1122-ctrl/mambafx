import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_TYPES,
  shouldTriggerEventDriven,
  shouldTriggerBatchCount,
  shouldTriggerTimeBased,
  computeNextScheduledExecution,
  validatePolicy,
  shouldTrigger,
} from '../../research/integration/schedulerPolicies.js';

test('shouldTriggerEventDriven: fires once at least minBatchesSinceLastRun new batches have been observed', () => {
  assert.equal(shouldTriggerEventDriven({ tickSummary: { eventsObservedThisSession: 5 }, lastExecutionBatchCount: 5 }, { minBatchesSinceLastRun: 1 }), false);
  assert.equal(shouldTriggerEventDriven({ tickSummary: { eventsObservedThisSession: 6 }, lastExecutionBatchCount: 5 }, { minBatchesSinceLastRun: 1 }), true);
  assert.equal(shouldTriggerEventDriven({ tickSummary: { eventsObservedThisSession: 6 }, lastExecutionBatchCount: 5 }, { minBatchesSinceLastRun: 2 }), false);
});

test('shouldTriggerBatchCount: fires only once total written crosses the next multiple of batchThreshold', () => {
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 9 } }, { batchThreshold: 10 }), false);
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 10 } }, { batchThreshold: 10 }), true);
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 15 }, lastExecutionWrittenCount: 10 }, { batchThreshold: 10 }), false);
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 20 }, lastExecutionWrittenCount: 10 }, { batchThreshold: 10 }), true);
});

test('shouldTriggerBatchCount: never triggers with a missing/invalid threshold', () => {
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 999 } }, {}), false);
  assert.equal(shouldTriggerBatchCount({ tickSummary: { totalWrittenThisSession: 999 } }, { batchThreshold: -5 }), false);
});

test('shouldTriggerTimeBased: fires once intervalMs has elapsed since lastExecutionTime', () => {
  const now = 1_000_000;
  assert.equal(shouldTriggerTimeBased({ lastExecutionTime: now - 500 }, { intervalMs: 1000 }, now), false);
  assert.equal(shouldTriggerTimeBased({ lastExecutionTime: now - 1000 }, { intervalMs: 1000 }, now), true);
});

test('shouldTriggerTimeBased: with no prior execution, measures from bootTime', () => {
  const now = 1_000_000;
  assert.equal(shouldTriggerTimeBased({ lastExecutionTime: null, bootTime: now - 2000 }, { intervalMs: 1000 }, now), true);
  assert.equal(shouldTriggerTimeBased({ lastExecutionTime: null, bootTime: now - 100 }, { intervalMs: 1000 }, now), false);
});

test('computeNextScheduledExecution: only defined for time-based policies, null otherwise', () => {
  const now = 1_000_000;
  assert.equal(computeNextScheduledExecution({ lastExecutionTime: now }, { type: 'event-driven' }, now), null);
  assert.equal(computeNextScheduledExecution({ lastExecutionTime: now }, { type: 'batch-count' }, now), null);
  assert.equal(computeNextScheduledExecution({ lastExecutionTime: now }, { type: 'time-based', intervalMs: 5000 }, now), now + 5000);
});

test('validatePolicy: accepts well-formed policies, rejects malformed ones with specific errors, never throws', () => {
  assert.equal(validatePolicy(null).valid, false);
  assert.equal(validatePolicy({}).valid, false);
  assert.equal(validatePolicy({ type: 'not-a-real-type' }).valid, false);
  assert.equal(validatePolicy({ type: POLICY_TYPES.EVENT_DRIVEN, minBatchesSinceLastRun: 1 }).valid, true);
  assert.equal(validatePolicy({ type: POLICY_TYPES.BATCH_COUNT }).valid, false, 'batch-count requires batchThreshold');
  assert.equal(validatePolicy({ type: POLICY_TYPES.BATCH_COUNT, batchThreshold: 10 }).valid, true);
  assert.equal(validatePolicy({ type: POLICY_TYPES.TIME_BASED }).valid, false, 'time-based requires intervalMs');
  assert.equal(validatePolicy({ type: POLICY_TYPES.TIME_BASED, intervalMs: 60000 }).valid, true);
});

test('shouldTrigger: dispatches to the correct policy function by type, and returns false (never throws) for an unrecognized policy', () => {
  assert.equal(shouldTrigger({ tickSummary: { eventsObservedThisSession: 1 }, lastExecutionBatchCount: 0 }, { type: POLICY_TYPES.EVENT_DRIVEN, minBatchesSinceLastRun: 1 }), true);
  assert.equal(shouldTrigger({}, { type: 'bogus' }), false);
  assert.equal(shouldTrigger({}, null), false);
});
