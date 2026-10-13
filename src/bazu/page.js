/**
 * src/bazu/page.js
 * BAZU page view. Sends commands to engine.js and renders its state — NO trading rules here.
 */
import * as E from './engine.js';
import { toCandles, clusterZones } from './structure.js';
import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';
import { wilson } from './stats.js';
import { accountInfo } from './execution.js';
import { GATE } from './decision.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const ci = (w) => (w && w.n ? `${pct(w.p)} <span class="mu">[${pct(w.lo)}–${pct(w.hi)}] n=${w.n}</span>` : '<span class="mu">no data</span>');
const money = (x) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2));
let tab = 'live', ready = false;

function bindOnce() {
  $('bzTabs').onclick = (e) => { const t = e.target.dataset.t; if (!t) return; tab = t; [...$('bzTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.t === t)); document.querySelectorAll('#page-bazu .bz-pane').forEach((p) => p.classList.toggle('on', p.id === 'bzp-' + t)); render(); };
  $('bzMode').onclick = (e) => { const m = e.target.dataset.m; if (!m) return; E.setMode(m); [...$('bzMode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === m)); };
  $('bzScan').onclick = () => E.scan().catch((e) => alert('BAZU scan: ' + e.message));
  $('bzStart').onclick = () => E.setRunning(true);
  $('bzStop').onclick = () => { E.setRunning(false); E.stopScan(); };
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
  syncAccounts(); render();
  if (!E.state.markets.size && E.state.status === 'idle') E.discover().then(() => E.startLoop()).catch((e) => { E.state.status = 'error: ' + e.message; render(); });
}
window.bazuPageInit = bazuPageInit;

function syncAccounts() {
  const sel = $('bzAcctSel'), accts = window.gridAccounts || [];
  const sig = accts.map((a) => a.account_id).join(',');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = accts.map((a) => `<option value="${esc(a.account_id)}">${a.is_virtual ? '🟢 DEMO' : '🔴 REAL'} · ${esc(a.account_id)}</option>`).join('') || '<option value="">(login first)</option>';
  }
}

function render() {
  if (!ready) return;
  const S = E.state, M = E.metrics(), acc = M.account;
  $('bzStatus').textContent = S.status + (S.scan.active ? ` · ${S.scan.phase} ${S.scan.done}/${S.scan.total}` : '');
  $('bzDot').className = 'dot' + (S.status === 'live' ? ' live' : '');
  const pill = $('bzAcctPill');
  pill.textContent = acc.connected ? (acc.isReal ? '🔴 REAL' : '🟢 DEMO') : 'NOT CONNECTED';
  pill.className = 'pill ' + (acc.connected ? (acc.isReal ? 'real' : 'demo') : '');
  $('bzStart').disabled = S.running; $('bzStop').disabled = !S.running && !S.scan.active;
  const mk = (l, v, c = '') => `<div class="m ${c}"><div class="l">${l}</div><div class="v num">${v}</div></div>`;
  $('bzMetrics').innerHTML = [
    mk('Balance', acc.connected ? `${Number(acc.balance).toFixed(2)} ${esc(acc.currency)}` : '—'),
    mk('Open stake', M.openStake.toFixed(2)),
    mk('If settled now', M.settleNow == null ? '—' : M.settleNow.toFixed(2)),
    mk('Potential payout', M.potentialPayout.toFixed(2)),
    mk('Session P/L', money(M.sessionPnl), M.sessionPnl > 0 ? 'ok' : M.sessionPnl < 0 ? 'bad' : ''),
    mk('Win rate', M.closed ? `${pct(M.win.p, 0)} <span class="mu" style="font-size:11px">n=${M.closed}</span>` : '—'),
    mk('Capital exposure', M.exposure.toUpperCase(), M.exposure),
    mk('Markets', M.markets), mk('Validated', M.validated), mk('Tradable now', M.tradable), mk('Completed', M.closed), mk('Failed', M.failed),
  ].join('');
  if (tab === 'live') renderLive(S);
  else if (tab === 'validation') renderValidation(S);
  else if (tab === 'accuracy') renderAccuracy(S);
  else renderExec(S, acc);
}

function renderLive(S) {
  const arr = [...S.markets.values()];
  $('bzMktCount').textContent = `(${arr.length} with Rise/Fall)`;
  $('bzCards').innerHTML = arr.map((m) => {
    const g = E.marketGate(m), sig = m.signal;
    return `<div class="card ${S.selected === m.symbol ? 'sel' : ''}" data-sym="${esc(m.symbol)}"><div class="t"><span>${esc(m.symbol)}</span><span class="num">${m.last ?? '—'}</span></div>
      <div class="s">${esc(m.name)}</div><div class="s"><span class="pill ${sig?.gate === GATE.OK ? 'ok' : g.edge ? 'warn' : ''}">${sig ? esc(sig.direction + ' ' + sig.duration) : esc(g.label)}</span> ${m.tickCount ? `<span class="mu">${m.tickCount} ticks</span>` : ''}</div></div>`;
  }).join('') || '<div class="note">Discovering markets from Deriv…</div>';
  const m = S.markets.get(S.selected);
  if (!m) return;
  $('bzSelTitle').textContent = `${m.symbol} · ${m.name}`;
  drawChart(m);
  const g = E.marketGate(m), sig = m.signal;
  $('bzSignal').innerHTML = sig && sig.gate !== GATE.NO_EDGE ? `<div class="sig ${sig.gate === GATE.OK ? 'ok' : ''}">
      <div class="row"><b class="${sig.direction === 'Rise' ? 'up' : 'dn'}">${esc(sig.direction)}</b><span class="pill">${esc(sig.duration)}</span><span class="pill ${sig.gate === GATE.OK ? 'ok' : 'warn'}">${esc(sig.gate)}</span>${sig.proxy ? '<span class="pill proxy">uses proxy</span>' : ''}</div>
      <div class="note num">Calibrated p ${pct(sig.probability)} · OOS hit ${pct(sig.oosHitRate)} (n=${sig.oosN}, LCB ${pct(sig.oosLcb)}) · break-even ${pct(sig.breakEven, 2)} (quoted ask ${sig.quote.ask}/payout ${sig.quote.payout}) · margin ${(sig.margin * 100).toFixed(2)} pp</div>
      <div class="note">Evidence: ${sig.evidence.map(esc).join(', ')}</div></div>`
    : `<div class="sig"><b>${esc(g.label)}</b><div class="note">${g.edge ? 'Validated setups exist but none is firing right now.' : 'Semi-auto and Auto are inactive for this market. Manual demo trading stays available from the Execution tab, flagged “no validated edge”.'}</div></div>`;
}

function drawChart(m) {
  const cv = $('bzChart'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const n = Math.min(m.prices.length, 900);
  if (n < 40) { ctx.fillStyle = '#848E9C'; ctx.fillText('Waiting for ticks…', 20, 30); return; }
  const P = m.prices.slice(-n), Ep = m.epochs.slice(-n);
  const { candles } = toCandles(P, Ep, 10);
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
  ctx.fillStyle = '#EAECEF'; ctx.font = '11px ui-monospace,Consolas,monospace'; ctx.fillText(String(m.last), W - 50, y(m.last) + 4);
  $('bzChartNote').textContent = `10-tick candles from real Deriv ticks (${n} ticks). Dashed lines: S/R zones with ≥2 touches (mtf swing clustering).`;
}

function renderValidation(S) {
  const m = S.markets.get(S.selected) || [...S.markets.values()].find((x) => Object.keys(x.val).length);
  if (!m) { $('bzValidation').innerHTML = '<div class="panel note">Run “Scan &amp; validate”, then pick a market on the Live tab.</div>'; return; }
  let html = `<div class="panel"><h3>${esc(m.symbol)} — walk-forward validation</h3><div class="note">Split: Discovery 50% · Replication 25% · Holdout 25% (time-ordered). Baseline = null probability of the side on the same segment, not 50%. Tradable only if Published AND Wilson LCB of OOS hit rate &gt; quoted break-even.</div></div>`;
  for (const [dur, v] of Object.entries(m.val)) {
    const c = v.counts, nc = v.nullControl, cal = v.calibration;
    html += `<div class="panel" style="margin-top:10px"><h3>${esc(dur)} <span class="mu">· ${v.ticks} ticks · D/R/H = ${v.n.D}/${v.n.R}/${v.n.H}</span></h3>
      <div class="row"><span class="pill">generated ${c.generated}</span><span class="pill">screened ${c.screened}</span><span class="pill">triaged ${c.triaged}</span><span class="pill">confirmed ${c.confirmed}</span><span class="pill">replicated ${c.replicated}</span><span class="pill ${c.published ? 'ok' : 'warn'}">published ${c.published}</span></div>
      ${nc ? `<div class="note" style="margin-top:6px">Null control (${nc.runs} shuffled-increment runs, full pipeline): false-confirmed ${nc.falseConfirmed}, false-published ${nc.falsePublished} (${nc.falsePublishedPerRun.toFixed(2)}/run; runs with ≥1 false publication ${pct(nc.fdrRunLevel, 0)}).</div>` : '<div class="note">Null control not run.</div>'}
      ${cal ? `<div class="note num">Calibration on untouched holdout: n=${cal.n}, Brier ${cal.brier.toFixed(4)} vs baseline ${cal.brierBaseline.toFixed(4)}; reliability: ${cal.bins.map((b) => `[${b.lo.toFixed(1)}–${b.hi.toFixed(1)}] pred ${pct(b.predicted)} / obs ${pct(b.observed)} (n=${b.n})`).join(' · ')}</div>` : '<div class="note">No published setups, so no calibration data.</div>'}
      ${v.setups.length ? `<div class="scroll"><table><tr><th>Setup (hypothesis ID)</th><th>Stage</th><th>Discovery</th><th>Replication</th><th>Holdout</th><th>OOS pooled (Wilson 95%)</th><th>Null p0</th></tr>${v.setups.map((s) => `<tr><td class="mono">${esc(s.id)} ${s.proxy ? '<span class="pill proxy">proxy</span>' : ''}</td><td>${esc(s.stage)}</td><td>${ci(wilson(s.D.k, s.D.n))}</td><td>${s.R ? ci(wilson(s.R.k, s.R.n)) : '—'}</td><td>${s.H ? ci(wilson(s.H.k, s.H.n)) : '—'}</td><td>${ci(s.oos)}</td><td class="num">${pct(s.p0)}</td></tr>`).join('')}</table></div>` : '<div class="note" style="margin-top:8px"><b>No validated edge</b> for this market and duration.</div>'}</div>`;
  }
  $('bzValidation').innerHTML = html;
}

function renderAccuracy(S) {
  const closed = S.trades.filter((t) => t.status === 'closed');
  const withP = closed.filter((t) => t.probability != null);
  const bins = [0.5, 0.55, 0.6, 0.65, 0.7, 1.01].slice(0, -1).map((lo, i, a) => { const hi = [0.55, 0.6, 0.65, 0.7, 1.01][i]; const r = withP.filter((t) => t.probability >= lo && t.probability < hi); return { lo, hi, n: r.length, w: wilson(r.filter((t) => t.profit > 0).length, r.length) }; });
  $('bzAccuracy').innerHTML = `<div class="panel"><h3>Live accuracy <span class="mu">(real Deriv settlements only)</span></h3>
    <div class="kpis"><div class="m"><div class="l">Completed</div><div class="v num">${closed.length}</div></div><div class="m"><div class="l">Hit rate (95% CI)</div><div class="v num" style="font-size:13px">${ci(wilson(closed.filter((t) => t.profit > 0).length, closed.length))}</div></div></div>
    <div class="note">Confidence vs realised hit rate (signal-driven trades):</div>
    <table><tr><th>Predicted p</th><th>Hit rate (n, 95% CI)</th></tr>${bins.map((b) => `<tr><td>${pct(b.lo, 0)}–${pct(Math.min(b.hi, 1), 0)}</td><td>${ci(b.w)}</td></tr>`).join('')}</table></div>
    <div class="panel" style="margin-top:10px"><h3>Trade log</h3><div class="scroll">${tradesTable(S.trades.filter((t) => t.status === 'closed'))}</div></div>`;
}

function tradesTable(list) {
  if (!list.length) return '<div class="note">No trades yet.</div>';
  return `<table><tr><th>Time</th><th>Market</th><th>Side</th><th>Dur</th><th>Stake</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Acct</th><th>Src</th></tr>${list.map((t) => `<tr><td class="num">${new Date(t.ts).toLocaleTimeString()}</td><td>${esc(t.market)}</td><td class="${t.direction === 'Rise' ? 'up' : 'dn'}">${esc(t.direction)}</td><td>${esc(t.duration)}</td><td class="num">${t.stake}</td><td class="num">${t.entry ?? '—'}</td><td class="num">${t.exit ?? '—'}</td><td class="num ${t.profit > 0 ? 'up' : t.profit < 0 ? 'dn' : ''}">${t.profit == null ? t.status : money(t.profit)}</td><td>${t.isReal ? '🔴' : '🟢'}</td><td>${esc(t.source)}${t.noEdge ? ' <span class="pill warn">no validated edge</span>' : ''}</td></tr>`).join('')}</table>`;
}

function renderExec(S, acc) {
  const m = S.markets.get(S.selected);
  const tiles = [...S.markets.values()].filter((x) => x.signal?.gate === GATE.OK);
  const el = $('bzExec');
  if (el.contains(document.activeElement) && /SELECT|INPUT/.test(document.activeElement.tagName)) return; // do not clobber a control being used
  el.innerHTML = `<div class="bz-cols"><div>
    <div class="panel"><h3>Quick routing <span class="mu">(tradable signals)</span></h3>${tiles.length ? tiles.map((x) => `<div class="sig ok"><div class="row"><b>${esc(x.symbol)}</b><b class="${x.signal.direction === 'Rise' ? 'up' : 'dn'}">${esc(x.signal.direction)}</b><span class="pill">${esc(x.signal.duration)}</span><span class="num">p ${pct(x.signal.probability)} · margin ${(x.signal.margin * 100).toFixed(2)}pp</span>${S.mode === 'semi' ? `<button class="btn primary" data-act="confirm" data-sym="${esc(x.symbol)}">Confirm trade</button>` : ''}</div></div>`).join('') : '<div class="note">No tradable signals. Semi-auto/Auto act only on Published setups whose LCB beats the quoted break-even.</div>'}</div>
    <div class="panel" style="margin-top:10px"><h3>Order ticket</h3>${m ? `<div class="row"><b>${esc(m.symbol)}</b>${E.marketGate(m).edge ? '' : '<span class="pill warn">no validated edge</span>'}<select id="bzTkDur">${m.durations.map((d) => `<option>${d.n}${d.unit}</option>`).join('')}</select>
      <button class="btn buy" data-act="buy" data-type="CALL" data-sym="${esc(m.symbol)}" ${acc.connected ? '' : 'disabled'}>Rise</button><button class="btn sell" data-act="buy" data-type="PUT" data-sym="${esc(m.symbol)}" ${acc.connected ? '' : 'disabled'}>Fall</button></div>
      <div class="note">Stake ${S.stake} · ${acc.connected ? (acc.isReal ? '🔴 REAL account (requires the confirm checkbox; stake capped)' : '🟢 DEMO account') : 'connect an account to trade'}. Orders go through Deriv proposal → buy; entry, payout, exit and P/L are Deriv's.</div>` : '<div class="note">Select a market on the Live tab.</div>'}</div>
    </div><div>
    <div class="panel"><h3>Open positions</h3>${tradesTable(S.trades.filter((t) => t.status === 'open'))}</div>
    <div class="panel" style="margin-top:10px"><h3>Event log</h3><div class="log">${S.log.map((l) => `<div class="${l.kind === 'bad' ? 'dn' : l.kind === 'ok' ? 'up' : l.kind === 'warn' ? '' : 'mu'}">${new Date(l.t).toLocaleTimeString()} · ${esc(l.msg)}</div>`).join('')}</div></div>
    <div class="panel note" style="margin-top:10px">Risk limits: stake ≤ ${S.limits.maxStake} (REAL ≤ ${S.limits.realMaxStake}), ≤ ${S.limits.maxConcurrent} open, 1 per market, daily loss limit ${S.limits.dailyLossLimit} (REAL ${S.limits.realDailyLossLimit}), ${S.limits.cooldownMs / 1000}s cooldown.</div></div></div>`;
}
