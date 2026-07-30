// ML FEATURE ENGINEERING ENGINE
// Generates 150+ derived features from the 12-column indicator window
// (B-3…B-1, P1…P5, A-1…A-4) for every signal record, then ranks them
// using in-browser mutual information, Random Forest importance (CART
// approximation), and SHAP values (TreeExplainer linear approximation).
// =====================================================================

// ── Feature definitions ─────────────────────────────────────────────
// Each feature: { id, label, family, phase:'B'|'P'|'A'|'all', fn(snaps) }
// snaps = array of 12 snapshots (index 0=B-3, 3=P1, 8=A-1); may contain nulls.
// fn returns a single number or null.

const _FEAT_DEFS = (function(){
  // ── Helpers ───────────────────────────────────────────────────────────
  // Safe get — returns null if snapshot missing or field NaN/null
  const g  = (s,k)=>(s&&s[k]!=null&&!isNaN(s[k]))?s[k]:null;
  // Slope: null if either endpoint missing
  const sl = (a,b)=>(a!=null&&b!=null)?(b-a):null;
  // Acceleration = second derivative
  const ac = (p,a,b)=>{ const s1=sl(p,a),s2=sl(a,b); return(s1!=null&&s2!=null)?s2-s1:null; };
  // Mean of array, null-safe
  const mn = arr=>{ const v=arr.filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0)/v.length:null; };
  // Sign
  const sg = v=>v==null?null:v>0?1:v<0?-1:0;
  // Clamp ratio to [-3,3] for stability
  const ratio = (a,b)=>(a!=null&&b!=null&&Math.abs(b)>1e-9)?Math.max(-3,Math.min(3,a/b)):null;

  // Column indices — B-window only (indices 0,1,2)
  const B3=0,B2=1,B1=2;
  const bCols=[0,1,2];

  const defs=[]; let id=0;
  const add=(label,family,phase,fn)=>defs.push({id:id++,label,family,phase,fn});

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 1: SLOPE — signed continuous (captures direction naturally)
  // 15 indicators × 3 transitions = 45 features
  // ═════════════════════════════════════════════════════════════════════
  const SLOPE_IND=[
    ['macd','MACD'],['signal','Signal'],['hist','Hist'],
    ['chop','Chop'],['cci','CCI'],['bbPctB','BB%B'],
    ['pdi','+DI'],['ndi','-DI'],['adx','ADX'],
    ['rsi','RSI'],['atr','ATR'],['stochK','Stoch%K'],['roc','ROC'],
    ['ema5','EMA5'],['ema20','EMA20'],
  ];
  SLOPE_IND.forEach(([k,lbl])=>{
    add(`${lbl} sl B3→B2`,'Slope','B',s=>sl(g(s[B3],k),g(s[B2],k)));
    add(`${lbl} sl B2→B1`,'Slope','B',s=>sl(g(s[B2],k),g(s[B1],k)));
    add(`${lbl} sl B3→B1`,'Slope','B',s=>sl(g(s[B3],k),g(s[B1],k)));
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 2: ACCELERATION — 2nd derivative (curvature / regime change)
  // 6 indicators × 1 = 6 features
  // ═════════════════════════════════════════════════════════════════════
  [['macd','MACD'],['hist','Hist'],['cci','CCI'],
   ['rsi','RSI'],['adx','ADX'],['stochK','Stoch%K']].forEach(([k,lbl])=>{
    add(`${lbl} accel B`,'Accel','B',s=>ac(g(s[B3],k),g(s[B2],k),g(s[B1],k)));
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 3: LEVEL — signed distance, not binary flags
  // Binary flags caused prediction bias; signed distance is symmetric
  // ═════════════════════════════════════════════════════════════════════
  add('RSI-50 B1',   'Level','B',s=>{ const v=g(s[B1],'rsi'); return v!=null?v-50:null; });
  add('RSI-50 B2',   'Level','B',s=>{ const v=g(s[B2],'rsi'); return v!=null?v-50:null; });
  add('RSI-50 B3',   'Level','B',s=>{ const v=g(s[B3],'rsi'); return v!=null?v-50:null; });
  add('CCI/100 B1',  'Level','B',s=>{ const v=g(s[B1],'cci'); return v!=null?v/100:null; });
  add('CCI/100 B2',  'Level','B',s=>{ const v=g(s[B2],'cci'); return v!=null?v/100:null; });
  add('Stoch-50 B1', 'Level','B',s=>{ const v=g(s[B1],'stochK'); return v!=null?v-50:null; });
  add('Stoch-50 B2', 'Level','B',s=>{ const v=g(s[B2],'stochK'); return v!=null?v-50:null; });
  add('DI spread B1','Level','B',s=>{ const p=g(s[B1],'pdi'),n=g(s[B1],'ndi'); return(p!=null&&n!=null)?p-n:null; });
  add('DI spread B2','Level','B',s=>{ const p=g(s[B2],'pdi'),n=g(s[B2],'ndi'); return(p!=null&&n!=null)?p-n:null; });
  add('DI spread B3','Level','B',s=>{ const p=g(s[B3],'pdi'),n=g(s[B3],'ndi'); return(p!=null&&n!=null)?p-n:null; });
  add('ADX B1',      'Level','B',s=>g(s[B1],'adx'));
  add('ADX B2',      'Level','B',s=>g(s[B2],'adx'));
  add('BB%B-0.5 B1', 'Level','B',s=>{ const v=g(s[B1],'bbPctB'); return v!=null?v-0.5:null; }); // symmetric: + near upper, - near lower
  add('BB%B-0.5 B2', 'Level','B',s=>{ const v=g(s[B2],'bbPctB'); return v!=null?v-0.5:null; });
  add('ROC B1',      'Level','B',s=>g(s[B1],'roc'));
  add('ROC B2',      'Level','B',s=>g(s[B2],'roc'));
  add('MACD B1',     'Level','B',s=>g(s[B1],'macd'));
  add('Hist B1',     'Level','B',s=>g(s[B1],'hist'));
  add('Hist B2',     'Level','B',s=>g(s[B2],'hist'));
  add('Chop-50 B1',  'Level','B',s=>{ const v=g(s[B1],'chop'); return v!=null?v-50:null; }); // negative = trending, positive = choppy
  add('EMA5-EMA20 B1','Level','B',s=>{ const a=g(s[B1],'ema5'),b=g(s[B1],'ema20'); return(a!=null&&b!=null)?a-b:null; });
  add('EMA5-EMA20 B2','Level','B',s=>{ const a=g(s[B2],'ema5'),b=g(s[B2],'ema20'); return(a!=null&&b!=null)?a-b:null; });
  add('EMA5-EMA10 B1','Level','B',s=>{ const a=g(s[B1],'ema5'),b=g(s[B1],'ema10'); return(a!=null&&b!=null)?a-b:null; });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 4: HISTOGRAM BEHAVIOUR
  // ═════════════════════════════════════════════════════════════════════
  add('Hist mean B',    'Hist','B',s=>mn(bCols.map(i=>g(s[i],'hist'))));
  add('Hist cumsum B',  'Hist','B',s=>{ const v=bCols.map(i=>g(s[i],'hist')).filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+b,0):null; });
  add('Hist accel B',   'Hist','B',s=>ac(g(s[B3],'hist'),g(s[B2],'hist'),g(s[B1],'hist')));
  add('Hist sign flips B','Hist','B',s=>{
    const v=bCols.map(i=>sg(g(s[i],'hist'))).filter(x=>x!=null);
    let c=0; for(let i=1;i<v.length;i++) if(v[i]!==v[i-1]) c++;
    return v.length>1?c:null;
  });
  add('Hist all pos B', 'Hist','B',s=>+(bCols.every(i=>{ const v=g(s[i],'hist'); return v!=null&&v>0; })));
  add('Hist all neg B', 'Hist','B',s=>+(bCols.every(i=>{ const v=g(s[i],'hist'); return v!=null&&v<0; })));
  // Histogram momentum: B1 vs mean(B3,B2) — captures late acceleration
  add('Hist late accel','Hist','B',s=>{
    const avg=mn([g(s[B3],'hist'),g(s[B2],'hist')]),b1=g(s[B1],'hist');
    return(avg!=null&&b1!=null)?b1-avg:null;
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 5: CHOPPINESS BEHAVIOUR
  // ═════════════════════════════════════════════════════════════════════
  add('Chop mean B',    'Chop','B',s=>mn(bCols.map(i=>g(s[i],'chop'))));
  add('Chop delta B',   'Chop','B',s=>sl(g(s[B3],'chop'),g(s[B1],'chop')));
  add('Chop range B',   'Chop','B',s=>{ const v=bCols.map(i=>g(s[i],'chop')).filter(x=>x!=null); return v.length?msdSafeMax(v)-msdSafeMin(v):null; });
  add('Chop accel B',   'Chop','B',s=>ac(g(s[B3],'chop'),g(s[B2],'chop'),g(s[B1],'chop')));
  // Chop falling = trending emerging (key pre-run signal)
  add('Chop falling B', 'Chop','B',s=>{ const d=sl(g(s[B3],'chop'),g(s[B1],'chop')); return d!=null?+(d<0):null; });
  add('Chop late drop', 'Chop','B',s=>sl(g(s[B2],'chop'),g(s[B1],'chop'))); // final tick drop most predictive

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 6: CCI BEHAVIOUR
  // ═════════════════════════════════════════════════════════════════════
  add('CCI mean B',     'CCI','B',s=>mn(bCols.map(i=>g(s[i],'cci'))));
  add('CCI delta B',    'CCI','B',s=>sl(g(s[B3],'cci'),g(s[B1],'cci')));
  add('CCI accel B',    'CCI','B',s=>ac(g(s[B3],'cci'),g(s[B2],'cci'),g(s[B1],'cci')));
  add('CCI abs max B',  'CCI','B',s=>{ const v=bCols.map(i=>g(s[i],'cci')).filter(x=>x!=null); return v.length?msdSafeMax(v.map(Math.abs)):null; });
  add('CCI monotone B', 'CCI','B',s=>{
    const v=bCols.map(i=>g(s[i],'cci')).filter(x=>x!=null);
    if(v.length<2) return null;
    return+(v.every((x,i)=>i===0||x>=v[i-1])||v.every((x,i)=>i===0||x<=v[i-1]));
  });
  // CCI signed momentum: direction of move weighted by magnitude
  add('CCI momentum B', 'CCI','B',s=>{ const d=sl(g(s[B2],'cci'),g(s[B1],'cci')); const mag=g(s[B1],'cci'); return(d!=null&&mag!=null)?d*Math.sign(mag):null; });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 7: BOLLINGER — width, squeeze, distance, expansion rate
  // ═════════════════════════════════════════════════════════════════════
  // Raw width (not normalised — absolute band spread)
  const bbW=(s,ci)=>{ const u=g(s[ci],'bbUpper'),l=g(s[ci],'bbLower'); return(u!=null&&l!=null)?u-l:null; };
  add('BB width B1',    'BB','B',s=>bbW(s,B1));
  add('BB width B2',    'BB','B',s=>bbW(s,B2));
  add('BB width B3',    'BB','B',s=>bbW(s,B3));
  // Width contraction — negative = bands narrowing (compression before burst)
  add('BB width delta B','BB','B',s=>sl(bbW(s,B3),bbW(s,B1)));
  add('BB width accel B','BB','B',s=>ac(bbW(s,B3),bbW(s,B2),bbW(s,B1)));
  // Normalised width = width/mid (bandwidth%)
  add('BB norm width B1','BB','B',s=>{ const w=bbW(s,B1),m=g(s[B1],'bbMid'); return(w!=null&&m!=null&&m>0)?w/m*100:null; });
  add('BB norm width B2','BB','B',s=>{ const w=bbW(s,B2),m=g(s[B2],'bbMid'); return(w!=null&&m!=null&&m>0)?w/m*100:null; });
  // Squeeze: normalised width < 0.05% (very tight bands)
  add('BB squeeze B1',  'BB','B',s=>{ const nw=bbW(s,B1)!=null&&g(s[B1],'bbMid')!=null?bbW(s,B1)/g(s[B1],'bbMid')*100:null; return nw!=null?+(nw<0.05):null; });
  // BB%B signed (symmetric around 0.5)
  add('BB%B-0.5 B3',   'BB','B',s=>{ const v=g(s[B3],'bbPctB'); return v!=null?v-0.5:null; });
  add('BB%B slope B3→B1','BB','B',s=>sl(g(s[B3],'bbPctB'),g(s[B1],'bbPctB')));
  add('BB%B slope B2→B1','BB','B',s=>sl(g(s[B2],'bbPctB'),g(s[B1],'bbPctB')));
  add('BB%B accel B',   'BB','B',s=>ac(g(s[B3],'bbPctB'),g(s[B2],'bbPctB'),g(s[B1],'bbPctB')));
  // Distance from middle band (signed: + = above mid, - = below)
  add('Price-BBmid B1', 'BB','B',s=>{ const p=g(s[B1],'price'),m=g(s[B1],'bbMid'); return(p!=null&&m!=null)?p-m:null; });
  add('Price-BBmid B2', 'BB','B',s=>{ const p=g(s[B2],'price'),m=g(s[B2],'bbMid'); return(p!=null&&m!=null)?p-m:null; });
  // Normalised distance from mid (scale-independent)
  add('Price-BBmid/W B1','BB','B',s=>{ const p=g(s[B1],'price'),m=g(s[B1],'bbMid'),w=bbW(s,B1); return(p!=null&&m!=null&&w!=null&&w>0)?(p-m)/w:null; });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 8: MACD SIGNAL GAP & MOMENTUM
  // ═════════════════════════════════════════════════════════════════════
  add('MACD-Sig gap B1','MACD','B',s=>{ const m=g(s[B1],'macd'),sg2=g(s[B1],'signal'); return(m!=null&&sg2!=null)?m-sg2:null; });
  add('MACD-Sig gap B2','MACD','B',s=>{ const m=g(s[B2],'macd'),sg2=g(s[B2],'signal'); return(m!=null&&sg2!=null)?m-sg2:null; });
  add('MACD-Sig gap B3','MACD','B',s=>{ const m=g(s[B3],'macd'),sg2=g(s[B3],'signal'); return(m!=null&&sg2!=null)?m-sg2:null; });
  // Gap expanding (crossover momentum)
  add('MACD gap expanding','MACD','B',s=>{
    const g1=(g(s[B2],'macd')!=null&&g(s[B2],'signal')!=null)?g(s[B2],'macd')-g(s[B2],'signal'):null;
    const g2=(g(s[B1],'macd')!=null&&g(s[B1],'signal')!=null)?g(s[B1],'macd')-g(s[B1],'signal'):null;
    return(g1!=null&&g2!=null)?+(Math.abs(g2)>Math.abs(g1)):null;
  });
  add('MACD cross B',  'MACD','B',s=>{
    for(let i=1;i<bCols.length;i++){
      const m0=g(s[bCols[i-1]],'macd'),s0=g(s[bCols[i-1]],'signal');
      const m1=g(s[bCols[i]],'macd'),  s1=g(s[bCols[i]],'signal');
      if(m0!=null&&s0!=null&&m1!=null&&s1!=null&&Math.sign(m0-s0)!==Math.sign(m1-s1)) return 1;
    }
    return 0;
  });
  add('MACD mean B',   'MACD','B',s=>mn(bCols.map(i=>g(s[i],'macd'))));
  add('MACD accel B',  'MACD','B',s=>ac(g(s[B3],'macd'),g(s[B2],'macd'),g(s[B1],'macd')));

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 9: PRICE & VOLATILITY — scale-independent where possible
  // ═════════════════════════════════════════════════════════════════════
  add('PriceVel B3→B1','Price','B',s=>sl(g(s[B3],'price'),g(s[B1],'price')));
  add('PriceVel B2→B1','Price','B',s=>sl(g(s[B2],'price'),g(s[B1],'price')));
  add('Price accel B',  'Price','B',s=>ac(g(s[B3],'price'),g(s[B2],'price'),g(s[B1],'price')));
  add('Price range B',  'Price','B',s=>{ const v=bCols.map(i=>g(s[i],'price')).filter(x=>x!=null); return v.length?msdSafeMax(v)-msdSafeMin(v):null; });
  // ATR
  add('ATR B1',         'Price','B',s=>g(s[B1],'atr'));
  add('ATR B2',         'Price','B',s=>g(s[B2],'atr'));
  add('ATR delta B',    'Price','B',s=>sl(g(s[B3],'atr'),g(s[B1],'atr'))); // ATR expansion rate
  add('ATR accel B',    'Price','B',s=>ac(g(s[B3],'atr'),g(s[B2],'atr'),g(s[B1],'atr')));
  // Price velocity normalised by ATR (scale-independent momentum)
  add('PriceVel/ATR B', 'Price','B',s=>ratio(sl(g(s[B3],'price'),g(s[B1],'price')),g(s[B1],'atr')));
  // EMA deviations (signed, normalised by ATR)
  add('P-EMA5 B1',      'Price','B',s=>{ const p=g(s[B1],'price'),e=g(s[B1],'ema5'); return(p!=null&&e!=null)?p-e:null; });
  add('P-EMA20 B1',     'Price','B',s=>{ const p=g(s[B1],'price'),e=g(s[B1],'ema20'); return(p!=null&&e!=null)?p-e:null; });
  add('P-EMA5/ATR B1',  'Price','B',s=>ratio(g(s[B1],'price')!=null&&g(s[B1],'ema5')!=null?g(s[B1],'price')-g(s[B1],'ema5'):null,g(s[B1],'atr')));
  add('P-EMA20/ATR B1', 'Price','B',s=>ratio(g(s[B1],'price')!=null&&g(s[B1],'ema20')!=null?g(s[B1],'price')-g(s[B1],'ema20'):null,g(s[B1],'atr')));
  add('EMA5-EMA20 B1',  'Price','B',s=>{ const a=g(s[B1],'ema5'),b=g(s[B1],'ema20'); return(a!=null&&b!=null)?a-b:null; });
  add('EMA5-EMA10 B1',  'Price','B',s=>{ const a=g(s[B1],'ema5'),b=g(s[B1],'ema10'); return(a!=null&&b!=null)?a-b:null; });
  add('EMA10-EMA20 B1', 'Price','B',s=>{ const a=g(s[B1],'ema10'),b=g(s[B1],'ema20'); return(a!=null&&b!=null)?a-b:null; });
  add('ROC B1',         'Price','B',s=>g(s[B1],'roc'));
  add('ROC B2',         'Price','B',s=>g(s[B2],'roc'));
  add('ROC accel B',    'Price','B',s=>ac(g(s[B3],'roc'),g(s[B2],'roc'),g(s[B1],'roc')));
  // Rolling volatility ratio: ATR B1 / ATR B3 (>1 = expanding volatility = regime change)
  add('ATR ratio B1/B3','Price','B',s=>ratio(g(s[B1],'atr'),g(s[B3],'atr')));

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 10: RSI BEHAVIOUR
  // ═════════════════════════════════════════════════════════════════════
  add('RSI mean B',    'RSI','B',s=>mn(bCols.map(i=>g(s[i],'rsi'))));
  add('RSI accel B',   'RSI','B',s=>ac(g(s[B3],'rsi'),g(s[B2],'rsi'),g(s[B1],'rsi')));
  add('RSI late sl',   'RSI','B',s=>sl(g(s[B2],'rsi'),g(s[B1],'rsi')));
  add('RSI early sl',  'RSI','B',s=>sl(g(s[B3],'rsi'),g(s[B2],'rsi')));
  // Mean reversion distance: how far RSI is from 50 (extreme = overextended)
  add('RSI |dev| B1',  'RSI','B',s=>{ const v=g(s[B1],'rsi'); return v!=null?Math.abs(v-50):null; });
  // RSI momentum: direction × magnitude
  add('RSI dir×mag B1','RSI','B',s=>{ const v=g(s[B1],'rsi'),d=sl(g(s[B2],'rsi'),g(s[B1],'rsi')); return(v!=null&&d!=null)?d*Math.sign(v-50):null; });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 11: STOCHASTIC & DMI
  // ═════════════════════════════════════════════════════════════════════
  add('Stoch%K-D B1',  'Stoch','B',s=>{ const k=g(s[B1],'stochK'),d=g(s[B1],'stochD'); return(k!=null&&d!=null)?k-d:null; });
  add('Stoch%K-D B2',  'Stoch','B',s=>{ const k=g(s[B2],'stochK'),d=g(s[B2],'stochD'); return(k!=null&&d!=null)?k-d:null; });
  add('Stoch K accel', 'Stoch','B',s=>ac(g(s[B3],'stochK'),g(s[B2],'stochK'),g(s[B1],'stochK')));
  add('ADX mean B',    'DMI','B',s=>mn(bCols.map(i=>g(s[i],'adx'))));
  add('ADX accel B',   'DMI','B',s=>ac(g(s[B3],'adx'),g(s[B2],'adx'),g(s[B1],'adx')));
  // DI divergence trend (is bullish/bearish bias growing?)
  add('DI spread accel B','DMI','B',s=>{
    const sp=(ci)=>{ const p=g(s[ci],'pdi'),n=g(s[ci],'ndi'); return(p!=null&&n!=null)?p-n:null; };
    return ac(sp(B3),sp(B2),sp(B1));
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 12: NEW VOLATILITY & REGIME FEATURES (as requested)
  // ═════════════════════════════════════════════════════════════════════
  // 12a. BB width contraction index (negative = contracting = compression before burst)
  add('BB contraction B','Regime','B',s=>{
    const w1=bbW(s,B1),w2=bbW(s,B2),w3=bbW(s,B3);
    if(w1==null||w2==null||w3==null) return null;
    // Slope of slope: negative = accelerating contraction
    return ac(w3,w2,w1);
  });
  // 12b. ATR expansion rate (>0 = energy building)
  add('ATR exp rate B', 'Regime','B',s=>sl(g(s[B3],'atr'),g(s[B1],'atr')));
  add('ATR exp/ATR B1', 'Regime','B',s=>ratio(sl(g(s[B3],'atr'),g(s[B1],'atr')),g(s[B1],'atr')));
  // 12c. Volatility ratio: recent ATR vs earlier (regime shift)
  add('Vol ratio late/early','Regime','B',s=>ratio(g(s[B1],'atr'),g(s[B3],'atr')));
  // 12d. Approximate entropy over 3 B-ticks (low entropy = persistent move)
  add('Price entropy B','Regime','B',s=>{
    const v=[g(s[B3],'price'),g(s[B2],'price'),g(s[B1],'price')].filter(x=>x!=null);
    if(v.length<2) return null;
    // Simplified entropy: variance of first differences (low = persistent, high = noisy)
    const diffs=v.slice(1).map((x,i)=>x-v[i]);
    const mu=diffs.reduce((a,b)=>a+b,0)/diffs.length;
    const va=diffs.reduce((a,d)=>a+(d-mu)**2,0)/diffs.length;
    return va; // low = ordered (trending), high = chaotic
  });
  // 12e. Persistence score: do all 3 B-ticks move the same way?
  add('Persist score B','Regime','B',s=>{
    const p=[g(s[B3],'price'),g(s[B2],'price'),g(s[B1],'price')];
    if(p.some(x=>x==null)) return null;
    const dirs=p.slice(1).map((x,i)=>Math.sign(x-p[i]));
    // +1=all same direction, 0=mixed, -1=reversal
    if(dirs.every(d=>d===1)) return 1;
    if(dirs.every(d=>d===-1)) return -1;
    return 0;
  });
  // 12f. Mean reversion distance: |price - EMA20| / ATR (how stretched?)
  add('MeanRev dist B1','Regime','B',s=>{ const p=g(s[B1],'price'),e=g(s[B1],'ema20'),a=g(s[B1],'atr'); return(p!=null&&e!=null&&a!=null&&a>0)?Math.abs(p-e)/a:null; });
  add('MeanRev signed B1','Regime','B',s=>{ const p=g(s[B1],'price'),e=g(s[B1],'ema20'),a=g(s[B1],'atr'); return(p!=null&&e!=null&&a!=null&&a>0)?(p-e)/a:null; });
  // 12g. Number of indicator crossovers in B-window (0,1,2,3 = transition density)
  add('Crossovers B',  'Regime','B',s=>{
    let crosses=0;
    // MACD/Signal cross
    for(let i=1;i<bCols.length;i++){
      const m0=g(s[bCols[i-1]],'macd'),s0=g(s[bCols[i-1]],'signal'),m1=g(s[bCols[i]],'macd'),s1=g(s[bCols[i]],'signal');
      if(m0!=null&&s0!=null&&m1!=null&&s1!=null&&Math.sign(m0-s0)!==Math.sign(m1-s1)) crosses++;
    }
    // Stoch%K cross above/below 50
    for(let i=1;i<bCols.length;i++){
      const k0=g(s[bCols[i-1]],'stochK'),k1=g(s[bCols[i]],'stochK');
      if(k0!=null&&k1!=null&&Math.sign(k0-50)!==Math.sign(k1-50)) crosses++;
    }
    // RSI cross above/below 50
    for(let i=1;i<bCols.length;i++){
      const r0=g(s[bCols[i-1]],'rsi'),r1=g(s[bCols[i]],'rsi');
      if(r0!=null&&r1!=null&&Math.sign(r0-50)!==Math.sign(r1-50)) crosses++;
    }
    // DI cross (+DI/-DI flip)
    for(let i=1;i<bCols.length;i++){
      const d0=(g(s[bCols[i-1]],'pdi')!=null&&g(s[bCols[i-1]],'ndi')!=null)?g(s[bCols[i-1]],'pdi')-g(s[bCols[i-1]],'ndi'):null;
      const d1=(g(s[bCols[i]],'pdi')!=null&&g(s[bCols[i]],'ndi')!=null)?g(s[bCols[i]],'pdi')-g(s[bCols[i]],'ndi'):null;
      if(d0!=null&&d1!=null&&Math.sign(d0)!==Math.sign(d1)) crosses++;
    }
    return crosses;
  });
  // 12h. Local trend curvature = price acceleration normalised by ATR
  add('Price curv/ATR B','Regime','B',s=>ratio(ac(g(s[B3],'price'),g(s[B2],'price'),g(s[B1],'price')),g(s[B1],'atr')));
  add('MACD curv B',   'Regime','B',s=>ac(g(s[B3],'macd'),g(s[B2],'macd'),g(s[B1],'macd')));
  add('BB curv/ATR B', 'Regime','B',s=>ratio(ac(bbW(s,B3),bbW(s,B2),bbW(s,B1)),g(s[B1],'atr')));

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 13: INTERACTION — meaningful cross-terms only
  // (reduced from before; quality > quantity for cross-terms)
  // ═════════════════════════════════════════════════════════════════════
  // ADX × DI spread: strong trend in a direction
  add('ADX×DIspread B1','Interact','B',s=>{
    const sp=(g(s[B1],'pdi')!=null&&g(s[B1],'ndi')!=null)?g(s[B1],'pdi')-g(s[B1],'ndi'):null;
    const adx=g(s[B1],'adx');
    return(sp!=null&&adx!=null)?sp*adx/100:null;  // divided by 100 to keep scale manageable
  });
  // Chop × |Hist|: is histogram moving in a trending market?
  add('Chop×|Hist| B1', 'Interact','B',s=>{ const ch=g(s[B1],'chop'),h=g(s[B1],'hist'); return(ch!=null&&h!=null)?(50-ch)*h:null; });
  // RSI × Hist sign: RSI direction agrees with histogram
  add('RSI×Hist B1',    'Interact','B',s=>{ const r=g(s[B1],'rsi'),h=g(s[B1],'hist'); return(r!=null&&h!=null)?(r-50)*h:null; });
  // BB%B × CCI: both at extremes (breakout setup)
  add('BB%B×CCI B1',    'Interact','B',s=>{ const b=g(s[B1],'bbPctB'),c=g(s[B1],'cci'); return(b!=null&&c!=null)?(b-0.5)*c:null; });
  // PriceVel/ATR × DI spread: momentum with directional conviction
  add('Vel/ATR×DI B1',  'Interact','B',s=>{
    const pv=sl(g(s[B3],'price'),g(s[B1],'price')),at=g(s[B1],'atr');
    const sp=(g(s[B1],'pdi')!=null&&g(s[B1],'ndi')!=null)?g(s[B1],'pdi')-g(s[B1],'ndi'):null;
    return(pv!=null&&at!=null&&at>0&&sp!=null)?(pv/at)*sp/100:null;
  });
  // EMA alignment × MACD
  add('EMAalign×MACD B1','Interact','B',s=>{
    const e5=g(s[B1],'ema5'),e10=g(s[B1],'ema10'),e20=g(s[B1],'ema20'),m=g(s[B1],'macd');
    if(e5==null||e10==null||e20==null||m==null) return null;
    // +1 = bullish stack (5>10>20), -1 = bearish stack, 0 = mixed
    const align=e5>e10&&e10>e20?1:e5<e10&&e10<e20?-1:0;
    return align*m;
  });
  // Hist accel × CCI (late histogram push with CCI support)
  add('HAccel×CCI B1', 'Interact','B',s=>{
    const ha=ac(g(s[B3],'hist'),g(s[B2],'hist'),g(s[B1],'hist'));
    return(ha!=null&&g(s[B1],'cci')!=null)?ha*g(s[B1],'cci')/100:null;
  });
  // Contraction × ROC: squeeze with momentum building
  add('BBcont×ROC B',  'Interact','B',s=>{
    const w1=bbW(s,B1),w3=bbW(s,B3),roc=g(s[B1],'roc');
    if(w1==null||w3==null||w3===0||roc==null) return null;
    const cont=1-(w1/w3);  // positive = contracting
    return cont*roc;
  });
  // Stoch-50 × RSI-50: both indicators agree on direction
  add('Stoch×RSI dir B1','Interact','B',s=>{
    const st=g(s[B1],'stochK'),rs=g(s[B1],'rsi');
    return(st!=null&&rs!=null)?(st-50)*(rs-50)/2500:null;  // normalised product
  });
  // ADX × BB contraction: trending into a squeeze = high probability burst
  add('ADX×BBcont B',  'Interact','B',s=>{
    const w1=bbW(s,B1),w3=bbW(s,B3),adx=g(s[B1],'adx');
    if(w1==null||w3==null||w3===0||adx==null) return null;
    const cont=1-(w1/w3);
    return cont*adx/100;
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 14: INDICATOR AGREEMENT — directional consensus scoring
  // Symmetric: score > 0 = bullish agreement, < 0 = bearish agreement
  // ═════════════════════════════════════════════════════════════════════
  // Signed consensus at B1: each indicator votes +1 (bullish), -1 (bearish), 0 (neutral)
  add('Consensus signed B1','Agreement','B',s=>{
    const votes=[
      g(s[B1],'rsi')!=null?Math.sign(g(s[B1],'rsi')-50):null,
      g(s[B1],'hist')!=null?Math.sign(g(s[B1],'hist')):null,
      (g(s[B1],'pdi')!=null&&g(s[B1],'ndi')!=null)?Math.sign(g(s[B1],'pdi')-g(s[B1],'ndi')):null,
      g(s[B1],'bbPctB')!=null?Math.sign(g(s[B1],'bbPctB')-0.5):null,
      g(s[B1],'roc')!=null?Math.sign(g(s[B1],'roc')):null,
      g(s[B1],'macd')!=null?Math.sign(g(s[B1],'macd')):null,
      (g(s[B1],'stochK')!=null&&g(s[B1],'stochD')!=null)?Math.sign(g(s[B1],'stochK')-g(s[B1],'stochD')):null,
    ].filter(x=>x!=null);
    return votes.length?votes.reduce((a,b)=>a+b,0)/votes.length:null;  // range [-1,+1]
  });
  add('Consensus signed B2','Agreement','B',s=>{
    const votes=[
      g(s[B2],'rsi')!=null?Math.sign(g(s[B2],'rsi')-50):null,
      g(s[B2],'hist')!=null?Math.sign(g(s[B2],'hist')):null,
      (g(s[B2],'pdi')!=null&&g(s[B2],'ndi')!=null)?Math.sign(g(s[B2],'pdi')-g(s[B2],'ndi')):null,
      g(s[B2],'roc')!=null?Math.sign(g(s[B2],'roc')):null,
      g(s[B2],'macd')!=null?Math.sign(g(s[B2],'macd')):null,
    ].filter(x=>x!=null);
    return votes.length?votes.reduce((a,b)=>a+b,0)/votes.length:null;
  });
  // Consensus agreement score (how many of 7 indicators agree — unsigned count)
  add('Agreement count B1','Agreement','B',s=>{
    const votes=[
      g(s[B1],'rsi')!=null?Math.sign(g(s[B1],'rsi')-50):null,
      g(s[B1],'hist')!=null?Math.sign(g(s[B1],'hist')):null,
      (g(s[B1],'pdi')!=null&&g(s[B1],'ndi')!=null)?Math.sign(g(s[B1],'pdi')-g(s[B1],'ndi')):null,
      g(s[B1],'bbPctB')!=null?Math.sign(g(s[B1],'bbPctB')-0.5):null,
      g(s[B1],'roc')!=null?Math.sign(g(s[B1],'roc')):null,
      g(s[B1],'macd')!=null?Math.sign(g(s[B1],'macd')):null,
    ].filter(x=>x!=null);
    if(!votes.length) return null;
    const pos=votes.filter(v=>v>0).length, neg=votes.filter(v=>v<0).length;
    return Math.max(pos,neg)/votes.length;  // 1.0 = unanimous, 0.5 = split
  });
  // Consensus change B3→B1 (is agreement improving or deteriorating?)
  add('Consensus shift B','Agreement','B',s=>{
    const cs=(ci)=>{
      const votes=[
        g(s[ci],'rsi')!=null?Math.sign(g(s[ci],'rsi')-50):null,
        g(s[ci],'hist')!=null?Math.sign(g(s[ci],'hist')):null,
        g(s[ci],'roc')!=null?Math.sign(g(s[ci],'roc')):null,
        g(s[ci],'macd')!=null?Math.sign(g(s[ci],'macd')):null,
      ].filter(x=>x!=null);
      return votes.length?votes.reduce((a,b)=>a+b,0)/votes.length:null;
    };
    return sl(cs(B3),cs(B1));
  });
  // Turning together: count of indicators that changed direction B2→B1
  add('Inds turning B2→B1','Agreement','B',s=>{
    const pairs=[
      [g(s[B2],'hist'),g(s[B1],'hist')],
      [g(s[B2],'rsi'),g(s[B1],'rsi')],
      [g(s[B2],'macd'),g(s[B1],'macd')],
      [g(s[B2],'cci'),g(s[B1],'cci')],
      [g(s[B2],'roc'),g(s[B1],'roc')],
    ];
    let count=0;
    pairs.forEach(([a,b])=>{ if(a!=null&&b!=null&&Math.sign(b)!==Math.sign(a)) count++; });
    return count;
  });

  // ═════════════════════════════════════════════════════════════════════
  // FAMILY 15: DIVERGENCE PATTERNS
  // ═════════════════════════════════════════════════════════════════════
  add('MACD-price div B','Diverge','B',s=>{
    const ps=sl(g(s[B3],'price'),g(s[B1],'price'));
    const ms=sl(g(s[B3],'macd'),g(s[B1],'macd'));
    return(ps!=null&&ms!=null)?+(Math.sign(ps)!==Math.sign(ms)):null;
  });
  // Signed divergence: direction of divergence matters
  add('MACD div signed B','Diverge','B',s=>{
    const ps=sl(g(s[B3],'price'),g(s[B1],'price'));
    const ms=sl(g(s[B3],'macd'),g(s[B1],'macd'));
    if(ps==null||ms==null) return null;
    // +1 = bullish divergence (price down, MACD up), -1 = bearish, 0 = convergent
    if(ps<0&&ms>0) return 1;
    if(ps>0&&ms<0) return -1;
    return 0;
  });
  add('RSI-price div B', 'Diverge','B',s=>{
    const ps=sl(g(s[B3],'price'),g(s[B1],'price'));
    const rs=sl(g(s[B3],'rsi'),g(s[B1],'rsi'));
    if(ps==null||rs==null) return null;
    if(ps<0&&rs>0) return 1;
    if(ps>0&&rs<0) return -1;
    return 0;
  });
  add('Stoch-price div B','Diverge','B',s=>{
    const ps=sl(g(s[B3],'price'),g(s[B1],'price'));
    const ss=sl(g(s[B3],'stochK'),g(s[B1],'stochK'));
    if(ps==null||ss==null) return null;
    if(ps<0&&ss>0) return 1;
    if(ps>0&&ss<0) return -1;
    return 0;
  });

  return defs;
})();


// ── Feature computation engine ───────────────────────────────────────
let _featCache = null;  // { features:[], rankings:[], computed:Date }

function featComputeAll(){
  // Build feature matrix: rows = signal records, cols = features
  // Returns { matrix:[[]], labels:['rise'|'fall'], feats:[def] }
  if (!signalRecords.length) return null;
  const cols = anColumns();  // 12 column descriptors
  const matrix = [], labels = [];
  signalRecords.forEach(rec => {
    // Build snaps array indexed 0-11
    const snaps = cols.map((_, ci) => anSnapAt(rec, ci));
    const row = _FEAT_DEFS.map(f => {
      try { return f.fn(snaps); } catch(_){ return null; }
    });
    matrix.push(row);
    labels.push(rec.dir === 1 ? 1 : 0);  // 1=rise, 0=fall
  });
  return { matrix, labels, feats:_FEAT_DEFS };
}

function featMutualInfo(colVals, labels){
  // Discretise into 10 equal-width bins, compute H(Y) - H(Y|X)
  const n = colVals.length;
  const valid = colVals.map((v,i)=>[v,labels[i]]).filter(([v])=>v!=null);
  if (valid.length < 3) return 0;
  const vals = valid.map(([v])=>v);
  const lbs  = valid.map(([,l])=>l);
  const vmin=msdSafeMin(vals),vmax=msdSafeMax(vals);
  const rng=vmax-vmin;
  if (rng===0) return 0;
  const BINS=8;
  const bin=v=>Math.min(BINS-1,Math.floor((v-vmin)/rng*BINS));
  // joint counts
  const joint=Array.from({length:BINS},()=>[0,0]);
  lbs.forEach((l,i)=>joint[bin(vals[i])][l]++);
  const N=valid.length;
  const py=[lbs.filter(l=>l===0).length/N, lbs.filter(l=>l===1).length/N];
  let mi=0;
  for(let b=0;b<BINS;b++){
    const pb=(joint[b][0]+joint[b][1])/N;
    if(pb===0)continue;
    for(let c=0;c<2;c++){
      const pjt=joint[b][c]/N;
      if(pjt>0) mi+=pjt*Math.log2(pjt/(pb*py[c]));
    }
  }
  return Math.max(0,mi);
}

function featRfImportance(colVals, labels){
  // Approximate: information gain at a single optimal split
  const valid=colVals.map((v,i)=>[v,labels[i]]).filter(([v])=>v!=null);
  if(valid.length<4) return 0;
  const sorted=valid.slice().sort(([a],[b])=>a-b);
  const n=sorted.length;
  // Gini of full set
  const totalPos=sorted.filter(([,l])=>l===1).length;
  const giniNode=1-(totalPos/n)**2-((n-totalPos)/n)**2;
  let bestGain=0;
  // Try every mid-point split
  for(let i=1;i<n;i++){
    const lLeft=sorted.slice(0,i),lRight=sorted.slice(i);
    const lPos=lLeft.filter(([,l])=>l===1).length;
    const rPos=lRight.filter(([,l])=>l===1).length;
    const nl=lLeft.length,nr=lRight.length;
    const gL=1-(lPos/nl)**2-((nl-lPos)/nl)**2;
    const gR=1-(rPos/nr)**2-((nr-rPos)/nr)**2;
    const gain=giniNode-(nl/n*gL+nr/n*gR);
    if(gain>bestGain) bestGain=gain;
  }
  return bestGain;
}

function featShap(colVals, labels){
  // Linear SHAP approximation: |Pearson r| × std(feature)
  const valid=colVals.map((v,i)=>[v,labels[i]]).filter(([v])=>v!=null);
  if(valid.length<3) return 0;
  const vals=valid.map(([v])=>v);
  const lbs=valid.map(([,l])=>l);
  const n=vals.length;
  const mx=vals.reduce((a,b)=>a+b,0)/n;
  const my=lbs.reduce((a,b)=>a+b,0)/n;
  let num=0,dx2=0,dy2=0;
  vals.forEach((v,i)=>{ const dv=v-mx,dl=lbs[i]-my; num+=dv*dl; dx2+=dv*dv; dy2+=dl*dl; });
  const r=(dx2>0&&dy2>0)?num/Math.sqrt(dx2*dy2):0;
  const std=Math.sqrt(dx2/n);
  return Math.abs(r)*std;
}

function featPageInit(){
  const btn=$("featCompBtn");
  const status=$("featStatus");
  if(status){
    if(!signalRecords.length)
      status.textContent="No signal records yet — wait for 5-tick runs.";
    else
      status.textContent=`${signalRecords.length} signal record${signalRecords.length!==1?'s':''} available. Click Compute to rank features.`;
  }
  if(btn) btn.disabled=!signalRecords.length;
}

function featCompute(){
  const status=$("featStatus");
  if(!signalRecords.length){ if(status) status.textContent="No signal records."; return; }
  if(status) status.textContent="Computing…";

  setTimeout(()=>{  // let UI breathe
    try{
      const data=featComputeAll();
      if(!data){ if(status) status.textContent="Failed."; return; }
      const {matrix,labels,feats}=data;
      const nFeat=feats.length;

      // Compute all three scores per feature
      const rankings=feats.map((f,fi)=>{
        const colVals=matrix.map(row=>row[fi]);
        const riseVals=colVals.filter((_,i)=>labels[i]===1&&colVals[i]!=null);
        const fallVals=colVals.filter((_,i)=>labels[i]===0&&colVals[i]!=null);
        const rise_avg=riseVals.length?riseVals.reduce((a,b)=>a+b,0)/riseVals.length:null;
        const fall_avg=fallVals.length?fallVals.reduce((a,b)=>a+b,0)/fallVals.length:null;
        const mi=featMutualInfo(colVals,labels);
        const rfi=featRfImportance(colVals,labels);
        const shap=featShap(colVals,labels);
        const composite=(mi+rfi*2+shap)/4;  // weighted: RFI counts double
        return {f,fi,mi,rfi,shap,composite,rise_avg,fall_avg,delta:(rise_avg!=null&&fall_avg!=null)?rise_avg-fall_avg:null};
      });

      // Sort by composite descending
      rankings.sort((a,b)=>b.composite-a.composite);
      _featCache={rankings,matrix,labels,feats,computed:new Date()};

      // Render rank table (top 50 B-phase features only)
      const body=$("featRankBody");
      if(body){
        body.innerHTML=rankings.filter(r=>r.f.phase==='B').slice(0,50).map((r,rank)=>{
          const f2=v=>v!=null?v.toFixed(4):"—";
          const f3=v=>v!=null?v.toFixed(5):"—";
          return `<tr>
            <td class="l cell-mut">${rank+1}</td>
            <td class="l" style="font-size:11px;font-weight:600">${r.f.label}</td>
            <td class="l" style="color:#56b6ff;font-weight:700">B</td>
            <td class="l cell-mut" style="font-size:10px">${r.f.family}</td>
            <td>${f3(r.mi)}</td>
            <td>${f3(r.rfi)}</td>
            <td>${f3(r.shap)}</td>
            <td style="font-weight:800;color:var(--accent)">${f2(r.composite)}</td>
            <td style="color:var(--up)">${r.rise_avg!=null?r.rise_avg.toFixed(4):"—"}</td>
            <td style="color:var(--down)">${r.fall_avg!=null?r.fall_avg.toFixed(4):"—"}</td>
            <td style="${r.delta!=null?(r.delta>0?'color:var(--up)':'color:var(--down)'):'color:var(--muted)'};font-weight:700">
              ${r.delta!=null?(r.delta>0?'+':'')+r.delta.toFixed(4):"—"}
            </td>
          </tr>`;
        }).join("");
      }

      // Family breakdown
      const familyEl=$("featFamilyGrid");
      if(familyEl){
        const familyMap={};
        rankings.forEach(r=>{ if(!familyMap[r.f.family]) familyMap[r.f.family]=[]; familyMap[r.f.family].push(r); });
        familyEl.innerHTML=Object.entries(familyMap).sort(([,a],[,b])=>b[0].composite-a[0].composite).map(([fam,rs])=>{
          const top=rs[0];
          return `<div class="em-card" style="padding:10px 12px">
            <div class="em-lab">${fam} (${rs.length} features)</div>
            <div style="font-size:11px;font-weight:700;color:var(--accent);margin:4px 0">Best: ${top.f.label}</div>
            <div style="font-size:10px;color:var(--muted)">Composite: ${top.composite.toFixed(4)}</div>
          </div>`;
        }).join("");
      }

      // Deviation bars (top 20 by |delta|)
      const barsEl=$("featDeviationBars");
      if(barsEl){
        const withDelta=rankings.filter(r=>r.delta!=null).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,20);
        const maxD=msdSafeMax(withDelta.map(r=>Math.abs(r.delta)))||1;
        barsEl.innerHTML=withDelta.map(r=>{
          const pct=(Math.abs(r.delta)/maxD*100).toFixed(1);
          const col=r.delta>0?'var(--up)':'var(--down)';
          return `<div style="display:flex;align-items:center;gap:8px">
            <div style="width:200px;font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${r.f.label}">${r.f.label}</div>
            <div style="flex:1;background:#0a0e17;border-radius:3px;overflow:hidden;height:14px">
              <div style="width:${pct}%;background:${col};height:100%;border-radius:3px;transition:width .4s"></div>
            </div>
            <div style="width:70px;font-size:10px;font-variant-numeric:tabular-nums;color:${col};font-weight:700;text-align:right">
              ${r.delta>0?'+':''}${r.delta.toFixed(4)}
            </div>
            <div style="width:20px;font-size:9px;color:var(--muted);font-weight:700">${r.f.phase}</div>
          </div>`;
        }).join("");
      }

      // Enable CSV buttons
      ['featCsvBBtn'].forEach(id=>{const b=$(id);if(b)b.disabled=false;});
      if(status) status.textContent=`✅ ${nFeat} features computed · ${rankings.length} ranked · ${signalRecords.length} signal records · computed at ${new Date().toLocaleTimeString()}`;

    } catch(e){
      console.error('featCompute error:',e);
      if(status) status.textContent='Error: '+e.message;
    }
  }, 20);
}

function featExportCsv(phase){
  if(!_featCache){ alert("Compute features first."); return; }
  const {rankings,matrix,labels,feats}=_featCache;
  const N=signalRecords.length;
  const today=new Date().toISOString().slice(0,10);

  // Filter features by phase
  const phaseFeatIdxs=rankings
    .filter(r=>r.f.phase===phase)
    .map(r=>r.fi);

  const phaseFeatDefs=phaseFeatIdxs.map(fi=>feats[fi]);

  // Header: metadata + feature columns (sorted by importance)
  const header=["signal_no","epoch","datetime","direction",
    ...phaseFeatDefs.map(f=>f.label.replace(/[,\n]/g,' '))
  ].join(",");

  const rows=[header];
  signalRecords.forEach((rec,idx)=>{
    const sigNo=N-idx;
    const epoch=rec.epoch||"";
    const dt=epoch?new Date(epoch*1000).toISOString().replace("T"," ").slice(0,19):"";
    const dir=rec.dir===1?"rise":"fall";
    const matRow=matrix[idx];
    const vals=phaseFeatIdxs.map(fi=>{
      const v=matRow[fi];
      return v==null||isNaN(v)?"":Number(v).toFixed(6);
    });
    rows.push([sigNo,epoch,dt,dir,...vals].join(","));
  });

  const csv=rows.join("\r\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`mamba_features_${phase}_${SYMBOL}_${today}.csv`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

// =====================================================================
// FUTURE PROJECT — reverse window exports (this module is a PRODUCER of
// state/functions read by the classic main script -- same pattern as
// src/trading/fiveTickSignalEngine.js's Phase 1d export block. An ES
// module's top-level declarations do not auto-attach to `window`, and
// are not visible by bare name to classic scripts, so the module that
// owns each binding/function exposes it explicitly here.
//
// Verified call/read sites in index.html (outside this section, in the
// classic main script) that require each of these:
//   - _FEAT_DEFS      : read via `const feats=_FEAT_DEFS;` inside
//                       lmvBuildFeatureVector() -- never reassigned
//                       anywhere, so a getter-only accessor suffices.
//   - featComputeAll  : called bare (`featComputeAll()`) from three
//                       separate call sites in the prediction-model
//                       builder code.
//   - featMutualInfo, featRfImportance, featShap : called bare together
//                       in the same feature-selection loop.
//   - featPageInit    : called bare when the Features page is opened
//                       (mirrors the engPageReady pattern from Phase 1d).
//   - featCompute, featExportCsv : referenced from `onclick="..."` HTML
//                       attributes (`onclick="featCompute()"`,
//                       `onclick="featExportCsv('B')"`) -- these attribute
//                       strings are compiled into handlers lazily, at
//                       first click, by which point this module has long
//                       finished executing, so timing is not a concern.
//
// _featCache (the other top-level declaration in this module) has zero
// references outside this section and is not exported.
// =====================================================================
Object.defineProperty(window, '_FEAT_DEFS', {
  get: () => _FEAT_DEFS,
  configurable: true
});
window.featComputeAll = featComputeAll;
window.featMutualInfo = featMutualInfo;
window.featRfImportance = featRfImportance;
window.featShap = featShap;
window.featPageInit = featPageInit;
window.featCompute = featCompute;
window.featExportCsv = featExportCsv;
