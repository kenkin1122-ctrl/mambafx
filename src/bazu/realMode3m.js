/**
 * src/bazu/realMode3m.js
 * Account modes. Demo trades as before. A real (or unknown-type) account trades only after an explicit, per-session opt-in
 * that is never persisted (no storage is touched here): every page load starts "demo only". Real Auto/Semi-auto needs a second,
 * separate opt-in. Real accounts also pass the REAL_* limits below, enforced by the choke point on every purchase attempt
 * (manual ticket, semi-auto, auto, retries, recovery). There is no bypass: the choke point refuses a real account when this
 * controller is missing.
 *
 * Never stores, logs or returns a token or a full account number: only the last 4 characters of the loginid are kept.
 */

/** Defaults are conservative; raise them here. 0 / non-finite values are treated as "block". */
export const REAL_LIMITS_DEFAULT = Object.freeze({
  REAL_MAX_STAKE: 0.35,            // market minimum stake
  REAL_MAX_OPEN_CONTRACTS: 1,
  REAL_MAX_EXPOSURE_PCT: 5,        // (open stake + new stake) as % of balance
  REAL_SESSION_LOSS_CAP: 2,        // net realised loss since page load, account currency
  REAL_DAILY_LOSS_CAP: 5,          // net realised loss since local midnight
  REAL_MAX_TRADES_PER_DAY: 20,
  REAL_LOSS_STREAK_N: 3,           // consecutive losses that trigger the cooldown
  REAL_COOLDOWN_MS: 15 * 60 * 1000,
});

export const REAL_PHRASE = 'REAL MONEY';
export const REAL_AUTO_PHRASE = 'REAL AUTO';
export const STALE_TICK_MS_DEFAULT = 5000;

export const suffixOf = (loginId) => (loginId ? String(loginId).slice(-4) : null);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : NaN);

/** Realised P/L of real trades, newest first helpers. Pure. */
export function realStats(trades, { sessionStart, dayStart }) {
  const real = trades.filter((t) => t.isReal);
  const closed = real.filter((t) => t.status === 'closed' && Number.isFinite(Number(t.profit)));
  const loss = (since) => -closed.filter((t) => (t.settledAt || t.ts) >= since).reduce((a, t) => a + Number(t.profit), 0);
  const open = real.filter((t) => t.status === 'open');
  const ordered = [...closed].sort((a, b) => (b.settledAt || b.ts) - (a.settledAt || a.ts));
  let streak = 0; for (const t of ordered) { if (Number(t.profit) < 0) streak++; else break; }
  return {
    open: open.length, openStake: open.reduce((a, t) => a + (num(t.buyPrice) || num(t.stake) || 0), 0),
    sessionLoss: loss(sessionStart), dailyLoss: loss(dayStart), tradesToday: real.filter((t) => t.ts >= dayStart).length,
    streak, lastLossAt: streak ? (ordered[0].settledAt || ordered[0].ts) : 0,
  };
}

