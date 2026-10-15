/**
 * src/bazu/estimators3m.js  (pure)
 *
 * P0: what each lifetime estimator predicts and how the realised value must be measured so that the
 * comparison is like with like. Realised times are right-censored (a level that was never touched inside
 * the observation window), so they are summarised with a Kaplan-Meier estimate, never by dropping them.
 *
 * Realised measures (from the tick path after the decision, window = MAX_DURATION_S or the data that exists):
 *   exit   = first touch of EITHER the target or the invalidation level (corridor exit; invalidation wins a tie)
 *   target = first touch of the target level, whether or not the invalidation level was touched before it
 */

export const ESTIMATOR_DEFS = Object.freeze({
  E1: { predicts: 'MEAN time to leave the corridor [invalidation, target] (driftless: a*b/sigma^2)', measure: 'exit', stat: 'mean', proxy: false },
  E2: { predicts: 'MEDIAN time to touch the target (a^2 / (0.6745 sigma)^2)', measure: 'target', stat: 'median', proxy: false },
  E3: { predicts: 'time to reach the target at the estimated trend speed (distance / |mu|); a point estimate', measure: 'target', stat: 'median', proxy: false },
  E4: { predicts: 'time for an OU reversion to cover fraction f of the displacement (log2(1/(1-f)) x half-life)', measure: 'target', stat: 'median', proxy: true, note: 'no stored displacement, so time-to-target is used as the closest measurable proxy' },
  E5: { predicts: 'pattern horizon: multiple x trigger-frame length (heuristic; time for the pattern to play out)', measure: 'exit', stat: 'median', proxy: false },
  E6: { predicts: 'cap on the time to the next spike (spike markets only)', measure: null, stat: 'median', proxy: false, note: 'needs Boom/Crash/Jump ticks and a spike threshold; not available in this data' },
});

const firstIdxAfter = (epochs, t) => { let lo = 0, hi = epochs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (epochs[m] > t) hi = m; else lo = m + 1; } return lo; };

/**
 * Everything the path after a decision says, in one pass. Times are seconds after `at`.
 * complete = the data covers the whole window. Adverse excursion is in price units (>= 0), overall and up to durSecs.
 */
export function pathStats({ prices, epochs, at, dir, entry, target, invalid, maxSecs, durSecs = null }) {
  const i0 = firstIdxAfter(epochs, at);
  const last = epochs.length ? epochs[epochs.length - 1] : at;
  const observedSecs = Math.max(0, Math.min(maxSecs, last - at));
  const out = { tTarget: null, tInvalid: null, tExit: null, exitKind: null, maxAdverse: 0, maxAdverseInDur: 0, maxFavourable: 0, observedSecs, complete: last - at >= maxSecs };
  for (let i = i0; i < epochs.length; i++) {
    const secs = epochs[i] - at;
    if (secs > maxSecs) break;
    const p = prices[i], move = (p - entry) * dir;
    if (-move > out.maxAdverse) out.maxAdverse = -move;
    if (durSecs != null && secs <= durSecs && -move > out.maxAdverseInDur) out.maxAdverseInDur = -move;
    if (move > out.maxFavourable) out.maxFavourable = move;
    if (out.tInvalid == null && (dir > 0 ? p <= invalid : p >= invalid)) out.tInvalid = secs;
    if (out.tTarget == null && target != null && (dir > 0 ? p >= target : p <= target)) out.tTarget = secs;
  }
  if (out.tInvalid != null && (out.tTarget == null || out.tInvalid <= out.tTarget)) { out.tExit = out.tInvalid; out.exitKind = 'invalid'; }
  else if (out.tTarget != null) { out.tExit = out.tTarget; out.exitKind = 'target'; }
  return out;
}

