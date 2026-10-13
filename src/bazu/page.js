/**
 * src/bazu/page.js
 * BAZU page view. Sends commands to engine.js and renders its state — NO trading rules here.
 */
import * as E from './engine.js?v=3';
import { clusterZones } from './structure.js?v=3';
import { TIMEFRAMES, timeframe, fmtPrice, localCandles, mergeLive } from './timeframes.js?v=3';
import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';
import { wilson } from './stats.js?v=3';
import { accountInfo } from './execution.js?v=3';
import { GATE } from './decision.js?v=3';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const ci = (w) => (w && w.n ? `${pct(w.p)} <span class="mu">[${pct(w.lo)}–${pct(w.hi)}] n=${w.n}</span>` : '<span class="mu">no data</span>');
const money = (x) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));
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
  $('bzStake').onchange = (e) => E.setStake(e.target.value);
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
    E.placeOrder({ symbol: sym, contractType: b.dataset.type, duration: d || m.durations[0], source: 'manual' }).then((r) => { if (!r.ok) alert(r.reason); });
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
  if (!ready) return;
  const S = E.state, M = E.metrics(), acc = M.account;
  $('bzStatus').textContent = S.status + (S.scan.active ? ` · ${S.scan.phase} ${S.scan.done}/${S.scan.total}` : '');
  $('bzDot').className = 'dot' + (S.status === 'live' ? ' live' : '');
  const pill = $('bzAcctPill');
  pill.textContent = acc.connected ? (acc.isReal ? '🔴 REAL' : '🟢 DEMO') : 'NOT CONNECTED';
  pill.className = 'pill ' + (acc.connected ? (acc.isReal ? 'real' : 'demo') : '');
  $('bzWhy').textContent = whyNoTrade(S, acc);
  $('bzStart').disabled = S.running; $('bzStop').disabled = !S.running;
  const mk = (l, v, c = '') => `<div class="m ${c}"><div class="l">${l}</div><div class="v num">${v}</div></div>`;
  $('bzMetrics').innerHTML = [
    mk('Balance', acc.connected ? `${Number(acc.balance).toFixed(2)} ${esc(acc.currency)}` : '—'),
    mk('Open stake', M.openStake.toFixed(2)),
    mk('If settled now', M.settleNow == null ? '—' : M.settleNow.toFixed(2)),
    mk('Potential payout', M.potentialPayout.toFixed(2)),
    mk('Session P/L', money(M.sessionPnl), M.sessionPnl > 0 ? 'ok' : M.sessionPnl < 0 ? 'bad' : ''),
    mk('Win rate', M.closed ? `${pct(M.win.p, 0)} <span class="mu" style="font-size:11px">n=${M.closed}</span>` : '—'),
    mk('Capital exposure', M.exposure.toUpperCase(), M.exposure),
    mk('Markets', M.markets), mk('Strong signals', M.tradable), mk('Completed', M.closed), mk('Failed', M.failed),
  ].join('');
  if (tab === 'live') renderLive(S);
  else if (tab === 'accuracy') renderAccuracy(S);
  else renderExec(S, acc);
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
      <div class="row"><b class="${sig.direction === 'Rise' ? 'up' : 'dn'}" style="font-size:18px">${esc(sig.direction)}</b><span class="pill">${esc(sig.duration)}</span><span class="pill ${sig.gate === GATE.OK ? (sig.direction === 'Rise' ? 'ok' : 'bad') : 'warn'}">${esc(sig.gate)}</span>${sig.proxy ? '<span class="pill proxy">uses proxy</span>' : ''}</div>
      <div class="note num">Signal strength ${pct(sig.strength, 0)} · ${sig.agree}/${sig.total} analysis features agree${sig.quote ? ` · Deriv quote: stake ${sig.quote.ask}, payout ${sig.quote.payout}` : ''}</div>
      <div class="note">Main drivers: ${sig.drivers.map(esc).join(', ') || '—'}. Strength is the consensus of the analysis features, not a win probability.</div></div>`
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
      <div class="note">Stake ${S.stake} · ${acc.connected ? (acc.isReal ? '🔴 REAL account (requires the confirm checkbox; stake capped)' : '🟢 DEMO account') : 'connect an account to trade'}. Orders go through Deriv proposal → buy; entry, payout, exit and P/L are Deriv's.</div>` : '<div class="note">Select a market on the Live tab.</div>'}</div>
    </div><div>
    <div class="panel"><h3>Open positions</h3>${tradesTable(S.trades.filter((t) => t.status === 'open'))}</div>
    <div class="panel" style="margin-top:10px"><h3>Event log</h3><div class="log">${S.log.map((l) => `<div class="${l.kind === 'bad' ? 'dn' : l.kind === 'ok' ? 'up' : l.kind === 'warn' ? '' : 'mu'}">${new Date(l.t).toLocaleTimeString()} · ${esc(l.msg)}</div>`).join('')}</div></div>
    <div class="panel note" style="margin-top:10px">Risk limits: stake ≤ ${S.limits.maxStake} (REAL ≤ ${S.limits.realMaxStake}), ≤ ${S.limits.maxConcurrent} open, 1 per market, daily loss limit ${S.limits.dailyLossLimit} (REAL ${S.limits.realDailyLossLimit}), ${S.limits.cooldownMs / 1000}s cooldown.</div></div></div>`;
}
