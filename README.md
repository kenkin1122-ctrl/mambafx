# Mamba FX — Deriv OAuth backend (Cloudflare Worker)

This is the minimal backend Deriv's support told you is required. The
browser can't exchange an OAuth code for an access token, and can't call
Deriv's `accounts` / `otp` REST endpoints directly — CORS blocks both, by
Deriv's own design. This Worker does those three calls on your behalf and
returns only what the browser needs.

It does **not** do anything else — no trading logic, no storage, no
database. Mamba FX (`v100-tracker.html`) does everything else: PKCE
generation, the OAuth redirect *and* the redirect return, the WebSocket
trading connection, signals, charts — all on one page.

## Architecture (single page, no popup, no separate callback file)

```
v100-tracker.html  (hosted on GitHub Pages — this IS the redirect_uri)
    │
    │ Login with Deriv → same-tab redirect to auth.deriv.com
    ▼
Deriv login page
    │
    │ Deriv redirects back to v100-tracker.html?code=...&state=...
    ▼
v100-tracker.html (same page, reloaded)
    │  detects ?code= on load, verifies state,
    │  POSTs {code, code_verifier} to this Worker
    ▼
this Worker  (/api/token → /api/accounts → /api/otp/{id})
    │  does the three Deriv calls that require a server
    ▼
v100-tracker.html
    │  receives the access token, account list, then the OTP WebSocket URL
    ▼
new WebSocket(otpUrl)   ← opened directly by the browser, same as before
```

There is no `callback.html` in this flow anymore. An old version of this
project used a popup window + separate callback page; that's been replaced
because it required cross-origin `sessionStorage` access that browsers
don't allow. The dashboard is now its own OAuth redirect target.

**This means `v100-tracker.html` must be hosted at a real HTTPS URL** (e.g.
GitHub Pages) — Deriv cannot redirect to a local `file://` path. Opening the
file locally will not let login complete.

## What this Worker exposes

| Route                  | Method | Purpose                                            |
|-------------------------|--------|-----------------------------------------------------|
| `/api/token`             | POST   | Exchange `{code, code_verifier}` for an access token |
| `/api/accounts`          | GET    | List accounts for the logged-in user (needs `Authorization: Bearer <token>`) |
| `/api/otp/{accountId}`   | POST   | Get the one-time trading WebSocket URL for an account (needs `Authorization: Bearer <token>`) |

## 1. Install Wrangler (Cloudflare's CLI)

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account
(free, no card required for the Workers free tier).

## 2. Set the required secrets

From inside this folder:

```bash
wrangler secret put DERIV_APP_ID
# paste: 33BoT5hHIzs1muGu7qhww

wrangler secret put DERIV_REDIRECT_URI
# paste the exact URL where you host v100-tracker.html, e.g.:
# https://kenkin1122-ctrl.github.io/mambafx/v100-tracker.html
```

This **must match exactly** — scheme, host, path, and trailing slash — both
here and in:
- Deriv's dashboard (Application manager → your app → redirect URL)
- the `DERIV_REDIRECT_URI` constant near the top of the
  `// DERIV TRADE EXECUTION` section inside `v100-tracker.html`

**Only if** Deriv's dashboard issued your `mambafx` app a `client_secret`
(check Dashboard → Applications → Application manager → your app):

```bash
wrangler secret put DERIV_CLIENT_SECRET
# paste the secret, if you have one
```

If your app is public/PKCE-only (no secret shown in the dashboard), skip
this — the Worker works fine without it.

## 3. Lock down CORS once the dashboard is hosted

Edit `wrangler.jsonc` and set `ALLOWED_ORIGIN` to the exact origin
`v100-tracker.html` is served from, e.g.:

```json
"vars": { "ALLOWED_ORIGIN": "https://kenkin1122-ctrl.github.io" }
```

`"*"` works for initial testing but should be tightened once you know the
real origin, since this Worker holds the only path to your access token.

## 4. Deploy

```bash
wrangler deploy
```

Wrangler prints your Worker's URL, something like:

```
https://mamba-fx-deriv-backend.<your-subdomain>.workers.dev
```

Copy that URL — paste it into `v100-tracker.html`'s Trading Grid page, in
the **Backend URL** field, before clicking "Login with Deriv". The dashboard
saves it in `localStorage` so you only need to enter it once per browser.

## 5. Test the Worker directly (optional, before wiring up the dashboard)

```bash
curl https://mamba-fx-deriv-backend.<your-subdomain>.workers.dev/api/health
# {"ok":true,"service":"mamba-fx-deriv-backend"}
```

A `404`/CORS error here means the Worker isn't deployed correctly; a
`{"ok":true,...}` response means it's live and ready for the dashboard to
use.

## Deploying v100-tracker.html itself

Push it to the same GitHub Pages repo as the redirect target, e.g.
`mambafx/v100-tracker.html`, so it's reachable at
`https://kenkin1122-ctrl.github.io/mambafx/v100-tracker.html` — the exact
URL set as `DERIV_REDIRECT_URI` above and inside the file. `callback.html`
is no longer required; you can leave it in the repo (it now just shows a
short notice if anyone lands on it) or delete it once Deriv's dashboard
redirect URL is updated to point at `v100-tracker.html` instead.

## Security notes

- Access tokens pass through this Worker in transit but are never logged,
  stored, or written to any database — there is no database. Restarting or
  redeploying the Worker has no effect on any in-flight session.
- `DERIV_CLIENT_SECRET`, if you set one, lives only as a Cloudflare Worker
  secret (encrypted at rest, never visible in the dashboard UI after
  creation, never present in source control).
- The `code_verifier` (PKCE) is generated and held in the browser's
  `sessionStorage` only, for the same tab/origin that started the login —
  this Worker just relays it to Deriv in the token request body over HTTPS.
