/**
 * research/src/governance/researchPipeline.js
 *
 * Purpose:
 *   The Final Core Research Pipeline Implementation's Priority 2 deliverable
 *   — connect the existing, independently-governed subsystems into one
 *   continuous, fully-governed scientific pipeline:
 *
 *     Hypothesis Registration -> Family Assignment -> Scientific Question
 *     -> Discovery Engine -> Statistical Testing -> Online Family-Level FDR
 *     -> Randomness Audit -> Publication Status -> Knowledge Engine ->
 *     Machine Learning -> Continuous Learning
 *
 *   This module introduces NO new statistical or governance logic. Every
 *   step below is a thin, documented composition of an already-built,
 *   already-tested function from a sibling governance module. Per the
 *   brief's own explicit instruction ("do not create a second discovery
 *   workflow... the existing Discovery Engine must become fully governed"),
 *   this is a SEQUENCER, not a reimplementation — if a step's underlying
 *   function already refuses an ungoverned action (e.g.
 *   evaluateDiscoveryCandidate's NotRegisteredError/
 *   IncompleteManifestForDiscoveryError), that refusal is preserved and
 *   propagated unchanged, never caught and silently downgraded.
 *
 * Why this is still needed even though every individual stage already
 *   enforces its own preconditions: each governance module enforces that
 *   ITS OWN action cannot proceed ungoverned (e.g. Discovery refuses an
 *   unregistered hypothesis), but nothing previously composed the stages
 *   into one documented sequence, and two real gaps existed at the seams:
 *   (1) a real Discovery result was never automatically reflected into the
 *   Scientific Knowledge Graph (Layer 9) — Phase N built the graph, but
 *   nothing wrote to it after a real event; (2) nothing checked evidence
 *   standards before a hypothesis's data could be used for ML training —
 *   Part 12's Publication Status axis existed, but no function actually
 *   gated ML eligibility on it. Both gaps are closed here, as thin
 *   compositions of already-existing reads (getCurrentPublicationStatus),
 *   not new statistical logic.
 *
 * Responsibilities:
 *   - runGovernedDiscoveryStep({...}): Steps 4-6 (Discovery Engine ->
 *     Statistical Testing -> Online FDR) — a direct, undecorated pass-
 *     through to discoveryDecision.evaluateDiscoveryCandidate(), named
 *     here only so the full pipeline sequence is discoverable from one
 *     module. Retains every one of that function's own governance
 *     guarantees (Registration precondition, Reproducibility Manifest
 *     precondition when experimentId is supplied) unchanged.
 *   - recordGovernedPublicationStatus({...}): Step 7 — a direct pass-
 *     through to publicationStatus.transitionPublicationStatus(), same
 *     reasoning.
 *   - reflectDiscoveryInKnowledgeGraph({...}): Step 8 — composes
 *     knowledgeGraph.js's existing node/edge functions to record a real,
 *     already-governed Discovery/Publication event as graph nodes and
 *     edges (Behaviour/Hypothesis/CandidateMeasurement/Feature and their
 *     relationships), so Layer 9 actually accumulates from real pipeline
 *     activity instead of requiring a separate, easy-to-forget manual
 *     call. NEVER creates a Hypothesis node from an unregistered
 *     hypothesisId (knowledgeGraph.js's own linkHypothesisToBehavior
 *     already refuses that — this function does not weaken it).
 *   - assertEligibleForMachineLearning(hypothesisId): Step 9's gate — the
 *     one genuinely new decision this module adds, and it is a pure
 *     composition: reads the REAL current Publication Status
 *     (getCurrentPublicationStatus) and refuses (MLNotEligibleError)
 *     unless it is Supported, Published, or Operational — i.e. Strong
 *     Evidence has actually been achieved (Part 12/13), never re-derives
 *     or second-guesses the Evidence Tier itself.
 *   - runGovernedResearchPipeline({...}): a single convenience function
 *     composing Steps 1-6 (Registration through Discovery) for the common
 *     case where a caller already has every input available at once —
 *     e.g. a batch/backtest run. Steps 7-9 (Publication Status onward)
 *     are DELIBERATELY NOT folded into this one-shot function: Part 12's
 *     own ALLOWED_TRANSITIONS graph requires Replication and Lockbox
 *     consumption to happen as separate, later, genuinely time-separated
 *     events (you cannot Replicate a result before it exists) — collapsing
 *     them into one synchronous call would misrepresent the actual
 *     temporal structure of the scientific process this Laboratory exists
 *     to enforce. Call recordGovernedPublicationStatus /
 *     reflectDiscoveryInKnowledgeGraph / assertEligibleForMachineLearning
 *     separately, at the point each real event actually happens.
 *
 * "Continuous Learning" (the pipeline's final named node): per the
 *   Constitution's own Tier 5 disclosure ("Automatic feature engineering...
 *   Causal inference, ensemble learning, online/continual learning...
 *   tracked as open research questions, revisited only if the Tier 1-4
 *   pipeline, once live, demonstrates a concrete need"), no new continual-
 *   learning engine is built here — the brief's own instruction against
 *   introducing new architectural concepts applies directly. The loop is
 *   already structurally closed by the EXISTING Lineage mechanism (Part 4):
 *   an improved hypothesis is registered again through Step 1 with
 *   parentIds/lineageId referencing the result that motivated it, and
 *   assertEligibleForMachineLearning gates whether that prior result may
 *   feed a live model at all. "Continuous Learning" is this cycle
 *   repeating, not a thing to construct separately.
 *
 * Inputs/Outputs: see each function's own signature; every input/output
 *   shape is identical to the underlying module's own — this file adds no
 *   new record shapes for Steps 4-7.
 * Dependencies: governance/hypothesisRegistry.js, governance/family.js,
 *   governance/scientificQuestion.js, governance/discoveryDecision.js,
 *   governance/publicationStatus.js, governance/knowledgeGraph.js.
 *
 * Public API: MLNotEligibleError, ML_ELIGIBLE_STATUSES,
 *   runGovernedDiscoveryStep, runGovernedRandomnessAudit,
 *   recordGovernedPublicationStatus, reflectDiscoveryInKnowledgeGraph,
 *   assertEligibleForMachineLearning, runGovernedResearchPipeline.
 * Internal API: none.
 *
 * Error handling: every underlying module's own error types propagate
 *   unchanged (NotRegisteredError, IncompleteManifestForDiscoveryError,
 *   ForbiddenPublicationTransitionError, InvalidPublicationTransitionError,
 *   UnknownNodeReferenceError, etc.) — this module adds exactly one new
 *   error type, MLNotEligibleError, for Step 9's own gate.
 * Performance notes: identical to the sum of the underlying calls made —
 *   this module performs no additional storage reads/writes of its own
 *   beyond Step 9's single getCurrentPublicationStatus read.
 * Threading model: main-thread only (matches every sibling module).
 * Storage usage: none directly — every write happens inside the
 *   underlying module it delegates to.
 * Complexity analysis: O(sum of underlying step complexities).
 * Future extension notes: a future Stage 5 pipeline step (e.g. Lockbox
 *   consumption, once wired into a live experiment) is added the same
 *   way — a new thin function here delegating to lockbox.js, never new
 *   governance logic duplicated into this file.
 */

