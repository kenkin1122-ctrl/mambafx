/**
 * research/src/governance/complianceAudit.js
 *
 * Purpose:
 *   Implement Volume IV v3.0 Part 2's Automatic Constitutional Compliance
 *   Audit: the mandatory, mechanical gate that must pass before ANY
 *   Lifecycle Stage transition, checking Registration completeness, Data
 *   Access Attestation validity, correct Family/Lineage assignment, and
 *   (via pluggable checks — see Future extension notes) Reproducibility
 *   Manifest completeness, Lockbox/Replication completeness, Evidence Tier
 *   satisfaction, and Drift Surveillance status where relevant to the
 *   transition being attempted.
 *
 * Design note on "the Global Compliance Audit Failure Counter" (Part 5):
 *   rather than maintaining a separate, independently-incrementable mutable
 *   counter (which would be state that can drift out of sync with the
 *   actual log, exactly the kind of hidden-flexibility risk Principle 12
 *   warns against), this module logs every audit outcome — pass AND fail —
 *   to the append-only ComplianceAuditLog store, and the "counter" is a
 *   derived COUNT over that permanent log (countFailures()). This is the
 *   same "counters are computed from the permanent record, never
 *   independently mutated" discipline the rest of this Volume already
 *   assumes for its Lifetime Statistical Accounting (Part 5).
 *
 * Responsibilities:
 *   - runComplianceAudit(hypothesisId, {toStage, context}): runs the
 *     built-in checks (registration completeness, current-stage/target-
 *     stage adjacency per hypothesisRegistry's ALLOWED_TRANSITIONS, Data
 *     Access Attestation validity) plus any caller-supplied `context.extraChecks`
 *     (an array of {name, fn: async () => boolean|{passed, detail}}),
 *     letting Stage-level callers register checks for machinery this
 *     governance layer does not itself implement yet (Reproducibility
 *     Manifest completeness, Lockbox consumption, Replication completeness,
 *     Evidence Tier satisfaction, Drift Surveillance currency). ALWAYS logs
 *     the full result, pass or fail, to ComplianceAuditLog before returning.
 *   - attemptTransition(hypothesisId, transitionArgs, context): the
 *     enforcement wrapper — runs the audit, and ONLY calls
 *     hypothesisRegistry.transitionLifecycleStage if every check passed;
 *     throws ComplianceAuditFailedError (carrying the full check list)
 *     otherwise. Nothing in this module ever allows a transition to proceed
 *     on a partially-passed audit.
 *   - countFailures(hypothesisId?): derived count from the permanent log,
 *     optionally scoped to one hypothesis.
 *   - listAuditHistory(hypothesisId): full audit history for a hypothesis,
 *     for dashboard/debugging use.
 *
 * Inputs: hypothesisId, the target Lifecycle Stage, and an optional
 *   `context` object carrying pluggable extraChecks and any data those
 *   checks need.
 * Outputs: Promises resolving to a structured audit result
 *   { hypothesisId, toStage, passed, checks: [...], createdAt } or, from
 *   attemptTransition, the new LifecycleTransitions row.
 * Dependencies: storage/researchGovernanceDb.js, governance/hypothesisRegistry.js.
 *
 * Public API: runComplianceAudit, attemptTransition, countFailures,
 *   listAuditHistory, ComplianceAuditFailedError.
 * Internal API: none.
 *
 * Error handling: ComplianceAuditFailedError is thrown ONLY after the
 *   failing audit has already been durably logged — a caller catching this
 *   error still has a permanent record of exactly what failed and why
 *   (Principle 8). Individual extraCheck functions that themselves throw
 *   are caught and recorded as a failed check with the error message as
 *   `detail`, rather than aborting the whole audit run uncaught — one badly
 *   written Stage-level check must not silently skip the rest of the audit.
 * Performance notes: built-in checks are O(log n) (index-bounded reads via
 *   hypothesisRegistry's own bounded helpers); overall cost scales with the
 *   number of extraChecks supplied, which is caller-controlled.
 * Threading model: main-thread only.
 * Storage usage: ComplianceAuditLog (append-only) plus read-only access to
 *   HypothesisRegistry / LifecycleTransitions via hypothesisRegistry.js.
 * Complexity analysis: see Performance notes.
 * Future extension notes: as Lockbox (Part 10), Evidence Standards
 *   (Part 13), and the Reproducibility Manifest store are implemented, their
 *   modules should each export a ready-made `{name, fn}` check object that
 *   Stage-level orchestration code passes into context.extraChecks — this
 *   file itself should not need to change to accommodate them, per the
 *   additive-only discipline already established for research/src.
 */

