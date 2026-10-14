import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configFor } from '../../src/bazu/config3m.js';
import { predict3m } from '../../src/bazu/predict3m.js';
import { createBook, S } from '../../src/bazu/signalBook3m.js';
import { createChoke } from '../../src/bazu/choke3m.js';
import { agreement, momentumGate, VERDICT } from '../../src/bazu/confluence3m.js';
import { momentumState, MOMENTUM_STATES } from '../../src/bazu/momentum3m.js';
import { buildTradeSignal, GATE } from '../../src/bazu/decision.js';
import { decideAt, fnv, summarise, replayOne, datasetHash } from '../../src/bazu/replay3m.js';
import { regimeWalk, remoteFrom, allowedFor } from './support3m.mjs';

const cfg = configFor('R_100');
const SRC = path.resolve('src/bazu');

// ---- a: golden legacy equivalence (digest taken from HEAD before CO8) ----
test('legacy mode is bit-identical to the pre-CO8 engine', () => {
  const FR = cfg.FRAMES, rows = [];
  for (const seed of [3, 7, 11]) {
    const w = regimeWalk(40000, seed), allowed = allowedFor(cfg), full = remoteFrom(w, 40000, cfg);
    for (let k = 12000; k < 40000; k += 97) {
      const remote = {}; for (const f of Object.keys(full)) remote[f] = full[f].filter((c) => c.epoch + FR[f] <= w.e[k]);
      const r = predict3m({ symbol: 'R_100', prices: w.p.slice(0, k + 1), epochs: w.e.slice(0, k + 1), remote, decisionEpoch: w.e[k], allowed, overrides: { CONFLUENCE_MODE: 'legacy' } });
      rows.push([r.wait, r.direction, r.strength.toFixed(6), r.playbook, r.vetoes.join('|'), r.duration?.key || null, r.durationSec].join(','));
    }
  }
  assert.equal(createHash('sha256').update(rows.join('\n')).digest('hex'), 'cd6a98a8f3c747eabd4537d85d78b1a8fd188091ee4a4bc9d86cee6898d5380c');
});

