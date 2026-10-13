import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../../src/bazu/stats.js';
import { exitIndices, outcomes, evaluate, runPipeline, computeFeatures, validateMarket } from '../../src/bazu/validation.js';
import { buildBazuRegistry } from '../../src/bazu/indicators.js';

function walk(n, seed, persist = 0.5) {
  const r = createSeededRng(seed), p = [100], e = [1700000000];
  let dir = 1;
  for (let i = 1; i < n; i++) { if (r() > persist) dir = -dir; p.push(+(p[i - 1] + dir * (0.5 + r())).toFixed(3)); e.push(e[i - 1] + 2); }
  return { prices: p, epochs: e };
}

test('registry holds core + BAZU plugins', () => {
  const reg = buildBazuRegistry();
  assert.ok(reg.lookup('RSI') && reg.lookup('TickDelta') && reg.lookup('KalmanSlope'));
  assert.ok(reg.list().length >= 40);
});

test('exit indices for ticks and seconds, outcome ties lose', () => {
  const { epochs } = walk(50, 1);
  assert.equal(exitIndices(epochs, { unit: 't', n: 5 })[0], 5);
  assert.equal(exitIndices(epochs, { unit: 's', n: 10 })[0], 5);
  const o = outcomes([1, 1, 2], new Int32Array([1, -1, -1]));
  assert.equal(o[0], 0);
});

test('evaluate is non-overlapping', () => {
  const dir = new Int8Array(20).fill(1), out = new Int8Array(20).fill(1), exit = new Int32Array(20).map((_, i) => (i + 5 < 20 ? i + 5 : -1));
  assert.equal(evaluate(dir, out, exit, 0, 20).n, 3);
});

test('features are causal: truncating the future does not change earlier values', () => {
  const { prices, epochs } = walk(1500, 3);
  const full = computeFeatures(prices, epochs), cut = computeFeatures(prices.slice(0, 1200), epochs.slice(0, 1200));
  const bad = [];
  for (const id of Object.keys(cut)) for (let i = 0; i < 1000; i++) {
    const a = full[id].values[i], b = cut[id].values[i];
    if (Number.isFinite(a) !== Number.isFinite(b) || (Number.isFinite(a) && Math.abs(a - b) > 1e-6 * (1 + Math.abs(a)))) { bad.push(id); break; }
  }
  assert.deepEqual(bad, []);
});

test('pipeline finds a planted momentum edge and rejects pure noise', { timeout: 120000 }, () => {
  const dur = { unit: 't', n: 1 };
  const edge = walk(9000, 11, 0.7);
  const e = validateMarket({ symbol: 'EDGE', ...edge, duration: dur, nullRuns: 0, permutations: 150 });
  assert.ok(e.counts.published >= 1, JSON.stringify(e.counts));
  const noise = walk(9000, 12, 0.5);
  const nz = validateMarket({ symbol: 'NOISE', ...noise, duration: dur, nullRuns: 0, permutations: 150 });
  assert.ok(nz.counts.published <= 1, JSON.stringify(nz.counts));
});
