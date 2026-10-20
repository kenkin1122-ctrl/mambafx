/**
 * src/bazu/engine.js
 *
 * Orchestrator. A DEDICATED public Deriv WebSocket is used because the main feed tracks
 * one SYMBOL, discards other symbols' ticks, and calls forget_all on symbol changes.
 * Pipeline: Prediction (worker validation + live signals) -> Decision (decision.js, risk.js)
 * -> Execution (execution.js). The UI only calls commands and reads `state`.
 */

import { parseActiveSymbols, parseContractsFor, pickDurations, durationAllowed } from './universe.js?v=15';
import { durationKey } from './validation.js?v=15';
import { buildTradeSignal, modeMayAct, GATE } from './decision.js?v=16';
import { predict3m } from './predict3m.js?v=16';
import { configFor } from './config3m.js?v=17';
import { hysteresisPass } from './filters3m.js?v=15';
import { allowedDurations, durationLabel } from './duration3m.js?v=15';
import { resolveRecord } from './calibration3m.js?v=15';
import { backfill, mergeCandles, parseCandles } from './backfill3m.js?v=16';
import { decimalsFromPip } from './timeframes.js?v=15';
import { checkOrder, DEFAULT_LIMITS, exposureLevel } from './risk.js?v=15';
import { start as perfStart, mark as perfMark, startMonitors } from './perf3m.js?v=15';
import { accountInfo, watchContracts, requestContractUpdate } from './execution.js?v=15';
import { createBook, S as SS } from './signalBook3m.js?v=15';
import { createChoke } from './choke3m.js?v=17';
import { createRealMode, REAL_LIMITS_DEFAULT } from './realMode3m.js?v=17';
import { createSupervisor } from './reconnect3m.js?v=15';
import { wilson } from './stats.js?v=15';
import { expiryProbBaseline, sigmaPerTick, reliabilityCurve, brier } from './expiry3m.js?v=15';
import { createLogger } from './siglogRuntime3m.js?v=20';
import { CRT_CONFIG } from './crtConfig3m.js?v=6';
import { createCrtTracker, crtExecutionAllowed } from './crt3m.js?v=6';
import { createCrtJournal } from './crtJournal3m.js?v=6';

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_PAGES = 2;
const MAX_TICKS = 6000;
const TRADES_KEY = 'bazu_trades_v1';

export const state = {
  status: 'idle', mode: 'manual', running: false, stake: 1, curStake: 1, martingale: 1, reverse: true, limits: { ...DEFAULT_LIMITS },
  markets: new Map(), trades: [], log: [], scan: { done: 0, total: 0, active: false },
  selected: null, signals: new Map(), manualKey: null, records: [], vetoStats: {}, backfill: null,
  contra: { directional: 0, opposing: 0, tradable: 0, tradableOpposing: 0, byPlaybook: {} },
  crtByMarket: new Map(),
  crtCollection: { status: 'waiting_for_demo_account', signalsLogged: 0, sampleSize: CRT_CONFIG.report_sample_size, baseRate: null, lookahead: null, error: null },
};

if (typeof window !== 'undefined') window.__bzState = state;
const signalLogger = createLogger({
  getMarket: (symbol) => state.markets.get(symbol),
  getTrades: () => state.trades,
});
signalLogger.store.ready.then(() => { emit(); }).catch((e) => console.error('BAZU signal-log database initialization failed', e));
export const signalLogRecords = () => signalLogger.store.all();
export const signalLogStatus = () => ({
  ...signalLogger.stat, ...signalLogger.store.stat,
  loggerLastError: signalLogger.stat.lastError, storageLastError: signalLogger.store.stat.lastError,
  pending: signalLogger.pendingCount(),
});
export const signalLogStore = signalLogger.store;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let dirty = false;
function emit() { if (dirty) return; dirty = true; setTimeout(() => { dirty = false; const end = perfStart('ui.listeners'); listeners.forEach((f) => { try { f(state); } catch (e) { console.error(e); } }); end(); }, 1000); }
function log(msg, kind = 'info') { state.log.unshift({ t: Date.now(), msg, kind }); state.log.length = Math.min(state.log.length, 200); emit(); }

// ---------- public socket ----------
let ws = null, reqSeq = 1000000;
const waiting = new Map();
let wsReady = null;

function openWs() {
  if (wsReady) return wsReady;
  const sock = new WebSocket(WS_URL);
  ws = sock;
  wsReady = new Promise((resolve, reject) => {
    sock.onopen = () => { state.status = 'live'; emit(); resolve(); link.start(); };
    sock.onerror = () => reject(new Error('BAZU feed socket error'));
    sock.onclose = () => {
      if (ws !== sock) return;
      state.status = 'reconnecting'; wsReady = null; ws = null;
      for (const [id, w] of [...waiting]) { waiting.delete(id); w.reject(new Error('socket closed')); }
      reject(new Error('socket closed')); emit(); link.notifyClosed();
    };
    sock.onmessage = (ev) => {
      link.touch();
      const t0 = performance.now(), m = JSON.parse(ev.data);
      const w = m.req_id && waiting.get(m.req_id);
      if (w) { waiting.delete(m.req_id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m); }
      if (m.msg_type === 'tick' && m.tick) onTick(m.tick);
      perfMark(m.msg_type === 'tick' ? 'ws.tick' : 'ws.other', performance.now() - t0);
    };
  });
  wsReady.catch(() => {});
  return wsReady;
}
function send(msg, timeoutMs = 15000) {
  return openWs().then(() => new Promise((resolve, reject) => {
    const id = ++reqSeq;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout')); }, timeoutMs);
    waiting.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
    try { ws.send(JSON.stringify({ ...msg, req_id: id })); } catch (e) { clearTimeout(t); waiting.delete(id); reject(e); }
  }));
}

