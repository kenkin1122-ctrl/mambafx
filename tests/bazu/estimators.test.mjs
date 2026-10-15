import test from 'node:test';
import assert from 'node:assert/strict';
import { pathStats, kaplanMeier, kmMedian, rmst, estimatorReport, chronoSplit, ESTIMATOR_DEFS, observation } from '../../src/bazu/estimators3m.js';
import { resolveRecord } from '../../src/bazu/calibration3m.js';

const ep = (n, t0 = 1000) => Array.from({ length: n }, (_, i) => t0 + i);

test('pathStats: target and invalidation times, adverse excursion, invalidation wins a tie', () => {
  const epochs = ep(8), prices = [100, 99, 98, 99, 101, 103, 100, 104];
  const s = pathStats({ prices, epochs, at: 1000, dir: 1, entry: 100, target: 103, invalid: 98, maxSecs: 10, durSecs: 4 });
  assert.equal(s.tInvalid, 2); assert.equal(s.tTarget, 5); assert.equal(s.tExit, 2); assert.equal(s.exitKind, 'invalid');
  assert.equal(s.maxAdverse, 2); assert.equal(s.maxAdverseInDur, 2); assert.equal(s.maxFavourable, 4);
  assert.equal(s.complete, false);
  const f = pathStats({ prices, epochs, at: 1000, dir: -1, entry: 100, target: 97, invalid: 104, maxSecs: 3 });
  assert.equal(f.tTarget, null); assert.equal(f.tExit, null); assert.equal(f.complete, true); assert.equal(f.maxAdverse, 0);
});

test('Kaplan-Meier with a censored observation matches the hand calculation', () => {
  const c = kaplanMeier([{ t: 1, event: true }, { t: 2, event: false }, { t: 3, event: true }, { t: 4, event: true }]);
  assert.deepEqual(c.map((p) => [p.t, +p.S.toFixed(4)]), [[1, 0.75], [3, 0.375], [4, 0]]);
  assert.equal(kmMedian(c), 3);
  assert.ok(Math.abs(rmst(c, 3.5) - 2.6875) < 1e-9);
});

test('KM median is null (not reached) when most observations are censored', () => {
  const c = kaplanMeier([{ t: 5, event: true }, { t: 9, event: false }, { t: 9, event: false }, { t: 9, event: false }]);
  assert.equal(kmMedian(c), null);
});

test('matched ratio keeps censored records; the old touched-only ratio drops them', () => {
  const mk = (tExit, observed, pred) => ({ playbook: 'breakout', estimators: { E1: pred }, path: { tExit, tTarget: tExit, observedSecs: observed, complete: true } });
  const recs = [mk(10, 1200, 20), mk(20, 1200, 20), mk(null, 1200, 20), mk(null, 1200, 20), mk(null, 1200, 20)];
  const r = estimatorReport(recs, { tau: 1200 }).find((x) => x.estimator === 'E1' && x.playbook === 'ALL');
  assert.equal(r.n, 5); assert.equal(r.events, 2); assert.equal(r.censored, 3); assert.equal(r.oldN, 2);
  assert.equal(r.realMedianKM, null); assert.equal(r.ratioMatched, null); assert.ok(r.ratioUpperIfNotReached > 0);
  assert.equal(r.oldRatio, 1.5); // misleading: only the 2 fast records
});

test('every estimator documents what it predicts and how it is measured; E6 is not available without spike data', () => {
  for (const k of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']) assert.ok(ESTIMATOR_DEFS[k].predicts.length > 10);
  assert.equal(ESTIMATOR_DEFS.E1.measure, 'exit'); assert.equal(ESTIMATOR_DEFS.E2.measure, 'target'); assert.equal(ESTIMATOR_DEFS.E6.measure, null);
  assert.deepEqual(observation({ tTarget: null, tExit: 7, observedSecs: 50 }, 'target'), { t: 50, event: false });
});

test('chronological split: train strictly earlier, embargo removes outcome windows that reach into the test period', () => {
  const recs = Array.from({ length: 10 }, (_, i) => ({ at: 1000 + i * 100 }));
  const { train, test } = chronoSplit(recs, 0.7, 250);
  assert.equal(test.length, 3);
  assert.ok(Math.max(...train.map((r) => r.at)) < Math.min(...test.map((r) => r.at)));
  assert.ok(train.every((r) => r.at + 250 < test[0].at));
  assert.equal(train.length, 5);
});

test('resolveRecord stores the full path (and waits for the whole window) for new-format records only', () => {
  const epochs = ep(60), prices = epochs.map((_, i) => 100 + (i % 7 === 0 ? 1 : 0));
  const cfg = { MAX_DURATION_S: 50 };
  const rec = () => ({ at: 1000, dir: 1, entry: 100, target: 101, invalid: 95, durSec: 5, shadowDs: [], features: { atr: 1 } });
  const early = rec(); assert.equal(resolveRecord(early, prices.slice(0, 20), epochs.slice(0, 20), cfg), false); assert.equal(early.path, undefined);
  const done = rec(); assert.equal(resolveRecord(done, prices, epochs, cfg), true); assert.equal(done.path.tTarget, 7);
  const legacy = { ...rec() }; delete legacy.features; assert.equal(resolveRecord(legacy, prices.slice(0, 20), epochs.slice(0, 20), cfg), true);
});
