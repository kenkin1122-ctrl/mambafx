/**
 * tests/phase11/validationUi.test.mjs
 *
 * Tests for research/src/ui/Phase11ValidationDashboard.js and
 * Phase11ValidationApplication.js — Section 8 of the Phase 11 Validation
 * & Calibration Directive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDocument } from '../support/fakeDom.js';
import { createPhase11ValidationDashboard } from '../../research/src/ui/Phase11ValidationDashboard.js';
import {
  mountPhase11Validation,
  Phase11ValidationUIError,
} from '../../research/src/ui/Phase11ValidationApplication.js';
import { buildValidationReport } from '../../research/src/validation/ValidationReport.js';
import { runCalibrationBatch } from '../../research/src/validation/CalibrationStudy.js';

test('createPhase11ValidationDashboard: renders an honest empty state with no report', () => {
  const doc = createFakeDocument();
  const dashboard = createPhase11ValidationDashboard(doc);
  assert.match(dashboard.element.textContent, /No validation report generated yet/);
});

test('createPhase11ValidationDashboard: renders a real calibration report, including the overall verdict badge', async () => {
  const doc = createFakeDocument();
  const dashboard = createPhase11ValidationDashboard(doc);

  const calibration = await runCalibrationBatch({
    datasetType: 'independent_prng', trials: 10, seed: 1, alpha: 0.05,
    datasetLength: 150, permutations: 150, bootstrapResamples: 150,
  });
  const report = buildValidationReport({ calibration, confirmationDiagnostics: calibration.reports });

  dashboard.updateReport(report);
  assert.match(dashboard.element.textContent, /PASS|FAIL/);
  assert.match(dashboard.element.textContent, /Empirical FDR/);
  assert.match(dashboard.element.textContent, /Mean Monte Carlo SE/);
});

test('mountPhase11Validation: throws without a valid container', () => {
  assert.throws(() => mountPhase11Validation(null), Phase11ValidationUIError);
});

test('mountPhase11Validation: mounts and updates cleanly, then unmounts', async () => {
  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const handle = mountPhase11Validation(container);
  assert.equal(container.children.length, 1);

  const calibration = await runCalibrationBatch({
    datasetType: 'iid_random_walk', trials: 8, seed: 2, alpha: 0.05,
    datasetLength: 150, permutations: 150, bootstrapResamples: 150,
  });
  const report = buildValidationReport({ calibration });
  handle.updateReport(report);
  assert.match(container.textContent, /Empirical FDR/);

  handle.unmount();
  assert.equal(container.children.length, 0);
});

test('UI isolation: neither validation UI file imports a protected legacy module or touches IndexedDB directly', async () => {
  const fs = await import('node:fs');
  for (const file of ['Phase11ValidationDashboard.js', 'Phase11ValidationApplication.js']) {
    const src = await fs.promises.readFile(
      new URL(`../../research/src/ui/${file}`, import.meta.url), 'utf8'
    );
    assert.ok(!/from\s+['"][^'"]*(onlineFdr|discoveryDecision|hypothesisRegistry|lockbox|randomnessAudit)\.js['"]/.test(src));
    assert.ok(!/indexedDB\.open|IDBFactory/.test(src));
  }
});
