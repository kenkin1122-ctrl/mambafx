/**
 * analysis/swingLabels.js
 *
 * Labels each swing point (from analysis/swingPoints.js) as HH, HL, LH, or
 * LL by comparing it to the PREVIOUS swing of the SAME type:
 *   - A swing high is HH (Higher High) if its price exceeds the previous
 *     swing high's price, else LH (Lower High).
 *   - A swing low is HL (Higher Low) if its price exceeds the previous
 *     swing low's price, else LL (Lower Low).
 *
 * The first swing of each type has no prior swing of that type to compare
 * against, so it can't be meaningfully labeled HH/HL/LH/LL yet — it's
 * marked as the unlabeled starting point ('H'/'L'), not given a fabricated
 * comparison. This is deliberately the exact same convention traders use
 * by hand when annotating a chart: you can't call the first high on the
 * screen "higher" or "lower" than anything, because there's nothing
 * before it to compare to.
 */

import { findSwingPoints } from './swingPoints.js';

/**
 * @param {Array} candles
 * @param {number} [lookback=2]
 * @returns {Array<{index:number, epoch:number, price:number, type:'high'|'low', label:'HH'|'HL'|'LH'|'LL'|'H'|'L'}>} sorted by index ascending
 */
export function labelSwings(candles, lookback = 2) {
  const swings = findSwingPoints(candles, lookback);
  let lastHigh = null, lastLow = null;
  return swings.map(s => {
    let label;
    if (s.type === 'high') {
      label = lastHigh === null ? 'H' : (s.price > lastHigh.price ? 'HH' : 'LH');
      lastHigh = s;
    } else {
      label = lastLow === null ? 'L' : (s.price > lastLow.price ? 'HL' : 'LL');
      lastLow = s;
    }
    return { ...s, label };
  });
}
