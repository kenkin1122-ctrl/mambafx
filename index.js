/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 *
 * HOW DERIV OAUTH WORKS (simple token flow, not PKCE):
 * ─────────────────────────────────────────────────────
 * 1. Redirect browser to:
 *      https://oauth.deriv.com/oauth2/authorize?app_id=CLIENT_ID
 *
 * 2. Deriv shows login screen. After login, Deriv redirects to the
 *    URL registered in your Deriv app dashboard — which must be:
 *      https://mambafx-backend.kenlin1122.workers.dev/auth/callback
 *
 *    The redirect URL contains tokens directly:
 *      /auth/callback?acct1=DOT91449066&token1=a1-xxx&cur1=usd
 *                    &acct2=VRTC1234567&token2=a1-yyy&cur2=usd
 *
 * 3. /auth/callback parses all acct+token+cur pairs pairs, stores them
 *    in KV under a session ID, sets an HttpOnly cookie, then redirects
 *    the browser back to the SPA (GitHub Pages).
 *
 * 4. The SPA calls /me/session → logged_in true/false.
 *    Then /me/accounts → list of accounts (no tokens exposed).
 *    Then /ws/otp { account_id } → WS URL for that account.
 *
 * REQUIRED secrets (wrangler secret put NAME):
 *   CLIENT_ID   = 33BoT5hHIzs1muGu7qhww
 *
 * REQUIRED in wrangler.jsonc vars:
 *   SPA_URL     = https://kenlin1122-ctrl.github.io/mambafx/
 *   ALLOWED_ORIGIN = https://kenlin1122-ctrl.github.io
 *
 * REQUIRED in Deriv app dashboard:
 *   Redirect URL = https://mambafx-backend.kenlin1122.workers.dev/auth/callback
 */

const DERIV_OAUTH_URL = "https://oauth.deriv.com/oauth2/authorize";
const DERIV_WS_BASE   = "wss://ws.derivws.com/websockets/v3";

const SESSION_COOKIE  = "mfx_session";
const SESSION_TTL     = 60 * 60 * 8;   // 8 hours

