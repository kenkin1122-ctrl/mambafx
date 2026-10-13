import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeSignal, GATE, modeMayAct } from '../../src/bazu/decision.js';
import { checkOrder } from '../../src/bazu/risk.js';
import { predictDirection } from '../../src/bazu/predict.js';
import { fmtPrice, decimalsFromPip, bucketCandles, mergeLive, localCandles, timeframe, TIMEFRAMES } from '../../src/bazu/timeframes.js';

const q = { ask: 1, payout: 1.95 };
const pred = (strength, direction = 1) => ({ direction, strength, up: 7, down: 2, total: 10, drivers: ['RSI-10'], proxy: false });

test('decision: always a Rise or Fall, gated by strength and quote', () => {
  const a = buildTradeSignal({ symbol: 'R_100', prediction: pred(0.5), duration: '5t', quote: q });
  assert.equal(a.direction, 'Rise'); assert.equal(a.gate, GATE.OK);
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred(0.5, -1), duration: '5t', quote: q }).direction, 'Fall');
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred(0.05), duration: '5t', quote: q }).gate, GATE.WEAK);
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred(0.9), duration: '5t', quote: null }).gate, GATE.NO_QUOTE);
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: null, duration: '5t', quote: q }).gate, GATE.NO_DATA);
});

test('semi-auto and auto need a tradable signal; manual does not', () => {
  assert.equal(modeMayAct('manual', null), true);
  assert.equal(modeMayAct('auto', { gate: GATE.WEAK }), false);
  assert.equal(modeMayAct('semi', { gate: GATE.OK }), true);
});

test('risk gate', () => {
  const st = { open: [], todayPnl: 0, lastTradeAt: {}, balance: 100 };
  const o = { stake: 1, market: 'R_100', isReal: false, realConfirmed: false, now: 1e6 };
  assert.equal(checkOrder(o, st).ok, true);
  assert.equal(checkOrder({ ...o, isReal: true }, st).ok, false);
});

test('predictDirection follows the consensus of directional features', () => {
  const up = Array.from({ length: 500 }, (_, i) => i / 100), dn = up.map((v) => -v);
  const prices = Array.from({ length: 500 }, (_, i) => 100 + i);
  const mk = (v) => ({ values: v, directional: true, discrete: false, proxy: false });
  const r = predictDirection({ a: mk(up), b: mk(up), c: mk(dn), x: { values: up, directional: false } }, prices);
  assert.equal(r.direction, 1); assert.equal(r.total, 3); assert.ok(r.strength > 0);
  assert.equal(predictDirection({ a: mk(dn), b: mk(dn) }, prices).direction, -1);
  assert.equal(predictDirection({}, prices), null);
});

test('prices keep trailing zeros', () => {
  assert.equal(fmtPrice(1247.8, 2), '1247.80');
  assert.equal(fmtPrice(9515, 2), '9515.00');
  assert.equal(fmtPrice(0.1, 3), '0.100');
  assert.equal(fmtPrice(null, 2), '—');
  assert.equal(decimalsFromPip(0.01), 2); assert.equal(decimalsFromPip(0.001), 3); assert.equal(decimalsFromPip(2), 2);
});

test('timeframes: 2 ticks to 1 hour, candles built from real ticks', () => {
  assert.equal(TIMEFRAMES[0].key, '2t'); assert.equal(TIMEFRAMES[TIMEFRAMES.length - 1].key, '1h');
  const P = [1, 2, 3, 2, 5, 4], E = [0, 5, 10, 16, 20, 31];
  const b = bucketCandles(P, E, 15);
  assert.deepEqual(b.map((c) => [c.open, c.high, c.low, c.close]), [[1, 3, 1, 3], [2, 5, 2, 5], [4, 4, 4, 4]]);
  assert.equal(localCandles(P, E, timeframe('2t'), 10).length, 3);
  const m = mergeLive([{ epoch: 0, open: 1, high: 2, low: 1, close: 2 }], [5, 9], [30, 70], 60);
  assert.equal(m.length, 2); assert.equal(m[0].close, 5); assert.equal(m[1].open, 9);
});
