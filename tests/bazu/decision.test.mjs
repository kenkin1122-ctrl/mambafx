import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeSignal, GATE, modeMayAct } from '../../src/bazu/decision.js';
import { checkOrder } from '../../src/bazu/risk.js';
import { signalForSetup } from '../../src/bazu/validation.js';

const setup = (lo) => ({ id: 'bazu:RSI-10:follow', stage: 'Published', duration: '5t', probability: 0.6, oos: { p: 0.62, n: 120, lo }, proxy: false });

test('gate: LCB must exceed quoted break-even', () => {
  const q = { ask: 1, payout: 1.95 }; // BE ~ 0.5128
  assert.equal(buildTradeSignal({ symbol: 'R_100', setup: setup(0.53), direction: 1, quote: q }).gate, GATE.OK);
  assert.equal(buildTradeSignal({ symbol: 'R_100', setup: setup(0.51), direction: 1, quote: q }).gate, GATE.BELOW_BE);
  assert.equal(buildTradeSignal({ symbol: 'R_100', setup: setup(0.9), direction: 1, quote: null }).gate, GATE.NO_QUOTE);
  assert.equal(buildTradeSignal({ symbol: 'R_100', setup: { ...setup(0.9), stage: 'Replicated' }, direction: 1, quote: q }).gate, GATE.NO_EDGE);
});

test('semi-auto and auto need a tradable signal; manual does not', () => {
  assert.equal(modeMayAct('manual', null), true);
  assert.equal(modeMayAct('auto', { gate: GATE.NO_EDGE }), false);
  assert.equal(modeMayAct('semi', { gate: GATE.OK }), true);
});

test('risk gate', () => {
  const st = { open: [], todayPnl: 0, lastTradeAt: {}, balance: 100 };
  const o = { stake: 1, market: 'R_100', isReal: false, realConfirmed: false, now: 1e6 };
  assert.equal(checkOrder(o, st).ok, true);
  assert.equal(checkOrder({ ...o, isReal: true }, st).ok, false);
  assert.equal(checkOrder({ ...o, isReal: true, realConfirmed: true, stake: 3 }, st).ok, false);
  assert.equal(checkOrder(o, { ...st, todayPnl: -25 }).ok, false);
  assert.equal(checkOrder(o, { ...st, open: [{ market: 'R_100' }] }).ok, false);
});

test('signalForSetup parses single IDs', () => {
  const v = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 5));
  const feats = { 'RSI-10': { values: v, directional: true, discrete: false } };
  const d = signalForSetup(feats, 'bazu:RSI-10:follow');
  assert.ok(d && d.length === 1000);
  assert.equal(signalForSetup(feats, 'bazu:NOPE-1:follow'), null);
});
