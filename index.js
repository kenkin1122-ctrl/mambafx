/**
 * Mamba FX — Deriv OAuth backend (Cloudflare Worker)
 * =====================================================================
 * Deriv's own support response is explicit: the browser must NOT exchange
 * the authorization code for an access token, and must NOT call the
 * accounts/OTP REST endpoints directly — those calls have to come from a
 * server. This Worker is that server. It does exactly the three calls
 * Deriv listed and nothing else:
 *
 *   POST /api/token        -> POST https://auth.deriv.com/oauth2/token
 *   GET  /api/accounts      -> GET  https://api.derivws.com/trading/v1/options/accounts
 *   POST /api/otp           -> POST https://api.derivws.com/trading/v1/options/accounts/{id}/otp
 *
 * The browser (v100-tracker.html) calls THIS Worker, never Deriv's token
 * endpoint directly. The Worker holds no session state — the browser still
 * holds its own PKCE code_verifier and posts it here for the token call;
 * the Worker just relays to Deriv and returns the result. Access tokens
 * pass through this Worker but are never logged or stored by it.
 *
 * Required secrets (set with `wrangler secret put NAME`):
 *   DERIV_APP_ID         - e.g. 33BoT5hHIzs1muGu7qhww
 *   DERIV_REDIRECT_URI    - e.g. https://kenkin1122-ctrl.github.io/mambafx/v100-tracker.html
 *                           (the dashboard is its own OAuth redirect target now —
 *                           there is no separate callback.html in the live flow)
 *   DERIV_CLIENT_SECRET   - OPTIONAL. Only set this if Deriv's dashboard issued
 *                           one for your app. PKCE alone is valid without it;
 *                           if your app is public/PKCE-only, do not set this.
 *   ALLOWED_ORIGIN        - the origin allowed to call this Worker, e.g.
 *                           https://kenkin1122-ctrl.github.io — set this to
 *                           the dashboard's real origin once it's hosted;
 *                           "*" is fine only while testing.
 */

const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const OPTIONS_REST_BASE = "https://api.derivws.com/trading/v1/options";

function corsHeaders(env, request){
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, headers){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function handleToken(request, env, headers){
  let body;
  try { body = await request.json(); } catch(_){ return json({ error: "invalid_request", message: "Expected JSON body." }, 400, headers); }
  const { code, code_verifier } = body || {};
  if (!code || !code_verifier){
    return json({ error: "invalid_request", message: "code and code_verifier are required." }, 400, headers);
  }
  if (!env.DERIV_APP_ID || !env.DERIV_REDIRECT_URI){
    return json({ error: "server_misconfigured", message: "DERIV_APP_ID / DERIV_REDIRECT_URI not set on the Worker." }, 500, headers);
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.DERIV_APP_ID,
    code,
    code_verifier,
    redirect_uri: env.DERIV_REDIRECT_URI,
  });
  if (env.DERIV_CLIENT_SECRET) form.set("client_secret", env.DERIV_CLIENT_SECRET);

  let resp, data;
  try {
    resp = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    return json({ error: "upstream_unreachable", message: "Could not reach Deriv's token endpoint.", detail: String(e) }, 502, headers);
  }
  if (!resp.ok){
    const msg = (data && (data.error_description || data.error)) || `HTTP ${resp.status}`;
    return json({ error: "token_exchange_failed", message: msg }, 400, headers);
  }
  if (!data || !data.access_token){
    return json({ error: "token_exchange_failed", message: "Deriv response did not include access_token." }, 502, headers);
  }
  // Only forward what the browser needs. expires_in lets the dashboard know
  // when to prompt for re-login; the raw token is unavoidable to forward
  // since the browser is the one that opens the WebSocket.
  return json({ access_token: data.access_token, expires_in: data.expires_in || null, token_type: data.token_type || "Bearer" }, 200, headers);
}

async function handleAccounts(request, env, headers){
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")){
    return json({ error: "missing_token", message: "Authorization: Bearer <access_token> header is required." }, 401, headers);
  }
  if (!env.DERIV_APP_ID){
    return json({ error: "server_misconfigured", message: "DERIV_APP_ID not set on the Worker." }, 500, headers);
  }
  let resp, data;
  try {
    resp = await fetch(`${OPTIONS_REST_BASE}/accounts`, {
      headers: { "Authorization": auth, "Deriv-App-ID": env.DERIV_APP_ID },
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    return json({ error: "upstream_unreachable", message: "Could not reach Deriv's accounts endpoint.", detail: String(e) }, 502, headers);
  }
  if (!resp.ok){
    const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${resp.status}`;
    return json({ error: "accounts_failed", message: msg }, resp.status, headers);
  }
  return json({ data: (data && data.data) || [] }, 200, headers);
}

async function handleOtp(request, env, headers, accountId){
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")){
    return json({ error: "missing_token", message: "Authorization: Bearer <access_token> header is required." }, 401, headers);
  }
  if (!accountId){
    return json({ error: "invalid_request", message: "accountId path segment is required: /api/otp/{accountId}" }, 400, headers);
  }
  if (!env.DERIV_APP_ID){
    return json({ error: "server_misconfigured", message: "DERIV_APP_ID not set on the Worker." }, 500, headers);
  }
  let resp, data;
  try {
    resp = await fetch(`${OPTIONS_REST_BASE}/accounts/${encodeURIComponent(accountId)}/otp`, {
      method: "POST",
      headers: { "Authorization": auth, "Deriv-App-ID": env.DERIV_APP_ID },
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    return json({ error: "upstream_unreachable", message: "Could not reach Deriv's OTP endpoint.", detail: String(e) }, 502, headers);
  }
  if (!resp.ok){
    const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${resp.status}`;
    return json({ error: "otp_failed", message: msg }, resp.status, headers);
  }
  const url = data && data.data && data.data.url;
  if (!url){
    return json({ error: "otp_failed", message: "Deriv response did not include a WebSocket URL." }, 502, headers);
  }
  // The OTP URL itself is short-lived and single-purpose (it authenticates a
  // WebSocket connection only) — safe to hand back to the browser, which is
  // exactly what Deriv's own instructions say to do in step 5.
  return json({ url }, 200, headers);
}

export default {
  async fetch(request, env, ctx){
    const headers = corsHeaders(env, request);
    if (request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/token" && request.method === "POST"){
        return await handleToken(request, env, headers);
      }
      if (path === "/api/accounts" && request.method === "GET"){
        return await handleAccounts(request, env, headers);
      }
      const otpMatch = path.match(/^\/api\/otp\/([^/]+)$/);
      if (otpMatch && request.method === "POST"){
        return await handleOtp(request, env, headers, decodeURIComponent(otpMatch[1]));
      }
      if (path === "/" || path === "/api/health"){
        return json({ ok: true, service: "mamba-fx-deriv-backend" }, 200, headers);
      }
      return json({ error: "not_found", message: `No route for ${request.method} ${path}` }, 404, headers);
    } catch (e) {
      return json({ error: "internal_error", message: String(e && e.message || e) }, 500, headers);
    }
  },
};
