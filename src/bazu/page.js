/**
 * src/bazu/page.js
 * BAZU page view. Sends commands to engine.js and renders its state — NO trading rules here.
 */
import { start as perfStart } from './perf3m.js?v=15';
import * as E from './engine.js?v=15';
import { clusterZones } from './structure.js?v=15';
import { TIMEFRAMES, timeframe, fmtPrice, localCandles, mergeLive } from './timeframes.js?v=15';
import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';
import { wilson } from './stats.js?v=15';
import { accountInfo } from './execution.js?v=15';
import { GATE } from './decision.js?v=15';
import { calibrationSummary, accuracyByDuration } from './calibration3m.js?v=15';
import { liveContractText } from './expiry3m.js?v=15';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const ci = (w) => (w && w.n ? `${pct(w.p)} <span class="mu">[${pct(w.lo)}–${pct(w.hi)}] n=${w.n}</span>` : '<span class="mu">no data</span>');
const money = (x) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2));
let tab = 'live', ready = false, tfKey = '10t';

function bindOnce() {
  $('bzTabs').onclick = (e) => { const t = e.target.dataset.t; if (!t) return; tab = t; [...$('bzTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); document.querySelectorAll('#page-bazu .bz-pane').forEach((p) => p.classList.toggle('on', p.id === 'bzp-' + t)); render(); };
  $('bzMode').onclick = (e) => { const m = e.target.dataset.m; if (!m) return; E.setMode(m); [...$('bzMode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === m)); };
  $('bzTf').innerHTML = TIMEFRAMES.map((t) => `<button data-tf="${t.key}" class="${t.key === tfKey ? 'on' : ''}">${t.label}</button>`).join('');
  $('bzTf').onclick = (e) => { const k = e.target.dataset.tf; if (!k) return; tfKey = k; [...$('bzTf').children].forEach((b) => b.classList.toggle('on', b.dataset.tf === k)); render(); };
  $('bzStart').onclick = () => {
    if (E.state.mode === 'manual') { E.setMode('auto'); [...$('bzMode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === 'auto')); }
    if (!accountInfo().connected && typeof window.gridConnect === 'function') $('bzConnect').onclick();
    E.setRunning(true);
  };
  $('bzStop').onclick = () => { E.setRunning(false); };
  $('bzDur').onchange = (e) => E.setManualDuration(e.target.value);
  $('bzStake').onchange = (e) => E.setStake(e.target.value);
  $('bzReverse').onchange = (e) => E.setReverse(e.target.checked);
  $('bzMetrics').addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-bzreset]'); if (b) E.resetPnl(b.dataset.bzreset); });
  $('bzMart').onchange = (e) => E.setMartingale(e.target.value);
  $('bzRealOk').onchange = (e) => E.confirmReal(e.target.checked);
  $('bzLogin').onclick = () => (typeof window.gridStartLogin === 'function' ? window.gridStartLogin() : alert('Login is on the Grid page'));
  $('bzConnect').onclick = () => {
    const pick = document.getElementById('gridAcctPick'), v = $('bzAcctSel').value;
    if (pick && v) { pick.value = v; if (typeof window.gridSelectAccountFromPicker === 'function') window.gridSelectAccountFromPicker(); }
    if (typeof window.gridConnect === 'function') window.gridConnect();
  };
  $('bzCards').onclick = (e) => { const c = e.target.closest('.card'); if (c) { E.state.selected = c.dataset.sym; render(); } };
  document.getElementById('page-bazu').addEventListener('click', onAction);
}

function onAction(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const sym = b.dataset.sym, m = E.state.markets.get(sym);
  if (b.dataset.act === 'buy') {
    const d = m.durations.find((x) => `${x.n}${x.unit}` === (document.getElementById('bzTkDur')?.value || ''));
    E.placeOrder({ symbol: sym, contractType: b.dataset.type, duration: d || m.durations[0], source: 'manual' }).then((r) => {
      if (r.needsConfirm && confirm('Gate findings:\n- ' + r.findings.join('\n- ') + '\n\nPlace this manual order anyway?')) return E.placeOrder({ symbol: sym, contractType: b.dataset.type, duration: d || m.durations[0], source: 'manual', confirmed: true }).then((r2) => { if (!r2.ok) alert(r2.reason); });
      if (!r.ok && !r.needsConfirm) alert(r.reason);
    });
  } else if (b.dataset.act === 'confirm' && m.signal) {
    E.placeSignal(m.signal, 'semi').then((r) => { if (!r.ok) alert(r.reason); });
  }
}

export function bazuPageInit() {
  if (!ready) { bindOnce(); ready = true; E.onChange(render); setInterval(() => { syncAccounts(); if (accountInfo().connected) E.attachAccount(); }, 3000); }
  E.resume(); syncAccounts(); render();
  if (!E.state.markets.size && E.state.status === 'idle') E.discover().then(() => E.startLoop()).catch((e) => { E.state.status = 'error: ' + e.message; render(); });
}
window.bazuPageInit = bazuPageInit;
window.bazuPageLeave = () => E.pause();

function syncAccounts() {
  const sel = $('bzAcctSel'), accts = window.gridAccounts || [];
  const sig = accts.map((a) => a.account_id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = accts.map((a) => `<option value="${esc(a.account_id)}">${a.is_virtual ? '🟢 DEMO' : '🔴 REAL'} · ${esc(a.account_id)}</option>`).join('') || '<option value="">(login first)</option>';
  }
}

function whyNoTrade(S, acc) {
  if (!acc.connected) return '⚠ No Deriv account connected - log in, pick an account and press Connect. Trades cannot be placed until then.';
  if (!S.running) return 'Bot stopped - press Start to trade automatically (Auto mode).';
  if (S.mode !== 'auto') return 'Mode is ' + S.mode + ' - choose Auto for automatic trades.';
  if (!acc.isDemo && !S.realConfirmed) return '⚠ REAL account: tick the real-money confirmation to allow trades.';
  const last = S.log.find((l) => /blocked|failed/.test(l.msg));
  const open = S.trades.filter((t) => t.status === 'open').length;
  return 'Auto trading ON (' + (acc.isDemo ? 'DEMO' : 'REAL') + ') - waiting for a signal with strength >= 20%. Open: ' + open + (last ? ' · last issue: ' + last.msg : '');
}

function render() {
  const endRender = perfStart('render'); try { renderNow(); } finally { endRender(); }
}
function renderNow() {
  if (!ready || document.hidden || !document.getElementById('page-bazu')?.classList.contains('active')) return;
  const S = E.state; let M; try { M = E.metrics(); } catch (e) { console.error('BAZU metrics', e); M = { account: accountInfo(), openStake: 0, potentialPayout: 0, sessionPnl: 0, closed: 0, win: {}, exposure: 'ok', markets: S.markets.size, tradable: 0, failed: 0 }; }
  const acc = M.account;
  $('bzStatus').textContent = S.status + (S.scan.active ? ` · ${S.scan.phase} ${S.scan.done}/${S.scan.total}` : '');
  $('bzDot').className = 'dot' + (S.status === 'live' ? ' live' : '');
  const pill = $('bzAcctPill');
  pill.textContent = acc.connected ? (acc.isReal ? '🔴 REAL' : '🟢 DEMO') : 'NOT CONNECTED';
  pill.className = 'pill ' + (acc.connected ? (acc.isReal ? 'real' : 'demo') : '');
  $('bzWhy').textContent = whyNoTrade(S, acc);
  $('bzStart').disabled = S.running; $('bzStop').disabled = !S.running;
  const mk = (l, v, c = '') => `<div class="m ${c}"><div class="l">${l}</div><div class="v num">${v}</div></div>`;
  try { $('bzMetrics').innerHTML = [
    mk('Balance', acc.connected ? `${Number(acc.balance).toFixed(2)} ${esc(acc.currency)}` : '—'),
    mk('Open stake', Number(M.openStake).toFixed(2)),
    mk('If settled now', M.settleNow == null ? '—' : Number(M.settleNow).toFixed(2)),
    mk('Potential payout', Number(M.potentialPayout).toFixed(2)),
    mk('🟢 Demo P/L <button data-bzreset=\"demo\" title=\"Reset demo P/L to zero\">reset</button>', money(M.demoPnl || 0), M.demoPnl > 0 ? 'ok' : M.demoPnl < 0 ? 'bad' : ''),
    mk('🔴 Real P/L <button data-bzreset=\"real\" title=\"Reset real P/L to zero\">reset</button>', money(M.realPnl || 0), M.realPnl > 0 ? 'ok' : M.realPnl < 0 ? 'bad' : ''),
    mk('Win rate', M.closed ? `${pct(M.win.p, 0)} <span class="mu" style="font-size:11px">n=${M.closed}</span>` : '—'),
    mk('Capital exposure', M.exposure.toUpperCase(), M.exposure),
    mk('Markets', M.markets), mk('Strong signals', M.tradable), mk('Completed', M.closed), mk('Failed', M.failed),
  ].join(''); } catch (e) { console.error('BAZU metrics', e); }
  const part = { live: () => renderLive(S), accuracy: () => renderAccuracy(S), perf: () => renderPerf(S), exec: () => renderExec(S, acc), calib: () => renderCalib(S) }[tab] || (() => renderExec(S, acc));
  syncDur(S);
  try { part(); } catch (e) { console.error('BAZU render', e); }
}

const secFmt = (s) => (s == null || !Number.isFinite(s) ? 'n/a' : s >= 120 ? (s / 60).toFixed(1) + 'm' : s.toFixed(0) + 's');
function lifetimeHtml(sig) {
  const L = sig.lifetime; if (!L) return '';
  const est = Object.entries(L.estimators || {}).map(([k, v]) => `${k} ${v == null ? '<span class="mu">not applicable</span>' : secFmt(v)}`).join(' · ');
  return `<div class="note num">Expected lifetime ${secFmt(L.lifetime)}${L.cappedBy ? ` (capped by ${esc(L.cappedBy)})` : ''} → duration ${esc(sig.duration || 'WAIT')}${sig.manual ? ' (manual duration)' : ''} · break-even ${sig.breakEven == null ? '—' : pct(sig.breakEven, 1)} · ${est}</div>`;
}
function reasoningHtml(sig) {
  if (!sig.families && !sig.momentum) return '';
  const mo = sig.momentum, fa = sig.familyAgreement, st = sig.signalState;
  const fam = Object.entries(sig.families || {}).map(([k, f]) => `${esc(k)} ${f.available === false ? 'n/a' : (f.vote > 0 ? '+' : f.vote < 0 ? '-' : '0')}`).join(', ');
  const ver = (sig.verdicts || []).map((v) => `${esc(v.kind)}: ${esc(v.reason)}`).join('; ');
  return `<div class="note"><b>Momentum</b> ${mo ? esc(mo.state) + (mo.available === false ? ' (unavailable)' : '') : 'n/a'}${mo?.opposes60s ? ' · opposes the last 60 s' : ''} · <b>Regime</b> ${esc(sig.regime || 'n/a')} · <b>State</b> ${esc(st || 'none')}${sig.entry?.trigger ? ' · trigger ' + esc(sig.entry.trigger) : ''}${sig.provisional ? ' (provisional)' : ''}</div>`
    + `<div class="note">Families: ${fam || 'n/a'}${fa ? ` · ${fa.agree}/${fa.available} agree, ${fa.oppose} oppose` : ''}</div>${ver ? `<div class="note">${ver}</div>` : ''}`;
}
function syncDur(S) {
  const sel = $('bzDur'); if (!sel) return;
  const keys = E.allowedKeys(), want = ['', ...keys].join('|');
  if (sel.dataset.k !== want) { sel.dataset.k = want; sel.innerHTML = '<option value="">Auto (lifetime)</option>' + keys.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join(''); }
  if (document.activeElement !== sel) sel.value = S.manualKey || '';
}
function vetoHtml(S) {
  const C = S.contra, T0 = E.vetoSummary();
  const contra = C && C.directional ? `<div class="note num">Momentum contradictions: ${C.opposing}/${C.directional} directional evaluations opposed the last 60 s (${pct(C.opposing / C.directional, 1)}) · among tradable: ${C.tradableOpposing}/${C.tradable}${Object.keys(C.byPlaybook).length ? ' · by playbook: ' + Object.entries(C.byPlaybook).map(([k, v]) => esc(k) + ' ' + v).join(', ') : ''}</div>` : '';
  return vetoHtml0(S, T0) + contra;
}
function vetoHtml0(S, T) {
  const rate = T.evals ? T.tradable / T.evals : null;
  const top = Object.entries(T.vetoes).sort((a, b) => b[1] - a[1]);
  const perMarket = Object.entries(S.vetoStats).map(([sym, s]) => ({ sym, ...s, top: Object.entries(s.vetoes).sort((a, b) => b[1] - a[1]).slice(0, 3) })).sort((a, b) => b.evals - a.evals);
  return `<div class="panel"><h3>Veto analysis <span class="mu">(live evaluations this session)</span></h3>
    <div class="note num">Evaluations ${T.evals} · tradable ${T.tradable} · tradable rate ${pct(rate, 1)}${top[0] ? ` · most common veto: <b>${esc(top[0][0])}</b> (${top[0][1]})` : ''}${S.backfill ? ` · backfill ${S.backfill.requests} requests, ${(S.backfill.ms / 1000).toFixed(0)}s` : ''}</div>
    <table><tr><th>Veto reason</th><th>Count</th><th>Share of evaluations</th></tr>${top.slice(0, 12).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td><td class="num">${pct(v / T.evals, 1)}</td></tr>`).join('') || '<tr><td colspan="3" class="mu">no evaluations yet</td></tr>'}</table>
    <div class="scroll" style="max-height:220px"><table><tr><th>Market</th><th>Evals</th><th>Tradable rate</th><th>Top vetoes</th></tr>${perMarket.map((m) => `<tr><td>${esc(m.sym)}</td><td class="num">${m.evals}</td><td class="num">${pct(m.tradable / m.evals, 1)}</td><td class="mu">${m.top.map(([k, v]) => `${esc(k)} (${v})`).join('; ')}</td></tr>`).join('')}</table></div></div>`;
}
function renderCalib(S) {
  const recs = S.records, sum = calibrationSummary(recs), acc = accuracyByDuration(recs);
  const dist = (e) => e.dist.map((d) => `${d.label}: ${d.count}`).join(' · ');
  const rows = (o) => Object.entries(o).map(([k, e]) => `<tr><td>${esc(k)}</td><td class="num">${e.n}</td><td class="num">${secFmt(e.medianErrorS)}</td><td class="num">${e.medianRatio == null ? '—' : e.medianRatio.toFixed(2) + 'x'}</td><td class="mu">${dist(e)}</td></tr>`).join('') || '<tr><td colspan="5" class="mu">no resolved records yet</td></tr>';
  const head = '<tr><th></th><th>N</th><th>Median error (pred − real)</th><th>Median pred/real</th><th>Error distribution</th></tr>';
  $('bzCalib').innerHTML = vetoHtml(S) + calibCurveHtml() + `<div class="panel" style="margin-top:10px"><h3>Lifetime calibration <span class="mu">(a record, not a gate)</span></h3>
    <div class="note num">Signals logged ${recs.length} · resolved ${sum.resolved} · target first ${sum.targetFirst} · invalidation first ${sum.invalidFirst} · neither within max ${sum.neither} · target touched within chosen duration but contract lost ${sum.touchedButLost} of ${sum.targetTouchedInDur}</div>
    <h4>By playbook</h4><table>${head}${rows(sum.byPlaybook)}</table><h4>By estimator</h4><table>${head}${rows(sum.byEstimator)}</table></div>
    <div class="panel" style="margin-top:10px"><h3>Accuracy by chosen duration <span class="mu">(shadow outcomes, ties lose)</span></h3>
    <table><tr><th>Duration</th><th>Hit rate (95% CI)</th><th>Mean break-even</th></tr>${acc.map((a) => `<tr><td>${esc(a.key)}</td><td>${ci(a.ci)}</td><td class="num">${pct(a.breakEven, 1)}</td></tr>`).join('') || '<tr><td colspan="3" class="mu">no resolved records yet</td></tr>'}</table></div>`;
}
function renderPerf(S) {
  const by = new Map();
  S.trades.filter((t) => t.status === 'closed' && t.result !== 'unknown' && Number.isFinite(t.profit)).forEach((t) => { if (!by.has(t.market)) by.set(t.market, []); by.get(t.market).push(t); });
  const rows = [...by.entries()].map(([mk, ts]) => {
    const wins = ts.filter((t) => t.profit > 0), ws = wins.filter((t) => t.strength != null);
    const bands = {}; ws.forEach((t) => { const b = Math.floor(t.strength * 10) * 10; bands[b] = (bands[b] || 0) + 1; });
    const top = Object.entries(bands).sort((a, b) => b[1] - a[1])[0];
    return { mk, n: ts.length, w: wilson(wins.length, ts.length), pnl: ts.reduce((a, t) => a + t.profit, 0), avgS: ws.length ? ws.reduce((a, t) => a + t.strength, 0) / ws.length : null, top: top ? `${top[0]}-${+top[0] + 10}% (${top[1]} of ${ws.length} wins)` : '—', last: Math.max(...ts.map((t) => t.ts)) };
  }).sort((a, b) => b.w.p - a.w.p || b.n - a.n);
  const when = (x) => new Date(x).toLocaleTimeString();
  $('bzPerf').innerHTML = rows.length ? `<div class="panel"><h3>Performance log <span class="mu">(markets ranked by win rate, real Deriv settlements)</span></h3><div class="scroll"><table><tr><th>#</th><th>Market</th><th>Win rate (95% CI)</th><th>Trades</th><th>Net P/L</th><th>Avg strength of wins</th><th>Most wins at strength</th><th>Last trade</th></tr>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.mk)}</td><td>${ci(r.w)}</td><td class="num">${r.n}</td><td class="num ${r.pnl >= 0 ? 'up' : 'dn'}">${money(r.pnl)}</td><td class="num">${r.avgS == null ? '—' : pct(r.avgS, 0)}</td><td>${r.top}</td><td class="mu">${when(r.last)}</td></tr>`).join('')}</table></div><div class="note">${esc(rows[0].mk)} leads with ${pct(rows[0].w.p, 0)} wins over ${rows[0].n} trades; most of its wins came at strength ${rows[0].top}. Small samples are noisy - check the interval.</div></div>` : '<div class="note">No completed trades yet.</div>';
}

function renderLive(S) {
  const arr = [...S.markets.values()];
  $('bzMktCount').textContent = `(${arr.length} with Rise/Fall)`;
  $('bzCards').innerHTML = arr.map((m) => {
    const sig = m.signal, has = sig && sig.direction;
    return `<div class="card ${S.selected === m.symbol ? 'sel' : ''}" data-sym="${esc(m.symbol)}"><div class="t"><span>${esc(m.symbol)}</span><span class="num">${fmtPrice(m.last, m.dp)}</span></div>
      <div class="s">${esc(m.name)}</div><div class="s"><span class="pill ${has && sig.gate === GATE.OK ? (sig.direction === 'Rise' ? 'ok' : 'bad') : ''}">${has ? esc(sig.direction + ' ' + sig.duration) : esc(E.marketGate(m).label)}</span> ${has ? `<span class="mu">${pct(sig.strength, 0)}</span>` : ''}</div></div>`;
  }).join('') || '<div class="note">Discovering markets from Deriv…</div>';
  const m = S.markets.get(S.selected);
  if (!m) return;
  $('bzSelTitle').textContent = `${m.symbol} · ${m.name}`;
  drawChart(m);
  const sig = m.signal;
  $('bzSignal').innerHTML = sig && sig.direction ? `<div class="sig ${sig.gate === GATE.OK ? (sig.direction === 'Rise' ? 'ok' : 'bad') : ''}">
      <div class="row"><b class="${sig.direction === 'Rise' ? 'up' : 'dn'}" style="font-size:18px">${esc(sig.direction)}</b><span class="pill">${esc(sig.duration)}${sig.manual ? ' · manual duration' : ''}</span><span class="pill ${sig.gate === GATE.OK ? (sig.direction === 'Rise' ? 'ok' : 'bad') : 'warn'}">${esc(sig.gate)}</span>${sig.proxy ? '<span class="pill proxy">uses proxy</span>' : ''}</div>
      <div class="note num">Signal strength ${pct(sig.strength, 0)} · ${sig.agree}/${sig.total} analysis features agree${sig.quote ? ` · Deriv quote: stake ${sig.quote.ask}, payout ${sig.quote.payout}` : ''}</div>
      ${lifetimeHtml(sig)}${reasoningHtml(sig)}${roomHtml(sig)}<div class="note"><b>${esc(sig.playbook || 'analysis')}</b>${sig.provisional ? ' (provisional trigger)' : ''} · ${esc(sig.reason || '')}</div>${(sig.reasons || []).length ? `<div class="note">${sig.reasons.map(esc).join('; ')}</div>` : ''}<div class="note">Drivers: ${(sig.drivers || []).map(esc).join(', ') || '-'}. Decided ${sig.decisionTs ? new Date(sig.decisionTs * 1000).toLocaleTimeString() : ''} for a ${esc(sig.duration)} Rise/Fall (exit vs entry; a tie loses). Score is a rule-based confluence, not a win probability.</div></div>`
    : `<div class="sig"><b>${esc(E.marketGate(m).label)}</b><div class="note">Collecting ticks to analyse this market.</div></div>`;
}

function drawChart(m) {
  const cv = $('bzChart'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height, tf = timeframe(tfKey);
  ctx.clearRect(0, 0, W, H);
  let candles;
  if (tf.remote) {
    E.ensureCandles(m, tf);
    const c = m.candleCache?.[tf.key];
    candles = c ? mergeLive(c.candles, m.prices.slice(-600), m.epochs.slice(-600), tf.secs).slice(-120) : [];
  } else candles = localCandles(m.prices, m.epochs, tf, 120);
  if (candles.length < 5) { ctx.fillStyle = '#848E9C'; ctx.fillText(tf.remote ? 'Loading candles…' : 'Waiting for ticks…', 20, 30); $('bzChartNote').textContent = ''; return; }
  const lo = Math.min(...candles.map((c) => c.low)), hi = Math.max(...candles.map((c) => c.high)), pad = (hi - lo) * 0.05 || 1;
  const y = (v) => H - 14 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 28), cw = (W - 60) / candles.length;
  const swings = findSwingPoints(candles, 2);
  const atr = candles.reduce((a, c) => a + (c.high - c.low), 0) / candles.length || 1;
  clusterZones(swings, candles, atr, candles.length).filter((z) => z.touches >= 2).forEach((z) => {
    ctx.strokeStyle = z.kind === 'resistance' ? 'rgba(246,70,93,.55)' : 'rgba(46,189,133,.55)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(z.price)); ctx.lineTo(W - 52, y(z.price)); ctx.stroke(); ctx.setLineDash([]);
  });
  candles.forEach((c, i) => {
    const x = 4 + i * cw, up = c.close >= c.open; ctx.strokeStyle = ctx.fillStyle = up ? '#2EBD85' : '#F6465D';
    ctx.beginPath(); ctx.moveTo(x + cw / 2, y(c.high)); ctx.lineTo(x + cw / 2, y(c.low)); ctx.stroke();
    ctx.fillRect(x + 1, Math.min(y(c.open), y(c.close)), Math.max(1, cw - 2), Math.max(1, Math.abs(y(c.open) - y(c.close))));
  });
  const lastPx = m.last ?? candles[candles.length - 1].close;
  const ri = m.signal?.roomInfo;
  if (ri && Number.isFinite(ri.sigmaT)) {
    ctx.fillStyle = 'rgba(76,141,255,.12)'; ctx.fillRect(0, y(ri.price + ri.sigmaT), W - 52, Math.max(1, y(ri.price - ri.sigmaT) - y(ri.price + ri.sigmaT)));
    if (ri.zone) { ctx.fillStyle = 'rgba(246,190,70,.18)'; ctx.fillRect(0, y(ri.zone.high), W - 52, Math.max(1, y(ri.zone.low) - y(ri.zone.high))); }
  }
  ctx.strokeStyle = '#4C8DFF'; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(0, y(lastPx)); ctx.lineTo(W - 52, y(lastPx)); ctx.stroke();
  ctx.fillStyle = '#EAECEF'; ctx.font = '11px ui-monospace,Consolas,monospace';
  ctx.fillText(fmtPrice(lastPx, m.dp), W - 56, y(lastPx) + 4);
  ctx.fillStyle = '#848E9C'; ctx.fillText(fmtPrice(hi, m.dp), W - 56, 12); ctx.fillText(fmtPrice(lo, m.dp), W - 56, H - 2);
  $('bzChartNote').textContent = `${tf.label} candles from real Deriv data (${candles.length} candles). Dashed lines: S/R zones with ≥2 touches.`;
}

function renderAccuracy(S) {
  const closed = S.trades.filter((t) => t.status === 'closed');
  const withP = closed.filter((t) => t.strength != null);
  const bins = [0.2, 0.3, 0.4, 0.5, 0.6].map((lo, i) => { const hi = [0.3, 0.4, 0.5, 0.6, 1.01][i]; const r = withP.filter((t) => t.strength >= lo && t.strength < hi); return { lo, hi, n: r.length, w: wilson(r.filter((t) => t.profit > 0).length, r.length) }; });
  $('bzAccuracy').innerHTML = `<div class="panel"><h3>Live accuracy <span class="mu">(real Deriv settlements only)</span></h3>
    <div class="kpis"><div class="m"><div class="l">Completed</div><div class="v num">${closed.length}</div></div><div class="m"><div class="l">Hit rate (95% CI)</div><div class="v num" style="font-size:13px">${ci(wilson(closed.filter((t) => t.profit > 0).length, closed.length))}</div></div></div>
    <div class="note">Signal strength vs realised hit rate (signal-driven trades):</div>
    <table><tr><th>Signal strength</th><th>Hit rate (n, 95% CI)</th></tr>${bins.map((b) => `<tr><td>${pct(b.lo, 0)}–${pct(Math.min(b.hi, 1), 0)}</td><td>${ci(b.w)}</td></tr>`).join('')}</table></div>
    <div class="panel" style="margin-top:10px"><h3>Trade log</h3><div class="scroll">${tradesTable(S.trades.filter((t) => t.status === 'closed'))}</div></div>`;
}

function roomHtml(sig) {
  const r = sig.roomInfo; if (!r) return '';
  return `<div class="note"><b>Room</b> ${esc(r.text)}${r.lifetimeDerived ? ' · in lifetime mode the duration is derived from the same distances' : ''}${r.fired ? ' · fired: ' + esc(r.fired) : ''}</div>`;
}
function liveContractsHtml(S) {
  const open = S.trades.filter((t) => t.status === 'open'); if (!open.length) return '';
  const cal = E.expiryCalibration();
  return open.map((t) => { let info = null; try { info = E.expiryInfo(t); } catch { /* data missing */ } return `<div class="note">${esc(t.market)} ${esc(t.direction)} ${esc(t.duration)}: ${esc(liveContractText(info ? info.p : null, cal))}</div>`; }).join('');
}
function calibCurveHtml() {
  const c = E.expiryCalibration(), f = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
  return `<div class="panel" style="margin-top:10px"><h3>Expiry probability calibration <span class="mu">(analytic model, probability at half time vs settled outcome)</span></h3>
    <div class="note">${c.n >= c.nMin ? `Calibrated on ${c.n} outcomes.` : `Uncalibrated: ${c.n}/${c.nMin} outcomes.`} Brier ${c.brier == null ? '-' : c.brier.toFixed(4)} vs constant 50%: ${c.brier50 == null ? '-' : c.brier50.toFixed(4)}.</div>
    <table><tr><th>Predicted bin</th><th>N</th><th>Mean predicted</th><th>Observed</th></tr>${c.curve.map((r) => `<tr><td>${(r.lo * 100).toFixed(0)}-${(r.hi * 100).toFixed(0)}%</td><td class="num">${r.n}</td><td class="num">${f(r.predicted)}</td><td class="num">${f(r.observed)}</td></tr>`).join('')}</table></div>`;
}
function tradesTable(list) {
  if (!list.length) return '<div class="note">No trades yet.</div>';
  return `<table><tr><th>Time</th><th>Market</th><th>Side</th><th>Dur</th><th>Stake</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Acct</th><th>Src</th></tr>${list.map((t) => `<tr><td class="num">${new Date(t.ts).toLocaleTimeString()}</td><td>${esc(t.market)}</td><td class="${t.direction === 'Rise' ? 'up' : 'dn'}">${esc(t.direction)}</td><td>${esc(t.duration)}</td><td class="num">${t.stake}</td><td class="num">${fmtPrice(t.entry, E.state.markets.get(t.market)?.dp)}</td><td class="num">${fmtPrice(t.exit, E.state.markets.get(t.market)?.dp)}</td><td class="num ${t.profit > 0 ? 'up' : t.profit < 0 ? 'dn' : ''}">${t.profit == null ? t.status : money(t.profit)}</td><td>${t.isReal ? '🔴' : '🟢'}</td><td>${esc(t.source)}</td></tr>`).join('')}</table>`;
}

function renderExec(S, acc) {
  const m = S.markets.get(S.selected);
  const tiles = [...S.markets.values()].filter((x) => x.signal?.gate === GATE.OK);
  const el = $('bzExec');
  if (el.contains(document.activeElement) && /SELECT|INPUT/.test(document.activeElement.tagName)) return; // do not clobber a control being used
  el.innerHTML = `<div class="bz-cols"><div>
    <div class="panel"><h3>Quick routing <span class="mu">(strong signals)</span></h3>${tiles.length ? tiles.map((x) => `<div class="sig ok"><div class="row"><b>${esc(x.symbol)}</b><b class="${x.signal.direction === 'Rise' ? 'up' : 'dn'}">${esc(x.signal.direction)}</b><span class="pill">${esc(x.signal.duration)}</span><span class="num">strength ${pct(x.signal.strength, 0)}</span>${S.mode === 'semi' ? `<button class="btn primary" data-act="confirm" data-sym="${esc(x.symbol)}">Confirm trade</button>` : ''}</div></div>`).join('') : '<div class="note">No strong signals right now. Semi-auto/Auto act only on signals above the minimum strength.</div>'}</div>
    <div class="panel" style="margin-top:10px"><h3>Order ticket</h3>${m ? `<div class="row"><b>${esc(m.symbol)}</b><select id="bzTkDur">${m.durations.map((d) => `<option>${d.n}${d.unit}</option>`).join('')}</select>
      <button class="btn buy" data-act="buy" data-type="CALL" data-sym="${esc(m.symbol)}" ${acc.connected ? '' : 'disabled'}>Rise</button><button class="btn sell" data-act="buy" data-type="PUT" data-sym="${esc(m.symbol)}" ${acc.connected ? '' : 'disabled'}>Fall</button></div>
      <div class="note">Stake ${S.curStake || S.stake}${S.martingale > 1 ? ' (martingale x' + S.martingale + ')' : ''} · ${acc.connected ? (acc.isReal ? '🔴 REAL account (requires the confirm checkbox; stake capped)' : '🟢 DEMO account') : 'connect an account to trade'}. Orders go through Deriv proposal → buy; entry, payout, exit and P/L are Deriv's.</div>` : '<div class="note">Select a market on the Live tab.</div>'}</div>
    </div><div>
    <div class="panel"><h3>Open positions</h3>${tradesTable(S.trades.filter((t) => t.status === 'open'))}${liveContractsHtml(S)}</div>
    <div class="panel" style="margin-top:10px"><h3>Event log</h3><div class="log">${S.log.map((l) => `<div class="${l.kind === 'bad' ? 'dn' : l.kind === 'ok' ? 'up' : l.kind === 'warn' ? '' : 'mu'}">${new Date(l.t).toLocaleTimeString()} · ${esc(l.msg)}</div>`).join('')}</div></div>
    <div class="panel note" style="margin-top:10px">No stake or trade-count limits are applied. REAL accounts require the confirmation tick.</div></div></div>`;
}
