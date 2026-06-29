/**
 * Mamba FX — Deriv OAuth2 backend (Cloudflare Worker)
 *
 * Uses the NEW Deriv OAuth2 PKCE flow (auth.deriv.com):
 *   client_id   = CLIENT_ID secret  (e.g. 33BoT5hHIzs1muGu7qhww)
 *   redirect_uri = https://mambafx-backend.kenkin1122.workers.dev/auth/callback
 *
 * Flow:
 *   1. GET /auth/start → redirect to auth.deriv.com with PKCE
 *   2. GET /auth/callback → exchange code for access_token
 *   3. Use access_token to call WS authorize → get account_list with tokens
 *   4. Store all accounts + per-account tokens in KV session
 *   5. GET /me/session, GET /me/accounts, POST /ws/otp for the SPA
 *
 * Required secrets (wrangler secret put NAME):
 *   CLIENT_ID       = 33BoT5hHIzs1muGu7qhww
 *   CLIENT_SECRET   = (if Deriv issued one — try without first)
 *
 * Required vars in wrangler.jsonc:
 *   REDIRECT_URI    = https://mambafx-backend.kenkin1122.workers.dev/auth/callback
 *   SPA_URL         = https://kenkin1122-ctrl.github.io/mambafx/
 *   ALLOWED_ORIGIN  = https://kenkin1122-ctrl.github.io
 */

const DERIV_AUTH_URL  = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_WS_URL    = "wss://ws.derivws.com/websockets/v3";

const SESSION_COOKIE  = "mfx_session";
const SESSION_TTL     = 60 * 60 * 8;
const PKCE_TTL        = 60 * 10;

// ── CORS ──────────────────────────────────────────────────────────────
function cors(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenkin1122-ctrl.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type",
    "Vary": "Origin",
  };
}
const J = (data, env, status=200, extra={}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors(env), "Content-Type": "application/json", ...extra },
  });

