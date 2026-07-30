function gridPageInit(){
  gridSet("gridMarketName", MARKETS[SYMBOL] || SYMBOL);
  renderSignalTable();
  renderGridTrades();
  if (gridPageInited) return;
  gridPageInited = true;
  gridCheckSession();
}

// ── Step 1: send the browser to the backend to start login. The backend
// does PKCE + the Deriv redirect + the code exchange entirely server-side;
// this page never generates a verifier or sees an authorization code.
function gridStartLogin(){
  window.location.assign(BACKEND_URL + "/auth/start");
}

// ── Step 2: check session and load accounts ───────────────────────────
async function gridCheckSession(){
  try {
    const resp = await fetch(BACKEND_URL + "/me/session", { credentials: "include" });
    const body = await resp.json().catch(()=>null);
    gridLoggedIn = !!(body && body.logged_in);
  } catch(e){
    gridLoggedIn = false;
    if (e instanceof TypeError)
      gridDiag(`<b>Cannot reach backend.</b> <code>${BACKEND_URL}/me/session</code> — check Worker is deployed.`, true);
    return;
  }
  if (gridLoggedIn){
    gridDiag(null);
    await gridLoadAccounts();
  } else {
    const pickBlock = $("gridAcctPickBlock"), loginBlock = $("gridLoginBlock");
    if (pickBlock) pickBlock.style.display = "none";
    if (loginBlock) loginBlock.style.display = "block";
  }
}

// On page load, check for ?login_error=... — the backend appends this if
// /auth/callback failed, then redirects here anyway so the error is visible.
function gridHandleRedirectReturn(){
  const params = new URLSearchParams(window.location.search);
  const err = params.get("login_error");
  const justLoggedIn = params.has("code") || document.referrer.includes("auth.deriv.com") || window.location.search.length === 0;
  if (err){
    showPage("grid");
    gridDiag(`<b>Login failed.</b> ${err}`, true);
    try {
      const clean = window.location.origin + window.location.pathname;
      window.history.replaceState({}, document.title, clean);
    } catch(_){}
    gridCheckSession();
    return;
  }
  // Right after landing back from Deriv, /me/session can briefly return
  // logged_in:false even though the login succeeded — the Worker's session
  // KV write hasn't finished propagating to every Cloudflare edge node yet
  // (KV is eventually-consistent, not instant, across edges). Retry with
  // backoff for a few seconds before accepting a "not logged in" result;
  // a normal (non-redirect) page load just checks once as before.
  gridCheckSessionWithRetry();
}

async function gridCheckSessionWithRetry(maxTries=5){
  const delays = [400, 800, 1500, 2500, 4000];
  for (let i = 0; i < maxTries; i++){
    await gridCheckSession();
    if (gridLoggedIn) return;
    if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
  }
  // Exhausted retries — leave whatever gridCheckSession last determined
  // (its own UI/diag handling already ran on the final attempt).
}

// ── Step 3: fetch all accounts for this session ──────────────────────
// Backend uses Deriv WS authorize to get account_list (real + virtual).
async function gridLoadAccounts(){
  gridSet("gridConnText", "fetching accounts…");
  let raw = [];
  try {
    const resp = await fetch(BACKEND_URL + "/me/accounts", { credentials: "include" });
    const body = await resp.json().catch(()=>null);
    if (!resp.ok) throw new Error((body && body.message) || `HTTP ${resp.status}`);
    if (body && body.error && body.error !== "no_accounts")
      throw new Error(body.message || "Account error — log out and back in.");
    raw = (body && body.data) || [];
    if (!raw.length) throw new Error("No accounts returned — log out and log back in.");
  } catch(e){
    gridDiag(`<b>Could not list accounts.</b> ${
      e instanceof TypeError
        ? `Cannot reach <code>${BACKEND_URL}/me/accounts</code>.`
        : `Backend: <b>${e.message||"unknown"}</b>.`
    }`, true);
    gridConnState("off");
    return;
  }

  // Normalise accounts from the backend. The backend now trusts Deriv's own
  // account_type field ("demo"/"virtual" vs "real") as authoritative, with
  // is_virtual as a secondary confirmation — no more guessing from the
  // loginid prefix here. Balance comes straight from /me/accounts, so the
  // Accounts page can show it immediately without waiting on a WS connect.
  gridAccounts = raw.map(a => {
    const demo =
      a.account_type === "demo"    ||
      a.account_type === "virtual" ||
      a.is_virtual === true        ||
      a.is_virtual === 1;
    return {
      account_id:   String(a.account_id || a.loginid || ""),
      account_type: demo ? "virtual" : "real",
      currency:     String(a.currency || "USD"),
      is_virtual:   demo ? 1 : 0,
      balance:      a.balance != null ? Number(a.balance) : null,
    };
  }).filter(a => a.account_id);

  // Pre-populate _acctData with balances from the REST response
  // so the Accounts page shows balances immediately before WS connects
  gridAccounts.forEach(a => {
    if (a.balance != null && !(_acctData[a.account_id]?.balance != null)){
      if (!_acctData[a.account_id]) _acctData[a.account_id] = { pnl:0, trades:0 };
      _acctData[a.account_id].balance  = a.balance;
      _acctData[a.account_id].currency = a.currency;
    }
  });

  gridBuildPicker();
}

