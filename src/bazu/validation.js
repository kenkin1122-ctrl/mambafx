/**
 * src/bazu/validation.js
 *
 * Hypothesis generation, walk-forward validation and the null-data control for BAZU.
 * Reuses: research IndicatorRegistry (features), circular-shift permutation test,
 * Phase 11 lifecycle (Generated -> Screened -> Triaged -> Confirmed -> Replicated -> Published).
 *
 * Splits (time-ordered, no shuffling): Discovery 50% | Replication 25% | Holdout 25%.
 * Hit definition: Rise wins iff exit spot > entry spot; Fall wins iff exit < entry; ties lose.
 * Baseline for a direction is the empirical null probability of that side on the same segment
 * (not 50%). Probabilities are shrunk Beta posteriors.
 */

import { computeCircularShiftPermutationTest } from '../../research/src/statistics/permutationTest.js';
import { PHASE11_LIFECYCLE_STAGES as ST, transitionPhase11Stage } from '../../research/src/governance/phase11LifecycleStates.js';
import { buildBazuRegistry, BAZU_FEATURE_FLAGS } from './indicators.js?v=14';
import { computeStructureFeatures } from './structure.js?v=14';
import {
  wilson, binomialTailGE, benjaminiHochberg, betaPosterior, brierScore, reliability,
  trailingQuantile, shuffleReturnsPath,
} from './stats.js?v=14';

export const SPLIT = Object.freeze({ discovery: 0.5, replication: 0.25 });
export const MIN_TRADES = 30;

/** Definitions already archived as negative evidence: never re-tested without a new hypothesis ID. */
export const EXCLUDED_DEFINITIONS = Object.freeze(['EMA_SLOPE:10']);

const CORE_DIRECTIONAL = ['RSI', 'CCI', 'MACD', 'ROC', 'Momentum', 'ZScore', 'StochasticK', 'BollingerPosition', 'EMA_SLOPE'];
const CORE_FILTERS = ['ADX', 'ATR', 'BollingerWidth', 'Volatility', 'Hurst', 'Entropy'];
const DEFAULT_PERIOD = { EMA_SLOPE: 20 };
const PERIOD = 10;

export function durationKey(d) { return `${d.n}${d.unit}`; }

/** Exit index per tick for a duration {unit:'t'|'s'|'m', n}; -1 if unavailable. */
export function exitIndices(epochs, d) {
  const T = epochs.length, out = new Int32Array(T).fill(-1);
  if (d.unit === 't') { for (let i = 0; i + d.n < T; i++) out[i] = i + d.n; return out; }
  const secs = d.unit === 'm' ? d.n * 60 : d.n;
  let j = 0;
  for (let i = 0; i < T; i++) {
    if (j < i) j = i;
    while (j < T && epochs[j] < epochs[i] + secs) j++;
    if (j >= T) break;
    out[i] = j;
  }
  return out;
}

/** outcome[i]: +1 spot rose, -1 fell, 0 tie/unavailable. */
export function outcomes(prices, exit) {
  const o = new Int8Array(prices.length);
  for (let i = 0; i < prices.length; i++) {
    const e = exit[i];
    if (e >= 0) o[i] = prices[e] > prices[i] ? 1 : prices[e] < prices[i] ? -1 : 0;
  }
  return o;
}

/** Collect all features (indicators + structure) as aligned per-tick arrays. */
export function computeFeatures(prices, epochs, registry = buildBazuRegistry(), ticksPerCandle = 10) {
  const feats = {};
  const add = (id, values, o) => { feats[id] = { values, ...o }; };
  const run = (name, period) => {
    const p = registry.lookup(name);
    return p ? p.compute({ prices, period }).signal : null;
  };
  for (const name of CORE_DIRECTIONAL) {
    const period = DEFAULT_PERIOD[name] || PERIOD;
    if (EXCLUDED_DEFINITIONS.includes(`${name}:${period}`)) continue;
    const s = run(name, period);
    if (s) add(`${name}-${period}`, s, { directional: true, discrete: false, proxy: false, family: 'core' });
  }
  for (const name of CORE_FILTERS) {
    const s = run(name, PERIOD);
    if (s) add(`${name}-${PERIOD}`, s, { directional: false, discrete: false, proxy: false, family: 'core' });
  }
  for (const name of Object.keys(BAZU_FEATURE_FLAGS)) {
    const fl = BAZU_FEATURE_FLAGS[name];
    const s = run(name, PERIOD);
    if (s) add(`${name}-${PERIOD}`, s, { directional: fl.directional, discrete: false, proxy: fl.proxy, family: 'bazu' });
  }
  const st = computeStructureFeatures(prices, epochs, ticksPerCandle);
  for (const k of st.names) add(`${k}-c${ticksPerCandle}`, st.series[k], { ...st.meta[k], family: 'structure' });
  return feats;
}

