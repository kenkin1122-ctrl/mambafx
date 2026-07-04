/**
 * ai/ruleEngine.js
 *
 * Phase 14: deterministic (no external AI API) classification of a candle
 * region into named market conditions, each with a confidence score. Every
 * rule here is a fixed, stated combination of outputs already produced by
 * Phases 11-13 — pattern findings, statistics, order flow, and trend
 * inference — never a new opaque heuristic invented just for this file.
 * That traceability matters: if a classification looks wrong, you can
 * trace it back to the specific stats/findings that produced it.
 *
 * "Confidence score" here means how strongly the stated rule's inputs
 * satisfy its own thresholds — NOT a probability of being correct, and
 * NOT a claim about future price action. This is pattern-matching against
 * a fixed rule, nothing more; see the description text on every finding
 * and the Analysis panel's own framing (Phase 11) for the same caveat
 * applied consistently.
 */

import { computeStats } from '../analysis/statistics.js';
import { computeOrderFlow } from '../orderflow/proxy.js';
import { runPatternScan } from '../analysis/patternEngine.js';
import { inferOverallTrend } from '../analysis/structurePatterns.js';

const RECENCY_WINDOW = 8; // a structure break / sweep counts as "recent" if within this many candles of the region's end

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @returns {Array<{type:string,label:string,confidence:number,direction?:string,description:string}>} sorted by confidence, descending
 */
