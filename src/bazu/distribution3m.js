// Market Rise/Fall distribution: descriptive analytics over buffered ticks. Read-only; never touches orders.
import { wilson } from './stats.js?v=15';
import { bucketCandles } from './timeframes.js?v=15';
import { trendDiagnostics } from './diagnostics3m.js?v=17';

export const WINDOWS = Object.freeze([100, 500, 1000, 0]); // 0 = all buffered ticks
export const CANDLE_SECS = Object.freeze([60, 300]);

function countMoves(values) {
  let up = 0, down = 0, flat = 0, run = 0, longestUp = 0, longestDown = 0, dir = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1], s = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (s > 0) up++; else if (s < 0) down++; else flat++;
    if (s !== 0 && s === dir) run++; else run = s === 0 ? 0 : 1;
    dir = s === 0 ? 0 : s;
    if (dir > 0) longestUp = Math.max(longestUp, run); else if (dir < 0) longestDown = Math.max(longestDown, run);
  }
  const dec = up + down;
  const ci = dec ? wilson(up, dec) : null;
  return { up, down, flat, n: dec + flat, riseShare: dec ? up / dec : null, lo: ci ? ci.lo ?? ci[0] : null, hi: ci ? ci.hi ?? ci[1] : null, longestUp, longestDown };
}

export function marketDistribution({ prices, epochs }) {
  const windows = WINDOWS.map((w) => {
    const slice = w && prices.length > w ? prices.slice(-(w + 1)) : prices;
    return { window: w || 'all', ...countMoves(slice) };
  });
  const candles = CANDLE_SECS.map((secs) => ({ secs, ...countMoves(bucketCandles(prices, epochs, secs).map((c) => c.close)) }));
  return { ticks: prices.length, windows, candles, trend: trendDiagnostics(prices) };
}

export function distributionRows(markets) {
  const rows = [];
  for (const [symbol, m] of markets) {
    if (!m.prices || m.prices.length < 3) continue;
    rows.push({ symbol, name: m.display_name || m.name || symbol, ...marketDistribution({ prices: m.prices, epochs: m.epochs }) });
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const f = (v, d = 4) => (v == null || Number.isNaN(v) ? '' : Number(v).toFixed(d));

export function distributionCsv(rows) {
  const head = ['symbol', 'scope', 'n', 'up', 'down', 'flat', 'rise_share', 'ci_lo', 'ci_hi', 'longest_up', 'longest_down', 'var_ratio', 'autocorr1', 'runs_z', 'hurst'];
  const out = [head.join(',')];
  for (const r of rows) {
    const t = r.trend;
    const add = (scope, c, withTrend) => out.push([r.symbol, scope, c.n, c.up, c.down, c.flat, f(c.riseShare), f(c.lo), f(c.hi), c.longestUp, c.longestDown, withTrend ? f(t.varianceRatio) : '', withTrend ? f(t.autocorr1) : '', withTrend ? f(t.runsZ, 2) : '', withTrend ? f(t.hurst) : ''].join(','));
    r.windows.forEach((w, i) => add(`ticks_${w.window}`, w, i === r.windows.length - 1));
    r.candles.forEach((c) => add(`candles_${c.secs}s`, c, false));
  }
  return out.join('\n');
}