/** Causal rule signal: +1 Rise / -1 Fall / 0 none. thresholds recomputed per 25-tick block from the past only. */
export function ruleSignal(values, { discrete }, mode) {
  const T = values.length, dir = new Int8Array(T);
  const flip = mode === 'fade' ? -1 : 1;
  if (discrete) {
    for (let i = 0; i < T; i++) { const v = values[i]; if (Number.isFinite(v) && v !== 0) dir[i] = v > 0 ? flip : -flip; }
    return dir;
  }
  let hi = NaN, lo = NaN;
  for (let i = 0; i < T; i++) {
    if (i % 25 === 0) { hi = trailingQuantile(values, i, 400, 0.8); lo = trailingQuantile(values, i, 400, 0.2); }
    const v = values[i];
    if (!Number.isFinite(v) || !Number.isFinite(hi) || hi <= lo) continue;
    if (v >= hi) dir[i] = flip; else if (v <= lo) dir[i] = -flip;
  }
  return dir;
}

/** Regime gate for non-directional features: 'hi' = top tercile, 'lo' = bottom tercile (causal). */
export function regimeGate(values, side) {
  const T = values.length, g = new Uint8Array(T);
  let hi = NaN, lo = NaN;
  for (let i = 0; i < T; i++) {
    if (i % 25 === 0) { hi = trailingQuantile(values, i, 400, 2 / 3); lo = trailingQuantile(values, i, 400, 1 / 3); }
    const v = values[i];
    if (!Number.isFinite(v) || !Number.isFinite(hi)) continue;
    g[i] = side === 'hi' ? (v >= hi ? 1 : 0) : (v <= lo ? 1 : 0);
  }
  return g;
}

export function andSignals(a, b) { const o = new Int8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] !== 0 && a[i] === b[i] ? a[i] : 0; return o; }
export function gateSignal(a, g) { const o = new Int8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = g[i] ? a[i] : 0; return o; }

/** Non-overlapping trades in [a,b): greedy, next trade may start at/after previous exit. */
export function evaluate(dir, out, exit, a, b) {
  let k = 0, n = 0, i = a;
  while (i < b) {
    if (dir[i] !== 0 && exit[i] >= 0 && exit[i] < b) {
      n++; if (out[i] === dir[i]) k++;
      i = exit[i];
    } else i++;
  }
  return { k, n };
}

/** Null baseline: empirical probability that side wins on a segment, over ALL entries. */
export function baseline(out, exit, a, b, side) {
  let k = 0, n = 0;
  for (let i = a; i < b; i++) if (exit[i] >= 0 && exit[i] < b) { n++; if (out[i] === side) k++; }
  return n ? k / n : 0.5;
}

function sideBaseline(dir, out, exit, a, b) {
  const up = baseline(out, exit, a, b, 1), dn = baseline(out, exit, a, b, -1);
  let ups = 0, tot = 0;
  for (let i = a; i < b; i++) if (dir[i] !== 0) { tot++; if (dir[i] > 0) ups++; }
  return tot ? (ups * up + (tot - ups) * dn) / tot : (up + dn) / 2;
}

function permP(dir, out, a, b, seed, permutations) {
  const f = Array.from(dir.subarray(a, b)), o = Array.from(out.subarray(a, b));
  const stat = (fv, ov) => { let k = 0, n = 0; for (let i = 0; i < fv.length; i++) if (fv[i] !== 0) { n++; if (ov[i] === fv[i]) k++; } return n >= 10 ? k / n : NaN; };
  try {
    return computeCircularShiftPermutationTest({ featureValues: f, outcomeValues: o, statisticFn: stat, permutations, seed }).pValue;
  } catch { return 1; }
}

