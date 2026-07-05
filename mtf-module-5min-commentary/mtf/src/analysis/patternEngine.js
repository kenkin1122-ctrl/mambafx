/**
 * analysis/patternEngine.js
 *
 * Runs every Phase 11 detector over a candle series and merges the results
 * into one findings list, sorted most-recent-first (what a trader glancing
 * at the panel cares about first). Each finding carries enough to render a
 * readable line item and to jump the chart to it — see ui/analysisPanel.js.
 */

import { detectEngulfing, detectOutsideBar, detectInsideBar, detectPinBar, detectDoji } from './candlestickPatterns.js';
import { detectStructureBreaks, detectLiquiditySweep } from './structurePatterns.js';
import { detectFVG, detectOrderBlock } from './zonePatterns.js';

const LABELS = {
  engulfing: 'Engulfing', outsideBar: 'Outside Bar', insideBar: 'Inside Bar', pinBar: 'Pin Bar', doji: 'Doji',
  bos: 'Break of Structure', choch: 'Change of Character', liquiditySweep: 'Liquidity Sweep',
  fvg: 'Fair Value Gap', orderBlock: 'Order Block',
};

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @returns {Array<{type:string,label:string,index:number,epoch:number,direction?:string,description:string}>} sorted newest-first
 */
export function runPatternScan(candles) {
  if (!candles || candles.length < 3) return [];

  const { bos, choch } = detectStructureBreaks(candles);
  const all = [
    ...detectEngulfing(candles),
    ...detectOutsideBar(candles),
    ...detectInsideBar(candles),
    ...detectPinBar(candles),
    ...detectDoji(candles),
    ...bos,
    ...choch,
    ...detectLiquiditySweep(candles),
    ...detectFVG(candles),
    ...detectOrderBlock(candles),
  ];

  return all
    .map(f => ({ ...f, label: LABELS[f.type] || f.type, description: describe(f) }))
    .sort((a, b) => b.index - a.index);
}

function describe(f) {
  const dir = f.direction ? f.direction[0].toUpperCase() + f.direction.slice(1) : '';
  switch (f.type) {
    case 'engulfing': return `${dir} engulfing — the candle's body fully covers the prior candle's body.`;
    case 'outsideBar': return `${dir} outside bar — range fully engulfs the prior candle.`;
    case 'insideBar': return `Inside bar — range fully contained within the prior candle.`;
    case 'pinBar': return `${dir} pin bar — long rejection wick with a small opposite wick.`;
    case 'doji': return `Doji — open and close nearly equal, signaling indecision.`;
    case 'bos': return `${dir} break of structure — closed beyond the prior swing ${f.direction === 'bullish' ? 'high' : 'low'} at ${f.brokenLevel.toFixed(2)}.`;
    case 'choch': return `${dir} change of character — closed beyond the prior swing ${f.direction === 'bullish' ? 'high' : 'low'} at ${f.brokenLevel.toFixed(2)}, against the prevailing trend.`;
    case 'liquiditySweep': return `${dir} liquidity sweep — wick pierced ${f.sweptLevel.toFixed(2)} then closed back inside.`;
    case 'fvg': return `${dir} fair value gap between ${f.bottom.toFixed(2)} and ${f.top.toFixed(2)}.`;
    case 'orderBlock': return `${dir} order block between ${f.bottom.toFixed(2)} and ${f.top.toFixed(2)}, preceding a displacement move.`;
    default: return '';
  }
}
