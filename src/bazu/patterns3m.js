/**
 * src/bazu/patterns3m.js  (pure)
 * Candlestick pattern library. Every pattern is a function (candles, i, cfg) -> result and only
 * reads candles[0..i] (closed candles), so it cannot look ahead. Thresholds come from cfg.patternCfg.
 * Candles must be enriched (see candles3m.enrich): atr, range, body, upper, lower, dir, bodyRange...
 */

const none = (name, kind) => ({ name, kind, present: false, direction: 0, strength: 0, reason: '' });
const hit = (name, kind, direction, strength, reason) => ({ name, kind, present: true, direction, strength: Math.max(0, Math.min(1, strength)), reason });
const ok = (c) => c && c.patternOk && c.atr > 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export function pinBar(cs, i, cfg) {
  const t = cfg.patternCfg, c = cs[i], N = 'pinBar';
  if (!ok(c) || !(c.range > 0) || c.rangeATR < t.pinRangeATR) return none(N, 'reversal');
  if (c.lower >= t.pinWick * c.body && c.lowerFrac >= t.pinWickFrac && c.upperFrac <= t.pinOppFrac)
    return hit(N, 'reversal', 1, c.lowerFrac, `hammer: lower wick ${(c.lowerFrac * 100).toFixed(0)}% of range`);
  if (c.upper >= t.pinWick * c.body && c.upperFrac >= t.pinWickFrac && c.lowerFrac <= t.pinOppFrac)
    return hit(N, 'reversal', -1, c.upperFrac, `shooting star: upper wick ${(c.upperFrac * 100).toFixed(0)}% of range`);
  return none(N, 'reversal');
}

export function engulfing(cs, i, cfg) {
  const N = 'engulfing', c = cs[i], p = cs[i - 1];
  if (!ok(c) || !ok(p) || !c.dir || !p.dir || c.dir === p.dir || c.bodyATR < cfg.patternCfg.engulfBodyATR) return none(N, 'reversal');
  const cTop = Math.max(c.open, c.close), cBot = Math.min(c.open, c.close), pTop = Math.max(p.open, p.close), pBot = Math.min(p.open, p.close);
  if (cTop < pTop || cBot > pBot) return none(N, 'reversal');
  if (c.dir > 0 ? !(c.close > p.open) : !(c.close < p.open)) return none(N, 'reversal');
  return hit(N, 'reversal', c.dir, Math.min(1, c.body / (p.body || 1) / 2 + 0.25), `${c.dir > 0 ? 'bullish' : 'bearish'} engulfing, body ${c.bodyATR.toFixed(1)} ATR`);
}

export function star(cs, i, cfg) {
  const N = 'star', c = cs[i], m = cs[i - 1], f = cs[i - 2];
  if (!ok(c) || !ok(m) || !ok(f) || !f.dir || !c.dir || f.dir === c.dir) return none(N, 'reversal');
  const small = m.body <= 0.35 * Math.max(f.body, 1e-12) && m.body <= 0.35 * Math.max(c.body, 1e-12);
  if (!small || f.bodyATR < 0.5 || c.bodyATR < 0.5) return none(N, 'reversal');
  const mid = (f.open + f.close) / 2;
  if (c.dir > 0 && f.dir < 0 && c.close > mid) return hit(N, 'reversal', 1, 0.8, 'morning star');
  if (c.dir < 0 && f.dir > 0 && c.close < mid) return hit(N, 'reversal', -1, 0.8, 'evening star');
  return none(N, 'reversal');
}

export function tweezer(cs, i, cfg) {
  const N = 'tweezer', c = cs[i], p = cs[i - 1], tol = cfg.patternCfg.tweezerATR * (c?.atr || 0);
  if (!ok(c) || !ok(p) || !c.dir || !p.dir || c.dir === p.dir) return none(N, 'reversal');
  if (c.dir < 0 && p.dir > 0 && near(c.high, p.high, tol)) return hit(N, 'reversal', -1, 0.6, 'tweezer top');
  if (c.dir > 0 && p.dir < 0 && near(c.low, p.low, tol)) return hit(N, 'reversal', 1, 0.6, 'tweezer bottom');
  return none(N, 'reversal');
}

