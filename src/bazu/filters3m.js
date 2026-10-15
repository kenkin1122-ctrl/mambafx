/**
 * src/bazu/filters3m.js  (pure, P4-P9)
 * Breakout filters, experimental range-fade conditions, adverse-excursion label, named room checks,
 * regime-dependent volatility filter, cooldown and hysteresis. Every verdict is ALWAYS computed so shadow
 * analysis works with the flags off; the flags (default OFF) only decide whether a verdict vetoes.
 * Verdict shape: { pass: true | false | null (not available - never counted as passed), value, reason }.
 */
import { wilson } from './stats.js?v=15';
import { tickFlowProxy } from './expiry3m.js?v=15';

const fin = Number.isFinite;
const V = (pass, value, reason) => ({ pass, value: fin(value) ? +value.toFixed(3) : value ?? null, reason });
const NA = (reason) => V(null, null, reason);

export const FILTER_KEYS = Object.freeze(['penetration', 'closeConfirm', 'retestHold', 'tickFlow', 'distance', 'intensity']);

/** Candle that broke the zone edge: the most recent one whose close is beyond it. */
function breakCandle(cs, zone, dir) {
  const edge = dir > 0 ? zone.high : zone.low;
  const beyond = (c) => (dir > 0 ? c.close - edge : edge - c.close) > 0;
  let j = cs.length - 1;
  if (!beyond(cs[j])) return null;
  while (j > 0 && cs.length - j < 12 && beyond(cs[j - 1])) j--;
  return { j, edge };
}

/** Constant tick spacing (fixed-rate synthetics) means intensity carries no information. */
export function tickGapsConstant(epochs, n = 120) {
  const e = epochs.slice(-n); if (e.length < 10) return true;
  const gaps = new Set(); for (let i = 1; i < e.length; i++) gaps.add(e[i] - e[i - 1]);
  return gaps.size <= 1;
}

/** P4 a-f. Returns { penetration, closeConfirm, retestHold, tickFlow, distance, intensity }. */
export function breakoutFilters({ cs, zone, dir, atr, prices, epochs, zones, price, cfg }) {
  const none = (r) => Object.fromEntries(FILTER_KEYS.map((k) => [k, NA(r)]));
  if (!zone || !(atr > 0) || !cs?.length) return none('no breakout context');
  const bc = breakCandle(cs, zone, dir);
  const out = {};
  if (!bc) { out.penetration = NA('no closed break candle'); out.closeConfirm = NA('no closed break candle'); out.retestHold = NA('no closed break candle'); }
  else {
    const c = cs[bc.j], depth = (dir > 0 ? c.close - bc.edge : bc.edge - c.close) / atr;
    out.penetration = V(depth >= cfg.BRK_PENETRATION_ATR, depth, `close beyond zone by ${depth.toFixed(2)} ATR (need ${cfg.BRK_PENETRATION_ATR})`);
    const after = cs.slice(bc.j + 1);
    out.closeConfirm = after.length ? V(after.every((x) => (dir > 0 ? x.close > bc.edge : x.close < bc.edge)), after.length, `${after.length} closed candle(s) after the break`) : NA('no candle closed after the break yet');
    const touched = after.filter((x) => (dir > 0 ? x.low <= bc.edge + 0.25 * atr : x.high >= bc.edge - 0.25 * atr));
    out.retestHold = !after.length ? NA('no retest data') : !touched.length ? NA('no retest yet') : V(touched.every((x) => (dir > 0 ? x.close >= bc.edge : x.close <= bc.edge)), touched.length, 'retest closed back on the break side');
  }
  const fl = prices?.length > 30 ? tickFlowProxy(prices, dir, cfg.BRK_FLOW_TICKS) : null;
  out.tickFlow = fl == null ? NA('tick flow proxy unavailable') : V(fl >= cfg.BRK_FLOW_MIN, fl, `tick flow proxy ${fl.toFixed(2)} (signed up-vs-down tick count, a proxy not volume)`);
  const opp = (zones || []).filter((z) => (dir > 0 ? z.low > price : z.high < price) && z !== zone && ['resistance', 'supply', 'support', 'demand'].includes(z.kind));
  const dist = opp.length ? Math.min(...opp.map((z) => (dir > 0 ? z.low - price : price - z.high))) : Infinity;
  out.distance = V(dist / atr >= cfg.BRK_ROOM_ATR, Number.isFinite(dist) ? dist / atr : 99, Number.isFinite(dist) ? `${(dist / atr).toFixed(2)} ATR to the next zone (need ${cfg.BRK_ROOM_ATR})` : 'no opposing zone ahead');
  out.intensity = tickGapsConstant(epochs || []) ? NA('tick timing is fixed-rate on this market: intensity not available') : (() => {
    const e = epochs.slice(-cfg.BRK_FLOW_TICKS), base = epochs.slice(-cfg.BRK_FLOW_TICKS * 4, -cfg.BRK_FLOW_TICKS);
    const r = base.length > 10 ? ((e.length / Math.max(1, e.at(-1) - e[0])) / (base.length / Math.max(1, base.at(-1) - base[0]))) : null;
    return r == null ? NA('not enough history') : V(r >= cfg.BRK_INTENSITY_MIN, r, `tick rate ${r.toFixed(2)}x the preceding window`);
  })();
  return out;
}

/** Which enabled filters fail (null = not available never fails and never counts as passed). */
export const failedFilters = (f, enabled) => FILTER_KEYS.filter((k) => enabled?.[k] && f?.[k] && f[k].pass === false);

