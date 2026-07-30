import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachTickListener,
  detachTickListener,
  getLastTickSummary,
  _resetForTesting,
} from '../../research/integration/tickListener.js';

describe('research/integration/tickListener.js', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  test('getLastTickSummary before any event reports an honest empty state', () => {
    const summary = getLastTickSummary();
    assert.equal(summary.lastEvent, null);
    assert.equal(summary.totalWrittenThisSession, 0);
    assert.equal(summary.eventsObservedThisSession, 0);
  });

  test('attachTickListener forwards a real mambafx:marketStatesWritten event into the cache, without calling any discovery function', async () => {
    const target = new EventTarget();
    attachTickListener(target);

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', {
      detail: { written: 3, qaRejected: 1, versionRejected: 0, dbRejected: 0, ts: 12345 },
    }));

    const summary = getLastTickSummary();
    assert.equal(summary.totalWrittenThisSession, 3);
    assert.equal(summary.eventsObservedThisSession, 1);
    assert.deepEqual(summary.lastEvent, { written: 3, qaRejected: 1, versionRejected: 0, dbRejected: 0, ts: 12345 });

    detachTickListener(target);
  });

  test('accumulates across multiple events (session total), matching msdQaRejectionTally-style session-scoped tallying', () => {
    const target = new EventTarget();
    attachTickListener(target);

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 2, ts: 1 } }));
    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 5, ts: 2 } }));

    const summary = getLastTickSummary();
    assert.equal(summary.totalWrittenThisSession, 7);
    assert.equal(summary.eventsObservedThisSession, 2);
    assert.equal(summary.lastEvent.ts, 2);

    detachTickListener(target);
  });

  test('a malformed event detail is treated as zero, never throws', () => {
    const target = new EventTarget();
    attachTickListener(target);

    assert.doesNotThrow(() => {
      target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: null }));
      target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten'));
    });

    const summary = getLastTickSummary();
    assert.equal(summary.totalWrittenThisSession, 0);
    assert.equal(summary.eventsObservedThisSession, 2);

    detachTickListener(target);
  });

  test('detachTickListener stops further updates', () => {
    const target = new EventTarget();
    attachTickListener(target);
    detachTickListener(target);

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 99 } }));

    const summary = getLastTickSummary();
    assert.equal(summary.totalWrittenThisSession, 0);
    assert.equal(summary.eventsObservedThisSession, 0);
  });

  test('re-attaching is idempotent (does not double-count via duplicate listeners)', () => {
    const target = new EventTarget();
    attachTickListener(target);
    attachTickListener(target); // re-attach should detach the first, not stack

    target.dispatchEvent(new CustomEvent('mambafx:marketStatesWritten', { detail: { written: 4 } }));

    const summary = getLastTickSummary();
    assert.equal(summary.totalWrittenThisSession, 4);
    assert.equal(summary.eventsObservedThisSession, 1);

    detachTickListener(target);
  });
});
