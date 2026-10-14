import test from 'node:test';
import assert from 'node:assert/strict';
import { configFor, TARGET, settle, marketClass } from '../../src/bazu/config3m.js';
import { enrich, formingCandle, closedOnly, robustAtr } from '../../src/bazu/candles3m.js';
import { pinBar, engulfing, star, doji, insideBar, runPatterns } from '../../src/bazu/patterns3m.js';
import { extendedMove, confirmed, breakoutState } from '../../src/bazu/context3m.js';
import { predict3m, triggerFor, spikeContext } from '../../src/bazu/predict3m.js';
import { buildTradeSignal, GATE, modeMayAct } from '../../src/bazu/decision.js';
import { bucketCandles } from '../../src/bazu/timeframes.js';

const cfg = configFor('R_100');
const C = (o, h, l, c, i) => ({ epoch: 1700000000 + i * 300, open: o, high: h, low: l, close: c });
/** n flat-ish candles around 100 with range 1 (ATR ~ 1), then extras. */
const base = (n = 20) => Array.from({ length: n }, (_, i) => (i % 2 ? C(100.4, 100.7, 99.8, 100, i) : C(100, 100.7, 99.8, 100.4, i)));
const build = (extra) => enrich([...base(), ...extra.map((x, k) => C(...x, 20 + k))], cfg);

test('(a) patterns on hand-built candles', () => {
  const hammer = build([[100.5, 100.65, 99.4, 100.6]]);
  const p = pinBar(hammer, hammer.length - 1, cfg);
  assert.ok(p.present && p.direction === 1, 'hammer');
  const star1 = build([[100.6, 100.65, 99.5, 99.6]]);
  const bear = build([[100, 100.2, 99.0, 99.2], [99.1, 100.5, 99.0, 100.4]]);
  assert.ok(engulfing(bear, bear.length - 1, cfg).present && engulfing(bear, bear.length - 1, cfg).direction === 1, 'bullish engulfing');
  const dj = build([[100, 100.5, 99.5, 100.01]]);
  assert.ok(doji(dj, dj.length - 1, cfg).present, 'doji');
  const inside = build([[100, 101.5, 99, 101.2], [100.9, 101.2, 100.2, 100.5]]);
  assert.ok(insideBar(inside, inside.length - 1, cfg).present, 'inside bar');
  assert.ok(runPatterns(hammer, hammer.length - 1, cfg).some((r) => r.name === 'pinBar'));
  assert.equal(star1.length, 21);
});

test('(a) only closed candles are used', () => {
  const cs = [C(100, 101, 99, 100.5, 0), C(100.5, 102, 100, 101, 1)];
  const closed = closedOnly(cs, 300, cs[1].epoch + 100);
  assert.equal(closed.length, 1);
});

test('(b) spike candles are excluded and followed by a cooldown; robust ATR ignores them', () => {
  const cs = build([[100, 110, 90, 108], [108, 108.5, 107.5, 108.2], [108.2, 108.6, 107.6, 108], [108, 108.5, 107.5, 108.1], [108.1, 108.6, 107.6, 108.2], [108.2, 108.8, 107.8, 108.4]]);
  const sp = cs[20];
  assert.ok(sp.spike && !sp.patternOk);
  assert.ok(cs[21].cooling && !cs[21].patternOk && cs[23].cooling);
  assert.ok(cs[25].patternOk, 'cooldown ends');
  assert.ok(!pinBar(cs, 20, cfg).present);
  assert.ok(robustAtr(cs)[21] < 2, 'median ATR not distorted by one spike');
});

test('(c) context rules: reversal needs zone + extended move + confirmation', () => {
  const down = Array.from({ length: 24 }, (_, i) => C(110 - i * 0.5, 110.3 - i * 0.5, 109.6 - i * 0.5 - 0.1, 109.5 - i * 0.5, i));
  const hammer = C(98.2, 98.3, 97.0, 98.25, 24), conf = C(98.3, 99.2, 98.2, 99.1, 25);
  const cs = enrich([...down, hammer, conf], cfg);
  const frames = { trigger: cs, setup: cs, context: cs, bias: cs, H1: cs, forming: null };
  const zone = { low: 96.8, high: 98.0, mid: 97.4, kind: 'support', touches: 3, strength: 3, fresh: true, flipped: false, tf: 'M15', overlap: 1 };
  const atr = cs.at(-1).atr;
  assert.ok(extendedMove(cs, 23, cfg).ext, 'extended down move');
  assert.ok(confirmed(cs, 24, 1, 0));
  const withZone = triggerFor(1, 'setup', { frames, cfg, zones: [zone], atr, price: 99, flow: {} });
  const noZone = triggerFor(1, 'setup', { frames, cfg, zones: [], atr, price: 99, flow: {} });
  assert.ok(withZone.score > 0, 'valid in context');
  assert.equal(noZone.score, 0, 'no zone -> no trigger');
  const noConf = enrich([...down, hammer, C(98.2, 98.25, 97.5, 97.6, 25)], cfg);
  assert.equal(triggerFor(1, 'setup', { frames: { ...frames, trigger: noConf, setup: noConf }, cfg, zones: [zone], atr, price: 97.6, flow: {} }).score, 0, 'unconfirmed');
});