export function createRealMode({ now = () => Date.now(), limits = REAL_LIMITS_DEFAULT, staleTickMs = STALE_TICK_MS_DEFAULT, onTrip = () => {} } = {}) {
  const startedAt = now();
  const st = { enabled: false, auto: false, suffix: null, reason: null, inflight: 0, inflightStake: 0 };
  const lim = () => ({ ...REAL_LIMITS_DEFAULT, ...limits });
  const dayStart = () => new Date(now()).setHours(0, 0, 0, 0);

  function trip(reason) {
    const was = st.auto; st.auto = false; st.reason = reason;
    if (was) onTrip(reason);
  }
  const sameAccount = (acc) => !!acc && acc.connected && st.suffix != null && suffixOf(acc.loginId) === st.suffix;

  return {
    /** Per-session state; read-only copy for the UI. */
    view: () => ({ ...st, limits: lim() }),
    isEnabledFor: (acc) => st.enabled && sameAccount(acc),
    isAutoEnabledFor: (acc) => st.enabled && st.auto && sameAccount(acc),

    /** Opt-in 1. Needs a connected real account, the typed phrase and (when known) the trade scope. */
    enable(acc, phrase) {
      if (!acc?.connected) return { ok: false, reason: 'Connect a Deriv account first' };
      if (!acc.isReal) return { ok: false, reason: 'This is a demo account - no opt-in is needed' };
      if (acc.scopes && !acc.scopes.includes('trade')) return { ok: false, reason: 'This token has no Trade scope' };
      if (!suffixOf(acc.loginId)) return { ok: false, reason: 'Account id unknown' };
      if (String(phrase).trim() !== REAL_PHRASE) return { ok: false, reason: `Type ${REAL_PHRASE} exactly to confirm` };
      st.enabled = true; st.auto = false; st.suffix = suffixOf(acc.loginId); st.reason = null;
      return { ok: true };
    },
    /** Takes effect immediately; also ends the Auto opt-in. */
    disable() { st.enabled = false; st.auto = false; st.suffix = null; st.reason = 'real trading disabled by user'; return { ok: true }; },
    /** Opt-in 2 (separate): Auto and Semi-auto on the real account. */
    enableAuto(acc, phrase) {
      if (!st.enabled || !sameAccount(acc)) return { ok: false, reason: 'Enable real trading first' };
      if (String(phrase).trim() !== REAL_AUTO_PHRASE) return { ok: false, reason: `Type ${REAL_AUTO_PHRASE} exactly to confirm` };
      st.auto = true; st.reason = null;
      return { ok: true };
    },
    disableAuto() { st.auto = false; st.reason = 'real Auto/Semi-auto disabled by user'; return { ok: true }; },
    trip,

    /** Periodic watchdog: connection loss, unknown balance or an account switch end the real opt-ins. */
    monitor(acc) {
      if (!st.enabled) return;
      if (acc?.connected && acc.isReal && suffixOf(acc.loginId) !== st.suffix) { st.enabled = false; st.auto = false; st.suffix = null; st.reason = 'account changed'; onTrip('account changed'); return; }
      if (acc?.connected && !acc.isReal) { st.enabled = false; st.auto = false; st.suffix = null; st.reason = 'demo account connected'; return; }
      if (!acc?.connected) { if (st.auto) trip('connection lost'); return; }
      if (st.auto && !(num(acc.balance) >= 0)) trip('balance unknown');
    },

    reserve(stake) { st.inflight++; st.inflightStake += stake; let done = false; return () => { if (!done) { done = true; st.inflight--; st.inflightStake -= stake; } }; },

    /**
     * The real-account gate. Called by the choke point for any account that is not a confirmed demo account.
     * { source: 'manual'|'auto'|'semi'|..., stake, acc, trades, dataAgeMs, ticketConfirmed } -> { ok, reason }
     */
    gate({ source = 'auto', stake, acc, trades = [], dataAgeMs = null, ticketConfirmed = false }) {
      if (!st.enabled || !sameAccount(acc)) return { ok: false, reason: 'Real trading is off (demo only mode) - use "Enable real trading"' };
      const automated = source !== 'manual', L = lim();
      if (automated && !st.auto) return { ok: false, reason: 'Auto/Semi-auto on a real account needs its own opt-in' };
      if (!automated && !st.auto && !ticketConfirmed) return { ok: false, reason: 'Real-account order needs the extra confirm click' };
      if (!(num(acc.balance) >= 0)) { if (automated) trip('balance unknown'); return { ok: false, reason: 'Real balance unknown' }; }
      if (automated && (!Number.isFinite(dataAgeMs) || dataAgeMs > staleTickMs)) { trip('stale data'); return { ok: false, reason: `Market data is stale (${Number.isFinite(dataAgeMs) ? Math.round(dataAgeMs) + ' ms' : 'unknown age'} > ${staleTickMs} ms)` }; }
      const blocked = (reason) => { if (automated) trip(reason); return { ok: false, reason }; };
      const s = realStats(trades, { sessionStart: startedAt, dayStart: dayStart() });
      if (!(stake > 0) || !(stake <= L.REAL_MAX_STAKE)) return blocked(`Stake ${stake} exceeds REAL_MAX_STAKE ${L.REAL_MAX_STAKE}`);
      if (s.open + st.inflight >= L.REAL_MAX_OPEN_CONTRACTS) return blocked(`REAL_MAX_OPEN_CONTRACTS ${L.REAL_MAX_OPEN_CONTRACTS} reached`);
      const exposure = (s.openStake + st.inflightStake + stake) / num(acc.balance) * 100;
      if (!(num(acc.balance) > 0) || exposure > L.REAL_MAX_EXPOSURE_PCT) return blocked(`Exposure ${Number.isFinite(exposure) ? exposure.toFixed(1) : '?'}% exceeds REAL_MAX_EXPOSURE_PCT ${L.REAL_MAX_EXPOSURE_PCT}%`);
      if (s.sessionLoss >= L.REAL_SESSION_LOSS_CAP) return blocked(`REAL_SESSION_LOSS_CAP ${L.REAL_SESSION_LOSS_CAP} reached - real trading blocked for the rest of this session`);
      if (s.dailyLoss >= L.REAL_DAILY_LOSS_CAP) return blocked(`REAL_DAILY_LOSS_CAP ${L.REAL_DAILY_LOSS_CAP} reached - real trading blocked for the rest of the day`);
      if (s.tradesToday >= L.REAL_MAX_TRADES_PER_DAY) return blocked(`REAL_MAX_TRADES_PER_DAY ${L.REAL_MAX_TRADES_PER_DAY} reached`);
      if (s.streak >= L.REAL_LOSS_STREAK_N && now() - s.lastLossAt < L.REAL_COOLDOWN_MS) {
        return blocked(`Cooldown after ${s.streak} consecutive losses: ${Math.ceil((L.REAL_COOLDOWN_MS - (now() - s.lastLossAt)) / 1000)}s left`);
      }
      return { ok: true };
    },
  };
}
