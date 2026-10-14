/**
 * src/bazu/context3m.js  (pure)
 * Zones (bands), extended-move test, confirmation, breakout / fakeout / liquidity-sweep logic and
 * the expected 3-minute move. Reuses swing points (mtf) and clusterZones/order blocks (structure.js).
 * A signal needs zone context; without it the bot does not trade.
 */
import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';
import { detectOrderBlock } from '../../mtf/src/analysis/zonePatterns.js';
import { clusterZones } from './structure.js?v=15';

const LB = 2;
const band = (price, atr, k) => ({ low: price - k * atr, high: price + k * atr });

function zonesFrom(cs, tf, cfg) {
  const out = [];
  if (cs.length < 20) return out;
  const atr = cs[cs.length - 1].atr, i = cs.length - 1;
  if (!(atr > 0)) return out;
  const swings = findSwingPoints(cs, LB).filter((s) => s.index + LB <= i).slice(-40);
  for (const z of clusterZones(swings, cs, atr, i)) {
    const b = band(z.price, atr, cfg.zoneK);
    let flipped = false;
    for (let j = z.last + 1; j <= i; j++) {
      if (z.kind === 'resistance' && cs[j].close > b.high + 0.25 * atr) flipped = true;
      if (z.kind === 'support' && cs[j].close < b.low - 0.25 * atr) flipped = true;
    }
    const kind = flipped ? (z.kind === 'resistance' ? 'support' : 'resistance') : z.kind;
    out.push({ ...b, mid: z.price, kind, touches: z.touches, strength: z.strength, fresh: i - z.last <= 30, flipped, tf, overlap: 0 });
  }
  for (const o of detectOrderBlock(cs)) {
    if (o.index + 6 > i || i - o.index > 60) continue;
    out.push({ low: o.bottom, high: o.top, mid: (o.top + o.bottom) / 2, kind: o.direction === 'bullish' ? 'demand' : 'supply', touches: 1, strength: 1, fresh: true, flipped: false, tf, overlap: 0 });
  }
  return out;
}

/** Previous-day (last 24 H1 candles) high / low / open as levels. H4 and D1 are used for levels only. */
function dayLevels(h1, atr, cfg) {
  if (h1.length < 24 || !(atr > 0)) return [];
  const d = h1.slice(-24), hi = Math.max(...d.map((c) => c.high)), lo = Math.min(...d.map((c) => c.low)), op = d[0].open;
  return [['resistance', hi], ['support', lo], ['level', op]].map(([kind, p]) => ({ ...band(p, atr, cfg.zoneK), mid: p, kind, touches: 2, strength: 2, fresh: true, flipped: false, tf: 'D1', overlap: 0 }));
}

/** Zones from the setup frame plus context/bias frames (names from config roles); a setup zone gains `overlap` per higher-timeframe zone it intersects. */
export function buildZones(frames, cfg, roles) {
  const setup = zonesFrom(frames.setup, roles.setup, cfg), ctx = zonesFrom(frames.context, roles.context, cfg), bias = roles.bias === roles.context ? [] : zonesFrom(frames.bias, roles.bias, cfg);
  const atr = frames.setup.length ? frames.setup[frames.setup.length - 1].atr : NaN;
  const all = [...setup, ...ctx, ...bias, ...dayLevels(frames.H1 || [], atr, cfg)];
  for (const z of setup) for (const h of [...ctx, ...bias]) if (z.low <= h.high && z.high >= h.low) z.overlap++;
  return all;
}
/** Zones whose band lies within tolAtr * atr of price. */
export const zonesNear = (zones, price, atr, tolAtr = 0.75) => zones.filter((z) => price >= z.low - tolAtr * atr && price <= z.high + tolAtr * atr);

/** Supportive zone for a direction: Rise wants support/demand, Fall wants resistance/supply. */
export const supportiveKinds = (dir) => (dir > 0 ? ['support', 'demand'] : ['resistance', 'supply']);
export const opposingKinds = (dir) => (dir > 0 ? ['resistance', 'supply'] : ['support', 'demand']);

/** Distance (price units) to the nearest opposing zone edge, or Infinity. */
export function roomToRun(zones, price, dir) {
  let best = Infinity;
  for (const z of zones) {
    if (!opposingKinds(dir).includes(z.kind)) continue;
    const d = dir > 0 ? z.low - price : price - z.high;
    if (d >= 0 && d < best) best = d;
  }
  return best;
}

/** Net move over the last N closed candles in ATR units; `ext` when >= EXTENDED_ATR. dir = direction of the move. */
export function extendedMove(cs, i, cfg) {
  const a = cs[i]?.atr, from = cs[i - cfg.EXTENDED_N];
  if (!from || !(a > 0)) return { ext: false, dir: 0, atrs: 0 };
  const net = cs[i].close - from.close, atrs = Math.abs(net) / a;
  return { ext: atrs >= cfg.EXTENDED_ATR, dir: Math.sign(net), atrs };
}

