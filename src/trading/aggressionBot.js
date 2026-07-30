// AGGRESSION BOT — buy/sell aggression within the live 1-min candle
// Uses the real tick-rule classification already computed per tick (dir),
// weighted by the magnitude of each tick's price move, so a burst of large
// fast moves in one direction scores higher than the same tick-count of
// tiny wiggles. Score is signed: +100 = maximum buy aggression this
// candle, -100 = maximum sell aggression. Intensity compares this
// candle's total tick movement against the rolling average of the last
// 10 completed candles, to separate "genuinely forceful" from "just
// directional but quiet."
// =====================================================================
const AGG_TF = 60;         // 1-min candles
const AGG_HIST_MAX = 60;
const AGG_ROLL_N = 10;     // rolling window for intensity baseline
let aggCur = null, aggHistory = [], aggLastPrice = null, aggPageReady = false, aggAlerts = [];

function aggNewCandle(bucket, price){
  return { start:bucket, open:price, high:price, low:price, close:price,
           upTicks:0, downTicks:0, upMag:0, downMag:0, ticks:0 };
}

function aggOnTick(price, epoch, dir){
  const bucket = Math.floor(epoch / AGG_TF) * AGG_TF;
  const mag = aggLastPrice != null ? Math.abs(price - aggLastPrice) : 0;
  if (!aggCur){
    aggCur = aggNewCandle(bucket, price);
  } else if (bucket > aggCur.start){
    aggFinalizeCandle(aggCur);
    aggCur = aggNewCandle(bucket, price);
  }
  aggCur.high = Math.max(aggCur.high, price);
  aggCur.low  = Math.min(aggCur.low, price);
  aggCur.close = price;
  aggCur.ticks++;
  if (dir === 1){ aggCur.upTicks++; aggCur.upMag += mag; }
  else if (dir === -1){ aggCur.downTicks++; aggCur.downMag += mag; }
  aggLastPrice = price;

  if (aggPageReady && document.getElementById("page-aggression") &&
      document.getElementById("page-aggression").classList.contains("active")){
    aggRenderAll();
  }
}

function aggScoreOf(c){
  const totalTicks = c.upTicks + c.downTicks, totalMag = c.upMag + c.downMag;
  if (totalTicks === 0) return { score:0, tickImb:0, magImb:0, intensity:0, verdict:"NEUTRAL", dir:0 };
  const tickImb = (c.upTicks - c.downTicks) / totalTicks;
  const magImb  = totalMag > 0 ? (c.upMag - c.downMag) / totalMag : 0;
  const score = Math.round((0.4*tickImb + 0.6*magImb) * 100);
  const recent = aggHistory.slice(-AGG_ROLL_N);
  const avgMag = recent.length ? recent.reduce((a,h)=>a+(h.upMag+h.downMag),0)/recent.length : (totalMag || 1e-9);
  const intensity = avgMag > 0 ? totalMag / avgMag : 1;
  const dir = score > 0 ? 1 : score < 0 ? -1 : 0;
  let verdict = "NEUTRAL";
  if (Math.abs(score) >= 60 && intensity >= 1.3) verdict = dir===1 ? "STRONG BUY AGGRESSION" : "STRONG SELL AGGRESSION";
  else if (Math.abs(score) >= 35) verdict = dir===1 ? "MODERATE BUY PRESSURE" : "MODERATE SELL PRESSURE";
  else if (Math.abs(score) >= 15) verdict = dir===1 ? "MILD BUY BIAS" : "MILD SELL BIAS";
  return { score, tickImb, magImb, intensity, verdict, dir };
}

function aggFinalizeCandle(c){
  const m = aggScoreOf(c);
  aggHistory.push(Object.assign({}, c, m));
  if (aggHistory.length > AGG_HIST_MAX) aggHistory.shift();
  if (Math.abs(m.score) >= 60 && m.intensity >= 1.3){
    aggAlerts.unshift({ time: c.start, verdict: m.verdict, score: m.score });
    if (aggAlerts.length > 30) aggAlerts.pop();
  }
}

function aggPageInit(){ aggPageReady = true; aggRenderAll(); }