export function runRuleEngine(candles) {
  if (!candles || candles.length < 10) return [];

  const stats = computeStats(candles);
  const flow = computeOrderFlow(candles);
  const findings = runPatternScan(candles);
  const trend = inferOverallTrend(candles);
  if (!stats || !flow) return [];

  const results = [];
  const lastIndex = candles.length - 1;
  const isRecent = f => f.index >= lastIndex - RECENCY_WINDOW;

  const bosFindings = findings.filter(f => f.type === 'bos');
  const chochFindings = findings.filter(f => f.type === 'choch');
  const sweepFindings = findings.filter(f => f.type === 'liquiditySweep');
  const lastBOS = bosFindings[0]; // findings are sorted newest-first by patternEngine.js
  const lastCHoCH = chochFindings[0];
  const lastSweep = sweepFindings[0];

  // ── Trend Strength — always produced, even with a null trend (confidence reflects that) ──
  const totalBreaks = bosFindings.length + chochFindings.length;
  const bosRatio = totalBreaks > 0 ? bosFindings.length / totalBreaks : 0.5;
  const directionSkew = Math.abs(stats.bullishCount - stats.bearishCount) / stats.candleCount;
  const momentumComponent = Math.min(Math.abs(stats.momentumPct), 10) / 10; // cap contribution at 10%+ net move
  const trendStrength = Math.round((bosRatio * 0.45 + directionSkew * 0.35 + momentumComponent * 0.20) * 100);
  results.push({
    type: 'trendStrength', label: 'Trend Strength', confidence: trendStrength, direction: trend,
    description: trend
      ? `${trend === 'up' ? 'Upward' : 'Downward'} trend, ${(bosFindings.length)} structure break(s) confirming vs ${chochFindings.length} against, net move ${stats.momentumPct.toFixed(2)}%.`
      : `No clear directional trend — swing highs/lows aren't consistently rising or falling.`,
  });

  // ── Bullish / Bearish Continuation — requires trend + a same-direction recent BOS + matching order-flow pressure ──
  if (trend === 'up' && lastBOS?.direction === 'bullish' && isRecent(lastBOS) && flow.buyingPressurePct > 55) {
    results.push({
      type: 'bullishContinuation', label: 'Bullish Continuation',
      confidence: Math.round(flow.buyingPressurePct * 0.6 + trendStrength * 0.4),
      direction: 'bullish',
      description: `Uptrend confirmed by a recent bullish break of structure, with buying pressure at ${flow.buyingPressurePct.toFixed(0)}%.`,
    });
  }
  if (trend === 'down' && lastBOS?.direction === 'bearish' && isRecent(lastBOS) && flow.sellingPressurePct > 55) {
    results.push({
      type: 'bearishContinuation', label: 'Bearish Continuation',
      confidence: Math.round(flow.sellingPressurePct * 0.6 + trendStrength * 0.4),
      direction: 'bearish',
      description: `Downtrend confirmed by a recent bearish break of structure, with selling pressure at ${flow.sellingPressurePct.toFixed(0)}%.`,
    });
  }

  // ── Reversal — a recent CHoCH, boosted by a nearby liquidity sweep in the same direction ──
  if (lastCHoCH && isRecent(lastCHoCH)) {
    let confidence = 50;
    const supportingSweep = sweepFindings.find(s => s.direction === lastCHoCH.direction && Math.abs(s.index - lastCHoCH.index) <= 3);
    if (supportingSweep) confidence += 25;
    if ((lastCHoCH.direction === 'bullish' && flow.buyingPressurePct > 55) || (lastCHoCH.direction === 'bearish' && flow.sellingPressurePct > 55)) confidence += 15;
    results.push({
      type: 'reversal', label: 'Reversal', confidence: Math.min(100, confidence), direction: lastCHoCH.direction,
      description: `Change of character detected${supportingSweep ? ', preceded by a liquidity sweep' : ''} — the prevailing trend may be turning ${lastCHoCH.direction === 'bullish' ? 'up' : 'down'}.`,
    });
  }

  // ── Liquidity Grab — a recent sweep, confidence scaled by how decisively price rejected back ──
  if (lastSweep && isRecent(lastSweep)) {
    const sweptCandle = candles[lastSweep.index];
    const wick = lastSweep.direction === 'bearish' ? (sweptCandle.high - Math.max(sweptCandle.open, sweptCandle.close)) : (Math.min(sweptCandle.open, sweptCandle.close) - sweptCandle.low);
    const body = Math.abs(sweptCandle.close - sweptCandle.open) || 1e-9;
    const rejectionStrength = Math.min(100, (wick / body) * 25);
    results.push({
      type: 'liquidityGrab', label: 'Liquidity Grab', confidence: Math.round(50 + rejectionStrength * 0.5), direction: lastSweep.direction,
      description: `Price pierced ${lastSweep.sweptLevel.toFixed(2)} and closed back inside — resting liquidity beyond that level was likely taken.`,
    });
  }

  // ── Accumulation / Distribution — low volatility + LOW net-efficiency (i.e.
  // real absorption: lots of range traversed, little net progress) + near-zero
  // net move, distinguished by what preceded it.
  // NOTE ON POLARITY: flow.absorption = |netMove| / totalRange (from Phase 13's
  // computeOrderFlow). A LOW value means little net progress relative to the
  // range traversed — genuine absorption. A HIGH value means price moved
  // efficiently in one direction — a clean trend, the opposite condition.
  if (stats.volatilityPct < 35 && flow.absorption < 0.35 && Math.abs(stats.momentumPct) < 2) {
    const isDistribution = trend === 'up'; // topping after an uptrend vs basing after a downtrend/no trend
    results.push({
      type: isDistribution ? 'distribution' : 'accumulation', label: isDistribution ? 'Distribution' : 'Accumulation',
      confidence: Math.round((1 - flow.absorption) * 100),
      description: `Low volatility (${stats.volatilityPct.toFixed(0)}%) with little net progress despite the range traversed — price is ${isDistribution ? 'stalling after an uptrend, a possible topping pattern' : 'basing, a possible bottoming pattern'}.`,
    });
  }

  // ── Absorption — a standalone flag whenever net-efficiency is LOW (see
  // polarity note above), independent of the other Accumulation/Distribution
  // conditions.
  if (flow.absorption < 0.2) {
    results.push({
      type: 'absorption', label: 'Absorption', confidence: Math.round((1 - flow.absorption) * 100),
      description: `A large share of this region's total price range was traversed without net progress — strong two-sided activity at this level.`,
    });
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}
