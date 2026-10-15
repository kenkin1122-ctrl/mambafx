import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as F from '../../src/bazu/filters3m.js';
import { BASE_CONFIG } from '../../src/bazu/config3m.js';
import { createBook } from '../../src/bazu/signalBook3m.js';

const cfg = BASE_CONFIG;
const cd = (o, h, l, c) => ({ open: o, high: h, low: l, close: c, atr: 1, upperFrac: 0, lowerFrac: 0, bodyRange: 0.8 });
const zone = { low: 99, high: 100, kind: 'resistance', mid: 99.5 };

test('flags default OFF', () => {
  assert.ok(Object.values(cfg.BREAKOUT_FILTERS).every((v) => v === false));
  for (const k of ['RANGE_FADE_EXP', 'ADVERSE_VETO', 'ROOM_NAMED', 'VOL_FILTER', 'COOLDOWN_ON']) assert.equal(cfg[k], false, k);
});

test('breakout filters on hand-built candles, on and off', () => {
  const cs = [cd(99, 99.5, 98.8, 99.2), cd(99.2, 100.9, 99.1, 100.8), cd(100.8, 101.3, 100.4, 101.1)];
  const prices = Array.from({ length: 80 }, (_, i) => 100 + i * 0.01), epochs = prices.map((_, i) => i * 1.37);
  const f = F.breakoutFilters({ cs, zone, dir: 1, atr: 1, prices, epochs, zones: [zone, { low: 103, high: 104, kind: 'resistance' }], price: 101.1, cfg });
  assert.equal(f.penetration.pass, true);
  assert.equal(f.closeConfirm.pass, true);
  assert.equal(f.tickFlow.pass, true);
  assert.equal(f.distance.pass, true);
  assert.equal(f.retestHold.pass, null, 'no retest yet is not a pass');
  const f2 = F.breakoutFilters({ cs, zone, dir: 1, atr: 1, prices, epochs, zones: [zone, { low: 101.5, high: 102, kind: 'resistance' }], price: 101.1, cfg });
  assert.equal(f2.distance.pass, false);
  assert.deepEqual(F.failedFilters(f2, cfg.BREAKOUT_FILTERS), [], 'flags off: nothing vetoes');
  assert.deepEqual(F.failedFilters(f2, { distance: true }), ['distance']);
  const shallow = [cd(99, 99.5, 98.8, 99.2), cd(99.2, 100.4, 99.1, 100.2)];
  assert.equal(F.breakoutFilters({ cs: shallow, zone, dir: 1, atr: 1, prices, epochs, zones: [], price: 100.2, cfg }).penetration.pass, false);
});

test('tick intensity is not available on fixed-rate ticks and never counted as passed', () => {
  const epochs = Array.from({ length: 300 }, (_, i) => 1000 + i), prices = epochs.map((_, i) => 100 + (i % 3));
  assert.equal(F.tickGapsConstant(epochs), true);
  const cs = [cd(99, 99.5, 98.8, 99.2), cd(99.2, 100.9, 99.1, 100.8)];
  const f = F.breakoutFilters({ cs, zone, dir: 1, atr: 1, prices, epochs, zones: [], price: 100.8, cfg });
  assert.equal(f.intensity.pass, null);
  assert.match(f.intensity.reason, /not available/);
  assert.deepEqual(F.failedFilters(f, { intensity: true }), []);
  const irregular = Array.from({ length: 300 }, (_, i) => 1000 + i + (i % 7) * 0.3);
  assert.equal(F.tickGapsConstant(irregular), false);
});

test('missing context returns not-available, never agreement', () => {
  const f = F.breakoutFilters({ cs: [], zone: null, dir: 1, atr: 1, prices: [], epochs: [], zones: [], price: 1, cfg });
  for (const k of F.FILTER_KEYS) assert.equal(f[k].pass, null);
});

test('range fade exp conditions and performance label', () => {
  const z = { low: 100, high: 101 }, c = { lowerFrac: 0.6, upperFrac: 0 };
  assert.equal(F.rangeFadeExp({ adxVal: 15, dir: 1, zone: z, price: 100.1, candle: c, cfg }).ok, true);
  assert.equal(F.rangeFadeExp({ adxVal: 25, dir: 1, zone: z, price: 100.1, candle: c, cfg }).ok, false);
  assert.equal(F.rangeFadeExp({ adxVal: 15, dir: 1, zone: z, price: 100.9, candle: c, cfg }).ok, false);
  assert.match(F.performanceLabel(30, 50, 0.513).label, /insufficient/);
  assert.match(F.performanceLabel(300, 500, 0.513).label, /positive/);
  assert.match(F.performanceLabel(260, 500, 0.513).label, /not distinguishable/);
  assert.ok(!/High Accuracy/i.test(JSON.stringify(F.performanceLabel(300, 500, 0.513))));
});