function aggRenderAll(){
  if (!aggCur) return;
  const live = aggScoreOf(aggCur);
  const $id = id => document.getElementById(id);
  const dirCol = live.dir===1 ? "var(--up)" : live.dir===-1 ? "var(--down)" : "var(--neutral)";
  const card = $id("aggCard"); if (card) card.style.setProperty("--sig-col", dirCol);
  const vEl = $id("aggVerdict");
  if (vEl){ vEl.textContent = (live.dir===1?"▲ ":live.dir===-1?"▼ ":"— ") + live.verdict; vEl.style.color = dirCol; }
  const stateEl = $id("aggState");
  if (stateEl) stateEl.textContent = `Live 1-min candle — ${aggCur.ticks} ticks so far`;

  const fill = $id("aggGaugeFill");
  if (fill){
    const pct = Math.max(-100, Math.min(100, live.score)), half = Math.abs(pct)/2;
    fill.style.background = pct >= 0 ? "var(--up)" : "var(--down)";
    if (pct >= 0){ fill.style.left = "50%"; fill.style.width = half + "%"; }
    else { fill.style.left = (50-half) + "%"; fill.style.width = half + "%"; }
  }
  const pctLab = $id("aggGaugePct"); if (pctLab) pctLab.textContent = (live.score>=0?"+":"") + live.score;

  const set = (id, txt, cls) => { const e=$id(id); if (e){ e.textContent = txt; if (cls) e.className = "em-val " + cls; } };
  set("aggBuyTicks", aggCur.upTicks);
  set("aggSellTicks", aggCur.downTicks);
  set("aggBuyMag", aggCur.upMag.toFixed(decimals));
  set("aggSellMag", aggCur.downMag.toFixed(decimals));
  set("aggIntensity", live.intensity.toFixed(2) + "\u00d7", live.intensity>=1.3?"warn":"neu");
  set("aggTickImb", (live.tickImb*100).toFixed(0)+"%", live.tickImb>0?"up":live.tickImb<0?"down":"neu");

  const chartCandles = aggHistory.slice(-40).map(c => ({ open:c.open, high:c.high, low:c.low, close:c.close, ticks:c.ticks }));
  const forming = { open:aggCur.open, high:aggCur.high, low:aggCur.low, close:aggCur.close, ticks:aggCur.ticks };
  if (typeof drawCandleChart === "function") drawCandleChart("aggCandleSvg", chartCandles, forming, { maxCandles:40 });

  const body = $id("aggHistBody");
  if (body){
    const rows = aggHistory.slice(-25).reverse();
    body.innerHTML = !rows.length
      ? '<tr><td colspan="7" class="sig-empty">No completed candles yet.</td></tr>'
      : rows.map(r => {
          const t = new Date(r.start*1000).toLocaleTimeString();
          const badgeCls = Math.abs(r.score)>=60 ? (r.dir===1?"b-up":"b-down") : Math.abs(r.score)>=35 ? "b-warn" : "b-neutral";
          return `<tr>
            <td class="l">${t}</td>
            <td>${r.open.toFixed(decimals)}</td>
            <td>${r.close.toFixed(decimals)}</td>
            <td class="${r.upTicks>r.downTicks?'cell-pos':'cell-mut'}">${r.upTicks}</td>
            <td class="${r.downTicks>r.upTicks?'cell-neg':'cell-mut'}">${r.downTicks}</td>
            <td class="${r.score>=0?'cell-pos':'cell-neg'}">${r.score>=0?'+':''}${r.score}</td>
            <td class="l"><span class="badge ${badgeCls}">${r.verdict}</span></td>
          </tr>`;
        }).join("");
  }

  const logBody = $id("aggAlertBody");
  if (logBody){
    logBody.innerHTML = !aggAlerts.length
      ? '<div class="empty">No strong-aggression candles yet.</div>'
      : aggAlerts.map(a => {
          const t = new Date(a.time*1000).toLocaleTimeString();
          const cls = a.score>=0 ? "up" : "down";
          return `<div class="row"><span class="t">${t}</span><span class="dir ${cls}">${a.verdict}</span><span class="pconv">score ${a.score>=0?'+':''}${a.score}</span></div>`;
        }).join("");
  }
}

function aggManualTrade(dir){
  if (typeof gridPlaceTrade === "function") gridPlaceTrade(dir, "manual-agg");
  else alert("Connect on the Trading Grid page first.");
}

// =====================================================================
// FUTURE PROJECT — reverse window exports (same producer-side pattern as
// src/trading/fiveTickSignalEngine.js and src/features/featureEngineering.js).
// This module is fully self-contained except for these three functions,
// which the classic main script calls by bare name (all guarded with
// `typeof X === "function"` -- this codebase's established convention for
// cross-scope calls -- or referenced from `onclick="..."` HTML attributes,
// which compile into handlers lazily at first click, long after this
// module has finished executing).
//
// Verified call sites in index.html (outside this section):
//   - aggOnTick     : `if (typeof aggOnTick === "function") aggOnTick(price, epoch, dir);`
//                     in the main tick handler.
//   - aggPageInit   : `if (typeof aggPageInit === "function") aggPageInit();`
//                     when the Aggression page is opened.
//   - aggManualTrade: `onclick="aggManualTrade(1)"` / `onclick="aggManualTrade(-1)"`
//                     on the manual buy/sell buttons.
//
// No new bridge entries were needed for this module's own external reads:
//   - `decimals` was already bridged read-write in Phase 1b.
//   - `drawCandleChart` is a top-level `function` declaration in the
//     classic main script, which auto-attaches to `window` in a classic
//     script -- bare-name fallthrough from this module already resolves
//     it with zero changes required (same reasoning as msdSafeMin/
//     msdSafeMax in Phase 1d).
//   - `gridPlaceTrade` (called from aggManualTrade, guarded by the same
//     typeof convention) is likewise a top-level `function` declaration
//     in the classic script (part of the still-inline Deriv trade-
//     execution block) -- already implicitly on `window`, no bridge
//     entry needed.
// =====================================================================
window.aggOnTick = aggOnTick;
window.aggPageInit = aggPageInit;
window.aggManualTrade = aggManualTrade;
