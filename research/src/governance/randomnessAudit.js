/**
 * research/src/governance/randomnessAudit.js
 *
 * Purpose:
 *   Implement the Randomness Audit — Priority 3 of the Final Core Research
 *   Pipeline Implementation, and per that brief "the only major scientific
 *   subsystem still missing." Its purpose, stated in the brief: determine
 *   whether observed predictive structure is distinguishable from
 *   randomness, a statistical artifact, selection bias, or multiple
 *   testing, before any scientific claim is made — and feed that verdict
 *   into the scientific evidence evaluation process (evidenceStandards.js).
 *
 * Explicit instruction followed: "leverage existing components wherever
 *   possible... avoid duplicating functionality already present in the
 *   Laboratory." This module is deliberately almost entirely composition:
 *
 *     - Permutation testing: statistics/permutationTest.js (new — this
 *       was the one genuinely missing primitive; discoveryDecision.js's
 *       own header already anticipated "a future research/src-native
 *       test" arriving here).
 *     - Negative control / calibration: governance/empiricalFdrCanary.js's
 *       checkPersistentMaterialDivergence — per the Architecture
 *       Consolidation doc's own Migration Plan (Stage M6), the Empirical
 *       FDR Calibration Canary IS the ported replacement for legacy's
 *       NegativeControlLedger-based calibration mechanism (the exact
 *       "fixed 3x heuristic" the Retirement Plan flagged for replacement).
 *       Reused here unchanged, never reimplemented.
 *     - Multiple testing / statistical accounting: the Family-scoped
 *       Online FDR wealth-gated `rejected` decision (governance/onlineFdr.js,
 *       via discoveryDecision.js) — a candidate that is statistically
 *       significant under permutation but did NOT clear its Family's
 *       multiple-testing-corrected bid is exactly what "selection bias or
 *       multiple testing" names.
 *     - Statistical artifact (structural instability): governance/
 *       driftSurveillance.js's real, current drift status for the
 *       relevant feature/stream.
 *     - Replication consistency: governance/evidenceStandards.js's
 *       existing checkStrongEvidenceToleranceBand (Part 16).
 *     - Positive control (detection-capability sensitivity): grounded in
 *       legacy index.html's msdRunPositiveControlSensitivityTest (line
 *       6551) — its ground-truth-verified PASS/PARTIAL/FAIL verdict logic
 *       (recovery required on an independent main run AND holdout run) is
 *       ported here as a pure decision function,
 *       evaluatePositiveControlDetection(). The synthetic-signal
 *       GENERATION and full pipeline execution that produces its inputs
 *       remain legacy/browser-dependent and are explicitly out of scope
 *       for this Node-only sandbox (same class of disclosed deferral as
 *       the Historical Tick Engine's live acquisition adapter) — this
 *       module accepts already-computed recovery/verification results,
 *       exactly as discoveryDecision.js accepts an already-computed
 *       p-value.
 *
 * Responsibilities:
 *   - evaluatePositiveControlDetection({...}): the ported legacy verdict
 *     logic (PASS/PARTIAL/FAIL), pure.
 *   - computeRandomnessAuditVerdict({...signals}): the actual audit — a
 *     pure decision function over a caller-supplied signal bundle,
 *     structured identically to evidenceStandards.classifyEvidenceTier
 *     (each signal already has its own authoritative source elsewhere in
 *     this codebase; this function's job is to combine them into one
 *     verdict, never to recompute any of them).
 *   - recordRandomnessAudit / getLatestRandomnessAudit / listRandomnessAudits:
 *     the permanent, append-only record of every audit ever run for a
 *     hypothesis (a hypothesis may legitimately be re-audited as more
 *     evidence — a Replication block, an updated Drift status — becomes
 *     available; each run is its own permanent historical fact, never a
 *     mutation of a prior one, mirroring CalibrationCanaryRuns' own
 *     pattern exactly).
 *   - runRandomnessAudit({...}): the convenience entry point wiring the
 *     permutation test primitive plus every already-governed signal
 *     source together, then records the result. Individual signals may
 *     be omitted by a caller who does not yet have them (e.g. no
 *     Replication has happened yet, so no tolerance-band result exists);
 *     computeRandomnessAuditVerdict treats a missing optional signal as
 *     "not yet checked," never as a silent pass.
 *
 * Its output feeding "the scientific evidence evaluation process" (the
 *   brief's own phrase): evidenceStandards.classifyEvidenceTier() now
 *   accepts an optional randomnessAuditPassed signal (default true, so
 *   every existing caller/test that predates this module is completely
 *   unaffected) — when explicitly false, the tier is capped at None,
 *   regardless of every other signal, since a result the Randomness Audit
 *   could not distinguish from chance/artifact/bias must never accumulate
 *   as scientific evidence.
 *
 * Inputs/Outputs: see each function's own signature.
 * Dependencies: statistics/permutationTest.js,
 *   governance/empiricalFdrCanary.js, governance/driftSurveillance.js,
 *   governance/evidenceStandards.js, storage/researchGovernanceDb.js.
 *
 * Public API: RANDOMNESS_AUDIT_VERDICTS, POSITIVE_CONTROL_STATUSES,
 *   InvalidRandomnessAuditInputError, evaluatePositiveControlDetection,
 *   computeRandomnessAuditVerdict, recordRandomnessAudit,
 *   getLatestRandomnessAudit, listRandomnessAudits, runRandomnessAudit.
 * Internal API: none.
 *
 * Error handling: InvalidRandomnessAuditInputError for malformed
 *   required input; every other signal's own error types (from
 *   permutationTest.js etc.) propagate unchanged.
 * Performance notes: computeRandomnessAuditVerdict is O(1) — pure
 *   decision logic over a small, fixed signal bundle, matching
 *   evidenceStandards.classifyEvidenceTier's own complexity exactly.
 *   Storage reads/writes are index-bounded (by_hypothesis_seq).
 * Threading model: main-thread only.
 * Storage usage: new append-only store RandomnessAuditResults,
 *   `mfx_research_governance` schema v7 -> v8, additive-only.
 * Complexity analysis: see Performance notes.
 * Future extension notes: a future, fully-live Positive Control (real
 *   synthetic-signal generation and pipeline execution) would supply
 *   evaluatePositiveControlDetection's inputs from real ground-truth
 *   verification rather than caller-supplied test values — no change to
 *   this module's own logic would be required.
 */

