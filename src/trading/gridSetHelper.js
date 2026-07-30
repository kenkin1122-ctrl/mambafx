function gridSet(id, txt){ const e = $(id); if (e) e.textContent = txt; }

// =====================================================================
// FUTURE PROJECT — reverse window export (same producer-side pattern as
// every other slice carved out of the deferred Deriv trade-execution
// block -- see MSD_FUTURE_PROJECT_PHASE1F/1G/1H reports). Kept as its
// own module, separate from src/trading/gridStatusUi.js (Phase 1h)
// despite the thematic overlap, so each slice stays independently
// reversible per this project's standing rule.
//
// gridSet is called (bare, unconditional) from 59 call sites across the
// file: the RFA (Risk-Free Auto) scanner, the still-inline Deriv
// connect/session/trade flow, engine and digit auto-fire status
// displays, chart indicator readouts, and OU payout statistics. All are
// classic-script functions invoked only at runtime (page load, ticks,
// clicks, WS messages) -- confirmed none execute before this module has
// finished loading, and none fall inside the frozen Phase 8 sealed
// region (lines 4361-4362, far from every one of gridSet's call sites).
// None of the already-shipped modules (mfxBot.js, dabBot.js,
// aggressionBot.js, fiveTickSignalEngine.js, featureEngineering.js,
// multiplierHelpers.js, gridStatusUi.js) reference gridSet directly.
//
// gridSet's only external read is `$` (already bridged read-only since
// Phase 1e) -- no new bridge entries were needed for this slice.
// =====================================================================
window.gridSet = gridSet;
