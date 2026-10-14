/**
 * src/bazu/signalBook3m.js  (pure, synchronous)
 * Dynamic signal state machine. One owner mutates signal state; every transition is a compare-and-set performed
 * synchronously (single JS turn = the lock), so two concurrent callbacks cannot trigger or execute a signal twice and a
 * cancellation always takes effect before any later execution attempt.
 *
 *   DETECTED -> ARMED -> TRIGGERED -> EXECUTING -> EXECUTED
 *   exits: DELAYED (logged outcome while waiting for confirmation), REJECTED, EXPIRED, INVALIDATED
 *
 * A signal's id, direction and playbook never change. A direction flip invalidates the old signal first; a new id in the
 * opposite direction exists only once the new setup qualifies on its own evidence. Once EXECUTED the signal is final.
 */
import { VERDICT } from './confluence3m.js?v=15';

export const S = Object.freeze({ DETECTED: 'DETECTED', ARMED: 'ARMED', TRIGGERED: 'TRIGGERED', EXECUTING: 'EXECUTING', EXECUTED: 'EXECUTED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED', INVALIDATED: 'INVALIDATED' });
export const FINAL = new Set([S.EXECUTED, S.REJECTED, S.EXPIRED, S.INVALIDATED]);
const LIVE = new Set([S.DETECTED, S.ARMED, S.TRIGGERED]);
const NEXT = {
  [S.DETECTED]: [S.ARMED, S.TRIGGERED, S.REJECTED, S.EXPIRED, S.INVALIDATED],
  [S.ARMED]: [S.TRIGGERED, S.REJECTED, S.EXPIRED, S.INVALIDATED],
  [S.TRIGGERED]: [S.ARMED, S.EXECUTING, S.REJECTED, S.EXPIRED, S.INVALIDATED],
  [S.EXECUTING]: [S.EXECUTED, S.TRIGGERED, S.INVALIDATED, S.EXPIRED, S.REJECTED],
  [S.EXECUTED]: [], [S.REJECTED]: [], [S.EXPIRED]: [], [S.INVALIDATED]: [],
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const scaled = (spec, T) => clamp(spec.mult * T, spec.min, spec.max);

export function createBook({ cfgFor, maxLog = 400 }) {
  const signals = new Map(), activeBySym = new Map(), finals = new Set(), log = [], rejectedAt = new Map(), lastProv = new Map();
  let seq = 0;

  const note = (e) => { log.push(e); if (log.length > maxLog) log.splice(0, log.length - maxLog); return e; };
  const keyOf = (sym, dir, playbook, candleId) => `${sym}|${dir}|${playbook}|${candleId}`;

  function transition(sig, to, reason, ts, kind = null) {
    const from = sig.state;
    if (!NEXT[from]?.includes(to)) return { ok: false, reason: `illegal transition ${from} -> ${to}` };
    sig.state = to; sig.updatedAt = ts; sig.lastReason = reason;
    const ev = { ts, id: sig.id, symbol: sig.symbol, from, to, reason, kind, dir: sig.dir };
    sig.history.push(ev); if (sig.history.length > 60) sig.history.shift();
    note(ev);
    if (FINAL.has(to)) { finals.add(sig.key); if (activeBySym.get(sig.symbol) === sig.id) activeBySym.delete(sig.symbol); }
    return { ok: true, event: ev };
  }

  function create(symbol, pred, ts) {
    const s = pred.setup, cfg = cfgFor(symbol), T = pred.durationSec || cfg.DEFAULT_DURATION_S;
    const sig = { id: `${symbol}-${pred.candleId}-${s.dir > 0 ? 'U' : 'D'}-${++seq}`, symbol, createdAt: ts, updatedAt: ts, state: S.DETECTED, history: [], attempts: 0, token: { cancelled: false, reason: null }, contractId: null };
    Object.defineProperties(sig, { dir: { value: s.dir, enumerable: true }, playbook: { value: s.playbook, enumerable: true }, candleId: { value: pred.candleId, enumerable: true }, key: { value: keyOf(symbol, s.dir, s.playbook, pred.candleId), enumerable: true } });
    Object.assign(sig, { T, decisionPrice: pred.decisionPrice, sigmaT: pred.sigmaT, invalid: pred.invalid, target: pred.target, durationSec: pred.durationSec, durationKey: pred.duration?.key || null, trigger: null });
    signals.set(sig.id, sig); activeBySym.set(symbol, sig.id);
    if (signals.size > 400) for (const [k, v] of signals) { if (FINAL.has(v.state)) { signals.delete(k); finals.delete(v.key); } if (signals.size <= 300) break; }
    note({ ts, id: sig.id, symbol, from: null, to: S.DETECTED, reason: `${s.playbook} detected`, dir: s.dir });
    sig.history.push(log.at(-1));
    return sig;
  }

  /** Apply the latest prediction to the symbol's live signal. Returns { signal, events[] }. */
  function observe(symbol, pred, ts) {
    const cfg = cfgFor(symbol), events = [], ev = (r) => { if (r?.event) events.push(r.event); return r; };
    let cur = activeBySym.get(symbol) ? signals.get(activeBySym.get(symbol)) : null;
    if (cur && cur.state === S.EXECUTING) return { signal: cur, events };
    if (pred.mode !== 'families') return { signal: cur, events };
    const setup = pred.setup;
    if (pred.provisional && cfg.FORMING_MAX_HZ > 0) {
      const last = lastProv.get(symbol);
      if (last != null && ts - last < 1 / cfg.FORMING_MAX_HZ && cur) return { signal: cur, events };
      lastProv.set(symbol, ts);
    }
    if (cur && LIVE.has(cur.state)) {
      const age = ts - cur.createdAt, maxAge = scaled(cfg.SIGNAL_MAX_AGE_S, cur.T), armMax = scaled(cfg.ARM_MAX_WAIT_S, cur.T);
      const price = pred.decisionPrice;
      if (age > maxAge) { cur.token.cancelled = true; ev(transition(cur, S.EXPIRED, `signal older than SIGNAL_MAX_AGE_S (${Math.round(maxAge)}s)`, ts)); }
      else if (cur.state !== S.TRIGGERED && ts - cur.createdAt > armMax) { cur.token.cancelled = true; ev(transition(cur, S.EXPIRED, `no trigger within ARM_MAX_WAIT_S (${Math.round(armMax)}s)`, ts)); }
      else if (Number.isFinite(price) && Number.isFinite(cur.invalid) && (price - cur.invalid) * cur.dir <= 0) { cur.token.cancelled = true; ev(transition(cur, S.INVALIDATED, 'invalidation level broken', ts)); }
      else if (!setup) { cur.token.cancelled = true; ev(transition(cur, S.EXPIRED, 'conditions that produced the setup disappeared', ts)); }
      else if (setup.dir !== cur.dir) { cur.token.cancelled = true; ev(transition(cur, S.INVALIDATED, `evidence flipped to ${setup.dir > 0 ? 'Rise' : 'Fall'}`, ts, 'FLIP')); }
      else {
        const rej = pred.verdicts.filter((v) => v.kind === VERDICT.REJECTED), dat = pred.verdicts.filter((v) => v.kind === VERDICT.DATA);
        if (rej.length) { cur.token.cancelled = true; ev(transition(cur, S.REJECTED, rej.map((v) => v.reason).join('; '), ts, VERDICT.REJECTED)); }
        else if (dat.length) { if (cur.state === S.TRIGGERED) ev(transition(cur, S.ARMED, `data: ${dat[0].reason}`, ts, VERDICT.DATA)); }
        else if (setup.triggered && !pred.provisional) { cur.trigger = setup.trigger; ev(transition(cur, S.TRIGGERED, `trigger: ${setup.trigger || 'playbook'}`, ts)); }
        else {
          const why = setup.triggered ? 'provisional trigger: waiting for the candle to close' : setup.delayReason;
          if (cur.state !== S.ARMED) ev(transition(cur, S.ARMED, `DELAYED: ${why}`, ts, VERDICT.DELAYED));
        }
      }
      if (FINAL.has(cur.state)) cur = null;
      else return { signal: cur, events };
    }
    if (!setup) return { signal: null, events };
    if (!setup.qualifies) {
      const rk = `${symbol}|${setup.dir}|${setup.playbook}`, last = rejectedAt.get(rk);
      if (last == null || ts - last >= cfg.REJECT_LOG_GAP_S) {
        rejectedAt.set(rk, ts);
        const reason = pred.verdicts.filter((v) => v.kind !== VERDICT.DELAYED).map((v) => v.reason).join('; ');
        events.push(note({ ts, id: null, symbol, from: null, to: S.REJECTED, reason, kind: pred.verdicts.some((v) => v.kind === VERDICT.DATA) ? VERDICT.DATA : VERDICT.REJECTED, dir: setup.dir }));
      }
      return { signal: null, events };
    }
    if (finals.has(keyOf(symbol, setup.dir, setup.playbook, pred.candleId))) return { signal: null, events };
    const sig = create(symbol, pred, ts);
    ev(transition(sig, S.ARMED, setup.triggered ? 'qualified' : `DELAYED: ${setup.delayReason}`, ts, setup.triggered ? null : VERDICT.DELAYED));
    if (setup.triggered && !pred.provisional) { sig.trigger = setup.trigger; ev(transition(sig, S.TRIGGERED, `trigger: ${setup.trigger || 'playbook'}`, ts)); }
    return { signal: sig, events };
  }

  /** Atomic claim: TRIGGERED -> EXECUTING. Refuses (and logs) a cancelled, in-flight, executed or untriggered signal. */
  function beginExecution(id, ts) {
    const sig = signals.get(id);
    const refuse = (reason) => { note({ ts, id, symbol: sig?.symbol, from: sig?.state, to: null, reason: `execution refused: ${reason}`, kind: 'REFUSED' }); return { ok: false, reason }; };
    if (!sig) return refuse('unknown signal');
    if (sig.token.cancelled) return refuse(`cancelled (${sig.token.reason || sig.lastReason || 'cancelled'})`);
    if (sig.state === S.EXECUTING) return refuse('already in flight');
    if (sig.state === S.EXECUTED) return refuse('already executed');
    if (sig.state !== S.TRIGGERED) return refuse(`state is ${sig.state}, not TRIGGERED`);
    const r = transition(sig, S.EXECUTING, 'claimed for execution', ts);
    return r.ok ? { ok: true, signal: sig } : refuse(r.reason);
  }
  /** Execution outcome. Failure returns the signal to TRIGGERED (attempts++) unless it was cancelled meanwhile. */
  function finishExecution(id, ok, info, ts) {
    const sig = signals.get(id); if (!sig || sig.state !== S.EXECUTING) return { ok: false, reason: 'not executing' };
    if (ok) { sig.contractId = info?.contractId ?? null; return transition(sig, S.EXECUTED, `bought contract ${sig.contractId}`, ts); }
    sig.attempts++;
    if (sig.token.cancelled) return transition(sig, info?.kind || S.INVALIDATED, `cancelled during execution: ${sig.token.reason}`, ts);
    return transition(sig, S.TRIGGERED, `execution failed: ${info?.reason || 'error'} (attempt ${sig.attempts})`, ts);
  }
  /** Cancel a live or executing signal. The token is set first so a later guard check always sees it. */
  function cancel(id, reason, ts, to = S.INVALIDATED) {
    const sig = signals.get(id); if (!sig) return { ok: false, reason: 'unknown signal' };
    if (FINAL.has(sig.state)) return { ok: false, reason: `already ${sig.state}` };
    sig.token.cancelled = true; sig.token.reason = reason;
    if (sig.state === S.EXECUTING) { note({ ts, id, symbol: sig.symbol, from: sig.state, to: null, reason: `cancel requested while executing: ${reason}`, kind: 'CANCEL' }); return { ok: true, pending: true }; }
    return transition(sig, to, reason, ts);
  }
  return { observe, beginExecution, finishExecution, cancel, get: (id) => signals.get(id), active: (sym) => (activeBySym.get(sym) ? signals.get(activeBySym.get(sym)) : null), log: () => log, signals: () => [...signals.values()] };
}
