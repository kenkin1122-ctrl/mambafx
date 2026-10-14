import test from 'node:test';
import assert from 'node:assert/strict';
import { configFor } from '../../src/bazu/config3m.js';
import * as D from '../../src/bazu/duration3m.js';
import { durationAllowed } from '../../src/bazu/universe.js';
import { predict3m } from '../../src/bazu/predict3m.js';
import { bucketCandles } from '../../src/bazu/timeframes.js';
import { backfill, mergeCandles, requestCount } from '../../src/bazu/backfill3m.js';

const cfg = configFor('R_100');
const ranges = [{ expiry: 'tick', lo: { unit: 't', n: 1 }, hi: { unit: 't', n: 10 } }, { expiry: 'intraday', lo: { unit: 's', n: 15 }, hi: { unit: 'h', n: 24 } }];
function walk(N = 120000, seed = 7) {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const p = [], e = []; let x = 1000;
  for (let i = 0; i < N; i++) { x += (r() - 0.5) * 0.6 + Math.sin(i / 900) * 0.05; p.push(x); e.push(1700000000 + i); }
  return { p, e, remote: { M1: bucketCandles(p, e, 60), M5: bucketCandles(p, e, 300), M15: bucketCandles(p, e, 900), H1: bucketCandles(p, e, 3600) } };
}
const run = (w, k, extra = {}) => predict3m({ symbol: 'R_100', prices: w.p.slice(k - 6000, k + 1), epochs: w.e.slice(k - 6000, k + 1), remote: w.remote, decisionEpoch: w.e[k], ...extra });

test('RR room check vs legacy vs fixed: tradable rates on the same simulation', () => {
  const w = walk(), allowed = D.allowedDurations(ranges, 1, cfg, durationAllowed);
  const rate = (overrides) => { let n = 0, t = 0; for (let k = 20000; k < 120000; k += 500) { n++; if (run(w, k, { allowed, overrides }).duration) t++; } return { t, n }; };
  const legacy = rate({ ROOM_CHECK: 'legacy' }), rr = rate({ ROOM_CHECK: 'rr' }), fixed = rate({ DURATION_MODE: 'fixed' });
  console.log(`tradable: legacy ${legacy.t}/${legacy.n}, rr ${rr.t}/${rr.n}, fixed ${fixed.t}/${fixed.n}`);
  const vet = (o) => { const h = {}; for (let k = 20000; k < 120000; k += 500) for (const v of run(w, k, { allowed, overrides: o }).vetoes || []) { const key = String(v).replace(/[0-9.]+/g, '#'); h[key] = (h[key] || 0) + 1; } return Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 4); };
  console.log('legacy vetoes', JSON.stringify(vet({ ROOM_CHECK: 'legacy' })));
  console.log('rr vetoes', JSON.stringify(vet({ ROOM_CHECK: 'rr' })));
  assert.ok(rr.t >= legacy.t);
});

test('RR check is strict about RR_MIN in lifetime mode', () => {
  const w = walk(), allowed = D.allowedDurations(ranges, 1, cfg, durationAllowed);
  let n = 0;
  for (let k = 20000; k < 120000; k += 500) {
    const hi = run(w, k, { allowed, overrides: { RR_MIN: 1e6 } });
    assert.ok(hi.wait || !hi.lifetime || hi.lifetime.a == null, 'finite target must fail RR_MIN'); n++;
  }
  assert.ok(n > 0);
});

test('backfill: 5 frames per market, concurrency and gap honoured, merge dedupes', async () => {
  const symbols = ['A', 'B', 'C'], seen = []; let inflight = 0, maxIn = 0, last = 0, minGap = Infinity;
  const send = async (req) => {
    const t = Date.now(); if (last) minGap = Math.min(minGap, t - last); last = t;
    inflight++; maxIn = Math.max(maxIn, inflight); seen.push(req);
    await new Promise((r) => setTimeout(r, 5)); inflight--;
    return { candles: [{ epoch: 1, open: 1, high: 2, low: 0, close: 1 }, { epoch: 1, open: 1, high: 2, low: 0, close: 1 }] };
  };
  const store = {}, c = { ...cfg, BACKFILL_GAP_MS: 20 };
  const res = await backfill({ symbols, send, cfg: c, store, onFrame: () => {} });
  assert.equal(res.failed, 0);
  assert.equal(res.requests, symbols.length * c.BACKFILL_FRAMES.length);
  assert.ok(maxIn <= c.BACKFILL_CONCURRENCY);
  assert.ok(minGap >= 10, `gap ${minGap}`);
  assert.equal(requestCount(symbols.length, c), res.requests);
  assert.equal(mergeCandles([{ epoch: 1, close: 1 }], [{ epoch: 1, close: 2 }, { epoch: 2, close: 3 }]).length, 2);
});
