/**
 * charts/socket.js
 *
 * Owns the single shared WebSocket connection to Deriv's public feed and all
 * candle/tick history requests. This module is intentionally DOM-free: it
 * never touches the connection-status indicator or panel headers directly —
 * it emits "connection:changed" and "panel:dataUpdated" on the EventBus, and
 * ui/header.js (which owns those DOM elements) subscribes to update them.
 * That boundary is what lets this module be unit-testable without a DOM and
 * reused by any future panel without caring who's listening.
 *
 * Connection-level state (ws, reconnect timer, endpoint index, the pending
 * request-id -> callback map) is module-private, not part of AppState — see
 * the note in core/AppState.js for why.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { WS_ENDPOINTS, CANDLE_COUNT } from '../core/constants.js';

let ws = null;
let reconnectTimer = null;
let endpointIdx = 0;
let reqSeq = 1000;
const pending = {}; // req_id -> callback(msg)

export function connect() {
  setConnState("connecting");
  const url = WS_ENDPOINTS[endpointIdx % WS_ENDPOINTS.length];
  try { ws = new WebSocket(url); }
  catch (e) { setConnState("dead"); endpointIdx++; scheduleReconnect(); return; }

  // Developer AI Mode — wrap .send() once here so every outgoing message
  // from this module (candle/tick history requests, forget_all) is
  // recorded automatically, the same pattern used for the main
  // dashboard's separate gridWs connection. These are two genuinely
  // different WebSocket connections; both report into the same shared
  // window.__mfxDebug recorder.
  if (typeof window !== 'undefined' && window.__mfxDebug) {
    const realSend = ws.send.bind(ws);
    ws.send = (data) => {
      try { const parsed = JSON.parse(data); window.__mfxDebug.recordOutgoing(parsed.req_id ?? null, parsed); } catch (_) {}
      return realSend(data);
    };
  }

  const timeout = setTimeout(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      try { ws.close(); } catch (_) {}
      endpointIdx++; setConnState("dead"); scheduleReconnect();
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(timeout);
    setConnState("live");
    ws.send(JSON.stringify({ forget_all: ["candles", "ticks"] }));
    // Iterate ALL registered timeframe panels (not just the htf/ltf
    // aliases) — with the 10-panel MTF Dashboard, every one of them needs
    // its own live subscription re-established, whether or not it's
    // currently aliased as the "active" analysis timeframe.
    const allPanels = Object.values(AppState.timeframePanels);
    const isReconnect = allPanels.length > 0 && allPanels[0].viewT0 != null;
    if (isReconnect && typeof window !== 'undefined' && window.__mfxDebug) window.__mfxDebug.recordReconnect();
    allPanels.forEach(p => requestPanelData(p, { preserveView: isReconnect }));
  };
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (typeof window !== 'undefined' && window.__mfxDebug) window.__mfxDebug.recordIncoming(msg.req_id ?? null, msg);
    if (msg.req_id && pending[msg.req_id]) {
      pending[msg.req_id](msg);
      if (!msg.subscription) delete pending[msg.req_id];
      return;
    }
    routeUnsolicited(msg);
  };
  ws.onerror = () => setConnState("dead");
  ws.onclose = () => { setConnState("dead"); scheduleReconnect(); };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

function setConnState(state) {
  if (typeof window !== 'undefined' && window.__mfxDebug) window.__mfxDebug.setConnectionStatus(state);
  eventBus.emit('connection:changed', state);
}

function routeUnsolicited(msg) {
  if (msg.error) return;
  // Iterate every registered timeframe panel, not just the two current
  // htf/ltf aliases — the 10-panel MTF Dashboard subscribes to all ten
  // simultaneously (see connect()'s onopen above), so incoming live data
  // must reach all ten too, whether or not each one happens to be
  // currently aliased as the "active" analysis timeframe.
  const allPanels = Object.values(AppState.timeframePanels);
  if (msg.msg_type === "ohlc" && msg.ohlc) {
    const p = allPanels.find(p => p && String(p.tf.g) === String(msg.ohlc.granularity));
    if (p) p.applyLiveCandle(msg.ohlc); // Panel itself emits panel:dataUpdated
  }
  if (msg.msg_type === "tick" && msg.tick && msg.tick.symbol === AppState.symbol) {
    allPanels.forEach(p => p && p.applyLiveTick(msg.tick));
  }
}

/**
 * Fetch candle/tick history for a panel and subscribe to live updates.
 * @param {import('./Panel.js').Panel} panel
 * @param {{start?: number, end?: number}} [opts] — for candle-decomposition (Phase 9): a bounded historical range instead of the live edge.
 */
