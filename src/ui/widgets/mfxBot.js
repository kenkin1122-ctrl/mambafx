/**
 * src/ui/widgets/mfxBot.js
 *
 * FUTURE PROJECT Phase 1b -- extracted verbatim from index.html's former
 * inline <script> block (the "MAMBA FX FLOATING BOT" draggable widget).
 * The IIFE body below is byte-for-byte identical to what index.html used
 * to run inline (verified with `diff` before this file was written) --
 * this is a pure move, not a rewrite.
 *
 * Why this needed a preparatory step first (unlike the debugPanel.js
 * extraction in Phase 1 slice 1): this code reads 19 identifiers --
 * MARKETS, SYMBOL, RUN_LENGTH, ticks, lastPrice, runDir, runLen, decimals,
 * gridWs, gridAuthed, gridLoginId, gridBalance, gridCurrency,
 * gridIsVirtual, gridTrades, gridReqId, gridPending, gridConnecting,
 * digTrades -- that are `let`/`const`-declared at the top level of
 * index.html's main script. Those bindings are visible, by bare name, to
 * other CLASSIC scripts on the page (a shared per-realm declarative
 * scope), but NOT to an ES module, which has its own separate top-level
 * scope and cannot see that shared record.
 *
 * Rather than rewrite this code's bare references to `window.X` (which
 * would make the extraction a behavioral rewrite, not a verifiable pure
 * move), index.html gained a small additive "live accessor bridge" block
 * immediately after the main script closes: for each of the 19
 * identifiers, `Object.defineProperty(window, name, {get, set})` exposes
 * a live, two-way view of the real binding. Because bare identifier
 * resolution in ANY script (module or classic) falls through to the
 * global object (window) when nothing more local shadows it, this file's
 * existing bare references keep working completely unchanged --
 * `window.gridReqId` and bare `gridReqId` are the same live value, and
 * `++gridReqId` correctly reads-increments-writes-back through the
 * accessor, so the main script and this module share one live counter
 * exactly as before the extraction (verified with a standalone Node vm
 * smoke test simulating the shared-scope semantics before this file was
 * written -- see MSD_FUTURE_PROJECT_PHASE1B_MFXBOT_REPORT.md).
 *
 * Four of the 19 (MARKETS, RUN_LENGTH, ticks, gridPending) are `const` in
 * the main script and are never reassigned by this widget (confirmed by
 * inspection) -- only read, or (gridPending) had properties set on the
 * same object reference -- so their bridge is a getter only.
 *
 * Behavior: byte-for-byte identical to the original inline block. No
 * scientific logic, no UI redesign, no feature change.
 */

