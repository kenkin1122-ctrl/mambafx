/**
 * src/bazu/universe.js
 * Market-universe discovery parsing (pure). Symbols and duration limits come ONLY from Deriv
 * active_symbols / contracts_for responses; nothing is hard-coded except the candidate
 * durations that are intersected with what Deriv says is valid.
 */

const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDur(str) {
  const m = /^(\d+)([tsmhd])$/.exec(String(str || ''));
  return m ? { n: +m[1], unit: m[2] } : null;
}
const toSec = (d) => d.n * UNIT_SEC[d.unit];

/** World basket indices (WLDAUD, WLDEUR, ...) are excluded from BAZU entirely. */
const isBasket = (s) => /^WLD/i.test(s.underlying_symbol || s.symbol || '') || /basket/i.test(s.submarket || '');
export function parseActiveSymbols(list) {
  return (list || [])
    .filter((s) => s.market === 'synthetic_index' && !s.is_trading_suspended && s.exchange_is_open !== 0 && !isBasket(s))
    .map((s) => ({ symbol: s.underlying_symbol || s.symbol, name: s.underlying_symbol_name || s.display_name || s.underlying_symbol, pip: s.pip_size, submarket: s.submarket }));
}

/** Returns null when the symbol offers no Rise/Fall (CALL+PUT callput). */
export function parseContractsFor(resp) {
  const av = resp?.contracts_for?.available || [];
  const rf = av.filter((c) => c.contract_category === 'callput' && (c.contract_type === 'CALL' || c.contract_type === 'PUT'));
  if (!rf.some((c) => c.contract_type === 'CALL') || !rf.some((c) => c.contract_type === 'PUT')) return null;
  const ranges = [];
  for (const c of rf.filter((x) => x.contract_type === 'CALL')) {
    const lo = parseDur(c.min_contract_duration), hi = parseDur(c.max_contract_duration);
    if (lo && hi) ranges.push({ expiry: c.expiry_type, lo, hi });
  }
  return ranges.length ? { ranges } : null;
}

/** Is duration {unit,n} valid for these ranges? */
export function durationAllowed(ranges, d) {
  return ranges.some((r) => {
    if (d.unit === 't') return r.lo.unit === 't' && d.n >= r.lo.n && d.n <= r.hi.n;
    if (r.lo.unit === 't') return false;
    const s = toSec(d);
    return s >= toSec(r.lo) && s <= toSec(r.hi) && r.expiry !== 'daily';
  });
}

export const CANDIDATE_DURATIONS = Object.freeze([{ unit: 't', n: 5 }, { unit: 't', n: 10 }, { unit: 's', n: 30 }, { unit: 'm', n: 1 }, { unit: 'm', n: 15 }]);

/** Up to `max` validation durations that Deriv allows for this symbol. */
export function pickDurations(ranges, max = 2, candidates = CANDIDATE_DURATIONS) {
  return candidates.filter((d) => durationAllowed(ranges, d)).slice(0, max);
}