export function requestPanelData(panel, opts = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const reqId = ++reqSeq;
  panel.candles = []; panel.ticks = [];

  if (panel.isTick() || panel.tf.g === "tick10") {
    const count = panel.tf.g === "tick10" ? CANDLE_COUNT * 10 : CANDLE_COUNT * 4;
    const msg = { ticks_history: AppState.symbol, style: "ticks", count, req_id: reqId };
    if (opts.start && opts.end) { msg.start = opts.start; msg.end = opts.end; delete msg.count; }
    else { msg.end = "latest"; msg.subscribe = 1; }
    pending[reqId] = m => handleTicksHistory(panel, m, opts);
    ws.send(JSON.stringify(msg));
  } else {
    const msg = { ticks_history: AppState.symbol, style: "candles", granularity: panel.tf.g, req_id: reqId };
    if (opts.start && opts.end) { msg.start = opts.start; msg.end = opts.end; }
    else { msg.count = CANDLE_COUNT; msg.end = "latest"; msg.subscribe = 1; }
    pending[reqId] = m => handleCandlesHistory(panel, m, opts);
    ws.send(JSON.stringify(msg));
  }
}

function handleCandlesHistory(panel, msg, opts = {}) {
  if (msg.error) {
    // Previously silent — a rejected request (rate limit, unsupported
    // granularity, anything) produced a blank chart with no diagnostic
    // trail at all, indistinguishable from "no data yet." Now it's at
    // least visible in the console, and charted, so it can be a fixed a bug
    // that says why, not an unexplained blank panel.
    console.warn(`[MTF] candle history request failed for ${panel.side} (granularity ${panel.tf?.g}):`, msg.error.message || msg.error);
    panel.lastError = msg.error.message || String(msg.error);
    eventBus.emit('panel:dataUpdated', { panel });
    return;
  }
  panel.lastError = null;
  if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
    panel.candles = msg.candles.map(c => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    if (panel.decompRange) panel.zoomToRange(panel.decompRange.t0, panel.decompRange.t1, 0.08);
    // A view already exists AND the caller asked to preserve it (the
    // reconnect path in connect()'s ws.onopen) — a dropped/restored
    // WebSocket connection refetches history to stay in sync, but that's
    // not a reason to yank the user's zoom/pan out from under them. Any
    // other caller (deliberate timeframe/symbol switch) still gets the
    // reset-to-default behavior, since the old view's time range is
    // usually meaningless at a different granularity.
    else if (panel.viewT0 != null && opts.preserveView) { /* leave viewT0/viewT1 untouched */ }
    else panel.setDefaultView();
    eventBus.emit('panel:dataUpdated', { panel });
  }
}

function handleTicksHistory(panel, msg, opts = {}) {
  if (msg.error) {
    console.warn(`[MTF] tick history request failed for ${panel.side}:`, msg.error.message || msg.error);
    panel.lastError = msg.error.message || String(msg.error);
    eventBus.emit('panel:dataUpdated', { panel });
    return;
  }
  panel.lastError = null;
  const h = msg.history;
  if (!h) return;
  const raw = h.times.map((t, i) => ({ epoch: +t, price: +h.prices[i] }));
  if (panel.tf.g === "tick10") {
    panel.candles = [];
    for (let i = 0; i < raw.length; i += 10) {
      const chunk = raw.slice(i, i + 10);
      if (!chunk.length) continue;
      panel.candles.push({
        epoch: chunk[0].epoch, open: chunk[0].price,
        high: Math.max(...chunk.map(c => c.price)), low: Math.min(...chunk.map(c => c.price)),
        close: chunk[chunk.length - 1].price, _n: chunk.length,
      });
    }
  } else {
    panel.ticks = raw;
  }
  if (panel.decompRange) panel.zoomToRange(panel.decompRange.t0, panel.decompRange.t1, 0.08);
  else if (panel.viewT0 != null && opts.preserveView) { /* leave the existing view untouched — see handleCandlesHistory's comment */ }
  else panel.setDefaultView();
  eventBus.emit('panel:dataUpdated', { panel });
}

/** Drop all history + subscriptions and refetch every registered panel — used on symbol switch. */
export function resubscribeAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ forget_all: ["candles", "ticks"] }));
  Object.values(AppState.timeframePanels).forEach(p => p && requestPanelData(p));
}

/**
 * One-shot candle snapshot for an arbitrary granularity — NOT tied to any
 * Panel instance, no live subscription (no `subscribe: 1`), just a single
 * request/response. Currently unused by any active feature (an earlier,
 * superseded draft of Smart Market Intelligence used it for a one-shot
 * multi-timeframe cascade before that feature was rebuilt with live data;
 * the draft was removed as dead code). Kept here as a small, self-contained,
 * already-correct utility in case a future feature needs a one-shot fetch
 * for a timeframe outside the live-subscribed set.
 * @returns {Promise<Array<{epoch:number,open:number,high:number,low:number,close:number}>>}
 */
export function fetchCandlesOnce(symbol, granularity, count = 60) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('not connected')); return; }
    const reqId = ++reqSeq;
    const timeout = setTimeout(() => { delete pending[reqId]; reject(new Error('timed out')); }, 10000);
    pending[reqId] = msg => {
      clearTimeout(timeout);
      if (msg.error) { reject(new Error(msg.error.message || 'request failed')); return; }
      if (msg.msg_type === 'candles' && Array.isArray(msg.candles)) {
        resolve(msg.candles.map(c => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close })));
      } else {
        reject(new Error('unexpected response shape'));
      }
    };
    ws.send(JSON.stringify({ ticks_history: symbol, style: 'candles', granularity, count, end: 'latest', req_id: reqId }));
  });
}
