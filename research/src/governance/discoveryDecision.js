/**
 * research/src/governance/discoveryDecision.js
 *
 * Purpose:
 *   The Laboratory's single authoritative Discovery decision gate (Volume
 *   IV v3.0 Parts 2, 6, 9) — implements the "two-condition Discovery gate"
 *   named in the v3.0 Independent Panel Review's Consistency Audit:
 *   lineage-aware Registration status AND Family-scoped Online FDR wealth,
 *   evaluated together, every time a candidate statistical test result is
 *   presented as a possible Discovery.
 *
 * Architectural note (why this is NOT a change to index.html): legacy
 *   index.html is a plain inline script with no module system; Dependency
 *   Rule 10 (Volume III) makes the research/src <-> legacy crossing
 *   one-directional and confined to services/bridgeToLegacyMsd/ — research
 *   code may call INTO legacy read functions, legacy code cannot import
 *   research/src at all. "Wiring the unified Discovery Engine into
 *   Registration -> Family-scoped Online FDR" is therefore implemented as
 *   an orchestration layer here, one level above the legacy statistical
 *   engines, not as an edit to their internals. This module is deliberately
 *   agnostic about WHERE a pValue came from — it accepts one from any
 *   already-computed test result, whether that eventually flows in from
 *   the legacy permutation-test engine, the legacy mutual-information
 *   engine, or a future research/src-native test.
 *
 * How this retires Discovery Engine B's independent path (Consolidation
 *   Duplicate Analysis, D-1): the legacy mutual-information engine
 *   (`msdRunStatisticalDiscovery`) is NOT deleted and NOT edited — its
 *   statistic remains a scientifically valid, additive test (it captures
 *   nonlinear dependence a rank-based permutation test can miss). What is
 *   retired is its standalone per-run Benjamini-Hochberg correction as an
 *   independent claim to a discovery verdict: going forward, ANY p-value —
 *   from the permutation engine or the mutual-information engine — must
 *   pass through evaluateDiscoveryCandidate() and spend against the SAME
 *   Family wealth ledger to count as a governed Discovery. Passing
 *   `testMethod: TEST_METHODS.MUTUAL_INFORMATION` records which method
 *   produced the p-value without giving it a separate alpha budget.
 *
 * How this retires the Generation Registry's standalone role (D-1/D-6):
 *   this module requires a Registered hypothesis (Part 3) — evaluated via
 *   hypothesisRegistry.getCurrentLifecycleStage(), never via the legacy
 *   `msdRegisterGeneration`. A candidate with no registered hypothesisId
 *   is refused outright (NotRegisteredError), before any wealth is spent —
 *   this is the concrete enforcement of "Registration must precede
 *   Discovery" (Part 2) at the exact point Discovery Engine consolidation
 *   requires it.
 *
 * Responsibilities:
 *   - evaluateDiscoveryCandidate({hypothesisId, familyKey OR (market +
 *     targetDefinition), pValue, testMethod, testedAt}): the sole entry
 *     point. Verifies Registration, resolves/reuses the canonical
 *     familyKey (family.js), spends the Family's Online FDR wealth
 *     (onlineFdr.js), and returns the combined, permanently-logged
 *     decision.
 *
 * Inputs: a hypothesisId that has already been registered (Part 3), a
 *   p-value from an already-completed statistical test, and either a
 *   pre-resolved familyKey or a (market, targetDefinition) pair to resolve
 *   one via family.js's tolerance-aware equivalence matching.
 * Outputs: Promise resolving to { hypothesisId, familyKey,
 *   lifecycleStageAtEvaluation, experimentId, rejected, alphaSpent,
 *   wealthBefore, wealthAfter, testMethod, seq, testedAt }.
 * Dependencies: governance/hypothesisRegistry.js (getCurrentLifecycleStage),
 *   governance/family.js (resolveOrCreateFamilyKey), governance/onlineFdr.js
 *   (recordTestAndUpdateWealth, TEST_METHODS), governance/
 *   reproducibilityManifest.js (buildManifestCompletenessCheck — Priority 2
 *   wiring, optional experimentId param).
 *
 * Public API: evaluateDiscoveryCandidate, NotRegisteredError,
 *   InvalidDiscoveryCandidateError, IncompleteManifestForDiscoveryError.
 * Internal API: none.
 *
 * Error handling: NotRegisteredError is thrown BEFORE any wealth is spent
 *   if the hypothesis has no Lifecycle Stage on record — a rejected
 *   candidate must never consume Family wealth, since that would let an
 *   unregistered, ungoverned test still degrade a Family's future testing
 *   budget. IncompleteManifestForDiscoveryError is thrown, also before any
 *   wealth is spent, when an experimentId is supplied but its
 *   Reproducibility Manifest is missing or incomplete (Part 3).
 *   InvalidDiscoveryCandidateError covers malformed input (neither
 *   familyKey nor market+targetDefinition supplied). All other validation
 *   (pValue range, testMethod enum) is delegated to and enforced by
 *   onlineFdr.js, not duplicated here.
 * Performance notes: O(log n) — one bounded Lifecycle-stage read, one
 *   familyKey resolution (in-memory, see family.js), one bounded wealth
 *   ledger read/write.
 * Threading model: main-thread only (matches every sibling governance
 *   module).
 * Storage usage: reads LifecycleTransitions (via hypothesisRegistry.js),
 *   writes one row to FamilyWealthLedger (via onlineFdr.js). Writes
 *   nothing to HypothesisRegistry itself — Registration is a precondition
 *   this module checks, never performs.
 * Complexity analysis: O(log n) total, per Performance notes.
 * Future extension notes: Priority 2 (Final Core Research Pipeline
 *   Implementation) closed the Reproducibility Manifest half of this
 *   note. Still open: enforcing the Lockbox holdout-disqualification
 *   check (dataAccessLedger.isLockboxAllocationDisqualified) before
 *   crediting a rejection's bonus — deliberately out of scope here since
 *   it is a Lockbox-consumption-time concern (Part 10), not a
 *   Discovery-time one; Lockbox consumption happens later in the
 *   pipeline (see governance/researchPipeline.js).
 */