/** Kaplan-Meier survival curve. obs = [{ t, event }]; event=false means right-censored at t. */
export function kaplanMeier(obs) {
  const s = obs.filter((o) => Number.isFinite(o.t)).sort((a, b) => a.t - b.t || (b.event ? 1 : 0) - (a.event ? 1 : 0));
  let atRisk = s.length, S = 1; const curve = [];
  for (let i = 0; i < s.length;) {
    const t = s[i].t; let d = 0, c = 0;
    while (i < s.length && s[i].t === t) { if (s[i].event) d++; else c++; i++; }
    if (d) { S *= 1 - d / atRisk; curve.push({ t, S }); }
    atRisk -= d + c;
  }
  return curve;
}
/** Smallest t with S(t) <= 0.5, or null when the median is not reached (more than half still "alive"). */
export const kmMedian = (curve) => (curve.find((p) => p.S <= 0.5) || { t: null }).t;
/** Restricted mean survival time up to tau: the area under S on [0, tau]. */
export function rmst(curve, tau) {
  let area = 0, prevT = 0, S = 1;
  for (const p of curve) { if (p.t >= tau) break; area += S * (p.t - prevT); prevT = p.t; S = p.S; }
  return area + S * (tau - prevT);
}

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Observation (time, event?) of a record for a measure ('exit' | 'target'). */
export function observation(path, measure) {
  const t = measure === 'target' ? path.tTarget : path.tExit;
  return t != null ? { t, event: true } : { t: path.observedSecs, event: false };
}

/**
 * Pred/real under the old and the matched definition, per estimator and playbook (and 'ALL').
 *  old     : median of per-record pred/real over records that touched a level, censored records dropped
 *  matched : median(pred) / KM median(realised), censored records kept; ratio is null when the KM median is not reached
 *            (then lowerBoundRealised = the observation horizon and ratioUpper = median(pred) / that, an upper bound)
 *  mean    : mean(min(pred, tau)) / RMST(tau), the restricted-mean comparison (an approximation, see ESTIMATOR_DEFS.E1)
 * records need { playbook, estimators, path }.
 */
export function estimatorReport(records, { tau = 1200 } = {}) {
  const rows = [];
  const groups = new Map();
  for (const r of records) {
    if (!r.path || !r.estimators) continue;
    for (const [k, v] of Object.entries(r.estimators)) {
      if (!Number.isFinite(v) || !ESTIMATOR_DEFS[k] || !ESTIMATOR_DEFS[k].measure) continue;
      for (const pb of [r.playbook, 'ALL']) { const key = `${k}|${pb}`; if (!groups.has(key)) groups.set(key, { k, pb, items: [] }); groups.get(key).items.push({ v, path: r.path }); }
    }
  }
  for (const { k, pb, items } of groups.values()) {
    const def = ESTIMATOR_DEFS[k];
    const obs = items.map((x) => observation(x.path, def.measure));
    const curve = kaplanMeier(obs), kmMed = kmMedian(curve), events = obs.filter((o) => o.event).length;
    const predMed = median(items.map((x) => x.v));
    const touched = items.filter((x) => x.path.tExit != null && x.path.tExit > 0);
    const oldRatio = median(touched.map((x) => x.v / x.path.tExit));
    const horizon = median(obs.filter((o) => !o.event).map((o) => o.t)) ?? tau;
    rows.push({
      estimator: k, playbook: pb, measure: def.measure, proxy: def.proxy, n: items.length, events, censored: items.length - events,
      predMedian: predMed, realMedianKM: kmMed, ratioMatched: kmMed ? predMed / kmMed : null, ratioUpperIfNotReached: kmMed ? null : predMed / horizon,
      oldRatio, oldN: touched.length, meanClippedPred: mean(items.map((x) => Math.min(x.v, tau))), rmstReal: rmst(curve, tau),
      ratioMean: rmst(curve, tau) > 0 ? mean(items.map((x) => Math.min(x.v, tau))) / rmst(curve, tau) : null,
    });
  }
  return rows.sort((a, b) => a.estimator.localeCompare(b.estimator) || (a.playbook === 'ALL' ? -1 : b.playbook === 'ALL' ? 1 : a.playbook.localeCompare(b.playbook)));
}

/**
 * Chronological split: the earlier `frac` for fitting, the later part held out. Training records whose outcome window
 * (at + embargoSecs) reaches into the test period are dropped, so no label is computed from test-period data.
 */
export function chronoSplit(records, frac = 0.7, embargoSecs = 0) {
  const s = [...records].sort((a, b) => a.at - b.at), cut = Math.floor(s.length * frac);
  const test = s.slice(cut), t0 = test.length ? test[0].at : Infinity;
  return { train: s.slice(0, cut).filter((r) => r.at + embargoSecs < t0), test };
}
