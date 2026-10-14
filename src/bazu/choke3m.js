/**
 * src/bazu/choke3m.js
 * THE single purchase gate. Every Bazu-originated order (auto, semi-auto confirm, retry, recovery, any fallback) and every
 * manual ticket order reaches Deriv only through this module: it is the only importer of buyRiseFall (enforced by a
 * structural test). For a signal it re-checks, under the book's compare-and-set claim and on every attempt:
 *   demo account -> claim -> validity (state/age/armed window/invalidation) -> data freshness -> pre-trade recheck
 *   (momentum gate, family agreement, adverse drift, direction flip) -> risk limits -> proposal -> guard -> buy.
 * A retry re-runs all of it; no earlier approval is reused.
 */
import { buyRiseFall as deriBuy } from './execution.js?v=15';
import { checkOrder } from './risk.js?v=15';
import { S, scaled } from './signalBook3m.js?v=15';
import { VERDICT } from './confluence3m.js?v=15';
import { MOMENTUM_STATES } from './momentum3m.js?v=15';

/**
 * deps: { book, cfgFor(symbol), predictNow(symbol) -> fresh prediction on the market buffers (with wall-clock freshness),
 *         account() -> {connected,isReal,balance}, riskState(), limits, realConfirmed(), now() -> seconds, log(msg, kind), buy? }
 */
