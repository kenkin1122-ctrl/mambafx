/**
 * src/dashboard/debugPanel.js
 *
 * FUTURE PROJECT Phase 1, slice 1 -- extracted verbatim from index.html's
 * former inline <script> block (the "debug panel renderer", formerly at
 * lines 34967-35056 post-Phase-R0 / 34965-35054 pre-Phase-R0). This is a
 * pure move: the code inside the IIFE below is byte-for-byte identical to
 * what index.html used to run inline, only now loaded via
 * <script type="module" src="src/dashboard/debugPanel.js"> instead of a
 * classic inline <script> tag.
 *
 * Why this block was chosen as the first real extraction: it was verified,
 * by inspection, to have NO dependency on any bare (non-window-qualified)
 * top-level `let`/`const`/`function` identifier from index.html's other
 * script blocks -- its only external dependency is `window.__mfxDebug`
 * (already window-qualified, installed elsewhere in index.html), and its
 * own two entry points (`mfxToggleDebugPanel`, `mfxRenderDebugPanel`) were
 * already assigned onto `window.*`, which is exactly how index.html's
 * static `onclick="mfxToggleDebugPanel()"` button and the keyboard
 * shortcut continue to find them after this move -- inline event-handler
 * attributes resolve function names against the global object at the
 * time the event fires, not at parse time, so nothing about this move
 * changes when or how that lookup succeeds.
 *
 * A more entangled sibling block ("mfxBot", the floating trading widget)
 * was NOT extracted in this same step after inspection showed it reads
 * dozens of bare identifiers (lastPrice, gridWs, gridAuthed, SYMBOL,
 * decimals, MARKETS, runLen, ...) that are `let`/`const`-declared at the
 * top level of index.html's main script -- those bindings are visible to
 * other CLASSIC scripts via the shared per-realm script scope, but are
 * NOT `window.*` properties and are therefore invisible to an ES module,
 * which does not share that scope. Extracting mfxBot safely requires an
 * additional, separate step first (adding explicit `window.X = X;` mirror
 * assignments in index.html's main script) that was not part of this
 * slice -- see MSD_FUTURE_PROJECT_PHASE1_SLICE1_REPORT.md.
 *
 * Behavior: byte-for-byte identical to the original inline block. No
 * scientific logic, no UI redesign, no feature change.
 */

(function(){
  function fmt(v){ return (v === null || v === undefined) ? '—' : (typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)); }
  function section(title, html){ return `<div style="margin-bottom:14px"><div style="font-weight:700;color:#56b6ff;margin-bottom:4px;text-transform:uppercase;font-size:9.5px;letter-spacing:.06em">${title}</div>${html}</div>`; }
  function kv(label, value, color){ return `<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:#6b7689">${label}</span><span style="${color?'color:'+color+';':''}font-weight:600">${fmt(value)}</span></div>`; }

  window.mfxToggleDebugPanel = function(){
    const el = document.getElementById('mfxDebugPanel');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'block') window.mfxRenderDebugPanel();
  };

  window.mfxRenderDebugPanel = function(){
    const el = document.getElementById('mfxDebugPanel');
    const body = document.getElementById('mfxDebugPanelBody');
    if (!el || !body || el.style.display === 'none') return;
    if (!window.__mfxDebug) { body.innerHTML = '<div style="color:#ff4d6a">window.__mfxDebug not installed yet.</div>'; return; }

    const dbg = window.__mfxDebug;
    const state = dbg.getState();
    const socket = dbg.getSocketInfo();
    const perf = dbg.getPerformance();
    const errors = dbg.getErrors(8);
    const signals = dbg.getSignals(5);
    const recentMsgs = socket.recentMessages.slice(-8);

    let html = '';

    html += section('Connection', 
      kv('Status', socket.status, socket.status === 'live' ? '#1fdf9b' : '#ff4d6a') +
      kv('Reconnects', socket.reconnectCount) +
      kv('Avg Latency', socket.averageLatencyMs != null ? socket.averageLatencyMs + 'ms' : '—') +
      kv('Pending Requests', socket.pendingRequests)
    );

    if (state) {
      html += section('Current Market State',
        kv('Symbol', state.symbol) +
        kv('Tick', state.tick) +
        (state.currentCandle ? kv('Candle O/H/L/C', `${fmt(state.currentCandle.open)} / ${fmt(state.currentCandle.high)} / ${fmt(state.currentCandle.low)} / ${fmt(state.currentCandle.close)}`) : '')
      );
      if (state.indicators) {
        const ind = state.indicators;
        html += section('Indicators',
          kv('EMA 5/10/20', `${fmt(ind.ema5)} / ${fmt(ind.ema10)} / ${fmt(ind.ema20)}`) +
          kv('MACD / Signal', `${fmt(ind.macd)} / ${fmt(ind.macdSignal)}`) +
          kv('ADX', ind.adx) +
          kv('+DI / -DI', `${fmt(ind.plusDI)} / ${fmt(ind.minusDI)}`) +
          kv('RSI', ind.rsi) +
          kv('ATR', ind.atr)
        );
      }
    } else {
      html += section('Current Market State', '<div style="color:#6b7689">No state recorded yet.</div>');
    }

    html += section('Recent Signals', signals.length
      ? signals.slice().reverse().map(s => `<div style="border-left:2px solid #56b6ff;padding-left:6px;margin-bottom:6px">
          <div style="font-weight:700">${s.signal || '—'} <span style="color:#6b7689;font-weight:400">(${s.confidence != null ? (s.confidence*100).toFixed(0)+'%' : '—'})</span></div>
          <div style="color:#6b7689;font-size:9.5px">${s.marketState || ''}</div>
          ${Array.isArray(s.reasons) ? '<ul style="margin:2px 0 0 14px;padding:0;color:#9aa7bd;font-size:9.5px">' + s.reasons.map(r=>`<li>${r}</li>`).join('') + '</ul>' : ''}
        </div>`).join('')
      : '<div style="color:#6b7689">None recorded yet — no signal-generating engine is wired to recordSignal() yet.</div>');

    html += section('Recent WS Messages', recentMsgs.length
      ? recentMsgs.slice().reverse().map(m => `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #1a2233">
          <span style="color:${m.dir==='out'?'#a78bfa':'#1fdf9b'}">${m.dir==='out'?'↑':'↓'} ${(m.msg && (m.msg.msg_type||Object.keys(m.msg)[0]))||'?'}</span>
          <span style="color:#6b7689">${m.latencyMs!=null ? m.latencyMs+'ms' : ''}</span>
        </div>`).join('')
      : '<div style="color:#6b7689">No messages yet.</div>');

    html += section('Recent Errors', errors.length
      ? errors.slice().reverse().map(e => `<div style="color:#ff4d6a;padding:2px 0;border-bottom:1px solid #1a2233">[${e.source}] ${e.message}</div>`).join('')
      : '<div style="color:#1fdf9b">None.</div>');

    html += section('Performance', 
      kv('Market States Recorded', perf.marketStateCount) +
      kv('WS Log Entries', perf.wsLogCount) +
      kv('Errors', perf.errorCount) +
      kv('Est. Memory', perf.memoryEstimateBytes ? (perf.memoryEstimateBytes/1024).toFixed(1)+' KB' : '—')
    );

    body.innerHTML = html;
  };

  window.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); window.mfxToggleDebugPanel(); } });
  setInterval(() => { if (document.getElementById('mfxDebugPanel').style.display !== 'none') window.mfxRenderDebugPanel(); }, 500);
})();
