/**
 * research/src/candidate/ProxyCandidate.js
 *
 * Purpose:
 *   Phase 11 Candidate subclass for Market Construct Proxies -- their own
 *   distinct level in the Phase 11 scientific ontology:
 *
 *     Measurements -> Derived Features -> Market Construct Proxies -> Scientific Hypotheses
 *
 *   A proxy is NOT a derived feature (that's IndicatorFeature's level) --
 *   it is an indirect, honestly-disclaimed measurement of a HYPOTHESISED
 *   market construct (support/resistance, institutional activity, etc.),
 *   one ontology level up from a raw indicator computation. This class
 *   exists so a proxy's signal can be tested as a genuine scientific
 *   hypothesis in its own right -- Generated, Screened, Confirmed,
 *   Replicated, Published -- and so it can be referenced as a real
 *   component in a CompositeCandidate (Indicator+Proxy, State+Proxy,
 *   Proxy+Proxy), exactly as IndicatorFeature and MarketState already are.
 *
 *   Mirrors MarketState.js's exact pattern (fingerprint, provenance,
 *   lineage, lifecycle, evidence tier, implementation maturity,
 *   reproducibility, uncertainty, decision audit, research freeze, SAP,
 *   configuration -- all inherited unmodified from Candidate.js's common
 *   fields) rather than introducing any new machinery.
 *
 * Scientific rationale for a DEDICATED class (not reusing IndicatorFeature):
 *   see the architectural audit accompanying this change. Summary: a
 *   proxy's assumedConstruct is a claim about an unobservable market
 *   phenomenon (support, institutional flow) that an indicator's
 *   mathematical definition never makes -- collapsing the two into one
 *   class would either strip the construct claim (losing scientific
 *   information) or bolt it onto IndicatorFeature (making a pure-math
 *   class carry a hypothesised-construct claim it was never designed to
 *   hold, for every future indicator too).
 *
 * NO DUPLICATION: this class stores only enough identity (proxyName +
 *   parameters) to route back to proxy/MarketConstructProxyRegistry.js's
 *   real plugin at computation time -- the same discipline
 *   IndicatorFeature/MarketState already follow. The plugin's own rich
 *   metadata (assumedConstruct, failureModes, biases, confidenceLevel,
 *   scientificEvidenceTier, mathDefinition, disclaimer, etc.) is NOT
 *   copied onto every candidate instance; it is read from the registry
 *   plugin itself when needed. The one exception -- assumedConstruct is
 *   captured on the candidate too, because (like MarketState's
 *   stateLabel) it is the candidate's own scientific claim being tested,
 *   not incidental plugin metadata; it is copied VERBATIM from the
 *   plugin's own metadata().assumedConstruct at generation time, never
 *   invented independently.
 *
 * Additional fields (beyond base Candidate):
 *   proxyName         — the registered MarketConstructProxyRegistry plugin name
 *   assumedConstruct  — the hypothesised market construct this proxy claims
 *                        to measure, copied verbatim from the plugin's own
 *                        metadata (never invented independently)
 *
 * Dependencies: candidate/Candidate.js.
 * Public API: ProxyCandidate.
 * Complexity: O(1) construction; O(n) fingerprint hash.
 */

import { Candidate, CandidateValidationError, CANDIDATE_TYPES } from './Candidate.js';

export class ProxyCandidate extends Candidate {
  // Note: no bare class field declarations — see IndicatorFeature.js for the rationale.
  // @field {string} proxyName        - MarketConstructProxyRegistry plugin name.
  // @field {string} assumedConstruct - Hypothesised construct, copied verbatim from the plugin.

  /** @private — use ProxyCandidate.create(). */
  constructor(fields) {
    super(fields);
    Object.freeze(this);
  }

  /**
   * Async factory. Validates ProxyCandidate-specific fields, computes fingerprint.
   *
   * @param {object} params - Base Candidate fields plus:
   * @param {string} params.proxyName - Required non-empty string; must match
   *   a plugin registered in proxy/MarketConstructProxyRegistry.js at
   *   generation time (this class does not enforce that itself -- the
   *   generator, same as for IndicatorFeature/MarketState, is responsible
   *   for only ever constructing candidates for real registered plugins).
   * @param {string} params.assumedConstruct - Required non-empty string,
   *   copied verbatim from the source plugin's own metadata().assumedConstruct.
   * @returns {Promise<ProxyCandidate>}
   */
  static async create(params) {
    const commonErrors = Candidate._validateCommonFields({
      ...params,
      type: CANDIDATE_TYPES.PROXY_CANDIDATE,
    });
    const typeErrors = [];
    if (!params.proxyName || typeof params.proxyName !== 'string')
      typeErrors.push('proxyName: required non-empty string (must match a MarketConstructProxyRegistry plugin name)');
    if (!params.assumedConstruct || typeof params.assumedConstruct !== 'string')
      typeErrors.push('assumedConstruct: required non-empty string (copied from the source plugin\'s own metadata, never invented)');

    const allErrors = [...commonErrors, ...typeErrors];
    if (allErrors.length) {
      throw new CandidateValidationError(allErrors.join('; '), {
        candidateType: CANDIDATE_TYPES.PROXY_CANDIDATE,
        fields: allErrors,
      });
    }

    const effectiveParams = { ...params, type: CANDIDATE_TYPES.PROXY_CANDIDATE };
    const fingerprintParams = {
      ...effectiveParams,
      parameters: {
        ...effectiveParams.parameters,
        proxyName: params.proxyName,
        assumedConstruct: params.assumedConstruct,
      },
    };
    const fingerprint = await Candidate._computeFingerprint(fingerprintParams);
    const common = Candidate._buildCommonFields(effectiveParams, fingerprint);

    return new ProxyCandidate({
      ...common,
      proxyName: params.proxyName,
      assumedConstruct: params.assumedConstruct,
    });
  }

  toJSON() {
    return {
      ...super.toJSON(),
      proxyName: this.proxyName,
      assumedConstruct: this.assumedConstruct,
    };
  }
}
