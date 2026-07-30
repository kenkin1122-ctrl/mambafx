/**
 * research/src/governance/phase11LifecycleStates.js
 *
 * Purpose:
 *   Phase 11 parallel lifecycle state machine for discovery candidates.
 *   Completely independent of hypothesisRegistry.js's LIFECYCLE_STAGES and
 *   ALLOWED_TRANSITIONS — Phase 11 candidates follow a different lifecycle
 *   that reflects the full journey from generation through publication.
 *
 * UNKNOWN #6 resolution: separate parallel machine. hypothesisRegistry.js is
 *   classified DO NOT TOUCH; its LIFECYCLE_STAGES and ALLOWED_TRANSITIONS are
 *   not extended. This module defines the Phase 11 lifecycle independently.
 *
 * Stage definitions and scientific rationale:
 *   Generated    — candidate created by the generator; no evaluation performed yet.
 *   Screened     — passed Round 1 funnel screening (initial statistical filters).
 *                  Scientific rationale: filtering before expensive computation is
 *                  a standard triage practice (funnel.js's Round 1 purpose).
 *   Triaged      — passed Round 2 deep statistical validation. Effect size and
 *                  p-value under permutation testing are credible.
 *   Confirmed    — passed Round 3 out-of-sample validation on held-out data.
 *                  This is the discovery decision gate.
 *   Replicated   — independently replicated on data from a different time window
 *                  or market condition (Round 4 + additional replication blocks).
 *   Published    — cleared ReproducibilityGate and all publication criteria in the SAP.
 *   Deprecated   — evidence withdrawn or superseded; terminal stage.
 *
 * Allowed transitions (acyclic, except for demotion to Deprecated from any stage):
 *   Generated  → Screened | Deprecated
 *   Screened   → Triaged  | Deprecated
 *   Triaged    → Confirmed| Deprecated
 *   Confirmed  → Replicated | Deprecated
 *   Replicated → Published  | Deprecated
 *   Published  → Deprecated
 *   Deprecated → (terminal — no further transition)
 *
 * Dependencies: none (standalone; no import from hypothesisRegistry.js).
 * Public API: PHASE11_LIFECYCLE_STAGES, PHASE11_ALLOWED_TRANSITIONS,
 *   transitionPhase11Stage, isTerminalPhase11Stage, Phase11TransitionError.
 * Complexity: O(1) for all operations (fixed-size state graph).
 */

export const PHASE11_LIFECYCLE_STAGES = Object.freeze({
  GENERATED:   'Generated',
  SCREENED:    'Screened',
  TRIAGED:     'Triaged',
  CONFIRMED:   'Confirmed',
  REPLICATED:  'Replicated',
  PUBLISHED:   'Published',
  DEPRECATED:  'Deprecated',
});

/**
 * Allow-list of valid transitions. Each key maps to the set of stages it
 * may transition TO. Deprecated is terminal — no outgoing edges.
 *
 * Scientific rationale for the acyclic structure: a candidate that has already
 * been confirmed cannot be "un-confirmed" by re-running the same pipeline step —
 * the historical record stands. Demotion to Deprecated is the only valid
 * regression path, and it is terminal (no recovery from deprecated status within
 * the same candidate lineage — a new candidate must be registered for a new attempt).
 */
export const PHASE11_ALLOWED_TRANSITIONS = Object.freeze({
  [PHASE11_LIFECYCLE_STAGES.GENERATED]:  Object.freeze([PHASE11_LIFECYCLE_STAGES.SCREENED,    PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.SCREENED]:   Object.freeze([PHASE11_LIFECYCLE_STAGES.TRIAGED,     PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.TRIAGED]:    Object.freeze([PHASE11_LIFECYCLE_STAGES.CONFIRMED,   PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.CONFIRMED]:  Object.freeze([PHASE11_LIFECYCLE_STAGES.REPLICATED,  PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.REPLICATED]: Object.freeze([PHASE11_LIFECYCLE_STAGES.PUBLISHED,   PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.PUBLISHED]:  Object.freeze([PHASE11_LIFECYCLE_STAGES.DEPRECATED]),
  [PHASE11_LIFECYCLE_STAGES.DEPRECATED]: Object.freeze([]), // terminal
});

export class Phase11TransitionError extends Error {
  /**
   * @param {string} from - Current stage.
   * @param {string} to   - Attempted target stage.
   */
  constructor(from, to) {
    super(
      `Phase 11 lifecycle transition "${from}" → "${to}" is not allowed. ` +
      `Valid transitions from "${from}": [${(PHASE11_ALLOWED_TRANSITIONS[from] || []).join(', ') || 'none — terminal stage'}]`
    );
    this.name = 'Phase11TransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Validates and returns the target stage if the transition is allowed.
 * Throws Phase11TransitionError if the transition is forbidden.
 * O(1) — array membership test on a fixed, small allow-list.
 *
 * @param {string} currentStage - The candidate's current lifecycle stage.
 * @param {string} targetStage  - The stage to transition to.
 * @returns {string} The target stage (for convenience in assignment expressions).
 */
export function transitionPhase11Stage(currentStage, targetStage) {
  const allowed = PHASE11_ALLOWED_TRANSITIONS[currentStage];
  if (!allowed) {
    throw new Phase11TransitionError(
      currentStage,
      targetStage,
    );
  }
  if (!allowed.includes(targetStage)) {
    throw new Phase11TransitionError(currentStage, targetStage);
  }
  return targetStage;
}

/**
 * Returns true if the given stage is terminal (no further transitions possible).
 * Currently only DEPRECATED is terminal.
 * O(1).
 * @param {string} stage
 * @returns {boolean}
 */
export function isTerminalPhase11Stage(stage) {
  const outgoing = PHASE11_ALLOWED_TRANSITIONS[stage];
  return Array.isArray(outgoing) && outgoing.length === 0;
}

/**
 * Returns true if the string is a recognised Phase 11 lifecycle stage.
 * O(1).
 * @param {string} stage
 * @returns {boolean}
 */
export function isValidPhase11Stage(stage) {
  return Object.values(PHASE11_LIFECYCLE_STAGES).includes(stage);
}