/** Rejection score of candle c at zone z: wick toward the zone, close back outside, tick intensity vs average. */
export function rejection(c, z, avgN) {
  if (!c || !(c.range > 0)) return 0;
  const atZoneLow = c.low <= z.high && c.high >= z.low;
  if (!atZoneLow) return 0;
  const wick = z.kind === 'support' || z.kind === 'demand' ? c.lowerFrac : c.upperFrac;
  const closeOut = z.kind === 'support' || z.kind === 'demand' ? c.close > z.high : c.close < z.low;
  const inten = avgN > 0 && c.n ? Math.min(1, c.n / avgN / 2) : 0.3;
  return Math.min(1, 0.5 * wick + (closeOut ? 0.3 : 0) + 0.2 * inten);
}

/** Pattern confirmation: the next closed candle closes beyond the pattern candle, or tick delta/intensity shifts the same way. */
export function confirmed(cs, patternIdx, dir, avgN) {
  const p = cs[patternIdx], nx = cs[patternIdx + 1];
  if (nx && nx.patternOk !== false) return dir > 0 ? nx.close > p.high || nx.close > p.close : nx.close < p.low || nx.close < p.close;
  const c = cs[patternIdx];
  return !!c.n && Math.sign(c.delta || 0) === dir && (avgN ? c.n >= avgN : true);
}

/**
 * Breakout / fakeout / retest on closed candles `cs` (trigger frame) against `zones`.
 * Returns { state: 'confirmed'|'fakeout'|'none', direction, zone, reason }.
 */
export function breakoutState(cs, zones, cfg) {
  const n = cs.length, i = n - 1, a = cs[i]?.atr;
  if (n < 8 || !(a > 0)) return { state: 'none', direction: 0 };
  const span = cfg.RETEST_BARS + cfg.FAKEOUT_BARS;
  for (let j = Math.max(1, i - span); j <= i; j++) {
    const c = cs[j];
    if (!c.patternOk && !c.spike) continue;
    for (const z of zones) {
      if (!['resistance', 'supply', 'support', 'demand', 'level'].includes(z.kind)) continue;
      for (const up of [true, false]) {
        if (up ? !['resistance', 'supply', 'level'].includes(z.kind) : !['support', 'demand', 'level'].includes(z.kind)) continue;
        const edge = up ? z.high : z.low, beyond = up ? c.high - edge : edge - c.low;
        if (beyond <= 0.1 * a) continue;
        const closeBeyond = up ? c.close - edge : edge - c.close;
        const after = cs.slice(j + 1, Math.min(i, j + cfg.FAKEOUT_BARS) + 1);
        const backInside = closeBeyond < 0 || after.some((x) => (up ? x.close < edge : x.close > edge));
        const wick = up ? c.upperFrac : c.lowerFrac;
        if (backInside && (c.bodyRange < 0.5 || wick >= 0.5) && j >= i - cfg.FAKEOUT_BARS)
          return { state: 'fakeout', direction: up ? -1 : 1, zone: z, reason: `fakeout beyond ${up ? 'resistance' : 'support'}: closed back inside` };
        if (closeBeyond >= cfg.BREAKOUT_MIN_ATR * a && c.bodyRange >= cfg.BREAKOUT_BODY && !backInside) {
          const follow = after.length > 0 && after.every((x) => (up ? x.close > edge : x.close < edge));
          const retest = after.some((x) => (up ? x.low <= edge + 0.25 * a && x.close >= edge : x.high >= edge - 0.25 * a && x.close <= edge));
          if (follow && (retest || after.length >= 2)) return { state: 'confirmed', direction: up ? 1 : -1, zone: z, reason: `breakout ${up ? 'above' : 'below'} zone, follow-through${retest ? ' and retest held' : ''}` };
        }
      }
    }
  }
  return { state: 'none', direction: 0 };
}

/** Sweep of equal highs/lows followed by displacement back. direction -1 = highs swept (Fall), +1 = lows swept (Rise). */
export function liquiditySweep(cs, cfg) {
  const n = cs.length, i = n - 1, a = cs[i]?.atr;
  if (n < 20 || !(a > 0)) return { present: false, direction: 0 };
  const sw = findSwingPoints(cs, LB).filter((s) => s.index + LB < i - 1);
  for (const type of ['high', 'low']) {
    const list = sw.filter((s) => s.type === type).slice(-6);
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      if (Math.abs(list[x].price - list[y].price) > 0.1 * a) continue;
      const lvl = Math.max(list[x].price, list[y].price) * (type === 'high' ? 1 : 0) + Math.min(list[x].price, list[y].price) * (type === 'low' ? 1 : 0);
      for (let j = Math.max(list[y].index + 1, i - 2); j <= i; j++) {
        const c = cs[j], nx = cs[j + 1] || c;
        const swept = type === 'high' ? c.high > lvl && c.close < lvl : c.low < lvl && c.close > lvl;
        const disp = type === 'high' ? nx.dir < 0 && nx.body >= 0.6 * a : nx.dir > 0 && nx.body >= 0.6 * a;
        if (swept && disp) return { present: true, direction: type === 'high' ? -1 : 1, level: lvl, reason: `equal ${type}s swept then displacement back` };
      }
    }
  }
  return { present: false, direction: 0 };
}

/** Expected move over T seconds in price units: sigmaPerSec * sqrt(T). */
export const expectedMove = (sigmaPerSec, secs) => (Number.isFinite(sigmaPerSec) ? sigmaPerSec * Math.sqrt(secs) : NaN);
