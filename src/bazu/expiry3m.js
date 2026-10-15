/**
 * src/bazu/expiry3m.js  (pure)
 *
 * P2: probability that a Rise/Fall contract is in the money AT EXPIRY (path dependent: touching the target
 * earlier does not win the contract). Baseline, analytic, no training:
 *   Rise: P = Phi( (S_now - S_entry + mu*tau) / (sigma*sqrt(tau)) ),  Fall mirrors it. mu = 0 unless a drift is supplied.
 * Units are consistent but arbitrary: sigma per tick with tau in ticks, or sigma per second with tau in seconds.
 * An optional learned logistic model and a calibration map (Platt) are fitted OFFLINE on a chronological training set
 * and shipped as versioned config (expiryModel3m.js). Heavy fitting never runs on the UI thread.
 */

export function normCdf(x) {
  if (x === Infinity) return 1; if (x === -Infinity) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Per-tick standard deviation of price changes over the last `n` ticks (null if too few). */
export function sigmaPerTick(prices, n = 300) {
  const m = Math.min(n, prices.length - 1);
  if (m < 20) return null;
  let s = 0, s2 = 0;
  for (let i = prices.length - m; i < prices.length; i++) { const d = prices[i] - prices[i - 1]; s += d; s2 += d * d; }
  const v = s2 / m - (s / m) ** 2;
  return v > 0 ? Math.sqrt(v) : null;
}

/** Baseline P(win at expiry). dir = +1 Rise / -1 Fall. Returns null when an input is missing (never a made-up number). */
export function expiryProbBaseline({ dir, spot, entry, tau, sigma, mu = 0 }) {
  if (![dir, spot, entry, tau, sigma, mu].every(Number.isFinite) || sigma <= 0 || tau < 0) return null;
  const lead = (spot - entry) * dir;
  if (tau === 0) return lead > 0 ? 1 : 0; // a tie loses
  return normCdf((lead + mu * dir * tau) / (sigma * Math.sqrt(tau)));
}

export const clampP = (p, eps = 1e-6) => Math.min(1 - eps, Math.max(eps, p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logLoss = (probs, ys) => (probs.length ? probs.reduce((s, p, i) => s - (ys[i] ? Math.log(clampP(p)) : Math.log(1 - clampP(p))), 0) / probs.length : null);
export const brier = (probs, ys) => (probs.length ? probs.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / probs.length : null);

/** Standardisation + L2-regularised logistic regression by Newton-free gradient descent (small, deterministic). */
export function fitLogistic(X, y, { l2 = 1, iters = 400, lr = 0.1 } = {}) {
  const n = X.length, k = X[0]?.length || 0;
  const mean = Array(k).fill(0), sd = Array(k).fill(1);
  for (let j = 0; j < k; j++) { mean[j] = X.reduce((s, r) => s + r[j], 0) / n; sd[j] = Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1; }
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / sd[j]));
  let w = Array(k).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(k).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; for (let j = 0; j < k; j++) z += w[j] * Z[i][j]; const e = sigmoid(z) - y[i]; gb += e; for (let j = 0; j < k; j++) gw[j] += e * Z[i][j]; }
    b -= (lr * gb) / n; for (let j = 0; j < k; j++) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n);
  }
  return { w, b, mean, sd };
}
export function predictLogistic(m, x) { let z = m.b; for (let j = 0; j < m.w.length; j++) z += m.w[j] * ((x[j] - m.mean[j]) / m.sd[j]); return sigmoid(z); }

/** Platt scaling: p' = sigmoid(a*logit(p) + c), fitted by the same logistic routine on logit(p). */
export function fitPlatt(probs, ys) {
  const m = fitLogistic(probs.map((p) => [Math.log(clampP(p) / (1 - clampP(p)))]), ys, { l2: 0.01, iters: 600, lr: 0.2 });
  return { a: m.w[0] / m.sd[0], c: m.b - (m.w[0] * m.mean[0]) / m.sd[0] };
}
export const applyPlatt = (pl, p) => sigmoid(pl.a * Math.log(clampP(p) / (1 - clampP(p))) + pl.c);

/** Reliability curve: equal-width bins with counts. Bins with no data are still listed (n = 0). */
export function reliabilityCurve(probs, ys, bins = 5) {
  const rows = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, p: 0, hits: 0 }));
  probs.forEach((p, i) => { const b = Math.min(bins - 1, Math.max(0, Math.floor(p * bins))); rows[b].n++; rows[b].p += p; rows[b].hits += ys[i]; });
  return rows.map((r) => ({ lo: r.lo, hi: r.hi, n: r.n, predicted: r.n ? r.p / r.n : null, observed: r.n ? r.hits / r.n : null }));
}

/** Holdout comparison. `candidate`, `baseline` and a constant 50% are scored by Brier and log loss. */
export function compareModels({ candidate, baseline, ys }) {
  const c50 = ys.map(() => 0.5);
  const s = (p) => ({ brier: brier(p, ys), logLoss: logLoss(p, ys) });
  const out = { n: ys.length, candidate: s(candidate), baseline: s(baseline), constant50: s(c50) };
  out.beatsBaseline = out.candidate.brier < out.baseline.brier && out.candidate.logLoss < out.baseline.logLoss;
  return out;
}

/**
 * Decision-time feature vector for the learned model. Everything is signed toward the trade direction
 * so one set of coefficients serves Rise and Fall. flow is a PROXY (up-tick share from real ticks), not volume.
 */
export const FEATURE_NAMES = Object.freeze(['atrRel', 'emaDist', 'adx', 'wickAgainst', 'flowProxy', 'momentum', 'logTau']);
export function featureVector(f) {
  return [f.atr / f.price * 1000, f.emaDist, f.adx, f.wickAgainst, f.flowProxy, f.momentum, Math.log(Math.max(1, f.tauTicks))];
}
export const featuresComplete = (f) => !!f && featureVector(f).every(Number.isFinite);

/** Flow proxy from real ticks: (ups - downs) / (ups + downs) over the last n ticks, signed by dir. Null if no moves. */
export function tickFlowProxy(prices, dir, n = 60) {
  let up = 0, dn = 0;
  for (let i = Math.max(1, prices.length - n); i < prices.length; i++) { if (prices[i] > prices[i - 1]) up++; else if (prices[i] < prices[i - 1]) dn++; }
  return up + dn ? (dir * (up - dn)) / (up + dn) : null;
}

/** Wording for a live contract: neutral, no advice, no colour. */
export function liveContractText(p, calib) {
  if (p == null) return 'Live contract. Expiry probability: not available (waiting for market data).';
  const tag = calib && calib.n >= calib.nMin ? `calibrated on ${calib.n} outcomes` : `uncalibrated${calib ? `, ${calib.n}/${calib.nMin} outcomes` : ''}`;
  return `Live contract. Expiry probability: ${Math.round(p * 100)}% (model estimate, ${tag}).`;
}
