/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 *
 * Flow (as specified):
 *   1. GET  /me/accounts          → GET /trading/v1/options/accounts
 *                                    Returns BOTH real and demo accounts
 *   2. POST /ws/otp {account_id}  → POST /accounts/{id}/otp
 *                                    Returns WS URL for that account
 *                                    (/ws/demo or /ws/real depending on account)
 *   3. Browser opens WS URL, sends {balance:1, subscribe:1} for live updates
 *   4. Browser places trades via proposal → buy on same WS
 */

const DERIV_API    = "https://api.derivws.com/trading/v1/options";
const DERIV_AUTH   = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN  = "https://auth.deriv.com/oauth2/token";
const SESSION_COOKIE     = "mfx_session";
const SESSION_TTL        = 60 * 60 * 8;   // 8 hours
const PKCE_TTL           = 60 * 10;        // 10 min

// ── CORS ─────────────────────────────────────────────────────────────
function cors(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenlin1122-ctrl.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type",
    "Vary": "Origin",
  };
}
const respond = (data, env, status=200, extra={}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(env), "Content-Type": "application/json", ...extra },
  });

// ── Cookie helpers ────────────────────────────────────────────────────
const setCookie  = (id, age) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
const clearCookie = ()       => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
function readCookie(req, name){
  for (const p of (req.headers.get("Cookie")||"").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i > -1 && p.slice(0,i) === name) return p.slice(i+1);
  }
  return null;
}

