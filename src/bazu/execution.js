/**
 * src/bazu/execution.js
 * EXECUTION layer: commands over Deriv sockets. All entry/exit/payout/profit values come from Deriv.
 * Uses the app's authenticated trading socket (window.gridWs) and its pending-callback table
 * (window.gridPending) so no second authenticated connection is needed.
 */

let nextId = 0;
const own = () => (window.gridReqId = (window.gridReqId || 0) + 1);
const watched = new WeakSet();

export function accountInfo() {
  return {
    connected: !!(window.gridWs && window.gridWs.readyState === 1 && window.gridAuthed),
    isReal: !window.gridIsVirtual, // unknown is treated as REAL so guards apply
    isDemo: !!window.gridIsVirtual,
    balance: window.gridBalance, currency: window.gridCurrency || 'USD', loginId: window.gridLoginId,
  };
}

function call(msg, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = window.gridWs;
    if (!ws || ws.readyState !== 1 || !window.gridAuthed) return reject(new Error('Not connected to a Deriv account'));
    const id = own();
    const t = setTimeout(() => { delete window.gridPending[id]; reject(new Error('Deriv timeout')); }, timeoutMs);
    window.gridPending[id] = (data, err) => { clearTimeout(t); err ? reject(new Error(err.message || 'Deriv error')) : resolve(data); };
    ws.send(JSON.stringify({ ...msg, req_id: id }));
  });
}

export function durationFields(d) { return { duration: d.n, duration_unit: d.unit }; }

/** proposal -> buy, atomically on the live proposal id/ask_price. Resolves with Deriv's buy response. */
export async function buyRiseFall({ symbol, contractType, stake, duration }) {
  const acc = accountInfo();
  const proposal = await call({ proposal: 1, amount: stake, basis: 'stake', contract_type: contractType, currency: acc.currency, ...durationFields(duration), underlying_symbol: symbol });
  if (!proposal?.id) throw new Error('No proposal id from Deriv');
  let buy;
  try {
    buy = await call({ buy: proposal.id, price: proposal.ask_price });
  } catch (e) {
    if (!/unknown contract proposal|proposal/i.test(e.message)) throw e;
    // Proposal id not recognised on this socket: buy directly from parameters (still a real Deriv contract).
    buy = await call({
      buy: 1, price: Number(proposal.ask_price),
      parameters: { amount: stake, basis: 'stake', contract_type: contractType, currency: acc.currency, ...durationFields(duration), underlying_symbol: symbol },
    });
  }
  return { proposal, buy, isReal: acc.isReal, id: ++nextId };
}

/**
 * Subscribe a callback to open-contract updates on the current socket (once per socket).
 * cb(contract) receives Deriv's proposal_open_contract object.
 */
export function watchContracts(cb) {
  const ws = window.gridWs;
  if (!ws || watched.has(ws)) return;
  watched.add(ws);
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.msg_type === 'proposal_open_contract' && m.proposal_open_contract?.contract_id) cb(m.proposal_open_contract);
  });
}

export function requestContractUpdate(contractId) {
  const ws = window.gridWs;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: Number(contractId), subscribe: 1 }));
}