// Build (or rebuild) the account picker. Real accounts first, then demo.
function gridBuildPicker(){
  const pickBlock = $("gridAcctPickBlock"), loginBlock = $("gridLoginBlock");
  if (loginBlock) loginBlock.style.display = "none";
  if (pickBlock)  pickBlock.style.display  = "block";

  const sel = $("gridAcctPick");
  if (!sel) return;

  const demoAccts = gridAccounts.filter(a => a.is_virtual === 1);
  const realAccts = gridAccounts.filter(a => a.is_virtual !== 1);
  const prev = sel.value;
  const optRow = a => `<option value="${a.account_id}">${a.account_id} · ${a.currency}${a.balance!=null?` · ${a.balance.toFixed(2)}`:''}</option>`;
  sel.innerHTML =
    (demoAccts.length ? `<optgroup label="🟢 Demo Accounts">${demoAccts.map(optRow).join("")}</optgroup>` : "") +
    (realAccts.length ? `<optgroup label="🔴 Real Accounts">${realAccts.map(optRow).join("")}</optgroup>` : "");

  // Restore previous / saved selection
  try {
    const saved = localStorage.getItem(ACCTID_KEY);
    if      (saved && gridAccounts.some(a => a.account_id === saved)) sel.value = saved;
    else if (prev  && gridAccounts.some(a => a.account_id === prev))  sel.value = prev;
  } catch(_){}

  const connBtn = $("gridConnectBtn"); if (connBtn) connBtn.disabled = false;
  gridConnState("off");
}

// Merge accounts that arrive at runtime. Only adds new ones and rebuilds.
function gridMergeAccounts(newList){
  if (!newList || !newList.length) return;
  let changed = false;
  newList.forEach(na => {
    const id = String(na.account_id || na.loginid || "");
    if (!id || gridAccounts.some(a => a.account_id === id)) return;
    const virt = na.is_virtual === 1 || na.is_virtual === true || /^VR/i.test(id);
    gridAccounts.push({ account_id: id, account_type: virt ? "virtual" : "trading", currency: String(na.currency || "USD"), is_virtual: virt ? 1 : 0 });
    changed = true;
  });
  if (changed) gridBuildPicker();
}

function gridSelectAccountFromPicker(){
  const sel = $("gridAcctPick");
  if (sel && sel.value){ try { localStorage.setItem(ACCTID_KEY, sel.value); } catch(_){} }
}

// =====================================================================
// FUTURE PROJECT — reverse window exports (same producer-side pattern as
// every other slice carved out of the deferred Deriv trade-execution
// block -- see MSD_FUTURE_PROJECT_PHASE1F/1G/1H/1I reports).
//
// Verified external call sites (outside this module's own functions):
//   - gridPageInit             : called from the page-switch handler
//                                 when the Grid page is opened.
//   - gridStartLogin           : referenced from two onclick="..." attrs
//                                 (Login with Deriv buttons).
//   - gridHandleRedirectReturn : called once from the main boot block,
//                                 after full page load.
//   - gridLoadAccounts         : called from the (not yet extracted)
//                                 Accounts-page session-refresh code.
//   - gridMergeAccounts        : called from the still-inline
//                                 gridWsSubscribeAndInit (part of the
//                                 remaining Deriv connect flow).
//   - gridSelectAccountFromPicker : referenced from an onchange="..."
//                                 attribute on the account picker.
// gridCheckSession, gridCheckSessionWithRetry, and gridBuildPicker have
// no references outside this module (they're called only by their
// sibling functions above) and are not exported.
// =====================================================================
window.gridPageInit = gridPageInit;
window.gridStartLogin = gridStartLogin;
window.gridHandleRedirectReturn = gridHandleRedirectReturn;
window.gridLoadAccounts = gridLoadAccounts;
window.gridMergeAccounts = gridMergeAccounts;
window.gridSelectAccountFromPicker = gridSelectAccountFromPicker;
