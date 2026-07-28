/**
 * research/src/discovery/rngForensics.js
 *
 * Purpose:
 *   Implement Phase 9 Requirement 7 — the RNG Forensics subsystem named in
 *   MambaFX_NextGen_Discovery_Engine_Architecture.md Section 10
 *   ("RNG-artifact risk") and MambaFX_Phase9_Part2...md's Risk Assessment.
 *   Deriv Synthetic Indices are algorithmically generated, not organically
 *   traded — a hypothesis that clears the Randomness Audit is evidence of
 *   REPRODUCIBLE STATISTICAL STRUCTURE, which is a narrower claim than
 *   "genuine market behaviour" or "an identified RNG mechanism." This
 *   module exists to classify WHICH of those narrower claims the evidence
 *   actually supports, strictly after the fact.
 *
 * Governing rule (stated once, enforced structurally): this module NEVER
 *   weakens discovery standards and NEVER re-decides anything Round 3/4
 *   (onlineFdr.js, discoveryDecision.js) or Publication Status
 *   (publicationStatus.js) already decided. It runs only AFTER
 *   randomnessAudit.js's own verdict for a hypothesis is
 *   RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE — enforced by
 *   assertRandomnessAuditSurvived, called unconditionally at the top of
 *   runRngForensics — and its output is a CLASSIFICATION, appended to its
 *   own store, never a mutation of any governance module's decision.
 *
 * Data-boundary discipline (matches this codebase's own disclosed pattern,
 *   e.g. randomnessAudit.js's positiveControlInputs, driftSurveillance.js's
 *   evaluateWindow): this module does not fetch or recompute raw tick data
 *   itself. It accepts ALREADY-COMPUTED sub-check results (each produced by
 *   the Laboratory's own existing statistics primitives —
 *   permutationTest.computeCircularShiftPermutationTest /
 *   computeMutualInformation, driftDetection.computeKSStatistic /
 *   computeKSPValue — run by the caller against whatever live/backfilled
 *   data is available) and adjudicates them. Generating those sub-checks
 *   from real live data is a live/browser concern, the same disclosed
 *   boundary already documented throughout Live Integration Phase 1+2.
 *
 * Responsibilities:
 *   - assertRandomnessAuditSurvived(hypothesisId): the precondition gate.
 *   - classifyRngForensics({...}): pure decision-tree classifier over
 *     already-computed sub-check results (Persistence across
 *     reseed/time-of-day windows, tick-index vs wall-clock alignment,
 *     quantization sensitivity) — no I/O, directly unit-testable, mirrors
 *     randomnessAudit.js's own computeRandomnessAuditVerdict / this
 *     codebase's "pure decision function + thin recording wrapper" split.
 *   - recordRngForensicsResult / getLatestRngForensicsResult /
 *     listRngForensicsResults: append-only storage, mirrors
 *     recordRandomnessAudit's exact shape.
 *   - runRngForensics({...}): the governed entry point — precondition
 *     check, classification, recording, in one call.
 *
 * Inputs: hypothesisId; arrays/objects of already-computed sub-check
 *   results (see classifyRngForensics's own doc comment for the exact
 *   shape of each).
 * Outputs: a permanently recorded RngForensicsResults row.
 * Dependencies: governance/randomnessAudit.js (precondition + verdict
 *   enum), storage/researchGovernanceDb.js (RngForensicsResults adapter).
 *
 * Public API: RNG_FORENSICS_CLASSIFICATIONS, InvalidRngForensicsInputError,
 *   RngForensicsPreconditionError, assertRandomnessAuditSurvived,
 *   classifyRngForensics, recordRngForensicsResult,
 *   getLatestRngForensicsResult, listRngForensicsResults, runRngForensics.
 * Internal API: none.
 *
 * Error handling: RngForensicsPreconditionError when the precondition
 *   (Randomness Audit verdict = GenuinePredictiveStructure) is not met;
 *   InvalidRngForensicsInputError for malformed input — mirrors this
 *   codebase's InvalidXInputError convention throughout.
 * Performance notes: O(1) precondition read (getLatestRandomnessAudit is
 *   already an indexed "latest" query); classification is O(k) in the
 *   number of supplied sub-check results, never a store scan.
 * Threading model: no shared mutable state.
 * Storage usage: one additive append-only store, RngForensicsResults
 *   (`mfx_research_governance` v9 -> v10) — see storage/researchGovernanceDb.js.
 * Complexity analysis: O(log n) per read/write, O(k) per classification.
 * Future extension notes: additional sub-check kinds are additional named
 *   fields on the input object plus one more branch in
 *   classifyRngForensics — no schema change, since the whole result object
 *   is stored as one record.
 */

import {
  RANDOMNESS_AUDIT_VERDICTS,
  getLatestRandomnessAudit,
} from '../governance/randomnessAudit.js';
import { getRngForensicsResultsAdapter } from '../storage/researchGovernanceDb.js';

