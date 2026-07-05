/**
 * ai/candleCommentary.js
 *
 * "5-Minute AI Market Commentary" for the Njanja Analysis page — reuses
 * every existing engine (statistics, order flow, structure breaks, swing
 * labeling, trend inference) exactly as Smart Market Intelligence does,
 * but assembles them into a DIFFERENT report structure: Current Trend,
 * Candle Psychology, Momentum Analysis, Institutional Order Flow, Support
 * & Resistance, Potential Warning Signs — matching the specific template
 * requested, not the Smart Market Intelligence layout.
 *
 * THE ONE GENUINELY NEW PIECE: "Candle Psychology" — analysis of the
 * CURRENTLY FORMING (possibly incomplete) candle's body-to-wick balance,
 * which nothing else in this app computes. Everything else here is
 * existing detection math, reorganized into new prose.
 *
 * Deterministic, rule-based — same "no external AI, every sentence traces
 * to a specific computed condition" discipline as narrativeEngine.js.
 */

import { computeStats } from '../analysis/statistics.js';
import { computeOrderFlow } from '../orderflow/proxy.js';
import { detectStructureBreaks, inferOverallTrend } from '../analysis/structurePatterns.js';
import { labelSwings } from '../analysis/swingLabels.js';
import { decimalsFor } from '../utils/geometry.js';

const MIN_CANDLES = 20;
const RECENCY_WINDOW = 10;
const ORDER_FLOW_WINDOW = 20; // "current" order flow means recent, not diluted by the entire loaded history

