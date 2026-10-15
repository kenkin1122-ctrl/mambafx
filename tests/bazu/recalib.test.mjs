import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCorrections, toConfig } from '../../src/bazu/recalib3m.js';
import { lifetime } from '../../src/bazu/duration3m.js';
import { configFor } from '../../src/bazu/config3m.js';
import { CORRECTIONS } from '../../src/bazu/corrections3m.js';

// Constructed records: realised exit time is `real`, the estimator predicts `pred`.
const mk = (at, pred, real, pb = 'breakout', k = 'E1') => ({ at, playbook: pb, estimators: { [k]: pred }, path: { tExit: real, tTarget: real, observedSecs: 1200, complete: true } });
const series = (n, pred, realFn, t0 = 0) => Array.from({ length: n }, (_, i) => mk(t0 + i * 100, pred, realFn(i)));

test('a stable bias is corrected and the correction passes the holdout rule', () => {
  const recs = series(200, 100, (i) => 50 + (i % 5));
  const r = fitCorrections(recs, { embargoSecs: 0 });
  const row = r.rows.find((x) => x.estimator === 'E1' && x.playbook === 'breakout');
  assert.ok(row.factor > 0.45 && row.factor < 0.6, String(row.factor));
  assert.equal(row.applied, true); assert.ok(row.errAfter < row.errBefore);
  assert.deepEqual(Object.keys(toConfig(r.rows).breakout), ['E1']);
});

test('a correction that would make the holdout worse is rejected and left unchanged', () => {
  const recs = [...series(140, 100, (i) => 50 + (i % 5)), ...series(60, 100, (i) => 100 + (i % 3), 14000)]; // regime change in the test period
  const row = fitCorrections(recs, { embargoSecs: 0 }).rows.find((x) => x.estimator === 'E1');
  assert.equal(row.applied, false); assert.match(row.reason, /does not reduce holdout error/);
});

test('thin playbooks are not corrected and the reason is reported', () => {
  const recs = [...series(200, 100, (i) => 50 + (i % 5)), ...series(10, 100, () => 30, 0).map((r) => ({ ...r, playbook: 'range fade' }))];
  const row = fitCorrections(recs, { embargoSecs: 0 }).rows.find((x) => x.playbook === 'range fade');
  assert.equal(row.applied, false); assert.match(row.reason, /too thin/);
});

test('no leakage: the factor is identical when the holdout labels are changed', () => {
  const base = series(200, 100, (i) => 50 + (i % 5));
  const poisoned = base.map((r, i) => (i >= 140 ? { ...r, path: { ...r.path, tExit: 1000, tTarget: 1000 } } : r));
  const a = fitCorrections(base, { embargoSecs: 0 }).rows[0], b = fitCorrections(poisoned, { embargoSecs: 0 }).rows[0];
  assert.equal(a.factor, b.factor); assert.equal(a.trainN, b.trainN);
});

test('flag OFF leaves every lifetime unchanged; ON scales only the listed estimator; raw estimators are never rewritten', () => {
  const base = configFor('R_100');
  const args = (cfg) => ({ raw: { E1: 100, E3: 400, E5: 240 }, playbook: 'breakout', marketClass: 'volatility', triggerSecs: 60, cfg });
  const off = lifetime(args({ ...base, ESTIMATOR_CORRECTION: false }));
  assert.equal(base.ESTIMATOR_CORRECTION, false);
  const on = lifetime(args({ ...base, ESTIMATOR_CORRECTION: true, COMBINE: 'min', CORRECTIONS: { factors: { breakout: { E1: 0.5 } } } }));
  const offMin = lifetime(args({ ...base, ESTIMATOR_CORRECTION: false, COMBINE: 'min' }));
  assert.equal(offMin.combined, 100); assert.equal(on.combined, 50);
  assert.deepEqual(on.estimators, offMin.estimators); // raw values recorded unchanged
  assert.equal(lifetime(args({ ...base, ESTIMATOR_CORRECTION: true, COMBINE: 'min', CORRECTIONS: { factors: { 'range fade': { E1: 0.5 } } } })).combined, 100); // other playbook untouched
  assert.ok(off.lifetime > 0);
});

test('shipped corrections are versioned and only contain factors that passed the holdout', () => {
  assert.ok(CORRECTIONS.version); assert.deepEqual(Object.keys(CORRECTIONS.factors), ['breakout']);
  assert.ok(Object.isFrozen(CORRECTIONS));
});