import { getRandomnessAuditResultsAdapter } from '../storage/researchGovernanceDb.js';
import { checkPersistentMaterialDivergence } from './empiricalFdrCanary.js';
import { getDriftStatus, DRIFT_STATES } from './driftSurveillance.js';
import { checkStrongEvidenceToleranceBand } from './evidenceStandards.js';
import { computeCircularShiftPermutationTest } from '../statistics/permutationTest.js';

/**
 * Integration 5 addendum (Integration, Testing, and GitHub Commit
 * Workflow brief): "Integrate the Positive Control and Negative Control
 * systems into the complete research pipeline so every discovery passes
 * through the same governed workflow."
 *
 *   - Negative Control: already fully wired as of Priority 3, above --
 *     runRandomnessAudit() unconditionally calls the real
 *     checkPersistentMaterialDivergence(familyKey) whenever a familyKey
 *     is supplied. No code change was required for this half.
 *   - Positive Control: as of Priority 3, evaluatePositiveControlDetection()
 *     existed but nothing in the governed pipeline ever called it --
 *     runRandomnessAudit() accepted an already-computed `positiveControl`
 *     verdict object as a caller-supplied value, meaning a caller COULD
 *     bypass the ported legacy verdict logic entirely by fabricating a
 *     {status: 'PASS'} object. Integration 5 closes this seam:
 *     runRandomnessAudit() now accepts optional `positiveControlInputs`
 *     (the raw mainGroundTruthVerified/mainRecovered/
 *     holdoutGroundTruthVerified/holdoutRecovered facts) and, when
 *     supplied, calls evaluatePositiveControlDetection() ITSELF to
 *     produce the verdict -- the same "resolve for real when real
 *     inputs are available, else fall back to the caller-supplied
 *     value" pattern Priority 1 already established for achievedPower/
 *     driftDetected. The old `positiveControl` param remains as the
 *     disclosed manual-attestation fallback for a caller who has not
 *     yet run a live positive-control trial, exactly as classifyIndeterminate's
 *     own caller-supplied achievedPower/driftDetected fallback remains.
 *     No new module, no new store, no duplicated verdict logic --
 *     evaluatePositiveControlDetection is the same, single, already-
 *     tested function; it is simply now called BY the governed pipeline
 *     instead of only being available FOR a caller to optionally use.
 */

export class InvalidRandomnessAuditInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidRandomnessAuditInputError';
  }
}

export const RANDOMNESS_AUDIT_VERDICTS = Object.freeze({
  CONSISTENT_WITH_RANDOMNESS: 'ConsistentWithRandomness',
  SELECTION_BIAS_OR_MULTIPLE_TESTING: 'SelectionBiasOrMultipleTesting',
  STATISTICAL_ARTIFACT: 'StatisticalArtifact',
  INSUFFICIENT_EVIDENCE: 'InsufficientEvidence',
  GENUINE_PREDICTIVE_STRUCTURE: 'GenuinePredictiveStructure',
});

export const POSITIVE_CONTROL_STATUSES = Object.freeze({
  PASS: 'PASS',
  PARTIAL: 'PARTIAL',
  FAIL: 'FAIL',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

/**
 * Ported verbatim from legacy msdRunPositiveControlSensitivityTest's own
 * verdict logic (line ~6640): PASS requires recovery on BOTH an
 * independent main run and holdout run; PARTIAL on exactly one; FAIL on
 * neither. NOT_EVALUATED if ground truth itself could not be verified
 * (the generator did not produce the intended properties) — never
 * silently treated as a FAIL, since that would conflate "the pipeline
 * failed to detect a real signal" with "we never actually had a valid
 * signal to test detection against."
 */
export function evaluatePositiveControlDetection({
  mainGroundTruthVerified, mainRecovered, holdoutGroundTruthVerified, holdoutRecovered,
} = {}) {
  if (mainGroundTruthVerified !== true || holdoutGroundTruthVerified !== true) {
    return Object.freeze({
      status: POSITIVE_CONTROL_STATUSES.NOT_EVALUATED,
      reason: 'Ground-truth verification failed on the main and/or holdout run — the generator did not produce the intended properties; detection capability cannot be assessed.',
    });
  }
  let status;
  if (mainRecovered && holdoutRecovered) status = POSITIVE_CONTROL_STATUSES.PASS;
  else if (mainRecovered || holdoutRecovered) status = POSITIVE_CONTROL_STATUSES.PARTIAL;
  else status = POSITIVE_CONTROL_STATUSES.FAIL;

  const reason = status === POSITIVE_CONTROL_STATUSES.PASS
    ? 'The planted signal was recovered on both the main run and the independent holdout.'
    : status === POSITIVE_CONTROL_STATUSES.PARTIAL
      ? `The planted signal was recovered on only one of the two runs (main: ${mainRecovered}, holdout: ${holdoutRecovered}) — not a full sensitivity PASS.`
      : 'The planted signal was not recovered on either run.';

  return Object.freeze({ status, reason });
}

/**
 * The composed audit verdict — a pure decision function over a
 * caller-supplied signal bundle, mirroring
 * evidenceStandards.classifyEvidenceTier's own structure exactly. Only
 * `permutation` and `fdrDecision` are required (the two signals every
 * Discovery decision already has); every other signal is optional and
 * strengthens the verdict's confidence when present — an omitted
 * optional signal is recorded as "not checked," never silently assumed
 * to pass.
 */
export function computeRandomnessAuditVerdict({
  permutation,
  fdrDecision,
  driftStatus = null,
  calibrationDivergence = null,
  toleranceBand = null,
  positiveControl = null,
  alpha = 0.05,
} = {}) {
  if (!permutation || typeof permutation.pValue !== 'number' || !Number.isFinite(permutation.pValue)) {
    throw new InvalidRandomnessAuditInputError('computeRandomnessAuditVerdict: "permutation.pValue" is required and must be a finite number');
  }
  if (!fdrDecision || typeof fdrDecision.rejected !== 'boolean') {
    throw new InvalidRandomnessAuditInputError('computeRandomnessAuditVerdict: "fdrDecision.rejected" is required and must be a boolean');
  }

  const checksPerformed = ['permutation', 'fdrDecision'];
  if (driftStatus) checksPerformed.push('driftStatus');
  if (calibrationDivergence) checksPerformed.push('calibrationDivergence');
  if (toleranceBand) checksPerformed.push('toleranceBand');
  if (positiveControl) checksPerformed.push('positiveControl');

  // 1. Random chance: is the observed effect even distinguishable from
  // chance under the permutation null?
  if (permutation.pValue > alpha) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.CONSISTENT_WITH_RANDOMNESS,
      reason: `Permutation test p-value ${permutation.pValue} exceeds alpha=${alpha} — the observed effect is not distinguishable from random chance.`,
      checksPerformed,
    });
  }

  // 2. Selection bias / multiple testing: significant under a naive
  // permutation test, but did not clear its Family-scoped, multiple-
  // testing-corrected Online FDR bid.
  if (!fdrDecision.rejected) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.SELECTION_BIAS_OR_MULTIPLE_TESTING,
      reason: 'Significant under the permutation null, but did not clear its Family-scoped Online FDR wealth-gated threshold (Part 9) — consistent with selection bias or an uncorrected multiple-testing effect.',
      checksPerformed,
    });
  }

  // 3. Statistical artifact, structural-break flavor: a detected drift
  // event coincides with this result.
  if (driftStatus && driftStatus.state === DRIFT_STATES.DRIFTED) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.STATISTICAL_ARTIFACT,
      reason: 'Drift Surveillance reports a currently DRIFTED state for the relevant feature/stream — the apparent effect may be a regime-specific artifact rather than a stable structure.',
      checksPerformed,
    });
  }

  // 4. Statistical artifact, calibration flavor: the Family's own
  // Empirical FDR Calibration Canary shows persistent, material
  // divergence, casting doubt on the pipeline's calibration itself.
  if (calibrationDivergence && calibrationDivergence.triggered === true) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.STATISTICAL_ARTIFACT,
      reason: 'The Family\'s Empirical FDR Calibration Canary shows persistent, material divergence — the pipeline\'s false-discovery calibration is currently suspect for this Family.',
      checksPerformed,
    });
  }

  // 5. Statistical artifact, replication flavor: failed the Strong
  // Evidence tolerance band against an independent replication.
  if (toleranceBand && toleranceBand.cleared === false) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.STATISTICAL_ARTIFACT,
      reason: 'The effect did not replicate within the Strong Evidence tolerance band (Part 16) — inconsistent with a stable, genuine effect.',
      checksPerformed,
    });
  }

  // 6. Insufficient evidence: the pipeline's own detection capability
  // could not be confirmed via positive control — a "no artifact found"
  // verdict is uninformative if we cannot confirm the pipeline can detect
  // a real signal at all under comparable conditions.
  if (positiveControl && positiveControl.status === POSITIVE_CONTROL_STATUSES.FAIL) {
    return Object.freeze({
      verdict: RANDOMNESS_AUDIT_VERDICTS.INSUFFICIENT_EVIDENCE,
      reason: 'The pipeline\'s own detection capability could not be confirmed via Positive Control (FAIL) — this result is uninformative until sensitivity is re-established.',
      checksPerformed,
    });
  }

  return Object.freeze({
    verdict: RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE,
    reason: 'Cleared every available randomness/artifact/selection-bias/multiple-testing check.',
    checksPerformed,
  });
}