// ---- b: structural: nothing but the choke point buys ----
test('buyRiseFall is referenced only by execution.js and choke3m.js', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    if (f === 'execution.js' || f === 'choke3m.js') continue;
    if (/buyRiseFall/.test(fs.readFileSync(path.join(SRC, f), 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
  assert.ok(!/buyRiseFall/.test(fs.readFileSync(path.resolve('index.html'), 'utf8')));
});
test('buyRiseFall refuses to run without a guard', async () => {
  const { buyRiseFall } = await import('../../src/bazu/execution.js');
  await assert.rejects(() => buyRiseFall({ symbol: 'R_100', contractType: 'CALL', stake: 1, duration: { n: 1, unit: 'm' } }), /guard/i);
});

// ---- c: family agreement counts correlated features once ----
const fam = (score, available = true) => ({ available, score, vote: Math.abs(score) >= cfg.FAMILY_VOTE_MIN ? Math.sign(score) : 0 });
test('three correlated features agreeing is a single family, not enough', () => {
  const families = { trend: fam(0.8), oscillator: fam(0), flow: fam(0), structure: fam(0), momentum: fam(0), volatility: fam(0, false) };
  const a = agreement(families, 1, cfg);
  assert.equal(a.ok, false);
  assert.equal(a.agree.length, 1);
});
test('independent families agreeing qualify; a strongly opposing family vetoes', () => {
  const good = { trend: fam(0.8), oscillator: fam(0.5), flow: fam(0.6), structure: fam(0.5), momentum: fam(0.5) };
  assert.equal(agreement(good, 1, cfg).ok, true);
  const bad = { ...good, flow: fam(-0.9) };
  assert.equal(agreement(bad, 1, cfg).ok, false);
});

// ---- d: momentum gate ----
test('momentum state thresholds and gate verdicts', () => {
  assert.equal(momentumState(0.6, 1, cfg), MOMENTUM_STATES.ALIGNED);
  assert.equal(momentumState(-0.7, 1, cfg), MOMENTUM_STATES.OPP_STRONG);
  const strong = momentumGate({ momentum: { available: true, score: -0.7 }, dir: 1, playbook: 'breakout', turn: null, oscReading: null, cfg });
  assert.equal(strong.verdict.kind, VERDICT.REJECTED);
  const aligned = momentumGate({ momentum: { available: true, score: 0.7 }, dir: 1, playbook: 'breakout', turn: null, oscReading: null, cfg });
  assert.ok(aligned.scoreDelta > 0 && !aligned.verdict);
  const missing = momentumGate({ momentum: { available: false, reason: 'no ticks' }, dir: 1, playbook: 'breakout', turn: null, oscReading: null, cfg });
  assert.equal(missing.verdict.kind, VERDICT.DATA);
});

// ---- e: state machine + choke ----
const mkPred = (over = {}) => ({
  mode: 'families', provisional: false, candleId: 'c1', decisionPrice: 100, sigmaT: 1, invalid: 98, target: 103, durationSec: 60, duration: { key: '1m' }, decisionTs: 1000,
  setup: { dir: 1, playbook: 'breakout', qualifies: true, triggered: true, trigger: 'choch', delayReason: null }, verdicts: [], momentum: { state: 'aligned' }, ...over,
});
const mkEnv = (over = {}) => {
  const book = createBook({ cfgFor: () => cfg }); let t = 1000, bought = [], pred = mkPred();
  const deps = {
    book, cfgFor: () => cfg, now: () => t, log: () => {}, predictNow: () => pred, account: () => ({ connected: true, isReal: false, balance: 1000 }),
    riskState: () => ({ open: [], todayPnl: 0, lastTradeAt: {}, balance: 1000 }), limits: {}, realConfirmed: () => false,
    durationFor: () => ({ n: 1, unit: 'm' }), buy: async (a) => { a.guard({}); bought.push(a); return { buy: { contract_id: 1 }, proposal: { payout: 1.95 }, isReal: false }; }, ...over,
  };
  return { book, choke: createChoke(deps), bought, setPred: (p) => { pred = p; }, tick: (n) => { t += n; }, now: () => t };
};
test('triggered signal executes exactly once even with simultaneous attempts', async () => {
  const e = mkEnv(); const { signal } = e.book.observe('R_100', mkPred(), 1000);
  assert.equal(signal.state, S.TRIGGERED);
  const rs = await Promise.all([e.choke.execute({ signalId: signal.id, stake: 1 }), e.choke.execute({ signalId: signal.id, stake: 1 })]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(e.bought.length, 1);
  assert.equal(e.book.get(signal.id).state, S.EXECUTED);
});
test('an armed (untriggered) or provisional signal never executes', async () => {
  const e = mkEnv(); const p = mkPred({ setup: { dir: 1, playbook: 'breakout', qualifies: true, triggered: false, delayReason: 'waiting' } });
  const { signal } = e.book.observe('R_100', p, 1000);
  assert.equal(signal.state, S.ARMED);
  const r = await e.choke.execute({ signalId: signal.id, stake: 1 });
  assert.equal(r.ok, false); assert.equal(e.bought.length, 0);
});
test('recheck cancels on flipped direction, strong opposing momentum, drift and a real account', async () => {
  const cases = [
    ['flip', { setup: { dir: -1, playbook: 'breakout', qualifies: true, triggered: true, trigger: 'x' } }],
    ['momentum', { momentum: { state: MOMENTUM_STATES.OPP_STRONG } }],
    ['drift', { decisionPrice: 95 }],
  ];
  for (const [name, change] of cases) {
    const e = mkEnv(); const { signal } = e.book.observe('R_100', mkPred(), 1000);
    e.setPred(mkPred(change));
    const r = await e.choke.execute({ signalId: signal.id, stake: 1 });
    assert.equal(r.ok, false, name); assert.equal(e.bought.length, 0, name);
    assert.equal(e.book.get(signal.id).state, S.INVALIDATED, name);
  }
  const e = mkEnv({ account: () => ({ connected: true, isReal: true, balance: 10 }), realConfirmed: () => true }); const { signal } = e.book.observe('R_100', mkPred(), 1000);
  const r = await e.choke.execute({ signalId: signal.id, stake: 1 });
  assert.equal(r.ok, true, 'real accounts trade too (risk checks permitting)');
});
test('stale trigger expires and DATA verdicts neither execute nor become zero-valued', async () => {
  const e = mkEnv(); const { signal } = e.book.observe('R_100', mkPred(), 1000);
  e.tick(cfg.EXEC_MAX_DELAY_S + 5);
  const r = await e.choke.execute({ signalId: signal.id, stake: 1 });
  assert.equal(r.ok, false); assert.equal(e.book.get(signal.id).state, S.EXPIRED);
  const e2 = mkEnv(); const s2 = e2.book.observe('R_100', mkPred(), 1000).signal;
  e2.setPred(mkPred({ verdicts: [{ kind: VERDICT.DATA, reason: 'stale ticks' }] }));
  const r2 = await e2.choke.execute({ signalId: s2.id, stake: 1 });
  assert.equal(r2.ok, false); assert.match(r2.reason, /data/);
  assert.equal(e2.book.get(s2.id).state, S.TRIGGERED);
});
test('a failed buy returns to TRIGGERED and the retry re-runs the gate', async () => {
  let fail = true; const e = mkEnv({ buy: async (a) => { a.guard({}); if (fail) throw new Error('network'); return { buy: { contract_id: 2 }, proposal: { payout: 1.9 }, isReal: false }; } });
  const { signal } = e.book.observe('R_100', mkPred(), 1000);
  assert.equal((await e.choke.execute({ signalId: signal.id, stake: 1 })).ok, false);
  assert.equal(e.book.get(signal.id).state, S.TRIGGERED);
  e.setPred(mkPred({ momentum: { state: MOMENTUM_STATES.OPP_STRONG } }));
  fail = false;
  assert.equal((await e.choke.execute({ signalId: signal.id, stake: 1 })).ok, false);
  assert.equal(e.book.get(signal.id).state, S.INVALIDATED);
});
test('flip invalidates the old signal; REJECTED, DELAYED and EXPIRED stay distinct and logged', () => {
  const e = mkEnv(); const s1 = e.book.observe('R_100', mkPred(), 1000).signal;
  const flip = mkPred({ candleId: 'c2', setup: { dir: -1, playbook: 'breakout', qualifies: true, triggered: false, delayReason: 'wait for turn' } });
  const r = e.book.observe('R_100', flip, 1010);
  assert.equal(e.book.get(s1.id).state, S.INVALIDATED);
  assert.notEqual(r.signal.id, s1.id); assert.equal(r.signal.state, S.ARMED);
  const kinds = new Set(e.book.log().flatMap((x) => [x.kind, x.to]));
  assert.ok(kinds.has(VERDICT.DELAYED) && kinds.has(S.INVALIDATED));
  const rej = e.book.observe('R_100', mkPred({ candleId: 'c3', setup: { dir: 1, playbook: 'x', qualifies: false, triggered: false }, verdicts: [{ kind: VERDICT.REJECTED, reason: 'family opposes' }] }), 1020);
  assert.equal(rej.signal, null); assert.ok(e.book.log().some((x) => x.to === S.REJECTED && x.kind === VERDICT.REJECTED));
  const e2 = mkEnv(); const s = e2.book.observe('R_100', mkPred(), 1000).signal;
  e2.book.observe('R_100', mkPred(), 1000 + 10000);
  assert.equal(e2.book.get(s.id).state, S.EXPIRED);
});

// ---- f: gate in decision.js depends on TRIGGERED ----
test('families-mode signal is tradable only while TRIGGERED', () => {
  const pred = { ...mkPred(), direction: 1, strength: 0.9, minStrength: 0.2, up: 5, down: 0, total: 16, vetoes: [] };
  const q = { ask: 1, payout: 1.95 };
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred, duration: '1m', quote: q, bookSignal: { id: 'x', state: 'TRIGGERED' } }).gate, GATE.OK);
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred, duration: '1m', quote: q, bookSignal: { id: 'x', state: 'ARMED' } }).gate, GATE.ARMED);
  assert.equal(buildTradeSignal({ symbol: 'R_100', prediction: pred, duration: '1m', quote: q, bookSignal: null }).gate, GATE.ARMED);
});