/** P5: preregistered conditions of the experimental range-fade. Returns {ok, parts}. */
export function rangeFadeExp({ adxVal, dir, zone, price, candle, cfg }) {
  if (!zone || !candle || !fin(adxVal)) return { ok: false, parts: { reason: 'missing data' } };
  const h = zone.high - zone.low, edge = dir > 0 ? zone.low : zone.high;
  const nearEdge = h > 0 && Math.abs(price - edge) <= cfg.RFX_EDGE_FRAC * Math.max(h, 1e-12) + 0;
  const wick = dir > 0 ? candle.lowerFrac : candle.upperFrac;
  const parts = { adx: adxVal < cfg.RFX_ADX_MAX, edge: nearEdge, wick: wick >= cfg.RFX_WICK };
  return { ok: parts.adx && parts.edge && parts.wick, parts };
}

/** Label only when N and the lower CI bound justify it. Never a marketing label. */
export function performanceLabel(wins, n, breakEven, nMin = 500) {
  if (!(n > 0)) return { label: 'no data', n: 0 };
  const ci = wilson(wins, n), hit = wins / n;
  const label = n < nMin ? `insufficient sample (N=${n} < ${nMin})` : ci.lo > breakEven ? 'positive after costs (95% CI above break-even)' : 'not distinguishable from break-even';
  return { label, n, hit, lo: ci.lo, hi: ci.hi, breakEven };
}

/** P6: adverse-excursion label. Adverse = price moved against the trade by >= K sigma before expiry. */
export function adverseLabel(rec, cfg) {
  const p = rec.path, s = rec.features?.sigmaPerSec;
  if (!p || !(s > 0) || !fin(rec.durSec)) return null;
  const thr = cfg.ADVERSE_K * s * Math.sqrt(rec.durSec);
  return p.maxAdverseInDur >= thr ? 1 : 0;
}

/** P7: named, independent room checks. Each prints its numbers; the first that fires is reported. */
export function roomChecks({ move, room, atr, price, dir, target, invalid, cfg }) {
  const checks = [];
  checks.push({ name: 'no-room', ok: !fin(move) || !fin(room) || move <= cfg.NOROOM_FRAC * room, text: `expected move ${fin(move) ? move.toPrecision(3) : 'n/a'} vs ${cfg.NOROOM_FRAC} x distance to the opposing zone ${fin(room) ? room.toPrecision(3) : 'none'}` });
  checks.push({ name: 'available-distance', ok: !fin(room) || !(atr > 0) || room >= cfg.AVAIL_ATR * atr, text: `distance to the opposing zone ${fin(room) && atr > 0 ? (room / atr).toFixed(2) : 'none'} ATR (need ${cfg.AVAIL_ATR})` });
  const a = fin(target) ? (target - price) * dir : null, b = fin(invalid) ? (price - invalid) * dir : null;
  checks.push({ name: 'reward-to-risk', ok: a == null || !(b > 0) || a / b >= cfg.RR_MIN, text: `reward ${a == null ? 'n/a' : a.toPrecision(3)} / risk ${b == null ? 'n/a' : b.toPrecision(3)} (need ${cfg.RR_MIN})` });
  const fired = checks.find((c) => !c.ok) || null;
  return { checks, fired: fired?.name || null, text: checks.map((c) => `${c.name}: ${c.ok ? 'OK' : 'FAIL'} (${c.text})`).join('; ') };
}

/** P8: regime-dependent volatility filter replacing the fixed chase limit. */
export function volatilityFilter({ rangeATR, adxVal, momentumAligned, cfg }) {
  if (!fin(rangeATR) || rangeATR <= cfg.VOL_RANGE_ATR) return { high: false, allow: true, label: null };
  if (!fin(adxVal)) return { high: true, allow: false, label: 'High volatility - regime unknown' };
  if (adxVal > 25) return momentumAligned ? { high: true, allow: true, label: 'High volatility - trend confirmed' } : { high: true, allow: false, label: 'High volatility - momentum not aligned' };
  if (adxVal < 20) return { high: true, allow: false, label: 'High volatility - late entry risk' };
  return { high: true, allow: !!cfg.VOL_TRANSITION_ALLOW, label: 'High volatility - transition' };
}

/** P9: cooldown that never touches expiry/cancel/invalidation/risk (it only gates NEW signal creation). */
export function cooldownBlocks({ last, now, cfg, setup, durSec }) {
  if (!last || !cfg.COOLDOWN_ON) return { blocked: false };
  const win = cfg.COOLDOWN_S * (durSec ? Math.max(1, Math.min(3, durSec / 60)) : 1);
  if (now - last.at >= win) return { blocked: false };
  const distinct = last.playbook !== setup.playbook || last.zoneMid !== setup.zoneMid || (last.invalidated && last.dir === setup.dir);
  return distinct ? { blocked: false, exception: 'distinct setup' } : { blocked: true, reason: `cooldown ${Math.round(win - (now - last.at))}s left after the previous signal` };
}

/** P9: hysteresis - higher bar to become tradable than to stay tradable. */
export function hysteresisPass({ strength, wasTradable, min, cfg }) {
  const enter = min + (cfg.HYST_ENTER_EXTRA ?? 0), exit = min - (cfg.HYST_EXIT_SLACK ?? 0);
  return wasTradable ? strength >= exit : strength >= enter;
}
