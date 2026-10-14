/**
 * src/bazu/factors3m.js  (pure)
 * Independent factors. Each is (ctx) -> { vote: +1|-1|0, reason, group } so it can be tested and
 * switched on/off per market class from config. Indicator math lives in ta3m.js / stats.js (reused).
 * ctx = { frames, cfg, stat, zones, price, atr, symbol, spikeInfo }
 */
import { emaSlope, rsi, stochastic, cci, macdHist, adx, bollinger } from './ta3m.js?v=15';
import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';

const closes = (c) => c.map((x) => x.close);
const sgn = (x, dead = 0) => (x > dead ? 1 : x < -dead ? -1 : 0);
const V = (group, vote, reason) => ({ group, vote, reason });
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

export function mtfTrend({ frames }) {
  const votes = [];
  for (const k of ['trigger', 'setup', 'context']) {
    const c = frames[k];
    if (c.length < 25) continue;
    const a = c[c.length - 1].atr, s = emaSlope(closes(c), 20, 3);
    if (a > 0 && Number.isFinite(s)) votes.push([k, sgn(s / a, 0.02)]);
  }
  const sum = votes.reduce((a, [, v]) => a + v, 0);
  const vote = votes.length >= 2 ? sgn(sum, votes.length / 3) : 0;
  return V('trend', vote, `EMA20 slope ${votes.map(([k, v]) => `${k}${v > 0 ? '+' : v < 0 ? '-' : '0'}`).join(' ')}`);
}
export function macd({ frames }) {
  const h = macdHist(closes(frames.setup)), a = frames.setup.at(-1)?.atr;
  return V('trend', Number.isFinite(h) && a > 0 ? sgn(h / a, 0.01) : 0, `setup MACD hist ${f2(h, 4)}`);
}
export function adxFactor({ frames, cfg }) {
  const r = adx(frames.setup);
  const vote = r.adx >= cfg.ADX_TREND ? sgn(r.plusDI - r.minusDI, 2) : 0;
  return V('trend', vote, `setup ADX ${f2(r.adx, 0)} DI diff ${f2(r.plusDI - r.minusDI, 0)}`);
}
export function stoch({ frames, cfg }) {
  const s = stochastic(frames.setup);
  return V('momentum', s.k <= cfg.STOCH_OS && s.k > s.d ? 1 : s.k >= cfg.STOCH_OB && s.k < s.d ? -1 : 0, `setup Stoch K ${f2(s.k, 0)}`);
}
export function rsiFactor({ frames, cfg }) {
  const r = rsi(closes(frames.setup));
  return V('momentum', r <= cfg.RSI_OS ? 1 : r >= cfg.RSI_OB ? -1 : 0, `setup RSI ${f2(r, 0)}`);
}
export function cciFactor({ frames }) {
  const c = cci(frames.setup);
  return V('momentum', c <= -100 ? 1 : c >= 100 ? -1 : 0, `setup CCI ${f2(c, 0)}`);
}

/** HH/HL (up), LH/LL (down), with break of structure / change of character on the latest closed candle. */
export function structureState(cs) {
  if (cs.length < 20) return { trend: 0, bos: 0, choch: 0 };
  const sw = findSwingPoints(cs, 2).filter((s) => s.index + 2 <= cs.length - 1);
  const hi = sw.filter((s) => s.type === 'high').slice(-2), lo = sw.filter((s) => s.type === 'low').slice(-2);
  if (hi.length < 2 || lo.length < 2) return { trend: 0, bos: 0, choch: 0 };
  const up = hi[1].price > hi[0].price && lo[1].price > lo[0].price;
  const dn = hi[1].price < hi[0].price && lo[1].price < lo[0].price;
  const trend = up ? 1 : dn ? -1 : 0, last = cs.at(-1).close;
  let bos = 0, choch = 0;
  if (last > hi[1].price) { if (trend >= 0) bos = 1; else choch = 1; }
  if (last < lo[1].price) { if (trend <= 0) bos = -1; else choch = -1; }
  return { trend, bos, choch, lastHigh: hi[1].price, lastLow: lo[1].price };
}
export function structure({ frames }) {
  const s = structureState(frames.setup);
  return V('structure', s.choch || s.bos || s.trend, `setup structure ${s.trend > 0 ? 'HH/HL' : s.trend < 0 ? 'LH/LL' : 'mixed'}${s.bos ? ' BOS' : ''}${s.choch ? ' CHoCH' : ''}`);
}

export function zonesFactor({ zones, price, atr }) {
  let best = null;
  for (const z of zones) {
    const d = price < z.low ? z.low - price : price > z.high ? price - z.high : 0;
    if (d <= 0.75 * atr && (!best || z.strength + z.overlap > best.strength + best.overlap)) best = z;
  }
  if (!best) return V('location', 0, 'no zone nearby');
  const vote = ['support', 'demand'].includes(best.kind) ? 1 : ['resistance', 'supply'].includes(best.kind) ? -1 : 0;
  return V('location', vote, `at ${best.tf} ${best.kind}${best.flipped ? ' (flipped)' : ''}, ${best.touches} touches, overlap ${best.overlap}`);
}

