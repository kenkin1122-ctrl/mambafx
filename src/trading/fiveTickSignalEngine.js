// ── 5-TICK SIGNAL ENGINE ─────────────────────────────────────────────
// Decides whether there is enough micro-imbalance to statistically
// sustain the next 3–5 ticks in one direction before firing.
// =====================================================================
const ENG = {
  W: 14,            // rolling window for tick delta
  TH: 35,           // |TD%| threshold to break (early-burst trigger)
  EC: 55,           // exhaustion ceiling (0–100); above this, never fire
  K: 8,             // ticks per tick-candle
  HORIZON: 5,       // a "win" = a sustained 5-tick directional run
  RUN_CAP: 8,       // run length that counts as "fully stretched"
  MAXT: 600,        // tick buffer cap
  FRESH: 3,         // "just" window: condition must have flipped within this many ticks
  CLUST_MAX: 6,     // cluster must still be young (run ≤ this) to count as "early"
  ACCEL_EPS: 0.02,  // accel (aligned) must exceed this to count as "turned positive"
  TREND_W: 30,      // trend/drift window — fire only WITH the prevailing drift
  MAG_MIN: 0.85,    // magnitude-expansion floor (recent vs prior avg |tick|)
  NOISE: 0.20,      // win-eval noise floor: opposite ticks smaller than NOISE × avg|tick|
                    //   are treated as neutral (not a real reversal). 0 = strict.
  MARKOV_W: 60,     // window for online estimation of the reversible Markov chain
                    //   (short enough to register bursts, long enough for stable a,b)
  PHI_MIN: 0.03,    // min persistence (lag-1 autocorr) — only fire in momentum regimes
  PRUN_MIN: 8       // min model P(5-run) %, on the conservative lower bound, to fire
};
// Random base rate of a clean 5-consecutive run, GIVEN the directional fire tick:
// the 4 follow-up ticks must each repeat → 0.5^4 = 6.25%. This is the honest
// yardstick for "edge", not 50% (the bid-ask bounce makes runs rarer, not 50/50).
const ENG_BASE = 6.25;
let engTicks = [];          // { price, dir, mag, epoch }  dir uses zero-tick carry
let engCarryDir = 0;        // last non-zero direction (zero-tick rule)
let engPending = null;      // { dir, prices:[…], dirs:[…], left, prob }
let engStats = { fired:0, hits:0, ticksInDir:0, resolved:0 };
let engLog = [];            // { time, dir, prob, prices:[…], dirs:[…], result }
let engPageReady = false;
// early-burst freshness trackers
let engPrevTDabove = false, engPrevAccelPos = false;
let engTDbrokeAge = 999, engAccelPosAge = 999;

