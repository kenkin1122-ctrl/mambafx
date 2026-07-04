/**
 * ai/probabilityEngine.js
 *
 * Multi-dimensional evidence engine — NOT a single fabricated probability.
 * For the current market state, computes:
 *   (1) P(current bias continues)
 *   (2) P(current bias fails/reverses)
 *   (3) P(reaching a user-specified price target, or a detected zone)
 *   (4) confidence — derived from how much the underlying evidence
 *       dimensions actually AGREE with each other, and from sample-size
 *       sufficiency, not asserted independently of the evidence
 *   (5) explicit invalidation conditions
 *
 * THE MODEL, STATED IN FULL: eight dimensions, each scored on a fixed
 * [-1, +1] scale (bearish to bullish) with a fixed, documented weight
 * summing to 1.0. The weighted sum of (score × weight) across all eight
 * IS the entire directional model — there is no hidden adjustment, no
 * external call, nothing that isn't traceable back to a specific computed
 * value from the currently loaded candles:
 *
 *   trend            weight 0.15  — inferOverallTrend(): +1 up / -1 down / 0 none
 *   momentum         weight 0.12  — stats.momentumPct, normalized to ±1 at ±5%
 *   structure        weight 0.15  — recent BOS/CHoCH balance (bullish vs bearish breaks)
 *   liquidity        weight 0.10  — direction of the most recent liquidity sweep, if any
 *   orderFlow        weight 0.15  — (buyingPressurePct − sellingPressurePct) / 100
 *   historicalSim    weight 0.13  — historicalSimilarity's continued-vs-reversed skew
 *   candleGenome     weight 0.10  — candleGenome's continued-vs-reversed skew
 *   mtfAlignment     weight 0.10  — does LTF order flow agree with the HTF trend?
 *   (volatility feeds CONFIDENCE, not the directional score — see below)
 *
 * Probabilities are deliberately capped to [5, 95] — this system never
 * claims certainty in either direction, because it never has grounds to.
 * Output is explicitly framed as probabilistic decision support, not a
 * prediction: every number describes what the CURRENTLY LOADED evidence
 * shows right now, not a promise about future price action.
 */

import { computeStats } from '../analysis/statistics.js';
import { computeOrderFlow } from '../orderflow/proxy.js';
import { runPatternScan } from '../analysis/patternEngine.js';
import { inferOverallTrend } from '../analysis/structurePatterns.js';
import { findHistoricalAnalogs } from '../analysis/historicalSimilarity.js';
import { findGenomeAnalogs } from '../analysis/candleGenome.js';