test('(d) breakout, fakeout sequences', () => {
  const zone = { low: 99.8, high: 100, mid: 99.9, kind: 'resistance', touches: 3, strength: 3, fresh: true, flipped: false, tf: 'M15', overlap: 0 };
  const rng = Array.from({ length: 20 }, (_, i) => C(99.2, 99.9, 98.9, 99.3, i));
  const up = enrich([...rng, C(99.4, 100.6, 99.3, 100.5, 20), C(100.5, 100.9, 100.1, 100.6, 21), C(100.6, 101, 100.1, 100.8, 22)], cfg);
  const b = breakoutState(up, [zone], cfg);
  assert.equal(b.state, 'confirmed'); assert.equal(b.direction, 1);
  const fake = enrich([...rng, C(99.6, 100.9, 99.5, 99.7, 20), C(99.7, 99.8, 99.2, 99.3, 21), C(99.3, 99.6, 99.0, 99.2, 22)], cfg);
  const f = breakoutState(fake, [zone], cfg);
  assert.equal(f.state, 'fakeout'); assert.equal(f.direction, -1);
});

function walk(N = 120000, seed = 7) {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const p = [], e = []; let x = 1000;
  for (let i = 0; i < N; i++) { x += (r() - 0.5) * 0.6 + Math.sin(i / 900) * 0.05; p.push(x); e.push(1700000000 + i); }
  return { p, e, remote: { M1: bucketCandles(p, e, 60), M5: bucketCandles(p, e, 300), M15: bucketCandles(p, e, 900), H1: bucketCandles(p, e, 3600) } };
}
const run = (w, k, extra = {}) => predict3m({ symbol: 'R_100', prices: w.p.slice(k - 6000, k + 1), epochs: w.e.slice(k - 6000, k + 1), remote: w.remote, decisionEpoch: w.e[k], ...extra });
const points = Array.from({ length: 200 }, (_, i) => 20000 + i * 500);

test('(e) any veto returns WAIT and a non-tradable gate; warm-up waits', () => {
  const w = walk();
  let waits = 0;
  for (const k of points) {
    const o = run(w, k);
    if (o.vetoes.length) { assert.ok(o.wait); waits++; assert.notEqual(buildTradeSignal({ symbol: 'R_100', prediction: o, duration: '3m', quote: { ask: 1, payout: 1.9 } }).gate, GATE.OK); }
  }
  assert.ok(waits > 0);
  const early = predict3m({ symbol: 'R_100', prices: w.p.slice(0, 200), epochs: w.e.slice(0, 200), remote: {}, decisionEpoch: w.e[199] });
  assert.ok(early.wait && /warming up/.test(early.reason));
  const sp = spikeContext('BOOM1000', { trigger: [{ epoch: 100, spike: true, cooling: false }, { epoch: 160, spike: false, cooling: true }] }, [1], [200], configFor('BOOM1000'), 1);
  assert.ok(sp.sinceSecs >= 0 && sp.meanSecs > 0);
});

test('(f) config changes alter output', () => {
  const w = walk();
  const trades = points.filter((k) => !run(w, k).wait);
  assert.ok(trades.length > 0, 'baseline trades somewhere');
  for (const k of trades) assert.ok(run(w, k, { overrides: { SCORE_MIN: 5 } }).wait);
  const off = run(w, points.at(-1), { overrides: { factors: { kalman: { enabled: false } } } });
  assert.ok(!('kalman' in off.factors) && 'kalman' in run(w, points.at(-1)).factors);
  assert.ok(configFor('BOOM1000').factors.spike.enabled && !configFor('R_100').factors.spike.enabled);
  assert.ok(!configFor('stpRNG').patterns.pinBar.enabled);
  assert.equal(marketClass('RB100'), 'rangebreak');
});

test('(g) pattern logging does not affect trading', () => {
  const w = walk();
  for (const k of points) {
    const a = run(w, k, { logPatterns: true }), b = run(w, k, { logPatterns: false });
    assert.equal(a.direction, b.direction); assert.equal(a.wait, b.wait); assert.equal(a.strength, b.strength);
    assert.deepEqual(a.vetoes, b.vetoes); assert.equal(b.patterns.length, 0);
  }
});

test('(h) forming candle is provisional, uses only earlier ticks, signal stores decision time', () => {
  const p = [1, 2, 3, 4, 5], e = [60, 70, 80, 90, 100];
  const f = formingCandle(p, e, 60, 85);
  assert.equal(f.provisional, true); assert.equal(f.high, 3); assert.equal(f.close, 3);
  const w = walk(), k = 33000;
  const a = run(w, k), b = predict3m({ symbol: 'R_100', prices: w.p.slice(k - 6000, k + 3000), epochs: w.e.slice(k - 6000, k + 3000), remote: w.remote, decisionEpoch: w.e[k] });
  assert.equal(a.decisionTs, w.e[k]);
  assert.equal(a.direction, b.direction); assert.equal(a.score, b.score); assert.deepEqual(a.vetoes, b.vetoes);
});

test('(i) target is the exit-vs-entry outcome, ties lose', () => {
  assert.equal(TARGET.tiesWin, false);
  assert.equal(settle(1, 100, 100.01), 'win'); assert.equal(settle(1, 100, 100), 'loss');
  assert.equal(settle(-1, 100, 99.9), 'win'); assert.equal(settle(-1, 100, 100), 'loss'); assert.equal(settle(-1, 100, 101), 'loss');
  const s = buildTradeSignal({ symbol: 'R_100', prediction: { wait: true, direction: 1, strength: 0.9, up: 5, down: 0, total: 5, drivers: [], vetoes: ['x'] }, duration: '3m', quote: { ask: 1, payout: 1.9 } });
  assert.equal(s.gate, GATE.WEAK); assert.ok(!modeMayAct('auto', s));
});
