#!/usr/bin/env node
/**
 * tools/mfx-debug-server.js
 *
 * A tiny, standalone, zero-dependency local HTTP server for Developer AI
 * Mode. Uses only Node's built-in `http` module — nothing to `npm install`.
 *
 * WHAT THIS IS: a relay, not a source of truth. MambaFX has no backend
 * application server (it's a static HTML file plus an ES-module tree,
 * both running entirely in the browser) — so there is nothing for a
 * `GET /debug/state` request to reach unless something bridges the gap.
 * This is that bridge: the browser's window.__mfxDebug POSTs a snapshot
 * here roughly once a second (throttled — see core/debugRecorder.js),
 * and this server just remembers the most recent one and serves it back
 * on GET.
 *
 * WHAT THIS IS NOT: this does not run automatically. You start it
 * yourself:
 *
 *   node tools/mfx-debug-server.js [port]        # default port 4317
 *
 * ...and then, in the running MambaFX page (via DevTools console, or a
 * Playwright page.evaluate call), point the recorder at it:
 *
 *   window.__mfxDebug.enableHttpRelay('http://localhost:4317')
 *
 * From then on:
 *
 *   curl http://localhost:4317/debug/state
 *   curl http://localhost:4317/debug/socket
 *   curl http://localhost:4317/debug/indicators
 *   curl http://localhost:4317/debug/signals
 *   curl http://localhost:4317/debug/trades
 *   curl http://localhost:4317/debug/performance
 *
 * NOTE ON /debug/history: the relay only carries a lightweight summary
 * (latest state, last 20 signals/trades/errors) to avoid POSTing the full
 * 10,000-entry rolling buffer every second for no reason. For the FULL
 * history, query window.__mfxDebug.getHistory(n) directly — via DevTools
 * console, or Playwright's page.evaluate(() => window.__mfxDebug.getHistory(500)).
 * /debug/history here returns whatever the last relay included, which is
 * enough for a quick check but not the complete rolling buffer.
 */

const http = require('http');

const PORT = Number(process.argv[2]) || 4317;

let latest = {
  state: null,
  socket: null,
  performance: null,
  signals: [],
  trades: [],
  errors: [],
  receivedAt: null,
};

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // the browser page origin (file:// or http(s)://) needs to POST here cross-origin
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

const routes = {
  '/debug/state': () => latest.state,
  '/debug/socket': () => latest.socket,
  '/debug/performance': () => latest.performance,
  '/debug/indicators': () => (latest.state ? latest.state.indicators || null : null),
  '/debug/signals': () => latest.signals,
  '/debug/trades': () => latest.trades,
  '/debug/history': () => ({
    note: 'This is a lightweight summary carried by the relay, not the full 10,000-entry buffer. For complete history, query window.__mfxDebug.getHistory(n) directly via DevTools or Playwright.',
    latestState: latest.state,
    recentSignals: latest.signals,
    recentTrades: latest.trades,
  }),
  '/debug/errors': () => latest.errors,
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  if (req.method === 'POST' && req.url === '/debug/report') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        latest = { ...latest, ...parsed, receivedAt: Date.now() };
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 400, { ok: false, error: 'Invalid JSON body: ' + e.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && routes[req.url]) {
    if (!latest.receivedAt) {
      send(res, 200, { warning: 'No snapshot received yet. Confirm the browser page has called window.__mfxDebug.enableHttpRelay(\'http://localhost:' + PORT + '\') and that at least one tick has arrived.', data: null });
      return;
    }
    const ageMs = Date.now() - latest.receivedAt;
    send(res, 200, { ageMs, stale: ageMs > 10000, data: routes[req.url]() });
    return;
  }

  if (req.method === 'GET' && req.url === '/debug/') {
    send(res, 200, {
      endpoints: Object.keys(routes),
      lastReportAgeMs: latest.receivedAt ? Date.now() - latest.receivedAt : null,
      usage: "Enable from the browser console: window.__mfxDebug.enableHttpRelay('http://localhost:" + PORT + "')",
    });
    return;
  }

  send(res, 404, { error: 'Unknown route. GET /debug/ for a list of endpoints.' });
});

server.listen(PORT, () => {
  console.log(`MambaFX Developer AI Mode debug relay listening on http://localhost:${PORT}`);
  console.log(`In the browser console, run: window.__mfxDebug.enableHttpRelay('http://localhost:${PORT}')`);
  console.log(`Then: curl http://localhost:${PORT}/debug/state`);
});