/** After every (re)connect: restore tick subscriptions, fill the tick gap, and re-read open-contract state. */
async function resync() {
  const syms = [...state.markets.keys()];
  await Promise.all(syms.map((sym) => send({ ticks: sym, subscribe: 1 }).catch(() => {})));
  const now = Date.now();
  for (const sym of syms) {
    const m = state.markets.get(sym);
    if (!m || m.lastEpoch == null || now - (m.lastTickAt || 0) < 5000) continue;
    try {
      const r = await send({ ticks_history: sym, start: m.lastEpoch + 1, end: 'latest', count: 1000, style: 'ticks' });
      const pr = r.history?.prices || [], tm = r.history?.times || [];
      for (let i = 0; i < pr.length; i++) onTick({ symbol: sym, quote: Number(pr[i]), epoch: Number(tm[i]) });
    } catch { /* a failed gap fill is covered by the next evaluation's freshness checks */ }
    await new Promise((res) => setTimeout(res, 150));
  }
  attachedWs = null;
  if (typeof window !== 'undefined' && window.gridWs) attachAccount();
  reconcileOpen();
  if (state.markets.size) log('Feed (re)connected, subscriptions and gaps restored');
}
const link = createSupervisor({
  connect: async () => { await openWs(); await resync(); },
  ping: () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ping: 1 })); },
  forceClose: () => { try { ws && ws.close(); } catch { /* already closed */ } },
  wanted: () => state.markets.size > 0,
  now: () => Date.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: (id) => clearTimeout(id),
  onState: (s, info) => { if (s === 'stale') log(`Feed silent for ${Math.round(info.silentMs / 1000)}s, forcing a reconnect`, 'warn'); if (s === 'reconnecting') { state.status = 'reconnecting'; emit(); } if (s === 'up') { state.status = 'live'; emit(); } },
});
export const feedLink = link;
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => link.kick());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) link.kick(); });
}
function onTick(t) {
  const m = state.markets.get(t.symbol);
  if (!m) return;
  const last = m.epochs[m.epochs.length - 1];
  if (last != null && t.epoch <= last) return;
  m.prices.push(t.quote); m.epochs.push(t.epoch);
  if (m.prices.length > MAX_TICKS) { m.prices.splice(0, 1500); m.epochs.splice(0, 1500); }
  m.last = t.quote; m.lastEpoch = t.epoch; m.lastTickAt = Date.now(); m.tickCount++;
  signalLogger.tick();
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
          state.markets.set(s.symbol, { ...s, ranges: rf.ranges, dp: decimalsFromPip(s.pip), prices: [], epochs: [], last: null, lastEpoch: null, tickCount: 0, status: 'discovered', signal: null, historyLoaded: false });
        }
      } catch (e) { log(`contracts_for ${s.symbol}: ${e.message}`, 'warn'); }
      state.scan.done++; emit();
    }
  }));
  state.scan.active = false;
  log(`Universe: ${state.markets.size} synthetic indices offer Rise/Fall (of ${syms.length} active)`);
  await Promise.all([...state.markets.keys()].map((sym) => send({ ticks: sym, subscribe: 1 }).catch(() => {}))); link.start();
  state.status = 'live'; emit();
  backfillAll().catch((e) => log('backfill: ' + e.message, 'warn'));
  const q = [...state.markets.keys()];
  for (let w = 0; w < 2; w++) (async () => { while (q.length) { try { await loadHistory(q.shift()); } catch (e) { log('history: ' + e.message, 'warn'); } } })();
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
  const w = new Worker(new URL('./worker.js?v=15', import.meta.url), { type: 'module' });
  w.onmessage = (ev) => { const j = jobs.get(ev.data.id); if (!j) return; jobs.delete(ev.data.id); ev.data.type === 'error' ? j.reject(new Error(ev.data.error)) : j.resolve(ev.data); };
  w.onerror = (e) => { log(`worker error: ${e.message}`, 'bad'); for (const j of jobs.values()) j.reject(new Error('worker failed')); jobs.clear(); };
  return w;
}
function runJob(w, payload) {
  return new Promise((resolve, reject) => { const id = ++jobSeq; const to = setTimeout(() => { jobs.delete(id); reject(new Error('worker timeout')); }, 8000); jobs.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } }); w.postMessage({ ...payload, id }); });
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

