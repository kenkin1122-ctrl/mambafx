/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 *
 * ARCHITECTURE (per Deriv docs):
 * ─────────────────────────────────────────────────────────────────────
 * 1. OAuth PKCE gives us an ACCESS TOKEN for the user's primary account.
 *
 * 2. We immediately call WS authorize with that token. The response
 *    msg.authorize.account_list contains ALL linked accounts, each with:
 *    { loginid, token, currency, is_virtual, ... }
 *    The `token` field on each entry is an API TOKEN for that account —
 *    exactly the token from "Profile → API Tokens" in the Deriv dashboard.
 *
 * 3. We store every per-account token in KV under the session.
 *
 * 4. When the browser wants a WS for account X:
 *    - POST /ws/otp { account_id: "DOT91449066" }
 *    - We look up that account's token from the session
 *    - Return { url: "wss://ws.derivws.com/websockets/v3?app_id=X", token: "a1-xxx" }
 *    - Browser opens WS, sends { authorize: token } — now authorised for X
 *    - Send { balance:1, subscribe:1 } → real-time balance for X
 *
 * 5. Virtual (demo) accounts have loginid starting with "VR" (e.g. VRTC...).
 *    Their token works the same way — authorize → balance → trade.
 *    No special handling needed, no REST OTP endpoint involved.
 *
 * DEBUG: GET /debug/session shows the raw session (minus tokens, for security).
 *        Use after login to verify both accounts are discovered.
 *
 * Routes:
 *   GET  /auth/start        → PKCE redirect to Deriv login
 *   GET  /auth/callback     → exchange code → WS authorize → store all
 *                             account tokens → redirect to SPA
 *   GET  /me/session        → { logged_in }
 *   GET  /me/accounts       → all accounts (from session, no tokens exposed)
 *   POST /ws/otp            → { account_id } → { url, token }
 *   POST /ws/connect        → alias for /ws/otp
 *   POST /logout            → clear session
 *   GET  /debug/session     → session contents (no tokens) for troubleshooting
 */

const DERIV_AUTH_URL  = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_WS_BASE   = "wss://ws.derivws.com/websockets/v3";

const SESSION_COOKIE  = "mfx_session";
const SESSION_TTL     = 60 * 60 * 8;   // 8 hours
const PKCE_TTL        = 60 * 10;       // 10 minutes

// ── CORS ──────────────────────────────────────────────────────────────
function corsH(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenlin1122-ctrl.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods":     "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":     "Content-Type",
    "Vary": "Origin",
  };
}
const J = (data, env, status=200, extra={}) =>
  new Response(JSON.stringify(data,null,2), {
    status,
    headers: { ...corsH(env), "Content-Type":"application/json", ...extra },
  });

// ── Cookies ───────────────────────────────────────────────────────────
const mkCookie = (id, age) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
const rmCookie = ()        => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
function getCookie(req, name){
  for (const p of (req.headers.get("Cookie")||"").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i > -1 && p.slice(0,i) === name) return p.slice(i+1);
  }
  return null;
}

