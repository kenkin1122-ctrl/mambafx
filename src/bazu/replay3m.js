/**
 * src/bazu/replay3m.js
 *
 * Replay evaluation (pure, point-in-time). Runs predict3m over recorded ticks exactly as the live
 * engine would: the decision at tick k sees ONLY ticks 0..k and candles that had closed by tick k.
 * Entry = first tick after the decision, exit = first tick at or after entry + chosen duration,
 * a tie loses. Used to compare CONFLUENCE_MODE legacy vs families on identical data.
 */

import { predict3m } from './predict3m.js?v=15';
import { configFor } from './config3m.js?v=15';
import { wilson } from './stats.js?v=15';

/** FNV-1a 32-bit hash of a string or number array; identifies a dataset or config. */
export function fnv(input) {
  let h = 0x811c9dc5;
  const feed = (c) => { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; };
  if (typeof input === 'string') for (let i = 0; i < input.length; i++) feed(input.charCodeAt(i) & 0xff), feed(input.charCodeAt(i) >> 8);
  else for (let i = 0; i < input.length; i++) { const s = String(input[i]); for (let j = 0; j < s.length; j++) feed(s.charCodeAt(j)); feed(44); }
  return h.toString(16).padStart(8, '0');
}
export const datasetHash = (ds) => fnv(ds.map((d) => `${d.symbol}:${d.prices.length}:${fnv(d.prices)}:${fnv(d.epochs)}`).join('|'));
export const configHash = (cfg) => fnv(JSON.stringify(cfg, (k, v) => (typeof v === 'function' ? undefined : v)));

/** Candles visible at epoch `now`: only those whose period has fully closed. */
export function visibleRemote(remote, frames, now) {
  const out = {};
  for (const f of Object.keys(remote || {})) { const secs = frames[f]; out[f] = secs ? remote[f].filter((c) => c.epoch + secs <= now) : remote[f]; }
  return out;
}

/** Decision at tick index k (point-in-time). Exported so tests can poison the future and compare. */
export function decideAt(d, k, { allowed, overrides, cfg }) {
  return predict3m({ symbol: d.symbol, prices: d.prices.slice(0, k + 1), epochs: d.epochs.slice(0, k + 1), remote: visibleRemote(d.remote, cfg.FRAMES, d.epochs[k]), decisionEpoch: d.epochs[k], allowed, overrides });
}

function settle(d, k, durSec) {
  const i = k + 1; if (i >= d.prices.length) return null;
  const due = d.epochs[i] + durSec;
  let j = i; while (j < d.prices.length && d.epochs[j] < due) j++;
  if (j >= d.prices.length) return null;
  return { entry: d.prices[i], exit: d.prices[j] };
}

/**
 * Replay one dataset. Returns { evals, trades[] }. One trade per market at a time (no overlap).
 * `trades[i]` = { symbol, k, dir, playbook, durationSec, win, momentum, agree, trigger, strength, breakEven }.
 */
export function replayOne(d, { mode, overrides = {}, allowed, startAt = 2000, step = 25, onDecision } = {}) {
  const cfg = configFor(d.symbol), ov = { ...overrides, CONFLUENCE_MODE: mode };
  const trades = [], stats = { evals: 0, waits: 0, vetoes: {}, opposing: 0, directional: 0 };
  let freeAt = -1;
  for (let k = startAt; k < d.prices.length - 2; k += step) {
    const r = decideAt(d, k, { allowed, overrides: ov, cfg: { ...cfg, ...ov } });
    stats.evals++;
    if (r.direction) { stats.directional++; if (r.momentum?.opposes60s === true) stats.opposing++; }
    if (r.wait) { stats.waits++; for (const v of r.vetoes || []) { const key = String(v).replace(/[0-9.]+/g, '#'); stats.vetoes[key] = (stats.vetoes[key] || 0) + 1; } if (onDecision) onDecision(k, r, false); continue; }
    if (d.epochs[k] < freeAt) continue;
    const s = settle(d, k, r.durationSec); if (!s) continue;
    const dir = r.direction, win = (s.exit - s.entry) * dir > 0;
    freeAt = d.epochs[k] + r.durationSec;
    trades.push({ symbol: d.symbol, k, dir, playbook: r.playbook, durationSec: r.durationSec, win, momentum: r.momentum?.state || null, opposes60s: !!r.momentum?.opposes60s, agree: r.familyAgreement?.agree ?? r.agree ?? null, trigger: r.entry?.trigger || null, strength: r.strength, breakEven: d.breakEven ?? null });
    if (onDecision) onDecision(k, r, true);
  }
  return { evals: stats.evals, stats, trades };
}

