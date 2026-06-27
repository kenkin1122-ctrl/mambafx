/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 *
 * Account detection strategy:
 *   The REST endpoint GET /accounts mislabels accounts and may return
 *   only one account. The ONLY reliable source for all linked accounts
 *   (real + virtual) is the Deriv WebSocket authorize response:
 *
 *     ws.send({ authorize: access_token })
 *     → msg.authorize.account_list = [
 *         { loginid:"DOT91449066", is_virtual:0, currency:"USD", token:"a1-xxx" },
 *         { loginid:"VRTC1234567", is_virtual:1, currency:"USD", token:"a1-yyy" }
 *       ]
 *
 *   is_virtual from this response is the authoritative field.
 *   loginid prefix (VR*) is used as a cross-check only.
 *   account_type string from REST is NEVER used.
 *
 * Routes:
 *   GET  /auth/start      → PKCE redirect to Deriv login
 *   GET  /auth/callback   → exchange code → access_token → WS authorize
 *                           → store account_list in session → redirect SPA
 *   GET  /me/session      → { logged_in }
 *   GET  /me/accounts     → accounts from session (set at login)
 *                           fallback: re-run WS authorize to refresh
 *   POST /ws/otp          → { account_id } → { url }
 *                           Uses each account's own token from account_list
 *                           Works for BOTH real and virtual accounts
 *   POST /logout          → clear session + cookie
 */

const DERIV_AUTH_URL  = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_WS_URL    = "wss://ws.derivws.com/websockets/v3";
const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

const SESSION_COOKIE = "mfx_session";
const SESSION_TTL    = 60 * 60 * 8;  // 8 h
const PKCE_TTL       = 60 * 10;      // 10 min

// ── CORS ──────────────────────────────────────────────────────────────
function corsHeaders(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenlin1122-ctrl.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type",
    "Vary": "Origin",
  };
}
function R(data, env, status=200, extra={}){
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(env), "Content-Type":"application/json", ...extra },
  });
}

// ── Cookies ───────────────────────────────────────────────────────────
const mkCookie = (id,age) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
const rmCookie = ()       => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
function getCookie(req, name){
  for (const p of (req.headers.get("Cookie")||"").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i>-1 && p.slice(0,i)===name) return p.slice(i+1);
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────
function randHex(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function b64u(buf){ let s=""; new Uint8Array(buf).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
const sha256b64u = async s => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// ── Session (KV prefix "s:") ──────────────────────────────────────────
async function loadSession(req, env){
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get("s:"+sid);
  if (!raw) return null;
  try { return { _sid:sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}
const storeSession = (env, sid, data) =>
  env.SESSION.put("s:"+sid, JSON.stringify(data), { expirationTtl: SESSION_TTL });

// ── Deriv WebSocket authorize ──────────────────────────────────────────
// Opens a short-lived outbound WS, sends { authorize: token },
// waits for the authorize response, returns msg.authorize.
// msg.authorize.account_list contains every linked account with:
//   { loginid, is_virtual, currency, token, landing_company_name, ... }
// This is the ONLY reliable source for all accounts.
async function wsAuthorize(accessToken, appId){
  const wsResp = await fetch(`${DERIV_WS_URL}?app_id=${encodeURIComponent(appId)}`, {
    headers: { Upgrade:"websocket", Connection:"Upgrade" },
  });
  const ws = wsResp.webSocket;
  if (!ws) throw new Error("WebSocket upgrade failed — is app_id valid?");
  ws.accept();
  ws.send(JSON.stringify({ authorize: accessToken }));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch(_){}
      reject(new Error("authorize timeout after 10s"));
    }, 10000);

    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(_){ return; }
      if (msg.msg_type !== "authorize") return;
      clearTimeout(timer);
      try { ws.close(); } catch(_){}
      if (msg.error) return reject(new Error(`Deriv authorize error: ${msg.error.message||msg.error.code}`));
      resolve(msg.authorize || {});
    });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
    ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error("WS closed before authorize")); });
  });
}