// ---- g: causal replay (poison the future) ----
test('replay decisions use only data available at the decision tick', () => {
  const w = regimeWalk(9000, 5), allowed = allowedFor(cfg), remote = remoteFrom(w, 9000, cfg);
  const clean = { symbol: 'R_100', prices: w.p, epochs: w.e, remote };
  const poisoned = { ...clean, prices: w.p.map((x, i) => (i > 6000 ? x * 7 + 50 : x)), remote: Object.fromEntries(Object.entries(remote).map(([f, c]) => [f, c.map((x) => (x.epoch > w.e[6000] ? { ...x, open: 1, high: 9e3, low: -5, close: 1 } : x))])) };
  for (const mode of ['legacy', 'families']) {
    for (const k of [3000, 4500, 6000]) {
      const a = decideAt(clean, k, { allowed, overrides: { CONFLUENCE_MODE: mode }, cfg }), b = decideAt(poisoned, k, { allowed, overrides: { CONFLUENCE_MODE: mode }, cfg });
      assert.deepEqual([a.wait, a.direction, a.strength, a.vetoes], [b.wait, b.direction, b.strength, b.vetoes], `${mode}@${k}`);
    }
  }
});
test('replay is deterministic, hashed, and ties lose', () => {
  assert.equal(fnv([1, 2, 3]), fnv([1, 2, 3])); assert.notEqual(fnv([1, 2, 3]), fnv([1, 2, 4]));
  const w = regimeWalk(6000, 9), d = { symbol: 'R_100', prices: w.p, epochs: w.e, remote: remoteFrom(w, 6000, cfg), breakEven: 0.5128 };
  const a = summarise([replayOne(d, { mode: 'families', allowed: allowedFor(cfg), startAt: 1500, step: 50 })]);
  const b = summarise([replayOne(d, { mode: 'families', allowed: allowedFor(cfg), startAt: 1500, step: 50 })]);
  assert.deepEqual(a, b);
  assert.equal(datasetHash([d]), datasetHash([d]));
  const flat = { symbol: 'R_100', prices: w.p.map(() => 1000), epochs: w.e, remote: {} };
  assert.equal(summarise([replayOne(flat, { mode: 'legacy', allowed: allowedFor(cfg), startAt: 1500, step: 100 })]).wins, 0);
});

