// Shared deterministic fixtures for BAZU tests (not a test file).
import { configFor } from '../../src/bazu/config3m.js';
import * as D from '../../src/bazu/duration3m.js';
import { durationAllowed } from '../../src/bazu/universe.js';
import { bucketCandles } from '../../src/bazu/timeframes.js';

export const T0 = 1700000000;
export const RANGES = [{ expiry: 'tick', lo: { unit: 't', n: 1 }, hi: { unit: 't', n: 10 } }, { expiry: 'intraday', lo: { unit: 's', n: 15 }, hi: { unit: 'h', n: 24 } }];
export const allowedFor = (cfg) => D.allowedDurations(RANGES, 1, cfg, durationAllowed);

export function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

/** Regime-switching walk: trending up/down segments, ranging segments and occasional bursts. 1 tick per second. */
export function regimeWalk(N = 60000, seed = 7, vol = 0.35) {
  const r = rng(seed), p = [], e = [];
  let x = 1000, mode = 0, left = 0, drift = 0;
  for (let i = 0; i < N; i++) {
    if (left <= 0) { mode = Math.floor(r() * 3); left = 600 + Math.floor(r() * 1800); drift = mode === 0 ? 0.04 : mode === 1 ? -0.04 : 0; }
    left--;
    const revert = mode === 2 ? -0.02 * (x - 1000 - Math.sin(i / 700) * 3) : 0;
    x += drift + revert + (r() - 0.5) * vol * (r() < 0.02 ? 4 : 1);
    p.push(+x.toFixed(4)); e.push(T0 + i);
  }
  return { p, e };
}

/** Remote candle arrays built only from ticks [0, k). */
export function remoteFrom(w, k, cfg = configFor('R_100')) {
  const out = {}, p = w.p.slice(0, k), e = w.e.slice(0, k);
  for (const f of ['M1', 'M3', 'M5', 'M15', 'H1']) out[f] = bucketCandles(p, e, cfg.FRAMES[f]).slice(-300);
  return out;
}

/** Candle builder for hand-made sequences: [open, high, low, close]. */
export const candle = (i, secs, o, h, l, c, extra = {}) => ({ epoch: T0 + i * secs, open: o, high: h, low: l, close: c, ...extra });