// Tick rule: +1 up-tick (buy-initiated), −1 down-tick (sell-initiated),
// flat ticks inherit the previous direction (Lee-Ready zero-tick rule).
function engineOnTick(price, epoch, rawDir){
  let dir = rawDir;
  if (dir === 0) dir = engCarryDir;        // zero-tick carry
  else engCarryDir = dir;
  const prev = engTicks.length ? engTicks[engTicks.length-1].price : price;
  const mag = Math.abs(price - prev);
  engTicks.push({ price, dir, mag, epoch });
  if (engTicks.length > ENG.MAXT) engTicks.shift();

  // ── Resolve an open prediction. A WIN = a sustained 5-tick run in the fired
  // direction: no MEANINGFUL reversal (flats and sub-noise ticks are tolerated)
  // AND net price progress in the fired direction over the 5 ticks. This is the
  // honest fix for runs that were broken only by a flat or a 1-cent noise tick.
  if (engPending){
    engPending.prices.push(price);
    engPending.dirs.push(rawDir);
    engPending.mags.push(Math.abs(price - prev));
    engPending.left--;
    if (engLog[0] && engLog[0].result === 'pend') engLog[0].prices = engPending.prices.slice();
    if (engPending.left <= 0){
      const d = engPending.dir;
      const dirs = engPending.dirs.slice(0, ENG.HORIZON);
      const mags = engPending.mags.slice(0, ENG.HORIZON);
      const avgMag = mags.reduce((a,b)=>a+b,0)/mags.length || 1e-9;
      const noiseFloor = ENG.NOISE * avgMag;
      // a tick is a "real reversal" only if it opposes d AND is bigger than the noise floor
      const realReversal = dirs.some((x,i) => x === -d && mags[i] > noiseFloor);
      const net = engPending.prices[Math.min(ENG.HORIZON, engPending.prices.length)-1] - engPending.prices[0];
      const win = !realReversal && Math.sign(net) === d;
      const inDir = dirs.filter(x => x === d).length;
      engStats.resolved++;
      if (win) engStats.hits++;
      engStats.ticksInDir += inDir;
      if (engLog[0] && engLog[0].result === 'pend'){
        engLog[0].result = win ? 'win' : 'loss';
        engLog[0].prices = engPending.prices.slice(0, ENG.HORIZON);
        engLog[0].dirs   = dirs;
      }
      engPending = null;
    }
  }

  const m = engineMetrics();
  const d = Math.sign(m.td);

  // ── Track freshness of the two "just turned" conditions ──────────────
  const tdAbove = Math.abs(m.tdPct) >= ENG.TH;
  if (tdAbove && !engPrevTDabove) engTDbrokeAge = 0;
  else if (tdAbove) engTDbrokeAge++;
  else engTDbrokeAge = 999;
  const accelPos = m.accelAligned > ENG.ACCEL_EPS;
  if (accelPos && !engPrevAccelPos) engAccelPosAge = 0;
  else if (accelPos) engAccelPosAge++;
  else engAccelPosAge = 999;
  engPrevTDabove = tdAbove; engPrevAccelPos = accelPos;

  // ── EARLY BURST PHASE trigger (upgraded to avoid firing into reversals) ──
  //   1) acceleration just turned positive   (fresh aligned-accel cross)
  //   2) TD% just broke threshold            (fresh imbalance cross)
  //   3) exhaustion still low                 (≤ ceiling — fresh move, no fatigue)
  //   4) first clustering appears             (a nascent run of 2–CLUST_MAX ticks)
  //   5) TREND ALIGNMENT  — drift over TREND_W agrees with d (don't fight the tape)
  //   6) PERSISTENCE REGIME — the reversible Markov chain is in a momentum regime
  //      (lag-1 autocorrelation φ ≥ PHI_MIN), NOT a bid-ask-bounce regime
  //   7) MODEL PROBABILITY — the chain's conservative P(5-run) clears PRUN_MIN
  const burstAccel = accelPos && engAccelPosAge <= ENG.FRESH;
  const burstTD    = tdAbove  && engTDbrokeAge  <= ENG.FRESH;
  const burstExh   = m.exhaustion <= ENG.EC;
  const burstClust = m.runDir === d && m.run >= 2 && m.run <= ENG.CLUST_MAX;
  const trendOK    = m.drift === d;
  const persistOK  = m.persistence >= ENG.PHI_MIN;
  const probOK     = (m.modelPLcb * 100) >= ENG.PRUN_MIN;
  const earlyBurst = d !== 0 && !engPending &&
                     burstAccel && burstTD && burstExh && burstClust && trendOK && persistOK && probOK;
  const conditionsMet = [burstTD, burstAccel, burstExh, burstClust, trendOK, persistOK, probOK].filter(Boolean).length;

  if (earlyBurst){
    engStats.fired++;
    engPending = { dir: d, prices: [price], dirs: [rawDir], mags: [mag], left: ENG.HORIZON - 1, prob: m.prob };
    engLog.unshift({ time: epoch, dir: d, prob: m.prob, prices: [price], dirs: [rawDir], result: 'pend' });
    if (engLog.length > 40) engLog.pop();
  }

  if (engPageReady && document.getElementById("page-engine").classList.contains("active")){
    renderEngine(m, { earlyBurst, conditionsMet, burstAccel, burstTD, burstExh, burstClust, trendOK, persistOK, probOK });
  }
}

