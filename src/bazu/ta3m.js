/**
 * src/bazu/ta3m.js  (pure)
 * Small candle-based indicator helpers for the 3-minute path. Statistical tools reuse ./stats.js.
 * All functions take closed candles and return the latest value (or a series where noted).
 */
import { varianceRatio, ouFit, kalmanTrend, cusumSeries } from './stats.js?v=14';

export function emaSeries(x, n) {
  const k = 2 / (n + 1), out = [];
  x.forEach((v, i) => out.push(i ? out[i - 1] + k * (v - out[i - 1]) : v));
  return out;
}
const last = (a) => a[a.length - 1];

export function emaSlope(closes, n, lag = 3) {
  const e = emaSeries(closes, n);
  return e.length > lag ? (last(e) - e[e.length - 1 - lag]) / lag : NaN;
}

export function rsi(closes, n = 14) {
  if (closes.length <= n) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function stochastic(c, n = 14, d = 3) {
  if (c.length < n + d) return { k: NaN, d: NaN };
  const ks = [];
  for (let i = c.length - d; i < c.length; i++) {
    const w = c.slice(i - n + 1, i + 1), hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
    ks.push(hi > lo ? ((c[i].close - lo) / (hi - lo)) * 100 : 50);
  }
  return { k: last(ks), d: ks.reduce((a, b) => a + b, 0) / ks.length };
}

export function cci(c, n = 20) {
  if (c.length < n) return NaN;
  const tp = c.slice(-n).map((x) => (x.high + x.low + x.close) / 3), m = tp.reduce((a, b) => a + b, 0) / n;
  const md = tp.reduce((a, b) => a + Math.abs(b - m), 0) / n;
  return md > 0 ? (last(tp) - m) / (0.015 * md) : 0;
}

export function macdHist(closes, f = 12, s = 26, sig = 9) {
  if (closes.length < s + sig) return NaN;
  const ef = emaSeries(closes, f), es = emaSeries(closes, s), m = ef.map((v, i) => v - es[i]);
  return last(m) - last(emaSeries(m, sig));
}

/** Wilder ADX with +DI / -DI. */
export function adx(c, n = 14) {
  if (c.length < n * 2 + 1) return { adx: NaN, plusDI: NaN, minusDI: NaN };
  let tr = 0, pd = 0, md = 0; const dx = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    const t = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pd += p; md += m; } else { tr = tr - tr / n + t; pd = pd - pd / n + p; md = md - md / n + m; }
    if (i >= n) { const pdi = tr ? (100 * pd) / tr : 0, mdi = tr ? (100 * md) / tr : 0; dx.push({ v: pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0, pdi, mdi }); }
  }
  const a = dx.slice(-n).reduce((s, x) => s + x.v, 0) / Math.min(n, dx.length);
  return { adx: a, plusDI: last(dx).pdi, minusDI: last(dx).mdi };
}

export function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return { mid: NaN, width: NaN, pos: NaN, squeeze: false };
  const w = closes.slice(-n), mid = w.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  const widths = [];
  for (let i = n; i <= closes.length; i++) { const ww = closes.slice(i - n, i), m = ww.reduce((a, b) => a + b, 0) / n; widths.push(Math.sqrt(ww.reduce((a, b) => a + (b - m) ** 2, 0) / n)); }
  const sorted = [...widths].sort((a, b) => a - b), rank = sorted.indexOf(sd) / Math.max(1, sorted.length - 1);
  return { mid, width: (2 * k * sd) / (mid || 1), pos: sd > 0 ? (last(closes) - mid) / (k * sd) : 0, squeeze: rank <= 0.2, expansion: rank >= 0.8 };
}

/** Rescaled-range Hurst estimate over the series' increments. >0.5 trending, <0.5 mean-reverting. */
export function hurst(x) {
  if (x.length < 64) return NaN;
  const inc = x.slice(1).map((v, i) => v - x[i]), pts = [];
  for (const m of [8, 16, 32, Math.floor(inc.length / 2)]) {
    if (m < 8 || m > inc.length) continue;
    const rs = [];
    for (let s = 0; s + m <= inc.length; s += m) {
      const seg = inc.slice(s, s + m), mean = seg.reduce((a, b) => a + b, 0) / m;
      let cum = 0, mx = -Infinity, mn = Infinity, ss = 0;
      for (const v of seg) { cum += v - mean; mx = Math.max(mx, cum); mn = Math.min(mn, cum); ss += (v - mean) ** 2; }
      const sd = Math.sqrt(ss / m); if (sd > 0) rs.push((mx - mn) / sd);
    }
    if (rs.length) pts.push([Math.log(m), Math.log(rs.reduce((a, b) => a + b, 0) / rs.length)]);
  }
  if (pts.length < 2) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let nu = 0, de = 0; for (const [a, b] of pts) { nu += (a - mx) * (b - my); de += (a - mx) ** 2; }
  return de > 0 ? nu / de : NaN;
}

/** Statistical regime read on recent tick prices (tick-rate agnostic: caller passes epochs for the half-life scale). */
export function statRegime(prices, epochs) {
  const p = prices.slice(-600), e = epochs.slice(-600);
  if (p.length < 100) return null;
  const dt = (e[e.length - 1] - e[0]) / (e.length - 1) || 1;
  const vr = varianceRatio(p, 4), ou = ouFit(p), kal = kalmanTrend(p), rets = p.slice(1).map((v, i) => v - p[i]);
  const cus = cusumSeries(rets);
  const sd = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length) || 1;
  return { hurst: hurst(p), vr, halfLifeSec: ou.halfLife * dt, kalSlope: last(kal.velocity) / sd, cusum: typeof last(cus) === 'number' ? last(cus) : 0, sigmaPerSec: sd / Math.sqrt(dt) };
}
