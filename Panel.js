/**
 * analysis/statistics.js
 *
 * Phase 12: descriptive statistics for a region of candles. Pure function,
 * no DOM/AppState dependency — the caller (ui/analysisPanel.js) decides
 * WHICH candles constitute "the selected region" (see that file for the
 * two ways a region gets chosen: a selected zone's time bounds, or the
 * chart's current visible range).
 */

function bodySize(c) { return Math.abs(c.close - c.open); }
function wickSize(c) { return (c.high - Math.max(c.open, c.close)) + (Math.min(c.open, c.close) - c.low); }
function isBullish(c) { return c.close >= c.open; }

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @returns {object|null} null if candles is empty — there's no meaningful "stats for nothing"
 */
export function computeStats(candles) {
  if (!candles || candles.length === 0) return null;

  let bullishCount = 0, bearishCount = 0;
  let sumBody = 0, sumWick = 0;
  let largest = candles[0], smallest = candles[0];
  let largestRange = -Infinity, smallestRange = Infinity;
  let highestHigh = -Infinity, lowestLow = Infinity;

  for (const c of candles) {
    if (isBullish(c)) bullishCount++; else bearishCount++;
    sumBody += bodySize(c);
    sumWick += wickSize(c);
    const range = c.high - c.low;
    if (range > largestRange) { largestRange = range; largest = c; }
    if (range < smallestRange) { smallestRange = range; smallest = c; }
    if (c.high > highestHigh) highestHigh = c.high;
    if (c.low < lowestLow) lowestLow = c.low;
  }

  const n = candles.length;
  const first = candles[0], last = candles[n - 1];
  const duration = last.epoch - first.epoch; // seconds spanned by the region

  // Momentum: net directional move (last close vs first open) as a % of the first open —
  // a simple, honest measure of "how far did price travel, net, across this region", not a
  // predictive indicator.
  const momentum = first.open !== 0 ? ((last.close - first.open) / first.open) * 100 : 0;

  // Volatility: standard deviation of each candle's range (high-low), as a % of the mean
  // range — a simple dispersion measure of how consistently wide/narrow candles were, not
  // a claim of statistically rigorous realized volatility (which would need tick-level data
  // and a proper annualization convention neither this region nor this app's synthetic-index
  // context calls for).
  const ranges = candles.map(c => c.high - c.low);
  const meanRange = ranges.reduce((s, r) => s + r, 0) / n;
  const variance = ranges.reduce((s, r) => s + (r - meanRange) ** 2, 0) / n;
  const stdDevRange = Math.sqrt(variance);
  const volatilityPct = meanRange !== 0 ? (stdDevRange / meanRange) * 100 : 0;

  return {
    candleCount: n,
    bullishCount, bearishCount,
    avgBodySize: sumBody / n,
    avgWickSize: sumWick / n,
    largestCandle: largest,
    smallestCandle: smallest,
    highestHigh, lowestLow,
    durationSeconds: duration,
    momentumPct: momentum,
    volatilityPct,
  };
}
