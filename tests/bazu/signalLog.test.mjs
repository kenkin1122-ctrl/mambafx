import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configFor } from '../../src/bazu/config3m.js';
import { findSignal, QUOTE } from './siglogSupport3m.mjs';
import { buildRecord, classifyVote, finalizeF, finalizeG, validateRecord, stableStringify, analyse } from '../../src/bazu/siglog3m.js';
import { buildTradeSignal } from '../../src/bazu/decision.js';
import { performanceRows, performanceReport, reportCsv, printableHtml, buildSignalPackage, outcomeOfTrade, calibrationReport } from '../../src/bazu/reports3m.js';
import { zipStore, zipStoreAsync, unzipStore, fromUtf8, sha256Hex, utf8 } from '../../src/bazu/zip3m.js';
import { openStore } from '../../src/bazu/siglogStore3m.js';
import { createLogger } from '../../src/bazu/siglogRuntime3m.js';

let fixture;
function schemaErrors(value, schema, root, path = '$') {
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split('/').reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    return schemaErrors(value, target, root, path);
  }
  const errors = [];
  for (const branch of schema.allOf || []) errors.push(...schemaErrors(value, branch, root, path));
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => t === 'null' ? value === null
      : t === 'array' ? Array.isArray(value)
        : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : t === 'integer' ? Number.isInteger(value)
            : t === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === t);
    if (!ok) return [`${path}: expected ${types.join('|')}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: const mismatch`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum mismatch`);
  if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) errors.push(`${path}: invalid uuid`);
  if (schema.format === 'date-time' && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) errors.push(`${path}: invalid date-time`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, root, `${path}.${key}`));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, child] of Object.entries(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(...schemaErrors(child, schema.additionalProperties, root, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${path}.${key}: additional property`);
  }
  return errors;
}

function fakeIndexedDB() {
  const records = new Map(), indexes = new Set(), stores = new Set();
  const request = (result) => {
    const r = { result };
    setTimeout(() => r.onsuccess?.({ target: r }), 0);
    return r;
  };
  const store = {
    indexNames: { contains: (name) => indexes.has(name) },
    createIndex(name) { indexes.add(name); },
    put(value) { records.set(value.signal_id, structuredClone(value)); },
    delete(id) { records.delete(id); },
    getAll() { return request([...records.values()].map((x) => structuredClone(x))); },
  };
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) { stores.add(name); return store; },
    transaction() {
      const tx = { objectStore: () => store };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
    close() {},
  };
  return {
    open() {
      const r = { result: db, transaction: { objectStore: () => store } };
      setTimeout(() => {
        if (!stores.has('records')) r.onupgradeneeded?.({ target: r });
        r.onsuccess?.({ target: r });
      }, 0);
      return r;
    },
  };
}

function recordFixture(traded = false) {
  if (!fixture) {
    fixture = findSignal({ from: 6000 });
    assert.ok(fixture, 'synthetic test walk should contain a scored signal');
    fixture.sig.signalId = 'book-signal-fixture';
    fixture.sig.signalState = 'TRIGGERED';
    fixture.sig.signalHistory = [{ ts: fixture.sig.decisionTs, from: 'ARMED', to: 'TRIGGERED', reason: 'fixture trigger' }];
  }
  const { w, k, cfg, sig, symbol, remote } = fixture;
  const entryIndex = k, durationTicks = 10, exitIndex = entryIndex + durationTicks;
  const outcome = w.p[exitIndex] === w.p[entryIndex] ? 'Tie' : (sig.contractType === 'CALL' ? w.p[exitIndex] > w.p[entryIndex] : w.p[exitIndex] < w.p[entryIndex]) ? 'Win' : 'Loss';
  const trade = traded ? {
    id: 'fixture-contract-1', isReal: false, buyPrice: 1, payout: 1.95, profit: outcome === 'Win' ? 0.95 : -1,
    entry: w.p[entryIndex], entryEpoch: w.e[entryIndex], exit: w.p[exitIndex], exitEpoch: w.e[exitIndex],
    stake: 1, result: outcome.toLowerCase(), status: 'closed', predicted: sig.direction,
  } : null;
  const rec = buildRecord({ sig, cfg, symbol, name: symbol, prices: w.p, epochs: w.e, remote, trade, now: 1700010000000 });
  const done = finalizeF(rec, { trade, prices: w.p, epochs: w.e, now: 1700010000000 });
  const full = finalizeG(done, { prices: w.p, epochs: w.e, remote, now: 1700011000000 });
  return { rec, done, full, trade, fixture };
}

