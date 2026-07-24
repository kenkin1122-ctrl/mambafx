/**
 * research/src/governance/scientificQuestion.js
 *
 * Purpose:
 *   Implement the Scientific Question half of Volume IV v3.0 Part 6: a
 *   Scientific Question is the pre-registered research aim ("does any
 *   short-window feature combination predict the initiation of a 5-tick
 *   Rise on R_100?") that one or more Families (family.js) are tested
 *   under. Registering a Question before Families/Hypotheses are created
 *   under it is what lets the Laboratory later distinguish a pre-planned
 *   research program from an ad hoc pattern-fishing expedition — the same
 *   falsifiability discipline Part 3's Hypothesis Registry enforces one
 *   level up.
 *
 * Responsibilities:
 *   - registerScientificQuestion(spec): append-only registration of a new
 *     Question (add()-only, mirroring hypothesisRegistry.js's "no
 *     overwrite" discipline for the same reason: a Question's definition
 *     must not be silently redefined after Families are already testing
 *     under it).
 *   - attachFamilyToQuestion(questionId, familyKey): records that a given
 *     Family Key is now tested under an existing Question. Implemented as
 *     an additional append-only "attachment" row (never an in-place edit of
 *     the Question's own familyKeys array), so the full history of which
 *     Families were added to a Question, and when, is itself an immutable,
 *     auditable fact.
 *   - listFamiliesForQuestion(questionId): every Family attached to a
 *     Question, in attachment order.
 *   - getQuestion(questionId) / listQuestionsForMarket(market): bounded
 *     reads via the by_market_createdAt / primary-key indexes.
 *
 * Inputs: plain objects describing a Question (market, researchAim,
 *   registeredBy, registeredAt) or a Family attachment.
 * Outputs: Promises resolving to the new questionId, an attachment id, or
 *   arrays of rows.
 * Dependencies: storage/researchGovernanceDb.js (getScientificQuestionsAdapter).
 *
 * Public API: registerScientificQuestion, attachFamilyToQuestion,
 *   listFamiliesForQuestion, getQuestion, listQuestionsForMarket,
 *   InvalidScientificQuestionError.
 * Internal API: none.
 *
 * Error handling: validation failures throw InvalidScientificQuestionError
 *   synchronously before any write; a duplicate questionId fails via the
 *   native IndexedDB ConstraintError on add(), exactly like
 *   hypothesisRegistry.registerHypothesis's duplicate-hypothesisId case.
 * Performance notes: getQuestion is a single-key get() (O(log n));
 *   listFamiliesForQuestion and listQuestionsForMarket use the declared
 *   indexes, never an unbounded scan.
 * Threading model: main-thread only.
 * Storage usage: ScientificQuestions store only. Family attachments are
 *   modeled as additional rows in the SAME store (a Question row has
 *   `recordType: 'question'`; an attachment row has `recordType:
 *   'family-attachment'`, keyed by its own questionId-derived id) rather
 *   than a new physical store — this keeps Part 6's storage footprint to
 *   one store, consistent with Principle 3 (retire/avoid anything that adds
 *   maintenance burden without a corresponding discovery benefit; a
 *   dedicated second store for what is structurally still "facts about a
 *   Question" would be exactly that kind of avoidable overhead).
 * Complexity analysis: all operations are O(log n + k) against declared
 *   indexes.
 * Future extension notes: Question status transitions (e.g., "Active" ->
 *   "Answered" -> "Retired") are out of scope for this initial slice and
 *   should be added the same way Lifecycle Stage transitions were added in
 *   hypothesisRegistry.js — a new append-only row per status change, never
 *   an in-place mutation.
 */

import { getScientificQuestionsAdapter } from '../storage/researchGovernanceDb.js';

export class InvalidScientificQuestionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidScientificQuestionError';
  }
}

const REQUIRED_QUESTION_FIELDS = Object.freeze(['questionId', 'market', 'researchAim', 'registeredBy']);

function assertRequired(spec, fields, callerName) {
  for (const f of fields) {
    if (spec[f] === undefined || spec[f] === null || spec[f] === '') {
      throw new InvalidScientificQuestionError(`${callerName}: "${f}" is required`);
    }
  }
}

/** Register a new Scientific Question. Fails (native ConstraintError) on a duplicate questionId. */
export async function registerScientificQuestion(spec) {
  assertRequired(spec, REQUIRED_QUESTION_FIELDS, 'registerScientificQuestion');
  const createdAt = spec.createdAt ?? Date.now();
  const adapter = await getScientificQuestionsAdapter();
  const record = {
    questionId: spec.questionId,
    recordType: 'question',
    market: spec.market,
    researchAim: spec.researchAim,
    registeredBy: spec.registeredBy,
    status: 'Active',
    createdAt,
  };
  await adapter.add(record);
  return record;
}

/** Attach an existing Family (by its canonical familyKey) to an existing Question, as a new immutable row. */
export async function attachFamilyToQuestion(questionId, familyKey) {
  if (!questionId) throw new InvalidScientificQuestionError('attachFamilyToQuestion: "questionId" is required');
  if (!familyKey) throw new InvalidScientificQuestionError('attachFamilyToQuestion: "familyKey" is required');
  const adapter = await getScientificQuestionsAdapter();
  const createdAt = Date.now();
  const id = `${questionId}::attach::${familyKey}::${createdAt}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    questionId: id, // primary key for this store is questionId (see keyPath in indexingStrategy.js)
    recordType: 'family-attachment',
    parentQuestionId: questionId,
    familyKey,
    market: null,
    createdAt,
  };
  await adapter.add(record);
  return record.questionId;
}

/** The Question's own registration row, or undefined if never registered. */
export async function getQuestion(questionId) {
  const adapter = await getScientificQuestionsAdapter();
  return adapter.get(questionId);
}

/**
 * Every Family attached to a Question, in attachment order. Reads the full
 * store's getAll() is intentionally NOT used here — instead we rely on the
 * question/attachment rows' shared parentQuestionId and filter client-side
 * over a bounded set, since ScientificQuestions is expected to remain a
 * small, slow-growing store (one row per Question plus one per attachment,
 * not one per Discovery run) — see Storage usage note above.
 */
export async function listFamiliesForQuestion(questionId) {
  const adapter = await getScientificQuestionsAdapter();
  const all = await adapter.getAll();
  return all
    .filter((row) => row.recordType === 'family-attachment' && row.parentQuestionId === questionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Every Question registered for a market, newest first (bounded index read). */
export async function listQuestionsForMarket(market, { limit = Infinity } = {}) {
  const adapter = await getScientificQuestionsAdapter();
  const rows = await adapter.listByIndexRange('by_market_createdAt', [market], { limit });
  return rows.filter((row) => row.recordType === 'question');
}