// ---------- remote candles: full startup backfill, then small incremental refreshes ----------
const remoteBusy = new Set();
let remoteSlots = 2;
const crtTrackers = new Map();
const crtScanKeys = new Map();
let crtJournal = null, crtJournalPromise = null;
function openCrtJournal() {
  if (!crtJournalPromise) {
    crtJournalPromise = Promise.resolve().then(() => createCrtJournal()).then(async (journal) => {
      await journal.ready;
      crtJournal = journal;
      return journal;
    }).catch((error) => {
      crtJournalPromise = null;
      throw error;
    });
  }
  return crtJournalPromise;
}
export function ensureRemote(m) {
  const cfg = configFor(m.symbol), store = (m.remote ||= {}), at = (m.remoteAt ||= {});
  for (const k of cfg.BACKFILL_FRAMES) {
    const secs = cfg.FRAMES[k], key = m.symbol + k, ttl = Math.max(60000, secs * 1000);
    if (remoteBusy.has(key) || (store[k] && Date.now() - (at[k] || 0) < ttl) || remoteSlots <= 0) continue;
    remoteBusy.add(key); remoteSlots--;
    send({ ticks_history: m.symbol, style: 'candles', granularity: secs, count: store[k] ? 10 : cfg.BACKFILL_COUNT, end: 'latest' })
      .then((r) => { store[k] = mergeCandles(store[k], parseCandles(r)); at[k] = Date.now(); })
      .catch((e) => { at[k] = Date.now() - ttl + 15000; log(`candles ${k} ${m.symbol}: ${e.message}`, 'warn'); })
      .finally(() => { remoteBusy.delete(key); remoteSlots++; });
  }
}
function accountTypeLabel() {
  const a = accountInfo();
  return !a.connected ? 'none' : a.isReal === false ? 'demo' : a.isReal === true ? 'real' : 'unknown';
}
async function refreshCrt(m) {
  if (!CRT_CONFIG.strategy_enabled || CRT_CONFIG.shadow_collection_only !== true) return;
  const decisionEpoch = m.epochs[m.epochs.length - 1];
  if (!Number.isFinite(decisionEpoch) || !m.remote?.H1?.length || !m.remote?.M5?.length) return;
  const scanKey = `${m.remote.H1[m.remote.H1.length - 1].epoch}:${m.remote.M5[m.remote.M5.length - 1].epoch}`;
  if (crtScanKeys.get(m.symbol) === scanKey) return;
  let tracker = crtTrackers.get(m.symbol);
  if (!tracker) { tracker = createCrtTracker(); crtTrackers.set(m.symbol, tracker); }
  const result = tracker.scan({
    symbol: m.symbol,
    h1Candles: m.remote.H1,
    ltfCandles: m.remote.M5,
    decisionEpoch,
    minTick: Number(m.pip),
  });
  state.crtByMarket.set(m.symbol, { status: 'shadow', scannedAt: decisionEpoch, ...result });
  try {
    const journal = await openCrtJournal();
    await journal.addQualified(result.records, {
      symbol: m.symbol,
      h1Candles: m.remote.H1,
      ltfCandles: m.remote.M5,
      decisionEpoch,
      minTick: Number(m.pip),
      accountType: accountTypeLabel(),
    });
    crtScanKeys.set(m.symbol, scanKey);
    await journal.resolveOutcomes(m.symbol, { epochs: m.epochs, prices: m.prices }, decisionEpoch);
    const reports = await journal.reports();
    const all = await journal.all();
    state.crtCollection = {
      status: 'collecting_shadow',
      signalsLogged: all.length,
      sampleSize: CRT_CONFIG.report_sample_size,
      baseRate: reports.baseRate,
      lookahead: reports.lookahead,
      error: null,
    };
    emit();
  } catch (error) {
    crtScanKeys.delete(m.symbol);
    state.crtCollection = { ...state.crtCollection, status: 'journal_error', error: String(error?.message || error) };
    log(`CRT shadow journal error: ${error?.message || error}`, 'bad');
  }
}
export function crtStatus(symbol) {
  const account = accountInfo();
  return {
    enabled: CRT_CONFIG.strategy_enabled && CRT_CONFIG.shadow_collection_only === true,
    configured: CRT_CONFIG.strategy_enabled && CRT_CONFIG.shadow_collection_only === true,
    validationStatus: CRT_CONFIG.validation_status,
    demoOnly: CRT_CONFIG.demo_only,
    demoConnected: account.connected && account.isReal === false,
    executionEligible: crtExecutionAllowed({ account }),
    latest: state.crtByMarket.get(symbol) || null,
    collection: state.crtCollection,
  };
}
export async function backfillAll() {
  const syms = [...state.markets.keys()], t0 = Date.now();
  const stats = await backfill({
    symbols: syms, send, cfg: configFor('R_100'),
    onFrame: (sym, k, cs) => { if (!cs) return; const m = state.markets.get(sym); (m.remote ||= {})[k] = mergeCandles(m.remote[k], cs); (m.remoteAt ||= {})[k] = Date.now(); },
  });
  state.backfill = { requests: stats.requests, failed: stats.failed, ms: Date.now() - t0 };
  log(`Candle backfill: ${stats.requests} requests, ${stats.failed} failed after retries${stats.failed ? " (missing frames are re-fetched in the background)" : ""}, ${((Date.now() - t0) / 1000).toFixed(0)}s`, stats.failed ? "warn" : "info");
}
// ---------- veto statistics (per market) ----------
const vetoKey = (v) => String(v).replace(/[\d.]+/g, '#');
function recordEval(sym, res) {
  const s = (state.vetoStats[sym] ||= { evals: 0, tradable: 0, vetoes: {} });
  s.evals++;
  if (!res.wait) s.tradable++;
  for (const v of res.vetoes || []) { const k = vetoKey(v); s.vetoes[k] = (s.vetoes[k] || 0) + 1; }
  if (res.direction && res.momentum?.available) {
    const c = state.contra; c.directional++;
    const opp = res.momentum.opposes60s === true;
    if (opp) { c.opposing++; c.byPlaybook[res.playbook] = (c.byPlaybook[res.playbook] || 0) + 1; }
    if (!res.wait) { c.tradable++; if (opp) c.tradableOpposing++; }
  }
}
export function vetoSummary() {
  const tot = { evals: 0, tradable: 0, vetoes: {} };
  for (const s of Object.values(state.vetoStats)) { tot.evals += s.evals; tot.tradable += s.tradable; for (const [k, v] of Object.entries(s.vetoes)) tot.vetoes[k] = (tot.vetoes[k] || 0) + v; }
  return tot;
}
// ---------- predictions ----------
const quoteCache = new Map();
let nextProposalAt = 0;
async function quoteFor(sym, d, type) {
  const k = `${sym}|${durationKey(d)}|${type}`, c = quoteCache.get(k);
  if (c && Date.now() - c.at < 30000) return c.q;
  const wait = Math.max(0, nextProposalAt - Date.now()); nextProposalAt = Math.max(Date.now(), nextProposalAt) + 700; if (wait) await new Promise((r) => setTimeout(r, wait));
  const r = await send({ proposal: 1, amount: 1, basis: 'stake', contract_type: type, currency: 'USD', duration: d.n, duration_unit: d.unit, underlying_symbol: sym });
  const q = { ask: Number(r.proposal.ask_price), payout: Number(r.proposal.payout), spot: r.proposal.spot, longcode: r.proposal.longcode };
  quoteCache.set(k, { q, at: Date.now() });
  return q;
}

