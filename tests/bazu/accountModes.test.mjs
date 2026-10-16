import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFor } from '../../src/bazu/config3m.js';
import { createBook } from '../../src/bazu/signalBook3m.js';
import { createChoke } from '../../src/bazu/choke3m.js';
import { createRealMode, REAL_LIMITS_DEFAULT, REAL_PHRASE, REAL_AUTO_PHRASE } from '../../src/bazu/realMode3m.js';

const cfg = configFor('R_100');
const mkPred = () => ({
  mode: 'families', provisional: false, candleId: 'c1', decisionPrice: 100, sigmaT: 1, invalid: 98, target: 103, durationSec: 60, duration: { key: '1m' }, decisionTs: 1000,
  setup: { dir: 1, playbook: 'breakout', qualifies: true, triggered: true, trigger: 'choch', delayReason: null }, verdicts: [], momentum: { state: 'aligned' },
});
const REAL = { connected: true, isReal: true, balance: 1000, loginId: 'CR1234567', currency: 'USD' };
const DEMO = { connected: true, isReal: false, balance: 1000, loginId: 'VRTC999', currency: 'USD' };

function env({ acc = REAL, trades = [], limits, age = 100, clock = { t: 1_700_000_000_000 } } = {}) {
  const book = createBook({ cfgFor: () => cfg }); let t = 1000; const bought = [], tripped = [];
  const cur = { acc, trades, age };
  const real = createRealMode({ now: () => clock.t, limits: { ...REAL_LIMITS_DEFAULT, ...limits }, onTrip: (r) => tripped.push(r) });
  const choke = createChoke({
    book, cfgFor: () => cfg, now: () => t, log: () => {}, predictNow: () => mkPred(), account: () => cur.acc,
    riskState: () => ({ open: [], todayPnl: 0, lastTradeAt: {}, balance: cur.acc.balance }), limits: {}, realConfirmed: () => real.isEnabledFor(cur.acc),
    real, trades: () => cur.trades, dataAgeMs: () => cur.age,
    durationFor: () => ({ n: 1, unit: 'm' }),
    buy: async (a) => { a.guard({}); bought.push(a); return { buy: { contract_id: bought.length }, proposal: { payout: 1.95 }, isReal: cur.acc.isReal }; },
  });
  const fire = async (opts = {}) => { const { signal } = book.observe('R_100', mkPred(), 1000); return choke.execute({ signalId: signal.id, stake: 0.35, ...opts }); };
  return { real, choke, bought, tripped, cur, clock, fire, book };
}
const optIn = (e, auto = false) => { assert.ok(e.real.enable(e.cur.acc, REAL_PHRASE).ok); if (auto) assert.ok(e.real.enableAuto(e.cur.acc, REAL_AUTO_PHRASE).ok); };
const closedLoss = (ts, profit = -0.35) => ({ isReal: true, status: 'closed', profit, ts, settledAt: ts, stake: 0.35 });

// a. opt-in sequence
test('real account is refused until both opt-ins are done', async () => {
  const e = env();
  assert.equal((await e.fire({ source: 'auto' })).ok, false, 'default demo-only');
  assert.match((await e.fire({ source: 'auto' })).reason, /demo only|not confirmed/);
  assert.equal(e.real.enable(e.cur.acc, 'real money').ok, false, 'phrase must match exactly');
  optIn(e);
  assert.equal((await e.fire({ source: 'auto' })).ok, false, 'real enabled but Auto not opted in');
  assert.equal((await e.fire({ source: 'semi' })).ok, false, 'semi-auto also needs the second opt-in');
  assert.equal(e.bought.length, 0);
  assert.equal(e.real.enableAuto(e.cur.acc, 'x').ok, false);
  assert.ok(e.real.enableAuto(e.cur.acc, REAL_AUTO_PHRASE).ok);
  assert.equal((await e.fire({ source: 'auto' })).ok, true);
});
test('a fresh page load (new controller) is demo only even with a real account connected', async () => {
  const first = env(); optIn(first, true);
  assert.equal((await first.fire({ source: 'auto' })).ok, true);
  const reloaded = env(); // state is memory only: nothing is persisted
  assert.equal(reloaded.real.view().enabled, false);
  assert.equal((await reloaded.fire({ source: 'auto' })).ok, false);
  const src = fs.readFileSync(path.resolve('src/bazu/realMode3m.js'), 'utf8');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), 'real opt-in is never persisted');
});
test('refused after "Disable real trading"; manual ticket needs the extra confirm unless Auto is on', async () => {
  const e = env(); optIn(e);
  const m = (o) => e.choke.manual({ symbol: 'R_100', contractType: 'CALL', duration: { n: 1, unit: 'm' }, stake: 0.35, confirmed: true, ...o });
  assert.equal((await m({})).ok, false, 'no ticket confirm');
  assert.equal((await m({ ticketConfirmed: true })).ok, true);
  e.real.disable();
  assert.equal((await m({ ticketConfirmed: true })).ok, false);
  assert.equal((await e.fire({ source: 'auto' })).ok, false);
});
test('unknown account type is treated as real; switching account ends the opt-in', async () => {
  const e = env({ acc: { ...REAL, isReal: undefined } }); assert.equal((await e.fire({ source: 'auto' })).ok, false);
  const e2 = env(); optIn(e2, true);
  e2.cur.acc = { ...REAL, loginId: 'CR7654321' };
  assert.equal((await e2.fire({ source: 'auto' })).ok, false, 'different account suffix');
  e2.real.monitor(e2.cur.acc); assert.equal(e2.real.view().enabled, false);
});