import { registerHypothesis, getCurrentLifecycleStage } from './hypothesisRegistry.js';
import { resolveOrCreateFamilyKey } from './family.js';
import { getQuestion, attachFamilyToQuestion, listFamiliesForQuestion } from './scientificQuestion.js';
import { evaluateDiscoveryCandidate } from './discoveryDecision.js';
import { transitionPublicationStatus, getCurrentPublicationStatus, PUBLICATION_STATUSES } from './publicationStatus.js';
import {
  registerBehavior, getBehavior, linkHypothesisToBehavior,
  registerCandidateMeasurement, registerFeatureNode, linkHypothesisToFamily,
} from './knowledgeGraph.js';
import { runRandomnessAudit } from './randomnessAudit.js';

export class MLNotEligibleError extends Error {
  constructor(hypothesisId, currentStatus) {
    super(
      `assertEligibleForMachineLearning: hypothesis "${hypothesisId}" has Publication Status ` +
      `"${currentStatus ?? '(none)'}" — Machine Learning may only train on a hypothesis that has reached ` +
      `${Object.values(ML_ELIGIBLE_STATUSES).join(', ')} (Strong Evidence, Part 12/13). Refusing.`
    );
    this.name = 'MLNotEligibleError';
    this.hypothesisId = hypothesisId;
    this.currentStatus = currentStatus;
  }
}

