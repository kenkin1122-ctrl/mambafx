/**
 * analysis/structurePatterns.js
 *
 * Detectors for the three market-structure patterns in the Phase 11 spec.
 * All three are defined relative to swing points (analysis/swingPoints.js)
 * — get the swing detector wrong and these are wrong too, which is why it
 * was tested in isolation first.
 *
 *   Break of Structure (BOS): price CLOSES beyond the most recent swing
 *     high (bullish BOS) or swing low (bearish BOS) — confirms the
 *     existing trend is continuing.
 *
 *   Change of Character (CHoCH): the first break of structure in the
 *     OPPOSITE direction of the prevailing trend — e.g. in an uptrend
 *     (series of higher highs), a close below the most recent swing LOW
 *     is a CHoCH, signaling the trend may be reversing. Distinguishing
 *     CHoCH from BOS requires knowing the prevailing trend direction,
 *     which this module infers from the sequence of recent swing points
 *     (higher highs + higher lows = uptrend, and vice versa).
 *
 *   Liquidity Sweep: a candle's WICK pierces beyond a swing point (taking
 *     out the liquidity resting there — stops above a swing high or below
 *     a swing low) but the candle's CLOSE comes back inside — the move
 *     didn't confirm, suggesting the level was "swept" rather than broken.
 */

import { findSwingPoints } from './swingPoints.js';

/** Infers the prevailing trend from the last few swing highs/lows: 'up' if highs and lows are both rising, 'down' if both falling, else null (no clear trend). */
function inferTrend(swings, beforeIndex) {
  const relevant = swings.filter(s => s.index < beforeIndex).slice(-4);
  const highs = relevant.filter(s => s.type === 'high');
  const lows = relevant.filter(s => s.type === 'low');
  if (highs.length >= 2 && lows.length >= 2) {
    const risingHighs = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const risingLows = lows[lows.length - 1].price > lows[lows.length - 2].price;
    if (risingHighs && risingLows) return 'up';
    if (!risingHighs && !risingLows) return 'down';
  }
  return null;
}

/**
 * Infers the overall trend for a whole candle region — same higher-highs/
 * higher-lows swing logic as the internal per-index inferTrend() used
 * during a BOS/CHoCH scan, but evaluated once at the end of the series.
 * Used by ai/ruleEngine.js (Phase 14) to classify Bullish/Bearish
 * Continuation and to distinguish Accumulation (basing after a downtrend)
 * from Distribution (topping after an uptrend).
 * @returns {'up'|'down'|null}
 */
export function inferOverallTrend(candles, lookback = 2) {
  const swings = findSwingPoints(candles, lookback);
  return inferTrend(swings, candles.length);
}

/**
 * @param {Array} candles
 * @param {number} [lookback=2] passed through to findSwingPoints
 * @returns {{bos: Array, choch: Array}} BOS and CHoCH findings, each {type, index, epoch, direction}
 */
export function detectStructureBreaks(candles, lookback = 2) {
  const swings = findSwingPoints(candles, lookback);
  const bos = [], choch = [];

  for (let i = lookback; i < candles.length; i++) {
    const c = candles[i];
    const priorHighs = swings.filter(s => s.type === 'high' && s.index < i);
    const priorLows = swings.filter(s => s.type === 'low' && s.index < i);
    const lastHigh = priorHighs[priorHighs.length - 1];
    const lastLow = priorLows[priorLows.length - 1];
    const trend = inferTrend(swings, i);

    if (lastHigh && c.close > lastHigh.price) {
      const finding = { index: i, epoch: c.epoch, direction: 'bullish', brokenLevel: lastHigh.price };
      // Breaking UP is continuation in an uptrend (BOS) but a reversal signal in a downtrend (CHoCH)
      if (trend === 'down') choch.push({ type: 'choch', ...finding });
      else bos.push({ type: 'bos', ...finding });
    }
    if (lastLow && c.close < lastLow.price) {
      const finding = { index: i, epoch: c.epoch, direction: 'bearish', brokenLevel: lastLow.price };
      if (trend === 'up') choch.push({ type: 'choch', ...finding });
      else bos.push({ type: 'bos', ...finding });
    }
  }
  return { bos, choch };
}

/**
 * @param {Array} candles
 * @param {number} [lookback=2]
 * @returns {Array<{type:'liquiditySweep', index:number, epoch:number, direction:'bullish'|'bearish', sweptLevel:number}>}
 */
export function detectLiquiditySweep(candles, lookback = 2) {
  const swings = findSwingPoints(candles, lookback);
  const found = [];

  for (let i = lookback; i < candles.length; i++) {
    const c = candles[i];
    const priorHighs = swings.filter(s => s.type === 'high' && s.index < i);
    const priorLows = swings.filter(s => s.type === 'low' && s.index < i);
    const lastHigh = priorHighs[priorHighs.length - 1];
    const lastLow = priorLows[priorLows.length - 1];

    // Wick pierces above a swing high, but close comes back below it — sell-side sweep (bearish signal: liquidity above the high was taken, then rejected)
    if (lastHigh && c.high > lastHigh.price && c.close < lastHigh.price) {
      found.push({ type: 'liquiditySweep', index: i, epoch: c.epoch, direction: 'bearish', sweptLevel: lastHigh.price });
    }
    // Wick pierces below a swing low, but close comes back above it — buy-side sweep (bullish signal)
    if (lastLow && c.low < lastLow.price && c.close > lastLow.price) {
      found.push({ type: 'liquiditySweep', index: i, epoch: c.epoch, direction: 'bullish', sweptLevel: lastLow.price });
    }
  }
  return found;
}