export function piercing(cs, i) {
  const N = 'piercing', c = cs[i], p = cs[i - 1];
  if (!ok(c) || !ok(p) || !c.dir || !p.dir || c.dir === p.dir || p.bodyATR < 0.5 || c.bodyATR < 0.5) return none(N, 'reversal');
  const mid = (p.open + p.close) / 2;
  if (c.dir > 0 && p.dir < 0 && c.open < p.close && c.close > mid && c.close < p.open) return hit(N, 'reversal', 1, 0.65, 'piercing line');
  if (c.dir < 0 && p.dir > 0 && c.open > p.close && c.close < mid && c.close > p.open) return hit(N, 'reversal', -1, 0.65, 'dark cloud cover');
  return none(N, 'reversal');
}

export function harami(cs, i) {
  const N = 'harami', c = cs[i], p = cs[i - 1];
  if (!ok(c) || !ok(p) || !c.dir || !p.dir || c.dir === p.dir || p.bodyATR < 0.6) return none(N, 'reversal');
  const inside = Math.max(c.open, c.close) < Math.max(p.open, p.close) && Math.min(c.open, c.close) > Math.min(p.open, p.close);
  return inside ? hit(N, 'reversal', c.dir, 0.4, `${c.dir > 0 ? 'bullish' : 'bearish'} harami (low weight)`) : none(N, 'reversal');
}

/** Doji / indecision family. direction 0 (indecision) except dragonfly (+1) and gravestone (-1) which lean. */
export function doji(cs, i, cfg) {
  const N = 'doji', c = cs[i];
  if (!ok(c) || !(c.range > 0)) return none(N, 'indecision');
  const t = cfg.patternCfg.dojiBody;
  if (c.bodyRange <= t) {
    if (c.lowerFrac >= 0.6 && c.upperFrac <= 0.15) return hit(N, 'indecision', 1, 0.6, 'dragonfly doji');
    if (c.upperFrac >= 0.6 && c.lowerFrac <= 0.15) return hit(N, 'indecision', -1, 0.6, 'gravestone doji');
    if (c.upperFrac >= 0.35 && c.lowerFrac >= 0.35) return hit(N, 'indecision', 0, 0.6, 'long-legged doji');
    return hit(N, 'indecision', 0, 0.5, 'doji');
  }
  if (c.bodyRange <= 0.3 && c.upperFrac >= 0.25 && c.lowerFrac >= 0.25) return hit(N, 'indecision', 0, 0.35, 'spinning top');
  return none(N, 'indecision');
}

/** Inside bar; direction is set when the NEXT closed candle (i) breaks the mother bar (breakout), else 0. */
export function insideBar(cs, i) {
  const N = 'insideBar', c = cs[i], m = cs[i - 1], mm = cs[i - 2];
  if (!ok(c) || !ok(m)) return none(N, 'continuation');
  if (mm && ok(mm) && m.high < mm.high && m.low > mm.low) {
    if (c.close > mm.high) return hit(N, 'continuation', 1, 0.6, 'inside-bar breakout up');
    if (c.close < mm.low) return hit(N, 'continuation', -1, 0.6, 'inside-bar breakout down');
  }
  if (c.high < m.high && c.low > m.low) return hit(N, 'indecision', 0, 0.3, 'inside bar (compression)');
  return none(N, 'continuation');
}

export function displacement(cs, i, cfg) {
  const N = 'displacement', c = cs[i], t = cfg.patternCfg;
  if (!ok(c) || !c.dir || c.bodyRange < t.displaceBody || c.rangeATR < t.displaceRangeATR) return none(N, 'continuation');
  return hit(N, 'continuation', c.dir, Math.min(1, c.rangeATR / 3), `displacement ${c.rangeATR.toFixed(1)} ATR, body ${(c.bodyRange * 100).toFixed(0)}%`);
}

