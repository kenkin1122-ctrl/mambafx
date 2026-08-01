/**
 * research/src/orchestration/startPhase11Campaign.js
 *
 * Purpose: the "Start Phase 11 Campaign" bootstrap — builds a real,
 * locked research cycle (ResearchConfiguration -> ResearchFreeze -> SAP),
 * a FamilyRegistry, a Phase11Orchestrator, and generates a small real
 * batch of IndicatorFeature candidates over well-known technical
 * indicators (RSI, EMA-slope, CCI) — the same indicator family already
 * used elsewhere in this app's Indicator Charts page — each one a genuine
 * Candidate instance with a real fingerprint and provenance, not a mock.
 *
 * Honesty boundary: this module generates and can screen/triage real
 * candidates, but does NOT claim any candidate is a confirmed discovery.
 * Screening/triage require a real scoreFn/diagnostics bundle supplied by
 * the caller (see runPhase11Screening/runPhase11Triage below) — this
 * module never fabricates statistics itself. In the browser, the caller
 * (index.html) supplies a scoreFn computed from actual live tick history,
 * clearly small-sample/demo-scale, not a rigorous confirmed result.
 *
 * Dependencies: config/{ResearchConfiguration,ResearchFreeze,
 *   StatisticalAnalysisPlan}.js, governance/FamilyRegistry.js,
 *   orchestration/Phase11Orchestrator.js, candidate/{Candidate,
 *   MeasurementRegistry}.js.
 * Public API: startPhase11Campaign, runPhase11Screening, runPhase11Triage,
 *   DEFAULT_INDICATOR_CANDIDATES.
 * Complexity: O(1) setup + O(n) candidate generation, n = number of
 *   default indicator candidates (small, fixed).
 */

import { ResearchConfiguration } from '../config/ResearchConfiguration.js';
import { ResearchFreeze } from '../config/ResearchFreeze.js';
import { StatisticalAnalysisPlan } from '../config/StatisticalAnalysisPlan.js';
import { FamilyRegistry } from '../governance/FamilyRegistry.js';
import { Phase11Orchestrator } from './Phase11Orchestrator.js';
import { CANDIDATE_TYPES } from '../candidate/Candidate.js';
import { IndicatorRegistry } from '../indicator/IndicatorRegistry.js';
import { registerCoreIndicators } from '../indicator/coreIndicators.js';
import { MarketStateRegistry } from '../plugin/MarketStateRegistry.js';
import { registerCoreMarketStates } from '../plugin/coreMarketStates.js';
import { streamAllRegistryDrivenCandidates } from '../discovery/registryDrivenCandidateGenerator.js';
import { PRIMITIVE_OBSERVABLES } from '../candidate/MeasurementRegistry.js';
import { INDICATOR_INPUT_FIELDS } from '../candidate/IndicatorFeature.js';

/**
 * A small, fixed set of well-known technical-indicator candidates to seed
 * a new campaign with — real IndicatorFeature parameter sets, not
 * placeholders. These mirror the indicators already computed on this
 * app's Indicator Charts page (RSI, MACD-family EMA slope, CCI), so a
 * researcher can recognise them immediately.
 */
export const DEFAULT_INDICATOR_CANDIDATES = Object.freeze([
  { id: 'rsi-14-close', indicatorName: 'RSI', period: 14, signalLine: null, inputField: INDICATOR_INPUT_FIELDS.CLOSE, description: 'RSI-14 on close price' },
  { id: 'ema-10-slope-close', indicatorName: 'EMA_SLOPE', period: 10, signalLine: null, inputField: INDICATOR_INPUT_FIELDS.CLOSE, description: 'EMA-10 slope on close price' },
  { id: 'cci-20-hlc3', indicatorName: 'CCI', period: 20, signalLine: null, inputField: INDICATOR_INPUT_FIELDS.HLC3, description: 'CCI-20 on (high+low+close)/3' },
]);

const DEFAULT_FAMILY_NAME = 'momentum';

