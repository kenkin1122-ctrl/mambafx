/**
 * research/src/candidate/EventProcessFeature.js
 *
 * Purpose:
 *   Phase 12 Candidate subclass for the Event Process domain -- the sixth
 *   sibling subtype alongside IndicatorFeature, MarketState, ProxyCandidate,
 *   CompositeCandidate, ConditionalHypothesis. Represents a hypothesis
 *   about ONE event-local feature (e.g. "TimeGap between consecutive
 *   5-run events") as a real, testable Candidate -- Generated, Screened,
 *   Triaged, Confirmed, Replicated, Published, exactly like every other
 *   subtype, through the exact same, unmodified generateCandidate().
 *
 * REFINEMENT #3 (passive data object, no statistical logic): this class
 *   stores IDENTITY, METADATA, and PROVENANCE only -- featureName (routes
 *   back to the real eventProcess/EventFeatureRegistry.js plugin at
 *   resolution time, never a cached/frozen computed value -- same
 *   discipline IndicatorFeature/MarketState/ProxyCandidate already
 *   follow: the actual signal is always recomputed fresh from real data
 *   at Confirmation time, never trusted from storage) and the identity of
 *   the specific event pair this feature concerns (eventId,
 *   previousEventId). It has NO compute()/test()/statistical method of
 *   its own -- exactly like every other Candidate subtype, this is a
 *   record of WHAT is being tested, never HOW to test it. The Null Model
 *   Hierarchy that eventually tests it (per refinement #4) lives entirely
 *   outside this class, resolved via a StatisticalProcedureRegistry (a
 *   separate, later slice).
 *
 * REFINEMENT #5 (versioned provenance, distinct from software version):
 *   protocolVersion/extractorVersion/schemaVersion are NEW fields, not a
 *   reuse of Candidate.js's existing generatorVersion/configHash --
 *   because this project's own governing premise for Phase 12 is "the
 *   protocol is frozen, the software may evolve": generatorVersion tracks
 *   which SOFTWARE build generated this candidate; protocolVersion tracks
 *   which FROZEN SCIENTIFIC PROTOCOL (e.g. "P12-GAP-v1.1.0") it was
 *   generated under. These are genuinely different facts and must both be
 *   recorded independently, following the SAME flat-field convention
 *   Candidate.js already uses for researchFreezeId/sapId/configHash
 *   (no nested "provenance" sub-object was introduced, for consistency).
 *
 * Scientific rationale for a DEDICATED class (not reusing IndicatorFeature):
 *   an event-local feature is computed from a fundamentally different
 *   domain -- a sparse, irregularly-spaced EVENT sequence, not a
 *   uniformly-sampled tick/price series -- with fundamentally different
 *   math (waiting times, hazard rates, not price statistics). This
 *   mirrors exactly why ProxyCandidate got its own class rather than
 *   being folded into IndicatorFeature: a real ontological distinction,
 *   not a convenience.
 *
 * NO DUPLICATION: mirrors ProxyCandidate.js's exact pattern (fingerprint,
 *   provenance, lineage, lifecycle, evidence tier, implementation
 *   maturity, reproducibility, uncertainty, decision audit, research
 *   freeze, SAP, configuration -- all inherited unmodified from
 *   Candidate.js's common fields).
 *
 * Additional fields (beyond base Candidate):
 *   featureName       — the registered EventFeatureRegistry plugin name
 *   eventId           — the event this feature concerns
 *   previousEventId   — the event it was computed against, or null (first
 *                        event of a session -- mirrors the plugin's own
 *                        honest-null discipline)
 *   protocolVersion   — the frozen scientific protocol version (e.g. "P12-GAP-v1.1.0")
 *   extractorVersion  — the EventFeatureRegistry plugin's own version() at generation time
 *   schemaVersion     — the mfx_msd_events schema version this candidate assumes
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: EventProcessFeature.
 * Complexity: O(1) construction; O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

export class EventProcessFeature extends Candidate {
  // Note: no bare class field declarations — see IndicatorFeature.js for the rationale.
  // @field {string} featureName       - EventFeatureRegistry plugin name.
  // @field {string} eventId           - The event this feature concerns.
  // @field {string|null} previousEventId - The event pair's predecessor, or null.
  // @field {string} protocolVersion   - Frozen scientific protocol version.
  // @field {string} extractorVersion  - Source plugin's own version() at generation time.
  // @field {string} schemaVersion     - mfx_msd_events schema version assumed.

  /** @private — use EventProcessFeature.create(). */
  constructor(fields) {
    super(fields);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates EventProcessFeature-specific fields, computes fingerprint.
   *
   * @param {object} params - Base Candidate fields plus:
   * @param {string} params.featureName - Required non-empty string; must
   *   match a plugin registered in eventProcess/EventFeatureRegistry.js
   *   at generation time (this class does not enforce that itself -- the
   *   generator, same as for every other subtype, is responsible for
   *   only ever constructing candidates for real registered plugins).
   * @param {string} params.eventId - Required non-empty string.
   * @param {string|null} [params.previousEventId] - Nullable string;
   *   null means this is the first event of its session (honest, not an error).
   * @param {string} params.protocolVersion - Required non-empty string.
   * @param {string} params.extractorVersion - Required non-empty string.
   * @param {string} params.schemaVersion - Required non-empty string.
   * @returns {Promise<EventProcessFeature>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE,
    });
    const typeErrors = [];
    if (!params.featureName || typeof params.featureName !== 'string')
      typeErrors.push('featureName: required non-empty string (must match an EventFeatureRegistry plugin name)');
    if (!params.eventId || typeof params.eventId !== 'string')
      typeErrors.push('eventId: required non-empty string');
    if (params.previousEventId !== null && params.previousEventId !== undefined && typeof params.previousEventId !== 'string')
      typeErrors.push('previousEventId: must be a non-empty string or null (null = first event of session)');
    if (!params.protocolVersion || typeof params.protocolVersion !== 'string')
      typeErrors.push('protocolVersion: required non-empty string (the frozen scientific protocol version)');
    if (!params.extractorVersion || typeof params.extractorVersion !== 'string')
      typeErrors.push('extractorVersion: required non-empty string (the source plugin\'s own version())');
    if (!params.schemaVersion || typeof params.schemaVersion !== 'string')
      typeErrors.push('schemaVersion: required non-empty string (the mfx_msd_events schema version assumed)');

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE,
        fields: allErrors,
      });
    }

    const previousEventId = params.previousEventId ?? null;
    const effectiveParams = { ...params, type: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE };
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        featureName: params.featureName,
        eventId: params.eventId,
        previousEventId,
        protocolVersion: params.protocolVersion,
        extractorVersion: params.extractorVersion,
        schemaVersion: params.schemaVersion,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new EventProcessFeature({
      ...common,
      featureName: params.featureName,
      eventId: params.eventId,
      previousEventId,
      protocolVersion: params.protocolVersion,
      extractorVersion: params.extractorVersion,
      schemaVersion: params.schemaVersion,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      featureName: this.featureName,
      eventId: this.eventId,
      previousEventId: this.previousEventId,
      protocolVersion: this.protocolVersion,
      extractorVersion: this.extractorVersion,
      schemaVersion: this.schemaVersion,
    };
  }
}
