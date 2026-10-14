/**
 * src/bazu/perf3m.js
 * Zero-dependency performance instrumentation: per-stage timings (count / total / max / p95 over a bounded window),
 * long-task counter, event-loop lag, heap size. Pure measurement; it never changes trading behaviour.
 */
const WIN = 240;
const stages = new Map();
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function rec(name, ms) {
  let s = stages.get(name);
  if (!s) { s = { n: 0, total: 0, max: 0, last: 0, win: new Float64Array(WIN), i: 0, filled: 0 }; stages.set(name, s); }
  s.n++; s.total += ms; s.last = ms; if (ms > s.max) s.max = ms;
  s.win[s.i] = ms; s.i = (s.i + 1) % WIN; if (s.filled < WIN) s.filled++;
}
/** const lap = lapTimer('predict'); ...; lap('frames'); ...; lap('zones'); -> records predict.frames, predict.zones */
export function lapTimer(prefix) { let t = now(); return (stage) => { const u = now(); rec(prefix + '.' + stage, u - t); t = u; }; }
export function timed(name, fn) { const t = now(); try { return fn(); } finally { rec(name, now() - t); } }
export function start(name) { const t = now(); return () => rec(name, now() - t); }
export const mark = rec;

function p95(s) { if (!s.filled) return 0; const a = Array.from(s.win.subarray(0, s.filled)).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; }

const env = { longTasks: 0, longMs: 0, worstLong: 0, lagMax: 0, lagSum: 0, lagN: 0 };
let started = false;
export function startMonitors() {
  if (started || typeof window === 'undefined') return; started = true;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { env.longTasks++; env.longMs += e.duration; env.worstLong = Math.max(env.worstLong, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch { /* unsupported */ }
  let last = now();
  setInterval(() => { const t = now(), lag = Math.max(0, t - last - 500); last = t; env.lagN++; env.lagSum += lag; env.lagMax = Math.max(env.lagMax, lag); }, 500);
}
export function snapshot() {
  const out = {};
  for (const [k, s] of stages) out[k] = { n: s.n, avg: +(s.total / s.n).toFixed(3), total: +s.total.toFixed(1), p95: +p95(s).toFixed(3), max: +s.max.toFixed(2), last: +s.last.toFixed(3) };
  const mem = typeof performance !== 'undefined' && performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
  return { stages: out, longTasks: env.longTasks, longMs: Math.round(env.longMs), worstLong: Math.round(env.worstLong), lagMax: Math.round(env.lagMax), lagAvg: env.lagN ? +(env.lagSum / env.lagN).toFixed(1) : 0, heapMB: mem };
}
export function reset() { stages.clear(); env.longTasks = env.longMs = env.worstLong = env.lagMax = env.lagSum = env.lagN = 0; }
if (typeof window !== 'undefined') window.__bzPerf = snapshot;