/** Generate hypotheses (id -> signal). Confluence built from top screened bases x regime filters. */
export function generateHypotheses(feats, topBases = []) {
  const hyps = [];
  for (const [fid, f] of Object.entries(feats)) {
    if (!f.directional) continue;
    for (const mode of ['follow', 'fade']) hyps.push({ id: `bazu:${fid}:${mode}`, features: [fid], kind: 'single', dir: ruleSignal(f.values, f, mode) });
  }
  const filters = Object.entries(feats).filter(([, f]) => !f.directional);
  const gates = [];
  for (const [fid, f] of filters) for (const side of ['hi', 'lo']) gates.push({ fid, side, g: regimeGate(f.values, side) });
  for (const base of topBases) for (const gt of gates) {
    hyps.push({ id: `${base.id}&${gt.fid}:${gt.side}`, features: [...base.features, gt.fid], kind: 'confluence', dir: gateSignal(base.dir, gt.g) });
  }
  for (let i = 0; i < topBases.length; i++) for (let j = i + 1; j < topBases.length; j++) {
    const A = topBases[i], B = topBases[j];
    if (A.features[0] === B.features[0]) continue;
    hyps.push({ id: `${A.id}+${B.id}`, features: [...A.features, ...B.features], kind: 'confluence', dir: andSignals(A.dir, B.dir) });
  }
  return hyps;
}

/** Rebuild a published setup's signal series from its parseable ID (used for live signals). */
export function signalForSetup(feats, id) {
  const single = (s) => { const m = /^bazu:([^:&+]+):(follow|fade)$/.exec(s); if (!m || !feats[m[1]]) return null; return ruleSignal(feats[m[1]].values, feats[m[1]], m[2]); };
  let m;
  if ((m = /^(bazu:[^:&+]+:(?:follow|fade))&([^:&+]+):(hi|lo)$/.exec(id))) {
    const b = single(m[1]); return b && feats[m[2]] ? gateSignal(b, regimeGate(feats[m[2]].values, m[3])) : null;
  }
  if ((m = /^(bazu:[^+]+)\+(bazu:.+)$/.exec(id))) { const a = single(m[1]), b = single(m[2]); return a && b ? andSignals(a, b) : null; }
  return single(id);
}

/**
 * Full walk-forward pipeline for ONE market and ONE duration.
 * @returns {{ setups: object[], counts: object, n:{D,R,H}, p0 }}
 */
