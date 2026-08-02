/**
 * research/src/eventProcess/streamEventProcessFeatureCandidates.js
 *
 * Purpose:
 *   Candidate Generator for the Event Process domain -- the direct
 *   structural analogue of discovery/registryDrivenCandidateGenerator.js's
 *   streamProxyCandidateParams()/streamProxyCandidates() pair, scoped to
 *   eventProcess/EventFeatureRegistry.js instead of
 *   proxy/MarketConstructProxyRegistry.js. Lives alongside
 *   EventFeatureRegistry.js/coreEventFeatures.js in this domain's own
 *   directory (per the approved "Data Source -> Feature Extractor ->
 *   Candidate Generator -> Candidate Type" pattern's domain-based
 *   organization) rather than growing registryDrivenCandidateGenerator.js
 *   further -- but calls the exact SAME, unmodified, canonical
 *   generateCandidate() (discovery/candidateGenerator.js) every other
 *   domain's stream already uses. No second construction path.
 *
 * One candidate per registered event-local feature plugin (mirroring
 *   streamProxyCandidateParams' one-per-plugin pattern) -- identity is
 *   featureName alone (see EventProcessFeature.js's own corrected
 *   identity-scoping design), a hypothesis template, not one candidate
 *   per event.
 *
 * Dependencies: EventFeatureRegistry.js (unmodified, reused),
 *   discovery/candidateGenerator.js (generateCandidate -- unmodified,
 *   reused), candidate/Candidate.js (CANDIDATE_TYPES, read-only).
 * Public API: streamEventProcessFeatureCandidateParams,
 *   streamEventProcessFeatureCandidates, EventProcessGenerationError.
 * Complexity: O(k) where k = number of registered event-local feature plugins.
 */

import { generateCandidate } from '../discovery/candidateGenerator.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';

export class EventProcessGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EventProcessGenerationError';
  }
}

/**
 * Lazily yields candidateParams-shaped objects for every registered
 * event-local feature plugin -- eventProcess/EventFeatureRegistry.js is
 * the SOLE source; this function copies only featureName from each
 * plugin's own metadata().name, never inventing or duplicating the
 * plugin's own scientific claims.
 *
 * @param {object} params
 * @param {import('./EventFeatureRegistry.js').EventFeatureRegistry} params.eventFeatureRegistry
 * @param {object} params.researchConfiguration
 * @param {string} params.protocolVersion - Required (Refinement #5 --
 *   every generated feature carries versioned provenance).
 * @param {string} [params.schemaVersion='1.0.0'] - The mfx_msd_events
 *   schema version this generation run assumes.
 * @yields {object} A candidateParams object ready for generateCandidate()
 *   (type EVENT_PROCESS_FEATURE).
 */
export function* streamEventProcessFeatureCandidateParams({
  eventFeatureRegistry, researchConfiguration, protocolVersion, schemaVersion = '1.0.0',
} = {}) {
  if (!eventFeatureRegistry || typeof eventFeatureRegistry.list !== 'function') {
    throw new EventProcessGenerationError('streamEventProcessFeatureCandidateParams: a valid EventFeatureRegistry is required');
  }
  if (!researchConfiguration?.id || !researchConfiguration?.configHash) {
    throw new EventProcessGenerationError('streamEventProcessFeatureCandidateParams: a valid ResearchConfiguration is required');
  }
  if (!protocolVersion || typeof protocolVersion !== 'string') {
    throw new EventProcessGenerationError('streamEventProcessFeatureCandidateParams: protocolVersion is required (refinement #5 -- versioned provenance on every generated feature)');
  }

  for (const plugin of eventFeatureRegistry.list()) {
    const meta = plugin.metadata();
    yield {
      id: `eventprocess-${meta.name}`,
      family: 'eventProcess',
      parameters: {},
      description: `${meta.displayName || meta.name} — auto-generated from the Event Feature Registry, tested as a hypothesis across the full available event history.`,
      generatorVersion: '12.0.0',
      grammarVersion: '11.0.0',
      configHash: researchConfiguration.configHash,
      researchConfigurationId: researchConfiguration.id,
      featureName: meta.name,
      protocolVersion,
      extractorVersion: meta.version,
      schemaVersion,
    };
  }
}

/**
 * Streams fully-governed, deduplicated EventProcessFeature instances --
 * the Event Process domain's counterpart to streamProxyCandidates(). Same
 * generateCandidate()-routed governance, same graceful onSkip handling,
 * same fingerprint deduplication.
 *
 * @param {object} params - Same as streamEventProcessFeatureCandidateParams, plus:
 * @param {import('../config/ResearchFreeze.js').ResearchFreeze} params.researchFreeze
 * @param {import('../config/StatisticalAnalysisPlan.js').StatisticalAnalysisPlan} params.sap
 * @param {import('../governance/FamilyRegistry.js').FamilyRegistry} [params.familyRegistry]
 * @param {import('../governance/DecisionAuditLog.js').DecisionAuditLog} [params.decisionAuditLog]
 * @param {Set<string>} [params.seenFingerprints]
 * @param {(err: Error, candidateParams: object) => void} [params.onSkip]
 * @yields {{ candidate: object, provenance: object }}
 */
export async function* streamEventProcessFeatureCandidates({
  eventFeatureRegistry, researchConfiguration, protocolVersion, schemaVersion = '1.0.0',
  researchFreeze, sap, familyRegistry = null, decisionAuditLog = null,
  seenFingerprints = new Set(), onSkip = null,
} = {}) {
  for (const candidateParams of streamEventProcessFeatureCandidateParams({
    eventFeatureRegistry, researchConfiguration, protocolVersion, schemaVersion,
  })) {
    let result;
    try {
      result = await generateCandidate({
        candidateType: CANDIDATE_TYPES.EVENT_PROCESS_FEATURE,
        candidateParams, researchFreeze, sap, familyRegistry, decisionAuditLog,
      });
    } catch (err) {
      if (onSkip) onSkip(err, candidateParams);
      continue;
    }
    if (seenFingerprints.has(result.candidate.fingerprint)) continue;
    seenFingerprints.add(result.candidate.fingerprint);
    yield result;
  }
}
