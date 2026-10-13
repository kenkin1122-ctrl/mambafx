import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveSymbols, parseContractsFor, pickDurations, parseDur } from '../../src/bazu/universe.js';

const cf = (types) => ({ contracts_for: { available: types } });
const t = (type, expiry, lo, hi) => ({ contract_category: 'callput', contract_type: type, expiry_type: expiry, min_contract_duration: lo, max_contract_duration: hi });

test('active symbols filtered to open synthetic indices', () => {
  const r = parseActiveSymbols([
    { underlying_symbol: 'R_100', market: 'synthetic_index', pip_size: 0.01 },
    { underlying_symbol: 'frxEURUSD', market: 'forex' },
    { underlying_symbol: 'X', market: 'synthetic_index', is_trading_suspended: 1 },
  ]);
  assert.deepEqual(r.map((x) => x.symbol), ['R_100']);
});

test('skips symbols without Rise/Fall', () => {
  assert.equal(parseContractsFor(cf([{ contract_category: 'accumulator', contract_type: 'ACCU' }])), null);
});

test('durations only those Deriv allows', () => {
  const r = parseContractsFor(cf([t('CALL', 'tick', '1t', '10t'), t('PUT', 'tick', '1t', '10t'), t('CALL', 'intraday', '15s', '1d'), t('PUT', 'intraday', '15s', '1d')]));
  assert.deepEqual(pickDurations(r.ranges, 3).map((d) => `${d.n}${d.unit}`), ['5t', '10t', '30s']);
  const w = parseContractsFor(cf([t('CALL', 'intraday', '15m', '10h'), t('PUT', 'intraday', '15m', '10h')]));
  assert.deepEqual(pickDurations(w.ranges, 3).map((d) => `${d.n}${d.unit}`), ['15m']);
  assert.deepEqual(parseDur('15s'), { n: 15, unit: 's' });
});
