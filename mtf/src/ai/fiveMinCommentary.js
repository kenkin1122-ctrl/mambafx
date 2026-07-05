/**
 * ai/fiveMinCommentary.js
 *
 * "5-Minute AI Market Commentary": a narrative report hardcoded to the
 * 5-minute timeframe specifically, with its own section structure —
 * Current Trend, Candle Psychology, Momentum Analysis, Institutional
 * Order Flow, Support and Resistance — distinct from Smart Market
 * Intelligence's report format. This reuses the exact same underlying
 * engines (analysis/statistics.js, orderflow/proxy.js,
 * analysis/swingLabels.js, analysis/structurePatterns.js, ai/ruleEngine.js)
 * rather than reimplementing any detection math; only the narrative
 * templating and section structure are new.
 *
 * "Candle Psychology" is the one genuinely new analytical angle here —
 * everything else recombines existing outputs. It's about the CURRENT
 * (possibly still-forming) candle specifically: its body-to-range ratio,
 * which side's wick shows a rejected push, and what that implies about
 * who's actually in control right now, as opposed to the broader-window
 * statistics the rest of the report draws on.
 *
 * POLARITY NOTE, stated because it was wrong once before in this project
 * and is worth being explicit about every time it's touched: orderflow's
 * `absorption` field is |netMove|/totalRange — a LOW value means genuine
 * absorption (lots of range traversed, little net progress); a HIGH value
 * means an efficient trend. "No significant distribution pattern" below
 * checks for a LOW absorption value, not a high one.
 */

import { computeStats } from '../analysis/statistics.js';
import { computeOrderFlow } from '../orderflow/proxy.js';
import { labelSwings } from '../analysis/swingLabels.js';
import { detectStructureBreaks, inferOverallTrend } from '../analysis/structurePatterns.js';
import { runPatternScan } from '../analysis/patternEngine.js';
import { runRuleEngine } from './ruleEngine.js';

const MIN_CANDLES = 30;

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} m5Candles
 * @returns {object|null} null when there isn't enough loaded 5-minute history yet
 */
export function generateFiveMinCommentary(m5Candles) {
  if (!m5Candles || m5Candles.length < MIN_CANDLES) return null;

  const stats = computeStats(m5Candles);
  const flow = computeOrderFlow(m5Candles);
  if (!stats || !flow) return null;

  const trend = inferOverallTrend(m5Candles);
  const swings = labelSwings(m5Candles, 2);
  const { bos, choch } = detectStructureBreaks(m5Candles, 2);
  const findings = runPatternScan(m5Candles);
  const ruleResults = runRuleEngine(m5Candles);
  const current = m5Candles[m5Candles.length - 1];

  const trendLabel = deriveTrendLabel(trend, ruleResults, choch);
  const trendNarrative = buildTrendNarrative(trend, trendLabel, swings, bos, choch, current);
  const candlePsychology = buildCandlePsychology(current);
  const momentum = buildMomentum(stats, m5Candles);
  const orderFlow = buildOrderFlow(flow, findings, m5Candles.length);
  const supportResistance = buildSupportResistance(swings, current.close);
  const warningSigns = buildWarningSigns(trendLabel, supportResistance, findings, m5Candles.length);

  return { trendLabel, trendNarrative, candlePsychology, momentum, orderFlow, supportResistance, warningSigns };
}

function deriveTrendLabel(trend, ruleResults, choch) {
  const cont = ruleResults.find(r => r.type === 'bullishContinuation' || r.type === 'bearishContinuation');
  if (cont) return cont.type === 'bullishContinuation' ? 'Bullish Continuation' : 'Bearish Continuation';
  const recentChoch = choch[choch.length - 1];
  if (recentChoch) return recentChoch.direction === 'bullish' ? 'Bullish Reversal' : 'Bearish Reversal';
  if (trend === 'up') return 'Bullish Continuation';
  if (trend === 'down') return 'Bearish Continuation';
  return 'Consolidation';
}

function buildTrendNarrative(trend, trendLabel, swings, bos, choch, current) {
  const bullish = trendLabel.startsWith('Bullish');
  const dir = bullish ? 'buyers' : 'sellers';
  const sentences = [];

  if (trend) {
    sentences.push(`The 5-minute timeframe remains in ${trendLabel === 'Consolidation' ? 'a consolidating range' : `an established ${bullish ? 'bullish' : 'bearish'} trend`}, with ${dir} continuing to defend ${bullish ? 'higher lows' : 'lower highs'}. Recent candles indicate that ${bullish ? 'bullish' : 'bearish'} momentum is still intact despite minor pullbacks.`);
  } else {
    sentences.push('The 5-minute timeframe does not currently show a clearly established trend in either direction.');
  }

  const lastLow = [...swings].reverse().find(s => s.type === 'low');
  const lastHigh = [...swings].reverse().find(s => s.type === 'high');
  if (bullish && lastLow) {
    const above = current.close > lastLow.price;
    sentences.push(`The current candle is developing ${above ? 'above' : 'below'} the previous swing low, suggesting that ${above ? 'buyers are absorbing selling pressure rather than allowing a bearish reversal' : 'sellers are testing that level directly'}.`);
  } else if (!bullish && lastHigh) {
    const below = current.close < lastHigh.price;
    sentences.push(`The current candle is developing ${below ? 'below' : 'above'} the previous swing high, suggesting that ${below ? 'sellers are absorbing buying pressure rather than allowing a bullish reversal' : 'buyers are testing that level directly'}.`);
  }

  const recentBearishBos = bos.some(b => b.direction === 'bearish');
  const recentBullishBos = bos.some(b => b.direction === 'bullish');
  if (bullish) {
    sentences.push(recentBearishBos
      ? 'A bearish break of structure has been confirmed, which weakens the case for continued upside.'
      : 'There is currently no confirmed bearish Break of Structure (BOS), so the primary market bias remains upward.');
  } else {
    sentences.push(recentBullishBos
      ? 'A bullish break of structure has been confirmed, which weakens the case for continued downside.'
      : 'There is currently no confirmed bullish Break of Structure (BOS), so the primary market bias remains downward.');
  }

  return sentences.join(' ');
}

