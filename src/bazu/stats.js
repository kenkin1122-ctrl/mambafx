/**
 * src/bazu/stats.js
 *
 * Pure statistical helpers for the BAZU Rise/Fall page. Nothing here touches
 * the DOM, the network or randomness without an explicit seed. Reuses
 * research/src/statistics/uncertaintyEstimation.js's seeded RNG rather than
 * duplicating one.
 */

import { createSeededRng } from '../../research/src/statistics/uncertaintyEstimation.js';

export { createSeededRng };

const Z95 = 1.959963984540054;

/** Break-even hit rate from a real Deriv quote: ask_price / payout (payout includes the stake). */
export function breakEven(askPrice, payout) {
  if (!(askPrice > 0) || !(payout > 0)) return null;
  return askPrice / payout;
}

/** Break-even from a payout percentage, e.g. 0.85 -> 1/(1+0.85) = 0.5405. */
export function breakEvenFromPayoutPct(pct) {
  return pct > 0 ? 1 / (1 + pct) : null;
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = Z95) {
  if (!(n > 0)) return { p: null, lo: null, hi: null, n: 0, k: 0 };
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), n, k };
}

function logFactCache() {
  const c = [0];
  return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; };
}
const logFact = logFactCache();

/** Exact one-sided binomial p-value P(X >= k | n, p0). */
export function binomialTailGE(k, n, p0) {
  if (!(n > 0)) return 1;
  if (k <= 0) return 1;
  if (p0 <= 0) return k > 0 ? 0 : 1;
  if (p0 >= 1) return 1;
  const lp = Math.log(p0), lq = Math.log(1 - p0);
  let s = 0;
  for (let i = k; i <= n; i++) {
    s += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + i * lp + (n - i) * lq);
  }
  return Math.min(1, s);
}

/** Beta(a0, b0) posterior for a success probability. */
export function betaPosterior(k, n, a0 = 1, b0 = 1) {
  const a = a0 + k, b = b0 + (n - k);
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { a, b, mean, sd };
}

export function brierScore(probs, outcomes) {
  if (!probs.length || probs.length !== outcomes.length) return null;
  let s = 0;
  for (let i = 0; i < probs.length; i++) s += (probs[i] - outcomes[i]) ** 2;
  return s / probs.length;
}

/** Reliability table: predicted-probability bins vs realised frequency. */
export function reliability(probs, outcomes, bins = 5) {
  const rows = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, predicted: 0, hits: 0 }));
  for (let i = 0; i < probs.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(probs[i] * bins)));
    rows[b].n++; rows[b].predicted += probs[i]; rows[b].hits += outcomes[i];
  }
  return rows.filter((r) => r.n > 0).map((r) => ({
    lo: r.lo, hi: r.hi, n: r.n, predicted: r.predicted / r.n, observed: r.hits / r.n,
  }));
}

/** Benjamini-Hochberg FDR control. Returns adjusted p-values (q-values) in input order. */
export function benjaminiHochberg(pValues, q = 0.05) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m);
  let prev = 1;
  for (let r = m - 1; r >= 0; r--) {
    prev = Math.min(prev, (order[r][0] * m) / (r + 1));
    adj[order[r][1]] = prev;
  }
  return { adjusted: adj, rejected: adj.map((a) => a <= q) };
}

export function diffs(prices) {
  const out = new Array(prices.length).fill(0);
  for (let i = 1; i < prices.length; i++) out[i] = prices[i] - prices[i - 1];
  return out;
}

/** Variance ratio VR(q) = Var(q-step returns) / (q * Var(1-step returns)). 1 = random walk. */
export function varianceRatio(prices, q) {
  const n = prices.length;
  if (n < q * 4) return NaN;
  const r1 = [], rq = [];
  for (let i = 1; i < n; i++) r1.push(prices[i] - prices[i - 1]);
  for (let i = q; i < n; i++) rq.push(prices[i] - prices[i - q]);
  const v = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); };
  const v1 = v(r1);
  return v1 > 0 ? v(rq) / (q * v1) : NaN;
}

/** Wald-Wolfowitz runs test z-score on a +1/-1 sequence (zeros ignored). Negative z = too many runs (mean reverting). */
export function runsTestZ(signs) {
  const s = signs.filter((x) => x !== 0);
  const n1 = s.filter((x) => x > 0).length, n2 = s.length - n1;
  if (n1 < 2 || n2 < 2) return NaN;
  let runs = 1;
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1]) runs++;
  const n = n1 + n2, mu = (2 * n1 * n2) / n + 1;
  const sd = Math.sqrt((2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1)));
  return sd > 0 ? (runs - mu) / sd : NaN;
}