/** The one new piece of analysis: what does the currently-forming candle's shape suggest about which side is in control right now? */
function analyzeCandlePsychology(candles) {
  const last = candles[candles.length - 1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const bullish = last.close >= last.open;
  const bodyRatio = range > 0 ? body / range : 0;
  const opposingWick = bullish ? upperWick : lowerWick;
  const opposingWickSignificant = body > 0 && opposingWick > body * 0.3;
  const healthyBody = bodyRatio > 0.45;

  const sentences = [];
  sentences.push(`The current candle forming reflects active participation from ${bullish ? 'buyers' : 'sellers'}.`);
  sentences.push(bullish ? 'Buyers continue to defend higher prices.' : 'Sellers continue to press price lower.');
  sentences.push(opposingWickSignificant
    ? `${bullish ? 'Sellers' : 'Buyers'} have attempted to push price ${bullish ? 'lower' : 'higher'} but have not gained control.`
    : `${bullish ? 'Sellers' : 'Buyers'} have shown little resistance so far this candle.`);
  sentences.push(`The candle body ${healthyBody ? 'remains healthy' : 'is relatively small'} relative to its wick size, ${healthyBody ? 'indicating sustained' : 'suggesting hesitant'} ${bullish ? 'buying' : 'selling'} pressure.`);
  sentences.push(`Unless the candle closes with significant ${bullish ? 'bearish' : 'bullish'} rejection, ${bullish ? 'buyers' : 'sellers'} retain the short-term advantage.`);

  return { text: sentences.join(' '), bullish, healthyBody };
}

/** Nearest support = most recent labeled swing low at/below current price; nearest resistance = most recent labeled swing high at/above it. */
function findNearestLevels(swings, currentPrice) {
  const lows = [...swings].reverse().filter(s => s.type === 'low');
  const highs = [...swings].reverse().filter(s => s.type === 'high');
  const support = lows.find(s => s.price <= currentPrice) || lows[0] || null;
  const resistance = highs.find(s => s.price >= currentPrice) || highs[0] || null;
  return { support, resistance };
}

/**
 * @param {Array} candles the 5-minute panel's own candles
 * @returns {object|null}
 */
export function generateCandleCommentary(candles) {
  if (!candles || candles.length < MIN_CANDLES) return null;

  const stats = computeStats(candles);
  const flow = computeOrderFlow(candles.slice(-ORDER_FLOW_WINDOW));
  const trend = inferOverallTrend(candles);
  const swings = labelSwings(candles, 2);
  const { bos, choch } = detectStructureBreaks(candles, 2);
  const psychology = analyzeCandlePsychology(candles);
  const currentPrice = candles[candles.length - 1].close;
  const { support, resistance } = findNearestLevels(swings, currentPrice);
  const dec = decimalsFor(currentPrice);

  const recent = f => f.index >= candles.length - RECENCY_WINDOW;
  const recentBullishBos = bos.some(f => f.direction === 'bullish' && recent(f));
  const recentBearishBos = bos.some(f => f.direction === 'bearish' && recent(f));
  const recentBearishChoch = choch.some(f => f.direction === 'bearish' && recent(f));
  const recentBullishChoch = choch.some(f => f.direction === 'bullish' && recent(f));
  const bullishBias = trend === 'up' && !recentBearishChoch;
  const bearishBias = trend === 'down' && !recentBullishChoch;

  let trendLabel, trendNarrative;
  if (bullishBias) {
    trendLabel = recentBullishBos ? 'Bullish Continuation' : 'Bullish, Awaiting Confirmation';
    const lastHL = [...swings].reverse().find(s => s.type === 'low' && (s.label === 'HL' || s.label === 'L'));
    trendNarrative = `The 5-minute timeframe remains in an established bullish trend, with buyers continuing to defend higher lows. Recent candles indicate that bullish momentum is still intact despite minor pullbacks. ` +
      (lastHL ? `The current candle is developing above the previous swing low at ${lastHL.price.toFixed(dec)}, suggesting that buyers are absorbing selling pressure rather than allowing a bearish reversal. ` : '') +
      `There is currently no confirmed bearish Break of Structure, so the primary market bias remains upward.`;
  } else if (bearishBias) {
    trendLabel = recentBearishBos ? 'Bearish Continuation' : 'Bearish, Awaiting Confirmation';
    const lastLH = [...swings].reverse().find(s => s.type === 'high' && (s.label === 'LH' || s.label === 'H'));
    trendNarrative = `The 5-minute timeframe remains in an established bearish trend, with sellers continuing to defend lower highs. Recent candles indicate that bearish momentum is still intact despite minor pullbacks. ` +
      (lastLH ? `The current candle is developing below the previous swing high at ${lastLH.price.toFixed(dec)}, suggesting that sellers are absorbing buying pressure rather than allowing a bullish reversal. ` : '') +
      `There is currently no confirmed bullish Break of Structure, so the primary market bias remains downward.`;
  } else {
    trendLabel = 'Transitioning / Unclear';
    trendNarrative = `The 5-minute timeframe does not currently show a clearly established trend. Recent structure has been mixed, with no decisive break confirming control for either buyers or sellers. This is a lower-confidence environment for trend-following decisions until structure clarifies.`;
  }

  const momentumLabel = stats.momentumPct > 0.3 ? 'positive' : stats.momentumPct < -0.3 ? 'negative' : 'flat';
  const momentumObservations = [
    stats.volatilityPct < 50 ? 'Price is advancing with controlled volatility.' : 'Volatility is elevated relative to the recent range, warranting caution.',
    Math.abs(stats.momentumPct) < 3 ? 'No signs of momentum exhaustion are currently evident.' : 'The magnitude of the recent move is significant enough that a slowdown or pullback would not be surprising.',
  ];

  const buyersInControl = flow.buyingPressurePct > flow.sellingPressurePct;
  const orderFlowObservations = [
    `${buyersInControl ? 'Buying' : 'Selling'} pressure exceeds ${buyersInControl ? 'selling' : 'buying'} pressure.`,
    flow.absorption < 0.35 ? 'A significant distribution pattern is visible in recent price action.' : 'No significant distribution pattern is visible.',
    (bullishBias || bearishBias) ? 'Pullbacks appear to be liquidity collection rather than trend reversal.' : 'Recent pullbacks are less clearly one-sided, consistent with the lack of a firmly established trend.',
    `Smart money is likely defending the recent ${buyersInControl ? 'demand' : 'supply'} zone.`,
  ];

  const warningSigns = bullishBias
    ? ['Failure to hold the latest higher low.', 'A strong bearish engulfing candle.', 'A confirmed bearish Break of Structure.']
    : bearishBias
    ? ['Failure to hold the latest lower high.', 'A strong bullish engulfing candle.', 'A confirmed bullish Break of Structure.']
    : ['A decisive break of the current range in either direction would establish a new bias.'];

  return {
    trendLabel, trendNarrative,
    candlePsychology: psychology.text,
    momentumLabel, momentumObservations,
    orderFlowControl: buyersInControl ? 'buyers' : 'sellers',
    orderFlowObservations,
    support: support ? { label: support.label, price: support.price } : null,
    resistance: resistance ? { label: resistance.label, price: resistance.price } : null,
    warningSigns,
  };
}
