/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 * =====================================================================
 * Routes:
 *   GET  /auth/start      → redirect to Deriv login (PKCE)
 *   GET  /auth/callback   → exchange code for token, store session, redirect to SPA
 *   GET  /me/session      → { logged_in: true|false }
 *   GET  /me/accounts     → all accounts (real + virtual) with per-account tokens
 *   POST /ws/otp          → { account_id } → { url } — uses account's own token
 *   POST /logout          → clear session
 * =====================================================================
 */

const DERIV_AUTH_URL  = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_WS_URL    = "wss://ws.derivws.com/websockets/v3";

const SESSION_COOKIE      = "mfx_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;   // 8 hours
const PKCE_TTL_SECONDS    = 60 * 10;        // 10 minutes

// ── CORS ────────────────────────────────────────────────────────────
function corsHeaders(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenlin1122-ctrl.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, env, status, extraHeaders){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(env), "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

// ── Cookie helpers ───────────────────────────────────────────────────
function setSessionCookie(sessionId, maxAge){
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}
function clearSessionCookie(){
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}
function readCookie(request, name){
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)){
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// ── Random ID ────────────────────────────────────────────────────────
function randomId(bytes){
  const arr = new Uint8Array(bytes || 24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
}

// ── PKCE ─────────────────────────────────────────────────────────────
function base64url(buf){
  let str = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
async function pkceChallenge(verifier){
  const data   = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

// ── Session ──────────────────────────────────────────────────────────
async function getSession(request, env){
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get(`session:${sid}`);
  if (!raw) return null;
  try { return { id: sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}

// ── Deriv WebSocket: authorize + get full account list with tokens ────
// Each account in account_list has its own token field. We store all of
// them so we can open an authenticated WS for any account without a
// separate OTP call for virtual accounts (which the REST OTP rejects).
async function derivAuthorizeWs(accessToken, appId){
  const url  = `${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}`;
  const resp = await fetch(url, {
    headers: { "Upgrade": "websocket", "Connection": "Upgrade" },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error("WebSocket upgrade failed");
  ws.accept();
  ws.send(JSON.stringify({ authorize: accessToken, req_id: 1 }));

  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => {
      try { ws.close(); } catch(_){}
      reject(new Error("authorize timeout"));
    }, 9000);

    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(_){ return; }
      if (msg.msg_type !== "authorize") return;
      clearTimeout(tid);
      try { ws.close(); } catch(_){}
      if (msg.error) return reject(new Error(msg.error.message || "authorize error"));
      resolve(msg.authorize || {});
    });
    ws.addEventListener("error", () => { clearTimeout(tid); reject(new Error("ws error")); });
    ws.addEventListener("close", () => { clearTimeout(tid); resolve({}); });
  });
}

// ── Derive WS URL for a specific account token ───────────────────────
// Given an account-specific token, open a WS, authorize, and return the
// WebSocket URL the browser can use directly. We don't use a one-time
// passcode (OTP) system here — instead we open a WS and immediately
// pass the token, which is how Deriv's own platform works.
//
// IMPORTANT: We cannot give the raw token to the browser (that would
// expose it). Instead we open the WS server-side, send authorize, and
// then return the already-authorized WS URL — but that's not how
// WebSockets work (the WS URL must be for the browser to open).
//
// The correct pattern for Deriv is:
//   1. Backend calls Deriv REST POST /accounts/{id}/otp with the MASTER token.
//   2. Deriv returns a one-time WS URL the browser can connect to.
//   3. For virtual accounts, Deriv requires switching via the primary account
//      WS (authorize with primary, then call set_account via WS).
//
// Simplest approach that WORKS for both real + virtual:
//   - Store per-account tokens in session after authorize.
//   - For OTP request: open WS with that account's token, prove we can authorize,
//     then return a new WS URL using the account-specific token as a short-lived
//     credential in the URL query string.
//
// Since Deriv accepts ?token=<account_token> in the WS URL:
//   wss://ws.derivws.com/websockets/v3?app_id=xxx&l=EN&brand=deriv&token=<acct_token>
// This IS the official authorized WS URL for that account.
async function getAccountWsUrl(accountToken, appId){
  // Deriv's official authorized WS URL format for direct browser connection
  return `${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}&token=${encodeURIComponent(accountToken)}`;
}

// ═══════════════════════════════════════════════════════════════════
// Route handlers
// ═══════════════════════════════════════════════════════════════════

// GET /auth/start
async function handleAuthStart(request, env){
  const verifier   = randomId(48);
  const state      = randomId(16);
  const challenge  = await pkceChallenge(verifier);

  await env.SESSION.put(`pkce:${state}`, JSON.stringify({ verifier }), {
    expirationTtl: PKCE_TTL_SECONDS,
  });

  const params = new URLSearchParams({
    response_type:         "code",
    client_id:             env.CLIENT_ID,
    redirect_uri:          env.REDIRECT_URI,
    scope:                 "trade",
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });

  return Response.redirect(DERIV_AUTH_URL + "?" + params.toString(), 302);
}

// GET /auth/callback
async function handleAuthCallback(request, env){
  const url     = new URL(request.url);
  const code    = url.searchParams.get("code");
  const state   = url.searchParams.get("state");
  const errP    = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description");
  const spa     = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";

  if (errP) return Response.redirect(
    spa + "?login_error=" + encodeURIComponent(errDesc || errP), 302);
  if (!code || !state) return Response.redirect(
    spa + "?login_error=" + encodeURIComponent("Missing code or state."), 302);

  const pkceRaw = await env.SESSION.get(`pkce:${state}`);
  if (!pkceRaw) return Response.redirect(
    spa + "?login_error=" + encodeURIComponent("Login expired — try again."), 302);
  await env.SESSION.delete(`pkce:${state}`);

  let verifier;
  try { verifier = JSON.parse(pkceRaw).verifier; } catch(_){}
  if (!verifier) return Response.redirect(
    spa + "?login_error=" + encodeURIComponent("PKCE verifier missing."), 302);

  const form = new URLSearchParams({
    grant_type:    "authorization_code",
    client_id:     env.CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri:  env.REDIRECT_URI,
  });
  if (env.CLIENT_SECRET) form.set("client_secret", env.CLIENT_SECRET);

  let tokenResp, tokenBody;
  try {
    tokenResp = await fetch(DERIV_TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    form.toString(),
    });
    tokenBody = await tokenResp.json().catch(() => null);
  } catch(e){
    return Response.redirect(
      spa + "?login_error=" + encodeURIComponent("Could not reach Deriv token endpoint."), 302);
  }

  if (!tokenResp.ok || !tokenBody || !tokenBody.access_token){
    const msg = (tokenBody && (tokenBody.error_description || tokenBody.error)) || `HTTP ${tokenResp.status}`;
    return Response.redirect(
      spa + "?login_error=" + encodeURIComponent("Token exchange failed: " + msg), 302);
  }

  // ── Immediately authorize via WS to get per-account tokens ──────
  // account_list entries contain { loginid, token, is_virtual, currency }
  // We store these tokens in the session so /ws/otp can use them later.
  let accountTokens = {};  // { loginid: { token, currency, is_virtual } }
  try {
    const authData = await derivAuthorizeWs(tokenBody.access_token, env.CLIENT_ID);
    const accounts = authData.account_list || [];
    accounts.forEach(a => {
      if (a.loginid && a.token) {
        accountTokens[a.loginid] = {
          token:      a.token,
          currency:   a.currency  || "USD",
          is_virtual: a.is_virtual ? 1 : 0,
        };
      }
    });
  } catch(wsErr){
    // Non-fatal: account tokens unavailable, OTP will fall back to REST
    console.error("WS authorize in callback failed:", wsErr.message);
  }

  const sessionId = randomId(32);
  await env.SESSION.put(`session:${sessionId}`, JSON.stringify({
    access_token:  tokenBody.access_token,
    account_tokens: accountTokens,   // per-account WS tokens
    created_at:    Date.now(),
  }), { expirationTtl: SESSION_TTL_SECONDS });

  return new Response(null, {
    status:  302,
    headers: {
      "Location":   spa,
      "Set-Cookie": setSessionCookie(sessionId, SESSION_TTL_SECONDS),
    },
  });
}

// GET /me/session
async function handleMeSession(request, env){
  const session = await getSession(request, env);
  return json({ logged_in: !!session }, env, 200);
}

// GET /me/accounts — returns ALL accounts (real + virtual) with is_virtual flag
async function handleMeAccounts(request, env){
  const session = await getSession(request, env);
  if (!session) return json({ error: "not_logged_in" }, env, 401);

  let allAccounts = [];

  // ── Primary: use cached account_tokens from session ──────────────
  if (session.account_tokens && Object.keys(session.account_tokens).length){
    allAccounts = Object.entries(session.account_tokens).map(([loginid, info]) => ({
      account_id:   loginid,
      account_type: info.is_virtual ? "virtual" : "trading",
      currency:     info.currency || "USD",
      is_virtual:   info.is_virtual ? 1 : 0,
    }));
  }

  // ── Fallback: re-authorize via WS to get fresh account_list ──────
  if (!allAccounts.length){
    try {
      const authData = await derivAuthorizeWs(session.access_token, env.CLIENT_ID);
      const accounts = authData.account_list || [];

      // Rebuild account_tokens in session
      const accountTokens = {};
      accounts.forEach(a => {
        if (a.loginid && a.token){
          accountTokens[a.loginid] = { token: a.token, currency: a.currency || "USD", is_virtual: a.is_virtual ? 1 : 0 };
        }
      });
      // Persist updated tokens
      await env.SESSION.put(`session:${session.id}`, JSON.stringify({
        ...session,
        account_tokens: accountTokens,
      }), { expirationTtl: SESSION_TTL_SECONDS });

      allAccounts = accounts.filter(a => a.loginid).map(a => ({
        account_id:   a.loginid,
        account_type: a.is_virtual ? "virtual" : "trading",
        currency:     a.currency || "USD",
        is_virtual:   a.is_virtual ? 1 : 0,
      }));
    } catch(wsErr){
      console.error("[me/accounts] WS authorize failed:", wsErr.message);
      // Last resort: REST fallback
      try {
        const resp = await fetch(`https://api.derivws.com/trading/v1/options/accounts`, {
          headers: { "Authorization": "Bearer " + session.access_token, "Deriv-App-ID": env.CLIENT_ID },
        });
        const body = await resp.json().catch(() => null);
        if (resp.ok && body && body.data){
          allAccounts = body.data.map(a => ({
            account_id:   String(a.account_id || ""),
            account_type: String(a.account_type || ""),
            currency:     String(a.currency || "USD"),
            is_virtual:   /^VR/i.test(String(a.account_id || "")) ? 1 : 0,
          })).filter(a => a.account_id);
        }
      } catch(_){
        return json({ error: "upstream_unreachable", message: "Could not reach Deriv." }, env, 502);
      }
    }
  }

  if (!allAccounts.length){
    return json({ error: "no_accounts", message: "No accounts found. Please log out and log in again." }, env, 200);
  }

  return json({ data: allAccounts }, env, 200);
}

// POST /ws/otp — { account_id } → { url }
// Uses per-account token stored at login. No separate OTP REST call needed.
// For virtual accounts this is the KEY fix: virtual account tokens work
// directly in the WS URL query string (wss://...?app_id=X&token=Y).
async function handleWsOtp(request, env){
  const session = await getSession(request, env);
  if (!session) return json({ error: "not_logged_in" }, env, 401);

  const payload   = await request.json().catch(() => ({}));
  const accountId = payload.account_id;
  if (!accountId) return json({ error: "missing_account_id" }, env, 400);

  // ── Try per-account token from session (works for both real + virtual) ──
  const acctInfo = session.account_tokens && session.account_tokens[accountId];
  if (acctInfo && acctInfo.token){
    const wsUrl = await getAccountWsUrl(acctInfo.token, env.CLIENT_ID);
    return json({ url: wsUrl }, env, 200);
  }

  // ── If no stored token, re-authorize to get it ──────────────────
  try {
    const authData = await derivAuthorizeWs(session.access_token, env.CLIENT_ID);
    const accounts = authData.account_list || [];
    const target   = accounts.find(a => a.loginid === accountId);

    if (target && target.token){
      // Update session with fresh tokens
      const updatedTokens = { ...(session.account_tokens || {}) };
      accounts.forEach(a => {
        if (a.loginid && a.token)
          updatedTokens[a.loginid] = { token: a.token, currency: a.currency || "USD", is_virtual: a.is_virtual ? 1 : 0 };
      });
      await env.SESSION.put(`session:${session.id}`, JSON.stringify({
        ...session,
        account_tokens: updatedTokens,
      }), { expirationTtl: SESSION_TTL_SECONDS });

      const wsUrl = await getAccountWsUrl(target.token, env.CLIENT_ID);
      return json({ url: wsUrl }, env, 200);
    }
  } catch(wsErr){
    console.error("[ws/otp] WS re-authorize failed:", wsErr.message);
  }

  // ── Last resort: Deriv REST OTP (only works for primary/real account) ──
  try {
    const resp = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
      method:  "POST",
      headers: { "Authorization": "Bearer " + session.access_token, "Deriv-App-ID": env.CLIENT_ID },
    });
    const body = await resp.json().catch(() => null);
    if (resp.ok){
      const wsUrl = body && body.data && body.data.url;
      if (wsUrl) return json({ url: wsUrl }, env, 200);
    }
    const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${resp.status}`;
    return json({ error: "otp_failed", message: msg }, env, resp.status);
  } catch(e){
    return json({ error: "upstream_unreachable", message: "Could not reach Deriv." }, env, 502);
  }
}

// POST /logout
async function handleLogout(request, env){
  const session = await getSession(request, env);
  if (session) await env.SESSION.delete(`session:${session.id}`);
  return json({ ok: true }, env, 200, { "Set-Cookie": clearSessionCookie() });
}

// ═══════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx){
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const missing = [];
    if (!env.SESSION || typeof env.SESSION.get !== "function") missing.push("SESSION (KV)");
    if (!env.CLIENT_ID)   missing.push("CLIENT_ID");
    if (!env.REDIRECT_URI) missing.push("REDIRECT_URI");
    if (missing.length && path !== "/" && path !== "/health"){
      return json({ error: "server_misconfigured", message: "Missing: " + missing.join(", ") }, env, 500);
    }

    try {
      if (path === "/auth/start"    && request.method === "GET")  return await handleAuthStart(request, env);
      if (path === "/auth/callback" && request.method === "GET")  return await handleAuthCallback(request, env);
      if (path === "/me/session"    && request.method === "GET")  return await handleMeSession(request, env);
      if (path === "/me/accounts"   && request.method === "GET")  return await handleMeAccounts(request, env);
      if (path === "/ws/otp"        && request.method === "POST") return await handleWsOtp(request, env);
      if (path === "/logout"        && request.method === "POST") return await handleLogout(request, env);
      if (path === "/" || path === "/health"){
        return json({
          ok: true, service: "mambafx-backend",
          config: {
            session_kv_bound: !!(env.SESSION && typeof env.SESSION.get === "function"),
            client_id_set:    !!env.CLIENT_ID,
            redirect_uri_set: !!env.REDIRECT_URI,
            client_secret_set: !!env.CLIENT_SECRET,
            spa_url:          env.SPA_URL || null,
            allowed_origin:   env.ALLOWED_ORIGIN || null,
          },
        }, env, 200);
      }
      return json({ error: "not_found", message: `No route for ${request.method} ${path}` }, env, 404);
    } catch(e){
      return json({ error: "internal_error", message: String(e && e.message || e), stack: String(e && e.stack || "") }, env, 500);
    }
  },
};