/** Bandt-Pompe permutation entropy, normalised to [0,1]. */
export function permutationEntropy(x, order = 3) {
  const n = x.length;
  if (n < order + 1) return NaN;
  const counts = new Map();
  let total = 0;
  for (let i = 0; i + order <= n; i++) {
    const idx = Array.from({ length: order }, (_, k) => k).sort((a, b) => x[i + a] - x[i + b] || a - b);
    const key = idx.join('');
    counts.set(key, (counts.get(key) || 0) + 1);
    total++;
  }
  let h = 0;
  counts.forEach((c) => { const p = c / total; h -= p * Math.log(p); });
  let fact = 1;
  for (let i = 2; i <= order; i++) fact *= i;
  return h / Math.log(fact);
}

/** Ornstein-Uhlenbeck fit by AR(1) regression; returns half-life in ticks (Infinity when not mean reverting). */
export function ouFit(x) {
  const n = x.length;
  if (n < 10) return { phi: NaN, halfLife: NaN, mean: NaN };
  const a = x.slice(0, -1), b = x.slice(1);
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); den += (a[i] - ma) ** 2; }
  const phi = den > 0 ? num / den : NaN;
  const halfLife = phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : Infinity;
  const mean = phi < 1 ? (mb - phi * ma) / (1 - phi) : NaN;
  return { phi, halfLife, mean };
}

/** Local-linear-trend Kalman filter. Returns { level[], velocity[] }. `qRatio` = process/measurement noise. */
export function kalmanTrend(x, qRatio = 0.01) {
  const n = x.length, level = new Array(n), velocity = new Array(n);
  if (!n) return { level, velocity };
  let l = x[0], v = 0;
  let P = [[1, 0], [0, 1]];
  const q = qRatio;
  level[0] = l; velocity[0] = 0;
  for (let i = 1; i < n; i++) {
    const lp = l + v;
    const Pp = [
      [P[0][0] + P[0][1] + P[1][0] + P[1][1] + q, P[0][1] + P[1][1]],
      [P[1][0] + P[1][1], P[1][1] + q],
    ];
    const S = Pp[0][0] + 1;
    const K0 = Pp[0][0] / S, K1 = Pp[1][0] / S;
    const innov = x[i] - lp;
    l = lp + K0 * innov; v = v + K1 * innov;
    P = [
      [(1 - K0) * Pp[0][0], (1 - K0) * Pp[0][1]],
      [Pp[1][0] - K1 * Pp[0][0], Pp[1][1] - K1 * Pp[0][1]],
    ];
    level[i] = l; velocity[i] = v;
  }
  return { level, velocity };
}

/** Two-sided CUSUM on standardised returns; positive output = upward drift alarm pressure. */
export function cusumSeries(returns, k = 0.5, window = 200) {
  const out = new Array(returns.length).fill(0);
  let sp = 0, sn = 0;
  for (let i = 0; i < returns.length; i++) {
    const lo = Math.max(0, i - window);
    let m = 0, c = 0;
    for (let j = lo; j <= i; j++) { m += returns[j]; c++; }
    m /= c;
    let s2 = 0;
    for (let j = lo; j <= i; j++) s2 += (returns[j] - m) ** 2;
    const sd = Math.sqrt(s2 / Math.max(1, c - 1)) || 1;
    const z = returns[i] / sd;
    sp = Math.max(0, sp + z - k);
    sn = Math.max(0, sn - z - k);
    out[i] = sp - sn;
  }
  return out;
}

/**
 * GARCH(1,1) conditional variance with variance targeting and FIXED alpha/beta
 * (no likelihood fit) - a volatility-state estimate, not a fitted forecast model.
 */
export function garchVariance(returns, alpha = 0.08, beta = 0.9) {
  const n = returns.length, out = new Array(n);
  if (!n) return out;
  // Variance target is the EXPANDING mean of r^2 so out[i] never uses data after i-1.
  let sum = 0, h = null;
  out.longRun = new Array(n);
  for (let i = 0; i < n; i++) {
    if (h === null) h = returns[i] ** 2 || 1e-12;
    out[i] = h;
    sum += returns[i] ** 2;
    const lr = sum / (i + 1);
    out.longRun[i] = lr;
    h = lr * (1 - alpha - beta) + alpha * returns[i] ** 2 + beta * h;
  }
  return out;
}

/** Causal trailing quantile: value at quantile `q` of the trailing `w` finite values before index i. */
export function trailingQuantile(arr, i, w, q) {
  const lo = Math.max(0, i - w);
  const vals = [];
  for (let j = lo; j < i; j++) if (Number.isFinite(arr[j])) vals.push(arr[j]);
  if (vals.length < Math.min(30, w / 2)) return NaN;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
}

/** Deterministically shuffles tick increments and rebuilds a price path (null-data control). */
export function shuffleReturnsPath(prices, seed) {
  const rng = createSeededRng(seed);
  const d = [];
  for (let i = 1; i < prices.length; i++) d.push(prices[i] - prices[i - 1]);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  const out = [prices[0]];
  for (let i = 0; i < d.length; i++) out.push(out[i] + d[i]);
  return out;
}
