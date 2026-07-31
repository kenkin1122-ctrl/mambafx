/**
 * research/src/validation/ValidationReport.js
 *
 * Purpose:
 *   Section 9 of the Phase 11 Validation & Calibration Directive: combines
 *   the outputs of every other validation module into one machine-readable
 *   (JSON-serialisable) report. Pure aggregation — computes nothing itself;
 *   every field is either passed through from an already-computed result
 *   or read from an already-existing registry (ScientificDebtLog).
 *
 * Dependencies: none beyond plain object composition. Callers pass in the
 *   already-computed results from CalibrationStudy.js, PowerStudy.js,
 *   ReproducibilityValidator.js, ReplicationValidator.js, and (optionally)
 *   an existing governance/ScientificDebtLog.js instance for the
 *   "remaining scientific debt" section.
 * Public API: buildValidationReport.
 * Complexity: O(1) (plain object assembly).
 */

/**
 * Assembles the final Phase 11 Validation Report.
 *
 * @param {object} params
 * @param {object} [params.calibration] - A runCalibrationBatch() or
 *   runNegativeControlCampaign() result, or an array of several.
 * @param {object} [params.power] - A runPowerCurve() result.
 * @param {object} [params.reproducibility] - A verifyReproducibility() result
 *   (Phase11ReproducibilityMismatchReport), or an array of several.
 * @param {object} [params.replication] - A verifyReplicationIndependence()
 *   result, or an array of several.
 * @param {object[]} [params.confirmationDiagnostics] - Raw
 *   runAutomatedConfirmationTest() reports whose permutation/bootstrap
 *   diagnostic fields should be summarised.
 * @param {import('../governance/ScientificDebtLog.js').ScientificDebtLog} [params.scientificDebtLog]
 * @param {string} [params.generatedAt] - ISO timestamp; defaults to now.
 * @returns {object} A plain, JSON.stringify-safe report object.
 */
export function buildValidationReport({
  calibration = null, power = null, reproducibility = null, replication = null,
  confirmationDiagnostics = [], scientificDebtLog = null, generatedAt = new Date().toISOString(),
} = {}) {
  const diagnosticsSummary = confirmationDiagnostics.length
    ? {
      count: confirmationDiagnostics.length,
      meanMonteCarloStandardError: confirmationDiagnostics.reduce((a, r) => a + r.monteCarloStandardError, 0) / confirmationDiagnostics.length,
      meanBootstrapCiWidth: confirmationDiagnostics.reduce((a, r) => a + r.bootstrapCiWidth, 0) / confirmationDiagnostics.length,
      instabilityWarningsCount: confirmationDiagnostics.filter((r) => r.instabilityWarning).length,
      instabilityWarnings: confirmationDiagnostics.filter((r) => r.instabilityWarning).map((r) => r.instabilityWarning),
    }
    : null;

  const reproducibilityArray = reproducibility ? (Array.isArray(reproducibility) ? reproducibility : [reproducibility]) : [];
  const reproducibilitySummary = reproducibilityArray.length
    ? {
      checksRun: reproducibilityArray.length,
      allMatched: reproducibilityArray.every((r) => r.matched),
      totalMismatches: reproducibilityArray.reduce((a, r) => a + r.mismatches.length, 0),
      reports: reproducibilityArray,
    }
    : null;

  const replicationArray = replication ? (Array.isArray(replication) ? replication : [replication]) : [];
  const replicationSummary = replicationArray.length
    ? {
      checksRun: replicationArray.length,
      allIndependent: replicationArray.every((r) => r.verdict === 'independent'),
      contaminatedCount: replicationArray.filter((r) => r.verdict === 'CONTAMINATED').length,
      reports: replicationArray,
    }
    : null;

  const scientificDebt = scientificDebtLog
    ? scientificDebtLog.listOpen().map((item) => ({ id: item.id, type: item.type, priority: item.priority, description: item.description }))
    : [];

  const overallVerdict = [
    calibration ? (Array.isArray(calibration) ? calibration.every((c) => (c.calibrationVerdict ?? 'PASS') !== 'FAIL') : (calibration.calibrationVerdict ?? 'PASS') !== 'FAIL') : true,
    reproducibilitySummary ? reproducibilitySummary.allMatched : true,
    replicationSummary ? replicationSummary.allIndependent : true,
  ].every(Boolean) ? 'PASS' : 'FAIL';

  return {
    generatedAt,
    overallVerdict,
    calibration,
    power,
    reproducibility: reproducibilitySummary,
    replication: replicationSummary,
    statisticalDiagnostics: diagnosticsSummary,
    remainingScientificDebt: scientificDebt,
  };
}
