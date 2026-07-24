/**
 * research/src/governance/hypothesisRegistry.js
 *
 * Purpose:
 *   Implement the core of Volume IV v3.0 Parts 2 (Hypothesis Lifecycle),
 *   3 (Hypothesis Registry), and 4 (Lineage Rules): Registration, the
 *   Lifecycle Stage state machine and its forbidden-transition enforcement,
 *   N_max assignment, generation/lineage bookkeeping, and the Indeterminate
 *   classification gate (Part 12).
 *
 * Scoping note (deliberate, documented): Part 2 lists Idea and Hypothesis as
 *   formal Lifecycle Stages, but Constitutionally carries "no statistical
 *   weight whatsoever" for them and requires no record of the idea itself —
 *   only data access during those stages is governed (dataAccessLedger.js).
 *   This module therefore begins tracking a hypothesis's formal Lifecycle
 *   Stage at Registration; the first row this module ever writes to
 *   LifecycleTransitions for a given hypothesisId IS its Registration event.
 *   Every subsequent transition builds on that row. This is an additive
 *   implementation choice, not a Constitutional exception — Idea/Hypothesis
 *   remain fully real Lifecycle Stages, they are just not represented as
 *   LifecycleTransitions rows because nothing in Part 2 requires a record of
 *   them (indeed Part 2 says an Idea requires "nothing to record the idea
 *   itself").
 *
 * Responsibilities:
 *   - registerHypothesis(spec): validates every Part 3 Registry field is
 *     present, assigns a Permanent Hypothesis ID, resolves N_max per Part 4
 *     (assignNMax), appends the immutable Registry row (add()-only — a
 *     second registerHypothesis() call for the same hypothesisId fails with
 *     the native IndexedDB ConstraintError, mechanically enforcing "no
 *     hypothesis may be overwritten"), and writes the first
 *     LifecycleTransitions row (-> 'Registration').
 *   - transitionLifecycleStage(hypothesisId, {to, reason, approvedBy}):
 *     enforces Part 2's ALLOWED_TRANSITIONS graph, including the single
 *     documented exception (an Indeterminate hypothesis's one permitted
 *     corrected re-attempt). Appends a new, sequenced LifecycleTransitions
 *     row — never mutates a prior one.
 *   - getCurrentLifecycleStage(hypothesisId): latest transition's `to`
 *     value, via the by_hypothesis_seq index (bounded read).
 *   - listLifecycleHistory(hypothesisId): full transition history, for
 *     Compliance Audit and dashboard use.
 *   - assignNMax({familyKey, requestedNMax, oversightApproval}): Part 4 —
 *     returns GOVERNANCE.DEFAULT_N_MAX unless a non-default value is
 *     requested, in which case a well-formed Scientific Oversight approval
 *     record is mandatory.
 *   - countGenerationsInLineage(lineageId): bounded read via
 *     by_lineage_generation index — never a full-registry scan.
 *   - classifyIndeterminate(hypothesisId, {...}): Part 12's Indeterminate
 *     gate — requires an achieved-power shortfall AND a confirmed drift
 *     detection AND a Scientific Oversight approval record, all three
 *     simultaneously; enforces the one-time-per-lineage limit by inspecting
 *     prior Lifecycle history across the lineage's generations, defaulting
 *     to Rejected if the lineage has already used its one Indeterminate.
 *
 * Inputs: plain objects per function (see each function's own doc comment).
 *   "Scientific Oversight approval," everywhere it appears, is modeled as a
 *   caller-supplied record { approvedBy, rationale, timestamp } — this
 *   module cannot itself exercise human scientific judgment (Part 8's
 *   independence requirement is a human/process matter); what it CAN and
 *   does enforce is that no gated action proceeds without such a record
 *   present and well-formed, and that the record is permanently logged
 *   alongside the action it authorized.
 * Outputs: Promises resolving to the new hypothesisId, the current/updated
 *   Lifecycle Stage, or a structured classification result.
 * Dependencies: storage/researchGovernanceDb.js, core/constants.js
 *   (GOVERNANCE thresholds), statistics/powerEngine.js (Priority 1.1 wiring
 *   -- real achieved-power resolution for classifyIndeterminate),
 *   governance/driftSurveillance.js (Priority 1.2 wiring -- real drift-
 *   status resolution for classifyIndeterminate).
 *
 * Public API: LIFECYCLE_STAGES, ALLOWED_TRANSITIONS, registerHypothesis,
 *   transitionLifecycleStage, getCurrentLifecycleStage, listLifecycleHistory,
 *   assignNMax, countGenerationsInLineage, classifyIndeterminate,
 *   ForbiddenTransitionError, InvalidRegistrationError, MissingPowerAnalysisError.
 * Internal API: none.
 *
 * Error handling: validation failures throw synchronously-raised, named
 *   Error subclasses (ForbiddenTransitionError, InvalidRegistrationError)
 *   BEFORE any write is attempted, so a rejected action never produces a
 *   partial record; IndexedDB errors (e.g., duplicate-key ConstraintError on
 *   a repeat registerHypothesis()) propagate as rejected Promises, never
 *   swallowed.
 * Performance notes: every read here is index-bounded (by_hypothesis_seq,
 *   by_lineage_generation) — none scan the full Registry or the full
 *   transition log, consistent with the "no unbounded historical scan"
 *   discipline already established for the Phase 1 stores.
 * Threading model: main-thread only.
 * Storage usage: HypothesisRegistry (one row per hypothesis, write-once) and
 *   LifecycleTransitions (append-only, many rows per hypothesis).
 * Complexity analysis: registerHypothesis is O(log n); transition/read
 *   helpers are O(log n + k) where k is the (small, per-hypothesis or
 *   per-lineage) result set size.
 * Future extension notes: Publication Status (Part 12's Supported/Rejected/
 *   Refuted/Replicated/Published/Operational/Deprecated/Retired/Archived
 *   trichotomy-plus-states, distinct from Lifecycle Stage) is a SEPARATE
 *   state machine layered on top of Lifecycle Stage per Part 2's own
 *   distinction ("Lifecycle Stage answers where in the process... Publication
 *   Status answers what is the Laboratory's current scientific verdict").
 *   It is intentionally out of scope for this file and belongs in a future
 *   publicationStatus.js sibling module, once Lockbox (Part 10) and Evidence
 *   Standards (Part 13) have their own implementations to gate against —
 *   see the Phase 2 Implementation Mapping document.
 */