export class InvalidRngForensicsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRngForensicsInputError';
  }
}

export class RngForensicsPreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RngForensicsPreconditionError';
  }
}

export const RNG_FORENSICS_CLASSIFICATIONS = Object.freeze({
  // The effect persists across reseed/time-of-day windows and across
  // tick-index/wall-clock alignment and quantization variants — the
  // strongest classification this module can assign. Still NOT proof of a
  // specific RNG mechanism (that would require reverse-engineering the
  // generator itself, out of scope) — only evidence the structure is
  // reproducible and not an artifact of the specific checks performed.
  GENUINE_STRUCTURE: 'GenuineStructure',
  // The effect does not hold consistently across independent reseed/
  // time-of-day windows — consistent with a fluctuation local to one
  // sample rather than a persistent property of the generator.
  FINITE_SAMPLE_OR_NON_STATIONARY: 'FiniteSampleOrNonStationary',
  // The effect appears under wall-clock alignment but not tick-index
  // alignment (or vice-versa in an implausible direction) — consistent
  // with a timestamp/latency-induced correlation rather than a property
  // of the actual generated price process.
  RNG_OR_TIMING_ARTIFACT: 'RngOrTimingArtifact',
  // Not enough independent sub-checks were supplied to distinguish the
  // above from genuine structure.
  INSUFFICIENT_EVIDENCE: 'InsufficientEvidence',
});

/**
 * The precondition gate: throws unless hypothesisId's MOST RECENT
 * Randomness Audit verdict is GenuinePredictiveStructure. Called
 * unconditionally at the top of runRngForensics — RNG Forensics is never
 * reachable for a hypothesis that has not already cleared the Randomness
 * Audit, structurally, not by caller discipline.
 */
export async function assertRandomnessAuditSurvived(hypothesisId) {
  if (!hypothesisId) {
    throw new InvalidRngForensicsInputError('assertRandomnessAuditSurvived: "hypothesisId" is required.');
  }
  const latest = await getLatestRandomnessAudit(hypothesisId);
  if (!latest || latest.verdict !== RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE) {
    throw new RngForensicsPreconditionError(
      `assertRandomnessAuditSurvived: hypothesis "${hypothesisId}" has not cleared the Randomness Audit ` +
      `(latest verdict: ${latest ? latest.verdict : 'none recorded'}). RNG Forensics may only run on a ` +
      'hypothesis whose Randomness Audit verdict is GenuinePredictiveStructure.'
    );
  }
  return latest;
}

/**
 * Pure decision tree over already-computed sub-check results. Each
 * argument, when supplied, is expected to already carry a `pValue` (from
 * permutationTest.computeCircularShiftPermutationTest or equivalent) —
 * this function only reads `pValue` against `alpha`, it never recomputes
 * a statistic.
 *
 * @param {Array<{windowLabel: string, pValue: number}>} reseedWindowResults
 *   One entry per independent reseed/time-of-day window tested.
 * @param {{pValue:number}|null} tickIndexAlignedResult
 * @param {{pValue:number}|null} wallClockAlignedResult
 * @param {{pValue:number}|null} coarseQuantizationResult
 * @param {{pValue:number}|null} fineQuantizationResult
 * @param {number} alpha
 */