// ── CORS ──────────────────────────────────────────────────────────────
function cors(env){
  return {
    "Access-Control-Allow-Origin":      env.ALLOWED_ORIGIN || "https://kenlin1122-ctrl.github.io",
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
  for (const p of (req.headers.get("Cookie") || "").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i > -1 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return null;
}

// ── Random hex ────────────────────────────────────────────────────────
const randHex = n => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
};

// ── KV session helpers ────────────────────────────────────────────────
async function loadSession(req, env){
  const sid = getCookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await env.SESSION.get("s:" + sid);
  if (!raw) return null;
  try { return { _sid: sid, ...JSON.parse(raw) }; } catch(_){ return null; }
}
const saveSession = (env, sid, data) =>
  env.SESSION.put("s:" + sid, JSON.stringify(data), { expirationTtl: SESSION_TTL });

// ── Normalise one account entry from the Deriv redirect URL ───────────
// Deriv loginid prefixes: VR* or VRTC* = virtual/demo, else = real
function normalise(loginid, token, currency){
  const id   = String(loginid || "").trim();
  const virt = /^VR/i.test(id);
  return {
    account_id:   id,
    account_type: virt ? "virtual" : "trading",
    currency:     String(currency || "USD").toUpperCase(),
    is_virtual:   virt ? 1 : 0,
    token:        String(token || ""),  // kept server-side only, never sent to browser
  };
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/start
// Redirect to Deriv OAuth. Deriv will send the browser to the
// registered redirect URL (/auth/callback) with tokens in the query.
// ══════════════════════════════════════════════════════════════════════
async function handleAuthStart(req, env){
  // Simple redirect — Deriv's token flow needs only app_id.
  // The redirect target is configured in the Deriv dashboard, not here.
  const url = `${DERIV_OAUTH_URL}?app_id=${encodeURIComponent(env.CLIENT_ID)}`;
  console.log("[auth/start] redirecting to:", url);
  return Response.redirect(url, 302);
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/callback
// Deriv redirects here with tokens in the query string:
//   ?acct1=DOT91449066&token1=a1-xxx&cur1=usd
//   &acct2=VRTC1234567&token2=a1-yyy&cur2=usd
//
// We parse all pairs, store them in a KV session, set an HttpOnly
// cookie, then redirect the browser back to the SPA.
// ══════════════════════════════════════════════════════════════════════
async function handleAuthCallback(req, env){
  const spa  = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";
  const fail = msg => Response.redirect(
    `${spa}?login_error=${encodeURIComponent(msg)}`, 302
  );

  const u = new URL(req.url);

  // Check for error from Deriv
  const errParam = u.searchParams.get("error");
  if (errParam)
    return fail(u.searchParams.get("error_description") || errParam);

  // Parse all acct+token+cur pairs pairs
  const accounts = [];
  let i = 1;
  while (true){
    const acct  = u.searchParams.get(`acct${i}`);
    const token = u.searchParams.get(`token${i}`);
    const cur   = u.searchParams.get(`cur${i}`);
    if (!acct || !token) break;
    accounts.push(normalise(acct, token, cur));
    i++;
  }

  console.log(`[callback] received ${accounts.length} account(s): ${
    accounts.map(a => `${a.account_id}(virt=${a.is_virtual},tok=${a.token?a.token.slice(0,8)+"…":"MISSING"})`).join(", ")
  }`);

  if (!accounts.length)
    return fail(
      "No accounts in the callback URL. " +
      "Make sure the redirect URL in your Deriv app dashboard is set to: " +
      "https://mambafx-backend.kenlin1122.workers.dev/auth/callback"
    );

  // Store session in KV — tokens stay server-side
  const sid = randHex(32);
  await saveSession(env, sid, {
    accounts,           // [{ account_id, account_type, currency, is_virtual, token }]
    created_at: Date.now(),
  });

  // Redirect browser back to SPA with session cookie set
  return new Response(null, {
    status:  302,
    headers: {
      "Location":   spa,
      "Set-Cookie": mkCookie(sid, SESSION_TTL),
    },
  });
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/session  →  { logged_in: true|false }
// ══════════════════════════════════════════════════════════════════════
async function handleMeSession(req, env){
  const s = await loadSession(req, env);
  return J({ logged_in: !!s }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /me/accounts  →  { data: [{ account_id, account_type, currency, is_virtual }] }
// Tokens are NEVER sent to the browser.
// ══════════════════════════════════════════════════════════════════════
async function handleMeAccounts(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  const accounts = (s.accounts || []).filter(a => a.account_id);
  if (!accounts.length)
    return J({ error: "no_accounts", message: "No accounts in session. Log out and log in again." }, env, 200);

  return J({ data: accounts.map(({ token: _, ...rest }) => rest) }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /ws/otp  { account_id }  →  { url, token }
//
// Returns the WS base URL + the account's OWN token so the browser
// can open the WS and send { authorize: token } on open.
//
// Each account has its own token from the OAuth redirect:
//   real  account token → authorizes a real-money WS session
//   demo  account token → authorizes a virtual/demo WS session
// ══════════════════════════════════════════════════════════════════════
async function handleWsOtp(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  const body       = await req.json().catch(() => ({}));
  const account_id = body.account_id;
  if (!account_id) return J({ error: "missing_account_id" }, env, 400);

  const acct = (s.accounts || []).find(a => a.account_id === account_id);
  if (!acct)
    return J({
      error:   "account_not_found",
      message: `${account_id} is not in your session. Log out and log in again.`,
    }, env, 404);

  if (!acct.token)
    return J({
      error:   "no_token",
      message: `No token stored for ${account_id}. Log out and log in again.`,
    }, env, 500);

  // Return WS URL + token. Browser will:
  //   ws = new WebSocket(url)
  //   ws.onopen → ws.send({ authorize: token })
  // This authorizes the WS for exactly this account (real or demo).
  const url = `${DERIV_WS_BASE}?app_id=${encodeURIComponent(env.CLIENT_ID)}`;
  console.log(`[ws/otp] ${account_id}(virt=${acct.is_virtual}) → token ${acct.token.slice(0,8)}…`);
  return J({ url, token: acct.token, account_id, is_virtual: acct.is_virtual }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /debug/session  →  session info (no tokens)
// ══════════════════════════════════════════════════════════════════════
async function handleDebugSession(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ logged_in: false, message: "No session cookie found." }, env, 200);
  return J({
    logged_in:     true,
    created:       s.created_at ? new Date(s.created_at).toISOString() : "?",
    account_count: (s.accounts || []).length,
    accounts:      (s.accounts || []).map(a => ({
      account_id:   a.account_id,
      account_type: a.account_type,
      currency:     a.currency,
      is_virtual:   a.is_virtual,
      has_token:    !!(a.token),
      token_prefix: a.token ? a.token.slice(0, 8) + "…" : "MISSING",
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

    // Config check — only CLIENT_ID is required (REDIRECT_URI not needed)
    if (!env.SESSION?.get && path !== "/" && path !== "/health")
      return J({ error: "misconfigured", message: "SESSION KV binding missing" }, env, 500);
    if (!env.CLIENT_ID && path !== "/" && path !== "/health")
      return J({ error: "misconfigured", message: "CLIENT_ID secret missing" }, env, 500);

    try {
      if (path === "/auth/start"    && req.method === "GET")  return await handleAuthStart(req, env);
      if (path === "/auth/callback" && req.method === "GET")  return await handleAuthCallback(req, env);
      if (path === "/me/session"    && req.method === "GET")  return await handleMeSession(req, env);
      if (path === "/me/accounts"   && req.method === "GET")  return await handleMeAccounts(req, env);
      if ((path === "/ws/otp" || path === "/ws/connect") && req.method === "POST")
                                                              return await handleWsOtp(req, env);
      if (path === "/logout"        && req.method === "POST") return await handleLogout(req, env);
      if (path === "/debug/session" && req.method === "GET")  return await handleDebugSession(req, env);

      if (path === "/" || path === "/health")
        return J({
          ok: true, service: "mambafx-backend",
          config: {
            kv:       !!(env.SESSION?.get),
            clientId: !!env.CLIENT_ID,
            spa:      env.SPA_URL || null,
            origin:   env.ALLOWED_ORIGIN || null,
          },
        }, env);

      return J({ error: "not_found", path }, env, 404);
    } catch(e){
      return J({ error: "internal", message: String(e?.message || e), stack: String(e?.stack || "") }, env, 500);
    }
  }
};