import { getHypothesisRegistryAdapter, getLifecycleTransitionsAdapter } from '../storage/researchGovernanceDb.js';
import { GOVERNANCE } from '../core/constants.js';
// Priority 1.1/1.2 wiring (Final Core Research Pipeline Implementation):
// classifyIndeterminate() below now resolves REAL, already-recorded Power
// Engine / Drift Surveillance evidence when a discoveryResultId /
// featureOrStream is supplied, rather than trusting only a caller-supplied
// placeholder value. Both imports are lazy-safe (no cycle back into this
// module -- verified: neither powerEngine.js nor driftSurveillance.js
// imports hypothesisRegistry.js).
import { getPowerAnalysis } from '../statistics/powerEngine.js';
import { getDriftStatus, DRIFT_STATES } from './driftSurveillance.js';

export class InvalidRegistrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRegistrationError';
  }
}

export class ForbiddenTransitionError extends Error {
  constructor(message, { from, to } = {}) {
    super(message);
    this.name = 'ForbiddenTransitionError';
    this.from = from;
    this.to = to;
  }
}

// ── Part 2: Lifecycle Stages this module tracks (see Scoping note above for
//    why Idea/Hypothesis are not represented as rows here). ────────────────
export const LIFECYCLE_STAGES = Object.freeze({
  REGISTRATION: 'Registration',
  FEATURE_GENERATION: 'FeatureGeneration',
  DISCOVERY: 'Discovery',
  REPLICATION: 'Replication',
  LOCKBOX: 'Lockbox',
  PUBLICATION: 'Publication',
  RETIREMENT: 'Retirement',
  ARCHIVE: 'Archive',
});

