/**
 * analysis/similarity.js
 *
 * Historical similarity: describes the current candle region as a small
 * feature vector (trend direction, momentum, volatility, dominant recent
 * pattern), then scans backward through the SAME loaded candle series for
 * earlier windows with a similar feature vector, and reports how those
 * earlier windows actually resolved (continued in the same direction, or
 * reversed) over the N candles that followed each one.
 *
 * Scope, stated plainly: this searches within whatever candle history is
 * already loaded (the same ~200 HTF candles the app normally keeps in
 * memory), not a separate deep historical archive — consistent with how
 * charts/replayManager.js (Phase 15) is scoped. It is NOT a machine-learned
 * pattern matcher; "similar" means "close in a handful of hand-chosen,
 * interpretable features," and the comparison logic is fully inspectable
 * below. This is meant to answer "have setups shaped like this tended to
 * continue or reverse, within the price history I can currently see" — a
 * modest, honest claim, not a promise of statistical significance.
 */

import { computeStats } from './statistics.js';
import { inferOverallTrend } from './structurePatterns.js';

/** Reduce a candle window to a small, comparable feature vector. */
function featuresOf(candles) {
  const stats = computeStats(candles);
  if (!stats) return null;
  const trend = inferOverallTrend(candles);
  return {
    trend,
    momentumSign: Math.sign(stats.momentumPct),
    momentumMagnitude: Math.min(Math.abs(stats.momentumPct), 15) / 15,
    volatilityNorm: Math.min(stats.volatilityPct, 100) / 100,
    bullishSkew: (stats.bullishCount - stats.bearishCount) / stats.candleCount,
  };
}

/** Distance between two feature vectors — lower is more similar. Trend mismatch is penalized heavily since it dominates what "similar setup" means to a trader. */
function distance(a, b) {
  if (!a || !b) return Infinity;
  const trendPenalty = a.trend === b.trend ? 0 : 0.6;
  return trendPenalty
    + Math.abs(a.momentumSign - b.momentumSign) * 0.15
    + Math.abs(a.momentumMagnitude - b.momentumMagnitude) * 0.5
    + Math.abs(a.volatilityNorm - b.volatilityNorm) * 0.3
    + Math.abs(a.bullishSkew - b.bullishSkew) * 0.4;
}

/**
 * @param {Array} candles full loaded candle series (oldest first)
 * @param {number} windowSize candles per comparison window
 * @param {number} lookaheadSize candles after a historical window checked for continuation/reversal
 * @param {number} maxMatches how many closest historical windows to return
 */
export function findSimilarHistoricalWindows(candles, windowSize = 12, lookaheadSize = 8, maxMatches = 8) {
  if (!candles || candles.length < windowSize * 2 + lookaheadSize) {
    return { available: false, matches: [], continuedCount: 0, reversedCount: 0 };
  }

  const currentWindow = candles.slice(candles.length - windowSize);
  const currentFeatures = featuresOf(currentWindow);
  if (!currentFeatures || !currentFeatures.trend) {
    return { available: false, matches: [], continuedCount: 0, reversedCount: 0 };
  }

  const candidates = [];
  const latestStart = candles.length - windowSize - lookaheadSize - windowSize;
  for (let start = 0; start <= latestStart; start++) {
    const window = candles.slice(start, start + windowSize);
    const features = featuresOf(window);
    if (!features || !features.trend) continue;
    const d = distance(currentFeatures, features);
    if (d > 0.9) continue;

    const after = candles.slice(start + windowSize, start + windowSize + lookaheadSize);
    const afterTrend = inferOverallTrend(window.concat(after));
    let outcome = 'inconclusive';
    if (afterTrend) outcome = afterTrend === features.trend ? 'continued' : 'reversed';

    candidates.push({ startIndex: start, distance: d, outcome });
  }

  candidates.sort((a, b) => a.distance - b.distance);
  const matches = candidates.slice(0, maxMatches);
  const continuedCount = matches.filter(m => m.outcome === 'continued').length;
  const reversedCount = matches.filter(m => m.outcome === 'reversed').length;

  return { available: matches.length > 0, matches, continuedCount, reversedCount, currentTrend: currentFeatures.trend };
}
