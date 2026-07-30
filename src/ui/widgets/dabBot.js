/**
 * src/ui/widgets/dabBot.js
 *
 * FUTURE PROJECT Phase 1c -- extracted verbatim from index.html's former
 * inline <script> block (the "dabBot" / Deriv Auto Bot floating widget,
 * structurally similar to mfxBot but with its own auto-fire/martingale
 * logic). The IIFE body below is byte-for-byte identical to what
 * index.html used to run inline (verified with `diff` before this file
 * was written) -- this is a pure move, not a rewrite.
 *
 * Dependency analysis was done independently from mfxBot's (Phase 1b),
 * not assumed to be identical, per the standing note in the Phase 1b
 * report. Result: dabBot reads 14 of the same style of cross-scope
 * `let`/`const` identifiers -- MARKETS, SYMBOL, decimals, gridAuthed,
 * gridCurrency, gridIsVirtual, gridPending, gridReqId, gridWs, lastPrice,
 * runDir, runLen, ticks -- all already exposed by the live window.*
 * accessor bridge added in index.html for mfxBot, PLUS one identifier
 * mfxBot never needed: `gridOpenContracts` (a `let`-declared object used
 * only via property assignment, e.g. `gridOpenContracts[row.id] = row`,
 * never reassigned -- so it only needed a getter, added as one more line
 * to the existing bridge block rather than a second separate bridge).
 *
 * A note on how this dependency list was actually determined: an
 * automated comment/string-stripping analysis (the same approach used
 * for mfxBot) silently corrupted itself on this file -- an unbalanced
 * apostrophe pattern caused its naive regex-based string-stripper to
 * treat more than half the code as "inside a string" and skip it,
 * which would have produced a dangerously incomplete dependency list
 * had it been trusted. This was caught by noticing the result (only one
 * flagged identifier, for code this similar to mfxBot) didn't pass a
 * basic plausibility check, and was replaced with a narrower, more
 * reliable check: this codebase consistently guards every cross-scope
 * read with an explicit `typeof X !== 'undefined'` pattern (confirmed by
 * reading mfxBot's own code, which uses the identical convention), so
 * grepping for that exact guard pattern -- plus a full manual read of
 * this file's ~370 lines -- was used instead, and is what produced the
 * 14-identifier list above.
 *
 * Behavior: byte-for-byte identical to the original inline block. No
 * scientific logic, no UI redesign, no feature change.
 */

