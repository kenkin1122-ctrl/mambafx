/**
 * analysis/zonePatterns.js
 *
 * Automated detection for the two zone-based patterns in the Phase 11
 * spec — distinct from Phase 8/10's manual candle marking and zone
 * presets, which require a person to click. These scan the whole candle
 * series and find them algorithmically.
 *
 *   Fair Value Gap (FVG): a 3-candle imbalance — candle[i-1]'s high is
 *     below candle[i+1]'s low (bullish FVG, a gap up the middle candle
 *     didn't fill) or candle[i-1]'s low is above candle[i+1]'s high
 *     (bearish FVG). The gap itself is the zone between those two prices.
 *
 *   Order Block: the last opposite-colored candle immediately before a
 *     "displacement" move — a candle whose body is at least
 *     `displacementMult` times the average body size of the preceding
 *     candles, signaling the strong directional push that an Order Block
 *     is defined relative to.
 */

function bodySize(c) { return Math.abs(c.close - c.open); }
function isBullish(c) { return c.close >= c.open; }

/**
 * @returns {Array<{type:'fvg', index:number, epoch:number, direction:'bullish'|'bearish', top:number, bottom:number}>}
 *   index refers to the MIDDLE candle of the 3-candle pattern.
 */
export function detectFVG(candles) {
  const found = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const left = candles[i - 1], right = candles[i + 1];
    if (left.high < right.low) {
      found.push({ type: 'fvg', index: i, epoch: candles[i].epoch, direction: 'bullish', top: right.low, bottom: left.high });
    } else if (left.low > right.high) {
      found.push({ type: 'fvg', index: i, epoch: candles[i].epoch, direction: 'bearish', top: left.low, bottom: right.high });
    }
  }
  return found;
}

/**
 * @param {number} [displacementMult=2] a move counts as "displacement" if its body is at least this many times the average of the preceding `avgWindow` candles
 * @param {number} [avgWindow=10] how many preceding candles to average for the displacement baseline
 * @returns {Array<{type:'orderBlock', index:number, epoch:number, direction:'bullish'|'bearish', top:number, bottom:number}>}
 *   index refers to the ORDER BLOCK candle itself (the last opposite candle before the move), not the displacement candle.
 */
export function detectOrderBlock(candles, displacementMult = 2, avgWindow = 10) {
  const found = [];
  for (let i = avgWindow; i < candles.length; i++) {
    const window = candles.slice(i - avgWindow, i);
    const avgBody = window.reduce((sum, c) => sum + bodySize(c), 0) / window.length;
    if (avgBody === 0) continue;

    const move = candles[i];
    if (bodySize(move) < avgBody * displacementMult) continue; // not a displacement move

    // Walk backward from the displacement candle to find the last candle of
    // the OPPOSITE color — that's the order block.
    const moveBullish = isBullish(move);
    for (let j = i - 1; j >= 0; j--) {
      if (isBullish(candles[j]) !== moveBullish) {
        const ob = candles[j];
        found.push({
          type: 'orderBlock', index: j, epoch: ob.epoch,
          direction: moveBullish ? 'bullish' : 'bearish', // named for the move it precedes, matching common usage ("bullish order block" = the down-candle before an up-move)
          top: Math.max(ob.open, ob.close), bottom: Math.min(ob.open, ob.close),
        });
        break;
      }
      if (i - j > 5) break; // don't walk back further than 5 candles looking for the opposite color — beyond that it's not meaningfully "the" order block for this move
    }
  }
  return found;
}