(function(){
  const bot    = document.getElementById('mfxBot');
  const head   = document.getElementById('mfxBotHead');
  const minBtn = document.getElementById('mfxMinBtn');
  const STORE  = 'mfxBotState_v1';

  /* ── position persistence ────────────────────────────────────── */
  function savePos(){
    try{ sessionStorage.setItem(STORE, JSON.stringify({
      x: bot.style.left, y: bot.style.top,
      min: bot.classList.contains('minimised')
    })); }catch(_){}
  }
  function loadPos(){
    try{
      const s = JSON.parse(sessionStorage.getItem(STORE)||'null');
      if(!s) return;
      if(s.x){ bot.style.left=s.x; bot.style.right='auto'; }
      if(s.y){
        const nav=document.querySelector('.pagenav');
        const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
        bot.style.top=Math.max(minY,parseFloat(s.y)||0)+'px';
        bot.style.bottom='auto';
      }
      if(s.min) setMin(true);
    }catch(_){}
  }

  /* ── minimise / restore ──────────────────────────────────────── */
  function setMin(on){
    bot.classList.toggle('minimised', on);
    minBtn.textContent = on ? '▣' : '⟨⟩';
    minBtn.title = on ? 'Restore' : 'Double-click header or click to minimise';
    savePos();
  }
  minBtn.addEventListener('click', e=>{ e.stopPropagation(); setMin(!bot.classList.contains('minimised')); });
  head.addEventListener('dblclick', ()=> setMin(!bot.classList.contains('minimised')));

  /* ── drag ────────────────────────────────────────────────────── */
  let dragging=false, ox=0, oy=0;
  head.addEventListener('mousedown', e=>{
    if(e.target===minBtn) return;
    dragging=true; ox=e.clientX-bot.offsetLeft; oy=e.clientY-bot.offsetTop;
    bot.style.left=bot.offsetLeft+'px'; bot.style.top=bot.offsetTop+'px';
    bot.style.right='auto'; bot.style.bottom='auto';
    bot.classList.add('dragging');
  });
  document.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const nav=document.querySelector('.pagenav');
    const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
    const x=Math.max(0,Math.min(e.clientX-ox, window.innerWidth-bot.offsetWidth));
    const y=Math.max(minY,Math.min(e.clientY-oy, window.innerHeight-bot.offsetHeight));
    bot.style.left=x+'px'; bot.style.top=y+'px';
  });
  document.addEventListener('mouseup', ()=>{ if(!dragging)return; dragging=false; bot.classList.remove('dragging'); savePos(); });

  /* touch drag */
  head.addEventListener('touchstart', e=>{
    if(e.target===minBtn) return;
    const t=e.touches[0];
    dragging=true; ox=t.clientX-bot.offsetLeft; oy=t.clientY-bot.offsetTop;
    bot.style.left=bot.offsetLeft+'px'; bot.style.top=bot.offsetTop+'px';
    bot.style.right='auto'; bot.style.bottom='auto';
  },{passive:true});
  document.addEventListener('touchmove', e=>{
    if(!dragging) return;
    const t=e.touches[0];
    const nav=document.querySelector('.pagenav');
    const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
    const x=Math.max(0,Math.min(t.clientX-ox, window.innerWidth-bot.offsetWidth));
    const y=Math.max(minY,Math.min(t.clientY-oy, window.innerHeight-bot.offsetHeight));
    bot.style.left=x+'px'; bot.style.top=y+'px';
  },{passive:true});
  document.addEventListener('touchend', ()=>{ if(!dragging)return; dragging=false; savePos(); });

  /* ── live data refresh (every tick, ~250 ms) ─────────────────── */
  function fmt(v,d){ return (v==null||isNaN(v)) ? '—' : Number(v).toFixed(d??2); }
  function fmtPnl(v){ if(v==null||isNaN(v))return{t:'—',c:''}; return{t:(v>=0?'+':'')+v.toFixed(2),c:v>=0?'pos':'neg'}; }

  function refreshBot(){
    /* price */
    const price = typeof lastPrice!=='undefined'?lastPrice:null;
    const el_price = document.getElementById('mfxPrice');
    const prev = el_price._prev;
    el_price.textContent = price!=null?fmt(price,typeof decimals!=='undefined'?decimals:2):'—';
    if(prev!=null&&price!=null&&price!==prev){
      el_price.style.color = price>prev?'#16e08b':price<prev?'#ff4d5e':'#e6ebf5';
    }
    el_price._prev = price;

    /* market */
    const sym = typeof SYMBOL!=='undefined'?SYMBOL:'';
    const mktName = (typeof MARKETS!=='undefined'&&MARKETS[sym])||sym||'—';
    // abbreviate long names
    const shortName = mktName.replace('Volatility ','V').replace('(1s)','1s').replace('(','').replace(')','');
    document.getElementById('mfxMarket').textContent = shortName;

    /* run bar */
    const rLen = typeof runLen!=='undefined'?runLen:0;
    const rDir = typeof runDir!=='undefined'?runDir:0;
    const rMax = typeof RUN_LENGTH!=='undefined'?RUN_LENGTH:5;
    const pct  = Math.min(100, rLen/rMax*100);
    const fill = document.getElementById('mfxRunFill');
    fill.style.width = pct+'%';
    fill.style.background = rDir===1?'#16e08b':rDir===-1?'#ff4d5e':'#56b6ff';
    const runText = document.getElementById('mfxRunText');
    if(rLen>0){
      runText.textContent = `${rDir===1?'▲ RISE':'▼ FALL'} · ${rLen} / ${rMax} ticks`;
      runText.style.color = rDir===1?'#16e08b':'#ff4d5e';
    } else {
      runText.textContent = '— no active run'; runText.style.color='#475569';
    }

    /* stats: won / lost / win rate / P/L — split by Demo vs Real */
    let net=0, won=0, lost=0;
    let dWon=0,dLost=0,dNet=0, rWon=0,rLost=0,rNet=0;
    const trades = [...(typeof gridTrades!=='undefined'?gridTrades:[]),
                    ...(typeof digTrades!=='undefined'?digTrades:[])];
    trades.forEach(t=>{
      const demo = t.isVirtual != null ? t.isVirtual : (typeof gridIsVirtual!=='undefined'?gridIsVirtual!==false:true);
      const pnl = t.pnl != null ? t.pnl : 0;
      if(t.status==='won'){
        won++; net+=pnl;
        if(demo){ dWon++; dNet+=pnl; } else { rWon++; rNet+=pnl; }
      }
      if(t.status==='lost'){
        lost++; net+=pnl;
        if(demo){ dLost++; dNet+=pnl; } else { rLost++; rNet+=pnl; }
      }
    });
    function mfxRateStr(w,l){ const t=w+l; return t>0?Math.round(w/t*100)+'%':'—'; }
    function mfxPnlStr(v,any){ return any?(v>=0?'+':'')+v.toFixed(2):'—'; }
    const total=won+lost, dTotal=dWon+dLost, rTotal=rWon+rLost;
    // All tab
    const elWon=document.getElementById('mfxWon'); if(elWon) elWon.textContent=won;
    const elLost=document.getElementById('mfxLost'); if(elLost) elLost.textContent=lost;
    const elWr=document.getElementById('mfxWinRate'); if(elWr) elWr.textContent=mfxRateStr(won,lost);
    const elPnl=document.getElementById('mfxPnL');
    if(elPnl){ elPnl.textContent=mfxPnlStr(net,total>0); elPnl.style.color=net>=0?'#10b981':'#ef4444'; }
    // Demo tab
    const elDW=document.getElementById('mfxWonDemo'); if(elDW) elDW.textContent=dWon;
    const elDL=document.getElementById('mfxLostDemo'); if(elDL) elDL.textContent=dLost;
    const elDR=document.getElementById('mfxWinRateDemo'); if(elDR) elDR.textContent=mfxRateStr(dWon,dLost);
    const elDP=document.getElementById('mfxPnLDemo');
    if(elDP){ elDP.textContent=mfxPnlStr(dNet,dTotal>0); elDP.style.color=dNet>=0?'#10b981':'#ef4444'; }
    // Real tab
    const elRW=document.getElementById('mfxWonReal'); if(elRW) elRW.textContent=rWon;
    const elRL=document.getElementById('mfxLostReal'); if(elRL) elRL.textContent=rLost;
    const elRR=document.getElementById('mfxWinRateReal'); if(elRR) elRR.textContent=mfxRateStr(rWon,rLost);
    const elRP=document.getElementById('mfxPnLReal');
    if(elRP){ elRP.textContent=mfxPnlStr(rNet,rTotal>0); elRP.style.color=rNet>=0?'#10b981':'#ef4444'; }

    /* keep market selector in sync with active symbol */
    const mktSel = document.getElementById('mfxMarketSel');
    if(mktSel && typeof SYMBOL!=='undefined' && mktSel.value !== SYMBOL){
      mktSel.value = SYMBOL;
    }

    /* connection */
    const authed = typeof gridAuthed!=='undefined'&&gridAuthed;
    const dot = document.getElementById('mfxDot');
    dot.className = 'd'+(authed?' on':typeof gridConnecting!=='undefined'&&gridConnecting?'':' off');
    document.getElementById('mfxConnLbl').textContent = authed?'live':typeof gridConnecting!=='undefined'&&gridConnecting?'…':'offline';
    const ccyEl = document.getElementById('mfxStakeCcy');
    if(ccyEl && typeof gridCurrency!=='undefined') ccyEl.textContent = gridCurrency;

    /* account row */
    const acctRow = document.getElementById('mfxAcctRow');
    if(authed&&typeof gridLoginId!=='undefined'&&gridLoginId){
      acctRow.style.display='flex';
      document.getElementById('mfxAcctId').textContent  = gridLoginId;
      const bal = typeof gridBalance!=='undefined'&&gridBalance!=null?gridBalance.toFixed(2)+' '+(typeof gridCurrency!=='undefined'?gridCurrency:''):'—';
      document.getElementById('mfxAcctBal').textContent = bal;
      document.getElementById('mfxAcctType').textContent= typeof gridIsVirtual!=='undefined'?(gridIsVirtual?'DEMO':'REAL'):'—';
    } else { acctRow.style.display='none'; }

    /* last trade */
    const lastTradeRow = document.getElementById('mfxLastTradeRow');
    if(trades.length){
      const t = trades[0];
      lastTradeRow.style.display='block';
      const dirEl=document.getElementById('mfxLastDir');
      dirEl.textContent  = t.dir===1?'RISE ▲':'FALL ▼';
      dirEl.className    = 'mfx-trade-dir '+(t.dir===1?'up':'dn');
      document.getElementById('mfxLastContract').textContent = t.contractType||t.digit!=null?('Digit '+t.digit):'—';
      document.getElementById('mfxLastStatus').textContent   = t.status||'—';
      const tp=fmtPnl(t.pnl);
      const pEl=document.getElementById('mfxLastPnL');
      pEl.textContent=tp.t; pEl.className='mfx-trade-pnl '+(tp.c||'');
    } else { lastTradeRow.style.display='none'; }

    /* quick-trade buttons */
    const canTrade = authed&&typeof gridWs!=='undefined'&&gridWs&&gridWs.readyState===1;
    document.getElementById('mfxRiseBtn').disabled=!canTrade;
    document.getElementById('mfxFallBtn').disabled=!canTrade;
    const runBtn = document.getElementById('mfxRunBtn');
    if(runBtn){ runBtn.disabled=!canTrade; }
    /* sync button labels with selected contract type */
    const ctSel = document.getElementById('mfxContractType');
    const ct = ctSel ? ctSel.value : 'CALL_PUT';
    const riseEl = document.getElementById('mfxRiseBtn');
    const fallEl = document.getElementById('mfxFallBtn');
    const labels = {
      CALL_PUT:    ['▲ RISE','▼ FALL'],
      DIGITEVEN:   ['EVEN','ODD'],
      DIGITOVER:   ['OVER','UNDER'],
      CALL_PUT_H:  ['▲ HIGHER','▼ LOWER'],
      EXPIRYRANGE: ['STAY IN','GOES OUT'],
      UPORDOWN:    ['ONLY UPS','ONLY DOWNS'],
    };
    const [lRise, lFall] = labels[ct]||labels.CALL_PUT;
    if(riseEl) riseEl.textContent=lRise;
    if(fallEl) fallEl.textContent=lFall;
  }

  /* ── contract type change: show/hide tick-duration bar ───────── */
  let mfxOuDur = 5; // default 5 ticks — matches Deriv's default for Only Ups/Only Downs
  window.mfxOnContractTypeChange = function(){
    const ct = (document.getElementById('mfxContractType')||{}).value||'CALL_PUT';
    const wrap = document.getElementById('mfxOuDurWrap');
    if(wrap) wrap.style.display = ct==='UPORDOWN' ? 'block' : 'none';
    refreshBot(); // update button labels
  };
  window.mfxSetOuDur = function(n){
    mfxOuDur = n;
    [2,3,4,5].forEach(d=>{
      const btn = document.getElementById('mfxOuDur'+d);
      if(btn) btn.classList.toggle('active', d===n);
    });
  };

  /* ── P/L tab switching (Demo / Real / All) ───────────────────── */
  let mfxPlTab = 'demo';
  window.mfxShowPlTab = function(tab){
    mfxPlTab = tab;
    ['demo','real','all'].forEach(t=>{
      const panel = document.getElementById('mfxPl'+t[0].toUpperCase()+t.slice(1));
      const btn = document.querySelector('.mfx-acct-pl-tab[onclick*="\''+t+'\'"]');
      if(panel) panel.classList.toggle('visible', t===tab);
      if(btn) btn.classList.toggle('active', t===tab);
    });
  };

  /* ── stake + multiplier ─────────────────────────────────────── */
  const mfxMult=(typeof makeMultiplier==='function')?makeMultiplier(()=>document.getElementById('mfxStakeInput')):null;
  function mfxGetStrat(){const s=document.getElementById('mfxMultiplier');return s?s.value:'flat';}
  function mfxGetStake(){
    if(mfxMult){mfxMult._strat=mfxGetStrat();return Math.max(0.35,mfxMult.getNext(mfxGetStrat()));}
    const el=document.getElementById('mfxStakeInput');
    return Math.max(0.35,parseFloat((el&&el.value)||'1'));
  }
  const mfxTradeIds=new Set(); // track IDs of trades placed by this bot
  window._multRecord=(function(){
    const prev=window._multRecord;
    return function(id,stk,won){
      if(prev) prev(id,stk,won);
      if(mfxMult&&mfxTradeIds.has(id)){ mfxMult.record(stk,won); mfxTradeIds.delete(id); }
    };
  })();

  /* ── quick-trade from the bot ────────────────────────────────── */
  window.mfxQuickTrade = function(dir){
    // gridWs and gridAuthed are let-declared in the main script — accessible
    // by name from any script on the same page, but NOT via window.gridWs
    // (let at top-level doesn't attach to window, unlike var).
    if(typeof gridWs==='undefined'||!gridWs||gridWs.readyState!==1||!gridAuthed){
      alert('Connect on the Trading Grid page first.'); return;
    }
    console.log('[MambaFX Bot] trade initiated — ws ready:', gridWs.readyState, 'authed:', gridAuthed);
    const ct = (document.getElementById('mfxContractType')||{}).value||'CALL_PUT';
    if(ct==='CALL_PUT'||ct==='CALL_PUT_H'){
      // Rise/Fall and Higher/Lower: CALL (rise) or PUT (fall)
      if(typeof gridPlaceTrade==='function') gridPlaceTrade(dir,'bot');
    } else if(ct==='UPORDOWN'){
      // Only Ups = RUNHIGH, Only Downs = RUNLOW (Deriv API docs confirmed)
      // These give the correct ~2953% return for 5 ticks, not the ~81% CALL/PUT return
      mfxSendOuProposal(dir===1?'RUNHIGH':'RUNLOW', mfxOuDur);
    } else if(ct==='DIGITEVEN'){
      if(typeof digPlaceTrade==='function') digPlaceTrade(dir===1?'even':'odd','bot');
      else mfxSendDigitProposal(dir===1?'DIGITEVEN':'DIGITODD',null);
    } else if(ct==='DIGITOVER'){
      mfxSendDigitProposal(dir===1?'DIGITOVER':'DIGITUNDER',5);
    } else if(ct==='EXPIRYRANGE'){
      mfxSendBarrierProposal(dir===1?'EXPIRYRANGE':'EXPIRYMISS');
    } else {
      if(typeof gridPlaceTrade==='function') gridPlaceTrade(dir,'bot');
    }
  };

  function mfxSendOuProposal(contractType, dur){
    // contractType: 'RUNHIGH' = Only Ups, 'RUNLOW' = Only Downs
    // Confirmed from Deriv API docs: developers.deriv.com/docs/only-upsonly-downs
    if(typeof gridWs==='undefined'||!gridWs||gridWs.readyState!==1) return;
    const stake = mfxGetStake();
    const reqId = (typeof gridReqId!=='undefined'?++gridReqId:Date.now());
    const proposalMsg = {
      proposal: 1,
      req_id: reqId,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,           // 'RUNHIGH' or 'RUNLOW'
      currency: typeof gridCurrency!=='undefined'?gridCurrency:'USD',
      duration: dur,                         // 2, 3, 4, or 5 ticks
      duration_unit: 't',
      underlying_symbol: typeof SYMBOL!=='undefined'?SYMBOL:'1HZ100V',
    };
    console.log('[MambaFX Bot] Sending OU proposal:', JSON.stringify(proposalMsg));

    function showPreviewError(msg){
      const prev = document.getElementById('mfxPayoutPreview');
      if(prev){
        prev.style.background='#fef2f2'; prev.style.borderColor='#fecaca';
        prev.style.display='block';
        const p1=document.getElementById('mfxPreviewPayout');
        const p2=document.getElementById('mfxPreviewProfit');
        const p3=document.getElementById('mfxPreviewReturn');
        if(p1) p1.textContent='Error';
        if(p2) p2.textContent=msg;
        if(p3) p3.textContent='—';
      }
    }

    if(typeof gridPending!=='undefined'){
      gridPending[reqId] = (proposal, err) => {
        if(err){
          console.error('[MambaFX Bot] OU proposal error:', err.code, err.message, err.details);
          showPreviewError((err.message||'Proposal rejected')+' ['+( err.details&&err.details.field?err.details.field:err.code||'?')+']');
          return;
        }
        if(!proposal||!proposal.id||proposal.ask_price==null){
          console.error('[MambaFX Bot] OU proposal missing id/ask_price:', proposal);
          showPreviewError('Proposal returned no price — check API Diagnostics page');
          return;
        }
        console.log('[MambaFX Bot] OU proposal OK:', JSON.stringify(proposal));

        // Show payout preview panel
        const payout = Number(proposal.payout||0);
        const askPrice = Number(proposal.ask_price||stake);
        const profit = payout - askPrice;
        const ret = askPrice>0 ? (profit/askPrice*100).toFixed(1) : '—';
        const prev = document.getElementById('mfxPayoutPreview');
        const ccy = typeof gridCurrency!=='undefined'?gridCurrency:'USD';
        if(prev){
          prev.style.background=''; prev.style.borderColor='';
          document.getElementById('mfxPreviewPayout').textContent  = payout.toFixed(2)+' '+ccy;
          document.getElementById('mfxPreviewProfit').textContent  = (profit>=0?'+':'')+profit.toFixed(2)+' '+ccy;
          document.getElementById('mfxPreviewReturn').textContent  = ret+'%';
          prev.style.display = 'block';
        }

        // Buy immediately with the exact proposal.id and ask_price
        const buyReqId = (typeof gridReqId!=='undefined'?++gridReqId:Date.now()+1);
        const buyMsg = { buy: proposal.id, price: proposal.ask_price, req_id: buyReqId };
        console.log('[MambaFX Bot] Sending OU buy:', JSON.stringify(buyMsg));
        if(typeof gridPending!=='undefined'){
          gridPending[buyReqId] = (buy, buyErr) => {
            if(buyErr){
              console.error('[MambaFX Bot] OU buy error:', buyErr.code, buyErr.message, buyErr.details);
              showPreviewError('Buy failed: '+(buyErr.message||buyErr.code||'error'));
              return;
            }
            if(buy){
              console.log('[MambaFX Bot] ✅ Only Ups/Downs contract opened:', buy.contract_id, 'payout:', buy.payout);
              const prev2 = document.getElementById('mfxPayoutPreview');
              if(prev2) prev2.style.borderColor='#86efac';
            }
          };
        }
        gridWs.send(JSON.stringify(buyMsg));
      };
    } else {
      console.error('[MambaFX Bot] gridPending not accessible — cannot register proposal callback');
    }
    if(typeof mfxTradeIds!=='undefined') mfxTradeIds.add('pending-'+reqId);
    gridWs.send(JSON.stringify(proposalMsg));
  }

  /* ── auto-run ────────────────────────────────────────────────── */
  let mfxRunning = false;
  window.mfxToggleRun = function(){
    mfxRunning = !mfxRunning;
    const btn = document.getElementById('mfxRunBtn');
    if(btn){
      btn.textContent = mfxRunning ? '⏹ STOP AUTO' : '▶ RUN AUTO';
      btn.classList.toggle('running', mfxRunning);
    }
  };

  /* ── digit proposal helper ───────────────────────────────────── */
  function mfxSendDigitProposal(ctype, barrier){
    if(typeof gridWs==="undefined"||!gridWs||gridWs.readyState!==1) return;
    const stake = mfxGetStake();
    const reqId = (typeof gridReqId!=='undefined'?++gridReqId:Date.now());
    const msg = {
      proposal:1, req_id:reqId, amount:stake, basis:'stake',
      contract_type:ctype, currency:typeof gridCurrency!=='undefined'?gridCurrency:'USD',
      duration:5, duration_unit:'t', underlying_symbol:typeof SYMBOL!=='undefined'?SYMBOL:'1HZ100V',
    };
    if(barrier!==null&&barrier!==undefined) msg.barrier=String(barrier);
    if(typeof gridPending!=='undefined'){
      gridPending[reqId]=(proposal,err)=>{
        if(err||!proposal||!proposal.id) return;
        const buyReqId=(typeof gridReqId!=='undefined'?++gridReqId:Date.now()+1);
        if(typeof gridPending!=='undefined') gridPending[buyReqId]=(buy,buyErr)=>{
          if(!buyErr&&buy) console.log('[MambaFX Bot] digit contract:',buy.contract_id);
        };
        gridWs.send(JSON.stringify({buy:proposal.id,price:proposal.ask_price,req_id:buyReqId}));
      };
    }
    gridWs.send(JSON.stringify(msg));
  }

  /* ── barrier proposal helper (Stay Between / Goes Out) ──────── */
  function mfxSendBarrierProposal(ctype){
    if(typeof gridWs==="undefined"||!gridWs||gridWs.readyState!==1) return;
    const tks = typeof ticks!=='undefined'?ticks:[];
    if(tks.length<5) return;
    const prices = tks.slice(-20).map(t=>t.price);
    const hi=msdSafeMax(prices), lo=msdSafeMin(prices);
    const dec=typeof decimals!=='undefined'?decimals:2;
    const rng=hi-lo;
    const stake=mfxGetStake();
    const reqId=(typeof gridReqId!=='undefined'?++gridReqId:Date.now());
    const msg={
      proposal:1,req_id:reqId,amount:stake,basis:'stake',
      contract_type:ctype,currency:typeof gridCurrency!=='undefined'?gridCurrency:'USD',
      duration:5,duration_unit:'t',underlying_symbol:typeof SYMBOL!=='undefined'?SYMBOL:'1HZ100V',
      high_barrier:(hi+(rng*0.5)).toFixed(dec),
      low_barrier:(lo-(rng*0.5)).toFixed(dec),
    };
    if(typeof gridPending!=='undefined'){
      gridPending[reqId]=(proposal,err)=>{
        if(err||!proposal||!proposal.id) return;
        const buyReqId=(typeof gridReqId!=='undefined'?++gridReqId:Date.now()+1);
        if(typeof gridPending!=='undefined') gridPending[buyReqId]=(buy,buyErr)=>{
          if(buyErr) console.warn('[MambaFX Bot] barrier buy error:', buyErr.message);
          else if(buy) console.log('[MambaFX Bot] barrier contract:',buy.contract_id);
        };
        gridWs.send(JSON.stringify({buy:proposal.id,price:proposal.ask_price,req_id:buyReqId}));
      };
    }
    gridWs.send(JSON.stringify(msg));
  }

  /* ── signal flash + auto-run hook ────────────────────────────── */
  const _origOnSignalFired = window.onSignalFired;
  window.onSignalFired = function(dir, price, epoch){
    const fill = document.getElementById('mfxRunFill');
    if(fill){ fill.classList.add('mfx-flash'); fill.addEventListener('animationend',()=>fill.classList.remove('mfx-flash'),{once:true}); }
    /* auto-run: fire a trade in the signal direction when running */
    if(mfxRunning){
      const ct=(document.getElementById('mfxContractType')||{}).value||'CALL_PUT';
      if(ct==='CALL_PUT'||ct==='CALL_PUT_H'){
        if(typeof gridPlaceTrade==='function') gridPlaceTrade(dir,'bot-auto');
      } else {
        window.mfxQuickTrade(dir);
      }
    }
    if(typeof _origOnSignalFired==='function') _origOnSignalFired(dir,price,epoch);
  };

  /* ── market change from bot selector ─────────────────────────── */
  window.mfxChangeMarket = function(){
    const sel = document.getElementById('mfxMarketSel');
    if(!sel) return;
    const code = sel.value;
    if(typeof switchMarket==='function') switchMarket(code);
  };

  /* ── init ────────────────────────────────────────────────────── */
  loadPos();
  // Populate the market selector from the app's own MARKETS constant
  (function initMarketSel(){
    const sel = document.getElementById('mfxMarketSel');
    if(!sel) return;
    try{
      if(typeof MARKETS!=='undefined'){
        sel.innerHTML = Object.entries(MARKETS).map(([k,v])=>
          `<option value="${k}"${k===SYMBOL?' selected':''}>${v.replace('Volatility ','V').replace(' Index','').replace('(','').replace(')','')}</option>`
        ).join('');
      }
    }catch(_){}
  })();
  setInterval(refreshBot, 300);
  refreshBot();
})();
