/**
 * research/src/governance/candidateLifecycleTransition.js
 *
 * Purpose:
 *   Every Phase 11 Candidate subclass instance is deep-frozen at
 *   construction (Candidate.js / IndicatorFeature.js / MarketState.js /
 *   CompositeCandidate.js / ConditionalHypothesis.js all call
 *   Object.freeze(this) — by design, for tamper-evidence). That means
 *   PromotionPolicy (and anything else that needs to advance a candidate's
 *   `lifecycle` field after Round 1/2 evaluation) cannot mutate the field
 *   in place — attempting `candidate.lifecycle = x` throws a TypeError in
 *   strict mode (ES modules are always strict).
 *
 *   This module provides the one correct way to "advance" a candidate:
 *   produce a NEW frozen instance, identical in every field except
 *   `lifecycle`, with the same prototype (so `instanceof IndicatorFeature`,
 *   `.toJSON()`, etc. all still work correctly on the result). This is the
 *   same discipline governance/ScientificDebtLog.js already uses for its
 *   own immutable ScientificDebtItem records (updateStatus() there returns
 *   a new instance rather than mutating the old one) — applied here to
 *   Candidate instances instead of reimplementing per-subclass "with"
 *   methods.
 *
 * Dependencies: governance/phase11LifecycleStates.js (transition validity,
 *   reused — this module never decides which transitions are legal itself).
 * Public API: withPhase11Lifecycle.
 * Complexity: O(f) in the candidate's own field count (property descriptor
 *   copy); the transition-validity check is O(1) (delegated).
 */

import { transitionPhase11Stage } from './phase11LifecycleStates.js';

/**
 * Returns a new candidate instance identical to `candidate` except for its
 * `lifecycle` field, which is set to `targetStage`. Validates the
 * transition via phase11LifecycleStates.transitionPhase11Stage (throws
 * Phase11TransitionError for an illegal transition) before cloning.
 *
 * @param {import('../candidate/Candidate.js').Candidate} candidate
 * @param {string} targetStage - One of PHASE11_LIFECYCLE_STAGES values.
 * @returns {import('../candidate/Candidate.js').Candidate} A new, frozen instance.
 */
export function withPhase11Lifecycle(candidate, targetStage) {
  transitionPhase11Stage(candidate.lifecycle, targetStage); // throws if illegal; result discarded (== targetStage)

  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors.lifecycle = { value: targetStage, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}
