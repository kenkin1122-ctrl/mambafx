/**
 * core/debugRecorder.js
 *
 * Developer AI Mode's central instrumentation hub. Exposes
 * `window.__mfxDebug` as the primary inspection surface — this is exactly
 * what Playwright/CDP read via `page.evaluate(() => window.__mfxDebug...)`,
 * with zero staleness since it IS live browser state, not a copy shipped
 * somewhere else first. Also optionally relays snapshots to a local HTTP
 * server (tools/mfx-debug-server.js) so plain `curl` / HTTP-based
 * inspection works too, for anyone who prefers that over browser
 * automation — see that file for why this needs to be started manually.
 *
 * DESIGN PRINCIPLE, stated because it constrains every function below:
 * this module is a one-way sink. Other modules call INTO it to record what
 * happened; it never reaches back into them, never wraps their return
 * values, never can silently change their behavior. Observability code
 * that can affect the thing it's observing is exactly how you get bugs
 * that only happen while you're watching for bugs — every recording
 * function here is fire-and-forget and wrapped so it can never throw into
 * the caller.
 *
 * SCOPE, stated directly: this records ticks, candles, WebSocket traffic,
 * and errors — all things that genuinely exist in the running app today.
 * Signal/trade recording functions exist and work, but there is no Market
 * State Recognition Engine yet to call them with real classification
 * data — that's future work this hub is built to support, not something
 * it fabricates output for today.
 */

const MAX_WS_LOG = 2000;
const MAX_MARKET_STATES = 10000;
const MAX_ERRORS = 500;
const MAX_SIGNALS = 1000;
const MAX_TRADES = 1000;
const RELAY_THROTTLE_MS = 1000;

const state = {
  wsLog: [],
  marketStates: [],
  errors: [],
  reconnectCount: 0,
  connectionStatus: 'unknown',
  subscriptions: {},
  pendingLatency: {},
  signals: [],
  trades: [],
};

let relayUrl = null;
let lastRelayAt = 0;

function push(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

export function recordOutgoing(reqId, msg) {
  const ts = Date.now();
  push(state.wsLog, { dir: 'out', reqId: reqId ?? null, msg, ts }, MAX_WS_LOG);
  if (reqId != null) state.pendingLatency[reqId] = ts;
  maybeRelay();
}

export function recordIncoming(reqId, msg) {
  const ts = Date.now();
  let latencyMs = null;
  if (reqId != null && state.pendingLatency[reqId] != null) {
    latencyMs = ts - state.pendingLatency[reqId];
    delete state.pendingLatency[reqId];
  }
  push(state.wsLog, { dir: 'in', reqId: reqId ?? null, msg, ts, latencyMs }, MAX_WS_LOG);
  maybeRelay();
}

export function recordReconnect() { state.reconnectCount++; }
export function setConnectionStatus(status) { state.connectionStatus = status; }
export function setSubscription(key, info) { state.subscriptions[key] = { ...info, updatedAt: Date.now() }; }

export function recordMarketState(snapshot) {
  push(state.marketStates, { ...snapshot, ts: Date.now() }, MAX_MARKET_STATES);
  maybeRelay();
}

export function recordError(source, message, stack) {
  push(state.errors, { source, message: String(message), stack: stack ? String(stack) : null, ts: Date.now() }, MAX_ERRORS);
  maybeRelay();
}

export function recordSignal(signal) {
  push(state.signals, { ...signal, ts: Date.now() }, MAX_SIGNALS);
  maybeRelay();
}

export function recordTrade(trade) {
  push(state.trades, { ...trade, ts: Date.now() }, MAX_TRADES);
  maybeRelay();
}

export function getState() { return state.marketStates[state.marketStates.length - 1] || null; }

export function getHistory(n = 500) {
  return {
    ticks: state.marketStates.slice(-n).map(s => ({ ts: s.ts, tick: s.tick, symbol: s.symbol })),
    marketStates: state.marketStates.slice(-n),
    signals: state.signals.slice(-n),
    trades: state.trades.slice(-100),
  };
}

export function getSocketInfo() {
  return {
    status: state.connectionStatus,
    reconnectCount: state.reconnectCount,
    subscriptions: state.subscriptions,
    pendingRequests: Object.keys(state.pendingLatency).length,
    recentMessages: state.wsLog.slice(-50),
    averageLatencyMs: computeAverageLatency(),
  };
}

export function getIndicators() { const last = getState(); return last ? (last.indicators || null) : null; }
export function getSignals(n = 100) { return state.signals.slice(-n); }
export function getTrades(n = 100) { return state.trades.slice(-n); }
export function getErrors(n = 100) { return state.errors.slice(-n); }

export function getPerformance() {
  return {
    marketStateCount: state.marketStates.length,
    wsLogCount: state.wsLog.length,
    errorCount: state.errors.length,
    reconnectCount: state.reconnectCount,
    memoryEstimateBytes: estimateMemory(),
  };
}

function computeAverageLatency() {
  const withLatency = state.wsLog.filter(e => e.dir === 'in' && e.latencyMs != null);
  if (!withLatency.length) return null;
  return Math.round(withLatency.reduce((s, e) => s + e.latencyMs, 0) / withLatency.length);
}

function estimateMemory() {
  try { return JSON.stringify(state).length; } catch (_) { return null; }
}

function maybeRelay() {
  if (!relayUrl) return;
  const now = Date.now();
  if (now - lastRelayAt < RELAY_THROTTLE_MS) return;
  lastRelayAt = now;
  try {
    fetch(relayUrl.replace(/\/$/, '') + '/debug/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: getState(), socket: getSocketInfo(), performance: getPerformance(),
        signals: getSignals(20), trades: getTrades(20), errors: getErrors(20),
      }),
    }).catch(() => {});
  } catch (_) { /* guarded per this module's fire-and-forget principle */ }
}

export function enableHttpRelay(url) { relayUrl = url; }
export function disableHttpRelay() { relayUrl = null; }

export function installGlobal() {
  if (typeof window === 'undefined') return;
  // Idempotent by design: the main dashboard's inline script and this
  // ES module both may try to install window.__mfxDebug (load order
  // between an inline <script> and an async <script type="module"> isn't
  // guaranteed) — whichever runs first must win, so neither side ever
  // silently discards buffers the other has already started collecting.
  if (window.__mfxDebug) return;

  window.__mfxDebug = {
    getState, getHistory, getSocketInfo, getIndicators, getSignals, getTrades, getPerformance, getErrors,
    recordSignal, recordTrade,
    enableHttpRelay, disableHttpRelay,
  };

  if (typeof console !== 'undefined' && !console.__mfxWrapped) {
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args) => { recordError('console.error', args.map(String).join(' ')); origError(...args); };
    console.warn = (...args) => { recordError('console.warn', args.map(String).join(' ')); origWarn(...args); };
    console.__mfxWrapped = true;
  }

  window.addEventListener('error', e => {
    recordError('window.onerror', e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', e => {
    recordError('unhandledrejection', e.reason && e.reason.message ? e.reason.message : String(e.reason));
  });
}