// ── Part 2's forbidden-transitions graph, expressed as an allow-list. The
//    Indeterminate re-attempt exception is handled separately in
//    transitionLifecycleStage (it is conditional on caller-supplied state,
//    not a static edge — a hypothesis may only take it once). ─────────────
export const ALLOWED_TRANSITIONS = Object.freeze({
  [LIFECYCLE_STAGES.REGISTRATION]: Object.freeze([LIFECYCLE_STAGES.FEATURE_GENERATION]),
  [LIFECYCLE_STAGES.FEATURE_GENERATION]: Object.freeze([LIFECYCLE_STAGES.DISCOVERY]),
  [LIFECYCLE_STAGES.DISCOVERY]: Object.freeze([LIFECYCLE_STAGES.REPLICATION]),
  [LIFECYCLE_STAGES.REPLICATION]: Object.freeze([LIFECYCLE_STAGES.LOCKBOX]),
  [LIFECYCLE_STAGES.LOCKBOX]: Object.freeze([LIFECYCLE_STAGES.PUBLICATION]),
  [LIFECYCLE_STAGES.PUBLICATION]: Object.freeze([LIFECYCLE_STAGES.RETIREMENT]),
  [LIFECYCLE_STAGES.RETIREMENT]: Object.freeze([LIFECYCLE_STAGES.ARCHIVE]),
  [LIFECYCLE_STAGES.ARCHIVE]: Object.freeze([]), // terminal — no further transition is possible (Part 2)
});

const REQUIRED_REGISTRATION_FIELDS = Object.freeze([
  'hypothesisId', 'lineageId', 'generationId', 'parentIds',
  'familyKey', 'lineageDeclaration', 'dataAccessAttestation',
  'missingValueHandlingPolicy', 'outlierHandlingPolicy',
  'analyticalChoiceSet', 'reasonForCreation',
]);

function validateRegistration(spec) {
  for (const field of REQUIRED_REGISTRATION_FIELDS) {
    if (spec[field] === undefined || spec[field] === null) {
      throw new InvalidRegistrationError(`registerHypothesis: missing required Registry field "${field}" (Part 3)`);
    }
  }
  if (!Array.isArray(spec.parentIds)) {
    throw new InvalidRegistrationError('registerHypothesis: "parentIds" must be an array (empty for a founding generation)');
  }
  if (!Array.isArray(spec.analyticalChoiceSet) || spec.analyticalChoiceSet.length === 0) {
    throw new InvalidRegistrationError('registerHypothesis: "analyticalChoiceSet" must be a non-empty array (Part 3, Part 13 Multiverse/Sensitivity Analysis)');
  }
  if (spec.dataAccessAttestation.attested !== true) {
    throw new InvalidRegistrationError(
      'registerHypothesis: Data Access Attestation did not pass (Part 7) — Registration cannot complete while undisclosed prior access exists'
    );
  }
}

/**
 * Part 4: N_max is never freely chosen by the registering researcher. This
 * returns the policy-fixed default unless a non-default value is requested
 * AND accompanied by a well-formed Scientific Oversight approval record.
 */
export function assignNMax({ requestedNMax, oversightApproval } = {}) {
  if (requestedNMax === undefined || requestedNMax === null) {
    return GOVERNANCE.DEFAULT_N_MAX;
  }
  const approvalValid = oversightApproval
    && typeof oversightApproval.approvedBy === 'string' && oversightApproval.approvedBy.length > 0
    && typeof oversightApproval.rationale === 'string' && oversightApproval.rationale.length > 0
    && Number.isFinite(oversightApproval.timestamp);
  if (!approvalValid) {
    throw new InvalidRegistrationError(
      'assignNMax: a non-default N_max was requested without a well-formed Scientific Oversight approval ' +
      '{approvedBy, rationale, timestamp} — Part 4/8 require prior Oversight approval for any non-default N_max'
    );
  }
  if (!Number.isInteger(requestedNMax) || requestedNMax < 1) {
    throw new InvalidRegistrationError('assignNMax: requestedNMax must be a positive integer');
  }
  return requestedNMax;
}