/** Append-only permanent record of one audit run. Mirrors CalibrationCanaryRuns' own by_hypothesis_seq pattern. */
export async function recordRandomnessAudit({ hypothesisId, familyKey, verdict, reason, checksPerformed, signals, computedAt } = {}) {
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new InvalidRandomnessAuditInputError('recordRandomnessAudit: "hypothesisId" must be a non-empty string');
  }
  if (!Object.values(RANDOMNESS_AUDIT_VERDICTS).includes(verdict)) {
    throw new InvalidRandomnessAuditInputError(`recordRandomnessAudit: "verdict" must be one of ${Object.values(RANDOMNESS_AUDIT_VERDICTS).join(', ')}`);
  }
  const adapter = await getRandomnessAuditResultsAdapter();
  const latest = await adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
  const seq = latest ? latest.seq + 1 : 0;
  const record = {
    id: `ra_${hypothesisId}_${seq}`,
    hypothesisId,
    familyKey: familyKey ?? null,
    seq,
    verdict,
    reason: reason ?? null,
    checksPerformed: checksPerformed ?? [],
    signals: signals ?? null,
    computedAt: computedAt ?? Date.now(),
  };
  await adapter.add(record);
  return record;
}

export async function getLatestRandomnessAudit(hypothesisId) {
  const adapter = await getRandomnessAuditResultsAdapter();
  return adapter.queryLatestByIndex('by_hypothesis_seq', [hypothesisId]);
}

