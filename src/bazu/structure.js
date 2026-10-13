/**
 * src/bazu/structure.js
 *
 * Causal market-structure / zone features built on the EXISTING mtf detectors
 * (swing points, BOS/CHoCH, liquidity sweep, FVG, order block). New here: S/R and
 * supply/demand zone clustering with strength (touches, rejection, age) and
 * distance in ATR units, which mtf/ does not provide.
 *
 * Causality: every mtf event is only considered available `lookback` candles
 * after the candle it is stamped on (swing confirmation delay), and order
 * blocks 6 candles after their candle (walk-back window), so nothing uses the future.
 * Features are evaluated at candle closes only; other ticks are NaN.
 */

import { findSwingPoints } from '../../mtf/src/analysis/swingPoints.js';
import { detectStructureBreaks, detectLiquiditySweep } from '../../mtf/src/analysis/structurePatterns.js';
import { detectFVG, detectOrderBlock } from '../../mtf/src/analysis/zonePatterns.js';

const LB = 2;

export function toCandles(prices, epochs, ticksPerCandle = 10) {
  const candles = [], closeIdx = [];
  for (let s = 0; s + ticksPerCandle <= prices.length; s += ticksPerCandle) {
    const seg = prices.slice(s, s + ticksPerCandle);
    candles.push({ epoch: epochs[s + ticksPerCandle - 1], open: seg[0], high: Math.max(...seg), low: Math.min(...seg), close: seg[seg.length - 1] });
    closeIdx.push(s + ticksPerCandle - 1);
  }
  return { candles, closeIdx };
}

function atrSeries(c, n = 14) {
  const out = new Array(c.length).fill(NaN);
  let prev = null;
  for (let i = 0; i < c.length; i++) {
    const tr = i ? Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)) : c[i].high - c[i].low;
    prev = prev === null ? tr : (prev * (n - 1) + tr) / n;
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

/** Cluster swing prices into zones; strength from touches, mean rejection (in ATR) and age decay. */
export function clusterZones(swings, candles, atr, i) {
  const tol = 0.5 * atr;
  const zones = [];
  for (const s of swings) {
    const z = zones.find((q) => Math.abs(q.price - s.price) <= tol && q.type === s.type);
    const cand = candles[s.index];
    const rej = s.type === 'high' ? cand.high - Math.max(cand.open, cand.close) : Math.min(cand.open, cand.close) - cand.low;
    if (z) { z.touches++; z.rej += rej; z.price = (z.price * (z.touches - 1) + s.price) / z.touches; z.last = s.index; }
    else zones.push({ type: s.type, price: s.price, touches: 1, rej, last: s.index });
  }
  return zones.map((z) => ({
    ...z, kind: z.type === 'high' ? 'resistance' : 'support',
    strength: z.touches * (1 + z.rej / z.touches / atr) * Math.exp(-(i - z.last) / 60),
  }));
}

const bias = (dUp, dDn) => (Number.isFinite(dUp) && Number.isFinite(dDn) ? (dUp - dDn) / (dUp + dDn || 1) : NaN);

/**
 * @returns {{ names: string[], series: Record<string, number[]>, meta: Record<string,{directional:boolean,discrete:boolean,proxy:boolean}>, closeIdx:number[] }}
 * series arrays are aligned with the tick array (NaN away from candle closes).
 */
