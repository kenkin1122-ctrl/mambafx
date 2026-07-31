/**
 * tests/phase11/validationReport.test.mjs
 *
 * Tests for research/src/validation/ValidationReport.js — Section 9 of the
 * Phase 11 Validation & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildValidationReport } from '../../research/src/validation/ValidationReport.js';
import { ScientificDebtLog, DEBT_TYPE, DEBT_PRIORITY } from '../../research/src/governance/ScientificDebtLog.js';
import { verifyReplicationIndependence } from '../../research/src/validation/ReplicationValidator.js';

test('buildValidationReport: with no inputs, produces an empty-but-valid, JSON-serialisable report with overallVerdict PASS', () => {
  const report = buildValidationReport({});
  assert.equal(report.overallVerdict, 'PASS');
  assert.equal(report.calibration, null);
  assert.equal(report.power, null);
  assert.equal(report.reproducibility, null);
  assert.equal(report.replication, null);
  assert.equal(report.statisticalDiagnostics, null);
  assert.deepEqual(report.remainingScientificDebt, []);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('buildValidationReport: aggregates calibration, reproducibility, and replication results into an overall verdict', () => {
  const calibration = { calibrationVerdict: 'PASS', empiricalFDR: 0.04 };
  const reproducibility = { matched: true, mismatches: [], comparisons: [] };
  const replication = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 100 }, replicationRange: { startTick: 100, endTick: 200 },
    originalEffectSize: 0.1, replicationPooledEffectSize: 0.1,
  });

  const report = buildValidationReport({ calibration, reproducibility, replication });
  assert.equal(report.overallVerdict, 'PASS');
  assert.equal(report.reproducibility.allMatched, true);
  assert.equal(report.replication.allIndependent, true);
});

test('buildValidationReport: a FAILing calibration or a CONTAMINATED replication flips the overall verdict to FAIL', () => {
  const failingCalibration = { calibrationVerdict: 'FAIL', empiricalFDR: 0.4 };
  const contaminatedReplication = verifyReplicationIndependence({
    originalRange: { startTick: 0, endTick: 100 }, replicationRange: { startTick: 50, endTick: 150 },
    originalEffectSize: 0.1, replicationPooledEffectSize: 0.1,
  });

  const report1 = buildValidationReport({ calibration: failingCalibration });
  assert.equal(report1.overallVerdict, 'FAIL');

  const report2 = buildValidationReport({ replication: contaminatedReplication });
  assert.equal(report2.overallVerdict, 'FAIL');
});

test('buildValidationReport: summarises confirmation diagnostics across several reports', () => {
  const confirmationDiagnostics = [
    { monteCarloStandardError: 0.01, bootstrapCiWidth: 0.2, instabilityWarning: null },
    { monteCarloStandardError: 0.02, bootstrapCiWidth: 0.3, instabilityWarning: 'bootstrap distribution is notably skewed' },
  ];
  const report = buildValidationReport({ confirmationDiagnostics });
  assert.equal(report.statisticalDiagnostics.count, 2);
  assert.equal(report.statisticalDiagnostics.instabilityWarningsCount, 1);
  assert.ok(Math.abs(report.statisticalDiagnostics.meanMonteCarloStandardError - 0.015) < 1e-9);
});

test('buildValidationReport: surfaces open items from a real ScientificDebtLog', () => {
  const debtLog = new ScientificDebtLog();
  debtLog.create({
    id: 'test-debt-1', type: DEBT_TYPE.IMPLEMENTATION_GAP, description: 'test debt item',
    priority: DEBT_PRIORITY.HIGH, assignedTo: null,
  });
  const report = buildValidationReport({ scientificDebtLog: debtLog });
  assert.equal(report.remainingScientificDebt.length, 1);
  assert.equal(report.remainingScientificDebt[0].id, 'test-debt-1');
});
