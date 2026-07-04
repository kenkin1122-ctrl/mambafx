/**
 * analysis/swingPoints.js
 *
 * Fractal-based swing high/low detection: a candle at index i is a swing
 * high if its high is the highest among the `lookback` candles on each
 * side of it (strictly higher than all of them — ties don't count, to
 * avoid flagging a flat run of equal highs as multiple swing points).
 * Same logic mirrored for swing lows. This is the standard definition used
 * by most charting platforms for "fractal" swing points, and it's what
 * analysis/structurePatterns.js's BOS/CHoCH/Liquidity Sweep detectors are
 * built on — get this wrong and every structural pattern built on top of
 * it is wrong too, so it's tested in isolation before anything else uses it.
 */

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @param {number} [lookback=2] how many candles on each side must be lower/higher
 * @returns {Array<{index:number, epoch:number, price:number, type:'high'|'low'}>} sorted by index ascending
 */
export function findSwingPoints(candles, lookback = 2) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ index: i, epoch: c.epoch, price: c.high, type: 'high' });
    if (isLow) swings.push({ index: i, epoch: c.epoch, price: c.low, type: 'low' });
  }
  return swings;
}

/** Convenience: just the swing highs, in index order. */
export function swingHighs(candles, lookback = 2) {
  return findSwingPoints(candles, lookback).filter(s => s.type === 'high');
}

/** Convenience: just the swing lows, in index order. */
export function swingLows(candles, lookback = 2) {
  return findSwingPoints(candles, lookback).filter(s => s.type === 'low');
}

/** The most recent swing high/low strictly before index `beforeIndex`, or null if none exists. */
export function lastSwingBefore(swings, beforeIndex, type) {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].index < beforeIndex && (!type || swings[i].type === type)) return swings[i];
  }
  return null;
}