test('adverse label and named room checks print numbers', () => {
  const rec = { path: { maxAdverseInDur: 3 }, features: { sigmaPerSec: 1 }, durSec: 4 };
  assert.equal(F.adverseLabel(rec, { ADVERSE_K: 1 }), 1);
  assert.equal(F.adverseLabel({ ...rec, path: { maxAdverseInDur: 1 } }, { ADVERSE_K: 1 }), 0);
  assert.equal(F.adverseLabel({ ...rec, features: {} }, { ADVERSE_K: 1 }), null);
  const r = F.roomChecks({ move: 5, room: 5, atr: 2, price: 100, dir: 1, target: 105, invalid: 99, cfg });
  assert.equal(r.fired, 'no-room');
  assert.match(r.text, /expected move 5\.00/);
  assert.match(r.text, /reward 5\.00 \/ risk 1\.00/);
  assert.equal(F.roomChecks({ move: 1, room: 10, atr: 2, price: 100, dir: 1, target: 105, invalid: 99, cfg }).fired, null);
});

test('volatility filter regime labels', () => {
  const v = (rangeATR, adxVal, momentumAligned) => F.volatilityFilter({ rangeATR, adxVal, momentumAligned, cfg });
  assert.deepEqual(v(1.0, 30, true), { high: false, allow: true, label: null });
  assert.deepEqual(v(2, 30, true), { high: true, allow: true, label: 'High volatility - trend confirmed' });
  assert.equal(v(2, 30, false).allow, false);
  assert.deepEqual(v(2, 15, true), { high: true, allow: false, label: 'High volatility - late entry risk' });
  assert.equal(v(2, 22, true).label, 'High volatility - transition');
  assert.equal(v(2, 22, true).allow, false);
  assert.equal(F.volatilityFilter({ rangeATR: 2, adxVal: 22, momentumAligned: true, cfg: { ...cfg, VOL_TRANSITION_ALLOW: true } }).allow, true);
});

test('cooldown gates only new signals, with distinct-setup exceptions; hysteresis', () => {
  const on = { ...cfg, COOLDOWN_ON: true, COOLDOWN_S: 120 };
  const last = { at: 1000, playbook: 'breakout', zoneMid: 5, dir: 1, invalidated: false };
  const same = { playbook: 'breakout', zoneMid: 5, dir: 1 };
  assert.equal(F.cooldownBlocks({ last, now: 1050, cfg, setup: same }).blocked, false, 'flag off');
  assert.equal(F.cooldownBlocks({ last, now: 1050, cfg: on, setup: same }).blocked, true);
  assert.equal(F.cooldownBlocks({ last, now: 1200, cfg: on, setup: same }).blocked, false, 'expired');
  assert.equal(F.cooldownBlocks({ last, now: 1050, cfg: on, setup: { ...same, playbook: 'range fade' } }).blocked, false, 'different playbook');
  assert.equal(F.cooldownBlocks({ last, now: 1050, cfg: on, setup: { ...same, zoneMid: 9 } }).blocked, false, 'different zone');
  assert.equal(F.cooldownBlocks({ last: { ...last, invalidated: true }, now: 1050, cfg: on, setup: same }).blocked, false, 'invalidated earlier signal');
  const h = { HYST_ENTER_EXTRA: 0.05, HYST_EXIT_SLACK: 0.05 };
  assert.equal(F.hysteresisPass({ strength: 0.22, wasTradable: false, min: 0.2, cfg: h }), false);
  assert.equal(F.hysteresisPass({ strength: 0.22, wasTradable: true, min: 0.2, cfg: h }), true);
  assert.equal(F.hysteresisPass({ strength: 0.14, wasTradable: true, min: 0.2, cfg: h }), false);
});

test('cooldown never blocks expiry, invalidation or cancellation of a live signal', () => {
  const c = { ...cfg, COOLDOWN_ON: true, COOLDOWN_S: 10000, SIGNAL_MAX_AGE_S: { mult: 1, min: 5, max: 5 } };
  const book = createBook({ cfgFor: () => c });
  const mk = (ts, price, id) => ({
    mode: 'families', provisional: false, candleId: id, decisionPrice: price, durationSec: 60, sigmaT: 1, invalid: price - 5, target: price + 5, zoneMid: 7,
    setup: { dir: 1, playbook: 'breakout', qualifies: true, triggered: true, trigger: 't', delayReason: null }, verdicts: [], duration: { key: '1m' },
  });
  const a = book.observe('X', mk(0, 100, 1), 0);
  assert.ok(a.signal, 'first signal created');
  const b = book.observe('X', { ...mk(1, 90, 2) }, 1);
  assert.ok(b.events.some((e) => e.to === 'INVALIDATED'), 'invalidation still fires inside cooldown');
  const book2 = createBook({ cfgFor: () => c });
  assert.ok(book2.observe('X', mk(0, 100, 1), 0).signal);
  const gone = book2.observe('X', { mode: 'families', setup: null, verdicts: [], decisionPrice: 100 }, 6);
  assert.ok(gone.events.some((e) => e.to === 'EXPIRED'), 'expiry still fires inside cooldown');
  assert.equal(book2.observe('X', mk(7, 100, 3), 7).signal, null, 'new identical signal blocked by cooldown');
});

test('protected modules have zero diff', () => {
  const out = execSync('git diff --stat origin/main -- research mtf src/trading src/features src/dashboard src/ui', { encoding: 'utf8' }).trim();
  assert.equal(out, '');
});

test('no forbidden labels in the shipped UI sources', () => {
  for (const f of ['page.js', 'engine.js', 'decision.js', 'filters3m.js']) {
    const s = fs.readFileSync(new URL('../../src/bazu/' + f, import.meta.url), 'utf8');
    assert.ok(!/High Accuracy|Weak Signal/.test(s), f);
  }
});