// Compute all engine metrics from the tick buffer.
function engineMetrics(){
  const n = engTicks.length;
  const W = Math.min(ENG.W, n);
  const out = { td:0, tdPct:0, up:0, down:0, accel:0, accelAligned:0, exhaustion:0,
                run:0, runDir:0, vel:0, flowPct:0, prob:50,
                tdShortPct:0, drift:0, driftMag:0, magRatio:1,
                pUp:0.5, pDown:0.5, persistence:0, samples:0,
                pRunUp:0.0625, pRunDown:0.0625, pRunUpLcb:0, pRunDownLcb:0, modelP:0.0625, modelPLcb:0 };
  if (n < 4) return out;
  const win = engTicks.slice(n - W);
  // tick delta (count) + magnitude-weighted flow
  let td=0, flow=0, magSum=0;
  win.forEach(t => { td += t.dir; flow += t.dir * t.mag; magSum += t.mag; out[t.dir>0?'up':'down']++; });
  out.td = td;
  out.tdPct = (td / W) * 100;
  out.flowPct = magSum > 0 ? (flow / magSum) * 100 : 0;

  // short-window imbalance (for dual-window agreement — filters one-off spikes)
  const sw = Math.max(3, Math.round(W/3));
  const swin = engTicks.slice(n - Math.min(sw, n));
  let sTd = 0; swin.forEach(t => sTd += t.dir);
  out.tdShortPct = (sTd / swin.length) * 100;

  // medium-term DRIFT (trend regime): net displacement over the trend window.
  // Tick momentum only persists when there is a prevailing drift; firing against
  // it is what produced the immediate-reversal losses.
  const tw = Math.min(ENG.TREND_W, n);
  const driftRaw = engTicks[n-1].price - engTicks[n-tw].price;
  out.drift = Math.sign(driftRaw);
  out.driftMag = Math.abs(driftRaw);

  // magnitude expansion: recent avg |tick| vs prior avg |tick| (burst expanding?).
  // A genuine burst grows; a dying micro-move shrinks (and reverts).
  const me = Math.max(2, Math.round(W/3));
  const recM = engTicks.slice(n-me).reduce((a,t)=>a+t.mag,0)/me;
  const priM = engTicks.slice(Math.max(0,n-2*me), n-me).reduce((a,t)=>a+t.mag,0)/me || 1e-9;
  out.magRatio = recM / priM;

  // velocity (signed Δprice per tick) and acceleration (recent − prior)
  const k = Math.max(2, Math.floor(W/2));
  const seg = engTicks.slice(n - 2*k >= 0 ? n - 2*k : 0);
  const half = Math.floor(seg.length/2) || 1;
  const dpr = (a) => a.length>1 ? (a[a.length-1].price - a[0].price)/(a.length-1) : 0;
  const vRecent = dpr(seg.slice(half));
  const vPrev   = dpr(seg.slice(0, half));
  out.vel = vRecent;
  out.accel = vRecent - vPrev;
  const avgMag = magSum / W || 1e-9;
  out.accelAligned = (out.accel * Math.sign(td)) / avgMag; // >0 building in delta dir

  // current run length / direction
  let run=0, rd=0;
  for (let i=n-1; i>=0; i--){ const d=engTicks[i].dir; if (rd===0 && d!==0){ rd=d; run=1; } else if (d===rd && d!==0){ run++; } else break; }
  out.run = run; out.runDir = rd;

  // ── Exhaustion (0–100): run-stretch + magnitude decay + extension-failure
  const rs = Math.min(1, run / ENG.RUN_CAP);
  // magnitude decay across the current run (shrinking ticks = fatigue)
  let md = 0;
  if (run >= 4){
    const r = engTicks.slice(n - run).map(t => t.mag);
    const h = Math.floor(r.length/2);
    const a1 = r.slice(0,h).reduce((a,b)=>a+b,0)/h || 1e-9;
    const a2 = r.slice(h).reduce((a,b)=>a+b,0)/(r.length-h) || 0;
    md = Math.max(0, Math.min(1, (a1 - a2) / a1));
  }
  // extension failure: of last few ticks, how many failed to make a new extreme in run dir
  let ef = 0;
  if (rd !== 0){
    const chk = engTicks.slice(Math.max(0, n - 6));
    let ext = rd>0 ? -Infinity : Infinity, fails=0, tot=0;
    chk.forEach(t => { tot++; const better = rd>0 ? t.price>ext : t.price<ext; if (better) ext = t.price; else fails++; });
    ef = tot ? fails/tot : 0;
  }
  out.exhaustion = Math.round(100 * (0.34*rs + 0.30*md + 0.36*ef));

  // ── REVERSIBLE 2-STATE MARKOV MODEL of tick direction (up/down) ──────────
  // Every 2-state chain satisfies detailed balance, so this is a *reversible*
  // generator: estimating P(up|up)=a and P(down|down)=b fully specifies it, and
  // the probability of an n-tick run is exact in closed form (a^k / b^k).
  // We estimate a,b online from the recent stream with a Beta(1,1) (Laplace)
  // prior, and use a conservative lower credible bound so small samples can't
  // fool the engine.
  const mw = Math.min(ENG.MARKOV_W, n);
  const seq = engTicks.slice(n - mw).map(t => t.dir).filter(x => x !== 0); // strict moves
  let nuu=0, nud=0, ndu=0, ndd=0;
  for (let i=1; i<seq.length; i++){
    const A = seq[i-1], B = seq[i];
    if (A>0 && B>0) nuu++; else if (A>0 && B<0) nud++;
    else if (A<0 && B>0) ndu++; else if (A<0 && B<0) ndd++;
  }
  const aMean = (nuu + 1) / (nuu + nud + 2);     // P(up | up)
  const bMean = (ndd + 1) / (ndd + ndu + 2);     // P(down | down)
  const aSd = Math.sqrt(aMean*(1-aMean) / (nuu+nud+3));
  const bSd = Math.sqrt(bMean*(1-bMean) / (ndd+ndu+3));
  const aLcb = Math.max(0, aMean - 1.28*aSd);    // ~10th-percentile credible bound
  const bLcb = Math.max(0, bMean - 1.28*bSd);
  out.pUp = aMean; out.pDown = bMean;
  out.persistence = aMean + bMean - 1;           // = lag-1 autocorrelation of ±1 series
  const kRun = ENG.HORIZON - 1;                      // follow-ticks needed after the fire tick
  out.pRunUp   = Math.pow(aMean, kRun);
  out.pRunDown = Math.pow(bMean, kRun);
  out.pRunUpLcb   = Math.pow(aLcb, kRun);
  out.pRunDownLcb = Math.pow(bLcb, kRun);
  out.samples = seq.length;

  // direction-specific model probability of catching the 5-tick run
  const dd = Math.sign(out.td);
  out.modelP    = dd>0 ? out.pRunUp    : dd<0 ? out.pRunDown    : Math.max(out.pRunUp, out.pRunDown);
  out.modelPLcb = dd>0 ? out.pRunUpLcb : dd<0 ? out.pRunDownLcb : Math.max(out.pRunUpLcb, out.pRunDownLcb);
  out.prob = Math.round(out.modelP * 100);       // conviction = actual model P(run)
  return out;
}

