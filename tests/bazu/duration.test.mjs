import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { configFor } from '../../src/bazu/config3m.js';
import * as D from '../../src/bazu/duration3m.js';
import { shadowOutcome, firstTouch, resolveRecord, calibrationSummary, accuracyByDuration } from '../../src/bazu/calibration3m.js';
import { ewmaVarRate } from '../../src/bazu/ta3m.js';
import { durationAllowed } from '../../src/bazu/universe.js';
import { predict3m } from '../../src/bazu/predict3m.js';
import { bucketCandles } from '../../src/bazu/timeframes.js';

const cfg = configFor('R_100');
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('estimators match hand-computed values', () => {
  near(D.e1(2, 1, 0.5), 4);
  near(D.e2(2, 0.5), 4 / (D.Z75 ** 2 * 0.5));
  near(D.e3(6, 2, true), 3); assert.equal(D.e3(6, 2, false), null);
  near(D.e4(10, 0.7), 17.369655941662063, 1e-6); near(D.e4(1, 0.7) , 1.7369655941662063, 1e-9);
  near(D.e5(4, 60), 240);
  assert.equal(D.e1(null, 1, 1), null); assert.equal(D.e1(1, 1, 0), null);
});

test('EWMA variance rate scales per second', () => {
  const p = [0, 1, 0, 1, 0, 1], e1 = [0, 1, 2, 3, 4, 5], e2 = [0, 2, 4, 6, 8, 10];
  near(ewmaVarRate(p, e1) / ewmaVarRate(p, e2), 2);
});

test('median / min / mean combination and playbook table', () => {
  near(D.combine([10, 20, 100], 'median'), 20); near(D.combine([10, 20, 100], 'min'), 10); near(D.combine([10, 20, 30], 'mean'), 20);
  assert.equal(D.combine([null, null], 'median'), null);
  const raw = { E1: 100, E2: 999, E3: 300, E4: 50, E5: 200, E6: null };
  const brk = D.lifetime({ raw, playbook: 'breakout', marketClass: 'volatility', triggerSecs: 60, cfg });
  assert.deepEqual(Object.keys(brk.estimators).filter((k) => brk.estimators[k] != null).sort(), ['E1', 'E3', 'E5']);
  near(brk.lifetime, 200);
  const fade = D.lifetime({ raw, playbook: 'range fade', marketClass: 'volatility', triggerSecs: 60, cfg });
  assert.deepEqual(Object.keys(fade.estimators).filter((k) => fade.estimators[k] != null).sort(), ['E1', 'E4']);
  near(fade.lifetime, 75);
});

test('E6 and trigger-multiple caps', () => {
  const raw = { E1: 400, E5: 600, E6: 30 };
  const bc = D.lifetime({ raw, playbook: 'breakout', marketClass: 'boomcrash', triggerSecs: 60, cfg });
  near(bc.lifetime, 30); assert.equal(bc.cappedBy, 'E6');
  const noE6 = D.lifetime({ raw, playbook: 'breakout', marketClass: 'volatility', triggerSecs: 60, cfg });
  assert.ok(noE6.estimators.E6 == null);
  const capped = D.lifetime({ raw: { E1: 5000, E5: 5000 }, playbook: 'breakout', marketClass: 'volatility', triggerSecs: 10, cfg });
  near(capped.lifetime, cfg.MAX_TRIGGER_MULTIPLE * 10); assert.equal(capped.cappedBy, 'MAX_TRIGGER_MULTIPLE');
});

const ranges = [{ expiry: 'tick', lo: { unit: 't', n: 1 }, hi: { unit: 't', n: 10 } }, { expiry: 'intraday', lo: { unit: 's', n: 15 }, hi: { unit: 'h', n: 24 } }];

