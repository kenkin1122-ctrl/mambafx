/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 *
 * CORRECT DERIV OAUTH FLOW (per official docs):
 * ─────────────────────────────────────────────────────────────────────
 * Deriv does NOT use standard PKCE code exchange. Instead:
 *
 * 1. Redirect user to:
 *    https://oauth.deriv.com/oauth2/authorize?app_id=YOUR_APP_ID
 *
 * 2. Deriv redirects back to your REDIRECT_URI with account tokens
 *    DIRECTLY in the query string:
 *    https://your-app.com/callback?
 *      acct1=cr799393&token1=a1-xxxx&cur1=usd&
 *      acct2=vrtc1859315&token2=a1-yyyy&cur2=usd
 *
 * 3. Parse acct1..N, token1..N, cur1..N from the query string.
 *    Real accounts: CR* or DOT* prefix
 *    Virtual/demo:  VRTC* prefix
 *
 * 4. Store all account+token pairs in KV session.
 *
 * 5. For WS connection to any account:
 *    POST /ws/otp { account_id } → use that account's token as Bearer
 *    in the REST OTP call → returns authenticated WS URL
 *    OR: open wss://api.derivws.com/trading/v1/options/ws/demo (or /real)
 *        passing the token in the OTP query param.
 *
 * Key insight: each account has its OWN token from the redirect URL.
 * We use the DEMO account token for the demo OTP call and the REAL
 * account token for the real OTP call. That is why only one account
 * was showing — we were always using the PRIMARY (real) account token.
 *
 * Routes:
 *   GET  /auth/start        → redirect to Deriv OAuth
 *   GET  /auth/callback     → parse acct+token pairs from query string
 *                             → store all accounts+tokens → redirect SPA
 *   GET  /me/session        → { logged_in }
 *   GET  /me/accounts       → all accounts (no tokens exposed)
 *   POST /ws/otp            → { account_id } → { url } via REST OTP
 *   POST /logout            → clear session
 *   GET  /debug/session     → what's stored (no tokens) for debugging
 */

const DERIV_OAUTH_URL  = "https://oauth.deriv.com/oauth2/authorize";
const DERIV_OTP_BASE   = "https://api.derivws.com/trading/v1/options/accounts";

const SESSION_COOKIE   = "mfx_session";
const SESSION_TTL      = 60 * 60 * 8;   // 8 hours

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
    headers: { ...cors(env), "Content-Type":"application/json", ...extra },
  });

// ── Cookie helpers ────────────────────────────────────────────────────
const mkCookie = (id, age) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${age}`;
const rmCookie = ()        => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
function getCookie(req, name){
  for (const p of (req.headers.get("Cookie")||"").split(/;\s*/)){
    const i = p.indexOf("=");
    if (i > -1 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return null;
}

// ── Misc ──────────────────────────────────────────────────────────────
const randHex = n => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,"0")).join("");
};

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

// ── Normalise account from Deriv redirect params ───────────────────────
// acct=cr799393 OR acct=vrtc1859315 OR acct=DOT91449066
// Virtual/demo: loginid starts with VR (case-insensitive)
function normalise(loginid, token, currency){
  const id   = String(loginid || "").trim();
  const virt = /^VR/i.test(id);
  return {
    account_id:   id,
    account_type: virt ? "virtual" : "trading",
    currency:     String(currency || "USD").toUpperCase(),
    is_virtual:   virt ? 1 : 0,
    token:        String(token || ""),   // stored in KV, NEVER sent to browser
  };
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/start
// Redirect to Deriv OAuth. Deriv will redirect back to REDIRECT_URI
// with ?acct1=...&token1=...&cur1=...&acct2=...&token2=...&cur2=...
// ══════════════════════════════════════════════════════════════════════
async function handleAuthStart(req, env){
  const state = randHex(16);
  // Store state in KV for CSRF protection
  await env.SESSION.put("state:" + state, "1", { expirationTtl: 600 });
  const url = `${DERIV_OAUTH_URL}?app_id=${encodeURIComponent(env.CLIENT_ID)}&state=${state}`;
  return Response.redirect(url, 302);
}

// ══════════════════════════════════════════════════════════════════════
// GET /auth/callback
// Deriv redirects here with:
//   ?acct1=cr799393&token1=a1-xxx&cur1=usd
//   &acct2=vrtc1859315&token2=a1-yyy&cur2=usd
//   &state=...
//
// Parse all acct*/token*/cur* pairs and store in session.
// ══════════════════════════════════════════════════════════════════════
async function handleAuthCallback(req, env){
  const spa  = env.SPA_URL || "https://kenlin1122-ctrl.github.io/mambafx/";
  const fail = msg => Response.redirect(`${spa}?login_error=${encodeURIComponent(msg)}`, 302);
  const u    = new URL(req.url);

  // CSRF check
  const state = u.searchParams.get("state");
  if (state){
    const stored = await env.SESSION.get("state:" + state);
    if (!stored) return fail("Invalid state parameter — possible CSRF. Please try again.");
    await env.SESSION.delete("state:" + state);
  }

  // Check for error param
  const errParam = u.searchParams.get("error");
  if (errParam) return fail(u.searchParams.get("error_description") || errParam);

  // Parse all acct*/token*/cur* pairs
  // Deriv uses acct1, acct2, ... token1, token2, ... cur1, cur2, ...
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

  console.log(`[callback] parsed ${accounts.length} account(s): ${
    accounts.map(a => `${a.account_id}(virt=${a.is_virtual},hasTok=${!!a.token})`).join(", ")
  }`);

  if (!accounts.length)
    return fail("No accounts returned by Deriv. Check your app_id and OAuth settings.");

  const sid = randHex(32);
  await saveSession(env, sid, {
    accounts,          // [{ account_id, account_type, currency, is_virtual, token }]
    created_at: Date.now(),
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
// GET /me/accounts
// Returns all accounts — NEVER returns tokens to the browser.
// ══════════════════════════════════════════════════════════════════════
async function handleMeAccounts(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  const accounts = (s.accounts || []).filter(a => a.account_id);
  if (!accounts.length)
    return J({ error:"no_accounts", message:"No accounts in session. Log out and log in again." }, env, 200);

  return J({
    data: accounts.map(({ token:_, ...rest }) => rest)
  }, env);
}

// ══════════════════════════════════════════════════════════════════════
// POST /ws/otp  { account_id } → { url }
//
// Uses each account's OWN token (from the OAuth redirect) to call the
// REST OTP endpoint. This returns an authenticated WS URL specific to
// that account (demo URL for virtual, real URL for real accounts).
//
// Demo WS URL: wss://api.derivws.com/trading/v1/options/ws/demo?otp=...
// Real WS URL: wss://api.derivws.com/trading/v1/options/ws/real?otp=...
// ══════════════════════════════════════════════════════════════════════
async function handleWsOtp(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ error: "not_logged_in" }, env, 401);

  const body = await req.json().catch(() => ({}));
  const account_id = body.account_id;
  if (!account_id) return J({ error: "missing_account_id" }, env, 400);

  // Find this account's token
  const acct = (s.accounts || []).find(a => a.account_id === account_id);
  if (!acct)
    return J({ error:"account_not_found", message:`Account ${account_id} not in session. Log out and log in again.` }, env, 404);
  if (!acct.token)
    return J({ error:"no_token", message:`No token stored for ${account_id}.` }, env, 500);

  // Call the REST OTP endpoint using THIS account's own token
  // This is what gets the correct demo or real WS URL
  let otpResp, otpBody;
  try {
    otpResp = await fetch(`${DERIV_OTP_BASE}/${encodeURIComponent(account_id)}/otp`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${acct.token}`,
        "Deriv-App-ID":  env.CLIENT_ID,
        "Content-Type":  "application/json",
      },
    });
    otpBody = await otpResp.json().catch(() => null);
  } catch(e){
    return J({ error:"upstream_unreachable", message: String(e.message) }, env, 502);
  }

  if (!otpResp.ok){
    const msg = (otpBody?.errors?.[0]?.message) || (otpBody?.error) || `HTTP ${otpResp.status}`;
    return J({ error:"otp_failed", message: msg, account_id, status: otpResp.status }, env, otpResp.status);
  }

  const wsUrl = otpBody?.data?.url;
  if (!wsUrl)
    return J({ error:"no_url", message:"OTP response had no url field.", raw: otpBody }, env, 502);

  console.log(`[ws/otp] ${account_id}(virt=${acct.is_virtual}) → ${wsUrl.split("?")[0]}?otp=***`);
  return J({ url: wsUrl, account_id, is_virtual: acct.is_virtual }, env);
}