// ── Misc helpers ──────────────────────────────────────────────────────
const randHex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,"0")).join(""); };
const b64url  = buf => { let s=""; new Uint8Array(buf).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); };
const sha256  = async s => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// ── Session KV ───────────────────────────────────────────────────────
async function getSession(req, env){
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get(`s:${sid}`);
  if (!raw) return null;
  try { return { _sid: sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}
const saveSession = (env, sid, data) =>
  env.SESSION.put(`s:${sid}`, JSON.stringify(data), { expirationTtl: SESSION_TTL });

// ── Deriv REST helper ─────────────────────────────────────────────────
async function derivRest(method, path, env_or_token, body=null){
  const token = typeof env_or_token === "string" ? env_or_token : env_or_token;
  const r = await fetch(`${DERIV_API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Deriv-App-ID":  "APP_ID_PLACEHOLDER",  // replaced at call time
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ok: r.ok, body: await r.json().catch(()=>null) };
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/start  — redirect to Deriv login
// ══════════════════════════════════════════════════════════════════════
async function authStart(req, env){
  const verifier  = randHex(48);
  const state     = randHex(16);
  const challenge = await sha256(verifier);
  await env.SESSION.put(`pkce:${state}`, verifier, { expirationTtl: PKCE_TTL });
  const p = new URLSearchParams({
    response_type: "code",
    client_id:     env.CLIENT_ID,
    redirect_uri:  env.REDIRECT_URI,
    scope:         "trade",
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
  });
  return Response.redirect(`${DERIV_AUTH}?${p}`, 302);
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/callback  — exchange code for token, save session
// ══════════════════════════════════════════════════════════════════════
async function authCallback(req, env){
  const spa  = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";
  const fail = msg => Response.redirect(`${spa}?login_error=${encodeURIComponent(msg)}`, 302);
  const u    = new URL(req.url);
  const code = u.searchParams.get("code");
  const state= u.searchParams.get("state");
  if (u.searchParams.get("error")) return fail(u.searchParams.get("error_description") || u.searchParams.get("error"));
  if (!code || !state)             return fail("Missing code or state");

  const verifier = await env.SESSION.get(`pkce:${state}`);
  if (!verifier) return fail("Login session expired — try again");
  await env.SESSION.delete(`pkce:${state}`);

  // Exchange code for access_token
  const form = new URLSearchParams({
    grant_type:    "authorization_code",
    client_id:     env.CLIENT_ID,
    redirect_uri:  env.REDIRECT_URI,
    code,
    code_verifier: verifier,
  });
  if (env.CLIENT_SECRET) form.set("client_secret", env.CLIENT_SECRET);

  const tr = await fetch(DERIV_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }).catch(()=>null);

  if (!tr || !tr.ok) return fail("Token exchange failed");
  const tb = await tr.json().catch(()=>null);
  if (!tb?.access_token) return fail("No access_token in response");

  const sid = randHex(32);
  await saveSession(env, sid, { access_token: tb.access_token, created: Date.now() });

  return new Response(null, {
    status: 302,
    headers: { Location: spa, "Set-Cookie": setCookie(sid, SESSION_TTL) },
  });
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/session
// ══════════════════════════════════════════════════════════════════════
async function meSession(req, env){
  const s = await getSession(req, env);
  return respond({ logged_in: !!s }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/accounts
// Calls Deriv REST GET /accounts — returns BOTH real and demo accounts.
// Response shape from Deriv:
//   { data: [
//     { account_id:"DOT91449066", account_type:"real",  currency:"USD", balance:"0.10", status:"active" },
//     { account_id:"VRTC1234567", account_type:"demo",  currency:"USD", balance:"10000.00", status:"active" }
//   ]}
// We normalise and return is_virtual flag.
// ══════════════════════════════════════════════════════════════════════
async function meAccounts(req, env){
  const s = await getSession(req, env);
  if (!s) return respond({ error: "not_logged_in" }, env, 401);

  const r = await fetch(`${DERIV_API}/accounts`, {
    headers: {
      "Authorization": `Bearer ${s.access_token}`,
      "Deriv-App-ID":  env.CLIENT_ID,
    },
  }).catch(()=>null);

  if (!r) return respond({ error: "upstream_unreachable" }, env, 502);

  const body = await r.json().catch(()=>null);

  if (!r.ok){
    const msg = body?.errors?.[0]?.message || body?.error || `HTTP ${r.status}`;
    return respond({ error: "deriv_error", message: msg }, env, r.status);
  }

  // Normalise: Deriv returns account_type "real" or "demo"
  const raw = body?.data || [];
  const accounts = raw.map(a => {
    const id      = String(a.account_id || a.loginid || "");
    const isDemo  = (a.account_type === "demo") || /^VR/i.test(id);
    return {
      account_id:   id,
      account_type: isDemo ? "virtual" : "trading",
      currency:     a.currency || "USD",
      is_virtual:   isDemo ? 1 : 0,
      balance:      a.balance != null ? Number(a.balance) : null,
      status:       a.status || "active",
    };
  }).filter(a => a.account_id && a.status === "active");

  if (!accounts.length)
    return respond({ error: "no_accounts", message: "No active accounts found. Log out and log in again." }, env, 200);

  return respond({ data: accounts }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /ws/otp  { account_id }  →  { url }
// Calls Deriv REST POST /accounts/{id}/otp to get a one-time WS URL.
// Deriv returns either .../ws/real or .../ws/demo depending on account.
// ══════════════════════════════════════════════════════════════════════
async function wsOtp(req, env){
  const s = await getSession(req, env);
  if (!s) return respond({ error: "not_logged_in" }, env, 401);

  const { account_id } = await req.json().catch(()=>({}));
  if (!account_id) return respond({ error: "missing_account_id" }, env, 400);

  const r = await fetch(
    `${DERIV_API}/accounts/${encodeURIComponent(account_id)}/otp`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${s.access_token}`,
        "Deriv-App-ID":  env.CLIENT_ID,
        "Content-Type":  "application/json",
      },
    }
  ).catch(()=>null);

  if (!r) return respond({ error: "upstream_unreachable" }, env, 502);

  const body = await r.json().catch(()=>null);

  if (!r.ok){
    const msg = body?.errors?.[0]?.message || body?.error || `HTTP ${r.status}`;
    return respond({ error: "otp_failed", message: msg, account_id }, env, r.status);
  }

  const url = body?.data?.url;
  if (!url) return respond({ error: "no_url", message: "Deriv OTP response had no URL" }, env, 502);

  return respond({ url }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /logout
// ══════════════════════════════════════════════════════════════════════
async function logout(req, env){
  const s = await getSession(req, env);
  if (s) await env.SESSION.delete(`s:${s._sid}`);
  return respond({ ok: true }, env, 200, { "Set-Cookie": clearCookie() });
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
    const missing = [];
    if (!env.SESSION?.get)  missing.push("SESSION (KV)");
    if (!env.CLIENT_ID)     missing.push("CLIENT_ID");
    if (!env.REDIRECT_URI)  missing.push("REDIRECT_URI");
    if (missing.length && path !== "/" && path !== "/health")
      return respond({ error: "misconfigured", missing }, env, 500);

    try {
      if (path === "/auth/start"    && req.method === "GET")  return await authStart(req, env);
      if (path === "/auth/callback" && req.method === "GET")  return await authCallback(req, env);
      if (path === "/me/session"    && req.method === "GET")  return await meSession(req, env);
      if (path === "/me/accounts"   && req.method === "GET")  return await meAccounts(req, env);
      if (path === "/ws/otp"        && req.method === "POST") return await wsOtp(req, env);
      // Alias: /ws/connect also maps to wsOtp
      if (path === "/ws/connect"    && req.method === "POST") return await wsOtp(req, env);
      if (path === "/logout"        && req.method === "POST") return await logout(req, env);

      if (path === "/" || path === "/health")
        return respond({
          ok: true, service: "mambafx-backend",
          config: {
            kv:       !!(env.SESSION?.get),
            clientId: !!env.CLIENT_ID,
            redirect: !!env.REDIRECT_URI,
            secret:   !!env.CLIENT_SECRET,
            spa:      env.SPA_URL  || null,
            origin:   env.ALLOWED_ORIGIN || null,
          }
        }, env);

      return respond({ error: "not_found", path }, env, 404);
    } catch(e){
      return respond({ error: "internal", message: String(e?.message||e) }, env, 500);
    }
  }
};
