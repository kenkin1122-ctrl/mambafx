import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BASE_CONFIG, configFor } from '../../src/bazu/config3m.js';
import { buildRecord, validateRecord } from '../../src/bazu/siglog3m.js';
import { analyseFrames, classifyRegime, playbookFor, MTF_FRAMES } from '../../src/bazu/mtf3m.js';
import { findSignal } from './siglogSupport3m.mjs';

const strip = (o) => JSON.parse(JSON.stringify(o));
const read = (f) => fs.readFileSync(new URL(`../../src/bazu/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');

test('defaults: MTF_LOG_ONLY on, MTF_GATE off', () => {
  assert.equal(BASE_CONFIG.MTF_LOG_ONLY, true);
  assert.equal(BASE_CONFIG.MTF_GATE, false);
});

test('golden: identical signal and record (except the mtf section) with MTF_LOG_ONLY on and off, gate off', () => {
  const on = findSignal({ overrides: { CONFLUENCE_MODE: 'families', MTF_LOG_ONLY: true, MTF_GATE: false } });
  const off = findSignal({ overrides: { CONFLUENCE_MODE: 'families', MTF_LOG_ONLY: false, MTF_GATE: false } });
  assert.ok(on && off);
  assert.deepEqual(strip(on.sig), strip(off.sig));
  assert.deepEqual(strip(on.pred), strip(off.pred));
  assert.equal(on.sig.contractType, off.sig.contractType);
  assert.equal(on.sig.duration, off.sig.duration);
  const mk = (f) => buildRecord({ sig: f.sig, cfg: f.cfg, symbol: f.symbol, name: f.symbol, prices: f.w.p, epochs: f.w.e, remote: f.remote, trade: null, id: 'golden', now: 1700010000000 });
  const a = mk(on), b = mk(off);
  assert.ok(a.mtf && !b.mtf, 'mtf only present when logging is on');
  const { mtf, config, config_hash, flags, ...ra } = strip(a), { config: c2, config_hash: h2, flags: f2, ...rb } = strip(b);
  for (const k of ['MTF_LOG_ONLY']) { delete config?.[k]; }
  assert.deepEqual(ra, rb);
  assert.deepEqual(validateRecord(a), []);
  assert.ok(Object.keys(mtf.frames).every((k) => MTF_FRAMES.includes(k)));
});

test('turning MTF_GATE on changes nothing either (flag is not consumed by any decision)', () => {
  const a = findSignal({ overrides: { CONFLUENCE_MODE: 'families', MTF_GATE: false } }), b = findSignal({ overrides: { CONFLUENCE_MODE: 'families', MTF_GATE: true } });
  assert.deepEqual(strip(a.sig), strip(b.sig));
});

test('classification and alignment from shared diagnostics', () => {
  assert.equal(classifyRegime({ varianceRatio: 1.3, hurst: 0.7 }), 'trending');
  assert.equal(classifyRegime({ varianceRatio: 0.7, hurst: 0.4 }), 'mean-reverting');
  assert.equal(classifyRegime({ varianceRatio: 1, hurst: 0.5 }), 'random');
  assert.equal(classifyRegime({ varianceRatio: NaN, hurst: 0.5 }), 'insufficient');
  assert.equal(playbookFor('trending'), 'trend-pullback');
  const up = Array.from({ length: 60 }, (_, i) => ({ close: 100 + i * 0.1 + (i % 3) * 0.01 }));
  const r = analyseFrames({ M1: up, M5: up.slice(0, 10) }, 1);
  assert.equal(r.frames.M1.direction, 1);
  assert.equal(r.frames.M1.aligned, true);
  assert.equal(r.frames.M5.regime, 'insufficient');
  assert.equal(r.alignedCount, 1);
});

test('structural scan: MTF code cannot reach any order path; flags are read only by config, siglog and mtf', () => {
  for (const f of ['mtf3m.js', 'diagnostics3m.js']) assert.ok(!/buy|proposal|choke|execution|engine|WebSocket|send\(/i.test(read(f)), f);
  for (const f of fs.readdirSync(new URL('../../src/bazu/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    if (['config3m.js', 'siglog3m.js', 'mtf3m.js'].includes(f)) continue;
    assert.ok(!/MTF_GATE|MTF_LOG_ONLY|mtf3m/.test(read(f)) || f === 'page.js', `${f} must not read MTF flags`);
  }
  assert.ok(!/MTF_GATE/.test(read('siglog3m.js')) && !/MTF_GATE/.test(read('mtf3m.js')));
});

test('NaN diagnostics never break record validation; invalid records are skipped, not fatal to the export', async () => {
  const { analyseFrames } = await import('../../src/bazu/mtf3m.js');
  const flat = Array.from({ length: 80 }, () => ({ close: 100 }));
  const r = analyseFrames({ M1: flat }, 1);
  assert.ok(Object.values(r.frames.M1).every((v) => typeof v !== 'number' || Number.isFinite(v)));
  const { buildSignalPackage } = await import('../../src/bazu/reports3m.js');
  const f = findSignal({});
  const good = buildRecord({ sig: f.sig, cfg: f.cfg, symbol: f.symbol, name: f.symbol, prices: f.w.p, epochs: f.w.e, remote: f.remote, trade: { id: 'c1', isReal: false, buyPrice: 1, payout: 1.95, profit: 0.95, entry: 1, entryEpoch: 1, exit: 2, exitEpoch: 2, stake: 1, result: 'win', status: 'closed', predicted: f.sig.direction }, now: 1700010000000 });
  const bad = { ...JSON.parse(JSON.stringify(good)), signal_id: 'bad', A: undefined };
  const pack = await buildSignalPackage([good, bad], { schema: {}, readme: '', dataDictionary: '', yieldControl: async () => {} });
  assert.equal(pack.count, 1);
  assert.equal(pack.skipped.length, 1);
});
