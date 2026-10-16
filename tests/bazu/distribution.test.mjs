import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marketDistribution, distributionRows, distributionCsv } from '../../src/bazu/distribution3m.js';
import { trendDiagnostics, autocorr, hurstRS } from '../../src/bazu/diagnostics3m.js';

const walk = (n, seed = 7) => { let s = seed, p = 100; const prices = [], epochs = []; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; p += s / 2 ** 32 < 0.5 ? -0.1 : 0.1; prices.push(+p.toFixed(2)); epochs.push(1000 + i * 2); } return { prices, epochs }; };

test('distribution counts up/down/flat exactly', () => {
  const d = marketDistribution({ prices: [1, 2, 2, 1, 3], epochs: [0, 1, 2, 3, 4] });
  const all = d.windows[d.windows.length - 1];
  assert.deepEqual([all.up, all.down, all.flat], [2, 1, 1]);
  assert.equal(all.longestUp, 1);
  assert.ok(Math.abs(all.riseShare - 2 / 3) < 1e-9 && all.lo < all.riseShare && all.hi > all.riseShare);
});

test('random walk diagnostics are near neutral and trend diagnostics are shared', () => {
  const { prices } = walk(4000);
  const t = trendDiagnostics(prices);
  assert.ok(Math.abs(t.varianceRatio - 1) < 0.2 && Math.abs(t.autocorr1) < 0.1);
  assert.ok(t.hurst > 0.35 && t.hurst < 0.75);
  assert.equal(marketDistribution(walk(4000)).trend.varianceRatio, t.varianceRatio);
  const trend = Array.from({ length: 400 }, (_, i) => i);
  assert.ok(autocorr(trend.map((_, i) => (i % 2 ? 1 : -1)), 1) < -0.9);
  let s = 3, q = 0, x = 0; const persistent = Array.from({ length: 3000 }, () => { s = (s * 1664525 + 1013904223) >>> 0; q = 0.9 * q + (s / 2 ** 32 - 0.5); x += q; return x; });
  assert.ok(hurstRS(persistent) > 0.6 && autocorr(persistent.slice(1).map((v, i) => v - persistent[i]), 1) > 0.5);
});

test('rows and csv export', () => {
  const m = new Map([['R_10', { ...walk(300) }], ['R_50', { prices: [1], epochs: [0] }]]);
  const rows = distributionRows(m);
  assert.equal(rows.length, 1);
  const csv = distributionCsv(rows);
  assert.ok(csv.startsWith('symbol,scope') && csv.includes('R_10,ticks_all'));
});

test('structural scan: distribution code cannot reach any order path', () => {
  for (const f of ['distribution3m.js', 'diagnostics3m.js']) {
    const src = fs.readFileSync(new URL(`../../src/bazu/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/buy|proposal|choke|execution|engine|WebSocket|send\(/i.test(src), f);
  }
});

test('page wires the Distribution tab without touching order calls', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('data-t="dist"') && html.includes('id="bzp-dist"'));
  const page = fs.readFileSync(new URL('../../src/bazu/page.js', import.meta.url), 'utf8');
  assert.ok(!/buyRiseFall/.test(page));
});
