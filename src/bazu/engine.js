/**
 * src/bazu/engine.js
 *
 * Orchestrator. A DEDICATED public Deriv WebSocket is used because the main feed tracks
 * one SYMBOL, discards other symbols' ticks, and calls forget_all on symbol changes.
 * Pipeline: Prediction (worker validation + live signals) -> Decision (decision.js, risk.js)
 * -> Execution (execution.js). The UI only calls commands and reads `state`.
 */

import { parseActiveSymbols, parseContractsFor, pickDurations } from './universe.js?v=3';
import { durationKey } from './validation.js?v=3';
import { buildTradeSignal, modeMayAct, GATE } from './decision.js?v=3';
import { decimalsFromPip } from './timeframes.js?v=3';
import { checkOrder, DEFAULT_LIMITS, exposureLevel } from './risk.js?v=3';
import { buyRiseFall, accountInfo, watchContracts, requestContractUpdate } from './execution.js?v=3';
import { wilson } from './stats.js?v=3';

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_PAGES = 2;
const MAX_TICKS = 20000;
const TRADES_KEY = 'bazu_trades_v1';

export const state = {
  status: 'idle', mode: 'manual', running: false, stake: 1, limits: { ...DEFAULT_LIMITS },
  markets: new Map(), trades: [], log: [], scan: { done: 0, total: 0, active: false }, realConfirmed: false,
  selected: null, signals: new Map(),
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let dirty = false;
function emit() { if (dirty) return; dirty = true; setTimeout(() => { dirty = false; listeners.forEach((f) => { try { f(state); } catch (e) { console.error(e); } }); }, 120); }
function log(msg, kind = 'info') { state.log.unshift({ t: Date.now(), msg, kind }); state.log.length = Math.min(state.log.length, 200); emit(); }

// ---------- public socket ----------
let ws = null, reqSeq = 1000000;
const waiting = new Map();
let wsReady = null;

function openWs() {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { state.status = 'live'; emit(); resolve(); };
    ws.onerror = () => reject(new Error('BAZU feed socket error'));
    ws.onclose = () => { state.status = 'reconnecting'; wsReady = null; emit(); setTimeout(() => { if (state.markets.size) reconnect(); }, 3000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const w = m.req_id && waiting.get(m.req_id);
      if (w) { waiting.delete(m.req_id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m); }
      if (m.msg_type === 'tick' && m.tick) onTick(m.tick);
    };
  });
  return wsReady;
}
function send(msg, timeoutMs = 15000) {
  return openWs().then(() => new Promise((resolve, reject) => {
    const id = ++reqSeq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout')); }, timeoutMs);
    waiting.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify({ ...msg, req_id: id }));
  }));
}
async function reconnect() {
  try { await openWs(); for (const sym of state.markets.keys()) await send({ ticks: sym, subscribe: 1 }); log('Feed reconnected'); } catch { /* retried by onclose */ }
}

function onTick(t) {
  const m = state.markets.get(t.symbol);
  if (!m) return;
  const last = m.epochs[m.epochs.length - 1];
  if (last != null && t.epoch <= last) return;
  m.prices.push(t.quote); m.epochs.push(t.epoch);
  if (m.prices.length > MAX_TICKS) { m.prices.splice(0, 2000); m.epochs.splice(0, 2000); }
  m.last = t.quote; m.lastEpoch = t.epoch; m.tickCount++;
  emit();
}

// ---------- discovery ----------
export async function discover() {
  state.status = 'discovering'; emit();
  const as = await send({ active_symbols: 'brief' });
  const syms = parseActiveSymbols(as.active_symbols);
  state.scan = { done: 0, total: syms.length, active: true, phase: 'contracts_for' };
  const sq = syms.slice();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (sq.length) {
      const s = sq.shift();
      try {
        const cf = await send({ contracts_for: s.symbol });
        const rf = parseContractsFor(cf);
        if (rf) {
          const durations = pickDurations(rf.ranges, 2);
          state.markets.set(s.symbol, { ...s, ranges: rf.ranges, durations, dp: decimalsFromPip(s.pip), prices: [], epochs: [], last: null, lastEpoch: null, tickCount: 0, status: 'discovered', signal: null, historyLoaded: false });
        }
      } catch (e) { log(`contracts_for ${s.symbol}: ${e.message}`, 'warn'); }
      state.scan.done++; emit();
    }
  }));
  state.scan.active = false;
  log(`Universe: ${state.markets.size} synthetic indices offer Rise/Fall (of ${syms.length} active)`);
  await Promise.all([...state.markets.keys()].map((sym) => send({ ticks: sym, subscribe: 1 }).catch(() => {})));
  state.status = 'live'; emit();
  const q = [...state.markets.keys()];
  for (let w = 0; w < 4; w++) (async () => { while (q.length) { try { await loadHistory(q.shift()); } catch (e) { log('history: ' + e.message, 'warn'); } } })();
}