// ── Cookies ───────────────────────────────────────────────────────────
const mkCookie = (id, age) =>
  `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
const rmCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
function getCookie(req, name){
  for (const p of (req.headers.get("Cookie")||"").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i > -1 && p.slice(0,i) === name) return p.slice(i+1);
  }
  return null;
}

// ── Crypto helpers ────────────────────────────────────────────────────
const randHex = n => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,"0")).join("");
};
const b64u = buf => {
  let s = ""; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
};
const sha256 = async s =>
  b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// ── KV session ────────────────────────────────────────────────────────
async function loadSession(req, env){
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get("s:" + sid);
  if (!raw) return null;
  try { return { _sid: sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}
const saveSession = (env, sid, data) =>
  env.SESSION.put("s:" + sid, JSON.stringify(data), { expirationTtl: SESSION_TTL });

// ── WS authorize → get account_list with per-account tokens ───────────
async function wsAuthorize(accessToken, clientId){
  const wsResp = await fetch(`${DERIV_WS_URL}?app_id=${encodeURIComponent(clientId)}`, {
    headers: { "Upgrade": "websocket", "Connection": "Upgrade" },
  });
  const ws = wsResp.webSocket;
  if (!ws) throw new Error("WebSocket upgrade failed");
  ws.accept();
  ws.send(JSON.stringify({ authorize: accessToken }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { try{ws.close();}catch(_){} reject(new Error("timeout")); }, 10000);
    ws.addEventListener("message", ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch(_){ return; }
      if (msg.msg_type !== "authorize") return;
      clearTimeout(t); try{ws.close();}catch(_){}
      if (msg.error) return reject(new Error(msg.error.message || msg.error.code));
      resolve(msg.authorize || {});
    });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("WS error")); });
    ws.addEventListener("close", () => { clearTimeout(t); reject(new Error("WS closed early")); });
  });
}

// ── Normalise account_list entry ──────────────────────────────────────
function normalise(a){
  const id   = String(a.loginid || "");
  const virt = /^VR/i.test(id) || a.is_virtual === 1 || a.is_virtual === true;
  return {
    account_id:   id,
    account_type: virt ? "virtual" : "trading",
    currency:     a.currency || "USD",
    is_virtual:   virt ? 1 : 0,
    token:        a.token || null,   // per-account token — never sent to browser
  };
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/start — begin PKCE login
// ══════════════════════════════════════════════════════════════════════
async function handleAuthStart(req, env){
  const verifier  = randHex(48);
  const state     = randHex(16);
  const challenge = await sha256(verifier);

  // Store verifier under state key — retrieved in callback
  await env.SESSION.put("pkce:" + state, verifier, { expirationTtl: PKCE_TTL });

  const params = new URLSearchParams({
    response_type:         "code",
    client_id:             env.CLIENT_ID,
    redirect_uri:          env.REDIRECT_URI,
    scope:                 "trade",
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });

  const url = DERIV_AUTH_URL + "?" + params.toString();
  console.log("[auth/start] →", url);
  return Response.redirect(url, 302);
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/callback — exchange code, get tokens, store session
// ══════════════════════════════════════════════════════════════════════
async function handleAuthCallback(req, env){
  const spa  = env.SPA_URL || "https://kenkin1122-ctrl.github.io/mambafx/";
  const fail = msg => Response.redirect(`${spa}?login_error=${encodeURIComponent(msg)}`, 302);
  const u    = new URL(req.url);

  const errParam = u.searchParams.get("error");
  if (errParam) return fail(u.searchParams.get("error_description") || errParam);

  const code  = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) return fail("Missing code or state");

  // Recover PKCE verifier
  const verifier = await env.SESSION.get("pkce:" + state);
  if (!verifier) return fail("Login session expired — try again");
  await env.SESSION.delete("pkce:" + state);

  // Exchange code for access_token
  const form = new URLSearchParams({
    grant_type:    "authorization_code",
    client_id:     env.CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri:  env.REDIRECT_URI,
  });
  if (env.CLIENT_SECRET) form.set("client_secret", env.CLIENT_SECRET);

  let tokenBody;
  try {
    const r = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    tokenBody = await r.json().catch(() => null);
    if (!r.ok || !tokenBody?.access_token)
      return fail("Token exchange failed: " + (tokenBody?.error_description || tokenBody?.error || `HTTP ${r.status}`));
  } catch(e){ return fail("Cannot reach Deriv token endpoint"); }

  // WS authorize → get account_list with per-account tokens
  let accounts = [];
  try {
    const auth = await wsAuthorize(tokenBody.access_token, env.CLIENT_ID);
    const list = auth.account_list || [];
    accounts = list.map(normalise).filter(a => a.account_id);
    console.log(`[callback] ${accounts.length} account(s): ${
      accounts.map(a => `${a.account_id}(virt=${a.is_virtual},tok=${a.token ? a.token.slice(0,8)+"…" : "NONE"})`).join(", ")
    }`);
  } catch(e){
    console.error("[callback] wsAuthorize failed:", e.message);
    // Store access_token anyway so /me/accounts can retry
  }

  const sid = randHex(32);
  await saveSession(env, sid, {
    access_token: tokenBody.access_token,
    accounts,
    created_at:   Date.now(),
  });

  return new Response(null, {
    status:  302,
    headers: { "Location": spa, "Set-Cookie": mkCookie(sid, SESSION_TTL) },
  });
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/session
// ══════════════════════════════════════════════════════════════════════
async function handleMeSession(req, env){
  const s = await loadSession(req, env);
  return J({ logged_in: !!s }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/accounts — refreshes via WS if account list is empty
// ══════════════════════════════════════════════════════════════════════
async function handleMeAccounts(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  let accounts = (s.accounts || []).filter(a => a.account_id);

  // If no accounts (wsAuthorize failed at callback), retry now
  if (!accounts.length && s.access_token){
    console.log("[me/accounts] retrying wsAuthorize");
    try {
      const auth = await wsAuthorize(s.access_token, env.CLIENT_ID);
      accounts = (auth.account_list || []).map(normalise).filter(a => a.account_id);
      await saveSession(env, s._sid, { ...s, accounts });
    } catch(e){ console.error("[me/accounts] retry failed:", e.message); }
  }

  if (!accounts.length)
    return J({ error: "no_accounts", message: "No accounts found. Log out and log in again." }, env, 200);

  return J({ data: accounts.map(({ token:_, ...rest }) => rest) }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /ws/otp  { account_id } → { url, token }
// Returns the WS URL + that account's own token.
// Browser opens WS, sends { authorize: token } on open.
// ══════════════════════════════════════════════════════════════════════
async function handleWsOtp(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  const { account_id } = await req.json().catch(() => ({}));
  if (!account_id) return J({ error: "missing_account_id" }, env, 400);

  let acct = (s.accounts || []).find(a => a.account_id === account_id);

  // Refresh if not found
  if (!acct || !acct.token){
    try {
      const auth = await wsAuthorize(s.access_token, env.CLIENT_ID);
      const fresh = (auth.account_list || []).map(normalise).filter(a => a.account_id);
      await saveSession(env, s._sid, { ...s, accounts: fresh });
      acct = fresh.find(a => a.account_id === account_id);
    } catch(e){ console.error("[ws/otp] refresh failed:", e.message); }
  }

  if (!acct)
    return J({ error: "account_not_found", message: `${account_id} not in session. Log out and log in again.` }, env, 404);
  if (!acct.token)
    return J({ error: "no_token", message: `No token for ${account_id}. Log out and log in again.` }, env, 500);

  const url = `${DERIV_WS_URL}?app_id=${encodeURIComponent(env.CLIENT_ID)}`;
  console.log(`[ws/otp] ${account_id}(virt=${acct.is_virtual}) → ${url}`);
  return J({ url, token: acct.token, account_id, is_virtual: acct.is_virtual }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /debug/session
// ══════════════════════════════════════════════════════════════════════
async function handleDebug(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ logged_in: false }, env);
  return J({
    logged_in:     true,
    created:       new Date(s.created_at).toISOString(),
    account_count: (s.accounts || []).length,
    accounts: (s.accounts || []).map(a => ({
      account_id:   a.account_id,
      account_type: a.account_type,
      currency:     a.currency,
      is_virtual:   a.is_virtual,
      has_token:    !!a.token,
      token_prefix: a.token ? a.token.slice(0,8) + "…" : "MISSING",
    })),
  }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /logout
// ══════════════════════════════════════════════════════════════════════
async function handleLogout(req, env){
  const s = await loadSession(req, env);
  if (s) await env.SESSION.delete("s:" + s._sid);
  return J({ ok: true }, env, 200, { "Set-Cookie": rmCookie() });
}

// ══════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env){
    const path = new URL(req.url).pathname;

    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(env) });

    // Config guard
    const miss = [];
    if (!env.SESSION?.get)  miss.push("SESSION (KV)");
    if (!env.CLIENT_ID)     miss.push("CLIENT_ID");
    if (!env.REDIRECT_URI)  miss.push("REDIRECT_URI");
    if (miss.length && path !== "/" && path !== "/health")
      return J({ error: "misconfigured", missing: miss }, env, 500);

    try {
      if (path === "/auth/start"    && req.method === "GET")  return await handleAuthStart(req, env);
      if (path === "/auth/callback" && req.method === "GET")  return await handleAuthCallback(req, env);
      if (path === "/me/session"    && req.method === "GET")  return await handleMeSession(req, env);
      if (path === "/me/accounts"   && req.method === "GET")  return await handleMeAccounts(req, env);
      if ((path === "/ws/otp" || path === "/ws/connect") && req.method === "POST")
                                                              return await handleWsOtp(req, env);
      if (path === "/logout"        && req.method === "POST") return await handleLogout(req, env);
      if (path === "/debug/session" && req.method === "GET")  return await handleDebug(req, env);

      if (path === "/" || path === "/health")
        return J({
          ok: true, service: "mambafx-backend",
          config: {
            kv:       !!(env.SESSION?.get),
            clientId: !!env.CLIENT_ID,
            redirect: env.REDIRECT_URI || null,
            spa:      env.SPA_URL      || null,
            origin:   env.ALLOWED_ORIGIN || null,
          },
        }, env);

      return J({ error: "not_found", path }, env, 404);
    } catch(e){
      return J({ error: "internal", message: String(e?.message||e), stack: String(e?.stack||"") }, env, 500);
    }
  }
};