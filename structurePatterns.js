/**
 * analysis/candlestickPatterns.js
 *
 * Detectors for the 5 single/two-candle patterns in the Phase 11 spec.
 * Each function scans a candle array and returns every match — pure,
 * side-effect-free, and independently testable (no dependency on
 * AppState, panels, or anything DOM-related), same design principle as
 * the drawing object hierarchy: logic that doesn't need a browser doesn't
 * get one.
 *
 * Definitions used (standard technical-analysis definitions, stated
 * explicitly since "pattern recognition" is meaningless without a precise
 * rule — these are deterministic rules, not ML/fuzzy matching):
 *
 *   Engulfing:   candle[i]'s body fully contains candle[i-1]'s body, and
 *                the two candles are opposite colors.
 *   Outside Bar: candle[i]'s high/low fully engulfs candle[i-1]'s high/low
 *                (range engulfing, not just body — a superset condition of
 *                candlestick "engulfing" that traders use for structure).
 *   Inside Bar:  candle[i]'s high/low is fully contained within
 *                candle[i-1]'s high/low (the opposite of Outside Bar).
 *   Pin Bar:     one wick is at least `wickRatio` (default 2x) the size of
 *                the body, and the opposite wick is small — signals
 *                rejection at that price level.
 *   Doji:        body size is below `bodyThreshold` (default 10%) of the
 *                candle's full range — open ≈ close, indicating indecision.
 */

function bodySize(c) { return Math.abs(c.close - c.open); }
function fullRange(c) { return c.high - c.low; }
function bodyTop(c) { return Math.max(c.open, c.close); }
function bodyBot(c) { return Math.min(c.open, c.close); }
function isBullish(c) { return c.close >= c.open; }

/** @returns {Array<{type:'engulfing', index:number, epoch:number, direction:'bullish'|'bearish'}>} */
export function detectEngulfing(candles) {
  const found = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], cur = candles[i];
    if (isBullish(cur) === isBullish(prev)) continue; // must be opposite colors
    const engulfs = bodyTop(cur) >= bodyTop(prev) && bodyBot(cur) <= bodyBot(prev) && bodySize(cur) > bodySize(prev);
    if (engulfs) {
      found.push({ type: 'engulfing', index: i, epoch: cur.epoch, direction: isBullish(cur) ? 'bullish' : 'bearish' });
    }
  }
  return found;
}

/** @returns {Array<{type:'outsideBar', index:number, epoch:number, direction:'bullish'|'bearish'}>} */
export function detectOutsideBar(candles) {
  const found = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], cur = candles[i];
    if (cur.high > prev.high && cur.low < prev.low) {
      found.push({ type: 'outsideBar', index: i, epoch: cur.epoch, direction: isBullish(cur) ? 'bullish' : 'bearish' });
    }
  }
  return found;
}

/** @returns {Array<{type:'insideBar', index:number, epoch:number}>} */
export function detectInsideBar(candles) {
  const found = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1], cur = candles[i];
    if (cur.high <= prev.high && cur.low >= prev.low) {
      found.push({ type: 'insideBar', index: i, epoch: cur.epoch });
    }
  }
  return found;
}

/**
 * @param {number} [wickRatio=2] the dominant wick must be at least this many times the body size
 * @param {number} [maxOppositeWickFrac=0.3] the opposite wick must be at most this fraction of the dominant wick
 * @returns {Array<{type:'pinBar', index:number, epoch:number, direction:'bullish'|'bearish'}>}
 */
export function detectPinBar(candles, wickRatio = 2, maxOppositeWickFrac = 0.3) {
  const found = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const body = bodySize(c);
    if (body === 0) continue; // a zero-body pin bar is really a doji — let detectDoji own that case
    const upperWick = c.high - bodyTop(c);
    const lowerWick = bodyBot(c) - c.low;

    if (lowerWick >= body * wickRatio && upperWick <= lowerWick * maxOppositeWickFrac) {
      // Long lower wick, rejection from below — bullish signal (hammer-type)
      found.push({ type: 'pinBar', index: i, epoch: c.epoch, direction: 'bullish' });
    } else if (upperWick >= body * wickRatio && lowerWick <= upperWick * maxOppositeWickFrac) {
      // Long upper wick, rejection from above — bearish signal (shooting-star-type)
      found.push({ type: 'pinBar', index: i, epoch: c.epoch, direction: 'bearish' });
    }
  }
  return found;
}

/** @param {number} [bodyThreshold=0.1] body size as a fraction of full range, below which it counts as a doji @returns {Array<{type:'doji', index:number, epoch:number}>} */
export function detectDoji(candles, bodyThreshold = 0.1) {
  const found = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const range = fullRange(c);
    if (range === 0) continue; // a candle with zero range (open=high=low=close) isn't a meaningful doji signal, just missing/flat data
    if (bodySize(c) / range <= bodyThreshold) {
      found.push({ type: 'doji', index: i, epoch: c.epoch });
    }
  }
  return found;
}