/** Part 4: how many generations already exist in this lineage (bounded read). */
export async function countGenerationsInLineage(lineageId) {
  const adapter = await getHypothesisRegistryAdapter();
  const rows = await adapter.listByIndexRange('by_lineage_generation', [lineageId]);
  return rows.length;
}

/**
 * Register a new hypothesis (founding generation or a subsequent generation
 * with parentIds set). Part 3's full field set is required; Part 7's
 * dataAccessAttestation must already have been computed (see
 * dataAccessLedger.verifyAttestation) and passed in already-resolved,
 * since attestation-checking requires Family-scoped ledger knowledge this
 * module intentionally does not duplicate.
 */
export async function registerHypothesis(spec) {
  validateRegistration(spec);
  const nMax = assignNMax({ requestedNMax: spec.requestedNMax, oversightApproval: spec.nMaxOversightApproval });
  const birthTimestamp = spec.birthTimestamp ?? Date.now();

  const registryAdapter = await getHypothesisRegistryAdapter();
  const record = {
    hypothesisId: spec.hypothesisId,
    lineageId: spec.lineageId,
    generationId: spec.generationId,
    parentIds: spec.parentIds,
    familyKey: spec.familyKey,
    scientificQuestionRef: spec.scientificQuestionRef ?? null,
    lineageDeclaration: spec.lineageDeclaration,
    dataAccessAttestation: spec.dataAccessAttestation,
    missingValueHandlingPolicy: spec.missingValueHandlingPolicy,
    outlierHandlingPolicy: spec.outlierHandlingPolicy,
    analyticalChoiceSet: spec.analyticalChoiceSet,
    nMax,
    reasonForCreation: spec.reasonForCreation,
    birthTimestamp,
    retirementTimestamp: null,
    reasonForRetirement: null,
  };
  await registryAdapter.add(record); // native add() -> ConstraintError on any duplicate hypothesisId

  const transitionsAdapter = await getLifecycleTransitionsAdapter();
  await transitionsAdapter.add({
    id: `lct_${spec.hypothesisId}_0`,
    hypothesisId: spec.hypothesisId,
    seq: 0,
    from: null,
    to: LIFECYCLE_STAGES.REGISTRATION,
    reason: 'Registration completed',
    approvedBy: null,
    createdAt: birthTimestamp,
  });

  return record;
}

/** Latest Lifecycle Stage transition row for a hypothesis, or undefined if never registered. */
async function getLatestTransition(hypothesisId) {
  const adapter = await getLifecycleTransitionsAdapter();
  return adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
}

export async function getCurrentLifecycleStage(hypothesisId) {
  const latest = await getLatestTransition(hypothesisId);
  return latest ? latest.to : null;
}

/**
 * The hypothesis's own immutable Registry row (Part 3), or undefined if
 * never registered. Read-only; added for Phase 4's Lockbox governance
 * (lockbox.js), which needs a registered hypothesis's birthTimestamp
 * (Registration timestamp) for Part 7's Lockbox pre-access disqualification
 * check -- a plain single-key get() via the existing adapter, no new
 * storage or index.
 */
export async function getHypothesis(hypothesisId) {
  const adapter = await getHypothesisRegistryAdapter();
  return adapter.get(hypothesisId);
}

export async function listLifecycleHistory(hypothesisId) {
  const adapter = await getLifecycleTransitionsAdapter();
  return adapter.listByIndexRange('by_hypothesis_seq', [hypothesisId]);
}

/**
 * Enforce Part 2's ALLOWED_TRANSITIONS graph and append the new transition.
 * `indeterminateReattempt: true` permits the single documented exception
 * (Discovery/Replication -> itself) — callers must have already obtained
 * this authorization from classifyIndeterminate() below; this function does
 * not itself re-derive Indeterminate eligibility.
 */