// ---------- allowed durations, signal records (calibration / shadow log; records only, never a gate) ----------
function allowedFor(m) {
  const n = m.epochs.length, k = Math.min(n - 1, 200);
  const tickSecs = k > 0 ? (m.epochs[n - 1] - m.epochs[n - 1 - k]) / k : NaN;
  const key = tickSecs.toFixed(2);
  if (m.allowedKey !== key) { m.allowedKey = key; m.allowedList = allowedDurations(m.ranges, tickSecs, configFor(m.symbol), durationAllowed); }
  return m.allowedList;
}
const REC_KEY = 'bazu_calib_v1', REC_KEEP = 600;
function loadRecords() { try { state.records = JSON.parse(localStorage.getItem(REC_KEY) || '[]'); } catch { state.records = []; } }
function saveRecords() { try { localStorage.setItem(REC_KEY, JSON.stringify(state.records.slice(-REC_KEEP))); } catch { /* quota */ } }
loadRecords();
let recSeq = 0;
function logRecord(m, pred, sig) {
  const rec = pred.record; if (!rec) return null;
  const cfg = configFor(m.symbol), last = [...state.records].reverse().find((x) => x.symbol === m.symbol);
  if (last && rec.at - last.at < cfg.LOG_MIN_GAP_S) return last.id;
  const r = { ...rec, id: `${m.symbol}-${rec.at}-${++recSeq}`, breakEven: sig.quote ? sig.quote.ask / sig.quote.payout : null, taken: false, realised: null, shadow: {} };
  state.records.push(r); if (state.records.length > REC_KEEP * 2) state.records.splice(0, REC_KEEP);
  return r.id;
}
function resolveRecords(m) {
  const cfg = configFor(m.symbol); let ch = false;
  for (const r of state.records) {
    if (r.symbol !== m.symbol || r.done) continue;
    const prev = JSON.stringify([r.realised, r.shadow]);
    r.done = resolveRecord(r, m.prices, m.epochs, cfg);
    if (prev !== JSON.stringify([r.realised, r.shadow])) ch = true;
  }
  if (ch) saveRecords();
}
export function setManualDuration(key) { state.manualKey = key || null; log(key ? `Manual duration: ${key}` : 'Duration: automatic (signal lifetime)'); emit(); }
export function allowedKeys() { const s = new Set(); state.markets.forEach((m) => (m.allowedList || []).forEach((d) => s.add(durationLabel(d)))); return [...s]; }