function renderEngine(m, st){
  st = st || { conditionsMet:0, burstAccel:false, burstTD:false, burstExh:false, burstClust:false };
  const $id = id => document.getElementById(id);
  const dir = Math.sign(m.td);
  const col = dir>0 ? "var(--up)" : dir<0 ? "var(--down)" : "var(--neutral)";
  const card = $id("engSignalCard");
  // signal verdict
  let verdict, state, reason;
  if (engPending){
    state = "tracking burst — needs 5 in a row";
    verdict = (engPending.dir>0?"▲ LONG":"▼ SHORT") + " FIRED";
    const got = engPending.dirs.filter(x=>x===engPending.dir).length;
    reason = `Captured ${got}/${engPending.dirs.length} so far in the fired direction. ${engPending.left} tick(s) left — a win needs all ${ENG.HORIZON} consecutive.`;
  } else if (st.conditionsMet >= 4 && dir !== 0){
    state = "early-burst forming";
    verdict = (dir>0?"▲ LONG":"▼ SHORT") + " FORMING";
    const tags = [];
    tags.push((st.burstTD?"✓":"·")+" TD% broke");
    tags.push((st.burstAccel?"✓":"·")+" accel +");
    tags.push((st.trendOK?"✓":"·")+" trend");
    tags.push((st.persistOK?"✓":"·")+" persistence");
    tags.push((st.probOK?"✓":"·")+" P(run)");
    tags.push((st.burstExh?"✓":"·")+" low exh");
    tags.push((st.burstClust?"✓":"·")+" cluster");
    reason = tags.join("   ");
  } else {
    state = "scanning micro-structure…";
    verdict = "— NO SIGNAL";
    if (m.persistence < ENG.PHI_MIN && Math.abs(m.tdPct) >= ENG.TH) reason = `Imbalance exists but the Markov chain is in a bounce regime (persistence φ=${m.persistence.toFixed(2)} < ${ENG.PHI_MIN}) — ticks are mean-reverting, runs unlikely.`;
    else if ((m.modelPLcb*100) < ENG.PRUN_MIN && Math.abs(m.tdPct) >= ENG.TH) reason = `Model P(5-run)=${(m.modelP*100).toFixed(0)}% is below the ${ENG.PRUN_MIN}% floor — the measured continuation odds don't justify a fire.`;
    else if (m.drift !== 0 && m.drift !== dir && Math.abs(m.tdPct) >= ENG.TH) reason = `Imbalance is ${dir>0?'up':'down'} but the ${ENG.TREND_W}-tick drift is ${m.drift>0?'up':'down'} — won't fire against the tape.`;
    else if (m.exhaustion > ENG.EC) reason = `Exhaustion ${m.exhaustion} is above the ${ENG.EC} ceiling — move is tired, no fresh burst.`;
    else if (Math.abs(m.tdPct) < ENG.TH) reason = `Imbalance ${m.tdPct.toFixed(0)}% has not broken the ${ENG.TH}% threshold yet.`;
    else reason = `Waiting for a persistent momentum regime and the first cluster to confirm.`;
  }
  const pcol = engPending ? (engPending.dir>0?"var(--up)":"var(--down)") : col;
  card.style.setProperty("--sig-col", pcol);
  $id("engState").textContent = state;
  $id("engVerdict").textContent = verdict;
  $id("engVerdict").style.color = pcol;
  $id("engReason").textContent = reason;
  // burst-conviction bar (model confidence the burst is genuine — NOT the literal odds of a 5-run)
  $id("engProbPct").textContent = m.prob + "%";
  $id("engProbFill").style.width = m.prob + "%";
  $id("engProbFill").style.background = col === "var(--neutral)" ? "var(--accent)" : col;

  // metric cards
  $id("engTD").textContent = m.tdPct.toFixed(0)+"%";
  $id("engTD").className = "em-val "+(m.tdPct>0?"up":m.tdPct<0?"down":"neu");
  $id("engTDraw").textContent = m.up+"↑/"+m.down+"↓";
  setDivBar("engTDbar", m.tdPct);
  $id("engAcc").textContent = (m.accelAligned>=0?"+":"")+(m.accelAligned*100).toFixed(0);
  $id("engAcc").className = "em-val "+(m.accelAligned>0.02?"up":m.accelAligned<-0.02?"down":"neu");
  setDivBar("engAccBar", Math.max(-100,Math.min(100,m.accelAligned*100)));
  $id("engExh").textContent = m.exhaustion;
  $id("engExh").className = "em-val "+(m.exhaustion>ENG.EC?"warn":"neu");
  { const f=$id("engExhBar"); f.style.left="0"; f.style.width=m.exhaustion+"%"; f.style.background=m.exhaustion>ENG.EC?"#ffc44d":m.exhaustion>40?"var(--accent)":"var(--up)"; }
  $id("engRun").textContent = m.run;
  $id("engRun").className = "em-val "+(m.runDir>0?"up":m.runDir<0?"down":"neu");
  $id("engRunDir").textContent = m.runDir>0?"consecutive up-ticks":m.runDir<0?"consecutive down-ticks":"no active run";
  $id("engVel").textContent = m.vel.toFixed(decimals);
  $id("engVel").className = "em-val "+(m.vel>0?"up":m.vel<0?"down":"neu");
  // Persistence φ (Markov regime)
  $id("engPhi").textContent = (m.persistence>=0?"+":"")+m.persistence.toFixed(2);
  $id("engPhi").className = "em-val "+(m.persistence>=ENG.PHI_MIN?"up":m.persistence<0?"down":"neu");
  $id("engRegime").textContent = m.persistence>=ENG.PHI_MIN ? "momentum" : m.persistence<0 ? "bounce" : "neutral";
  setDivBar("engPhiBar", Math.max(-100,Math.min(100,m.persistence*100)));
  $id("engPP").textContent = `P(↑|↑)=${m.pUp.toFixed(2)} · P(↓|↓)=${m.pDown.toFixed(2)} · n=${m.samples}`;

  // accuracy panel — "win" = a clean 5-consecutive run was captured
  $id("engFired").textContent = engStats.fired;
  if (engStats.resolved>0){
    const acc = engStats.hits/engStats.resolved*100;
    $id("engAccuracy").textContent = acc.toFixed(0)+"%";
    $id("engAccuracy").className = "em-val "+(acc>ENG_BASE*1.5?"up":acc<ENG_BASE?"down":"neu");
    const edge = acc-ENG_BASE;                       // vs the true random base rate (6.25%)
    $id("engEdge").textContent = (edge>=0?"+":"")+edge.toFixed(0)+"%";
    $id("engEdge").className = "em-val "+(edge>2?"up":edge<-2?"down":"neu");
    $id("engAvgTicks").textContent = (engStats.ticksInDir/engStats.resolved).toFixed(1)+"/"+ENG.HORIZON;
    $id("engAvgTicks").className = "em-val neu";
  }

  renderEngineLog();
  drawEngLine();
  drawEngTickCandles();
}

