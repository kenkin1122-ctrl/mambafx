// Minimal static file server for Mamba FX local preview on Replit
// Serves all static assets (index.html, JS modules, audit tools, etc.)
// Phase 8 API endpoints: GET /api/phase8/seal, POST /api/phase8/run
// This does NOT replace the Cloudflare Worker backend — it only serves static files.

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 5000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

// ─── Phase 8 engine (lazy-loaded on first API call) ─────────────────────────
let _engine = null;
function getEngine() {
  if (!_engine) _engine = require('./phase8-engine');
  return _engine;
}

// ─── JSON body reader ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) { // 50 MB limit
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ─── Request handler ─────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url);
  const reqPath = decodeURIComponent(parsed.pathname);

  // ── CORS preflight ──────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ── API: GET /api/phase8/seal ───────────────────────────────────────────
  if (req.method === 'GET' && reqPath === '/api/phase8/seal') {
    try {
      const seal = getEngine().getSeal();
      json(res, 200, { ok: true, seal });
    } catch (e) {
      console.error('[/api/phase8/seal]', e.message);
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ── API: POST /api/phase8/run ───────────────────────────────────────────
  if (req.method === 'POST' && reqPath === '/api/phase8/run') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 400, { ok: false, error: 'Body read error: ' + e.message });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      json(res, 400, { ok: false, error: 'Invalid JSON body' });
      return;
    }
    if (!Array.isArray(payload.states)) {
      json(res, 400, { ok: false, error: 'Request must have a "states" array' });
      return;
    }
    console.log(`[/api/phase8/run] Received ${payload.states.length} states. Starting campaign…`);
    try {
      const result = await getEngine().runCampaign(payload.states);
      console.log(`[/api/phase8/run] Campaign complete. ok=${result.ok} hyps=${result.hypotheses ? result.hypotheses.length : '?'} elapsed=${result.serverElapsedMs}ms`);
      json(res, 200, { ok: true, result });
    } catch (e) {
      console.error('[/api/phase8/run] Campaign error:', e.message);
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────
  let filePath = reqPath === '/' || reqPath === '' ? '/index.html' : reqPath;
  filePath = path.join(ROOT, filePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? '404 Not Found' : '500 Internal Server Error');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Mamba FX static server running on port ${PORT}`);
  console.log(`Open the preview to see index.html`);
  console.log(`Phase 7 audit: /msd-phase7-audit.html`);
});