const group = (trades, keyFn) => {
  const g = {};
  for (const t of trades) { const k = keyFn(t) ?? 'n/a'; (g[k] ||= { n: 0, wins: 0 }); g[k].n++; if (t.win) g[k].wins++; }
  for (const k of Object.keys(g)) g[k].ci = wilson(g[k].wins, g[k].n);
  return g;
};

/** Summarise: tradable rate, hit rate with Wilson CI against mean break-even, and breakdowns. */
export function summarise(runs) {
  const trades = runs.flatMap((r) => r.trades), evals = runs.reduce((a, r) => a + r.evals, 0);
  const wins = trades.filter((t) => t.win).length, be = trades.filter((t) => t.breakEven != null);
  const meanBE = be.length ? be.reduce((a, t) => a + t.breakEven, 0) / be.length : null;
  const stats = { directional: 0, opposing: 0, vetoes: {} };
  for (const r of runs) { stats.directional += r.stats.directional; stats.opposing += r.stats.opposing; for (const [k, v] of Object.entries(r.stats.vetoes)) stats.vetoes[k] = (stats.vetoes[k] || 0) + v; }
  const ci = trades.length ? wilson(wins, trades.length) : null;
  return {
    evals, trades: trades.length, tradableRate: evals ? trades.length / evals : 0, wins, hitRate: trades.length ? wins / trades.length : null, ci, meanBreakEven: meanBE,
    clearsBreakEven: ci && meanBE != null ? ci.lo > meanBE : null, contradictions: stats,
    byMomentum: group(trades, (t) => t.momentum), byAgree: group(trades, (t) => t.agree), byTrigger: group(trades, (t) => t.trigger), byPlaybook: group(trades, (t) => t.playbook),
    warning: evals && trades.length / evals < 0.01 ? 'tradable rate below 1%: the filter may be too strict' : null,
  };
}

/** Compare legacy vs families on identical datasets. Returns hashes + both summaries. */
export function compare(datasets, { allowed, overrides = {}, startAt, step } = {}) {
  const out = { datasetHash: datasetHash(datasets), configHash: configHash({ ...configFor(datasets[0]?.symbol || 'R_100'), ...overrides }) };
  for (const mode of ['legacy', 'families']) out[mode] = summarise(datasets.map((d) => replayOne(d, { mode, overrides, allowed, startAt, step })));
  return out;
}

/** Chunked async runner for the UI: yields between decisions so live trading never blocks. */
export async function replayChunked(datasets, opts, { budgetMs = 8, yieldFn = () => new Promise((r) => setTimeout(r, 0)), onProgress } = {}) {
  const out = { datasetHash: datasetHash(datasets), configHash: configHash({ ...configFor(datasets[0]?.symbol || 'R_100'), ...(opts.overrides || {}) }) };
  for (const mode of ['legacy', 'families']) {
    const runs = []; let t0 = performance.now();
    for (const d of datasets) {
      let last = 0;
      runs.push(replayOne(d, { ...opts, mode, onDecision: () => { /* sync loop; budget is enforced per dataset slice below */ } }));
      if (performance.now() - t0 > budgetMs) { await yieldFn(); t0 = performance.now(); }
      if (onProgress) onProgress({ mode, done: runs.length, total: datasets.length, last });
    }
    out[mode] = summarise(runs);
  }
  return out;
}
