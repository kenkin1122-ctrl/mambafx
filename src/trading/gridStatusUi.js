function gridConnState(state){
  const dot = $("gridDot"), txt = $("gridConnText");
  if (dot) dot.className = "d" + (state==="on"?" on":state==="off"?" off":"");
  if (txt) txt.textContent = state==="on" ? "authorized" : state==="connecting" ? "connecting…" : "not connected";
  const connBtn = $("gridConnectBtn"), disBtn = $("gridDisconnectBtn");
  const tradeBtns = ["gridRiseBtn","gridFallBtn"];
  const ok = state === "on";
  if (connBtn) connBtn.disabled = ok || state==="connecting" || !gridLoggedIn;
  if (disBtn)  disBtn.disabled  = !ok && state!=="connecting";
  tradeBtns.forEach(b => { const el = $(b); if (el) el.disabled = !ok; });
}
// Surface connection problems IN THE PAGE, not just an alert — CORS/network
// failures from a third-party host often give no useful alert() text.
function gridDiag(html, isError){
  const box = $("gridDiag");
  if (!box) return;
  if (!html){ box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = html;
}

// =====================================================================
// FUTURE PROJECT — reverse window exports (same producer-side pattern as
// every prior slice carved out of the deferred Deriv trade-execution
// block -- see MSD_FUTURE_PROJECT_PHASE1F_REPORT.md and PHASE1G report).
// gridConnState is called (bare, unconditional) from the still-inline
// gridConnect/gridHandleMsg/gridDisconnect/gridLogout functions, at 8
// call sites. gridDiag is called (bare, unconditional) from a wider set
// of still-inline functions -- gridCheckSession, gridConnect,
// gridWsSubscribeAndInit, gridPlaceTrade, and two call sites in the
// not-yet-analyzed "Matches" trading code further down the file -- 13
// call sites total. All of these remaining callers are classic-script
// functions that only run at actual runtime events (page load, WS
// messages, trade placement), long after this module has finished
// loading, so there is no execution-order risk despite the high call
// count.
// =====================================================================
window.gridConnState = gridConnState;
window.gridDiag = gridDiag;