export function createChoke(deps) {
  const buy = deps.buy || deriBuy, now = () => deps.now(), log = deps.log || (() => {});

  /** Re-evaluate everything that can change between detection and purchase. { ok, cancel, reason }. */
  function recheck(sig, pred) {
    const cfg = deps.cfgFor(sig.symbol);
    if (!pred) return { ok: false, cancel: false, reason: 'no fresh prediction' };
    const dat = (pred.verdicts || []).find((v) => v.kind === VERDICT.DATA);
    if (dat) return { ok: false, cancel: false, reason: `data: ${dat.reason}`, data: true };
    if (pred.mode !== 'families') return { ok: false, cancel: false, reason: 'confluence mode is not families' };
    if (!pred.setup) return { ok: false, cancel: true, kind: S.EXPIRED, reason: 'setup no longer present' };
    if (pred.setup.dir !== sig.dir) return { ok: false, cancel: true, kind: S.INVALIDATED, reason: 'direction flipped' };
    if (pred.momentum?.state === MOMENTUM_STATES.OPP_STRONG) return { ok: false, cancel: true, kind: S.INVALIDATED, reason: 'momentum has become opposing_strong' };
    const price = pred.decisionPrice, sigma = pred.sigmaT ?? sig.sigmaT;
    if (Number.isFinite(price) && Number.isFinite(sig.decisionPrice) && Number.isFinite(sigma) && sigma > 0) {
      const adverse = (sig.decisionPrice - price) * sig.dir;
      if (adverse > cfg.RECHECK_MAX_SIGMA * sigma) return { ok: false, cancel: true, kind: S.INVALIDATED, reason: `price moved ${(adverse / sigma).toFixed(2)} sigma against the trade since the decision` };
    }
    if (!pred.setup.qualifies) return { ok: false, cancel: true, kind: S.INVALIDATED, reason: `setup no longer qualifies: ${(pred.verdicts || []).filter((v) => v.kind !== VERDICT.DELAYED).map((v) => v.reason).join('; ')}` };
    if (!pred.setup.triggered || pred.provisional) return { ok: false, cancel: false, reason: pred.setup.delayReason || 'trigger not confirmed on closed data' };
    return { ok: true };
  }

  function validity(sig, t) {
    const cfg = deps.cfgFor(sig.symbol), age = t - sig.createdAt;
    if (age > scaled(cfg.SIGNAL_MAX_AGE_S, sig.T)) return { ok: false, kind: S.EXPIRED, reason: 'signal too old' };
    const since = t - ([...sig.history].reverse().find((h) => h.to === S.TRIGGERED)?.ts ?? sig.createdAt);
    if (since > cfg.EXEC_MAX_DELAY_S && sig.attempts === 0) return { ok: false, kind: S.EXPIRED, reason: `triggered ${Math.round(since)}s ago (EXEC_MAX_DELAY_S ${cfg.EXEC_MAX_DELAY_S})` };
    return { ok: true };
  }

  /** Execute a Bazu signal by id. Resolves { ok, reason, res?, stage }. */
  async function execute({ signalId, stake, reverse = false, source = 'auto' }) {
    const t = now(), sig0 = deps.book.get(signalId);
    const refuse = (stage, reason) => { log(`${sig0?.symbol || signalId} not executed (${stage}): ${reason}`, 'warn'); return { ok: false, stage, reason }; };
    const acc = deps.account(), cfg0 = sig0 && deps.cfgFor(sig0.symbol);
    if (!acc.connected) return refuse('account', 'Connect a Deriv account first');
    if (cfg0?.DEMO_ONLY && acc.isReal) return refuse('demo', 'DEMO_ONLY: Bazu orders are refused on a real account');
    const claim = deps.book.beginExecution(signalId, t);
    if (!claim.ok) return refuse('claim', claim.reason);
    const sig = claim.signal, release = (reason) => { deps.book.finishExecution(signalId, false, { reason }, t); };
    try {
      const v = validity(sig, t);
      if (!v.ok) { sig.token.cancelled = true; sig.token.reason = v.reason; deps.book.finishExecution(signalId, false, { reason: v.reason, kind: v.kind }, t); return refuse('validity', v.reason); }
      let pred = null; try { pred = deps.predictNow(sig.symbol); } catch (e) { release(`recheck failed: ${e.message}`); return refuse('recheck', e.message); }
      const rc = recheck(sig, pred);
      if (!rc.ok) {
        if (rc.cancel) { sig.token.cancelled = true; sig.token.reason = rc.reason; deps.book.finishExecution(signalId, false, { reason: rc.reason, kind: rc.kind }, t); }
        else release(rc.reason);
        return refuse('recheck', rc.reason);
      }
      const cur = deps.book.get(signalId);
      if (cur.token.cancelled) { release('cancelled'); return refuse('claim', 'cancelled'); }
      const open = deps.riskState().open.filter((x) => x.market === sig.symbol).length;
      if (open >= (cfg0.MAX_OPEN_PER_MARKET ?? Infinity)) { release('open trade on this market'); return refuse('risk', `already ${open} open trade(s) on ${sig.symbol}`); }
      const risk = checkOrder({ stake, market: sig.symbol, isReal: acc.isReal, realConfirmed: deps.realConfirmed(), now: t * 1000 }, deps.riskState(), deps.limits);
      if (!risk.ok) { release(risk.reason); return refuse('risk', risk.reason); }
      const base = sig.dir > 0 ? 'CALL' : 'PUT', contractType = reverse ? (base === 'CALL' ? 'PUT' : 'CALL') : base;
      const duration = deps.durationFor(sig);
      if (!duration) { release('no duration'); return refuse('validity', 'no allowed duration for this signal'); }
      const res = await buy({ symbol: sig.symbol, contractType, stake, duration, guard: () => { if (deps.book.get(signalId).token.cancelled) throw new Error(`cancelled: ${deps.book.get(signalId).token.reason}`); } });
      deps.book.finishExecution(signalId, true, { contractId: res.buy?.contract_id }, now());
      return { ok: true, res, contractType, signal: sig, source };
    } catch (e) {
      if (deps.book.get(signalId)?.state === S.EXECUTING) deps.book.finishExecution(signalId, false, { reason: e.message }, now());
      return refuse('buy', e.message);
    }
  }

  /** Manual ticket order: needs no signal, still passes demo + risk. Gate findings are returned and must be confirmed. */
  async function manual({ symbol, contractType, duration, stake, confirmed = false }) {
    const acc = deps.account(), cfg = deps.cfgFor(symbol);
    if (!acc.connected) return { ok: false, stage: 'account', reason: 'Connect a Deriv account first' };
    if (cfg.DEMO_ONLY && acc.isReal) return { ok: false, stage: 'demo', reason: 'DEMO_ONLY: Bazu orders are refused on a real account' };
    const risk = checkOrder({ stake, market: symbol, isReal: acc.isReal, realConfirmed: deps.realConfirmed(), now: now() * 1000 }, deps.riskState(), deps.limits);
    if (!risk.ok) return { ok: false, stage: 'risk', reason: risk.reason };
    const findings = [];
    try {
      const pred = deps.predictNow(symbol), want = contractType === 'CALL' ? 1 : -1;
      if (!pred?.setup) findings.push('no qualifying setup right now');
      else {
        if (pred.setup.dir !== want) findings.push(`current setup points ${pred.setup.dir > 0 ? 'Rise' : 'Fall'}`);
        for (const v of pred.verdicts || []) findings.push(`${v.kind}: ${v.reason}`);
        if (pred.momentum?.state && pred.setup.dir === want && pred.momentum.state === MOMENTUM_STATES.OPP_STRONG) findings.push('momentum strongly opposes');
      }
    } catch (e) { findings.push(`gate could not be evaluated: ${e.message}`); }
    if (findings.length && !confirmed) return { ok: false, stage: 'confirm', needsConfirm: true, findings, reason: 'gate findings need explicit confirmation' };
    try {
      const res = await buy({ symbol, contractType, stake, duration, guard: () => {} });
      return { ok: true, res, contractType, manual: true, findings };
    } catch (e) { return { ok: false, stage: 'buy', reason: e.message }; }
  }

  return { execute, manual, recheck, validity };
}
