/**
 * src/bazu/indicators.js
 *
 * New BAZU candidate features, registered into the EXISTING research
 * IndicatorRegistry (PluginContract plugins) next to the 27 core indicators.
 * All are causal: signal[i] only uses prices[0..i].
 * Tick-derived features are PROXIES: Deriv synthetic indices have no volume.
 */

import { IndicatorRegistry } from '../../research/src/indicator/IndicatorRegistry.js';
import { registerCoreIndicators } from '../../research/src/indicator/coreIndicators.js';
import { createMathDefinition } from '../../research/src/plugin/MachineReadableMathematics.js';
import { varianceRatio, permutationEntropy, ouFit, kalmanTrend, cusumSeries, garchVariance, diffs } from './stats.js?v=14';

const NAN = NaN;
const DISC = 'BAZU candidate feature: exploratory, validated before use, not financial advice.';
const SAMPLE = { prices: Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 2 + i * 0.05), period: 10 };

function mk({ name, description, assumptions, proxy = false, directional = true, fn }) {
  return Object.freeze({
    metadata() {
      return Object.freeze({
        name, displayName: name, description: proxy ? `${description} (proxy)` : description,
        version: '1.0.0', scientificAssumptions: assumptions, dependencies: [], complexity: 'O(n*period)',
        validationStatus: 'THEORETICAL', maxLookahead: 0, disclaimer: DISC,
        bazu: { proxy, directional },
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute(inputs) { return { signal: fn(inputs.prices || [], inputs.period || 10), period: inputs.period }; },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() { return [{ name: `${name} computes`, inputs: SAMPLE, expectedOutputShape: { signal: 'number[]' } }]; },
    documentation() { return `${description} ${DISC}`; },
    scientificAssumptions() { return [...assumptions]; },
    mathDefinition: createMathDefinition({
      humanReadable: description, symbolicExpression: name, executableFormula: (p, per) => fn(p, per),
      units: 'dimensionless', domain: 'R^n', range: 'R',
    }),
  });
}

const roll = (p, period, f, minLen = period) => {
  const out = new Array(p.length).fill(NAN);
  for (let i = minLen - 1; i < p.length; i++) out[i] = f(p.slice(Math.max(0, i - period + 1), i + 1), i);
  return out;
};
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const ema = (v, n) => { const k = 2 / (n + 1); const o = []; let pr = null; for (const x of v) { pr = pr === null ? x : x * k + pr * (1 - k); o.push(pr); } return o; };
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

export const BAZU_PLUGINS = Object.freeze([
  mk({ name: 'VarianceRatio', description: 'Lo-MacKinlay variance ratio VR(4) over window; <1 mean-reverting, >1 trending', assumptions: ['Increments weakly stationary in window'], directional: false,
    fn: (p, per) => roll(p, per * 4, (w) => varianceRatio(w, 4)) }),
  mk({ name: 'PermEntropy', description: 'Normalised permutation entropy (order 3); low = ordered', assumptions: ['Ordinal patterns are informative'], directional: false,
    fn: (p, per) => roll(p, per * 3, (w) => permutationEntropy(w, 3)) }),
  mk({ name: 'OUReversion', description: 'Negative z-score of price vs OU equilibrium when half-life is finite (mean-reversion pull)', assumptions: ['AR(1) mean reversion within window'],
    fn: (p, per) => roll(p, per * 4, (w) => { const f = ouFit(w); const s = sd(w); return Number.isFinite(f.halfLife) && s > 0 ? (f.mean - w[w.length - 1]) / s : 0; }) }),
  mk({ name: 'KalmanSlope', description: 'Kalman local-linear-trend velocity in units of rolling std of increments', assumptions: ['Local linear trend plus noise'],
    fn: (p, per) => { const k = kalmanTrend(p, 0.01).velocity; const d = diffs(p); return k.map((v, i) => { if (i < per) return NAN; const s = sd(d.slice(Math.max(1, i - per * 3), i + 1)); return s > 0 ? v / s : 0; }); } }),
  mk({ name: 'CUSUM', description: 'Two-sided CUSUM pressure on standardised increments (change-point drift)', assumptions: ['Regime breaks appear as persistent drift'],
    fn: (p, per) => cusumSeries(diffs(p), 0.5, per * 10).map((v, i) => (i < per ? NAN : v)) }),
  mk({ name: 'GarchRatio', description: 'GARCH(1,1) (fixed params) conditional std / long-run std; volatility regime', assumptions: ['Volatility clusters'], directional: false,
    fn: (p, per) => { const d = diffs(p); const h = garchVariance(d); return h.map((v, i) => (i < per || !(h.longRun[i] > 0) ? NAN : Math.sqrt(v / h.longRun[i]))); } }),
  mk({ name: 'StochD', description: 'Stochastic %D (3-SMA of %K) minus 50', assumptions: ['Closing position within range is informative'],
    fn: (p, per) => { const k = roll(p, per, (w) => { const hi = Math.max(...w), lo = Math.min(...w); return hi > lo ? ((w[w.length - 1] - lo) / (hi - lo)) * 100 : 50; }); return k.map((_, i) => (i < per + 1 ? NAN : (k[i] + k[i - 1] + k[i - 2]) / 3 - 50)); } }),
  mk({ name: 'TickDelta', description: 'Signed tick delta: (up-ticks minus down-ticks)/N by tick rule', assumptions: ['Tick rule approximates aggressor side'], proxy: true,
    fn: (p, per) => { const d = diffs(p).map(sgn); return roll(d, per, (w) => w.reduce((a, b) => a + b, 0) / w.length); } }),
  mk({ name: 'DeltaDivergence', description: 'Price change sign minus tick-delta sign over window (+ = price down but delta up)', assumptions: ['Delta/price disagreement precedes reversal'], proxy: true,
    fn: (p, per) => { const d = diffs(p).map(sgn); return p.map((_, i) => { if (i < per) return NAN; const dl = d.slice(i - per + 1, i + 1).reduce((a, b) => a + b, 0) / per; const pc = sgn(p[i] - p[i - per]); return pc !== 0 && sgn(dl) === -pc ? dl : 0; }); } }),
  mk({ name: 'Absorption', description: 'Absorption: |delta| high with small net price progress relative to path length (0..1)', assumptions: ['Effort without result indicates absorption'], proxy: true, directional: false,
    fn: (p, per) => p.map((_, i) => { if (i < per) return NAN; const w = p.slice(i - per, i + 1); let path = 0; for (let j = 1; j < w.length; j++) path += Math.abs(w[j] - w[j - 1]); const net = Math.abs(w[w.length - 1] - w[0]); const dl = Math.abs(diffs(w).slice(1).map(sgn).reduce((a, b) => a + b, 0)) / per; return path > 0 ? dl * (1 - net / path) : 0; }) }),
  mk({ name: 'DonchianPos', description: 'Position within Donchian channel scaled to [-1,1]', assumptions: ['Breakouts persist or fade'],
    fn: (p, per) => roll(p, per, (w) => { const hi = Math.max(...w), lo = Math.min(...w); return hi > lo ? ((w[w.length - 1] - lo) / (hi - lo)) * 2 - 1 : 0; }) }),
  mk({ name: 'KeltnerPos', description: 'Price distance from EMA in units of mean absolute increment (Keltner-style)', assumptions: ['Channel extremes are informative'],
    fn: (p, per) => { const e = ema(p, per), d = diffs(p).map(Math.abs); const a = ema(d, per); return p.map((x, i) => (i < per || !(a[i] > 0) ? NAN : (x - e[i]) / (a[i] * 3))); } }),
  mk({ name: 'DIDiff', description: '+DI minus -DI (tick-path version, smoothed)', assumptions: ['Directional movement persists'],
    fn: (p, per) => { const d = diffs(p); const up = ema(d.map((x) => Math.max(x, 0)), per), dn = ema(d.map((x) => Math.max(-x, 0)), per); return up.map((u, i) => (i < per ? NAN : (u + dn[i] > 0 ? (u - dn[i]) / (u + dn[i]) : 0))); } }),
  mk({ name: 'EMACross', description: 'Fast EMA(period) minus slow EMA(3*period) relative to increment scale', assumptions: ['Trend persistence'],
    fn: (p, per) => { const f = ema(p, per), s = ema(p, per * 3), a = ema(diffs(p).map(Math.abs), per * 3); return p.map((_, i) => (i < per * 3 || !(a[i] > 0) ? NAN : (f[i] - s[i]) / a[i])); } }),
]);

export const BAZU_FEATURE_FLAGS = Object.freeze(Object.fromEntries(BAZU_PLUGINS.map((p) => [p.metadata().name, p.metadata().bazu])));

/** Core research indicators + BAZU additions in ONE registry. */
export function buildBazuRegistry() {
  const reg = new IndicatorRegistry();
  registerCoreIndicators(reg);
  for (const p of BAZU_PLUGINS) reg.register(p);
  return reg;
}