// ── Normalise an account_list entry ──────────────────────────────────
// Source of truth for is_virtual: msg.authorize.account_list[n].is_virtual
// Cross-check: loginid prefix "VR" means virtual
// NEVER trust account_type string from REST
function normaliseAccount(a){
  const loginid    = String(a.loginid || "");
  const isVirtual  = (a.is_virtual === 1 || a.is_virtual === true || /^VR/i.test(loginid));
  return {
    account_id:   loginid,
    account_type: isVirtual ? "virtual" : "trading",   // "virtual"=demo, "trading"=real
    currency:     a.currency || "USD",
    is_virtual:   isVirtual ? 1 : 0,
    token:        a.token || null,   // per-account WS token (stored in session, never sent to browser)
  };
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/start
// ══════════════════════════════════════════════════════════════════════
async function handleAuthStart(req, env){
  const verifier  = randHex(48);
  const state     = randHex(16);
  const challenge = await sha256b64u(verifier);
  await env.SESSION.put("pkce:"+state, verifier, { expirationTtl: PKCE_TTL });
  const p = new URLSearchParams({
    response_type:"code", client_id:env.CLIENT_ID,
    redirect_uri:env.REDIRECT_URI, scope:"trade",
    state, code_challenge:challenge, code_challenge_method:"S256",
  });
  return Response.redirect(DERIV_AUTH_URL+"?"+p, 302);
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/callback
// ══════════════════════════════════════════════════════════════════════
async function handleAuthCallback(req, env){
  const spa  = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";
  const fail = m => Response.redirect(spa+"?login_error="+encodeURIComponent(m), 302);
  const u    = new URL(req.url);
  const code = u.searchParams.get("code");
  const state= u.searchParams.get("state");

  if (u.searchParams.get("error")) return fail(u.searchParams.get("error_description")||u.searchParams.get("error"));
  if (!code||!state) return fail("Missing code or state");

  const verifier = await env.SESSION.get("pkce:"+state);
  if (!verifier) return fail("Login session expired — try again");
  await env.SESSION.delete("pkce:"+state);

  // 1. Exchange code for access_token
  const form = new URLSearchParams({
    grant_type:"authorization_code", client_id:env.CLIENT_ID,
    redirect_uri:env.REDIRECT_URI, code, code_verifier:verifier,
  });
  if (env.CLIENT_SECRET) form.set("client_secret", env.CLIENT_SECRET);

  let tokenBody;
  try {
    const tr = await fetch(DERIV_TOKEN_URL, {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:form.toString(),
    });
    tokenBody = await tr.json().catch(()=>null);
    if (!tr.ok || !tokenBody?.access_token)
      return fail("Token exchange failed: "+(tokenBody?.error_description||tokenBody?.error||`HTTP ${tr.status}`));
  } catch(e){ return fail("Cannot reach Deriv token endpoint"); }

  // 2. WS authorize → get account_list with per-account tokens
  //    This gives us BOTH real (DOT...) and virtual (VRTC...) accounts.
  let accounts = [];
  try {
    const authData   = await wsAuthorize(tokenBody.access_token, env.CLIENT_ID);
    const rawList    = authData.account_list || [];
    accounts = rawList.map(normaliseAccount).filter(a => a.account_id);
    console.log(`[callback] account_list: ${accounts.map(a=>`${a.account_id}(virtual=${a.is_virtual},token=${a.token?"yes":"NO"})`).join(", ")}`);
  } catch(e){
    console.error("[callback] wsAuthorize failed:", e.message, "— proceeding without account list");
    // Non-fatal: /me/accounts will retry via wsAuthorize
  }

  // 3. Store session: access_token + pre-normalised accounts
  const sid = randHex(32);
  await storeSession(env, sid, {
    access_token: tokenBody.access_token,
    accounts,     // [{ account_id, account_type, currency, is_virtual, token }]
    created_at:   Date.now(),
  });

  return new Response(null, {
    status:302,
    headers:{ Location:spa, "Set-Cookie":mkCookie(sid, SESSION_TTL) },
  });
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/session
// ══════════════════════════════════════════════════════════════════════
async function handleMeSession(req, env){
  const s = await loadSession(req, env);
  return R({ logged_in: !!s }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/accounts
// Returns accounts from session (populated at login via WS authorize).
// If session has no accounts (old session), re-runs WS authorize and
// updates the session in place.
// ══════════════════════════════════════════════════════════════════════
async function handleMeAccounts(req, env){
  const s = await loadSession(req, env);
  if (!s) return R({ error:"not_logged_in" }, env, 401);

  let accounts = (s.accounts || []).filter(a => a.account_id);

  // If accounts missing (old session pre-dating this fix), refresh via WS
  if (!accounts.length){
    console.log("[me/accounts] no accounts in session — re-authorizing via WS");
    try {
      const authData = await wsAuthorize(s.access_token, env.CLIENT_ID);
      accounts = (authData.account_list||[]).map(normaliseAccount).filter(a=>a.account_id);
      console.log(`[me/accounts] refreshed: ${accounts.map(a=>a.account_id).join(", ")}`);
      // Update session with fresh accounts
      await storeSession(env, s._sid, { ...s, accounts });
    } catch(e){
      console.error("[me/accounts] WS re-authorize failed:", e.message);
      return R({ error:"authorize_failed", message:e.message }, env, 502);
    }
  }

  if (!accounts.length)
    return R({ error:"no_accounts", message:"No accounts found. Log out and log in again." }, env, 200);

  // Return accounts WITHOUT tokens (tokens stay server-side)
  return R({
    data: accounts.map(({ token:_, ...rest }) => rest)
  }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /ws/otp  { account_id } → { url }
// Uses the per-account token from account_list to build an authorized
// WS URL. Works for both real and virtual accounts.
// ══════════════════════════════════════════════════════════════════════
async function handleWsOtp(req, env){
  const s = await loadSession(req, env);
  if (!s) return R({ error:"not_logged_in" }, env, 401);

  const { account_id } = await req.json().catch(()=>({}));
  if (!account_id) return R({ error:"missing_account_id" }, env, 400);

  // Find this account's token in the session
  let acct = (s.accounts||[]).find(a => a.account_id === account_id);

  // If not found (old session), re-authorize to refresh
  if (!acct){
    console.log(`[ws/otp] ${account_id} not in session — re-authorizing`);
    try {
      const authData = await wsAuthorize(s.access_token, env.CLIENT_ID);
      const fresh    = (authData.account_list||[]).map(normaliseAccount).filter(a=>a.account_id);
      await storeSession(env, s._sid, { ...s, accounts:fresh });
      acct = fresh.find(a => a.account_id === account_id);
    } catch(e){
      console.error("[ws/otp] re-authorize failed:", e.message);
    }
  }

  // Strategy A: use per-account token from account_list (works for real + virtual)
  if (acct?.token){
    // Deriv WS URL with per-account token. The browser opens this WS and
    // the token authorizes it for exactly this account.
    const url = `${DERIV_WS_URL}?app_id=${encodeURIComponent(env.CLIENT_ID)}`;
    return R({ url, token: acct.token }, env);
  }

  // Strategy B: fall back to REST OTP (works for real accounts, may fail for virtual)
  console.log(`[ws/otp] no token for ${account_id} — trying REST OTP fallback`);
  try {
    const r = await fetch(
      `${DERIV_REST_BASE}/accounts/${encodeURIComponent(account_id)}/otp`,
      {
        method:"POST",
        headers:{
          "Authorization":`Bearer ${s.access_token}`,
          "Deriv-App-ID": env.CLIENT_ID,
          "Content-Type": "application/json",
        },
      }
    );
    const body = await r.json().catch(()=>null);
    if (r.ok && body?.data?.url) return R({ url:body.data.url, token:null }, env);
    const msg = body?.errors?.[0]?.message || `HTTP ${r.status}`;
    return R({ error:"otp_failed", message:msg, account_id }, env, r.status);
  } catch(e){
    return R({ error:"upstream_unreachable", message:"Cannot reach Deriv" }, env, 502);
  }
}

// ══════════════════════════════════════════════════════════════════════
// POST /logout
// ══════════════════════════════════════════════════════════════════════
async function handleLogout(req, env){
  const s = await loadSession(req, env);
  if (s) await env.SESSION.delete("s:"+s._sid);
  return R({ ok:true }, env, 200, { "Set-Cookie":rmCookie() });
}

// ══════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env){
    const path = new URL(req.url).pathname;

    if (req.method === "OPTIONS")
      return new Response(null, { status:204, headers:corsHeaders(env) });

    const miss = [];
    if (!env.SESSION?.get) miss.push("SESSION (KV binding)");
    if (!env.CLIENT_ID)    miss.push("CLIENT_ID (secret)");
    if (!env.REDIRECT_URI) miss.push("REDIRECT_URI (secret)");
    if (miss.length && path!=="/" && path!=="/health")
      return R({ error:"misconfigured", missing:miss }, env, 500);

    try {
      if (path==="/auth/start"    && req.method==="GET")  return await handleAuthStart(req, env);
      if (path==="/auth/callback" && req.method==="GET")  return await handleAuthCallback(req, env);
      if (path==="/me/session"    && req.method==="GET")  return await handleMeSession(req, env);
      if (path==="/me/accounts"   && req.method==="GET")  return await handleMeAccounts(req, env);
      if ((path==="/ws/otp"||path==="/ws/connect") && req.method==="POST") return await handleWsOtp(req, env);
      if (path==="/logout"        && req.method==="POST") return await handleLogout(req, env);
      if (path==="/" || path==="/health")
        return R({ ok:true, service:"mambafx-backend", config:{
          kv:      !!(env.SESSION?.get),
          clientId: !!env.CLIENT_ID,
          redirect: !!env.REDIRECT_URI,
          spa:      env.SPA_URL||null,
          origin:   env.ALLOWED_ORIGIN||null,
        }}, env);
      return R({ error:"not_found" }, env, 404);
    } catch(e){
      return R({ error:"internal", message:String(e?.message||e), stack:String(e?.stack||"") }, env, 500);
    }
  }
};
