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
    const { htf, ltf } = AppState.panels;
    if (htf) requestPanelData(htf);
    if (ltf) requestPanelData(ltf);
  };
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
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
  eventBus.emit('connection:changed', state);
}

function routeUnsolicited(msg) {
  if (msg.error) return;
  const { htf, ltf } = AppState.panels;
  if (msg.msg_type === "ohlc" && msg.ohlc) {
    const p = [htf, ltf].find(p => p && String(p.tf.g) === String(msg.ohlc.granularity));
    if (p) p.applyLiveCandle(msg.ohlc); // Panel itself emits panel:dataUpdated
  }
  if (msg.msg_type === "tick" && msg.tick && msg.tick.symbol === AppState.symbol) {
    [htf, ltf].forEach(p => p && p.applyLiveTick(msg.tick));
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
    pending[reqId] = m => handleTicksHistory(panel, m);
    ws.send(JSON.stringify(msg));
  } else {
    const msg = { ticks_history: AppState.symbol, style: "candles", granularity: panel.tf.g, req_id: reqId };
    if (opts.start && opts.end) { msg.start = opts.start; msg.end = opts.end; }
    else { msg.count = CANDLE_COUNT; msg.end = "latest"; msg.subscribe = 1; }
    pending[reqId] = m => handleCandlesHistory(panel, m);
    ws.send(JSON.stringify(msg));
  }
}

function handleCandlesHistory(panel, msg) {
  if (msg.error) { eventBus.emit('panel:dataUpdated', { panel }); return; }
  if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
    panel.candles = msg.candles.map(c => ({ epoch: +c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    if (!panel.decompRange) panel.setDefaultView();
    else panel.zoomToRange(panel.decompRange.t0, panel.decompRange.t1, 0.08);
    eventBus.emit('panel:dataUpdated', { panel });
  }
}

function handleTicksHistory(panel, msg) {
  if (msg.error) { eventBus.emit('panel:dataUpdated', { panel }); return; }
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
  if (!panel.decompRange) panel.setDefaultView();
  else panel.zoomToRange(panel.decompRange.t0, panel.decompRange.t1, 0.08);
  eventBus.emit('panel:dataUpdated', { panel });
}

/** Drop all history + subscriptions and refetch both panels — used on symbol switch. */
export function resubscribeAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ forget_all: ["candles", "ticks"] }));
  const { htf, ltf } = AppState.panels;
  if (htf) requestPanelData(htf);
  if (ltf) requestPanelData(ltf);
}

/**
 * One-shot candle snapshot for an arbitrary granularity — NOT tied to any
 * Panel instance, no live subscription (no `subscribe: 1`), just a single
 * request/response. Used by ai/marketIntelligence.js's multi-timeframe
 * cascade to get real data for timeframes not currently displayed in
 * either panel (e.g. Daily/H4 when the panels are showing H1/M1), without
 * disturbing what's actually on screen.
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