test('signal record contains point-in-time A-E, append-only F-G, and reasons for every null', async () => {
  const { rec, full, fixture: f } = recordFixture(true);
  assert.equal(rec.traded, true);
  assert.equal(rec.A.available_at_decision, true);
  for (const k of ['A', 'B', 'C', 'D', 'E']) assert.equal(rec[k].available_at_decision, true);
  for (const k of ['F', 'G']) assert.equal(rec[k].available_at_decision, false);
  assert.deepEqual(validateRecord(full), []);
  const decision = rec.decision_time_epoch_ms / 1000;
  for (const frames of Object.values(rec.B.candles)) for (const c of frames) assert.ok(c.epoch <= decision);
  assert.ok(rec.C.current_candle.epoch <= decision);
  assert.equal(rec.C.current_candle.forming, true);
  assert.ok(rec.A.state_transitions.some((e) => e.to === 'TRIGGERED'));
  assert.ok(rec.E.e2 && rec.E.e3 && rec.E.e4);
  assert.equal(stableStringify(analyse(rec.E.inputs)), stableStringify({ e2: rec.E.e2, e3: rec.E.e3, e4: rec.E.e4 }));
  assert.equal(full.F.contract.contract_id, 'fixture-contract-1');
  assert.equal(typeof full.F.result, 'string');
  assert.ok(full.F.hindsight);
  assert.equal(full.G.reversal.window_s, configFor(f.symbol).REVERSAL_WINDOW_S);
  const schema = JSON.parse(await readFile(new URL('../../reports/signal.schema.json', import.meta.url), 'utf8'));
  for (const k of schema.required) assert.ok(Object.hasOwn(full, k), `schema required key ${k}`);
  assert.deepEqual(schemaErrors(full, schema, schema), []);
});