export function volatility({ frames }) {
  const b = bollinger(closes(frames.setup));
  if (!Number.isFinite(b.pos)) return V('volatility', 0, 'insufficient data');
  if (b.squeeze) return V('volatility', 0, 'Bollinger squeeze: no edge until expansion');
  const vote = b.expansion ? sgn(b.pos, 0.5) : b.pos <= -1 ? 1 : b.pos >= 1 ? -1 : 0;
  return V('volatility', vote, `BB ${b.expansion ? 'expansion' : 'regular'} pos ${f2(b.pos, 1)}`);
}

/** Signed tick delta over 1/3/5 minutes, intensity vs the 20-bar average, absorption (high intensity, no progress). */
export function tickFlow({ frames }) {
  const arr = frames.forming ? [...frames.trigger, frames.forming] : frames.trigger;
  if (arr.length < 6) return V('flow', 0, 'insufficient flow data');
  const prev = arr.slice(-21, -1), avgN = prev.reduce((a, c) => a + (c.n || 0), 0) / Math.max(1, prev.length);
  const sum = (k) => arr.slice(-k).reduce((a, c) => a + (c.delta || 0), 0);
  const d1 = sum(1), d3 = sum(3), d5 = sum(5), cur = arr.at(-1);
  const inten = avgN > 0 ? (cur.n || 0) / avgN : 1;
  const prog = Math.abs(cur.close - cur.open) / (cur.atr || (cur.high - cur.low) || 1);
  const absorb = inten > 1.5 && prog < 0.3;
  return { group: 'flow', vote: absorb ? 0 : sgn(d1 + d3 + d5, 3), absorption: absorb, intensity: inten, reason: `tick delta 1/3/5 bars ${d1}/${d3}/${d5}, intensity ${f2(inten, 1)}x${absorb ? ', ABSORPTION' : ''}` };
}

export const hurstFactor = ({ stat }) => V('stat', 0, `Hurst ${f2(stat?.hurst)} (${stat?.hurst > 0.55 ? 'trending' : stat?.hurst < 0.45 ? 'mean-reverting' : 'random'}; regime input)`);
export const varianceRatioFactor = ({ stat }) => V('stat', 0, `variance ratio ${f2(stat?.vr)} (regime input)`);
export const ouHalfLife = ({ stat }) => V('stat', 0, `OU half-life ${Number.isFinite(stat?.halfLifeSec) ? stat.halfLifeSec.toFixed(0) + 's' : 'n/a'} (regime input)`);
export const kalman = ({ stat }) => V('stat', Number.isFinite(stat?.kalSlope) ? sgn(stat.kalSlope, 0.05) : 0, `Kalman slope ${f2(stat?.kalSlope)}`);
export const cusum = ({ stat }) => V('stat', 0, `CUSUM ${f2(stat?.cusum)} (change flag, regime input)`);

/** Boom/Crash/Jump: spikeInfo is computed in predict (bias = direction of the drift between spikes). */
export const spike = ({ spikeInfo }) => V('spike', spikeInfo ? spikeInfo.bias : 0, spikeInfo ? spikeInfo.reason : 'no spike info');

/** Range Break: structural only - near a range edge leans back inside. */
export function rangeBreak({ frames, price, atr }) {
  const c = frames.setup.slice(-30);
  if (c.length < 20 || !(atr > 0)) return V('structure', 0, 'insufficient data');
  const hi = Math.max(...c.map((x) => x.high)), lo = Math.min(...c.map((x) => x.low));
  const vote = price >= hi - 0.25 * atr ? -1 : price <= lo + 0.25 * atr ? 1 : 0;
  return V('structure', vote, `range ${f2(lo)}-${f2(hi)}, edge ${vote > 0 ? 'low' : vote < 0 ? 'high' : 'none'}`);
}
/** Step index: pure structure from the setup swing sequence. */
export function stepStructure({ frames }) {
  const s = structureState(frames.setup);
  return V('structure', s.trend, `Step structure ${s.trend > 0 ? 'higher' : s.trend < 0 ? 'lower' : 'flat'}`);
}

export const FACTORS = Object.freeze({ mtfTrend, macd, adx: adxFactor, stoch, rsi: rsiFactor, cci: cciFactor, structure, zones: zonesFactor, volatility, tickFlow, hurst: hurstFactor, varianceRatio: varianceRatioFactor, ouHalfLife, kalman, cusum, spike, rangeBreak, stepStructure });

export function runFactors(ctx) {
  const out = {};
  for (const [name, fn] of Object.entries(FACTORS)) {
    const f = ctx.cfg.factors[name];
    if (!f?.enabled) continue;
    try { out[name] = { ...fn(ctx), weight: f.weight ?? 1 }; } catch (e) { out[name] = { group: 'error', vote: 0, weight: 0, reason: `error: ${e.message}` }; }
  }
  return out;
}
