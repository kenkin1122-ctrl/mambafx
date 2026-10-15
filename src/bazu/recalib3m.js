/**
 * src/bazu/recalib3m.js  (pure)
 * P3: per estimator x playbook correction factor, fitted on the TRAINING period only and kept only if it reduces the
 * error on the chronological HOLDOUT. Error = |ln(predicted median / realised KM median)|, the realised median being the
 * Kaplan-Meier one for the estimator's own measure (censoring kept). Corrections apply to future predictions only.
 */
import { kaplanMeier, kmMedian, observation, ESTIMATOR_DEFS, chronoSplit } from './estimators3m.js?v=15';

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function stat(items, measure) {
  const obs = items.map((x) => observation(x.path, measure));
  return { n: items.length, events: obs.filter((o) => o.event).length, predMed: median(items.map((x) => x.v)), realMed: kmMedian(kaplanMeier(obs)) };
}
const collect = (records, k, pb) => records.filter((r) => r.path && r.estimators && Number.isFinite(r.estimators[k]) && r.playbook === pb).map((r) => ({ v: r.estimators[k], path: r.path }));

/** Fit on train, judge on test. Returns one row per estimator x playbook with the decision and the reason. */
export function fitCorrections(records, { frac = 0.7, embargoSecs = 1200, minEvents = 30, minTestEvents = 15, clamp = [0.25, 4] } = {}) {
  const { train, test } = chronoSplit(records.filter((r) => r.path), frac, embargoSecs);
  const rows = [], pbs = [...new Set(records.map((r) => r.playbook))];
  for (const k of Object.keys(ESTIMATOR_DEFS)) {
    const def = ESTIMATOR_DEFS[k]; if (!def.measure) continue;
    for (const pb of pbs) {
      const tr = stat(collect(train, k, pb), def.measure), te = stat(collect(test, k, pb), def.measure);
      if (!tr.n) continue;
      const row = { estimator: k, playbook: pb, trainN: tr.n, trainEvents: tr.events, testN: te.n, testEvents: te.events, factor: null, errBefore: null, errAfter: null, applied: false, reason: null };
      if (tr.events < minEvents || !tr.realMed || !tr.predMed) { row.reason = `train too thin or median not reached (${tr.events} events, need ${minEvents})`; rows.push(row); continue; }
      const f = Math.min(clamp[1], Math.max(clamp[0], tr.realMed / tr.predMed)); row.factor = f;
      if (te.events < minTestEvents || !te.realMed || !te.predMed) { row.reason = `holdout too thin or median not reached (${te.events} events, need ${minTestEvents})`; rows.push(row); continue; }
      row.errBefore = Math.abs(Math.log(te.predMed / te.realMed)); row.errAfter = Math.abs(Math.log((f * te.predMed) / te.realMed));
      row.applied = row.errAfter < row.errBefore;
      row.reason = row.applied ? 'reduces holdout error' : 'does not reduce holdout error: left unchanged';
      rows.push(row);
    }
  }
  return { trainN: train.length, testN: test.length, rows };
}

/** Only the applied factors, as the versioned config object { playbook: { E1: f } }. */
export function toConfig(rows) {
  const out = {};
  for (const r of rows) if (r.applied) (out[r.playbook] ||= {})[r.estimator] = +r.factor.toFixed(3);
  return out;
}
