// Test-only: a scripted demo account socket for the memory soak. Injected into the page, never shipped by index.html.
(() => {
  const ws = new EventTarget();
  ws.readyState = 1; let n = 0;
  const reply = (id, data) => setTimeout(() => { const f = window.gridPending[id]; if (f) f(data); }, 20);
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.proposal === 1) return reply(m.req_id, { id: 'P' + (++n), ask_price: Number(m.amount), payout: +(m.amount * 1.95).toFixed(2), spot: 1 });
    if (m.buy) {
      const cid = 9000000 + (++n), secs = (m.parameters?.duration_unit === 't' ? 2 : 1) * (m.parameters?.duration || 5);
      reply(m.req_id, { contract_id: cid, buy_price: Number(m.price), payout: +(m.price * 1.95).toFixed(2) });
      setTimeout(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: cid, entry_tick: 1, entry_tick_time: Math.floor(Date.now() / 1000), exit_tick: 1.1, exit_tick_time: Math.floor(Date.now() / 1000) + secs, is_sold: 1, status: 'won', profit: 0.95, payout: 1.95 } }) })), secs * 1000);
    }
  };
  window.gridPending = window.gridPending; // accessor from the page bridge
  window.gridWs = ws; window.gridAuthed = true; window.gridIsVirtual = true; window.gridBalance = 10000; window.gridLoginId = 'VRTC0000'; window.gridCurrency = 'USD';
})();