const lastActedEpoch = new Map();
let sigTimer = null, sigBusy = false;
const SLICE_MS = 8;
const UNIT_S = { t: 2, s: 1, m: 60, h: 3600, d: 86400 };
const STALE_ASK_MS = 20000, STALE_GIVEUP_MS = 120000;
const endMs = (t) => { const mt = /^(\d+)([tsmhd])$/.exec(String(t.duration || '')); return t.ts + (mt ? Number(mt[1]) * UNIT_S[mt[2]] * 1000 : 0); };
/** Open trades past expiry: ask Deriv again; give up (status 'stale') so they never block new trades. */
function reconcileOpen() {
  const now = Date.now(); let changed = false;
  for (const t of state.trades) {
    if (t.status !== 'open') continue;
    const over = now - endMs(t);
    if (over > STALE_GIVEUP_MS) { t.status = 'stale'; changed = true; }
    else if (over > STALE_ASK_MS) requestContractUpdate(t.id);
  }
  if (changed) { saveTrades(); log('Unsettled trades marked stale (no result from Deriv); they no longer block new trades', 'warn'); }
}
const yieldUi = () => new Promise((res) => setTimeout(res, 0));
// ---------- signal book + single purchase gate ----------
const book = createBook({ cfgFor: (sym) => configFor(sym) });
export const signalBook = book;
const marketNow = (sym) => { const m = state.markets.get(sym); return m && m.epochs.length ? m.epochs[m.epochs.length - 1] + (Date.now() - (m.lastTickAt || Date.now())) / 1000 : Date.now() / 1000; };
function predictFor(m, wall = true) {
  const n = m.epochs.length;
  return predict3m({ symbol: m.symbol, prices: m.prices.slice(-6000), epochs: m.epochs.slice(-6000), remote: m.remote || {}, decisionEpoch: m.epochs[n - 1], allowed: allowedFor(m), manualKey: state.manualKey, wallNow: wall ? marketNow(m.symbol) : null });
}
/** Per-session real-account opt-ins (never persisted: every page load starts demo only). */
export const realMode = createRealMode({
  limits: REAL_LIMITS_DEFAULT,
  onTrip: (reason) => {
    if (state.mode !== 'manual') state.mode = 'manual';
    log(`Real-account Auto/Semi-auto disabled: ${reason}. Re-enable it explicitly to resume.`, 'bad'); emit();
  },
});
const dataAgeMs = (sym) => { const m = state.markets.get(sym); return m && m.lastTickAt ? Date.now() - m.lastTickAt : null; };
const choke = createChoke({
  book, cfgFor: (sym) => configFor(sym), now: marketNow, log: (msg, kind) => log(msg, kind),
  predictNow: (sym) => { const m = state.markets.get(sym); return m && m.prices.length >= 300 ? predictFor(m) : null; },
  account: accountInfo, riskState, limits: state.limits, realConfirmed: () => realMode.isEnabledFor(accountInfo()),
  real: realMode, trades: () => state.trades, dataAgeMs,
  durationFor: (sig) => { const m = state.markets.get(sig.symbol); return (m?.allowedList || []).find((x) => durationLabel(x) === sig.durationKey) || null; },
});
const NOISY = new Set([SS.ARMED, SS.DETECTED]);
function logEvents(events) {
  for (const e of events) if (e.to && !NOISY.has(e.to) && e.to !== SS.EXECUTING) log(`${e.symbol} signal ${e.id || ''} ${e.from || ''} -> ${e.to}${e.kind ? ' [' + e.kind + ']' : ''}: ${e.reason}`, e.to === SS.TRIGGERED || e.to === SS.EXECUTED ? 'ok' : 'info');
}
const wasTradable = new Map();
/** P9: separate enter/exit strength thresholds for the tradable state (no-op while both offsets are 0). */
function applyHysteresis(sym, res) {
  const cfg = configFor(sym), min = res.minStrength;
  if (!(min > 0) || !(cfg.HYST_ENTER_EXTRA || cfg.HYST_EXIT_SLACK)) { wasTradable.set(sym, !res.wait && res.strength >= (min ?? 0)); return; }
  const ok = !res.wait && hysteresisPass({ strength: res.strength, wasTradable: !!wasTradable.get(sym), min, cfg });
  wasTradable.set(sym, ok);
  res.minStrength = ok ? Math.min(min, res.strength) : Math.max(min, res.strength + 1e-9);
}
export async function signalTick() {
  if (sigBusy) return; sigBusy = true; startMonitors(); reconcileOpen(); realMode.monitor(accountInfo());
  const endPass = perfStart('signalTick');
  try {
    let sliceT = performance.now();
    for (const m of [...state.markets.values()]) {
      if (performance.now() - sliceT > SLICE_MS) { await yieldUi(); sliceT = performance.now(); }
      if (!m.historyLoaded) { loadHistory(m.symbol).catch(() => {}); }
      if (m.prices.length < 300) continue;
      ensureRemote(m);
      refreshCrt(m).catch((e) => log(`CRT analysis ${m.symbol}: ${e.message}`, 'warn'));
      const allowed = allowedFor(m);
      let r;
      const endP = perfStart('predict3m'); try { r = predictFor(m); } catch (e) { endP(); log('predict ' + m.symbol + ': ' + e.message, 'warn'); continue; } endP();
      recordEval(m.symbol, r);
      applyHysteresis(m.symbol, r);
      const obs = book.observe(m.symbol, r, r.decisionTs); logEvents(obs.events);
      r = { result: r, lastEpoch: r.decisionTs };
      let q = null; const d = r.result.duration && allowed.find((x) => durationLabel(x) === r.result.duration.key);
      if (d && !r.result.wait && r.result.strength >= r.result.minStrength) { try { q = await quoteFor(m.symbol, d, r.result.direction > 0 ? 'CALL' : 'PUT'); } catch { /* no quote */ } }
      const sig = { ...buildTradeSignal({ symbol: m.symbol, prediction: r.result, duration: d ? durationKey(d) : null, quote: q, bookSignal: book.active(m.symbol) }), epoch: r.lastEpoch, durationObj: d || null };
      const endR = perfStart('records'); sig.recId = logRecord(m, r.result, sig);
      resolveRecords(m); endR();
      m.signal = sig; state.signals.set(m.symbol, sig);
      emit();
      if (state.running && state.mode === 'auto' && state.martingale <= 1 && modeMayAct('auto', sig)) await autoTrade(m, sig);
      if (sig.gate === GATE.OK && sig.signalState === SS.TRIGGERED) signalLogger.onSignal(sig, m, { rec: r.result.record, minStrength: r.result.minStrength });
    }
    if (state.running && state.mode === 'auto' && state.martingale > 1) await autoTradeBest();
  } finally { sigBusy = false; endPass(); emit(); }
}
/** Martingale mode: one trade at a time, always on the strongest tradable market. */
let bestBusy = false;
async function autoTradeBest() {
  if (bestBusy || state.trades.some((t) => t.status === 'open')) return;
  const cand = [...state.markets.values()].map((m) => m.signal && { m, sig: m.signal }).filter((x) => x && modeMayAct('auto', x.sig)).sort((a, b) => b.sig.strength - a.sig.strength);
  if (!cand.length) return;
  bestBusy = true;
  try { await autoTrade(cand[0].m, cand[0].sig); } finally { bestBusy = false; }
}
async function autoTrade(m, sig) { await placeSignal(sig, 'auto'); }

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
export function setStake(v) { state.stake = Math.max(0.35, Number(v) || 1); state.curStake = state.stake; emit(); }
export function setReverse(on) { state.reverse = !!on; log(on ? 'Reverse mode ON: trades the opposite of the prediction' : 'Reverse mode OFF: trades the predicted direction'); emit(); }
export function setMartingale(v) { const n = Number(v); state.martingale = n > 1 ? n : 1; state.curStake = state.stake; emit(); }
const nextStake = () => +(Math.max(0.35, state.curStake || state.stake)).toFixed(2);
export function enableRealTrading(phrase) { const r = realMode.enable(accountInfo(), phrase); log(r.ok ? 'Real trading ENABLED for this session (demo-only on reload)' : `Real trading not enabled: ${r.reason}`, r.ok ? 'warn' : 'bad'); emit(); return r; }
export function disableRealTrading() { const r = realMode.disable(); log('Real trading disabled', 'ok'); emit(); return r; }
export function enableRealAuto(phrase) { const r = realMode.enableAuto(accountInfo(), phrase); log(r.ok ? 'Real Auto/Semi-auto ENABLED for this session' : `Real Auto not enabled: ${r.reason}`, r.ok ? 'warn' : 'bad'); emit(); return r; }
export function disableRealAuto() { const r = realMode.disableAuto(); log('Real Auto/Semi-auto disabled', 'ok'); emit(); return r; }