function buildCandlePsychology(current) {
  const range = current.high - current.low || 1e-9;
  const body = Math.abs(current.close - current.open);
  const bullish = current.close >= current.open;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bodyRatio = body / range;

  const bullets = [];
  if (bullish) {
    bullets.push('Buyers continue to defend higher prices.');
    bullets.push(upperWick > body * 0.5
      ? 'Sellers have attempted to push price lower from the highs but have not gained control.'
      : 'Sellers have made little visible attempt to push price lower this candle.');
  } else {
    bullets.push('Sellers continue to defend lower prices.');
    bullets.push(lowerWick > body * 0.5
      ? 'Buyers have attempted to push price higher from the lows but have not gained control.'
      : 'Buyers have made little visible attempt to push price higher this candle.');
  }
  bullets.push(bodyRatio > 0.5
    ? 'The candle body remains healthy relative to its wick size, indicating sustained pressure in the current direction.'
    : 'The candle body is small relative to its wick size, indicating some hesitation rather than conviction.');
  bullets.push(`Unless the candle closes with significant ${bullish ? 'bearish' : 'bullish'} rejection, ${bullish ? 'buyers' : 'sellers'} retain the short-term advantage.`);

  return {
    intro: `The current candle forming reflects active participation from ${bullish ? 'buyers' : 'sellers'}.`,
    bullets,
    closing: 'The market structure continues to favor trend continuation.',
  };
}

function buildMomentum(stats, candles) {
  const positive = stats.momentumPct > 0;
  const observations = [];
  observations.push(`Price is advancing with ${stats.volatilityPct < 40 ? 'controlled' : 'elevated'} volatility.`);

  const recentBodies = candles.slice(-6).map(c => Math.abs(c.close - c.open));
  const firstHalf = recentBodies.slice(0, 3).reduce((s, b) => s + b, 0) / 3;
  const secondHalf = recentBodies.slice(3).reduce((s, b) => s + b, 0) / 3;
  const shrinking = secondHalf < firstHalf * 0.6;
  observations.push(shrinking
    ? 'Recent candle bodies are shrinking relative to prior ones — an early signal of momentum exhaustion worth watching.'
    : 'No signs of momentum exhaustion are currently evident.');

  return { direction: positive ? 'positive' : 'negative', momentumPct: stats.momentumPct, observations };
}

function buildOrderFlow(flow, findings, candleCount) {
  const buyersInControl = flow.buyingPressurePct >= flow.sellingPressurePct;
  const observations = [];
  observations.push(`${buyersInControl ? 'Buying' : 'Selling'} pressure exceeds ${buyersInControl ? 'selling' : 'buying'} pressure.`);
  observations.push(flow.absorption < 0.3
    ? 'A distribution-like pattern is visible — significant range with limited net progress.'
    : 'No significant distribution pattern is visible.');
  const recentSweep = findings.find(f => f.type === 'liquiditySweep' && f.index >= candleCount - 8);
  observations.push(recentSweep
    ? 'Recent pullbacks appear to be liquidity collection rather than the start of a trend reversal.'
    : 'No recent liquidity sweep has been detected in this window.');
  observations.push(`Smart money is likely ${buyersInControl ? 'defending recent demand' : 'defending recent supply'}.`);

  return { buyersInControl, buyingPressurePct: flow.buyingPressurePct, sellingPressurePct: flow.sellingPressurePct, observations };
}

function buildSupportResistance(swings, currentPrice) {
  const lows = swings.filter(s => s.type === 'low' && s.price < currentPrice);
  const highs = swings.filter(s => s.type === 'high' && s.price > currentPrice);
  const nearestSupport = lows.length ? lows[lows.length - 1] : null;
  const nearestResistance = highs.length ? highs[0] : null;

  return {
    support: nearestSupport ? {
      price: nearestSupport.price,
      label: nearestSupport.label === 'HL' ? 'Previous Higher Low' : 'Previous swing low',
      description: 'Recent demand zone remains respected.',
    } : null,
    resistance: nearestResistance ? {
      price: nearestResistance.price,
      label: 'Previous swing high',
      description: 'If broken, further upside continuation becomes more probable.',
    } : null,
  };
}

function buildWarningSigns(trendLabel, supportResistance, findings, candleCount) {
  const bullish = trendLabel.startsWith('Bullish');
  const signs = [];
  if (bullish && supportResistance.support) signs.push('Failure to hold the latest higher low.');
  if (!bullish && supportResistance.resistance) signs.push('Failure to hold the latest lower high.');
  const engulfing = findings.find(f => f.type === 'engulfing' && f.direction === (bullish ? 'bearish' : 'bullish') && f.index >= candleCount - 5);
  signs.push(`A strong ${bullish ? 'bearish' : 'bullish'} engulfing candle${engulfing ? ' (one has just formed)' : ''}.`);
  signs.push(`A confirmed ${bullish ? 'bearish' : 'bullish'} BOS.`);
  return signs;
}
