/**
 * src/bazu/risk.js
 *
 * Thin pre-trade risk gate for BAZU (the repo has no standalone Risk Engine to extend).
 * Pure: takes the proposed order and current state, returns allow/deny + reason.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxStake: 5, maxConcurrent: 3, maxPerMarket: 1, dailyLossLimit: 20, cooldownMs: 15000, realMaxStake: 2, realDailyLossLimit: 10,
});

/**
 * @param {{stake:number, market:string, isReal:boolean, realConfirmed:boolean, now:number}} order
 * @param {{open:Array<{market:string}>, todayPnl:number, lastTradeAt:Record<string,number>, balance:number}} state
 */
export function checkOrder(order, state, limits = DEFAULT_LIMITS) {
  const maxStake = order.isReal ? Math.min(limits.maxStake, limits.realMaxStake) : limits.maxStake;
  const lossLimit = order.isReal ? limits.realDailyLossLimit : limits.dailyLossLimit;
  if (!(order.stake > 0)) return { ok: false, reason: 'Stake must be positive' };
  if (order.isReal && !order.realConfirmed) return { ok: false, reason: 'Real account not confirmed' };
  if (state.balance != null && order.stake > state.balance) return { ok: false, reason: 'Insufficient balance' };
  const last = state.lastTradeAt?.[order.market];
  return { ok: true };
}

/** Capital exposure level for the metrics bar. */
export function exposureLevel(openStake, balance) {
  if (!(balance > 0)) return 'ok';
  const r = openStake / balance;
  return r > 0.25 ? 'bad' : r > 0.1 ? 'warn' : 'ok';
}
