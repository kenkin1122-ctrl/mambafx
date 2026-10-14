/**
 * src/bazu/calibration3m.js  (pure)
 * Records, not gates. Shadow outcomes (same entry/exit tick rules as a contract, ties lose) and
 * lifetime calibration (realised first-touch time of the target / invalidation level).
 * Entry = first tick after the decision; exit = tick at expiry (tick count, or first tick at/after expiry time).
 */
import { settle } from './config3m.js?v=15';
import { wilson } from './stats.js?v=15';

const firstIdxAfter = (epochs, t) => { let lo = 0, hi = epochs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (epochs[m] > t) hi = m; else lo = m + 1; } return lo; };

/** Outcome of a hypothetical contract. d = {unit:'t'|'s'|'m', n}. Returns 'win'|'loss'|null (not yet resolvable). */
export function shadowOutcome({ prices, epochs, at, dir, d }) {
  const i = firstIdxAfter(epochs, at);
  if (i >= epochs.length) return null;
  let j;
  if (d.unit === 't') j = i + d.n;
  else {
    const expiry = epochs[i] + (d.unit === 'm' ? d.n * 60 : d.n);
    j = i; while (j < epochs.length && epochs[j] < expiry) j++;
  }
  if (j >= epochs.length) return null;
  return settle(dir, prices[i], prices[j]);
}

/**
 * First time (s after `at`) the price touches the target or the invalidation level.
 * Returns { kind: 'target'|'invalid'|'none'|null, secs }. null = undecided yet (data ends before maxSecs).
 * If both are hit on the same tick the invalidation counts (conservative).
 */
export function firstTouch({ prices, epochs, at, dir, target, invalid, maxSecs }) {
  const i0 = firstIdxAfter(epochs, at);
  for (let i = i0; i < epochs.length; i++) {
    const secs = epochs[i] - at;
    if (secs > maxSecs) return { kind: 'none', secs: null };
    const hitT = dir > 0 ? prices[i] >= target : prices[i] <= target;
    const hitI = dir > 0 ? prices[i] <= invalid : prices[i] >= invalid;
    if (hitI) return { kind: 'invalid', secs };
    if (hitT) return { kind: 'target', secs };
  }
  const last = epochs[epochs.length - 1];
  return last - at >= maxSecs ? { kind: 'none', secs: null } : { kind: null, secs: null };
}

/**
 * Fill in whatever can be resolved now. rec = { at, dir, target, invalid, shadowDs:[{unit,n,key}], realised, shadow }.
 * Returns true when fully resolved.
 */
export function resolveRecord(rec, prices, epochs, cfg) {
  if (!rec.realised || rec.realised.kind == null) {
    const r = firstTouch({ prices, epochs, at: rec.at, dir: rec.dir, target: rec.target, invalid: rec.invalid, maxSecs: cfg.MAX_DURATION_S });
    if (r.kind != null) rec.realised = r;
  }
  rec.shadow = rec.shadow || {};
  for (const d of rec.shadowDs) {
    if (rec.shadow[d.key]) continue;
    const o = shadowOutcome({ prices, epochs, at: rec.at, dir: rec.dir, d });
    if (o) rec.shadow[d.key] = o;
  }
  return !!(rec.realised && rec.realised.kind != null) && rec.shadowDs.every((d) => rec.shadow[d.key]);
}

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const ERROR_BINS = Object.freeze([['<0.5x', 0, 0.5], ['0.5-0.8x', 0.5, 0.8], ['0.8-1.25x', 0.8, 1.25], ['1.25-2x', 1.25, 2], ['>2x', 2, Infinity]]);

const errStats = (pairs) => {
  const ratios = pairs.map((p) => p.pred / p.real);
  return {
    n: pairs.length,
    medianErrorS: median(pairs.map((p) => p.pred - p.real)),
    medianRatio: median(ratios),
    dist: ERROR_BINS.map(([label, lo, hi]) => ({ label, count: ratios.filter((r) => r >= lo && r < hi).length })),
  };
};

/** Predicted vs realised lifetime by playbook and by estimator, plus touched-but-lost count. */
export function calibrationSummary(records) {
  const done = records.filter((r) => r.realised && r.realised.kind != null);
  const touched = done.filter((r) => (r.realised.kind === 'target' || r.realised.kind === 'invalid') && r.realised.secs > 0);
  const byPlaybook = {}, byEstimator = {};
  for (const r of touched) {
    (byPlaybook[r.playbook] ||= []).push({ pred: r.predicted, real: r.realised.secs });
    for (const [k, v] of Object.entries(r.estimators || {})) if (Number.isFinite(v)) (byEstimator[k] ||= []).push({ pred: v, real: r.realised.secs });
  }
  const inDur = (r) => r.realised.kind === 'target' && r.realised.secs <= r.durSec;
  return {
    resolved: done.length,
    neither: done.filter((r) => r.realised.kind === 'none').length,
    targetFirst: done.filter((r) => r.realised.kind === 'target').length,
    invalidFirst: done.filter((r) => r.realised.kind === 'invalid').length,
    targetTouchedInDur: done.filter(inDur).length,
    touchedButLost: done.filter((r) => inDur(r) && r.shadow?.[r.durKey] === 'loss').length,
    byPlaybook: Object.fromEntries(Object.entries(byPlaybook).map(([k, v]) => [k, errStats(v)])),
    byEstimator: Object.fromEntries(Object.entries(byEstimator).map(([k, v]) => [k, errStats(v)])),
  };
}

/** Hit rate of the shadow outcome at the chosen duration, grouped by duration, with Wilson CI and mean break-even from quotes. */
export function accuracyByDuration(records) {
  const g = {};
  for (const r of records) {
    const o = r.shadow?.[r.durKey]; if (!o) continue;
    const e = (g[r.durKey] ||= { key: r.durKey, w: 0, n: 0, be: [] });
    e.n++; if (o === 'win') e.w++;
    if (Number.isFinite(r.breakEven)) e.be.push(r.breakEven);
  }
  return Object.values(g).map((e) => ({ key: e.key, n: e.n, p: e.w / e.n, ci: wilson(e.w, e.n), breakEven: e.be.length ? e.be.reduce((a, b) => a + b, 0) / e.be.length : null })).sort((a, b) => b.n - a.n);
}