const histBusy = new Map();
function loadHistory(sym) {
  const m = state.markets.get(sym);
  if (m.historyLoaded) return Promise.resolve();
  if (!histBusy.has(sym)) histBusy.set(sym, loadHistoryNow(sym).finally(() => histBusy.delete(sym)));
  return histBusy.get(sym);
}
async function loadHistoryNow(sym) {
  const m = state.markets.get(sym);
  let end = 'latest', P = [], E = [];
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const r = await send({ ticks_history: sym, end, count: 1000, style: 'ticks' });
    const pr = r.history?.prices || [], tm = r.history?.times || [];
    if (!pr.length) break;
    P = pr.concat(P); E = tm.concat(E);
    end = tm[0] - 1;
  }
  const liveP = m.prices, liveE = m.epochs;
  const cut = E.length ? E[E.length - 1] : -1;
  m.prices = P.concat(liveP.filter((_, i) => liveE[i] > cut));
  m.epochs = E.concat(liveE.filter((e) => e > cut));
  m.historyLoaded = true;
}

// ---------- workers ----------
let sWorker = null;
const jobs = new Map();
let jobSeq = 0;
function mkWorker() {
  const w = new Worker(new URL('./worker.js?v=3', import.meta.url), { type: 'module' });
  w.onmessage = (ev) => { const j = jobs.get(ev.data.id); if (!j) return; jobs.delete(ev.data.id); ev.data.type === 'error' ? j.reject(new Error(ev.data.error)) : j.resolve(ev.data); };
  w.onerror = (e) => log(`worker error: ${e.message}`, 'bad');
  return w;
}
function runJob(w, payload) {
  return new Promise((resolve, reject) => { const id = ++jobSeq; jobs.set(id, { resolve, reject }); w.postMessage({ ...payload, id }); });
}

// ---------- candles for the chart ----------
const candleBusy = new Set();
export function ensureCandles(m, tf) {
  if (!tf.remote) return;
  const c = (m.candleCache ||= {})[tf.key], k = m.symbol + tf.key;
  if ((c && Date.now() - c.at < 15000) || candleBusy.has(k)) return;
  candleBusy.add(k);
  send({ ticks_history: m.symbol, style: 'candles', granularity: tf.secs, count: 150, end: 'latest' })
    .then((r) => { m.candleCache[tf.key] = { at: Date.now(), candles: (r.candles || []).map((x) => ({ epoch: x.epoch, open: +x.open, high: +x.high, low: +x.low, close: +x.close })) }; })
    .catch((e) => log('candles ' + m.symbol + ': ' + e.message, 'warn'))
    .finally(() => { candleBusy.delete(k); emit(); });
}

// ---------- predictions ----------
const quoteCache = new Map();
async function quoteFor(sym, d, type) {
  const k = `${sym}|${durationKey(d)}|${type}`, c = quoteCache.get(k);
  if (c && Date.now() - c.at < 8000) return c.q;
  const r = await send({ proposal: 1, amount: 1, basis: 'stake', contract_type: type, currency: 'USD', duration: d.n, duration_unit: d.unit, underlying_symbol: sym });
  const q = { ask: Number(r.proposal.ask_price), payout: Number(r.proposal.payout), spot: r.proposal.spot, longcode: r.proposal.longcode };
  quoteCache.set(k, { q, at: Date.now() });
  return q;
}

const lastActedEpoch = new Map();
let sigTimer = null, sigBusy = false;
async function signalTick() {
  if (sigBusy) return; sigBusy = true;
  try {
    sWorker = sWorker || mkWorker();
    for (const m of state.markets.values()) {
      if (!m.historyLoaded) { try { await loadHistory(m.symbol); } catch { continue; } }
      if (m.prices.length < 300 || !m.durations.length) continue;
      const d = m.durations[0];
      const r = await runJob(sWorker, { type: 'predict', prices: m.prices.slice(-1500), epochs: m.epochs.slice(-1500) });
      let q = null;
      if (r.result) { try { q = await quoteFor(m.symbol, d, r.result.direction > 0 ? 'CALL' : 'PUT'); } catch { /* no quote */ } }
      const sig = { ...buildTradeSignal({ symbol: m.symbol, prediction: r.result, duration: durationKey(d), quote: q }), epoch: r.lastEpoch, durationObj: d };
      m.signal = sig; state.signals.set(m.symbol, sig);
      emit();
      if (state.running && state.mode === 'auto' && modeMayAct('auto', sig)) await autoTrade(m, sig);
    }
  } finally { sigBusy = false; emit(); }
}
async function autoTrade(m, sig) {
  if (lastActedEpoch.get(m.symbol) === sig.epoch) return;
  lastActedEpoch.set(m.symbol, sig.epoch);
  await placeSignal(sig, 'auto');
}

let paused = false;
export function pause() {
  if (state.running || paused || !state.markets.size) return;
  paused = true; clearInterval(sigTimer); sigTimer = null;
  send({ forget_all: 'ticks' }).catch(() => {});
}
export function resume() {
  if (!paused) return;
  paused = false; startLoop();
  Promise.all([...state.markets.keys()].map((sym) => send({ ticks: sym, subscribe: 1 }).catch(() => {}))).then(emit);
}
export function startLoop() { if (!sigTimer) sigTimer = setInterval(signalTick, 4000); }
export function setRunning(on) { state.running = !!on; if (on) startLoop(); log(on ? `Engine started (${state.mode})` : 'Engine stopped'); emit(); }
export function setMode(m) { state.mode = m; log(`Mode: ${m}`); emit(); }
export function setStake(v) { state.stake = Math.max(0.35, Number(v) || 1); emit(); }
export function confirmReal(v) { state.realConfirmed = !!v; emit(); }