/** Impulse followed by a tight, shallow counter-drift (flag/pennant) and a resumption close. */
export function flagPennant(cs, i) {
  const N = 'flagPennant';
  if (i < 6) return none(N, 'continuation');
  const imp = cs[i - 5], flag = cs.slice(i - 4, i), c = cs[i];
  if (![imp, ...flag, c].every(ok) || imp.rangeATR < 1.5 || !imp.dir) return none(N, 'continuation');
  const hi = Math.max(...flag.map((x) => x.high)), lo = Math.min(...flag.map((x) => x.low));
  const tight = (hi - lo) <= imp.range * 0.6;
  const counter = imp.dir > 0 ? flag[flag.length - 1].close <= flag[0].open : flag[flag.length - 1].close >= flag[0].open;
  if (tight && counter && imp.dir > 0 && c.close > hi) return hit(N, 'continuation', 1, 0.6, 'bull flag breakout');
  if (tight && counter && imp.dir < 0 && c.close < lo) return hit(N, 'continuation', -1, 0.6, 'bear flag breakout');
  return none(N, 'continuation');
}

/** Rising/falling three methods: strong candle, three small counter candles inside its range, strong resumption. */
export function threeMethods(cs, i) {
  const N = 'threeMethods';
  if (i < 4) return none(N, 'continuation');
  const a = cs[i - 4], mid = cs.slice(i - 3, i), c = cs[i];
  if (![a, ...mid, c].every(ok) || !a.dir || a.dir !== c.dir || a.bodyATR < 0.8 || c.bodyATR < 0.8) return none(N, 'continuation');
  const inside = mid.every((x) => x.high <= a.high && x.low >= a.low && x.dir === -a.dir);
  const resume = a.dir > 0 ? c.close > a.close : c.close < a.close;
  return inside && resume ? hit(N, 'continuation', a.dir, 0.7, a.dir > 0 ? 'rising three methods' : 'falling three methods') : none(N, 'continuation');
}

/** Optional, off by default: 38-62% pullback of the last swing leg. Direction = resume the leg. */
export function fibPullback(cs, i, cfg) {
  const N = 'fibPullback', w = cs.slice(Math.max(0, i - 15), i + 1);
  if (w.length < 8 || !w.every((x) => x.atr > 0)) return none(N, 'continuation');
  let hiI = 0, loI = 0; w.forEach((x, k) => { if (x.high > w[hiI].high) hiI = k; if (x.low < w[loI].low) loI = k; });
  const up = loI < hiI, leg = w[hiI].high - w[loI].low, c = w[w.length - 1];
  if (!(leg > 1.5 * c.atr) || hiI === w.length - 1 || loI === w.length - 1) return none(N, 'continuation');
  const ret = up ? (w[hiI].high - c.close) / leg : (c.close - w[loI].low) / leg;
  return ret >= cfg.PULLBACK_MIN && ret <= cfg.PULLBACK_MAX ? hit(N, 'continuation', up ? 1 : -1, 0.4, `fib pullback ${(ret * 100).toFixed(0)}%`) : none(N, 'continuation');
}

/** ABCD: A->B leg, B->C retrace 38-79%, C->D extension is the call. Optional, off by default. Direction = AB leg direction reversed at D. */
export function abcd(cs, i, cfg) {
  const N = 'abcd', w = cs.slice(Math.max(0, i - 20), i + 1);
  if (w.length < 10 || !ok(cs[i])) return none(N, 'reversal');
  const p = fibPullback(cs, i, { ...cfg, PULLBACK_MIN: 0.382, PULLBACK_MAX: 0.79 });
  return p.present ? hit(N, 'reversal', -p.direction, 0.3, 'ABCD completion zone (low weight)') : none(N, 'reversal');
}

export const PATTERNS = Object.freeze({ pinBar, engulfing, star, tweezer, piercing, harami, doji, insideBar, flagPennant, threeMethods, displacement, abcd, fibPullback });

/** Run every enabled pattern on candle i. Logging-only side data (never affects trading by itself). */
export function runPatterns(cs, i, cfg) {
  const out = [];
  if (i < 0 || !cs[i]) return out;
  for (const [name, fn] of Object.entries(PATTERNS)) {
    if (!cfg.patterns[name]?.enabled) continue;
    const r = fn(cs, i, cfg);
    if (r.present) out.push({ ...r, weight: (cfg.patterns[name].weight || 1) * (cfg.patternWeights[name] ?? 1), epoch: cs[i].epoch });
  }
  return out;
}