// ---------- trades ----------
function loadTrades() { try { state.trades = JSON.parse(localStorage.getItem(TRADES_KEY) || '[]'); } catch { state.trades = []; } }
function saveTrades() { try { localStorage.setItem(TRADES_KEY, JSON.stringify(state.trades.slice(0, 500))); } catch { /* quota */ } }
loadTrades();
const PNL_KEY = 'bazu_pnl_reset_v1';
let pnlReset = { demo: 0, real: 0 };
try { pnlReset = { ...pnlReset, ...JSON.parse(localStorage.getItem(PNL_KEY) || '{}') }; } catch { /* default */ }
/** Zero the P/L counter of one account kind ('demo' | 'real'); trades stay in history. */
export function resetPnl(kind) { if (kind !== 'demo' && kind !== 'real') return; pnlReset[kind] = Date.now(); try { localStorage.setItem(PNL_KEY, JSON.stringify(pnlReset)); } catch { /* quota */ } log('P/L reset (' + kind + ')', 'ok'); emit(); }
const pnlOf = (isReal) => state.trades.filter((t) => t.status === 'closed' && !!t.isReal === isReal && t.ts >= pnlReset[isReal ? 'real' : 'demo']);

function riskState() {
  const open = state.trades.filter((t) => t.status === 'open');
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const todayPnl = state.trades.filter((t) => t.status === 'closed' && t.ts >= dayStart).reduce((a, t) => a + (t.profit || 0), 0);
  const lastTradeAt = {}; state.trades.forEach((t) => { lastTradeAt[t.market] = Math.max(lastTradeAt[t.market] || 0, t.ts); });
  return { open, todayPnl, lastTradeAt, balance: accountInfo().balance };
}