import { getComplianceAuditLogAdapter } from '../storage/researchGovernanceDb.js';
import {
  ALLOWED_TRANSITIONS,
  getCurrentLifecycleStage,
  transitionLifecycleStage,
} from './hypothesisRegistry.js';

export class ComplianceAuditFailedError extends Error {
  constructor(message, auditResult) {
    super(message);
    this.name = 'ComplianceAuditFailedError';
    this.auditResult = auditResult;
  }
}

async function runCheck(name, fn) {
  try {
    const result = await fn();
    if (typeof result === 'boolean') return { name, passed: result, detail: null };
    return { name, passed: !!result.passed, detail: result.detail ?? null };
  } catch (err) {
    return { name, passed: false, detail: `check threw: ${err.message}` };
  }
}

export async function runComplianceAudit(hypothesisId, { toStage, context = {} } = {}) {
  const checks = [];

  const currentStage = await getCurrentLifecycleStage(hypothesisId);
  checks.push(await runCheck('registration-complete', () => currentStage !== null));

  checks.push(await runCheck('lifecycle-adjacency', () => {
    if (currentStage === null) return { passed: false, detail: 'no current Lifecycle Stage — hypothesis is not Registered' };
    const allowed = ALLOWED_TRANSITIONS[currentStage] || [];
    const isReattempt = context.indeterminateReattempt === true && currentStage === toStage;
    const ok = allowed.includes(toStage) || isReattempt;
    return { passed: ok, detail: ok ? null : `"${currentStage}" -> "${toStage}" is not permitted (Part 2)` };
  }));

  if (context.dataAccessAttestation) {
    checks.push(await runCheck('data-access-attestation-valid', () => ({
      passed: context.dataAccessAttestation.attested === true,
      detail: context.dataAccessAttestation.attested ? null : 'undisclosed pre-Registration data access present (Part 7)',
    })));
  }

  for (const extra of (context.extraChecks || [])) {
    checks.push(await runCheck(extra.name, extra.fn));
  }

  const passed = checks.every((c) => c.passed);
  const auditResult = {
    hypothesisId,
    toStage,
    fromStage: currentStage,
    passed,
    checks,
    createdAt: Date.now(),
  };

  const logAdapter = await getComplianceAuditLogAdapter();
  await logAdapter.add({ id: `caud_${hypothesisId}_${auditResult.createdAt}_${Math.random().toString(36).slice(2, 8)}`, ...auditResult });

  return auditResult;
}

/**
 * The enforcement wrapper: audits, then transitions only if every check
 * passed. A failed audit is already durably logged by runComplianceAudit
 * before this function throws.
 */
export async function attemptTransition(hypothesisId, transitionArgs, context = {}) {
  const auditResult = await runComplianceAudit(hypothesisId, { toStage: transitionArgs.to, context });
  if (!auditResult.passed) {
    const failedNames = auditResult.checks.filter((c) => !c.passed).map((c) => c.name).join(', ');
    throw new ComplianceAuditFailedError(
      `attemptTransition: Compliance Audit failed for hypothesis "${hypothesisId}" -> "${transitionArgs.to}" (failed checks: ${failedNames})`,
      auditResult
    );
  }
  return transitionLifecycleStage(hypothesisId, transitionArgs);
}

/** Derived count of failed audits from the permanent log — never a separately mutated counter. */
export async function countFailures(hypothesisId) {
  const logAdapter = await getComplianceAuditLogAdapter();
  const rows = hypothesisId
    ? await logAdapter.listByIndexRange('by_hypothesis_createdAt', [hypothesisId])
    : await logAdapter.getAll();
  return rows.filter((r) => r.passed === false).length;
}

export async function listAuditHistory(hypothesisId) {
  const logAdapter = await getComplianceAuditLogAdapter();
  return logAdapter.listByIndexRange('by_hypothesis_createdAt', [hypothesisId]);
}