// ── Crypto helpers ────────────────────────────────────────────────────
const randHex  = n => { const a=new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,"0")).join(""); };
const b64u     = buf => { let s=""; new Uint8Array(buf).forEach(b=>s+=String.fromCharCode(b)); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); };
const sha256   = async s => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// ── KV session helpers ────────────────────────────────────────────────
async function loadSession(req, env){
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get("s:"+sid);
  if (!raw) return null;
  try { return { _sid: sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}
const saveSession = (env, sid, data) =>
  env.SESSION.put("s:"+sid, JSON.stringify(data), { expirationTtl: SESSION_TTL });

// ── Deriv WS authorize ────────────────────────────────────────────────
// Sends { authorize: token } on a short-lived outbound WebSocket.
// Returns the full msg.authorize object, which includes account_list.
//
// account_list entry shape (from Deriv WS API docs):
//   {
//     loginid:             "DOT91449066",  // real
//     token:               "a1-xxxx...",   // API token for this account
//     currency:            "USD",
//     is_virtual:          0,              // 0=real, 1=virtual/demo
//     balance:             "0.10",
//     landing_company_name:"maltainvest",
//     account_type:        "trading",
//   }
//   {
//     loginid:             "VRTC1234567",  // virtual/demo
//     token:               "a1-yyyy...",
//     currency:            "USD",
//     is_virtual:          1,
//     balance:             "10000.00",
//     account_type:        "virtual",
//   }
async function wsAuthorize(token, appId){
  const wsResp = await fetch(`${DERIV_WS_BASE}?app_id=${encodeURIComponent(appId)}`, {
    headers: { "Upgrade": "websocket", "Connection": "Upgrade" },
  });
  const ws = wsResp.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed (app_id=${appId})`);
  ws.accept();
  ws.send(JSON.stringify({ authorize: token }));

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { ws.close(); } catch(_){}
      reject(new Error("authorize timeout after 10s"));
    }, 10000);

    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch(_){ return; }
      if (msg.msg_type !== "authorize") return;  // ignore ping/other
      clearTimeout(t);
      try { ws.close(); } catch(_){}
      if (msg.error) return reject(new Error(
        `Deriv authorize error [${msg.error.code}]: ${msg.error.message}`
      ));
      resolve(msg.authorize || {});
    });
    ws.addEventListener("error",  () => { clearTimeout(t); reject(new Error("WS error")); });
    ws.addEventListener("close",  () => { clearTimeout(t); reject(new Error("WS closed before authorize")); });
  });
}

// ── Normalise one account_list entry ─────────────────────────────────
// is_virtual is authoritative from Deriv's WS response.
// VR* prefix is a cross-check only.
// We NEVER trust account_type string.
function normalise(a){
  const id   = String(a.loginid || "");
  const virt = (a.is_virtual === 1 || a.is_virtual === true || /^VR/i.test(id));
  return {
    account_id:   id,
    account_type: virt ? "virtual" : "trading",
    currency:     String(a.currency || "USD"),
    is_virtual:   virt ? 1 : 0,
    token:        a.token  || null,   // per-account API token — stored in KV, never sent to browser
    balance:      a.balance != null ? Number(a.balance) : null,
  };
}

// ══════════════════════════════════════════════════════════════════════
// /auth/start — begin PKCE login
// ══════════════════════════════════════════════════════════════════════
async function handleAuthStart(req, env){
  const verifier  = randHex(48);
  const state     = randHex(16);
  const challenge = await sha256(verifier);
  await env.SESSION.put("pkce:"+state, verifier, { expirationTtl: PKCE_TTL });
  const p = new URLSearchParams({
    response_type:"code", client_id:env.CLIENT_ID,
    redirect_uri:env.REDIRECT_URI, scope:"trade",
    state, code_challenge:challenge, code_challenge_method:"S256",
  });
  return Response.redirect(DERIV_AUTH_URL+"?"+p, 302);
}

// ══════════════════════════════════════════════════════════════════════
// /auth/callback — exchange code → access_token → WS authorize → session
// ══════════════════════════════════════════════════════════════════════
async function handleAuthCallback(req, env){
  const spa  = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";
  const fail = msg => Response.redirect(`${spa}?login_error=${encodeURIComponent(msg)}`, 302);
  const u    = new URL(req.url);
  const code = u.searchParams.get("code");
  const state= u.searchParams.get("state");

  const errP = u.searchParams.get("error");
  if (errP) return fail(u.searchParams.get("error_description") || errP);
  if (!code || !state) return fail("Missing code or state from Deriv.");

  const verifier = await env.SESSION.get("pkce:"+state);
  if (!verifier) return fail("Login session expired — please try again.");
  await env.SESSION.delete("pkce:"+state);

  // ── Step 1: exchange auth code for OAuth access_token ────────────
  const form = new URLSearchParams({
    grant_type:"authorization_code", client_id:env.CLIENT_ID,
    redirect_uri:env.REDIRECT_URI, code, code_verifier:verifier,
  });
  if (env.CLIENT_SECRET) form.set("client_secret", env.CLIENT_SECRET);

  let tokenBody;
  try {
    const r = await fetch(DERIV_TOKEN_URL, {
      method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:form.toString(),
    });
    tokenBody = await r.json().catch(()=>null);
    if (!r.ok || !tokenBody?.access_token)
      return fail("Token exchange failed: " + (tokenBody?.error_description || tokenBody?.error || `HTTP ${r.status}`));
  } catch(e){ return fail("Cannot reach Deriv token endpoint."); }

  // ── Step 2: WS authorize → get ALL linked accounts with their tokens ─
  // This is the critical step. The OAuth access_token authorises the
  // primary account. msg.authorize.account_list contains every linked
  // account — both real (DOT...) and virtual (VRTC...) — each with its
  // own API token that we can use to open a dedicated WS for that account.
  let accounts = [];
  let authorizeError = null;
  try {
    const authData = await wsAuthorize(tokenBody.access_token, env.CLIENT_ID);
    const rawList  = authData.account_list || [];

    console.log(`[callback] account_list raw: ${JSON.stringify(rawList.map(a=>({
      loginid: a.loginid, is_virtual: a.is_virtual, hasToken: !!a.token, currency: a.currency
    })))}`);

    accounts = rawList.map(normalise).filter(a => a.account_id);

    if (!accounts.length){
      // account_list was empty — Deriv may have returned the current account info differently
      // Try the top-level authData fields as a single account entry
      if (authData.loginid){
        accounts = [normalise({
          loginid:    authData.loginid,
          is_virtual: authData.is_virtual || 0,
          currency:   authData.currency   || "USD",
          token:      tokenBody.access_token,  // use OAuth token as fallback
          balance:    authData.balance    || null,
        })];
        console.log(`[callback] account_list was empty, used top-level loginid: ${authData.loginid}`);
      }
    }

    console.log(`[callback] stored ${accounts.length} account(s): ${accounts.map(a=>`${a.account_id}(virt=${a.is_virtual},token=${a.token?"YES":"NO"})`).join(", ")}`);
  } catch(e){
    authorizeError = e.message;
    console.error("[callback] wsAuthorize failed:", e.message);
    // Fallback: store just the access_token so /me/accounts can retry
  }

  // ── Step 3: store session ─────────────────────────────────────────
  const sid = randHex(32);
  await saveSession(env, sid, {
    access_token:    tokenBody.access_token,
    accounts,                                 // [{ account_id, account_type, currency, is_virtual, token, balance }]
    authorize_error: authorizeError,
    created_at:      Date.now(),
  });

  return new Response(null, {
    status:  302,
    headers: { "Location": spa, "Set-Cookie": mkCookie(sid, SESSION_TTL) },
  });
}

// ══════════════════════════════════════════════════════════════════════
// /me/session
// ══════════════════════════════════════════════════════════════════════
async function handleMeSession(req, env){
  const s = await loadSession(req, env);
  return J({ logged_in: !!s }, env);
}

// ══════════════════════════════════════════════════════════════════════
// /me/accounts  — returns account list, refreshing via WS if needed
// ══════════════════════════════════════════════════════════════════════
async function handleMeAccounts(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error:"not_logged_in" }, env, 401);

  let accounts = (s.accounts || []).filter(a => a.account_id);

  // If session has no accounts (login predates this fix, or wsAuthorize failed
  // at callback time), retry wsAuthorize now and update the session.
  if (!accounts.length){
    console.log("[me/accounts] no accounts in session — retrying wsAuthorize");
    try {
      const authData = await wsAuthorize(s.access_token, env.CLIENT_ID);
      const rawList  = authData.account_list || [];
      accounts = rawList.map(normalise).filter(a => a.account_id);
      if (!accounts.length && authData.loginid){
        accounts = [normalise({
          loginid:    authData.loginid,
          is_virtual: authData.is_virtual || 0,
          currency:   authData.currency   || "USD",
          token:      s.access_token,
          balance:    authData.balance    || null,
        })];
      }
      console.log(`[me/accounts] refreshed: ${accounts.map(a=>a.account_id).join(", ")}`);
      await saveSession(env, s._sid, { ...s, accounts });
    } catch(e){
      console.error("[me/accounts] wsAuthorize retry failed:", e.message);
      return J({ error:"authorize_failed", message:e.message }, env, 502);
    }
  }

  if (!accounts.length)
    return J({ error:"no_accounts", message:"No accounts found — log out and log in again." }, env, 200);

  // Never send tokens to the browser
  return J({ data: accounts.map(({ token:_t, ...rest }) => rest) }, env);
}

// ══════════════════════════════════════════════════════════════════════
// /ws/otp  { account_id } → { url, token }
//
// Returns:
//   url   — wss://ws.derivws.com/websockets/v3?app_id=X
//   token — the per-account API token
//
// Browser flow:
//   1. ws = new WebSocket(url)
//   2. ws.onopen → ws.send({ authorize: token })
//   3. Deriv responds { msg_type:"authorize", authorize:{...} }
//      confirming connection to exactly that account
//   4. ws.send({ balance:1, subscribe:1 }) → live balance for that account
//   5. ws.send({ proposal:... }) + ws.send({ buy:... }) → trade on that account
// ══════════════════════════════════════════════════════════════════════
async function handleWsOtp(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error:"not_logged_in" }, env, 401);

  const body = await req.json().catch(()=>({}));
  const account_id = body.account_id;
  if (!account_id) return J({ error:"missing_account_id" }, env, 400);

  // Look up this account's token in the session
  let acct = (s.accounts||[]).find(a => a.account_id === account_id);

  // If not found, re-authorize to refresh the account list
  if (!acct || !acct.token){
    console.log(`[ws/otp] ${account_id} not found or no token — re-authorizing`);
    try {
      const authData = await wsAuthorize(s.access_token, env.CLIENT_ID);
      const fresh    = (authData.account_list||[]).map(normalise).filter(a=>a.account_id);
      if (!fresh.length && authData.loginid){
        fresh.push(normalise({ loginid:authData.loginid, is_virtual:authData.is_virtual||0, currency:authData.currency||"USD", token:s.access_token }));
      }
      await saveSession(env, s._sid, { ...s, accounts:fresh });
      acct = fresh.find(a => a.account_id === account_id);
      console.log(`[ws/otp] after re-auth: ${fresh.map(a=>`${a.account_id}(token=${a.token?"yes":"NO"})`).join(", ")}`);
    } catch(e){
      console.error("[ws/otp] re-authorize failed:", e.message);
      return J({ error:"authorize_failed", message:e.message }, env, 502);
    }
  }

  if (!acct)
    return J({ error:"account_not_found", message:`Account ${account_id} not in your session. Log out and log in again.` }, env, 404);

  if (!acct.token)
    return J({ error:"no_token", message:`No API token for ${account_id}. The OAuth response did not include a per-account token. Check app_id and scope in your Deriv app settings.` }, env, 502);

  // Return the WS base URL + the account-specific token.
  // The browser opens this WS and sends { authorize: token } on open.
  const wsUrl = `${DERIV_WS_BASE}?app_id=${encodeURIComponent(env.CLIENT_ID)}`;
  return J({ url: wsUrl, token: acct.token, account_id, is_virtual: acct.is_virtual }, env);
}

// ══════════════════════════════════════════════════════════════════════
// /debug/session — inspect session contents (no tokens exposed)
// Use this after login to verify both accounts were discovered.
// ══════════════════════════════════════════════════════════════════════
async function handleDebugSession(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ logged_in:false, message:"No session cookie found." }, env, 200);
  return J({
    logged_in:       true,
    session_id:      s._sid ? s._sid.slice(0,8)+"…" : "?",
    created_at:      s.created_at ? new Date(s.created_at).toISOString() : null,
    authorize_error: s.authorize_error || null,
    has_access_token: !!s.access_token,
    account_count:   (s.accounts||[]).length,
    accounts:        (s.accounts||[]).map(a => ({
      account_id:   a.account_id,
      account_type: a.account_type,
      currency:     a.currency,
      is_virtual:   a.is_virtual,
      has_token:    !!a.token,
      balance:      a.balance,
    })),
  }, env);
}

// ══════════════════════════════════════════════════════════════════════
// /logout
// ══════════════════════════════════════════════════════════════════════
async function handleLogout(req, env){
  const s = await loadSession(req, env);
  if (s) await env.SESSION.delete("s:"+s._sid);
  return J({ ok:true }, env, 200, { "Set-Cookie":rmCookie() });
}

// ══════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env){
    const path = new URL(req.url).pathname;

    if (req.method === "OPTIONS")
      return new Response(null, { status:204, headers:corsH(env) });

    const missing = [];
    if (!env.SESSION?.get) missing.push("SESSION (KV binding)");
    if (!env.CLIENT_ID)    missing.push("CLIENT_ID (secret)");
    if (!env.REDIRECT_URI) missing.push("REDIRECT_URI (secret)");
    if (missing.length && path !== "/" && path !== "/health")
      return J({ error:"misconfigured", missing }, env, 500);

    try {
      if (path==="/auth/start"                                 && req.method==="GET")  return await handleAuthStart(req,env);
      if (path==="/auth/callback"                              && req.method==="GET")  return await handleAuthCallback(req,env);
      if (path==="/me/session"                                 && req.method==="GET")  return await handleMeSession(req,env);
      if (path==="/me/accounts"                                && req.method==="GET")  return await handleMeAccounts(req,env);
      if ((path==="/ws/otp"||path==="/ws/connect")             && req.method==="POST") return await handleWsOtp(req,env);
      if (path==="/logout"                                     && req.method==="POST") return await handleLogout(req,env);
      if (path==="/debug/session"                              && req.method==="GET")  return await handleDebugSession(req,env);
      if (path==="/" || path==="/health")
        return J({
          ok:true, service:"mambafx-backend",
          config:{
            kv:       !!(env.SESSION?.get),
            clientId: !!env.CLIENT_ID,
            redirect: !!env.REDIRECT_URI,
            secret:   !!env.CLIENT_SECRET,
            spa:      env.SPA_URL||null,
            origin:   env.ALLOWED_ORIGIN||null,
          },
        }, env);
      return J({ error:"not_found", path }, env, 404);
    } catch(e){
      return J({ error:"internal", message:String(e?.message||e), stack:String(e?.stack||"") }, env, 500);
    }
  }
};