export async function transitionLifecycleStage(hypothesisId, { to, reason, approvedBy, indeterminateReattempt = false } = {}) {
  const latest = await getLatestTransition(hypothesisId);
  if (!latest) {
    throw new ForbiddenTransitionError(`transitionLifecycleStage: hypothesis "${hypothesisId}" has not been Registered`, { from: null, to });
  }
  const from = latest.to;

  const allowed = ALLOWED_TRANSITIONS[from] || [];
  const isReattempt = indeterminateReattempt && from === to && (from === LIFECYCLE_STAGES.DISCOVERY || from === LIFECYCLE_STAGES.REPLICATION);
  if (!allowed.includes(to) && !isReattempt) {
    throw new ForbiddenTransitionError(
      `transitionLifecycleStage: "${from}" -> "${to}" is not a permitted transition for hypothesis "${hypothesisId}" (Part 2)`,
      { from, to }
    );
  }

  const transitionsAdapter = await getLifecycleTransitionsAdapter();
  const record = {
    id: `lct_${hypothesisId}_${latest.seq + 1}`,
    hypothesisId,
    seq: latest.seq + 1,
    from,
    to,
    reason: reason ?? null,
    approvedBy: approvedBy ?? null,
    createdAt: Date.now(),
  };
  await transitionsAdapter.add(record);
  return record;
}

/**
 * Part 12's Indeterminate gate. Requires ALL THREE objective conditions
 * simultaneously — achieved power below the policy-fixed minimum, a
 * confirmed Drift Surveillance Engine detection, and a well-formed
 * Scientific Oversight approval. If the lineage has already used its one
 * permitted Indeterminate classification (checked across every generation
 * in the lineage, not just this hypothesisId), this function forces the
 * result to Rejected instead, per Part 2/4's "no serial Indeterminate
 * laundering" rule, and logs which rule fired.
 */
/**
 * Priority 1.1/1.2 wiring: resolves the REAL, already-recorded Power
 * Engine analysis for discoveryResultId, if supplied -- this is the
 * "automatic, not a placeholder" path the Final Core Research Pipeline
 * Implementation brief requires. Falls back to a caller-supplied
 * achievedPower ONLY when no discoveryResultId is given at all (the
 * disclosed manual-attestation path this codebase already uses elsewhere
 * for facts it cannot itself independently compute -- see publicationStatus.js).
 * Throws MissingPowerAnalysisError if a discoveryResultId IS given but no
 * recorded analysis exists for it -- a missing formal analysis must never
 * silently fall through to an unverified placeholder.
 */
async function resolveAchievedPower({ discoveryResultId, achievedPower }) {
  if (discoveryResultId === undefined || discoveryResultId === null) {
    return { achievedPower, source: 'caller-supplied' };
  }
  const analysis = await getPowerAnalysis(discoveryResultId);
  if (!analysis) {
    throw new MissingPowerAnalysisError(discoveryResultId);
  }
  return { achievedPower: analysis.power, source: 'power-engine', analysis };
}

/**
 * Priority 1.2 wiring: resolves the REAL, current Drift Surveillance
 * status for featureOrStream, if supplied. Falls back to a caller-
 * supplied driftDetected/driftTestStatistic ONLY when no featureOrStream
 * is given at all -- mirrors resolveAchievedPower's exact reasoning.
 */
async function resolveDriftEvidence({ featureOrStream, driftDetected, driftTestStatistic }) {
  if (featureOrStream === undefined || featureOrStream === null) {
    return { driftDetected, driftTestStatistic, source: 'caller-supplied' };
  }
  const status = await getDriftStatus(featureOrStream);
  return {
    driftDetected: status.state === DRIFT_STATES.DRIFTED,
    driftTestStatistic: status.statistic,
    source: 'drift-surveillance',
    status,
  };
}