// ══════════════════════════════════════════════════════════════════════
// GET /debug/session — inspect session contents (no tokens)
// ══════════════════════════════════════════════════════════════════════
async function handleDebugSession(req, env){
  const s = await loadSession(req, env);
  if (!s) return J({ logged_in:false, message:"No valid session cookie." }, env, 200);
  return J({
    logged_in:    true,
    session_age:  s.created_at ? Math.round((Date.now()-s.created_at)/1000) + "s ago" : "?",
    account_count:(s.accounts||[]).length,
    accounts:     (s.accounts||[]).map(a => ({
      account_id:   a.account_id,
      account_type: a.account_type,
      currency:     a.currency,
      is_virtual:   a.is_virtual,
      has_token:    !!(a.token),
      token_prefix: a.token ? a.token.slice(0,6)+"…" : "MISSING",
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
      return new Response(null, { status:204, headers:cors(env) });

    const missing = [];
    if (!env.SESSION?.get) missing.push("SESSION (KV binding)");
    if (!env.CLIENT_ID)    missing.push("CLIENT_ID");
    if (!env.REDIRECT_URI) missing.push("REDIRECT_URI");
    if (missing.length && path !== "/" && path !== "/health")
      return J({ error:"misconfigured", missing }, env, 500);

    try {
      if (path==="/auth/start"                               && req.method==="GET")  return await handleAuthStart(req,env);
      if (path==="/auth/callback"                            && req.method==="GET")  return await handleAuthCallback(req,env);
      if (path==="/me/session"                               && req.method==="GET")  return await handleMeSession(req,env);
      if (path==="/me/accounts"                              && req.method==="GET")  return await handleMeAccounts(req,env);
      if ((path==="/ws/otp"||path==="/ws/connect")           && req.method==="POST") return await handleWsOtp(req,env);
      if (path==="/logout"                                   && req.method==="POST") return await handleLogout(req,env);
      if (path==="/debug/session"                            && req.method==="GET")  return await handleDebugSession(req,env);

      if (path==="/" || path==="/health")
        return J({
          ok: true, service: "mambafx-backend",
          config:{
            kv:       !!(env.SESSION?.get),
            clientId: !!env.CLIENT_ID,
            redirect: env.REDIRECT_URI || null,
            spa:      env.SPA_URL || null,
            origin:   env.ALLOWED_ORIGIN || null,
          },
        }, env);

      return J({ error:"not_found", path }, env, 404);
    } catch(e){
      return J({ error:"internal", message:String(e?.message||e), stack:String(e?.stack||"") }, env, 500);
    }
  }
};
