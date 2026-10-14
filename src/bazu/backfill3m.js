/**
 * src/bazu/backfill3m.js
 * Startup candle backfill for every configured frame, market by market (a market becomes ready as soon as
 * its own frames are in), with bounded concurrency and a minimum gap between requests (Deriv rate limits).
 * `send` is injected (engine's socket, or a test/measurement socket).
 */
import { configFor } from './config3m.js?v=15';

export const parseCandles = (r) => (r.candles || []).map((x) => ({ epoch: Number(x.epoch), open: +x.open, high: +x.high, low: +x.low, close: +x.close }));

/** Merge candle arrays by epoch (later wins), sorted. */
export function mergeCandles(a, b) {
  const m = new Map(); for (const c of a || []) m.set(c.epoch, c); for (const c of b || []) m.set(c.epoch, c);
  return [...m.values()].sort((x, y) => x.epoch - y.epoch);
}

/** Requests needed: one per market per frame. */
export const requestCount = (nMarkets, cfg = configFor('R_100')) => nMarkets * cfg.BACKFILL_FRAMES.length;

export async function backfill({ symbols, send, cfg = configFor('R_100'), store, onFrame, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const jobs = [];
  for (const sym of symbols) for (const k of cfg.BACKFILL_FRAMES) jobs.push({ sym, k });
  const stats = { requests: 0, failed: 0, readyAt: {}, startedAt: now() };
  const left = Object.fromEntries(symbols.map((s) => [s, cfg.BACKFILL_FRAMES.length]));
  let gateAt = 0;
  const worker = async () => {
    while (jobs.length) {
      const { sym, k } = jobs.shift();
      const wait = gateAt - now(); gateAt = Math.max(now(), gateAt) + cfg.BACKFILL_GAP_MS; if (wait > 0) await sleep(wait);
      stats.requests++;
      try {
        const r = await send({ ticks_history: sym, style: 'candles', granularity: cfg.FRAMES[k], count: cfg.BACKFILL_COUNT, end: 'latest' });
        const cs = parseCandles(r);
        if (store) { const s = (store[sym] ||= {}); s[k] = mergeCandles(s[k], cs); }
        onFrame && onFrame(sym, k, cs);
      } catch (e) { stats.failed++; onFrame && onFrame(sym, k, null, e); }
      if (--left[sym] === 0) stats.readyAt[sym] = now() - stats.startedAt;
    }
  };
  await Promise.all(Array.from({ length: cfg.BACKFILL_CONCURRENCY }, worker));
  stats.totalMs = now() - stats.startedAt;
  return stats;
}