/**
 * The Publication Statuses at or beyond which Strong Evidence has actually
 * been achieved via successful Lockbox consumption (Part 12's own
 * ALLOWED_TRANSITIONS graph guarantees SUPPORTED is unreachable without
 * it — see publicationStatus.js's own SUPPORTED case). Deliberately does
 * NOT include ProvisionallySupported/Replicated (Weak/Moderate Evidence
 * only) — those are real scientific progress, but not yet strong enough
 * evidence to justify training a live model.
 */
export const ML_ELIGIBLE_STATUSES = Object.freeze([
  PUBLICATION_STATUSES.SUPPORTED,
  PUBLICATION_STATUSES.PUBLISHED,
  PUBLICATION_STATUSES.OPERATIONAL,
]);

/** Step 4-6: Discovery Engine -> Statistical Testing -> Online Family-Level FDR. Direct pass-through — see module header. */
export async function runGovernedDiscoveryStep(args) {
  return evaluateDiscoveryCandidate(args);
}

/**
 * Randomness Audit (Priority 3), placed here in the sequence exactly
 * where the brief's own "Expected End State" diagram places it —
 * between Replication and Family-Level Statistical Accounting. Direct
 * pass-through to randomnessAudit.runRandomnessAudit() — see that
 * module's header for the full composition (permutation test + Drift
 * Surveillance + Empirical FDR Calibration Canary + tolerance band +
 * positive control).
 */
export async function runGovernedRandomnessAudit(args) {
  return runRandomnessAudit(args);
}

/** Step 7: Publication Status. Direct pass-through — see module header. */
export async function recordGovernedPublicationStatus(hypothesisId, args) {
  return transitionPublicationStatus(hypothesisId, args);
}

/**
 * Step 8: Knowledge Engine (Scientific Knowledge Graph). Reflects a real,
 * already-governed hypothesis into the graph's taxonomy chain, creating
 * only the pieces the caller actually supplies (a Behaviour is optional —
 * not every Discovery traces to a pre-registered Behaviour yet). Every
 * write here reuses knowledgeGraph.js's own validated functions
 * unchanged — a hypothesisId that isn't real and registered is refused by
 * those functions exactly as it would be if called directly.
 */
export async function reflectDiscoveryInKnowledgeGraph({
  hypothesisId, familyKey,
  behaviorId, behaviorLabel, behaviorDescription,
  candidateId, candidateLabel, mathematicalSketch,
  featureKey, featureFamily, mathematicalDefinition,
} = {}) {
  const results = {};

  if (behaviorId) {
    let behaviorNode = await getBehavior(behaviorId);
    if (!behaviorNode) {
      behaviorNode = await registerBehavior({ behaviorId, label: behaviorLabel || behaviorId, description: behaviorDescription });
    }
    results.behaviorEdge = await linkHypothesisToBehavior(hypothesisId, behaviorId);
  }

  if (familyKey) {
    results.familyEdge = await linkHypothesisToFamily(hypothesisId, familyKey);
  }

  if (candidateId) {
    results.candidateNode = await registerCandidateMeasurement({
      candidateId, label: candidateLabel || candidateId, mathematicalSketch, parentHypothesisId: hypothesisId,
    });
  }

  if (featureKey) {
    if (!candidateId) {
      throw new Error('reflectDiscoveryInKnowledgeGraph: "featureKey" requires "candidateId" — a Feature must implement a real Candidate Measurement (knowledgeGraph.js\'s own precondition).');
    }
    results.featureNode = await registerFeatureNode({
      featureKey, family: featureFamily, parentCandidateMeasurementId: candidateId, mathematicalDefinition,
    });
  }

  return results;
}