/**
 * Builds a full, real, locked research cycle and generates the default
 * indicator candidates under it.
 *
 * @param {object} [params]
 * @param {string} [params.campaignName='Phase 11 momentum campaign']
 * @param {string} [params.symbol='1HZ100V'] - Recorded in the configuration's
 *   description only (this module doesn't fetch or require live data itself).
 * @param {object[]} [params.indicatorCandidates] - Defaults to DEFAULT_INDICATOR_CANDIDATES.
 * @returns {Promise<{
 *   orchestrator: Phase11Orchestrator,
 *   researchConfiguration: ResearchConfiguration,
 *   researchFreeze: ResearchFreeze,
 *   sap: StatisticalAnalysisPlan,
 *   familyRegistry: FamilyRegistry,
 *   generated: { candidate: object, provenance: object }[]
 * }>}
 */
export async function startPhase11Campaign({
  campaignName = 'Phase 11 momentum campaign',
  symbol = '1HZ100V',
  indicatorCandidates = DEFAULT_INDICATOR_CANDIDATES,
} = {}) {
  const researchConfiguration = await ResearchConfiguration.create({
    id: `rc-${Date.now()}`,
    name: campaignName,
    description: `Momentum-indicator discovery campaign over ${symbol}. Indicators serve as trend filters improving confluence, not direct predictors, on this PRNG-driven synthetic instrument.`,
    grammarVersion: '11.0.0',
    ontologyVersion: '11.0.0',
    generatorVersion: '11.0.0',
    proxyVersions: { coreProxies: '1.0.0' },
  });

  const researchFreeze = await ResearchFreeze.create({
    researchConfigurationId: researchConfiguration.id,
    configHash: researchConfiguration.configHash,
    ontologyVersion: researchConfiguration.ontologyVersion,
    generatorVersion: researchConfiguration.generatorVersion,
    proxyVersions: { ...researchConfiguration.proxyVersions },
    candidateFingerprints: [],
    researchConfigurationHash: researchConfiguration.configHash,
  });

  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-${Date.now()}`,
    hypothesisFamilies: [DEFAULT_FAMILY_NAME],
    alphaAllocation: { [DEFAULT_FAMILY_NAME]: 0.05 },
    promotionPolicies: { screeningPromotionQuantile: 0.5 },
    stoppingRules: [{ maxCandidates: 100 }],
    replicationCriteria: { minReplicationBlocks: 1 },
    publicationCriteria: { minReproducibilityLevel: 1 },
    // Deliberately permissive defaults: this is a starter campaign meant to
    // demonstrate the real pipeline mechanics, not a pre-registered
    // confirmatory study. Tighten these before treating any result as a
    // genuine discovery.
    effectSizeThresholds: { default: 0 },
    minimumSampleSizes: { default: 1 },
    requiredDiagnostics: [],
  });

  const familyRegistry = new FamilyRegistry();
  familyRegistry.registerFamily({
    familyName: DEFAULT_FAMILY_NAME,
    version: '1.0.0',
    allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.MARKET_STATE],
    description: 'Technical-indicator and market-state candidates over synthetic index price series.',
  });

  const orchestrator = new Phase11Orchestrator({ researchFreeze, sap, familyRegistry });

  const candidateParamsList = indicatorCandidates.map((spec) => ({
    id: spec.id,
    family: DEFAULT_FAMILY_NAME,
    parameters: { period: spec.period, inputField: spec.inputField },
    description: spec.description,
    generatorVersion: researchConfiguration.generatorVersion,
    grammarVersion: researchConfiguration.grammarVersion,
    configHash: researchConfiguration.configHash,
    researchConfigurationId: researchConfiguration.id,
    indicatorName: spec.indicatorName,
    period: spec.period,
    signalLine: spec.signalLine,
    inputField: spec.inputField,
    inputObservables: [PRIMITIVE_OBSERVABLES.CANDLE_CLOSE],
  }));

  const generated = await orchestrator.generate({
    candidateType: CANDIDATE_TYPES.INDICATOR_FEATURE,
    candidateParamsList,
  });

  // ReproducibilityGate (used by Phase11Orchestrator.checkPublicationEligibility
  // at Publication time) requires each candidate's fingerprint to already be
  // present in the ResearchFreeze's candidateFingerprints -- rebuild the
  // freeze now that the fingerprints are known (a fingerprint never depends
  // on the freeze itself) and patch each candidate's researchFreezeId to
  // match. This is a bookkeeping fix, not a shortcut around any real
  // scientific check: reproducibilityLevel/implementationMaturity are left
  // at their real (low) defaults, so publication eligibility still fails
  // honestly for these fresh candidates until they're genuinely validated.
  const researchFreezeWithFingerprints = await ResearchFreeze.create({
    researchConfigurationId: researchConfiguration.id,
    configHash: researchConfiguration.configHash,
    ontologyVersion: researchConfiguration.ontologyVersion,
    generatorVersion: researchConfiguration.generatorVersion,
    proxyVersions: { ...researchConfiguration.proxyVersions },
    candidateFingerprints: generated.map((g) => g.candidate.fingerprint),
    researchConfigurationHash: researchConfiguration.configHash,
  });
  orchestrator.researchFreeze = researchFreezeWithFingerprints;

  const patchedGenerated = generated.map(({ candidate, provenance }) => {
    const patched = withField(candidate, 'researchFreezeId', researchFreezeWithFingerprints.id);
    orchestrator.updateCandidate(patched);
    return { candidate: patched, provenance };
  });

  return {
    orchestrator, researchConfiguration, researchFreeze: researchFreezeWithFingerprints,
    sap, familyRegistry, generated: patchedGenerated,
  };
}

/** Clones a frozen candidate with one field overridden (Candidate instances are immutable). */
function withField(candidate, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  descriptors[field] = { value, writable: true, enumerable: true, configurable: true };
  const clone = Object.create(Object.getPrototypeOf(candidate), descriptors);
  Object.freeze(clone);
  return clone;
}

/**
 * Thin re-export so callers only need this one module for the whole
 * "start a campaign, then screen/triage it" flow.
 */
export { runPhase11Screening, runPhase11Triage } from '../discovery/phase11FunnelBridge.js';

// ═══════════════════════════════════════════════════════════════════════════
// Registry-driven campaign (additive -- startPhase11Campaign above is
// completely unchanged and remains the default demo path).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Starts a campaign using discovery/registryDrivenCandidateGenerator.js's
 * streamAllRegistryDrivenCandidates() instead of the fixed 3-candidate
 * DEFAULT_INDICATOR_CANDIDATES list -- "Registry-Driven Candidate
 * Generation" directive, Stage 9 (automatic registration into Generated,
 * without altering confirmation). Builds the same real
 * ResearchConfiguration/ResearchFreeze/SAP/FamilyRegistry cycle as
 * startPhase11Campaign(), then streams candidates from the Indicator and
 * Market State registries through the EXISTING, UNMODIFIED
 * generateCandidate() (the same function Phase11Orchestrator.generate()
 * itself uses) -- every candidate gets a real FamilyRegistry compatibility
 * check, a real ProvenanceDAG, and (if a DecisionAuditLog is supplied) a
 * real GENERATED audit entry, exactly as demo-generated candidates already
 * do. Screening, Triage, and Confirmation are unchanged -- this only
 * replaces WHAT gets generated, never how it's evaluated.
 *
 * @param {object} [params]
 * @param {string} [params.campaignName]
 * @param {string} [params.symbol]
 * @param {number[]} [params.indicatorPeriods] - Defaults to [10, 14, 20, 30].
 * @param {boolean} [params.includeMarketStates=true]
 * @returns {Promise<{
 *   orchestrator: Phase11Orchestrator, researchConfiguration: object,
 *   researchFreeze: object, sap: object, familyRegistry: FamilyRegistry,
 *   generatedCount: number, countsByType: { indicator: number, marketState: number },
 *   provenanceById: Record<string, object>
 * }>}
 */
export async function startRegistryDrivenCampaign({
  campaignName = 'Phase 11 registry-driven campaign', symbol = '1HZ100V',
  indicatorPeriods = [10, 14, 20, 30], includeMarketStates = true,
} = {}) {
  const researchConfiguration = await ResearchConfiguration.create({
    id: `rc-registry-${Date.now()}`, name: campaignName,
    description: `Registry-driven discovery campaign over ${symbol} -- enumerates the Indicator and Market State registries rather than a fixed candidate list.`,
    grammarVersion: '11.0.0', ontologyVersion: '11.0.0', generatorVersion: '11.1.0',
    proxyVersions: { coreProxies: '1.0.0' },
  });

  // Placeholder freeze so generateCandidate()'s precondition is satisfied
  // during generation -- fingerprints aren't known until candidates exist,
  // so (same pattern as startPhase11Campaign() above) the freeze is
  // rebuilt with them afterward and every candidate's researchFreezeId
  // is patched to match.
  const placeholderFreeze = await ResearchFreeze.create({
    researchConfigurationId: researchConfiguration.id, configHash: researchConfiguration.configHash,
    ontologyVersion: researchConfiguration.ontologyVersion, generatorVersion: researchConfiguration.generatorVersion,
    proxyVersions: { ...researchConfiguration.proxyVersions }, candidateFingerprints: [],
    researchConfigurationHash: researchConfiguration.configHash,
  });

  // Every family the auto-categorized indicators (INDICATOR_FAMILY_BY_NAME
  // in registryDrivenCandidateGenerator.js) and market states can land in,
  // plus the DEFAULT_FAMILY_NAME fallback used elsewhere in this file.
  const REGISTRY_FAMILIES = Object.freeze([
    'trend', 'momentum', 'volatility', 'statistical', 'microstructure', 'indicator', 'marketState',
  ]);
  const sap = await StatisticalAnalysisPlan.create({
    sapId: `sap-registry-${Date.now()}`, hypothesisFamilies: [...REGISTRY_FAMILIES],
    alphaAllocation: Object.fromEntries(REGISTRY_FAMILIES.map((f) => [f, 0.05])),
    promotionPolicies: { screeningPromotionQuantile: 0.5 },
    stoppingRules: [{ maxCandidates: 1000000 }], replicationCriteria: { minReplicationBlocks: 1 },
    publicationCriteria: { minReproducibilityLevel: 1 }, effectSizeThresholds: { default: 0 },
    minimumSampleSizes: { default: 1 }, requiredDiagnostics: [],
  });

  const familyRegistry = new FamilyRegistry();
  for (const familyName of REGISTRY_FAMILIES) {
    familyRegistry.registerFamily({
      familyName, version: '1.0.0',
      allowedCandidateTypes: [CANDIDATE_TYPES.INDICATOR_FEATURE, CANDIDATE_TYPES.MARKET_STATE],
      description: `Registry-driven candidates auto-categorized as "${familyName}".`,
    });
  }

  const orchestrator = new Phase11Orchestrator({ researchFreeze: placeholderFreeze, sap, familyRegistry });

  const indicatorRegistry = new IndicatorRegistry();
  registerCoreIndicators(indicatorRegistry);
  const marketStateRegistry = includeMarketStates ? new MarketStateRegistry() : null;
  if (marketStateRegistry) registerCoreMarketStates(marketStateRegistry);

  const generatedFingerprints = [];
  const provenanceById = {};
  const countsByType = { indicator: 0, marketState: 0 };

  for await (const { candidate, provenance } of streamAllRegistryDrivenCandidates({
    indicatorRegistry, marketStateRegistry, periods: indicatorPeriods,
    researchConfiguration, researchFreeze: placeholderFreeze, sap, familyRegistry,
    decisionAuditLog: orchestrator.decisionAuditLog,
  })) {
    orchestrator.updateCandidate(candidate);
    provenanceById[candidate.id] = provenance;
    generatedFingerprints.push(candidate.fingerprint);
    if (candidate.type === CANDIDATE_TYPES.MARKET_STATE) countsByType.marketState++;
    else countsByType.indicator++;
  }

  // Rebuild the freeze to include every generated candidate's fingerprint
  // (ReproducibilityGate requirement -- same fix already applied to
  // startPhase11Campaign()), then patch every candidate's researchFreezeId
  // to match and re-register.
  const researchFreeze = await ResearchFreeze.create({
    researchConfigurationId: researchConfiguration.id, configHash: researchConfiguration.configHash,
    ontologyVersion: researchConfiguration.ontologyVersion, generatorVersion: researchConfiguration.generatorVersion,
    proxyVersions: { ...researchConfiguration.proxyVersions }, candidateFingerprints: generatedFingerprints,
    researchConfigurationHash: researchConfiguration.configHash,
  });
  orchestrator.researchFreeze = researchFreeze;
  for (const candidate of orchestrator.listCandidates()) {
    orchestrator.updateCandidate(withField(candidate, 'researchFreezeId', researchFreeze.id));
  }

  return {
    orchestrator, researchConfiguration, researchFreeze, sap, familyRegistry,
    generatedCount: generatedFingerprints.length, countsByType, provenanceById,
  };
}