function recordTrade({ res, symbol, contractType, duration, stake, source, signal, m }) {
  const t = {
    id: String(res.buy.contract_id), market: symbol, name: m?.name, contractType, direction: contractType === 'CALL' ? 'Rise' : 'Fall',
    duration: durationKey(duration), stake, buyPrice: res.buy.buy_price, payout: res.buy.payout ?? res.proposal.payout,
    entry: null, exit: null, profit: null, status: 'open', isReal: res.isReal, account_type: res.isReal ? 'real' : 'demo', source, ts: Date.now(),
    predicted: signal?.predicted ?? null, strength: signal?.strength ?? null, drivers: signal?.drivers || [], signalId: signal?.signalId || null,
    playbook: signal?.playbook || null,
  };
  if (signal) signalLogger.onBuy(t, { ...signal, contractType, direction: contractType === 'CALL' ? 'Rise' : 'Fall' }, m, { rec: state.records.find((r) => r.id === signal.recId), minStrength: signal.minStrength });
  state.trades.unshift(t); saveTrades(); watchContracts(onContract); requestContractUpdate(t.id);
  log(`${source} ${t.direction}${t.predicted && t.predicted !== t.direction ? ` (predicted ${t.predicted}, reversed)` : ''} ${symbol} ${t.duration} @ ${t.stake} (${t.isReal ? 'REAL' : 'DEMO'})`, 'ok');
  emit(); return t;
}
/** Manual ticket order. Goes through the choke point; gate findings must be confirmed (`confirmed: true`). */
export async function placeOrder({ symbol, contractType, duration, source = 'manual', stake = nextStake(), confirmed = false, ticketConfirmed = false }) {
  const m = state.markets.get(symbol);
  const r = await choke.manual({ symbol, contractType, duration, stake, confirmed, ticketConfirmed });
  if (!r.ok) { if (!r.needsConfirm) log(`${symbol} blocked: ${r.reason}`, 'warn'); return r; }
  return { ok: true, trade: recordTrade({ res: r.res, symbol, contractType, duration, stake, source, signal: null, m }) };
}
/** Signal-driven order: every purchase passes the signal book and the choke point. */
export async function placeSignal(sig, source = 'semi') {
  if (!sig?.signalId) return { ok: false, reason: 'no triggered signal to execute' };
  const rec = state.records.find((x) => x.id === sig.recId); if (rec) { rec.taken = true; saveRecords(); }
  const flip = state.reverse && (sig.contractType === 'CALL' || sig.contractType === 'PUT');
  const stake = nextStake();
  const r = await choke.execute({ signalId: sig.signalId, stake, reverse: flip, source });
  logEvents(book.log().slice(-3));
  if (!r.ok) { if (rec) { rec.taken = false; saveRecords(); } return r; }
  const t = recordTrade({ res: r.res, symbol: sig.market, contractType: r.contractType, duration: sig.durationObj, stake, source, signal: { ...sig, predicted: sig.contractType === 'CALL' ? 'Rise' : 'Fall' }, m: state.markets.get(sig.market) });
  return { ok: true, trade: t };
}
function onContract(c) {
  const t = state.trades.find((x) => x.id === String(c.contract_id));
  if (!t) return;
  if (c.entry_tick != null) t.entry = c.entry_tick;
  if (c.entry_tick_time != null || c.date_start != null) t.entryEpoch = Number(c.entry_tick_time ?? c.date_start);
  if (c.exit_tick_time != null || c.date_expiry != null) t.exitEpoch = Number(c.exit_tick_time ?? c.date_expiry);
  if (c.payout != null) t.payout = c.payout;
  if (c.bid_price != null) t.bid = Number(c.bid_price);
  if (c.is_sold || c.status === 'sold' || c.status === 'won' || c.status === 'lost' || c.is_expired) {
    t.exit = c.exit_tick ?? c.sell_spot ?? t.exit; t.profit = Number(c.profit);
    t.status = 'closed'; t.derivStatus = String(c.status || (c.is_expired ? 'expired' : 'unknown')).toLowerCase();
    t.settledAt = Date.now();
    t.result = t.entry != null && t.exit != null && Number(t.entry) === Number(t.exit)
      ? 'tie'
      : t.derivStatus === 'won' ? 'win'
        : t.derivStatus === 'lost' ? 'loss'
          : Number.isFinite(t.profit) ? t.profit > 0 ? 'win' : t.profit < 0 ? 'loss' : 'tie'
            : 'unknown';
    saveTrades();
    signalLogger.tick();
    if (t.profit > 0) state.curStake = state.stake; else if (state.martingale > 1 && t.profit < 0) state.curStake = +(Number(t.stake) * state.martingale).toFixed(2);
    log(`${t.market} ${t.direction}${t.strength != null ? ` (${Math.round(t.strength * 100)}%)` : ''} ${t.result.toUpperCase()} ${t.profit >= 0 ? '+' : ''}${t.profit}`, t.profit > 0 ? 'ok' : 'bad');
  }
  emit();
}
/**
 * P1/P2: model estimate of P(win at expiry) for an open contract (analytic baseline, drift 0), updated on every tick.
 * Returns null when any input is missing. Also snapshots the probability once half the contract has elapsed so it can be
 * calibrated against the settled outcome.
 */