function setDivBar(id, pct){           // pct in -100..100, bar grows from centre
  const f = document.getElementById(id); if (!f) return;
  const p = Math.max(-100, Math.min(100, pct));
  const half = Math.abs(p)/2;          // half of 100% track width
  f.style.background = p>0 ? "var(--up)" : p<0 ? "var(--down)" : "var(--neutral)";
  if (p>=0){ f.style.left="50%"; f.style.width=half+"%"; }
  else { f.style.left=(50-half)+"%"; f.style.width=half+"%"; }
}

function renderEngineLog(){
  const body = document.getElementById("engLogBody");
  if (!engLog.length){ body.innerHTML = `<div class="empty">No signals fired yet. The engine fires only at an early burst: TD% just broke, acceleration just turned positive, exhaustion still low, first cluster forming.</div>`; return; }
  body.innerHTML = engLog.map(e => {
    const t = new Date(e.time*1000).toLocaleTimeString();
    const dcls = e.dir>0?"up":"down", dtxt = e.dir>0?"▲ LONG":"▼ SHORT";
    const r = e.result==='win'?'<span class="res win">✓ WIN</span>'
            : e.result==='loss'?'<span class="res loss">✗ LOSS</span>'
            : '<span class="res pend">… tracking</span>';
    // price path P1→P2→P3→P4→P5, each price coloured by that tick's direction vs the fired side
    const prices = e.prices || [];
    let path = '<span class="path">';
    for (let i=0;i<ENG.HORIZON;i++){
      const has = i < prices.length;
      const val = has ? prices[i].toFixed(decimals) : '·····';
      let cls = 'p-pend';
      if (has && i>0){ const d = Math.sign(prices[i]-prices[i-1]); cls = d===e.dir ? 'p-good' : d===0 ? 'p-pend' : 'p-bad'; }
      else if (has && i===0){ cls = e.dir>0 ? 'p-good' : 'p-bad'; }
      path += `<span class="${cls}" title="tick ${i+1}">${val}</span>`;
      if (i<ENG.HORIZON-1) path += '<span class="p-sep">→</span>';
    }
    path += '</span>';
    return `<div class="row"><span class="t">${t}</span><span class="dir ${dcls}">${dtxt}</span><span class="pconv">c=${e.prob}%</span>${path}${r}</div>`;
  }).join("");
}

