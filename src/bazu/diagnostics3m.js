// Shared per-series trend diagnostics. Used by the Distribution tab and (later) the multi-timeframe playbook analysis.
// Pure functions: no DOM, no engine state, no order path.
import { varianceRatio, runsTestZ, diffs } from './stats.js?v=15';

export function autocorr(x, lag = 1) {
  const n = x.length;
  if (n < lag + 3) return NaN;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - m) ** 2;
  for (let i = lag; i < n; i++) num += (x[i] - m) * (x[i - lag] - m);
  return den > 0 ? num / den : NaN;
}

// Rescaled-range Hurst estimate on increments; ~0.5 random walk, >0.5 persistent, <0.5 mean reverting.
export function hurstRS(prices) {
  const r = diffs(prices).slice(1), n = r.length;
  if (n < 32) return NaN;
  const pts = [];
  for (let w = 8; w <= n / 2; w = Math.floor(w * 1.6) + 1) {
    let sum = 0, cnt = 0;
    for (let s = 0; s + w <= n; s += w) {
      const seg = r.slice(s, s + w), m = seg.reduce((a, b) => a + b, 0) / w;
      let acc = 0, lo = 0, hi = 0, ss = 0;
      for (const v of seg) { acc += v - m; lo = Math.min(lo, acc); hi = Math.max(hi, acc); ss += (v - m) ** 2; }
      const sd = Math.sqrt(ss / w);
      if (sd > 0) { sum += (hi - lo) / sd; cnt++; }
    }
    if (cnt) pts.push([Math.log(w), Math.log(sum / cnt)]);
  }
  if (pts.length < 3) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : NaN;
}

export function trendDiagnostics(prices, q = 5) {
  const r = diffs(prices).slice(1);
  return {
    n: prices.length,
    varianceRatio: varianceRatio(prices, q),
    autocorr1: autocorr(r, 1),
    runsZ: runsTestZ(r.map(Math.sign)),
    hurst: hurstRS(prices),
  };
}