export function expiryInfo(t) {
  const m = state.markets.get(t.market);
  if (!t || t.status !== 'open' || !m || t.entry == null || t.entryEpoch == null || m.epochs.length < 30) return null;
  const n = m.epochs.length, k = Math.min(200, n - 1), tickSecs = (m.epochs[n - 1] - m.epochs[n - 1 - k]) / k;
  const mm = /^(\d+)([tsmhd])$/.exec(String(t.duration)); if (!mm || !(tickSecs > 0)) return null;
  const total = Number(mm[1]), unit = mm[2];
  let totalTicks, tau;
  if (unit === 't') { let el = 0; for (let i = n - 1; i >= 0 && m.epochs[i] > t.entryEpoch; i--) el++; totalTicks = total; tau = total - el; }
  else { const secs = total * UNIT_S[unit]; totalTicks = secs / tickSecs; tau = (t.entryEpoch + secs - m.epochs[n - 1]) / tickSecs; }
  const p = expiryProbBaseline({ dir: t.direction === 'Rise' ? 1 : -1, spot: m.prices[n - 1], entry: Number(t.entry), tau: Math.max(0, tau), sigma: sigmaPerTick(m.prices) });
  if (p != null && t.pMid == null && tau <= totalTicks / 2) { t.pMid = p; saveTrades(); }
  return p == null ? null : { p, tauTicks: Math.max(0, tau), model: 'baseline' };
}
/** Calibration of the live-contract probability: pairs of (probability at half time, settled outcome). */
export function expiryCalibration({ from, to, includeSamples = false } = {}) {
  const done = state.trades.filter((t) => {
    const ts = t.settledAt || t.ts;
    return t.status === 'closed' && t.pMid != null && (t.result === 'win' || t.result === 'loss' || t.result === 'tie') &&
      (!from || ts >= Date.parse(`${from}T00:00:00Z`)) && (!to || ts < Date.parse(`${to}T00:00:00Z`) + 86400000);
  });
  const summarize = (items) => {
    const probs = items.map((t) => t.pMid), ys = items.map((t) => (t.result === 'win' ? 1 : 0));
    return { n: items.length, curve: reliabilityCurve(probs, ys, 5), brier: brier(probs, ys), brier50: brier(probs.map(() => 0.5), ys), ...(includeSamples ? { samples: items.map((t, i) => ({ probability: probs[i], outcome: ys[i] })) } : {}) };
  };
  return {
    ...summarize(done), nMin: configFor('R_100').EXPIRY_N_MIN,
    by_account_type: Object.fromEntries(['demo', 'real'].map((type) => [type, summarize(done.filter((t) => (t.isReal ? 'real' : 'demo') === type))])),
  };
}
let attachedWs = null;
export function attachAccount() {
  if (attachedWs === window.gridWs) return;
  attachedWs = window.gridWs;
  watchContracts(onContract);
  state.trades.forEach((t) => { if (t.status === 'open' && !/^\d+$/.test(String(t.id))) { t.status = 'closed'; t.result = 'unknown'; } });
  state.trades.filter((t) => t.status === 'open' || t.status === 'stale').forEach((t) => requestContractUpdate(t.id));
}

// ---------- derived metrics (all from recorded Deriv data) ----------
export function metrics() {
  const acc = accountInfo();
  const open = state.trades.filter((t) => t.status === 'open');
  const closed = pnlOf(!!acc.isReal);
  const wins = closed.filter((t) => t.profit > 0).length;
  const openStake = open.reduce((a, t) => a + (Number(t.buyPrice) || Number(t.stake) || 0), 0);
  const known = open.filter((t) => t.bid != null);
  const settleNow = known.length === open.length && open.length ? known.reduce((a, t) => a + Number(t.bid), 0) : null;
  return {
    account: acc, openStake, settleNow, potentialPayout: open.reduce((a, t) => a + (Number(t.payout) || 0), 0),
    sessionPnl: closed.reduce((a, t) => a + (Number(t.profit) || 0), 0), demoPnl: pnlOf(false).reduce((a, t) => a + (Number(t.profit) || 0), 0), realPnl: pnlOf(true).reduce((a, t) => a + (Number(t.profit) || 0), 0), closed: closed.length, wins, win: wilson(wins, closed.length),
    exposure: exposureLevel(openStake, acc.balance),
    markets: state.markets.size, tradable: [...state.markets.values()].filter((m) => m.signal?.gate === GATE.OK).length,
    failed: closed.length - wins,
  };
}

export function marketGate(m) {
  const g = m.signal?.gate;
  return { label: g || GATE.NO_DATA, ok: g === GATE.OK };
}