export function runPipeline({ prices, epochs, duration, feats, seed = 1, permutations = 200, alpha = 0.1 }) {
  const T = prices.length;
  const exit = exitIndices(epochs, duration), out = outcomes(prices, exit);
  const dEnd = Math.floor(T * SPLIT.discovery), rEnd = Math.floor(T * (SPLIT.discovery + SPLIT.replication));
  const seg = { D: [0, dEnd], R: [dEnd, rEnd], H: [rEnd, T] };
  const stageOf = new Map();
  const advance = (h, to) => { h.stage = transitionPhase11Stage(h.stage, to); };

  const screen = (hyps) => {
    const rows = [];
    for (const h of hyps) {
      h.stage = ST.GENERATED;
      const ev = evaluate(h.dir, out, exit, ...seg.D);
      if (ev.n < MIN_TRADES) continue;
      const p0 = sideBaseline(h.dir, out, exit, ...seg.D);
      h.D = { ...ev, p0, pBinom: binomialTailGE(ev.k, ev.n, p0) };
      advance(h, ST.SCREENED);
      rows.push(h);
    }
    return rows;
  };

  const base = screen(generateHypotheses(feats));
  const topBases = base.filter((h) => h.kind === 'single').sort((x, y) => x.D.pBinom - y.D.pBinom).slice(0, 6);
  const confl = screen(generateHypotheses(feats, topBases).filter((h) => h.kind === 'confluence'));
  const all = [...base, ...confl];
  const hypsGenerated = base.length + confl.length;

  // Triage: circular-shift permutation on the best screened candidates (cost-bounded).
  const tri = all.sort((x, y) => x.D.pBinom - y.D.pBinom).slice(0, 40);
  tri.forEach((h, idx) => { h.D.pPerm = permP(h.dir, out, ...seg.D, seed + idx, permutations); advance(h, ST.TRIAGED); });
  const bhD = benjaminiHochberg(all.map((h) => h.D.pPerm ?? 1), alpha);
  // BH over every screened hypothesis (non-triaged ones carry p=1) keeps the family size honest.
  const confirmed = [];
  tri.forEach((h) => { const i = all.indexOf(h); h.D.qPerm = bhD.adjusted[i]; if (bhD.rejected[i] && h.D.k / h.D.n > h.D.p0) { advance(h, ST.CONFIRMED); confirmed.push(h); } });

  // Replication on R (one-sided vs baseline), BH among confirmed.
  confirmed.forEach((h) => {
    const ev = evaluate(h.dir, out, exit, ...seg.R), p0 = sideBaseline(h.dir, out, exit, ...seg.R);
    h.R = { ...ev, p0, p: ev.n >= MIN_TRADES ? binomialTailGE(ev.k, ev.n, p0) : 1 };
  });
  const bhR = benjaminiHochberg(confirmed.map((h) => h.R.p), 0.1);
  const replicated = [];
  confirmed.forEach((h, i) => { if (bhR.rejected[i] && h.R.n >= MIN_TRADES && h.R.k / h.R.n > h.R.p0) { advance(h, ST.REPLICATED); replicated.push(h); } });

  // Holdout H: untouched until now.
  replicated.forEach((h) => {
    const ev = evaluate(h.dir, out, exit, ...seg.H), p0 = sideBaseline(h.dir, out, exit, ...seg.H);
    h.H = { ...ev, p0, p: ev.n >= MIN_TRADES ? binomialTailGE(ev.k, ev.n, p0) : 1 };
  });
  const bhH = benjaminiHochberg(replicated.map((h) => h.H.p), 0.1);
  const published = [];
  replicated.forEach((h, i) => { if (bhH.rejected[i] && h.H.n >= MIN_TRADES && h.H.k / h.H.n > h.H.p0) { advance(h, ST.PUBLISHED); published.push(h); } });

  const setups = all.filter((h) => h.stage === ST.PUBLISHED || h.stage === ST.REPLICATED || h.stage === ST.CONFIRMED).map((h) => {
    const k = (h.R?.k || 0) + (h.H?.k || 0), n = (h.R?.n || 0) + (h.H?.n || 0);
    const prior = h.D.p0 * 20;
    const post = betaPosterior(h.D.k + k, h.D.n + n, prior, 20 - prior);
    return {
      id: h.id, market: null, duration: durationKey(duration), stage: h.stage, features: h.features, kind: h.kind,
      D: h.D, R: h.R, H: h.H, oos: { k, n, ...wilson(k, n) }, p0: h.D.p0,
      probability: betaPosterior(h.D.k + (h.R?.k || 0), h.D.n + (h.R?.n || 0), prior, 20 - prior).mean,
      posterior: post, proxy: h.features.some((f) => feats[f]?.proxy),
    };
  });

  // Calibration: probability fixed from D+R, scored on untouched H trades of published setups.
  const probs = [], outs = [], pb = [];
  for (const h of published) {
    const p = setups.find((s) => s.id === h.id).probability;
    let i = seg.H[0];
    while (i < seg.H[1]) {
      if (h.dir[i] !== 0 && exit[i] >= 0 && exit[i] < seg.H[1]) { probs.push(p); outs.push(out[i] === h.dir[i] ? 1 : 0); pb.push(h.H.p0); i = exit[i]; } else i++;
    }
  }
  const calibration = probs.length ? { n: probs.length, brier: brierScore(probs, outs), brierBaseline: brierScore(pb, outs), bins: reliability(probs, outs, 5) } : null;

  return {
    setups, calibration,
    counts: { generated: hypsGenerated, screened: all.length, triaged: tri.length, confirmed: confirmed.length, replicated: replicated.length, published: published.length },
    n: { D: dEnd, R: rEnd - dEnd, H: T - rEnd },
  };
}

/** Run the entire pipeline on shuffled-increment copies of the data to estimate false discoveries. */
export function nullControl({ prices, epochs, duration, runs = 3, seed = 9001, permutations = 100 }) {
  let withPub = 0, pubTotal = 0, confTotal = 0, generated = 0;
  const reg = buildBazuRegistry();
  for (let r = 0; r < runs; r++) {
    const sh = shuffleReturnsPath(prices, seed + r);
    const feats = computeFeatures(sh, epochs, reg);
    const res = runPipeline({ prices: sh, epochs, duration, feats, seed: seed + 100 * r, permutations });
    if (res.counts.published > 0) withPub++;
    pubTotal += res.counts.published; confTotal += res.counts.confirmed; generated += res.counts.generated;
  }
  return {
    runs, generated, falseConfirmed: confTotal, falsePublished: pubTotal,
    runsWithFalsePublished: withPub, falsePublishedPerRun: pubTotal / runs,
    fdrRunLevel: withPub / runs,
  };
}

/** Per-market validation (single duration). */
export function validateMarket({ symbol, prices, epochs, duration, nullRuns = 3, permutations = 200, seed = 1 }) {
  const feats = computeFeatures(prices, epochs);
  const res = runPipeline({ prices, epochs, duration, feats, seed, permutations });
  res.setups.forEach((s) => { s.market = symbol; });
  const nullCtl = nullRuns > 0 ? nullControl({ prices, epochs, duration, runs: nullRuns, permutations: Math.min(permutations, 100) }) : null;
  return { symbol, duration: durationKey(duration), ...res, nullControl: nullCtl, asOfEpoch: epochs[epochs.length - 1], ticks: prices.length };
}
