import test from 'node:test';
import assert from 'node:assert/strict';
import { configFor } from '../../src/bazu/config3m.js';
import * as D from '../../src/bazu/duration3m.js';
import { durationAllowed } from '../../src/bazu/universe.js';
import { predict3m } from '../../src/bazu/predict3m.js';
import { setFrameCache } from '../../src/bazu/candles3m.js';
import { bucketCandles } from '../../src/bazu/timeframes.js';
import * as P from '../../src/bazu/perf3m.js';

const cfg = configFor('R_100');
const ranges = [{ expiry: 'tick', lo: { unit: 't', n: 1 }, hi: { unit: 't', n: 10 } }, { expiry: 'intraday', lo: { unit: 's', n: 15 }, hi: { unit: 'h', n: 24 } }];
function walk(N = 60000, seed = 11) {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const p = [], e = []; let x = 1000;
  for (let i = 0; i < N; i++) { x += (r() - 0.5) * 0.6 + Math.sin(i / 900) * 0.05; p.push(x); e.push(1700000000 + i); }
  return { p, e };
}
const mkRemote = (w, k) => ({ M1: bucketCandles(w.p.slice(0, k), w.e.slice(0, k), 60), M5: bucketCandles(w.p.slice(0, k), w.e.slice(0, k), 300), M15: bucketCandles(w.p.slice(0, k), w.e.slice(0, k), 900), H1: bucketCandles(w.p.slice(0, k), w.e.slice(0, k), 3600) });

/** Live-like sequence: the tick buffer grows from a fixed start, the remote candle object is reused (and its arrays replaced now and then), the buffer is trimmed once. */
function sequence(w, cache, steps) {
  setFrameCache(cache);
  const allowed = D.allowedDurations(ranges, 1, cfg, durationAllowed), out = [], remote = {};
  let start = 20000, refreshAt = 0;
  for (let i = 0; i < steps; i++) {
    const k = 30000 + i * 11;
    if (i === Math.floor(steps / 2)) start += 1500;
    if (i >= refreshAt) { Object.assign(remote, mkRemote(w, k - 60)); refreshAt = i + 25; }
    const r = predict3m({ symbol: 'R_100', prices: w.p.slice(start, k + 1), epochs: w.e.slice(start, k + 1), remote, decisionEpoch: w.e[k], allowed });
    out.push(JSON.stringify(r));
  }
  setFrameCache(true);
  return out;
}

test('frame cache: predictions are identical with and without the cache, incl. trim and remote refresh', () => {
  const w = walk(), N = 400;
  const a = sequence(w, false, N), b = sequence(w, true, N);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.equal(b[i], a[i], `mismatch at step ${i}`);
});

test('frame cache makes prediction cheaper', () => {
  const w = walk(), N = 200;
  const t = (cache) => { const t0 = performance.now(); sequence(w, cache, N); return (performance.now() - t0) / N; };
  t(true); const off = t(false), on = t(true);
  console.log(`predict ms/call: uncached ${off.toFixed(2)}, cached ${on.toFixed(2)}`);
  assert.ok(Number.isFinite(on) && Number.isFinite(off));
});

test('perf3m records stages and bounded windows', () => {
  P.reset();
  const lap = P.lapTimer('x'); lap('a'); lap('b'); for (let i = 0; i < 1000; i++) P.mark('y', i);
  const s = P.snapshot();
  assert.equal(s.stages['x.a'].n, 1); assert.equal(s.stages.y.n, 1000); assert.ok(s.stages.y.p95 >= 900); assert.equal(s.stages.y.max, 999);
});