// ---------- trades ----------
function loadTrades() { try { state.trades = JSON.parse(localStorage.getItem(TRADES_KEY) || '[]'); } catch { state.trades = []; } }
function saveTrades() { try { localStorage.setItem(TRADES_KEY, JSON.stringify(state.trades.slice(0, 500))); } catch { /* quota */ } }
loadTrades();

function riskState() {
  const open = state.trades.filter((t) => t.status === 'open');
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const todayPnl = state.trades.filter((t) => t.status === 'closed' && t.ts >= dayStart).reduce((a, t) => a + (t.profit || 0), 0);
  const lastTradeAt = {}; state.trades.forEach((t) => { lastTradeAt[t.market] = Math.max(lastTradeAt[t.market] || 0, t.ts); });
  return { open, todayPnl, lastTradeAt, balance: accountInfo().balance };
}

/** Manual (from ticket) or signal-driven order. Returns {ok, reason}. */
export async function placeOrder({ symbol, contractType, duration, source = 'manual', signal = null, stake = state.stake }) {
  const acc = accountInfo();
  if (!acc.connected) return { ok: false, reason: 'Connect a Deriv account first' };
  const m = state.markets.get(symbol);
  const risk = checkOrder({ stake, market: symbol, isReal: acc.isReal, realConfirmed: state.realConfirmed, now: Date.now() }, riskState(), state.limits);
  if (!risk.ok) { log(`${symbol} blocked: ${risk.reason}`, 'warn'); return risk; }
  try {
    const res = await buyRiseFall({ symbol, contractType, stake, duration });
    const t = {
      id: String(res.buy.contract_id), market: symbol, name: m?.name, contractType, direction: contractType === 'CALL' ? 'Rise' : 'Fall',
      duration: durationKey(duration), stake, buyPrice: res.buy.buy_price, payout: res.buy.payout ?? res.proposal.payout,
      entry: null, exit: null, profit: null, status: 'open', isReal: res.isReal, source, ts: Date.now(),
      strength: signal?.strength ?? null, drivers: signal?.drivers || [],
    };
    state.trades.unshift(t); saveTrades(); watchContracts(onContract); requestContractUpdate(t.id);
    log(`${source} ${t.direction} ${symbol} ${t.duration} @ ${t.stake} (${t.isReal ? 'REAL' : 'DEMO'})`, 'ok');
    emit(); return { ok: true, trade: t };
  } catch (e) { log(`${symbol} order failed: ${e.message}`, 'bad'); return { ok: false, reason: e.message }; }
}
export const placeSignal = (sig, source = 'semi') => placeOrder({ symbol: sig.market, contractType: sig.contractType, duration: sig.durationObj, source, signal: sig });

function onContract(c) {
  const t = state.trades.find((x) => x.id === String(c.contract_id));
  if (!t) return;
  if (c.entry_tick != null) t.entry = c.entry_tick;
  if (c.payout != null) t.payout = c.payout;
  if (c.bid_price != null) t.bid = c.bid_price;
  if (c.is_sold || c.status === 'sold' || c.is_expired) {
    t.exit = c.exit_tick ?? c.sell_spot ?? t.exit; t.profit = Number(c.profit);
    t.status = 'closed'; t.result = t.profit > 0 ? 'win' : 'loss'; saveTrades();
    log(`${t.market} ${t.direction} ${t.result.toUpperCase()} ${t.profit >= 0 ? '+' : ''}${t.profit}`, t.profit > 0 ? 'ok' : 'bad');
  }
  emit();
}
export function attachAccount() { watchContracts(onContract); state.trades.filter((t) => t.status === 'open').forEach((t) => requestContractUpdate(t.id)); }

// ---------- derived metrics (all from recorded Deriv data) ----------
export function metrics() {
  const acc = accountInfo();
  const open = state.trades.filter((t) => t.status === 'open');
  const closed = state.trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.profit > 0).length;
  const openStake = open.reduce((a, t) => a + (t.buyPrice || t.stake), 0);
  const known = open.filter((t) => t.bid != null);
  const settleNow = known.length === open.length && open.length ? known.reduce((a, t) => a + t.bid, 0) : null;
  return {
    account: acc, openStake, settleNow, potentialPayout: open.reduce((a, t) => a + (t.payout || 0), 0),
    sessionPnl: closed.reduce((a, t) => a + t.profit, 0), closed: closed.length, wins, win: wilson(wins, closed.length),
    exposure: exposureLevel(openStake, acc.balance),
    markets: state.markets.size, tradable: [...state.markets.values()].filter((m) => m.signal?.gate === GATE.OK).length,
    failed: closed.length - wins,
  };
}

export function marketGate(m) {
  const g = m.signal?.gate;
  return { label: g || GATE.NO_DATA, ok: g === GATE.OK };
}
