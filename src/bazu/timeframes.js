/**
 * src/bazu/timeframes.js  (pure)
 * Chart timeframes from 2 ticks to 1 hour, price formatting and candle bucketing.
 * Tick and sub-minute frames are built from real Deriv ticks; 1m and above come from Deriv candles.
 */
import { toCandles } from './structure.js?v=14';

export const TIMEFRAMES = Object.freeze([
  { key: '2t', label: '2 ticks', ticks: 2 }, { key: '5t', label: '5 ticks', ticks: 5 },
  { key: '10t', label: '10 ticks', ticks: 10 }, { key: '30t', label: '30 ticks', ticks: 30 },
  { key: '15s', label: '15 sec', secs: 15 }, { key: '30s', label: '30 sec', secs: 30 },
  { key: '1m', label: '1 min', secs: 60, remote: true }, { key: '5m', label: '5 min', secs: 300, remote: true },
  { key: '15m', label: '15 min', secs: 900, remote: true }, { key: '30m', label: '30 min', secs: 1800, remote: true },
  { key: '1h', label: '1 hour', secs: 3600, remote: true },
]);

export const timeframe = (key) => TIMEFRAMES.find((t) => t.key === key) || TIMEFRAMES[2];

/** Decimal places from a Deriv pip size (0.01 -> 2, or an already-integer count). */
export function decimalsFromPip(pip) {
  const p = Number(pip);
  if (!Number.isFinite(p) || p <= 0) return null;
  return p < 1 ? Math.min(8, Math.round(-Math.log10(p))) : Math.min(8, Math.round(p));
}

/** Fixed decimals, so a trailing zero is always shown (e.g. 1247.80, never 1247.8). */
export function fmtPrice(v, dp) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return dp == null ? String(v) : Number(v).toFixed(dp);
}

/** Time-bucketed candles from ticks; buckets aligned to epoch multiples of secs. */
export function bucketCandles(prices, epochs, secs) {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    const b = Math.floor(epochs[i] / secs) * secs, c = out[out.length - 1];
    if (c && c.epoch === b) { if (prices[i] > c.high) c.high = prices[i]; if (prices[i] < c.low) c.low = prices[i]; c.close = prices[i]; }
    else out.push({ epoch: b, open: prices[i], high: prices[i], low: prices[i], close: prices[i] });
  }
  return out;
}

/** Fold ticks newer than the last remote candle into it (forming candle) or append new buckets. */
export function mergeLive(candles, prices, epochs, secs) {
  if (!candles.length) return candles;
  const out = candles.map((c) => ({ ...c }));
  let last = out[out.length - 1];
  for (let i = 0; i < prices.length; i++) {
    if (epochs[i] < last.epoch) continue;
    const b = Math.floor(epochs[i] / secs) * secs;
    if (b === last.epoch) { last.high = Math.max(last.high, prices[i]); last.low = Math.min(last.low, prices[i]); last.close = prices[i]; }
    else if (b > last.epoch) { last = { epoch: b, open: prices[i], high: prices[i], low: prices[i], close: prices[i] }; out.push(last); }
  }
  return out;
}

/** Candles for a timeframe from local ticks (tick and sub-minute frames). */
export function localCandles(prices, epochs, tf, max = 150) {
  let from = 0;
  if (tf.ticks) from = Math.max(0, prices.length - (max + 2) * tf.ticks);
  else { const cut = epochs[epochs.length - 1] - (max + 1) * tf.secs; from = epochs.length; while (from > 0 && epochs[from - 1] >= cut) from--; }
  const p = prices.slice(from), e = epochs.slice(from);
  const c = tf.ticks ? toCandles(p, e, tf.ticks).candles : bucketCandles(p, e, tf.secs);
  return c.slice(-max);
}