test('allowed durations come from contracts_for; 1 tick excluded unless enabled', () => {
  const a = D.allowedDurations(ranges, 2, cfg, durationAllowed);
  assert.ok(a.length && a.every((d) => durationAllowed(ranges, d) && d.secs >= cfg.MIN_DURATION_S && d.secs <= cfg.MAX_DURATION_S));
  assert.ok(!a.some((d) => d.unit === 't' && d.n === 1));
  const on = D.allowedDurations(ranges, 2, { ...cfg, ALLOW_1_TICK: true, MIN_DURATION_S: 1 }, durationAllowed);
  assert.ok(on.some((d) => d.unit === 't' && d.n === 1));
  const tickOnly = D.allowedDurations([ranges[0]], 2, cfg, durationAllowed);
  assert.ok(tickOnly.every((d) => d.unit === 't')); near(tickOnly.find((d) => d.n === 5).secs, 10);
});

test('snapping and WAIT rules', () => {
  const a = D.allowedDurations(ranges, 2, cfg, durationAllowed);
  const s = D.snapDuration(100, a, cfg); assert.ok(a.includes(s.duration));
  assert.equal(D.snapDuration(110, a, { ...cfg, SNAP: 'round_up' }).duration.secs >= 110, true);
  assert.equal(D.snapDuration(110, a, { ...cfg, SNAP: 'round_down' }).duration.secs <= 110, true);
  const lo = D.snapDuration(1, a, cfg); assert.equal(lo.duration, null); assert.match(lo.reason, /outside tradable range/);
  const hi = D.snapDuration(cfg.MAX_DURATION_S * cfg.SKIP_FACTOR * 1.1, a, cfg); assert.equal(hi.duration, null); assert.match(hi.reason, /outside tradable range/);
  assert.ok(D.snapDuration(cfg.MAX_DURATION_S * 1.2, a, cfg).duration, 'slightly above max snaps to max');
  assert.equal(D.snapDuration(null, a, cfg).duration, null);
  assert.equal(D.snapDuration(100, [], cfg).duration, null);
});

test('chosen duration changes with sigma and distances', () => {
  const a = D.allowedDurations(ranges, 2, cfg, durationAllowed);
  const pick = (aa, b, s2) => D.snapDuration(D.lifetime({ raw: { E1: D.e1(aa, b, s2) }, playbook: 'trending pullback', marketClass: 'volatility', triggerSecs: 60, cfg }).lifetime, a, cfg).duration;
  const base = pick(2, 1, 0.02), fastVol = pick(2, 1, 0.2), wider = pick(6, 3, 0.02);
  assert.ok(fastVol.secs < base.secs); assert.ok(wider.secs > base.secs);
});

test('shadow outcome uses contract entry/exit tick rules, ties lose', () => {
  const e = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], p = [10, 10, 11, 12, 11, 10, 9, 9, 9, 9];
  assert.equal(shadowOutcome({ prices: p, epochs: e, at: 0, dir: 1, d: { unit: 't', n: 2 } }), 'win');
  assert.equal(shadowOutcome({ prices: p, epochs: e, at: 0, dir: 1, d: { unit: 't', n: 4 } }), 'loss');
  assert.equal(shadowOutcome({ prices: p, epochs: e, at: 0, dir: -1, d: { unit: 't', n: 5 } }), 'win');
  assert.equal(shadowOutcome({ prices: [10, 10, 10, 10], epochs: [0, 1, 2, 3], at: 0, dir: -1, d: { unit: 't', n: 2 } }), 'loss', 'tie loses');
  assert.equal(shadowOutcome({ prices: p, epochs: e, at: 0, dir: 1, d: { unit: 't', n: 50 } }), null);
});

