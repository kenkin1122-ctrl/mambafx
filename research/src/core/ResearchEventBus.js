/**
 * research/src/core/ResearchEventBus.js
 *
 * Purpose:
 *   Provide the research pipeline's publish/subscribe mechanism WITHOUT
 *   sharing any runtime object with the existing mtf/ chart tree's live
 *   EventBus singleton (Volume III v10.1, Section 5.5, Required Change 5).
 *
 * Responsibilities:
 *   - Import the EventBus CLASS (implementation) from mtf/src/core/EventBus.js.
 *   - Instantiate one new, independent object from that class.
 *   - Namespace every event name published through this module
 *     ('research.<Name>') as a second, belt-and-suspenders layer of
 *     protection against accidental cross-subscription, even though the
 *     instances are already fully separate objects.
 *   - Re-scope the bus architecture-wide as a NOTIFICATION mechanism only.
 *     Nothing in research/src may treat delivery of an event as a
 *     correctness guarantee — see reconciliationRunner.js, which is the
 *     actual source of truth for "has this work been done".
 *
 * Inputs: event name (string, un-namespaced) + payload (any structured-clone
 *   -safe value) for publish(); event name + handler function for subscribe().
 * Outputs: unsubscribe function (from subscribe()); nothing from publish().
 * Dependencies: mtf/src/core/EventBus.js (class import only, never the
 *   singleton `eventBus` instance exported from that file).
 *
 * Public API: publish(name, payload), subscribe(name, handler),
 *   subscribeOnce(name, handler), unsubscribeAll(name?).
 * Internal API: none — this module intentionally does not expose the
 *   underlying EventBus instance directly, so callers cannot bypass the
 *   namespacing by calling .emit()/.on() directly on it.
 *
 * Error handling: inherited from mtf's EventBus.emit() — a throwing
 *   subscriber is caught and logged per-listener; it never prevents sibling
 *   subscribers of the same event from running (confirmed against the
 *   actual EventBus.js source at implementation time; this was flagged as
 *   an open verification item in the v10.1 traceability matrix and is now
 *   confirmed: mtf's EventBus.emit() wraps each listener call in try/catch
 *   individually).
 * Performance notes: synchronous, in-memory dispatch — O(listeners) per
 *   publish() call. No batching/coalescing (matches the underlying
 *   implementation's stated Phase 1 scope).
 * Threading model: main-thread only. Workers (Stage 0 / Stage 7) do not
 *   import this module — they communicate via postMessage back to the
 *   stage's main-thread orchestration code, which publishes on their behalf.
 * Storage usage: none — purely in-memory, non-durable by design (Section 5.5:
 *   "never required for correctness").
 * Complexity analysis: O(1) publish overhead beyond listener count; O(1)
 *   subscribe/unsubscribe (Set operations).
 * Future extension notes: if wildcard subscriptions or event batching are
 *   ever needed, they should be added to the underlying EventBus class in
 *   mtf/src/core/EventBus.js (benefiting both trees) rather than
 *   reimplemented here — this module's job is namespacing + isolation, not
 *   bus mechanics.
 */

import { EventBus } from '../../../mtf/src/core/EventBus.js';
import { EVENT_NAMESPACE } from './constants.js';

// Independent instance — NOT the `eventBus` singleton exported by mtf's
// EventBus.js. This is the entire point of Required Change 5: same
// implementation, zero shared runtime state.
const bus = new EventBus();

/**
 * Required Fix 7 (improved documentation): the required, documented calling
 * convention is to pass BARE event names (e.g. 'PowerComputed') — this
 * function is what applies the 'research.' namespace prefix automatically.
 *
 * As a deliberate, DOCUMENTED convenience (not an accident of
 * implementation), passing an ALREADY-namespaced name (e.g.
 * 'research.PowerComputed') is also accepted and treated identically —
 * `startsWith` makes re-prefixing a no-op rather than producing
 * 'research.research.PowerComputed'. This is intentional so that, e.g.,
 * logging/debugging code that captured a namespaced event name from
 * _listenerCountForTesting() or a published payload's metadata can be
 * passed back into subscribe()/publish() without the caller needing to
 * strip the prefix first. It is NOT an invitation to pass either form
 * interchangeably in new code — new code should always pass the bare name,
 * per every example in this module's own tests.
 */
function ns(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('ResearchEventBus: event name must be a non-empty string');
  }
  return name.startsWith(`${EVENT_NAMESPACE}.`) ? name : `${EVENT_NAMESPACE}.${name}`;
}

/**
 * Publish a notification. Best-effort, fire-and-forget, synchronous.
 * NEVER treat the return value or absence of a throw as confirmation that
 * downstream work happened — that guarantee comes from reconciliationRunner,
 * not from this call succeeding.
 */
export function publish(eventName, payload) {
  bus.emit(ns(eventName), payload);
}

/** Subscribe to a namespaced research event. Returns an unsubscribe function. */
export function subscribe(eventName, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('ResearchEventBus.subscribe: handler must be a function');
  }
  return bus.on(ns(eventName), handler);
}

/** Subscribe once; auto-unsubscribes after the first matching publish(). */
export function subscribeOnce(eventName, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('ResearchEventBus.subscribeOnce: handler must be a function');
  }
  return bus.once(ns(eventName), handler);
}

/** Remove every listener for one event, or every listener entirely (tests/teardown only). */
export function unsubscribeAll(eventName) {
  if (eventName) bus.clear(ns(eventName));
  else bus.clear();
}

/**
 * Test/inspection hook ONLY — returns how many listeners are currently
 * registered for a given (un-namespaced) event name. Not part of the public
 * architectural contract; exists so unit tests can assert subscription
 * bookkeeping without reaching into the underlying EventBus internals.
 */
export function _listenerCountForTesting(eventName) {
  const set = bus._listeners.get(ns(eventName));
  return set ? set.size : 0;
}