// b. limits
test('every real-account limit blocks the purchase with a reason; demo limits unchanged', async () => {
  const now = 1_700_000_000_000, day = new Date(now).setHours(0, 0, 0, 0);
  const cases = [
    ['REAL_MAX_STAKE', { stake: 0.5 }, {}, []],
    ['REAL_MAX_OPEN_CONTRACTS', {}, {}, [{ isReal: true, status: 'open', ts: now, stake: 0.35, buyPrice: 0.35 }]],
    ['REAL_MAX_EXPOSURE_PCT', {}, { balance: 5 }, []],
    ['REAL_SESSION_LOSS_CAP', {}, { limits: { REAL_SESSION_LOSS_CAP: 0.3 } }, [closedLoss(now + 10, -0.35)]],
    ['REAL_DAILY_LOSS_CAP', {}, { limits: { REAL_DAILY_LOSS_CAP: 0.3 } }, [closedLoss(day + 1, -0.35)]],
    ['REAL_MAX_TRADES_PER_DAY', {}, { limits: { REAL_MAX_TRADES_PER_DAY: 1 } }, [{ isReal: true, status: 'closed', profit: 1, ts: day + 5, settledAt: day + 5 }]],
    ['Cooldown', {}, {}, [closedLoss(now - 3000), closedLoss(now - 2000), closedLoss(now - 1000)]],
  ];
  for (const [name, fireOpts, over, trades] of cases) {
    const e = env({ trades, limits: over.limits, acc: over.balance ? { ...REAL, balance: over.balance } : REAL, clock: { t: now } });
    optIn(e, true);
    const r = await e.fire({ source: 'auto', ...fireOpts });
    assert.equal(r.ok, false, name); assert.match(r.reason, new RegExp(name), name); assert.equal(e.bought.length, 0, name);
    assert.equal(e.real.view().auto, false, `${name} turns real Auto off`);
  }
  const d = env({ acc: DEMO, trades: [closedLoss(1e12, -999)].map((t) => ({ ...t, isReal: false })) });
  const r = await d.fire({ source: 'auto', stake: 50 });
  assert.equal(r.ok, true, 'demo is not subject to REAL_* limits');
});
test('loss caps count only real trades, and the cooldown lifts after REAL_COOLDOWN_MS', async () => {
  const now = 1_700_000_000_000;
  const demoLosses = Array.from({ length: 5 }, (_, i) => ({ ...closedLoss(now - i), isReal: false }));
  const e = env({ trades: demoLosses, clock: { t: now } }); optIn(e, true);
  assert.equal((await e.fire({ source: 'auto' })).ok, true);
  const streak = [closedLoss(now - 3000), closedLoss(now - 2000), closedLoss(now - 1000)];
  const e2 = env({ trades: streak, clock: { t: now + REAL_LIMITS_DEFAULT.REAL_COOLDOWN_MS + 5000 }, limits: { REAL_SESSION_LOSS_CAP: 100, REAL_DAILY_LOSS_CAP: 100 } }); optIn(e2, true);
  assert.equal((await e2.fire({ source: 'auto' })).ok, true);
});