export class MissingPowerAnalysisError extends Error {
  constructor(discoveryResultId) {
    super(
      `classifyIndeterminate: discoveryResultId "${discoveryResultId}" was supplied but no recorded Power Analysis ` +
      'exists for it (powerEngine.recordPowerAnalysis must run first) -- refusing to fall back to an unverified ' +
      'placeholder power value for a real discoveryResultId.'
    );
    this.name = 'MissingPowerAnalysisError';
    this.discoveryResultId = discoveryResultId;
  }
}

export async function classifyIndeterminate(hypothesisId, {
  lineageId, achievedPower, minPower = GOVERNANCE.MIN_STATISTICAL_POWER,
  driftDetected, driftTestStatistic, oversightApproval,
  discoveryResultId, featureOrStream,
} = {}) {
  const approvalValid = oversightApproval
    && typeof oversightApproval.approvedBy === 'string' && oversightApproval.approvedBy.length > 0
    && typeof oversightApproval.rationale === 'string' && oversightApproval.rationale.length > 0;

  const resolvedPower = await resolveAchievedPower({ discoveryResultId, achievedPower });
  const resolvedDrift = await resolveDriftEvidence({ featureOrStream, driftDetected, driftTestStatistic });
  achievedPower = resolvedPower.achievedPower;
  driftDetected = resolvedDrift.driftDetected;
  driftTestStatistic = resolvedDrift.driftTestStatistic;

  if (!(achievedPower < minPower) || driftDetected !== true || !approvalValid) {
    return {
      classification: 'Rejected',
      reason: 'Indeterminate criteria not met (Part 12 requires: achieved power below minimum, confirmed drift detection, AND Scientific Oversight approval, all three)',
    };
  }

  const priorIndeterminateInLineage = await lineageAlreadyUsedIndeterminate(lineageId);
  if (priorIndeterminateInLineage) {
    return {
      classification: 'Rejected',
      reason: 'Lineage has already used its one permitted Indeterminate classification (Part 2, Part 4: no serial Indeterminate laundering)',
    };
  }

  // Indeterminate is a Part 12 PUBLICATION STATUS annotation overlaid on the
  // hypothesis's CURRENT Lifecycle Stage (Part 2: "Lifecycle Stage answers
  // where in the process... Publication Status answers what is the
  // Laboratory's current scientific verdict") — it is deliberately NOT
  // routed through transitionLifecycleStage()/ALLOWED_TRANSITIONS, since it
  // is not itself a Lifecycle Stage change. It is appended directly, as its
  // own permanently logged row, with seq continuing the same per-hypothesis
  // sequence so listLifecycleHistory() surfaces it in order alongside real
  // stage transitions.
  const latest = await getLatestTransition(hypothesisId);
  const transitionsAdapter = await getLifecycleTransitionsAdapter();
  await transitionsAdapter.add({
    id: `lct_${hypothesisId}_${latest.seq + 1}`,
    hypothesisId,
    seq: latest.seq + 1,
    from: latest.to,
    to: latest.to, // Indeterminate does not change the Lifecycle Stage
    reason: `Indeterminate: achievedPower=${achievedPower} < minPower=${minPower}; drift detected (stat=${driftTestStatistic})`,
    approvedBy: oversightApproval.approvedBy,
    createdAt: Date.now(),
  });

  return {
    classification: 'Indeterminate',
    reason: 'Formal power analysis and Drift Surveillance Engine evidence both confirmed; Scientific Oversight approved (Part 12)',
    oversightApproval,
    achievedPower,
    powerSource: resolvedPower.source,
    driftDetected,
    driftTestStatistic,
    driftSource: resolvedDrift.source,
  };
}

async function lineageAlreadyUsedIndeterminate(lineageId) {
  const registryAdapter = await getHypothesisRegistryAdapter();
  const generations = await registryAdapter.listByIndexRange('by_lineage_generation', [lineageId]);
  const transitionsAdapter = await getLifecycleTransitionsAdapter();
  for (const gen of generations) {
    const rows = await transitionsAdapter.listByIndexRange('by_hypothesis_seq', [gen.hypothesisId]);
    if (rows.some((r) => (r.reason || '').startsWith('Indeterminate:'))) {
      return true;
    }
  }
  return false;
}
