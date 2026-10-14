/**
 * src/bazu/candles3m.js  (pure)
 * ONE shared pass per candle close: geometry, robust ATR, spike flags/cooldown and tick-flow proxies.
 * Only CLOSED candles are ever used for pattern reading. The forming candle is exposed separately
 * and labelled provisional; it only contains ticks received up to the decision time.
 */
import { bucketCandles } from './timeframes.js?v=15';

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

/** Robust ATR: median of the last `n` true ranges, so isolated spike candles do not distort it. Returns a series. */
export function robustAtr(c, n = 14) {
  const tr = c.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low));
  return tr.map((_, i) => (i + 1 >= Math.min(n, 5) ? median(tr.slice(Math.max(0, i - n + 1), i + 1)) : NaN));
}

/** Aggregate finer candles into coarser buckets (used to derive M3 from M1). */
export function aggregate(candles, secs) {
  const out = [];
  for (const c of candles) {
    const b = Math.floor(c.epoch / secs) * secs, o = out[out.length - 1];
    if (o && o.epoch === b) { o.high = Math.max(o.high, c.high); o.low = Math.min(o.low, c.low); o.close = c.close; o.n = (o.n || 0) + (c.n || 0); o.delta = (o.delta || 0) + (c.delta || 0); o.mins = (o.mins || 1) + 1; }
    else out.push({ ...c, epoch: b, mins: 1 });
  }
  return out;
}

/** Candles whose bucket has fully ended at `nowEpoch`. */
export const closedOnly = (candles, secs, nowEpoch) => candles.filter((c) => c.epoch + secs <= nowEpoch);

/** Per-bucket tick intensity (count) and signed tick delta, attached to candles (proxy, not real volume). */
export function attachTickFlow(candles, prices, epochs, secs) {
  const idx = new Map(candles.map((c) => [c.epoch, c]));
  for (const c of candles) { c.n = 0; c.delta = 0; }
  for (let i = 1; i < prices.length; i++) {
    const c = idx.get(Math.floor(epochs[i] / secs) * secs);
    if (!c) continue;
    c.n++; c.delta += Math.sign(prices[i] - prices[i - 1]);
  }
  return candles;
}

/** Geometry of one candle. */
export function geometry(c, atr) {
  const range = c.high - c.low, body = Math.abs(c.close - c.open);
  const top = Math.max(c.open, c.close), bot = Math.min(c.open, c.close);
  const upper = c.high - top, lower = bot - c.low;
  return {
    range, body, upper, lower, dir: c.close > c.open ? 1 : c.close < c.open ? -1 : 0,
    bodyRange: range > 0 ? body / range : 0, upperFrac: range > 0 ? upper / range : 0, lowerFrac: range > 0 ? lower / range : 0,
    clv: range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0,
    rangeATR: atr > 0 ? range / atr : NaN, bodyATR: atr > 0 ? body / atr : NaN,
  };
}

/**
 * Shared pass: enrich closed candles with geometry, ATR, spike flag and cooldown.
 * cooling = within `cooldown` candles after a spike (pattern reading is skipped there).
 */
export function enrich(closed, cfg) {
  const atr = robustAtr(closed, cfg.ATR_PERIOD);
  const out = closed.map((c, i) => ({ ...c, atr: atr[i], ...geometry(c, atr[i]) }));
  let last = -Infinity;
  out.forEach((c, i) => {
    const ref = i ? atr[i - 1] : atr[i];
    c.spike = Number.isFinite(ref) && ref > 0 && c.range > cfg.SPIKE_ATR * ref;
    if (c.spike) last = i;
    c.cooling = !c.spike && i - last <= cfg.SPIKE_COOLDOWN;
    c.patternOk = !c.spike && !c.cooling;
  });
  return out;
}

/** Forming candle built only from ticks with epoch <= decisionEpoch. Always provisional. */
export function formingCandle(prices, epochs, secs, decisionEpoch) {
  const b = Math.floor(decisionEpoch / secs) * secs;
  const idx = [];
  for (let i = epochs.length - 1; i >= 0; i--) { if (epochs[i] > decisionEpoch) continue; if (epochs[i] < b) break; idx.unshift(i); }
  if (!idx.length) return null;
  let high = -Infinity, low = Infinity, delta = 0;
  for (const i of idx) { high = Math.max(high, prices[i]); low = Math.min(low, prices[i]); if (i > 0) delta += Math.sign(prices[i] - prices[i - 1]); }
  return { epoch: b, open: prices[idx[0]], high, low, close: prices[idx[idx.length - 1]], n: idx.length, delta, provisional: true };
}

/**
 * Build closed-candle frames named in `names` (keys of cfg.FRAMES) from remote Deriv candles plus live ticks.
 * `remote` = { M1, M5, M15, H1 } (any may be missing). Frames shorter than the base remote frame come from ticks only.
 * Tick-flow (intensity / signed delta) is attached to frames up to cfg.FLOW_MAX_FRAME_S. The forming candle uses
 * `formingSecs` and only ticks <= decisionEpoch.
 */
/*
 * Closed candles never change once their bucket has ended, so each frame (closed candles + tick flow + ATR/geometry
 * enrichment) is cached per `remote` object and rebuilt only when its inputs change: a new bucket closes, the remote
 * candle arrays are replaced, the tick buffer start moves (trim / history load) or the relevant config changes.
 * Output is identical to the uncached build (see tests/bazu/perf.test.mjs).
 */
const FRAME_CACHE = new WeakMap();
let cacheOn = true;
export const setFrameCache = (on) => { cacheOn = !!on; };

export function buildFrames({ remote, prices, epochs, decisionEpoch, cfg, names, formingSecs }) {
  const F = cfg.FRAMES, base = F.M1, frames = {};
  const store = cacheOn && remote && typeof remote === 'object' ? (FRAME_CACHE.get(remote) || FRAME_CACHE.set(remote, new Map()).get(remote)) : null;
  const t0 = epochs.length ? epochs[0] : 0, sig = `${cfg.FLOW_MAX_FRAME_S}|${cfg.ATR_PERIOD}|${cfg.SPIKE_ATR}|${cfg.SPIKE_COOLDOWN}|${base}`;
  let m1 = null;
  const getM1 = () => m1 || (m1 = mergeByEpoch(remote.M1 || [], prices.length ? bucketCandles(prices, epochs, base) : []));
  for (const k of names) {
    const secs = F[k], idx = Math.floor(decisionEpoch / secs), rk = remote[k] || null, rm = remote.M1 || null, hit = store && store.get(k);
    if (hit && hit.idx === idx && hit.t0 === t0 && hit.sig === sig && hit.rk === rk && hit.rm === rm && hit.secs === secs) { frames[k] = hit.value; continue; }
    const src = secs < base ? (prices.length ? bucketCandles(prices, epochs, secs) : []) : secs === base ? getM1() : mergeByEpoch(remote[k] || [], aggregate(getM1(), secs));
    const closed = closedOnly(src, secs, decisionEpoch);
    if (secs <= cfg.FLOW_MAX_FRAME_S) attachTickFlow(closed, prices, epochs, secs);
    frames[k] = enrich(closed, cfg);
    if (store) store.set(k, { idx, t0, sig, rk, rm, secs, value: frames[k] });
  }
  frames.forming = formingSecs ? formingCandle(prices, epochs, formingSecs, decisionEpoch) : null;
  return frames;
}function mergeByEpoch(remote, local) {
  const map = new Map(remote.map((c) => [c.epoch, c]));
  for (const c of local) if (!map.has(c.epoch)) map.set(c.epoch, c);
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
