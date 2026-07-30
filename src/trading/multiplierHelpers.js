// One multiplier instance per bot — created lazily after DOM is ready
// (makeMultiplier is defined just before the try{} boot block)
let _gridMult = null, _digMult = null, _engMult = null;
function gridMult(){ return _gridMult||(_gridMult=makeMultiplier(()=>$("gridStake"))); }
function digMult(){  return _digMult ||(_digMult =makeMultiplier(()=>$("digStake"))); }
function engMult(){  return _engMult ||(_engMult =makeMultiplier(()=>$("engStake"))); }
function gridMultStrat(){ const s=$("gridMultiplier"); return s?s.value:'flat'; }
function digMultStrat(){  const s=$("digMultiplier");  return s?s.value:'flat'; }
function engMultStrat(){  const s=$("engMultiplier");  return s?s.value:'flat'; }

// =====================================================================
// FUTURE PROJECT — reverse window exports (same producer-side pattern as
// src/trading/fiveTickSignalEngine.js, src/features/featureEngineering.js,
// and src/trading/aggressionBot.js). This module was carved out of the
// deferred Deriv trade-execution block (see MSD_FUTURE_PROJECT_PHASE1F_
// REPORT.md) -- specifically, the multiplier-helper functions, which are
// self-contained aside from these six exports. The gridWs/gridAuthed/etc.
// state declarations and the connect/message/trade functions that own
// them remain inline in index.html, untouched, exactly as before.
//
// Verified call sites in index.html (outside this section) that require
// each export:
//   - gridMult, gridMultStrat : called from gridPlaceTrade (still inline)
//     and from the shared multiplier-record callback near the bottom of
//     the main script.
//   - digMult, digMultStrat   : called from the (not yet extracted) digit-
//     trading stake calculation and the shared multiplier-record callback.
//   - engMult, engMultStrat   : called from the (not yet extracted) 5-tick-
//     engine-adjacent auto-fire stake calculation and the shared
//     multiplier-record callback.
// All of these remaining call sites are themselves inside classic-script
// functions that only run at actual trade-firing time, long after this
// module has finished loading, so there is no execution-order risk.
//
// _gridMult/_digMult/_engMult (the private lazy-singleton state) have
// zero references outside this section and are not exported.
// =====================================================================
window.gridMult = gridMult;
window.digMult = digMult;
window.engMult = engMult;
window.gridMultStrat = gridMultStrat;
window.digMultStrat = digMultStrat;
window.engMultStrat = engMultStrat;