import { getCurrentLifecycleStage } from './hypothesisRegistry.js';
import { resolveOrCreateFamilyKey } from './family.js';
import { recordTestAndUpdateWealth, TEST_METHODS } from './onlineFdr.js';
// Priority 2 wiring (Final Core Research Pipeline Implementation): when a
// candidate is tied to a real experimentId, its Reproducibility Manifest
// must be complete BEFORE any Family wealth is spent -- Part 3's hard
// gate ("no experiment's results may... contribute to any Lifecycle Stage
// transition until its manifest is complete") applies with equal force to
// a Discovery decision, which is exactly the kind of "contribution" that
// clause means. Reuses the ready-made check this module's sibling already
// exports; no manifest logic is duplicated here.
import { buildManifestCompletenessCheck } from './reproducibilityManifest.js';

export class NotRegisteredError extends Error {
  constructor(hypothesisId) {
    super(`evaluateDiscoveryCandidate: hypothesis "${hypothesisId}" has no Registration on record — Registration (Part 3) must precede any Discovery decision`);
    this.name = 'NotRegisteredError';
    this.hypothesisId = hypothesisId;
  }
}

export class InvalidDiscoveryCandidateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDiscoveryCandidateError';
  }
}

export class IncompleteManifestForDiscoveryError extends Error {
  constructor(experimentId, detail) {
    super(
      `evaluateDiscoveryCandidate: experimentId "${experimentId}" was supplied but its Reproducibility Manifest is not ` +
      `complete (${detail}) -- Part 3 forbids any experiment's results from contributing to a Discovery decision until ` +
      'its manifest is complete. Refusing before any Family wealth is spent.'
    );
    this.name = 'IncompleteManifestForDiscoveryError';
    this.experimentId = experimentId;
  }
}

/**
 * The single authoritative Discovery decision gate. See module header for
 * the full rationale; in short, this enforces BOTH halves of Part 6/9's
 * two-condition gate in one place: (1) the hypothesis must be Registered,
 * (2) the test must clear its Family's current Online FDR wealth-gated
 * bid. Neither condition may be bypassed by calling onlineFdr.js or
 * hypothesisRegistry.js directly for a Discovery-stage decision — this
 * function is the sanctioned entry point.
 */
export async function evaluateDiscoveryCandidate({
  hypothesisId,
  familyKey,
  market,
  targetDefinition,
  pValue,
  testMethod = TEST_METHODS.UNSPECIFIED,
  testedAt,
  experimentId,
} = {}) {
  if (!hypothesisId || typeof hypothesisId !== 'string') {
    throw new InvalidDiscoveryCandidateError('evaluateDiscoveryCandidate: "hypothesisId" must be a non-empty string');
  }
  if (!familyKey && !(market && targetDefinition)) {
    throw new InvalidDiscoveryCandidateError(
      'evaluateDiscoveryCandidate: either "familyKey" or both "market" and "targetDefinition" must be supplied'
    );
  }

  // Condition 1: Registration must precede Discovery (Part 2/3). Checked
  // BEFORE any wealth is spent, per the Error handling note above.
  const lifecycleStageAtEvaluation = await getCurrentLifecycleStage(hypothesisId);
  if (!lifecycleStageAtEvaluation) {
    throw new NotRegisteredError(hypothesisId);
  }

  // Condition 1.5 (Priority 2 wiring, Part 3): a real experimentId's
  // Reproducibility Manifest must be complete before its result may
  // contribute to a Discovery decision -- also checked BEFORE any wealth
  // is spent, same discipline as Condition 1.
  if (experimentId) {
    const manifestCheck = await buildManifestCompletenessCheck(experimentId).fn();
    if (!manifestCheck.passed) {
      throw new IncompleteManifestForDiscoveryError(experimentId, manifestCheck.detail);
    }
  }

  // Resolve the canonical Family Key -- reuses an existing equivalent
  // Family's key rather than minting a cosmetically-different one, per
  // family.js's tolerance-aware equivalence matching (Part 6).
  const resolvedFamilyKey = familyKey || resolveOrCreateFamilyKey({ market, targetDefinition });

  // Condition 2: spend the Family's Online FDR wealth (Part 9). This is
  // the ONLY place a Discovery candidate's significance is decided --
  // never a flat, per-run alpha threshold.
  const wealthResult = await recordTestAndUpdateWealth({
    familyKey: resolvedFamilyKey,
    hypothesisId,
    pValue,
    testMethod,
    testedAt,
  });

  return {
    hypothesisId,
    familyKey: resolvedFamilyKey,
    lifecycleStageAtEvaluation,
    experimentId: experimentId ?? null,
    ...wealthResult,
  };
}
