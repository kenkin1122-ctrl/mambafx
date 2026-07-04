/**
 * analysis/historicalSimilarity.js
 *
 * "Historical context" for the Smart Market Intelligence page: compares the
 * CURRENT market structure signature (trend direction, momentum sign,
 * bullish/bearish candle balance over a recent window) against every
 * earlier window of the same length in the SAME already-loaded candle
 * history, and reports how often sufficiently-similar setups were followed
 * by continuation vs reversal over a fixed look-ahead horizon.
 *
 * This is deliberately simple and fully deterministic — no ML, no
 * external data, no curve-fitting. The "similarity" score is a fixed,
 * inspectable formula (trend match + momentum-sign match + bullish-ratio
 * closeness). Precision here matters more than sophistication: every
 * number this produces is traceable back to real candles that actually
 * occurred in the loaded history, not a fabricated statistic.
 *
 * Honest limitation, stated directly: sample size is bounded by how much
 * history is loaded (~200 HTF candles), so results on a young session or a
 * newly-switched symbol may have too few analogs to be meaningful —
 * findHistoricalAnalogs() reports sampleSize explicitly so callers (and
 * the narrative text) can say so rather than presenting a thin sample as
 * confident evidence.
 */

import { inferOverallTrend } from './structurePatterns.js';

function buildSignature(windowCandles) {
  if (!windowCandles || windowCandles.length < 6) return null;
  const trend = inferOverallTrend(windowCandles, 1);
  const bullishCount = windowCandles.filter(c => c.close >= c.open).length;
  const bullishRatio = bullishCount / windowCandles.length;
  const momentum = windowCandles[0].open !== 0
    ? (windowCandles[windowCandles.length - 1].close - windowCandles[0].open) / windowCandles[0].open
    : 0;
  return { trend, bullishRatio, momentumSign: Math.sign(momentum) };
}

/** @returns {number} 0..1 */
function signatureSimilarity(a, b) {
  if (!a || !b) return 0;
  let score = 0;
  if (a.trend !== null && a.trend === b.trend) score += 0.5;
  if (a.momentumSign === b.momentumSign) score += 0.3;
  score += 0.2 * (1 - Math.min(1, Math.abs(a.bullishRatio - b.bullishRatio)));
  return score;
}

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @param {{windowSize?:number, lookAhead?:number, simThreshold?:number}} [opts]
 * @returns {{sampleSize:number, continued:number, reversed:number, neutral:number, continuedPct:number, reversedPct:number, currentTrend:'up'|'down'|null}|null}
 */
export function findHistoricalAnalogs(candles, opts = {}) {
  const windowSize = opts.windowSize ?? 12;
  const lookAhead = opts.lookAhead ?? 8;
  const simThreshold = opts.simThreshold ?? 0.75;

  if (!candles || candles.length < windowSize * 2 + lookAhead) return null;

  const currentSig = buildSignature(candles.slice(candles.length - windowSize));
  if (!currentSig || currentSig.trend === null) {
    return { sampleSize: 0, continued: 0, reversed: 0, neutral: 0, continuedPct: 0, reversedPct: 0, currentTrend: null };
  }

  let continued = 0, reversed = 0, neutral = 0;
  for (let end = windowSize; end <= candles.length - lookAhead; end++) {
    if (end > candles.length - windowSize) continue; // skip windows overlapping "now"

    const windowCandles = candles.slice(end - windowSize, end);
    const sig = buildSignature(windowCandles);
    if (!sig || sig.trend === null) continue;
    if (signatureSimilarity(currentSig, sig) < simThreshold) continue;

    const before = candles[end - 1].close;
    const after = candles[Math.min(end - 1 + lookAhead, candles.length - 1)].close;
    const changeFrac = before !== 0 ? (after - before) / before : 0;
    const continuedTrend = (sig.trend === 'up' && changeFrac > 0.001) || (sig.trend === 'down' && changeFrac < -0.001);
    const reversedTrend = (sig.trend === 'up' && changeFrac < -0.001) || (sig.trend === 'down' && changeFrac > 0.001);
    if (continuedTrend) continued++;
    else if (reversedTrend) reversed++;
    else neutral++;
  }

  const sampleSize = continued + reversed + neutral;
  return {
    sampleSize, continued, reversed, neutral,
    continuedPct: sampleSize ? Math.round((continued / sampleSize) * 100) : 0,
    reversedPct: sampleSize ? Math.round((reversed / sampleSize) * 100) : 0,
    currentTrend: currentSig.trend,
  };
}