(function(){
  const bot  = document.getElementById('dabBot');
  const head = document.getElementById('dabHead');
  const minB = document.getElementById('dabMinBtn');
  const STORE = 'dabBotState_v1';

  /* ── position persistence ────────────────────────────────── */
  function savePos(){
    try{ sessionStorage.setItem(STORE, JSON.stringify({
      x:bot.style.left, y:bot.style.top,
      min:bot.classList.contains('minimised')
    }));}catch(_){}
  }
  function loadPos(){
    try{
      const s=JSON.parse(sessionStorage.getItem(STORE)||'null');
      if(!s) return;
      if(s.x){bot.style.left=s.x;bot.style.right='auto';}
      if(s.y){
        const nav=document.querySelector('.pagenav');
        const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
        bot.style.top=Math.max(minY,parseFloat(s.y)||0)+'px';
        bot.style.bottom='auto';
      }
      if(s.min) setMin(true);
    }catch(_){}
  }

  /* ── minimise ─────────────────────────────────────────────── */
  function setMin(on){
    bot.classList.toggle('minimised',on);
    minB.textContent=on?'▣':'⟨⟩';
    savePos();
  }
  minB.addEventListener('click',e=>{e.stopPropagation();setMin(!bot.classList.contains('minimised'));});
  head.addEventListener('dblclick',()=>setMin(!bot.classList.contains('minimised')));

  /* ── drag (mouse) ─────────────────────────────────────────── */
  let dragging=false,ox=0,oy=0;
  head.addEventListener('mousedown',e=>{
    if(e.target===minB)return;
    dragging=true;ox=e.clientX-bot.offsetLeft;oy=e.clientY-bot.offsetTop;
    bot.style.left=bot.offsetLeft+'px';bot.style.top=bot.offsetTop+'px';
    bot.style.right='auto';bot.style.bottom='auto';
    bot.classList.add('dragging');
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const nav=document.querySelector('.pagenav');
    const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
    bot.style.left=Math.max(0,Math.min(e.clientX-ox,window.innerWidth-bot.offsetWidth))+'px';
    bot.style.top=Math.max(minY,Math.min(e.clientY-oy,window.innerHeight-bot.offsetHeight))+'px';
  });
  document.addEventListener('mouseup',()=>{if(!dragging)return;dragging=false;bot.classList.remove('dragging');savePos();});

  /* ── drag (touch) ─────────────────────────────────────────── */
  head.addEventListener('touchstart',e=>{
    if(e.target===minB)return;
    const t=e.touches[0];
    dragging=true;ox=t.clientX-bot.offsetLeft;oy=t.clientY-bot.offsetTop;
    bot.style.left=bot.offsetLeft+'px';bot.style.top=bot.offsetTop+'px';
    bot.style.right='auto';bot.style.bottom='auto';
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!dragging)return;
    const t=e.touches[0];
    const nav=document.querySelector('.pagenav');
    const minY=nav?(nav.getBoundingClientRect().bottom+8):0;
    bot.style.left=Math.max(0,Math.min(t.clientX-ox,window.innerWidth-bot.offsetWidth))+'px';
    bot.style.top=Math.max(minY,Math.min(t.clientY-oy,window.innerHeight-bot.offsetHeight))+'px';
  },{passive:true});
  document.addEventListener('touchend',()=>{if(!dragging)return;dragging=false;savePos();});

  /* ── helpers ──────────────────────────────────────────────── */
  function dabSet(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
  function dabGet(id){const e=document.getElementById(id);return e?e.value:'';}
  const dabMult=(typeof makeMultiplier==='function')?makeMultiplier(()=>document.getElementById('dabStake')):null;
  function dabGetStrat(){const s=document.getElementById('dabMultiplier');return s?s.value:'flat';}
  // Only Ups/Only Downs (RUNHIGH/RUNLOW) pay out roughly 30x the stake at
  // 5 ticks (Deriv's own quoted ~2953% return). Martingale on a contract
  // that already pays ~30x will cross Deriv's $10,000 max-payout ceiling
  // after only ~10-11 consecutive losses -- long before balance is at risk.
  // Once that happens every further fire hits the exact same rejection
  // forever, so we cap the stake (and reset Martingale) BEFORE firing.
  const DAB_PAYOUT_MULT = { UPORDOWN: 30.53 };
  const DAB_PAYOUT_CAP  = 9500;   // stay safely under Deriv's 10,000 ceiling
  function dabGetStake(){
    const base = Math.max(0.35, parseFloat(dabGet('dabStake')||'1'));
    let stake = dabMult ? (dabMult._strat = dabGetStrat(), Math.max(0.35, dabMult.getNext(dabGetStrat()))) : base;
    const ct = dabGet('dabContractType');
    const mult = DAB_PAYOUT_MULT[ct];
    if (mult && stake * mult > DAB_PAYOUT_CAP){
      if (dabMult) dabMult.reset();
      stake = base;
      dabSet('dabStatus', `⚠ Payout cap reached (would exceed Deriv's $10,000 max payout) — Martingale reset to base stake ${base.toFixed(2)}.`);
    }
    return stake;
  }
  function dabGetDur(){
    const ct=dabGet('dabContractType');
    if(ct==='UPORDOWN') return dabOuDur;
    return Math.max(1,parseInt(dabGet('dabDuration')||'5',10));
  }

  /* ── contract type change ─────────────────────────────────── */
  let dabOuDur=5;
  window.dabSetOuDur=function(n){
    dabOuDur=n;
    [2,3,4,5].forEach(d=>{
      const b=document.getElementById('dabOuDur'+d);
      if(b)b.classList.toggle('active',d===n);
    });
  };
  window.dabOnContractChange=function(){
    const ct=dabGet('dabContractType');
    const ouWrap=document.getElementById('dabOuDurWrap');
    const durField=document.getElementById('dabDurField');
    if(ouWrap) ouWrap.style.display=ct==='UPORDOWN'?'block':'none';
    if(durField) durField.style.display=ct==='UPORDOWN'?'none':'block';
    const btnUp=document.getElementById('dabBtnUp');
    const btnDn=document.getElementById('dabBtnDn');
    const labels={
      CALL_PUT:['▲ UP','▼ DOWN'],UPORDOWN:['ONLY UPS','ONLY DOWNS'],
      DIGITEVEN:['EVEN','ODD'],DIGITOVER:['OVER','UNDER'],
      EXPIRYRANGE:['STAY IN','GOES OUT']
    };
    const [lu,ld]=(labels[ct]||labels.CALL_PUT);
    if(btnUp)btnUp.textContent=lu;
    if(btnDn)btnDn.textContent=ld;
  };

  /* ── trade ledger ─────────────────────────────────────────── */
  const dabTrades=[];
  function dabRenderStats(){
    let won=0,lost=0,net=0,any=false;
    dabTrades.forEach(t=>{
      if(t.status==='won'){won++;if(t.pnl!=null){net+=t.pnl;any=true;}}
      if(t.status==='lost'){lost++;if(t.pnl!=null){net+=t.pnl;any=true;}}
    });
    dabSet('dabWon',won); dabSet('dabLost',lost);
    const tot=won+lost;
    dabSet('dabWinRate',tot>0?(won/tot*100).toFixed(1)+'%':'—');
    const ccy=(typeof gridCurrency!=='undefined'?gridCurrency:'USD');
    const pEl=document.getElementById('dabPnL');
    if(pEl){
      pEl.textContent=any?(net>=0?'+':'')+net.toFixed(2)+' '+ccy:'—';
      pEl.className='val '+(any?(net>=0?'up':'dn'):'');
    }
    // last trade
    if(dabTrades.length){
      const t=dabTrades[0];
      document.getElementById('dabLastRow').style.display='block';
      const dEl=document.getElementById('dabLastDir');
      dEl.textContent=t.dir===1?'▲ UP':'▼ DOWN';
      dEl.className='dab-dir '+(t.dir===1?'up':'dn');
      dabSet('dabLastType',t.contractType||'—');
      dabSet('dabLastStatus',t.status||'—');
      const pEl2=document.getElementById('dabLastPnl');
      if(pEl2){
        pEl2.textContent=t.pnl!=null?(t.pnl>=0?'+':'')+t.pnl.toFixed(2):'—';
        pEl2.className='dab-last-pnl '+(t.pnl!=null?(t.pnl>=0?'pos':'neg'):'');
      }
    }
  }

  /* ── connection status ────────────────────────────────────── */
  function dabRefreshConn(){
    const ok=typeof gridWs!=='undefined'&&gridWs&&gridWs.readyState===1&&(typeof gridAuthed!=='undefined'&&gridAuthed);
    const dot=document.getElementById('dabDot');
    if(dot)dot.className='d'+(ok?' on':' off');
    dabSet('dabConnLbl',ok?'live':'offline');
    const ccy=(typeof gridCurrency!=='undefined'?gridCurrency:'USD');
    const ccyEl=document.getElementById('dabStakeCcy');if(ccyEl)ccyEl.textContent=ccy;
    ['dabBtnUp','dabBtnDn','dabAutoBtn'].forEach(id=>{
      const b=document.getElementById(id);if(b)b.disabled=!ok;
    });
    if(!ok&&dabAutoRunning) dabStopAuto('disconnected');
  }

  /* ── core fire function ───────────────────────────────────── */
  function dabFire(dir,source){
    if(typeof gridWs==='undefined'||!gridWs||gridWs.readyState!==1||!(typeof gridAuthed!=='undefined'&&gridAuthed)){
      dabSet('dabStatus','Not connected — connect on Trading Grid first.');return;
    }
    const ct=dabGet('dabContractType');
    const dur=dabGetDur();
    const stake=dabGetStake();
    const bust=document.getElementById('dabBust')&&document.getElementById('dabBust').checked;

    // Build the proposal
    let contractType;
    if(ct==='CALL_PUT')       contractType=dir===1?'CALL':'PUT';
    else if(ct==='UPORDOWN')  contractType=dir===1?'RUNHIGH':'RUNLOW';
    else if(ct==='DIGITEVEN') contractType=dir===1?'DIGITEVEN':'DIGITODD';
    else if(ct==='DIGITOVER') contractType=dir===1?'DIGITOVER':'DIGITUNDER';
    else if(ct==='EXPIRYRANGE') contractType=dir===1?'EXPIRYRANGE':'EXPIRYMISS';
    else contractType=dir===1?'CALL':'PUT';

    const reqId=(typeof gridReqId!=='undefined'?++gridReqId:Date.now());
    const proposal={
      proposal:1, req_id:reqId,
      amount:stake, basis:'stake',
      contract_type:contractType,
      currency:(typeof gridCurrency!=='undefined'?gridCurrency:'USD'),
      duration:dur, duration_unit:'t',
      underlying_symbol:(typeof SYMBOL!=='undefined'?SYMBOL:'1HZ100V'),
    };
    // Barrier for Over/Under digit contracts
    if(ct==='DIGITOVER'||ct==='DIGITUNDER') proposal.barrier='5';
    // High/low barriers for Stay Between / Goes Out
    if(ct==='EXPIRYRANGE'){
      const tks=typeof ticks!=='undefined'?ticks:[];
      if(tks.length>=5){
        const prices=tks.slice(-20).map(t=>t.price);
        const hi=msdSafeMax(prices),lo=msdSafeMin(prices),rng=hi-lo;
        const dec=(typeof decimals!=='undefined'?decimals:2);
        proposal.high_barrier=(hi+rng*0.5).toFixed(dec);
        proposal.low_barrier=(lo-rng*0.5).toFixed(dec);
      }
    }

    const row={
      id:'pending-'+reqId,dir,source,contractType,stake,
      currency:(typeof gridCurrency!=='undefined'?gridCurrency:'USD'),
      isVirtual:typeof gridIsVirtual!=='undefined'?!!gridIsVirtual:true,
      time:Math.floor(Date.now()/1000),
      entry:null,exit:null,payout:null,pnl:null,status:'pricing…'
    };
    dabTrades.unshift(row);
    if(dabTrades.length>200)dabTrades.pop();
    dabRenderStats();
    dabSet('dabStatus',`Pricing ${contractType}…`);

    // In BUST MODE: we fire and forget — don't wait for the outcome before
    // allowing the next trade. The contract is tracked for P/L but execution
    // continues immediately. Without bust mode, the auto-fire interval still
    // controls timing; bust simply removes the "wait for settlement" gate.
    if(typeof gridPending!=='undefined'){
      gridPending[reqId]=(prop,err)=>{
        if(err){
          row.status='rejected: '+(err.message||err.code||'error')+(err.details?` [${err.details.field||'?'}]`:'');
          dabRenderStats();
          const isPayoutCap = /maximum payout/i.test(err.message||'');
          if (isPayoutCap && dabMult){
            dabMult.reset();
            dabSet('dabStatus', `⚠ Deriv rejected on payout cap — Martingale reset to base stake. (${err.message||''})`);
          } else {
            dabSet('dabStatus',row.status);
          }
          return;
        }
        if(!prop||!prop.id||prop.ask_price==null){
          row.status='rejected: no price';dabRenderStats();return;
        }
        const buyReqId=(typeof gridReqId!=='undefined'?++gridReqId:Date.now()+1);
        const buyMsg={buy:prop.id,price:prop.ask_price,req_id:buyReqId};
        row.status='open';dabRenderStats();
        dabSet('dabStatus',`Contract open — payout if won: ${Number(prop.payout||0).toFixed(2)}`);
        if(typeof gridPending!=='undefined'){
          gridPending[buyReqId]=(buy,buyErr)=>{
            if(buyErr){
              row.status='buy failed: '+(buyErr.message||buyErr.code||'error');
              dabRenderStats();dabSet('dabStatus',row.status);return;
            }
            if(buy){
              row.id=String(buy.contract_id);
              row.buyPrice=buy.buy_price;
              row.status='open';
              if(typeof gridOpenContracts!=='undefined') gridOpenContracts[row.id]=row;
              dabRenderStats();
              console.log('[Deriv Auto Bot] contract opened:',buy.contract_id,contractType);
            }
          };
        }
        gridWs.send(JSON.stringify(buyMsg));
      };
    }
    gridWs.send(JSON.stringify(proposal));
    console.log('[Deriv Auto Bot] proposal sent:',contractType,'dur:',dur,'stake:',stake,'bust:',bust);
  }
  // Expose so gridUpdateContract can call engRenderStats equivalent
  window.dabFire=dabFire;

  // Hook into gridUpdateContract to update dabTrades on settlement
  const _origUpdate=window.gridUpdateContract;
  // Patch is done by checking dabTrades inside the existing gridUpdateContract,
  // not by wrapping (gridUpdateContract already checks dabTrades via reference).

  /* ── AUTO FIRE ────────────────────────────────────────────── */
  let dabAutoRunning=false,dabAutoTimer=null,dabAutoFired=0;

  window.dabToggleAuto=function(){
    if(dabAutoRunning){dabStopAuto('stopped by user');}
    else{dabStartAuto();}
  };

  function dabStartAuto(){
    if(typeof gridWs==='undefined'||!gridWs||gridWs.readyState!==1){
      dabSet('dabStatus','Not connected.');return;
    }
    dabAutoRunning=true;dabAutoFired=0;
    const btn=document.getElementById('dabAutoBtn');
    if(btn){btn.textContent='⏹ STOP AUTO FIRE';btn.classList.add('firing');}
    dabSet('dabStatus','Auto fire armed — firing on interval…');
    dabScheduleNext();
  }

  function dabStopAuto(reason){
    dabAutoRunning=false;
    if(dabAutoTimer){clearTimeout(dabAutoTimer);dabAutoTimer=null;}
    const btn=document.getElementById('dabAutoBtn');
    if(btn){btn.textContent='⚡ START AUTO FIRE';btn.classList.remove('firing');}
    dabSet('dabStatus','Auto fire stopped'+(reason?' ('+reason+')':'')+'.');
  }

  function dabScheduleNext(){
    if(!dabAutoRunning)return;
    const maxN=Math.max(0,parseInt(dabGet('dabAutoMax')||'0',10));
    if(maxN&&dabAutoFired>=maxN){dabStopAuto('reached '+maxN+' fires');return;}
    const interval=Math.max(1,parseFloat(dabGet('dabAutoInterval')||'6'))*1000;
    dabAutoTimer=setTimeout(()=>{
      if(!dabAutoRunning)return;
      // Determine direction from auto-dir setting
      const dir_pref=dabGet('dabAutoDir');
      let dir;
      if(dir_pref==='up') dir=1;
      else if(dir_pref==='down') dir=-1;
      else dir=(Math.random()>0.5?1:-1); // both: alternate randomly
      dabFire(dir,'auto');
      dabAutoFired++;
      dabSet('dabStatus',`Auto fired #${dabAutoFired}${maxN?' of '+maxN:''} — ${dir===1?'UP':'DOWN'}`);
      dabScheduleNext();
    },interval);
  }

  /* ── refresh loop ─────────────────────────────────────────── */
  function dabRefresh(){
    dabRefreshConn();
    // live price
    const price=(typeof lastPrice!=='undefined'&&lastPrice!=null)?lastPrice:null;
    const dec=(typeof decimals!=='undefined'?decimals:2);
    const prEl=document.getElementById('dabPrice');
    if(prEl&&price!=null){
      const prev=prEl._prev;
      prEl.textContent=Number(price).toFixed(dec);
      prEl.style.color=prev==null?'#e6ebf5':price>prev?'#16e08b':price<prev?'#ff4d5e':'#e6ebf5';
      prEl._prev=price;
    }
    const dir=(typeof runDir!=='undefined'?runDir:0);
    const rLen=(typeof runLen!=='undefined'?runLen:0);
    const sym=(typeof SYMBOL!=='undefined'?SYMBOL:'');
    const mkts=(typeof MARKETS!=='undefined'?MARKETS:{});
    const mktName=(mkts[sym]||sym).replace('Volatility ','V').replace(' Index','').replace(/[()]/g,'');
    dabSet('dabPriceSub',rLen>0?(dir===1?'▲':'▼')+' run '+rLen:mktName);
  }

  /* ── init ─────────────────────────────────────────────────── */
  loadPos();
  setInterval(dabRefresh,300);
  dabRefresh();
  dabOnContractChange(); // set initial labels

  // Make dabRenderStats accessible so gridUpdateContract can trigger it
  window._dabRenderStats=dabRenderStats;
  window._dabTrades=dabTrades;
  // Register multiplier record callback
  const _prevMultRecord=window._multRecord;
  window._multRecord=function(id,stk,won){
    if(_prevMultRecord) _prevMultRecord(id,stk,won);
    if(dabMult&&dabTrades.some(t=>t.id===id)) dabMult.record(stk,won);
  };
})();