// Continuous tick line, segments recoloured on a run of RUN_LENGTH ticks
function drawEngLine(){
  const svg = document.getElementById("engLine"); if (!svg) return;
  const W=1000,H=300,padX=12,padY=20;
  const data = engTicks.slice(-Math.min(engTicks.length, 180));
  if (data.length < 2){ svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="#475569" font-size="13" text-anchor="middle" font-family="monospace">collecting ticks…</text>`; return; }
  const prices = data.map(t=>t.price);
  let min=msdSafeMin(prices), max=msdSafeMax(prices); if(min===max){min-=1;max+=1;}
  const rng=max-min, stepX=(W-padX*2)/(data.length-1);
  const x=i=>padX+i*stepX, y=p=>padY+(H-padY*2)*(1-(p-min)/rng);
  // flag points inside a run of RUN_LENGTH
  const colorAt=new Array(data.length).fill(0); let len=0,d=0;
  for(let i=0;i<data.length;i++){ const td=data[i].dir;
    if(td!==0&&td===d)len++; else if(td!==0){d=td;len=1;} else {d=0;len=0;}
    if(len>=RUN_LENGTH){ for(let k=0;k<RUN_LENGTH&&i-k>=0;k++) colorAt[i-k]=d; } }
  let out="";
  // gridlines + axis
  for(let i=0;i<=3;i++){ const gy=padY+(H-padY*2)/3*i, gp=max-rng/3*i;
    out+=`<line x1="${padX}" y1="${gy.toFixed(1)}" x2="${W-padX}" y2="${gy.toFixed(1)}" stroke="#161d2b" stroke-width="1"/>`;
    out+=`<text x="${W-padX-2}" y="${(gy-3).toFixed(1)}" fill="#475569" font-size="9" text-anchor="end" font-family="monospace">${gp.toFixed(decimals)}</text>`; }
  const colName=c=>c===1?"var(--up)":c===-1?"var(--down)":"var(--neutral)";
  for(let i=1;i<data.length;i++){
    const c = (colorAt[i]!==0 && (colorAt[i]===colorAt[i-1])) ? colorAt[i] : 0;
    out+=`<line x1="${x(i-1).toFixed(1)}" y1="${y(data[i-1].price).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(data[i].price).toFixed(1)}" stroke="${colName(c)}" stroke-width="${c?2:1.3}" stroke-linecap="round" opacity="${c?1:0.75}"/>`;
  }
  // last price dot
  const li=data.length-1;
  out+=`<circle cx="${x(li).toFixed(1)}" cy="${y(data[li].price).toFixed(1)}" r="3" fill="${colName(colorAt[li])}"/>`;
  svg.innerHTML=out;
}

// Tick candles: aggregate every K ticks into one OHLC candle
function drawEngTickCandles(){
  const svg = document.getElementById("engTickCandles"); if (!svg) return;
  const W=1000,H=300,padT=12,padB=12,padL=8,padR=58;
  const K=ENG.K;
  const candles=[];
  for(let i=0;i<engTicks.length;i+=K){
    const slice=engTicks.slice(i,i+K); if(slice.length<2&&candles.length) break;
    const ps=slice.map(t=>t.price);
    candles.push({ o:ps[0], h:msdSafeMax(ps), l:msdSafeMin(ps), c:ps[ps.length-1], n:slice.length });
  }
  const vis=candles.slice(-Math.min(candles.length,60));
  if(vis.length<2){ svg.innerHTML=`<text x="${W/2}" y="${H/2}" fill="#475569" font-size="13" text-anchor="middle" font-family="monospace">building tick candles…</text>`; return; }
  let hi=msdSafeMax(vis.map(c=>c.h)), lo=msdSafeMin(vis.map(c=>c.l)); if(hi===lo){hi+=1;lo-=1;}
  const pd=(hi-lo)*0.08; hi+=pd; lo-=pd; const rng=hi-lo;
  const y=p=>padT+(H-padT-padB)*(1-(p-lo)/rng);
  const slot=(W-padL-padR)/vis.length, bw=Math.max(1.5,Math.min(slot*0.66,16));
  let out="";
  for(let i=0;i<=4;i++){ const gy=padT+(H-padT-padB)/4*i, gp=hi-rng/4*i;
    out+=`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W-padR}" y2="${gy.toFixed(1)}" stroke="#161d2b" stroke-width="1"/>`;
    out+=`<text x="${W-padR+4}" y="${(gy+3).toFixed(1)}" fill="#475569" font-size="9" font-family="monospace">${gp.toFixed(decimals)}</text>`; }
  vis.forEach((c,i)=>{
    const cx=padL+slot*i+slot/2, up=c.c>=c.o, col=up?"var(--up)":"var(--down)";
    out+=`<line x1="${cx.toFixed(1)}" y1="${y(c.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const yo=y(c.o), yc=y(c.c), top=Math.min(yo,yc), bh=Math.max(1,Math.abs(yc-yo));
    out+=`<rect x="${(cx-bw/2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" opacity="0.92"/>`;
  });
  // live price dash
  const last=vis[vis.length-1];
  out+=`<line x1="${padL}" y1="${y(last.c).toFixed(1)}" x2="${W-padR}" y2="${y(last.c).toFixed(1)}" stroke="#f97316" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;
  svg.innerHTML=out;
}

// =====================================================================
// FUTURE PROJECT — reverse window exports (this module is a PRODUCER of
// state/functions read by the classic main script, unlike mfxBot/dabBot
// which were pure consumers of main-script state via the accessor bridge
// in index.html). Unlike that bridge, these accessors live HERE, inside
// the module that owns the underlying `let`/`const` bindings, because an
// ES module's top-level declarations do NOT auto-attach to `window` the
// way a classic script's top-level `function`/`var` declarations do, and
// are NOT visible by bare name to other classic scripts on the page the
// way classic-script `let`/`const` declarations are to each other.
//
// Verified call/read sites in index.html (outside this section, still
// inside the classic main script) that require each of these:
//   - ENG            : read via `ENG.K`/`ENG[key]` and WRITTEN via
//                      `ENG[key] = ...` / `ENG.NOISE = ...` (engine
//                      threshold sliders) — never reassigned, so a
//                      getter-only accessor is sufficient (mirrors the
//                      existing `gridPending` getter-only entry in the
//                      Phase 1b bridge: mutate the same object in place).
//   - engPageReady   : SET to `true` when the Engine page is opened, and
//                      READ by the threshold-slider handlers — genuinely
//                      read AND written from outside, so both accessors
//                      are needed.
//   - engineOnTick   : called bare on every tick (`engineOnTick(price,
//                      epoch, dir);`) from the main tick handler.
//   - engineMetrics  : called bare from the page-open handler and the
//                      threshold-slider handlers.
//   - renderEngine   : called bare from the same two call sites.
//
// No other identifier declared in this module (engTicks, engCarryDir,
// engPending, engStats, engLog, ENG_BASE, engPrevTDabove, engPrevAccelPos,
// engTDbrokeAge, engAccelPosAge, setDivBar, renderEngineLog, drawEngLine,
// drawEngTickCandles) has any reference outside this section (confirmed
// by a whole-file occurrence count: total references == in-section
// references for every one of them), so none of them are exported.
// =====================================================================
Object.defineProperty(window, 'ENG', {
  get: () => ENG,
  configurable: true
});
Object.defineProperty(window, 'engPageReady', {
  get: () => engPageReady,
  set: (v) => { engPageReady = v; },
  configurable: true
});
window.engineOnTick = engineOnTick;
window.engineMetrics = engineMetrics;
window.renderEngine = renderEngine;