test('logging on/off leaves trade decisions unchanged and disabled logging writes nothing', async () => {
  const { fixture: f } = recordFixture();
  const bookSignal = { id: f.sig.signalId, state: f.sig.signalState, lastReason: f.sig.signalReason, history: f.sig.signalHistory };
  const decision = () => buildTradeSignal({
    symbol: f.symbol, prediction: f.pred, duration: f.pred.durKey || '10t', quote: QUOTE,
    now: f.w.e[f.k - 1] * 1000, bookSignal,
  });
  const originalPrediction = JSON.stringify(f.pred);
  const originalDecision = JSON.stringify(decision());
  const writes = [];
  const store = { put: (record) => writes.push(record), all: () => [], prune() {} };
  const off = createLogger({ store, configForMarket: (symbol) => configFor(symbol, { SIGNAL_LOGGING_ENABLED: false }) });
  assert.equal(off.enabled(f.symbol), false);
  assert.equal(off.onBuy({ id: 'logging-off', isReal: false }, decision(), { symbol: f.symbol }), null);
  assert.equal(writes.length, 0);

  const on = createLogger({ store });
  assert.equal(on.enabled(f.symbol), true);
  assert.equal(on.onBuy({ id: 'logging-on', isReal: false }, decision(), {
    symbol: f.symbol, name: f.symbol, prices: f.w.p.slice(0, f.k), epochs: f.w.e.slice(0, f.k), remote: f.remote,
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(f.pred), originalPrediction);
  assert.equal(JSON.stringify(decision()), originalDecision);
});

test('untraded triggered signals are logged only when explicitly included', async () => {
  const { fixture: f } = recordFixture(), stored = [];
  const store = { put: (record) => stored.push(record), all: () => [], prune() {} };
  const market = { symbol: f.symbol, name: f.symbol, prices: f.w.p.slice(0, f.k), epochs: f.w.e.slice(0, f.k), remote: f.remote };
  const disabled = createLogger({ store, configForMarket: (symbol) => configFor(symbol) });
  assert.equal(disabled.onSignal(f.sig, market), null);
  const enabled = createLogger({ store, configForMarket: (symbol) => configFor(symbol, { SIGNAL_LOG_INCLUDE_UNTRADED: true }) });
  assert.equal(enabled.onSignal(f.sig, market), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].traded, false);
  assert.deepEqual(validateRecord(stored[0]), []);
});

test('logger processes at most one signal record per idle callback', () => {
  const { fixture: f } = recordFixture();
  const callbacks = [], stored = [];
  const hadIdle = Object.hasOwn(globalThis, 'requestIdleCallback'), previousIdle = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (callback) => { callbacks.push(callback); return callbacks.length; };
  try {
    const store = { put: (record) => stored.push(record), all: () => [], prune() {} };
    const logger = createLogger({ store, now: () => 1700000000000 });
    for (let i = 0; i < 3; i++) {
      const sig = { ...f.sig, signalId: `idle-batch-${i}`, signalHistory: [] };
      assert.equal(logger.onBuy({ id: `idle-contract-${i}`, isReal: false }, sig, {
        symbol: f.symbol, name: f.symbol, prices: f.w.p.slice(0, f.k), epochs: f.w.e.slice(0, f.k), remote: f.remote,
      }), true);
    }
    let count = 0;
    while (callbacks.length) {
      callbacks.shift()({ timeRemaining: () => 50, didTimeout: false });
      assert.equal(stored.length, ++count);
    }
    assert.equal(count, 3);
  } finally {
    if (hadIdle) globalThis.requestIdleCallback = previousIdle;
    else delete globalThis.requestIdleCallback;
  }
});

test('opposite candidate scores and leave-one-out sensitivity are deterministic on hand-built factors', () => {
  const families = Object.fromEntries(['trend', 'structure', 'flow'].map((name) => [name, {
    name, available: true, score: 1, vote: 1,
    members: [{ id: name, vote: 1, weight: 1, na: false }],
  }]));
  const T = { FAMILIES_AGREE_MIN: 3, AGREE_RATIO_MIN: 0.6, FAMILY_OPPOSE_STRONG: 0.6, FAMILY_VOTE_MIN: 0.34, MOM_VOTE_MIN: 0.25, MOM_OPPOSE_MOD: 0.25 };
  const inp = {
    dir: 1, strength: 0.8, minStrength: 0.45, families, T,
    votes: ['trend', 'structure', 'flow'].map((factor) => ({ factor, family: factor, vote: 1, weight: 1, na: false, reason: 'agrees' })),
    hypothetical: [], readings: {}, nearMissFrac: 0.15, nearNeutralFrac: 0.15, momentum: { score: 0.5 },
    candidateScores: [{ direction: 1, playbook: 'breakout', score: 0.8 }, { direction: -1, playbook: 'range fade', score: 0.7 }],
  };
  const a = analyse(inp);
  assert.equal(a.e3.opposite_playbook_score, 0.7);
  assert.equal(a.e3.opposite_playbook, 'range fade');
  assert.equal(a.e4.baseline_decision, 'TRADE');
  assert.equal(a.e4.by_family.find((x) => x.family === 'trend').remove_alone, 'WAIT');
  assert.equal(a.e4.by_factor.find((x) => x.factor === 'trend').flip_alone, 'WAIT');
  assert.equal(classifyVote(1, 1, 1), 'agreed_correct');
  assert.equal(classifyVote(-1, 1, -1), 'dissented_correct');
  assert.equal(classifyVote(0, 1, 1), 'neutral');
});

test('Performance rows rank Wilson rates, count ties as non-wins, and unrank low samples', async () => {
  assert.equal(outcomeOfTrade({ result: 'loss', profit: 100, entry: 1, exit: 2 }), 'loss', 'Deriv result wins over monetary profit sign');
  assert.equal(outcomeOfTrade({ result: 'unknown', profit: 100, entry: 1, exit: 2 }), null, 'unknown Deriv outcomes are not inferred from P/L');
  assert.equal(outcomeOfTrade({ result: 'loss', entry: 1, exit: 1 }), 'tie');
  const day = Date.UTC(2026, 0, 1), trades = [];
  for (let i = 0; i < 30; i++) trades.push({
    id: `t${i}`, market: 'R_100', status: 'closed', result: i < 15 ? 'win' : i === 29 ? 'loss' : 'loss',
    profit: i === 15 ? 0 : i < 15 ? 1 : -1, entry: i === 15 ? 100 : 100, exit: i === 15 ? 100 : i < 15 ? 101 : 99,
    ts: day + i * 1000, duration: '10t',
  });
  for (let i = 0; i < 5; i++) trades.push({ id: `small${i}`, market: 'R_25', status: 'closed', result: 'win', profit: 1, entry: 1, exit: 2, ts: day + i * 1000, duration: '10t' });
  const rows = performanceRows({ trades, minN: 30, filters: { from: '2026-01-01', to: '2026-01-01' } });
  const ranked = rows.find((r) => r.market === 'R_100');
  assert.equal(ranked.n, 30);
  assert.equal(ranked.wins, 15);
  assert.equal(ranked.losses, 14);
  assert.equal(ranked.ties, 1);
  assert.equal(ranked.rate, 0.5);
  assert.equal(ranked.rank, 1);
  assert.equal(rows.find((r) => r.market === 'R_25').rank, null);
  assert.equal(rows.find((r) => r.market === 'R_25').lowSample, true);
  const splitAccounts = performanceRows({ trades: [...trades, { ...trades[0], id: 'real-1', market: 'R_100', isReal: true }], minN: 30 });
  assert.equal(splitAccounts.filter((r) => r.market === 'R_100').length, 2);
  assert.deepEqual(new Set(splitAccounts.filter((r) => r.market === 'R_100').map((r) => r.accountType)), new Set(['demo', 'real']));
  const cross = performanceRows({ trades: trades.map((t) => ({ ...t, playbook: 'breakout' })), view: 'market-playbook', minN: 30 });
  assert.equal(cross.find((r) => r.market === 'R_100').playbook, 'breakout');
  assert.equal(cross.find((r) => r.market === 'R_100').n, 30);
  const shadowSignal = {
    signal_id: 'shadow-fixture', traded: true, market: 'R_100', market_class: 'volatility', decision_time_epoch_ms: day,
    A: { playbook: 'breakout', duration: { key: '10t', seconds: 10 } },
    F: { finalised: true, result: 'Win', hypothetical_outcomes: [{ duration: '10t', traded_direction: 'loss' }] },
  };
  const shadowRows = performanceRows({ trades: [trades[0]], signals: [shadowSignal], minN: 1 });
  assert.equal(shadowRows.find((r) => r.accountType === 'demo').wins, 1);
  assert.equal(shadowRows.find((r) => r.accountType === 'shadow').losses, 1);
  assert.equal(performanceRows({ signals: [shadowSignal], filters: { outcomeType: 'shadow' }, minN: 1 }).length, 1);
  const report = performanceReport(rows, 'market');
  const text = JSON.stringify(report) + reportCsv(report) + printableHtml('Performance', report);
  assert.doesNotMatch(text, /net\s*p\/?l|equity|profit/i);
  const page = await readFile(new URL('../../src/bazu/page.js', import.meta.url), 'utf8');
  const perfUi = page.slice(page.indexOf('function renderPerf'), page.indexOf('function renderSignalLog'));
  assert.doesNotMatch(perfUi, /net\s*p\/?l|equity|profit/i);
});

test('signal ZIP opens, uses requested layout and manifest hashes, and exports matching summary/NDJSON', async () => {
  const { full } = recordFixture(true);
  const schema = JSON.parse(await readFile(new URL('../../reports/signal.schema.json', import.meta.url), 'utf8'));
  const readme = await readFile(new URL('../../reports/README.md', import.meta.url), 'utf8');
  const dictionary = await readFile(new URL('../../reports/data_dictionary.md', import.meta.url), 'utf8');
  const date = full.decision_time_iso.slice(0, 10);
  const pack = await buildSignalPackage([full], { from: date, to: date, schema, readme, dataDictionary: dictionary });
  assert.equal(pack.count, 1, `${full.decision_time_iso} was selected for the UTC date range`);
  const files = unzipStore(pack.zip), byPath = new Map(files.map((f) => [f.name, f.data]));
  assert.ok([...byPath.keys()].some((p) => /^logs\/signals\/\d{4}-\d{2}-\d{2}\/R_100\/signal_.*\.json$/.test(p)));
  assert.ok(byPath.has('signals_summary.csv'));
  assert.ok(byPath.has('signals.ndjson'));
  const manifest = JSON.parse(fromUtf8(byPath.get('manifest.json')));
  for (const file of manifest.file_hashes_sha256) assert.equal(await sha256Hex(byPath.get(file.path)), file.sha256);
  const summary = fromUtf8(byPath.get('signals_summary.csv'));
  assert.ok(summary.includes(full.signal_id));
  assert.equal(JSON.parse(fromUtf8(byPath.get('signals.ndjson'))).signal_id, full.signal_id);
  const record = JSON.parse(fromUtf8([...byPath].find(([p]) => p.startsWith('logs/signals/'))[1]));
  assert.deepEqual(new Set(manifest.file_hashes_sha256.map((f) => f.path)), new Set([...byPath.keys()].filter((p) => p !== 'manifest.json')));
  const keys = [];
  const walk = (v) => { if (!v || typeof v !== 'object') return; for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
  walk(record);
  assert.ok(!keys.some((k) => /token|loginid|account.?number|balance|secret/i.test(k)));
  assert.doesNotMatch(reportCsv({ columns: ['a'], rows: [{ a: 'ok' }] }), /secret/i);
});

test('async ZIP writer yields during large files and matches the synchronous STORE archive', async () => {
  const files = [{ name: 'large.txt', data: 'x'.repeat(150000) }, { name: 'small.txt', data: 'ok' }];
  let yields = 0;
  const asyncZip = await zipStoreAsync(files, 1700000000000, { chunkBytes: 10000, yieldControl: async () => { yields++; } });
  const syncZip = zipStore(files, 1700000000000);
  assert.ok(yields >= 15);
  assert.deepEqual(asyncZip, syncZip);
  assert.deepEqual(unzipStore(asyncZip).map((f) => fromUtf8(f.data)), ['x'.repeat(150000), 'ok']);
});

test('calibration report keeps account results separate and includes intervals for rate/error outputs', () => {
  const { full } = recordFixture(true);
  const demo = { ...full, account_type: 'demo', F: { ...full.F, result: 'Win' } };
  const real = { ...full, signal_id: '22222222-2222-4222-8222-222222222222', account_type: 'real', F: { ...full.F, result: 'Loss' } };
  const report = calibrationReport({
    signalRecords: [demo, real],
    records: [
      { features: { wait: true }, durKey: '10t', shadow: { '10t': 'loss' } },
      { features: { wait: false }, durKey: '10t', shadow: { '10t': 'win' } },
    ],
    expiryCurve: {
      n: 2, curve: [{ lo: 0, hi: 0.5, n: 2, predicted: 0.4, observed: 0.5 }], samples: [{ probability: 0.4, outcome: 1 }, { probability: 0.4, outcome: 0 }],
      by_account_type: {
        demo: { n: 1, curve: [{ lo: 0, hi: 0.5, n: 1, predicted: 0.4, observed: 1 }], samples: [{ probability: 0.4, outcome: 1 }] },
        real: { n: 1, curve: [{ lo: 0, hi: 0.5, n: 1, predicted: 0.4, observed: 0 }], samples: [{ probability: 0.4, outcome: 0 }] },
      },
    },
  });
  assert.ok(report.hit_rate_by_duration['demo · 10t']);
  assert.ok(report.hit_rate_by_duration['real · 10t']);
  assert.equal(report.hit_rate_by_duration['10t'], undefined);
  assert.deepEqual(report.expiry_probability_curve.curve[0].observed_ci95.length, 2);
  assert.equal(report.expiry_probability_curve.brier_ci95.n, 2);
  assert.equal(report.expiry_probability_curve.by_account_type.demo.brier_ci95.n, 1);
  assert.equal(report.expiry_probability_curve.by_account_type.real.brier_ci95.n, 1);
  assert.equal(report.veto_audit.vetoed.n, 1);
  assert.equal(report.veto_audit.vetoed.ci95.length, 2);
});

test('pending records survive an IndexedDB reopen and can be finalized afterward', async () => {
  const { rec, full } = recordFixture(true), idb = fakeIndexedDB();
  const first = openStore({ idb, flushDelay: 0 });
  await first.ready;
  first.put(rec);
  await first.flush();
  const second = openStore({ idb, flushDelay: 0 });
  await second.ready;
  const restored = second.get(rec.signal_id);
  assert.equal(restored.F.pending, true);
  assert.deepEqual(restored.A, rec.A);
  second.put(full);
  await second.flush();
  const third = openStore({ idb, flushDelay: 0 });
  await third.ready;
  assert.equal(third.get(rec.signal_id).F.finalised, true);
  assert.deepEqual(third.get(rec.signal_id).A, rec.A);
});

test('retention and the hard cap prune stale pending and oldest completed records', () => {
  const store = openStore({ idb: null }), now = Date.UTC(2026, 0, 1);
  const item = (signal_id, ageDays, pending) => ({
    signal_id, decision_time_epoch_ms: now - ageDays * 86400000,
    F: { finalised: !pending }, G: { pending: pending },
  });
  store.put(item('expired-completed', 90, false));
  store.put(item('expired-pending', 3, true));
  store.put(item('fresh-pending', 1, true));
  store.put(item('fresh-completed', 0, false));
  assert.equal(store.prune({ maxRecords: 2, retentionDays: 60, now }), 2);
  assert.deepEqual(store.all().map((x) => x.signal_id).sort(), ['fresh-completed', 'fresh-pending']);
});

test('committed sample artifacts are explicitly synthetic and conform to the signal schema', async () => {
  const dir = new URL('../../reports/samples/', import.meta.url);
  const sample = JSON.parse(await readFile(new URL('signal_record.json', dir), 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../../reports/signal.schema.json', import.meta.url), 'utf8'));
  const notice = await readFile(new URL('README.txt', dir), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'));
  assert.match(notice, /synthetic/i);
  assert.deepEqual(validateRecord(sample), []);
  assert.deepEqual(schemaErrors(sample, schema, schema), []);
  const summary = await readFile(new URL('signals_summary.csv', dir), 'utf8'), ndjson = await readFile(new URL('signals.ndjson', dir), 'utf8');
  assert.match(summary, new RegExp(sample.signal_id));
  assert.equal(JSON.parse(ndjson).signal_id, sample.signal_id);
  for (const file of ['signals_summary.csv', 'signals.ndjson', 'signal_record.json']) {
    const text = await readFile(new URL(file, dir), 'utf8');
    const entry = manifest.file_hashes_sha256.find((item) => file === 'signal_record.json'
      ? item.path.endsWith(`signal_${sample.signal_id}.json`)
      : item.path === file);
    assert.ok(entry, `manifest includes ${file}`);
    assert.equal(await sha256Hex(utf8(text)), entry.sha256, `${file} matches its manifest hash`);
  }
  for (const [packagePath, text] of [
    ['schema/signal.schema.json', JSON.stringify(schema, null, 2)],
    ['README.md', await readFile(new URL('../../reports/README.md', dir), 'utf8')],
    ['data_dictionary.md', await readFile(new URL('../../reports/data_dictionary.md', dir), 'utf8')],
  ]) {
    const entry = manifest.file_hashes_sha256.find((item) => item.path === packagePath);
    assert.ok(entry, `manifest includes ${packagePath}`);
    assert.equal(await sha256Hex(utf8(text)), entry.sha256, `${packagePath} matches its manifest hash`);
  }
  const performance = JSON.parse(await readFile(new URL('performance.json', dir), 'utf8'));
  const performanceCsv = await readFile(new URL('performance.csv', dir), 'utf8');
  const performanceHtml = await readFile(new URL('performance.html', dir), 'utf8');
  assert.ok(performance.rows.length > 0);
  assert.match(performance.note, /synthetic/i);
  for (const row of performance.rows) {
    const rowCsv = performance.columns.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(',');
    assert.ok(performanceCsv.includes(rowCsv));
    for (const key of performance.columns) assert.ok(performanceHtml.includes(`<td>${String(row[key] ?? '')}</td>`));
  }
  const calibration = JSON.parse(await readFile(new URL('calibration.json', dir), 'utf8'));
  assert.match(calibration.sample_notice, /synthetic/i);
  assert.match(await readFile(new URL('calibration.csv', dir), 'utf8'), /sample_notice/);
  assert.match(await readFile(new URL('calibration.html', dir), 'utf8'), /Synthetic fixtures only/);
  const perfResults = JSON.parse(await readFile(new URL('performance_results.json', dir), 'utf8'));
  assert.match(perfResults.workload.type, /synthetic/i);
  assert.ok(perfResults.export.observed_main_thread_long_task_max_ms <= perfResults.export.long_task_threshold_ms);
});

test('logger storage errors stay isolated from the caller and are surfaced in logger status', async () => {
  const f = fixture || findSignal({ from: 6000 });
  fixture = f;
  const store = { all: () => [], put() { throw new Error('quota exceeded'); }, prune() {}, flush: async () => {} };
  const logger = createLogger({ store, getMarket: () => null, now: () => 1700010000000 });
  const m = { symbol: f.symbol, name: f.symbol, prices: f.w.p, epochs: f.w.e, remote: f.remote };
  const trade = { id: 'contract-error-fixture', isReal: false, status: 'open' };
  assert.equal(logger.onBuy(trade, f.sig, m), true);
  assert.doesNotThrow(() => logger.flush());
  assert.ok(logger.stat.errors > 0);
  assert.match(logger.stat.lastError, /quota exceeded/);
  const failingStore = openStore({ idb: { open() { throw new Error('IndexedDB unavailable'); } } });
  await failingStore.ready;
  assert.equal(failingStore.stat.writeErrors, 1);
  assert.match(failingStore.stat.lastError, /IndexedDB unavailable/);
  const page = await readFile(new URL('../../src/bazu/page.js', import.meta.url), 'utf8');
  assert.match(page, /Storage error:/);
  assert.match(page, /Logger error:/);
});