// c. auto auto-disable
test('real Auto stops on connection loss, stale data, unknown balance, a limit hit and a choke error', async () => {
  let e = env(); optIn(e, true); e.cur.acc = { ...REAL, connected: false }; e.real.monitor(e.cur.acc);
  assert.equal(e.real.view().auto, false); assert.deepEqual(e.tripped, ['connection lost']);
  e.cur.acc = REAL; assert.equal((await e.fire({ source: 'auto' })).ok, false, 'does not resume by itself');
  assert.ok(e.real.enableAuto(REAL, REAL_AUTO_PHRASE).ok); assert.equal((await e.fire({ source: 'auto' })).ok, true, 'resumes only after re-enable');

  e = env({ age: 6000 }); optIn(e, true);
  assert.match((await e.fire({ source: 'auto' })).reason, /stale/); assert.equal(e.real.view().auto, false);

  e = env({ acc: { ...REAL, balance: undefined } }); optIn(e, true);
  assert.match((await e.fire({ source: 'auto' })).reason, /balance unknown/i); assert.equal(e.real.view().auto, false);

  e = env({ limits: { REAL_MAX_STAKE: 0.1 } }); optIn(e, true);
  assert.equal((await e.fire({ source: 'auto' })).ok, false); assert.equal(e.real.view().auto, false);

  e = env(); optIn(e, true);
  const bad = createChoke({
    book: e.book, cfgFor: () => cfg, now: () => 1000, log: () => {}, predictNow: () => mkPred(), account: () => REAL, riskState: () => ({ open: [], balance: 1000 }), limits: {},
    realConfirmed: () => true, real: e.real, trades: () => [], dataAgeMs: () => 10, durationFor: () => ({ n: 1, unit: 'm' }), buy: async () => { throw new Error('boom'); },
  });
  const { signal } = e.book.observe('R_100', mkPred(), 1000);
  assert.equal((await bad.execute({ signalId: signal.id, stake: 0.35, source: 'auto' })).ok, false);
  assert.equal(e.real.view().auto, false); assert.match(e.real.view().reason, /choke error/);
});
test('concurrent real attempts cannot exceed REAL_MAX_OPEN_CONTRACTS', async () => {
  const e = env(); optIn(e, true);
  const mk = () => { const s = { ...mkPred(), candleId: Math.random().toString() }; return e.book.observe('R_' + Math.floor(Math.random() * 1e6), s, 1000).signal; };
  const a = mk(), b = mk();
  const rs = await Promise.all([a, b].map((s) => e.choke.execute({ signalId: s.id, stake: 0.35, source: 'auto' })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
});

// d. structural scan
test('only choke3m.js (and execution.js itself) can reach the Deriv buy client', () => {
  const root = path.resolve('src'), offenders = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of walk(root).filter((x) => /\.(js|mjs)$/.test(x))) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (rel === 'bazu/execution.js' || rel === 'bazu/choke3m.js') continue;
    if (/buyRiseFall|execution\.js/.test(strip(fs.readFileSync(f, 'utf8'))) && !/^bazu\/(page|engine)\.js$/.test(rel)) offenders.push(rel);
    if (/\{\s*"?buy"?\s*:|buy:\s*proposal|JSON\.stringify\(\{\s*buy\b/.test(fs.readFileSync(f, 'utf8')) && rel.startsWith('bazu/')) offenders.push(rel + ' (raw buy)');
  }
  assert.deepEqual(offenders, []);
  const choke = fs.readFileSync(path.join(root, 'bazu/choke3m.js'), 'utf8');
  assert.equal((choke.match(/accountGate\(/g) || []).length, 3, 'definition + execute + manual');
  for (const f of ['page.js', 'engine.js']) assert.ok(!/buyRiseFall/.test(fs.readFileSync(path.join(root, 'bazu', f), 'utf8')));
});
test('a choke point without a real-mode controller refuses every real or unknown account', async () => {
  const book = createBook({ cfgFor: () => cfg }); const bought = [];
  const mk = (acc) => createChoke({ book, cfgFor: () => cfg, now: () => 1000, log: () => {}, predictNow: () => mkPred(), account: () => acc, riskState: () => ({ open: [], balance: 1000 }), limits: {}, realConfirmed: () => true, durationFor: () => ({ n: 1, unit: 'm' }), buy: async (a) => { bought.push(a); return {}; } });
  for (const acc of [REAL, { ...REAL, isReal: undefined }, { ...REAL, isReal: null }]) {
    const r = await mk(acc).manual({ symbol: 'R_100', contractType: 'CALL', duration: { n: 1, unit: 'm' }, stake: 0.35, confirmed: true, ticketConfirmed: true });
    assert.equal(r.ok, false);
  }
  assert.equal(bought.length, 0);
});

// e. demo unchanged
test('demo account: decisions, durations and order requests are unchanged', async () => {
  const e = env({ acc: DEMO });
  const r = await e.fire({ source: 'auto', stake: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(e.bought.map((b) => [b.symbol, b.contractType, b.stake, b.duration.n + b.duration.unit]), [['R_100', 'CALL', 1, '1m']]);
  const rev = env({ acc: DEMO }); const x = await rev.fire({ source: 'auto', stake: 1, reverse: true });
  assert.equal(rev.bought[0].contractType, 'PUT');
});

// f. banner and badge on every tab
test('page renders the account badge and the live-money banner outside the tab panes; no code stores real opt-in', () => {
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8'), page = fs.readFileSync(path.resolve('src/bazu/page.js'), 'utf8');
  const bannerAt = html.indexOf('id="bzRealBanner"'), tabsAt = html.indexOf('id="bzTabs"'), pane = html.indexOf('class="bz-pane on"');
  assert.ok(bannerAt > 0 && bannerAt < tabsAt && tabsAt < pane, 'banner is above the tab strip so every tab shows it');
  assert.ok(html.includes('id="bzAcctPill"'));
  assert.match(page, /REAL ACCOUNT - LIVE MONEY/);
  assert.match(page, /bzAcctPill/); assert.match(page, /DEMO/);
  assert.ok(!/bzRealOk'\)\.onchange/.test(page), 'the old real-money checkbox is gone');
  assert.ok(!/localStorage[^;]*real(Enabled|Auto)/i.test(page));
});
