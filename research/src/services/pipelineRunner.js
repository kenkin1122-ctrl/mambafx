/**
 * research/src/services/pipelineRunner.js
 *
 * Purpose:
 *   Orchestration-only skeleton for running an experiment context through
 *   the Stage 0-9 pipeline (Volume III Section 9's Implementation Order).
 *   Phase 1 scope: this module defines the STAGE REGISTRY MECHANISM only —
 *   no stage engine exists yet (Stages 0/5/6/7/8/9 land in Phases 2-7). It
 *   must contain zero statistical or scientific logic of its own; its only
 *   job is to sequence whatever stages have been registered, in the frozen
 *   order, and hand each one the previous stage's output.
 *
 * Responsibilities:
 *   - registerStage(stageId, {run, reconcile}): stages register themselves
 *     here once implemented (Phase 2 onward) rather than pipelineRunner
 *     importing each stage directly — this keeps pipelineRunner ignorant of
 *     any stage's internals, satisfying Dependency Rule 8 (cross-stage
 *     communication via public API/bus only — pipelineRunner calls a
 *     stage's registered `run` function, never reaches into its module
 *     internals).
 *   - runFrom(stageId, context): sequentially invokes every registered
 *     stage from `stageId` onward, in STAGE_ORDER (imported from
 *     constants.js-adjacent ordering, defined here since it is pipeline-
 *     sequencing metadata, not a version/threshold constant), passing each
 *     stage's output forward as the next stage's input.
 *   - getRegisteredStages(): introspection for tests/UI ("which stages are
 *     currently wired up").
 *
 * Inputs: stageId (string matching STAGE_ORDER), a context object (shape
 *   owned by whichever stage produced it — pipelineRunner treats it as
 *   opaque).
 * Outputs: Promise resolving to an array of { stageId, result } in
 *   execution order, or rejecting with the first stage failure (context of
 *   which stage failed is attached to the error).
 * Dependencies: none beyond the STAGE_ORDER list below — deliberately zero
 *   imports of any stage module, by design.
 *
 * Public API: registerStage, unregisterStage, runFrom, getRegisteredStages,
 *   STAGE_ORDER.
 * Internal API: none.
 *
 * Error handling: if a stage's `run` throws/rejects, runFrom stops
 *   sequencing further stages and rejects with an error carrying
 *   {stageId, cause} — pipelineRunner never silently continues past a
 *   failed stage (a silent skip would be exactly the kind of "phantom
 *   validation" failure mode this lab has already been burned by once,
 *   R-060).
 * Performance notes: negligible orchestration overhead; actual cost lives
 *   entirely inside each registered stage's `run` function.
 * Threading model: main-thread orchestration; a stage's `run` function may
 *   itself delegate to a Worker (Stage 0/7) — pipelineRunner does not know
 *   or care.
 * Storage usage: none directly.
 * Complexity analysis: O(stages) per runFrom call, independent of data size.
 * Future extension notes: adding Stage 10 (should the lab ever need one) is
 *   an append to STAGE_ORDER plus a registerStage call from that stage's own
 *   module — no change to runFrom's logic.
 */

export const STAGE_ORDER = Object.freeze([
  'stage0', 'stage1', 'stage2', 'stage3', 'stage4',
  'stage5', 'stage6', 'stage7', 'stage8', 'stage9',
]);

const registry = new Map();

/**
 * @param {string} stageId one of STAGE_ORDER
 * @param {{ run: (context:any) => Promise<any>|any, reconcile?: () => Promise<any>|any }} handlers
 */
/**
 * Required Fix 7 (defensive improvement): registering the same stageId
 * twice is now detected and rejected by default rather than silently
 * replacing the prior registration — a silent overwrite could previously
 * mask a double-registration bug (e.g., two different modules both
 * registering "stage5" due to an import-path mistake) with no signal that
 * anything unusual happened. Pass { replace: true } for the rare legitimate
 * case (e.g., hot-reloading a stage module during development).
 */
export function registerStage(stageId, handlers, { replace = false } = {}) {
  if (!STAGE_ORDER.includes(stageId)) {
    throw new Error(`pipelineRunner.registerStage: "${stageId}" is not a recognized stage id (STAGE_ORDER: ${STAGE_ORDER.join(', ')})`);
  }
  if (!handlers || typeof handlers.run !== 'function') {
    throw new TypeError(`pipelineRunner.registerStage: "${stageId}" must be registered with a { run } handler`);
  }
  if (registry.has(stageId) && !replace) {
    throw new Error(
      `pipelineRunner.registerStage: "${stageId}" is already registered. This is rejected by default because a ` +
      'silent double-registration usually indicates an import-path mistake or an accidental duplicate module load. ' +
      'Call unregisterStage(stageId) first, or pass { replace: true } if this is a deliberate re-registration.'
    );
  }
  registry.set(stageId, handlers);
}

export function unregisterStage(stageId) {
  registry.delete(stageId);
}

export function getRegisteredStages() {
  return STAGE_ORDER.filter((id) => registry.has(id));
}

/**
 * Runs every REGISTERED stage from `stageId` onward, in STAGE_ORDER,
 * threading each stage's output into the next stage's input. Stages with no
 * registered handler are skipped (this is expected during Phase 1-7, where
 * only a subset of stages exist yet) — skipping an UNREGISTERED stage is not
 * the same failure mode as a REGISTERED stage throwing, which always halts
 * the run.
 */
export async function runFrom(stageId, context) {
  const startIndex = STAGE_ORDER.indexOf(stageId);
  if (startIndex === -1) {
    throw new Error(`pipelineRunner.runFrom: "${stageId}" is not a recognized stage id`);
  }
  const results = [];
  let currentContext = context;
  for (const id of STAGE_ORDER.slice(startIndex)) {
    const handlers = registry.get(id);
    if (!handlers) continue; // not yet implemented in this phase — expected, not an error
    try {
      const result = await handlers.run(currentContext);
      results.push({ stageId: id, result });
      currentContext = result;
    } catch (cause) {
      const err = new Error(`pipelineRunner.runFrom: stage "${id}" failed`);
      err.stageId = id;
      err.cause = cause;
      throw err;
    }
  }
  return results;
}

/** Test-only: clear every registered stage between test cases. */
export function _clearRegistryForTesting() {
  registry.clear();
}