export async function listRandomnessAudits(hypothesisId, { limit = Infinity } = {}) {
  const adapter = await getRandomnessAuditResultsAdapter();
  const rows = await adapter.listByIndexRange('by_hypothesis_seq', [hypothesisId], { limit });
  return rows.slice().sort((a, b) => a.seq - b.seq);
}

/**
 * The composed entry point: runs the permutation test primitive, reads
 * every already-governed real signal a caller identifies (Drift status
 * via featureOrStream, Calibration divergence via familyKey), combines
 * them via computeRandomnessAuditVerdict, and permanently records the
 * result. fdrDecision, toleranceBand, and positiveControl are still
 * caller-supplied (already-computed) signals — this function does not
 * re-run a Discovery decision, replication comparison, or positive
 * control trial itself, exactly as discoveryDecision.js does not
 * recompute a p-value.
 */
export async function runRandomnessAudit({
  hypothesisId,
  familyKey,
  featureValues,
  outcomeValues,
  permutationSeed,
  permutations,
  alpha = 0.05,
  fdrDecision,
  driftFeatureOrStream,
  toleranceBand,
  positiveControl,
  positiveControlInputs,
} = {}) {
  const permutation = computeCircularShiftPermutationTest({
    featureValues, outcomeValues, seed: permutationSeed, permutations,
  });

  const driftStatus = driftFeatureOrStream ? await getDriftStatus(driftFeatureOrStream) : null;
  const calibrationDivergence = familyKey ? await checkPersistentMaterialDivergence(familyKey) : null;

  // Integration 5 (Positive Control woven into the governed pipeline):
  // when a caller supplies the raw, already-observed recovery/
  // verification facts (positiveControlInputs), THIS function -- not
  // the caller -- runs the single ported legacy verdict function
  // (evaluatePositiveControlDetection) to produce the Positive Control
  // signal, overriding any caller-supplied `positiveControl` object.
  // This closes the one remaining seam where a caller could otherwise
  // hand a fabricated PASS/PARTIAL/FAIL verdict straight into the audit
  // without it ever having been computed by the Laboratory's own
  // governed logic -- i.e. "every discovery passes through the same
  // governed workflow." Mirrors exactly the pattern Priority 1 already
  // established for achievedPower/driftDetected in
  // hypothesisRegistry.classifyIndeterminate(): resolve for real when
  // real inputs are available, fall back to the caller-supplied value
  // (the pre-existing, disclosed manual-attestation path, still needed
  // for a caller who has not yet run a live positive-control trial) when
  // they are not -- so every existing caller/test that predates this
  // parameter is completely unaffected.
  const resolvedPositiveControl = positiveControlInputs
    ? evaluatePositiveControlDetection(positiveControlInputs)
    : (positiveControl ?? null);

  const { verdict, reason, checksPerformed } = computeRandomnessAuditVerdict({
    permutation, fdrDecision, driftStatus, calibrationDivergence, toleranceBand,
    positiveControl: resolvedPositiveControl, alpha,
  });

  return recordRandomnessAudit({
    hypothesisId, familyKey, verdict, reason, checksPerformed,
    signals: { permutation, fdrDecision, driftStatus, calibrationDivergence, toleranceBand, positiveControl: resolvedPositiveControl },
  });
}