test('calibration measures first-touch times on constructed ticks', () => {
  const e = Array.from({ length: 100 }, (_, i) => i), p = e.map((i) => 100 + (i === 30 ? 5 : 0) + (i > 30 ? 5 : 0));
  const t = firstTouch({ prices: p, epochs: e, at: 0, dir: 1, target: 105, invalid: 95, maxSecs: 50 });
  assert.deepEqual(t, { kind: 'target', secs: 30 });
  const inv = firstTouch({ prices: p.map((x, i) => (i === 10 ? 94 : x)), epochs: e, at: 0, dir: 1, target: 105, invalid: 95, maxSecs: 50 });
  assert.deepEqual(inv, { kind: 'invalid', secs: 10 });
  assert.equal(firstTouch({ prices: Array(100).fill(100), epochs: e, at: 0, dir: 1, target: 105, invalid: 95, maxSecs: 50 }).kind, 'none');
  assert.equal(firstTouch({ prices: [100, 100], epochs: [0, 1], at: 0, dir: 1, target: 105, invalid: 95, maxSecs: 50 }).kind, null, 'undecided');
  const rec = { at: 0, dir: 1, target: 105, invalid: 95, predicted: 40, estimators: { E1: 40 }, playbook: 'breakout', durSec: 20, durKey: '20s', shadowDs: [{ unit: 's', n: 20, key: '20s' }], realised: null, shadow: {} };
  assert.ok(resolveRecord(rec, p, e, { ...cfg, MAX_DURATION_S: 50 }));
  const sum = calibrationSummary([rec]);
  assert.equal(sum.byPlaybook.breakout.n, 1); near(sum.byPlaybook.breakout.medianErrorS, 10); assert.equal(sum.targetFirst, 1);
  assert.equal(accuracyByDuration([rec])[0].n, 1);
});

function walk(N = 120000, seed = 7) {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const p = [], e = []; let x = 1000;
  for (let i = 0; i < N; i++) { x += (r() - 0.5) * 0.6 + Math.sin(i / 900) * 0.05; p.push(x); e.push(1700000000 + i); }
  return { p, e, remote: { M1: bucketCandles(p, e, 60), M5: bucketCandles(p, e, 300), M15: bucketCandles(p, e, 900), H1: bucketCandles(p, e, 3600) } };
}
const run = (w, k, extra = {}) => predict3m({ symbol: 'R_100', prices: w.p.slice(k - 6000, k + 1), epochs: w.e.slice(k - 6000, k + 1), remote: w.remote, decisionEpoch: w.e[k], ...extra });

test('DURATION_MODE=fixed uses DEFAULT_DURATION_S; lifetime mode derives it; manual is tagged', () => {
  const w = walk(), allowed = D.allowedDurations(ranges, 1, cfg, durationAllowed);
  let fixedSeen = 0, lifeSeen = 0, manualSeen = 0;
  for (let k = 20000; k < 120000 && (fixedSeen < 3 || lifeSeen < 1); k += 500) {
    const f = run(w, k, { allowed, overrides: { DURATION_MODE: 'fixed' } });
    if (f.duration) { assert.equal(f.durationSec, cfg.DEFAULT_DURATION_S); assert.equal(f.manual, false); fixedSeen++; }
    const l = run(w, k, { allowed });
    if (l.duration) { assert.ok(allowed.some((d) => `${d.n}${d.unit}` === l.duration.key)); assert.ok(l.lifetime.estimators); assert.ok(Number.isFinite(l.lifetime.lifetime)); lifeSeen++; }
    const m = run(w, k, { allowed, manualKey: '45s' });
    if (m.lifetime) { assert.equal(m.duration.key, '45s'); assert.equal(m.manual, true); manualSeen++; }
  }
  assert.ok(fixedSeen > 0 && lifeSeen > 0 && manualSeen > 0);
});

test('no literal contract duration in logic code', () => {
  let out = '';
  try { out = execSync('git grep --untracked -n -E "\\b(180|threeMinute|FRAME_SECS|durationSec \\|\\| 180)\\b" -- src/bazu ":!src/bazu/config3m.js"', { encoding: 'utf8' }).toString().trim(); } catch (e) { if (e.status !== 1) throw e; }
  assert.equal(out, '');
});