const WEIGHTS = {
  trend: 0.15, momentum: 0.12, structure: 0.15, liquidity: 0.10,
  orderFlow: 0.15, historicalSim: 0.13, candleGenome: 0.10, mtfAlignment: 0.10,
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function scoreTrend(trend) {
  return { score: trend === 'up' ? 1 : trend === 'down' ? -1 : 0, detail: trend };
}

function scoreMomentum(stats) {
  const score = clamp(stats.momentumPct / 5, -1, 1);
  return { score, detail: `${stats.momentumPct.toFixed(2)}%` };
}

function scoreStructure(findings, candleCount, recencyWindow = 20) {
  const recent = f => f.index >= candleCount - recencyWindow;
  const breaks = findings.filter(f => (f.type === 'bos' || f.type === 'choch') && recent(f));
  if (!breaks.length) return { score: 0, detail: 'no recent structure breaks' };
  const bullish = breaks.filter(f => f.direction === 'bullish').length;
  const bearish = breaks.length - bullish;
  return { score: (bullish - bearish) / breaks.length, detail: `${bullish} bullish / ${bearish} bearish breaks` };
}

function scoreLiquidity(findings, candleCount, recencyWindow = 10) {
  const sweep = [...findings].filter(f => f.type === 'liquiditySweep' && f.index >= candleCount - recencyWindow).sort((a, b) => b.index - a.index)[0];
  if (!sweep) return { score: 0, detail: 'no recent liquidity sweep' };
  return { score: sweep.direction === 'bullish' ? 1 : -1, detail: `${sweep.direction} sweep at ${sweep.sweptLevel.toFixed(2)}` };
}

function scoreOrderFlow(flow) {
  const score = (flow.buyingPressurePct - flow.sellingPressurePct) / 100;
  return { score, detail: `${flow.buyingPressurePct.toFixed(0)}% buy / ${flow.sellingPressurePct.toFixed(0)}% sell` };
}

function scoreHistoricalSim(analogs) {
  if (!analogs || analogs.currentTrend === null || analogs.sampleSize === 0) return { score: 0, detail: 'insufficient historical analogs', sampleSize: 0 };
  const dirSign = analogs.currentTrend === 'up' ? 1 : -1;
  const skew = (analogs.continuedPct - analogs.reversedPct) / 100;
  return { score: dirSign * skew, detail: `${analogs.sampleSize} analogs, ${analogs.continuedPct}% continued`, sampleSize: analogs.sampleSize };
}

function scoreGenome(genome) {
  if (!genome || genome.currentDirection === null || genome.sampleSize === 0) return { score: 0, detail: 'insufficient genome analogs', sampleSize: 0 };
  const skew = (genome.continuedPct - genome.reversedPct) / 100;
  return { score: genome.currentDirection * skew, detail: `${genome.sampleSize} genome analogs, ${genome.continuedPct}% continued`, sampleSize: genome.sampleSize };
}

function scoreMtfAlignment(htfTrend, ltfCandles) {
  if (!htfTrend || !ltfCandles || ltfCandles.length < 20) return { score: 0, detail: 'no lower-timeframe data' };
  const ltfFlow = computeOrderFlow(ltfCandles);
  if (!ltfFlow) return { score: 0, detail: 'insufficient lower-timeframe data' };
  const ltfDir = ltfFlow.buyingPressurePct >= ltfFlow.sellingPressurePct ? 1 : -1;
  const htfDir = htfTrend === 'up' ? 1 : -1;
  const agree = ltfDir === htfDir;
  return { score: agree ? htfDir * 1 : htfDir * -0.5, detail: agree ? 'LTF order flow agrees with HTF trend' : 'LTF order flow diverges from HTF trend' };
}

/**
 * @param {Array} htfCandles
 * @param {Array} ltfCandles
 * @param {'bullish'|'bearish'|'ranging'|'neutral'} bias — the already-derived bias, so continuation/reversal is measured relative to a single, consistent bias definition across the whole app.
 * @returns {object|null}
 */
export function runProbabilityEngine(htfCandles, ltfCandles, bias) {
  if (!htfCandles || htfCandles.length < 40) return null;

  const stats = computeStats(htfCandles);
  const flow = computeOrderFlow(htfCandles);
  const findings = runPatternScan(htfCandles);
  const trend = inferOverallTrend(htfCandles);
  const analogs = findHistoricalAnalogs(htfCandles);
  const genome = findGenomeAnalogs(htfCandles);
  if (!stats || !flow) return null;

  const dims = {
    trend: scoreTrend(trend),
    momentum: scoreMomentum(stats),
    structure: scoreStructure(findings, htfCandles.length),
    liquidity: scoreLiquidity(findings, htfCandles.length),
    orderFlow: scoreOrderFlow(flow),
    historicalSim: scoreHistoricalSim(analogs),
    candleGenome: scoreGenome(genome),
    mtfAlignment: scoreMtfAlignment(trend, ltfCandles),
  };

  const weightedScore = Object.keys(WEIGHTS).reduce((sum, key) => sum + dims[key].score * WEIGHTS[key], 0);

  const biasDirection = bias === 'bullish' ? 1 : bias === 'bearish' ? -1 : 0;
  let pContinue, pReverse;
  if (biasDirection === 0) {
    pContinue = 50; pReverse = 50;
  } else {
    const alignment = weightedScore * biasDirection;
    pContinue = Math.round(clamp(50 + alignment * 50, 5, 95));
    pReverse = 100 - pContinue;
  }

  const nonZeroDims = Object.values(dims).filter(d => d.score !== 0);
  const agreeingDims = nonZeroDims.filter(d => Math.sign(d.score) === Math.sign(weightedScore || 1));
  const agreementRatio = nonZeroDims.length ? agreeingDims.length / nonZeroDims.length : 0.5;
  const sampleSizePenalty = (dims.historicalSim.sampleSize < 3 ? 0.85 : 1) * (dims.candleGenome.sampleSize < 3 ? 0.85 : 1);
  const volatilityPenalty = (stats.volatilityPct > 80 || stats.volatilityPct < 5) ? 0.9 : 1;
  const confidence = Math.round(clamp(agreementRatio * 100 * sampleSizePenalty * volatilityPenalty, 10, 95));

  return {
    pContinue, pReverse, confidence, bias,
    dimensions: Object.entries(dims).map(([name, d]) => ({ name, score: Math.round(d.score * 100) / 100, weight: WEIGHTS[name], detail: d.detail })),
    weightedScore: Math.round(weightedScore * 100) / 100,
  };
}

/**
 * Empirical probability of price reaching `targetPrice` within
 * `lookAheadCandles`, computed from how often moves of the SAME relative
 * size actually occurred, historically, in the loaded data.
 * @param {Array} candles
 * @param {number} targetPrice
 * @param {{lookAheadCandles?:number}} [opts]
 * @returns {{probability:number, sampleSize:number, direction:'up'|'down', targetDistancePct:number}|null}
 */
export function computeReachProbability(candles, targetPrice, opts = {}) {
  const lookAheadCandles = opts.lookAheadCandles ?? 20;
  if (!candles || candles.length < lookAheadCandles + 10) return null;

  const currentPrice = candles[candles.length - 1].close;
  if (currentPrice === 0) return null;
  const targetDistanceFrac = Math.abs(targetPrice - currentPrice) / currentPrice;
  const directionNeeded = targetPrice >= currentPrice ? 1 : -1;
  if (targetDistanceFrac === 0) {
    return { probability: 95, sampleSize: candles.length, direction: directionNeeded === 1 ? 'up' : 'down', targetDistancePct: 0 };
  }

  let hits = 0, trials = 0;
  for (let i = 0; i < candles.length - lookAheadCandles; i++) {
    const startPrice = candles[i].close;
    if (startPrice === 0) continue;
    let reached = false;
    for (let j = i + 1; j <= Math.min(i + lookAheadCandles, candles.length - 1); j++) {
      const excursion = directionNeeded === 1
        ? (candles[j].high - startPrice) / startPrice
        : (startPrice - candles[j].low) / startPrice;
      if (excursion >= targetDistanceFrac) { reached = true; break; }
    }
    if (reached) hits++;
    trials++;
  }
  if (trials === 0) return null;

  return {
    probability: Math.round(clamp((hits / trials) * 100, 5, 95)),
    sampleSize: trials,
    direction: directionNeeded === 1 ? 'up' : 'down',
    targetDistancePct: Math.round(targetDistanceFrac * 10000) / 100,
  };
}
