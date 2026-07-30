/**
 * research/integration/campaignRunner.js
 *
 * Purpose:
 *   The ONE manual trigger this first integration exposes, per the
 *   approved rollout decision ("manual execution from the Research
 *   Dashboard for the first integration; automatic scheduling will be
 *   considered only after the integration has been scientifically
 *   validated"). Nothing in this file runs on a timer or a tick
 *   callback — it runs only when `window.mfxRunResearchCampaignStep()`
 *   is called, which only happens from the dashboard's "Run Campaign
 *   Step" button (bootstrap.js wires that one call site).
 *
 * What this module deliberately does NOT do, disclosed explicitly (same
 *   discipline liveResearchOrchestrator.js's own header already applies
 *   to itself):
 *   - It does not invent a registrationSpec, statisticalEvidence, or
 *     publicationTransition to force a full
 *     runFullyGovernedLiveDiscovery() cycle to "complete successfully."
 *     Those are real scientific judgments legacy's own analyzer layer
 *     and a human researcher must supply — fabricating them here would
 *     be exactly the kind of placeholder-implementation this laboratory's
 *     entire governance discipline exists to prevent.
 *   - It does not advance a funnel round (runRoundOneScreening/Two/Three/
 *     Four) itself, because those require real candidate/evidence data
 *     this generic dashboard button does not have. Advancing a funnel
 *     round remains something a real research workflow (Experiment
 *     Runner, or a future, more specific dashboard action once this
 *     integration has been "scientifically validated" per the rollout
 *     decision) must still do explicitly.
 *   - It does not call Online FDR, Discovery Decision, Lockbox,
 *     Publication Status, or Randomness Audit directly — it only ever
 *     calls prioritizeNextRepresentationFamily() (Phase 9, confirmed
 *     read-only/side-effect-free) and reports what that ranking says is
 *     next, exactly the "prioritization-only, never a discovery
 *     decision" boundary the original Phase 9 implementation prompt
 *     required.
 *
 * Responsibilities:
 *   - runResearchCampaignStep(): the one exported action. Calls
 *     campaignPrioritization.prioritizeNextRepresentationFamily() with
 *     dashboardReadModel.ACTIVE_SEARCH_STRATEGY (the single configured
 *     method — no duplicated literal), then rebuilds the dashboard
 *     snapshot so the UI reflects the result. Returns a plain result
 *     object describing what happened (a ranked next-family
 *     recommendation, or an honest "nothing to prioritize yet" /
 *     "requires human-supplied evidence to proceed further" message) —
 *     never a silent success.
 *
 * Inputs: none (reads no external state beyond what
 *   prioritizeNextRepresentationFamily/buildDashboardSnapshot already
 *   read).
 * Outputs: Promise<{ ok: boolean, message: string, prioritization: object|null, snapshot: object }>.
 * Dependencies: ./dashboardReadModel.js (for the snapshot rebuild + the
 *   shared ACTIVE_SEARCH_STRATEGY constant), ../src/discovery/campaignPrioritization.js.
 *
 * Public API: runResearchCampaignStep.
 * Internal API: none.
 *
 * Error handling: an InvalidCampaignPrioritizationInputError (e.g. "no
 *   Active Representation Family exists") is caught and reported as
 *   `{ ok: false, message: <that exact message> }`, not re-thrown —
 *   this is an expected, common state (nothing to prioritize yet), not
 *   a bug. Any other error propagates, since it indicates a real defect.
 * Performance notes: O(active families) — same bound as
 *   prioritizeNextRepresentationFamily itself.
 * Threading model: main thread, invoked only on a user click.
 * Storage usage: read-only.
 * Complexity analysis: O(1) call into an already-analyzed function.
 * Future extension notes: once the integration has been scientifically
 *   validated (the rollout decision's own stated condition for
 *   considering automatic scheduling), a future cadence-driven scheduler
 *   can be added as a SEPARATE module that also calls
 *   runResearchCampaignStep() — this file does not need to change to
 *   support that; it was written to be callable either way.
 */

import { buildDashboardSnapshot, ACTIVE_SEARCH_STRATEGY } from './dashboardReadModel.js';
import {
  prioritizeNextRepresentationFamily,
  InvalidCampaignPrioritizationInputError,
} from '../src/discovery/campaignPrioritization.js';

/**
 * Runs exactly one manual campaign step: ask the Phase 9 adaptive search
 * engine (via campaignPrioritization) which Active Representation Family
 * is currently most worth exploring next, given its own real, recorded
 * arm statistics. Reports the answer; does not act on it further.
 */
export async function runResearchCampaignStep() {
  let prioritization = null;
  let ok = true;
  let message;

  try {
    prioritization = await prioritizeNextRepresentationFamily({ method: ACTIVE_SEARCH_STRATEGY });
    message = `Prioritization complete (method: ${ACTIVE_SEARCH_STRATEGY}). Next recommended Representation Family: "${prioritization.armId}". ` +
      'Advancing this family through the Validation Funnel or registering a new Discovery Campaign round requires a human-supplied ' +
      'candidate/evidence set — this button intentionally does not fabricate one.';
  } catch (err) {
    if (err instanceof InvalidCampaignPrioritizationInputError) {
      ok = false;
      message = err.message;
    } else {
      throw err;
    }
  }

  const snapshot = await buildDashboardSnapshot();
  return { ok, message, prioritization, snapshot };
}