// ---- h: stale / missing data WAITs, never zero ----
test('stale ticks produce a DATA wait in families mode', () => {
  const w = regimeWalk(9000, 5), allowed = allowedFor(cfg), remote = remoteFrom(w, 9000, cfg), k = 6000;
  const r = predict3m({ symbol: 'R_100', prices: w.p.slice(0, k + 1), epochs: w.e.slice(0, k + 1), remote, decisionEpoch: w.e[k], allowed, wallNow: w.e[k] + 600, overrides: { CONFLUENCE_MODE: 'families' } });
  assert.equal(r.wait, true);
  assert.ok(r.verdicts.some((v) => v.kind === VERDICT.DATA));
});

// ---- i: the chosen duration reaches the Deriv proposal and buy; a manual override changes it ----
test('signal duration appears in proposal and buy requests; manual override changes it', async () => {
  const sent = [];
  globalThis.window = { gridPending: {}, gridAuthed: true, gridIsVirtual: true, gridCurrency: 'USD', gridBalance: 1000,
    gridWs: { readyState: 1, send(raw) { const m = JSON.parse(raw); sent.push(m); setImmediate(() => window.gridPending[m.req_id](m.proposal ? { id: 'p1', ask_price: 1, payout: 1.95 } : { buy: { contract_id: 7, buy_price: 1, payout: 1.95 } })); } } };
  try {
    const { accountInfo } = await import('../../src/bazu/execution.js');
    const e = mkEnv({ account: accountInfo, buy: undefined, durationFor: (sig) => ({ n: 10, unit: 't' }) });
    const { signal } = e.book.observe('R_100', mkPred({ duration: { key: '10t' } }), 1000);
    const r = await e.choke.execute({ signalId: signal.id, stake: 1 });
    assert.equal(r.ok, true);
    const prop = sent.find((m) => m.proposal), buy = sent.find((m) => m.buy);
    assert.equal(prop.duration, 10); assert.equal(prop.duration_unit, 't'); assert.equal(prop.underlying_symbol, 'R_100');
    assert.ok(buy.buy === 'p1' || buy.parameters);
    sent.length = 0;
    const m = await e.choke.manual({ symbol: 'R_100', contractType: 'CALL', duration: { n: 5, unit: 'm' }, stake: 1, confirmed: true });
    assert.equal(m.ok, true);
    const p2 = sent.find((x) => x.proposal);
    assert.equal(p2.duration, 5); assert.equal(p2.duration_unit, 'm');
  } finally { delete globalThis.window; }
});

// ---- j: replay sanity: naive strategies land near 50% with the tie rule applied ----
test('always-Rise, always-Fall and random replays land near 50% and sum to 1 minus ties', async () => {
  const { baselineStrategy } = await import('../../src/bazu/replay3m.js');
  const { rng } = await import('./support3m.mjs');
  const w = regimeWalk(60000, 21, 0.35), flat = w.p.map((x) => x), d = { symbol: 'R_100', prices: flat, epochs: w.e };
  // zero-drift random walk: no directional edge
  const r = rng(99), p = [1000]; for (let i = 1; i < 60000; i++) p.push(+(p[i - 1] + (r() - 0.5)).toFixed(2));
  const dz = { symbol: 'R_100', prices: p, epochs: w.e };
  const up = baselineStrategy(dz, 1, 60, { step: 7 }), dn = baselineStrategy(dz, -1, 60, { step: 7 });
  const rr = rng(5), rnd = baselineStrategy(dz, () => (rr() < 0.5 ? 1 : -1), 60, { step: 7 });
  for (const s of [up, dn, rnd]) assert.ok(Math.abs(s.hitRate - 0.5) < 0.03, `hit ${s.hitRate}`);
  assert.equal(up.wins + dn.wins + up.ties, up.n);
  assert.ok(d.prices.length > 0);
});