export function computeStructureFeatures(prices, epochs, ticksPerCandle = 10) {
  const { candles, closeIdx } = toCandles(prices, epochs, ticksPerCandle);
  const n = candles.length, T = prices.length;
  const names = ['bosDir', 'chochDir', 'sweepDir', 'fvgDir', 'obDir', 'trendHHHL', 'srBias', 'sdBias', 'zoneDistATR', 'zoneStrength'];
  const series = Object.fromEntries(names.map((k) => [k, new Array(T).fill(NaN)]));
  const meta = {
    bosDir: { directional: true, discrete: true }, chochDir: { directional: true, discrete: true }, sweepDir: { directional: true, discrete: true },
    fvgDir: { directional: true, discrete: true }, obDir: { directional: true, discrete: true }, trendHHHL: { directional: true, discrete: true },
    srBias: { directional: true, discrete: false }, sdBias: { directional: true, discrete: false },
    zoneDistATR: { directional: false, discrete: false }, zoneStrength: { directional: false, discrete: false },
  };
  for (const k of names) meta[k].proxy = false;
  if (n < 30) return { names, series, meta, closeIdx };

  const atr = atrSeries(candles);
  const swings = findSwingPoints(candles, LB);
  const { bos, choch } = detectStructureBreaks(candles, LB);
  const sweeps = detectLiquiditySweep(candles, LB);
  const fvgs = detectFVG(candles);
  const obs = detectOrderBlock(candles);

  const avail = (ev, shift) => ev.map((e) => ({ ...e, at: e.index + shift }));
  const bosA = avail(bos, LB), chochA = avail(choch, LB), swpA = avail(sweeps, LB), fvgA = avail(fvgs, 1), obA = avail(obs, 6);
  const dirOf = (list, i, win) => {
    for (let k = list.length - 1; k >= 0; k--) if (list[k].at <= i) return i - list[k].at <= win ? (list[k].direction === 'bullish' ? 1 : -1) : 0;
    return 0;
  };
  const inZone = (list, i, px) => {
    for (let k = list.length - 1; k >= 0; k--) {
      const z = list[k];
      if (z.at > i) continue;
      if (i - z.at > 40) break;
      if (px >= z.bottom && px <= z.top) return z.direction === 'bullish' ? 1 : -1;
    }
    return 0;
  };

  for (let i = 20; i < n; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    const px = candles[i].close, t = closeIdx[i];
    const conf = swings.filter((s) => s.index + LB <= i).slice(-40);
    const zones = clusterZones(conf, candles, a, i);
    const sup = zones.filter((z) => z.kind === 'support' && z.price <= px).sort((x, y) => y.price - x.price)[0];
    const res = zones.filter((z) => z.kind === 'resistance' && z.price >= px).sort((x, y) => x.price - y.price)[0];
    const dS = sup ? (px - sup.price) / a : NaN, dR = res ? (res.price - px) / a : NaN;
    const demand = obA.filter((o) => o.at <= i && o.direction === 'bullish' && o.top <= px).slice(-1)[0];
    const supply = obA.filter((o) => o.at <= i && o.direction === 'bearish' && o.bottom >= px).slice(-1)[0];
    const dD = demand ? (px - demand.top) / a : NaN, dP = supply ? (supply.bottom - px) / a : NaN;

    series.bosDir[t] = dirOf(bosA, i, 3);
    series.chochDir[t] = dirOf(chochA, i, 3);
    series.sweepDir[t] = dirOf(swpA, i, 2);
    series.fvgDir[t] = inZone(fvgA, i, px);
    series.obDir[t] = inZone(obA, i, px);
    const hs = conf.filter((s) => s.type === 'high').slice(-2), ls = conf.filter((s) => s.type === 'low').slice(-2);
    series.trendHHHL[t] = hs.length === 2 && ls.length === 2
      ? (hs[1].price > hs[0].price && ls[1].price > ls[0].price ? 1 : hs[1].price < hs[0].price && ls[1].price < ls[0].price ? -1 : 0) : 0;
    series.srBias[t] = bias(dR, dS); // positive = nearer support than resistance
    series.sdBias[t] = bias(dP, dD);
    const near = Math.min(...[dS, dR].filter(Number.isFinite));
    series.zoneDistATR[t] = Number.isFinite(near) ? near : NaN;
    const nz = (sup && res) ? (dS < dR ? sup : res) : (sup || res);
    series.zoneStrength[t] = nz ? nz.strength : NaN;
  }
  return { names, series, meta, closeIdx };
}
