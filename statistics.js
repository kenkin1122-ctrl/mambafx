/**
 * analysis/candleGenome.js
 *
 * "Candle Genome": a compact, deterministic shape fingerprint for a small
 * sequence of candles (default: the most recent 3) — body ratio, upper/
 * lower wick ratio, direction, and size relative to recent average range,
 * per candle. This is genuinely different from analysis/historicalSimilarity.js,
 * which compares WHOLE-WINDOW trend signatures (12+ candles, direction +
 * momentum + swing structure). A genome is the fine-grained shape of just
 * the last few candles — the kind of thing a discretionary trader means by
 * "this looks like a classic exhaustion candle" or "that's a textbook
 * absorption bar." Two candles can belong to very different trend contexts
 * and still have near-identical genomes; that's the point of keeping this
 * separate from the window-level comparison.
 *
 * Like historicalSimilarity.js, this is fully deterministic — a fixed,
 * inspectable distance formula in feature space, no ML, no external data.
 * Every match is a real historical candle sequence that occurred in the
 * loaded history.
 */

function bodyRatio(c) {
  const range = c.high - c.low;
  return range > 0 ? Math.abs(c.close - c.open) / range : 0;
}
function upperWickRatio(c) {
  const range = c.high - c.low;
  return range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
}
function lowerWickRatio(c) {
  const range = c.high - c.low;
  return range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;
}
function direction(c) {
  return c.close >= c.open ? 1 : -1;
}

/**
 * @param {Array} candles the full series
 * @param {number} endIndex exclusive — genome covers candles[endIndex-genomeLen .. endIndex-1]
 * @param {number} genomeLen
 * @param {number} avgWindow how many preceding candles define "recent average range" for the relative-size feature
 */
function buildGenome(candles, endIndex, genomeLen = 3, avgWindow = 20) {
  if (endIndex - genomeLen < 0) return null;
  const avgStart = Math.max(0, endIndex - avgWindow);
  const avgSlice = candles.slice(avgStart, endIndex);
  if (avgSlice.length < 5) return null;
  const avgRange = avgSlice.reduce((s, c) => s + (c.high - c.low), 0) / avgSlice.length;
  if (avgRange === 0) return null;

  const slice = candles.slice(endIndex - genomeLen, endIndex);
  return {
    bodyRatios: slice.map(bodyRatio),
    upperWicks: slice.map(upperWickRatio),
    lowerWicks: slice.map(lowerWickRatio),
    directions: slice.map(direction),
    relativeSizes: slice.map(c => (c.high - c.low) / avgRange),
  };
}

/** Distance between two genomes — lower is more similar. A direction mismatch adds a fixed penalty per candle, since a shape match in the wrong direction isn't really the same genome. */
function genomeDistance(a, b) {
  if (!a || !b || a.bodyRatios.length !== b.bodyRatios.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.bodyRatios.length; i++) {
    sum += (a.bodyRatios[i] - b.bodyRatios[i]) ** 2;
    sum += (a.upperWicks[i] - b.upperWicks[i]) ** 2;
    sum += (a.lowerWicks[i] - b.lowerWicks[i]) ** 2;
    sum += Math.min(1, (a.relativeSizes[i] - b.relativeSizes[i]) ** 2 / 4);
    if (a.directions[i] !== b.directions[i]) sum += 0.5;
  }
  return Math.sqrt(sum);
}

/**
 * @param {Array<{epoch:number,open:number,high:number,low:number,close:number}>} candles
 * @param {{genomeLen?:number, lookAhead?:number, maxDistance?:number}} [opts]
 * @returns {{sampleSize:number, continuedPct:number, reversedPct:number, currentDirection:1|-1|null}|null}
 */
export function findGenomeAnalogs(candles, opts = {}) {
  const genomeLen = opts.genomeLen ?? 3;
  const lookAhead = opts.lookAhead ?? 6;
  const maxDistance = opts.maxDistance ?? 0.6;

  if (!candles || candles.length < genomeLen + 30 + lookAhead) return null;

  const currentGenome = buildGenome(candles, candles.length, genomeLen);
  if (!currentGenome) return null;
  const currentDirection = currentGenome.directions[currentGenome.directions.length - 1];

  let continued = 0, reversed = 0, neutral = 0;
  for (let end = genomeLen + 20; end <= candles.length - lookAhead; end++) {
    if (end > candles.length - genomeLen) continue;
    const g = buildGenome(candles, end, genomeLen);
    if (!g) continue;
    if (genomeDistance(currentGenome, g) > maxDistance) continue;

    const before = candles[end - 1].close;
    const after = candles[Math.min(end - 1 + lookAhead, candles.length - 1)].close;
    const changeFrac = before !== 0 ? (after - before) / before : 0;
    const genomeDir = g.directions[g.directions.length - 1];
    const continuedMove = (genomeDir === 1 && changeFrac > 0.001) || (genomeDir === -1 && changeFrac < -0.001);
    const reversedMove = (genomeDir === 1 && changeFrac < -0.001) || (genomeDir === -1 && changeFrac > 0.001);
    if (continuedMove) continued++;
    else if (reversedMove) reversed++;
    else neutral++;
  }

  const sampleSize = continued + reversed + neutral;
  return {
    sampleSize, continued, reversed, neutral,
    continuedPct: sampleSize ? Math.round((continued / sampleSize) * 100) : 0,
    reversedPct: sampleSize ? Math.round((reversed / sampleSize) * 100) : 0,
    currentDirection,
  };
}