export function classifyRngForensics({
  reseedWindowResults = [],
  tickIndexAlignedResult = null,
  wallClockAlignedResult = null,
  coarseQuantizationResult = null,
  fineQuantizationResult = null,
  alpha = 0.05,
} = {}) {
  const checksPerformed = [];

  // Check 1: reseed / time-of-day persistence. Needs at least two
  // independent windows to say anything about persistence at all.
  if (reseedWindowResults.length < 2) {
    return {
      classification: RNG_FORENSICS_CLASSIFICATIONS.INSUFFICIENT_EVIDENCE,
      reason: `Only ${reseedWindowResults.length} reseed/time-of-day window(s) supplied; at least 2 are required to assess persistence.`,
      checksPerformed: ['reseedWindowPersistence:insufficient'],
    };
  }
  checksPerformed.push('reseedWindowPersistence');
  const significantWindows = reseedWindowResults.filter((w) => Number.isFinite(w.pValue) && w.pValue < alpha).length;
  const persistenceRate = significantWindows / reseedWindowResults.length;
  if (persistenceRate < 0.5) {
    return {
      classification: RNG_FORENSICS_CLASSIFICATIONS.FINITE_SAMPLE_OR_NON_STATIONARY,
      reason: `Effect significant in only ${significantWindows}/${reseedWindowResults.length} independent reseed/time-of-day windows ` +
        `(alpha=${alpha}) — not a persistent property across windows.`,
      checksPerformed,
    };
  }

  // Check 2: tick-index vs wall-clock alignment. A real discrepancy here
  // (significant one way, not the other) is the specific signature of a
  // timestamp/latency-induced artifact described in the architecture doc.
  if (tickIndexAlignedResult && wallClockAlignedResult) {
    checksPerformed.push('tickIndexVsWallClockAlignment');
    const tickSig = Number.isFinite(tickIndexAlignedResult.pValue) && tickIndexAlignedResult.pValue < alpha;
    const clockSig = Number.isFinite(wallClockAlignedResult.pValue) && wallClockAlignedResult.pValue < alpha;
    if (clockSig && !tickSig) {
      return {
        classification: RNG_FORENSICS_CLASSIFICATIONS.RNG_OR_TIMING_ARTIFACT,
        reason: 'Effect is significant under wall-clock alignment but NOT under tick-index alignment — ' +
          'consistent with a timestamp/latency-induced correlation rather than a property of the generated price process itself.',
        checksPerformed,
      };
    }
  }

  // Check 3: quantization sensitivity (informational — recorded, does not
  // by itself downgrade the classification, since a real subtle effect
  // CAN legitimately disappear under coarser quantization; this is a
  // supporting signal, not a disqualifying one).
  let quantizationNote = null;
  if (coarseQuantizationResult && fineQuantizationResult) {
    checksPerformed.push('quantizationSensitivity');
    const coarseSig = Number.isFinite(coarseQuantizationResult.pValue) && coarseQuantizationResult.pValue < alpha;
    const fineSig = Number.isFinite(fineQuantizationResult.pValue) && fineQuantizationResult.pValue < alpha;
    quantizationNote = (fineSig && !coarseSig)
      ? 'Effect disappears under coarser price quantization — recorded as a supporting signal, not independently disqualifying.'
      : 'Effect stable across quantization granularity.';
  }

  return {
    classification: RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE,
    reason: `Effect persists in ${significantWindows}/${reseedWindowResults.length} independent reseed/time-of-day windows` +
      (checksPerformed.includes('tickIndexVsWallClockAlignment') ? '; consistent under tick-index and wall-clock alignment' : '') +
      (quantizationNote ? `; ${quantizationNote}` : '') + '. This is evidence of reproducible statistical structure, ' +
      'NOT proof of a specific RNG mechanism — mechanistic attribution requires separate, dedicated forensics beyond this classification.',
    checksPerformed,
  };
}

export async function recordRngForensicsResult({ hypothesisId, classification, reason, checksPerformed, inputs, computedAt } = {}) {
  if (!hypothesisId) {
    throw new InvalidRngForensicsInputError('recordRngForensicsResult: "hypothesisId" is required.');
  }
  if (!Object.values(RNG_FORENSICS_CLASSIFICATIONS).includes(classification)) {
    throw new InvalidRngForensicsInputError(
      `recordRngForensicsResult: "classification" must be one of ${Object.values(RNG_FORENSICS_CLASSIFICATIONS).join(', ')}`
    );
  }
  const adapter = await getRngForensicsResultsAdapter();
  const latest = await adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
  const seq = latest ? latest.seq + 1 : 0;
  const record = {
    id: `rngf_${hypothesisId}_${seq}`,
    hypothesisId,
    seq,
    classification,
    reason: reason || '',
    checksPerformed: checksPerformed || [],
    inputs: inputs || {},
    computedAt: computedAt || Date.now(),
  };
  await adapter.add(record);
  return record;
}

export async function getLatestRngForensicsResult(hypothesisId) {
  const adapter = await getRngForensicsResultsAdapter();
  return adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
}

export async function listRngForensicsResults(hypothesisId, { limit = Infinity } = {}) {
  const adapter = await getRngForensicsResultsAdapter();
  const rows = await adapter.listByIndexRange('by_hypothesis_seq', [hypothesisId]);
  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

/**
 * The governed entry point: enforces the precondition, classifies, and
 * permanently records the result in one call — mirrors
 * randomnessAudit.runRandomnessAudit's own "precondition + pure decision +
 * record" composition.
 */
export async function runRngForensics({
  hypothesisId,
  reseedWindowResults,
  tickIndexAlignedResult,
  wallClockAlignedResult,
  coarseQuantizationResult,
  fineQuantizationResult,
  alpha,
} = {}) {
  await assertRandomnessAuditSurvived(hypothesisId);
  const { classification, reason, checksPerformed } = classifyRngForensics({
    reseedWindowResults, tickIndexAlignedResult, wallClockAlignedResult, coarseQuantizationResult, fineQuantizationResult, alpha,
  });
  return recordRngForensicsResult({
    hypothesisId, classification, reason, checksPerformed,
    inputs: { reseedWindowResults, tickIndexAlignedResult, wallClockAlignedResult, coarseQuantizationResult, fineQuantizationResult, alpha },
  });
}