/**
 * Step 9's gate: refuses unless the hypothesis's REAL, current Publication
 * Status has actually reached Strong Evidence. Never re-derives evidence
 * strength itself — reads the single authoritative source
 * (publicationStatus.js) exactly once.
 */
export async function assertEligibleForMachineLearning(hypothesisId) {
  const currentStatus = await getCurrentPublicationStatus(hypothesisId);
  if (!ML_ELIGIBLE_STATUSES.includes(currentStatus)) {
    throw new MLNotEligibleError(hypothesisId, currentStatus);
  }
  return { hypothesisId, currentStatus, eligible: true };
}

/**
 * Steps 1-6 in one call, for the common one-shot case (e.g. a batch/
 * backtest run where every input is already known). See module header for
 * why Steps 7-9 are deliberately NOT included here.
 *
 * registrationSpec: passed to hypothesisRegistry.registerHypothesis()
 *   unchanged (Part 3's full required field set applies — this function
 *   adds no defaults and skips no validation).
 * scientificQuestionId (optional): if supplied, the resolved familyKey is
 *   attached to that already-registered Scientific Question
 *   (scientificQuestion.attachFamilyToQuestion) — refuses if the Question
 *   does not exist. Idempotent-safe: does not re-attach if already
 *   attached (checked via listFamiliesForQuestion first, since
 *   attachFamilyToQuestion's own store is append-only and has no
 *   duplicate-prevention of its own).
 * discovery: { pValue, testMethod, testedAt, experimentId } passed to
 *   evaluateDiscoveryCandidate() unchanged.
 */
export async function runGovernedResearchPipeline({
  registrationSpec,
  market,
  targetDefinition,
  scientificQuestionId,
  discovery,
} = {}) {
  // Step 2 actually resolves BEFORE Step 1's write completes, because
  // Part 3 hard-requires a familyKey to already exist as one of
  // registerHypothesis()'s own REQUIRED_REGISTRATION_FIELDS -- Family
  // Assignment is conceptually upstream of Registration's actual write,
  // whichever order they are described in narratively. A caller may
  // either supply registrationSpec.familyKey directly (it is then reused
  // unchanged, never second-guessed) or supply market+targetDefinition
  // and let this step resolve it via the SAME tolerance-aware resolution
  // the Discovery step itself would use — either way the familyKey used
  // for Registration and the one used for Discovery are guaranteed
  // identical.
  const familyKey = registrationSpec.familyKey || resolveOrCreateFamilyKey({ market, targetDefinition });

  // Step 1: Hypothesis Registration (Part 2/3). registerHypothesis() is
  // itself the sole write path — every one of its own preconditions
  // (Data Access Attestation, analyticalChoiceSet, etc.) applies unchanged.
  // If the hypothesisId is already registered, this call fails exactly as
  // registerHypothesis() always has (native ConstraintError) -- a caller
  // resuming an already-registered hypothesis should call the later steps
  // directly instead of this one-shot function.
  const registration = await registerHypothesis({ ...registrationSpec, familyKey });

  // Step 3: Scientific Question (Part 6), optional.
  let scientificQuestion = null;
  if (scientificQuestionId) {
    const question = await getQuestion(scientificQuestionId);
    if (!question) {
      throw new Error(`runGovernedResearchPipeline: scientificQuestionId "${scientificQuestionId}" does not reference a registered Scientific Question.`);
    }
    const attached = await listFamiliesForQuestion(scientificQuestionId);
    if (!attached.some((row) => row.familyKey === familyKey)) {
      await attachFamilyToQuestion(scientificQuestionId, familyKey);
    }
    scientificQuestion = question;
  }

  // Steps 4-6: Discovery Engine -> Statistical Testing -> Online FDR.
  const discoveryResult = await runGovernedDiscoveryStep({
    hypothesisId: registration.hypothesisId,
    familyKey,
    ...discovery,
  });

  return {
    registration,
    familyKey,
    scientificQuestion,
    lifecycleStage: await getCurrentLifecycleStage(registration.hypothesisId),
    discoveryResult,
  };
}
