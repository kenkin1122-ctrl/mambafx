/**
 * src/bazu/crtBazu3m.js  (pure, shadow only)
 * Maps a CRT tracker record to a BAZU-style signal package: direction, target, invalidation, state,
 * lifetime (existing estimators E1/E3/E5 + snapDuration) and a rule-based score.
 * Nothing here places orders, touches the signal book or the choke point.
 */
import { e1, e3, e5, combine, snapDuration, durationLabel } from "./duration3m.js?v=15";

export const CRT_BAZU_CONFIG = Object.freeze({
  config_version: "crt-bazu-1",
  crt_enabled: true,
  crt_trade_enabled: false,
  long_horizon: "wait", // wait | skip : what to do when the CRT lifetime exceeds MAX_DURATION_S
  e5_multiple: 3,
  trigger_secs: 300,
  drift_window_ticks: 300,
  label: "rule-based, unvalidated playbook",
  score_note: "Rule-based confluence score (0-100), not a probability.",
  weights: Object.freeze({ sweep: 20, reclaim: 20, poi: 20, htf: 15, compression: 15, room: 10 }),
});

const finite = (x) => Number.isFinite(x);
const clamp01 = (x) => (finite(x) ? Math.min(1, Math.max(0, x)) : 0);
export const CRT_SIGNAL_STATES = Object.freeze({ ARMED: "ARMED", TRIGGERED: "TRIGGERED", EXPIRED: "EXPIRED", INVALIDATED: "INVALIDATED", REJECTED: "REJECTED" });

/** CRT tracker status to BAZU signal state; null = not a signal (no sweep). */
export function mapState(record) {
  const s = record.signalStatus, why = record.rejectionReason;
  if (s === "WATCH") return CRT_SIGNAL_STATES.ARMED;
  if (s === "QUALIFIED" || s === "TRIGGERED") return CRT_SIGNAL_STATES.TRIGGERED;
  if (why === "trigger_timeout" || why === "watch_expired") return CRT_SIGNAL_STATES.EXPIRED;
  if (why === "range_invalidation") return CRT_SIGNAL_STATES.INVALIDATED;
  if (why === "no_sweep_reclaim" || !record.sweepSide || record.sweepSide === "NONE") return null;
  return CRT_SIGNAL_STATES.REJECTED;
}

export function crtScore(record, cfg = CRT_BAZU_CONFIG) {
  const w = cfg.weights, range = record.rangeHigh - record.rangeLow;
  const rise = record.sweepSide === "LOW", entry = record.breakCandle?.close;
  const parts = {
    sweep: w.sweep * clamp01((record.wickDepthAtr ?? 0) / 1),
    reclaim: w.reclaim * (range > 0 && finite(entry) ? clamp01(rise ? (entry - record.sweptExtreme) / range : (record.sweptExtreme - entry) / range) : 0),
    poi: w.poi * clamp01((record.confluenceScore ?? 0) / 2),
    htf: w.htf * (record.htfBiasOk ? 1 : 0),
    compression: w.compression * (finite(record.compressionRatio) ? clamp01(1 - record.compressionRatio) : 0),
    room: w.room * (finite(record.rrRatio) ? clamp01(record.rrRatio / 2) : 0),
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, parts, note: cfg.score_note };
}

/** Tick-path speed: variance rate (price^2/s) and signed drift (price/s) over the last N ticks. */
export function pathSpeed(prices, epochs, n = CRT_BAZU_CONFIG.drift_window_ticks) {
  const len = Math.min(prices.length, epochs.length);
  if (len < 20) return { s2: null, drift: null };
  const from = Math.max(1, len - n), dts = [], steps = [];
  for (let i = from; i < len; i++) { const dt = epochs[i] - epochs[i - 1]; if (dt > 0) { dts.push(dt); steps.push(prices[i] - prices[i - 1]); } }
  if (steps.length < 10) return { s2: null, drift: null };
  const total = dts.reduce((a, b) => a + b, 0);
  const s2 = steps.reduce((a, b) => a + b * b, 0) / total;
  return { s2, drift: (prices[len - 1] - prices[from - 1]) / (epochs[len - 1] - epochs[from - 1] || NaN) };
}

/** Lifetime from E1 (corridor exit), E5 (pattern horizon) and E3 (trend speed), snapped to allowed durations. */
export function crtLifetime({ record, entry, target, invalidation, prices, epochs, allowed, cfg, bazuCfg = CRT_BAZU_CONFIG }) {
  const rise = record.sweepSide === "LOW";
  const a = Math.abs(target - entry), b = Math.abs(entry - invalidation);
  const { s2, drift } = pathSpeed(prices || [], epochs || []);
  const towards = finite(drift) && (rise ? drift > 0 : drift < 0) ? Math.abs(drift) : null;
  const estimators = { E1: e1(a, b, s2), E3: e3(a, towards, towards != null), E5: e5(bazuCfg.e5_multiple, record.triggerSecs ?? bazuCfg.trigger_secs) };
  const life = combine([estimators.E1, estimators.E3, estimators.E5], cfg.COMBINE || "median");
  if (life == null) return { estimators, lifetime: null, duration: null, decision: "WAIT", reason: "no lifetime estimator applies" };
  if (life > cfg.MAX_DURATION_S) {
    return { estimators, lifetime: life, duration: null, decision: bazuCfg.long_horizon === "skip" ? "SKIP" : "WAIT", reason: "CRT horizon beyond tradable range" };
  }
  const snap = snapDuration(life, allowed || [], cfg);
  return { estimators, lifetime: life, duration: snap.duration ? durationLabel(snap.duration) : null, decision: snap.duration ? "CANDIDATE" : "WAIT", reason: snap.reason };
}

/** Full package for one CRT record, or null when the record is not a signal. */
export function mapCrtRecord(record, { prices, epochs, allowed, cfg, bazuCfg = CRT_BAZU_CONFIG } = {}) {
  const state = mapState(record);
  if (!state || (record.sweepSide !== "LOW" && record.sweepSide !== "HIGH")) return null;
  const rise = record.sweepSide === "LOW", sign = rise ? 1 : -1;
  const buffer = finite(record.atrValueUsed) ? (record.bufferMultiplier ?? 0) * record.atrValueUsed : 0;
  const invalidation = record.sweptExtreme - sign * buffer;
  const target = record.crt50, secondTarget = rise ? record.rangeHigh : record.rangeLow;
  const entry = record.breakCandle?.close;
  const pkg = {
    playbook: "CRT", variant: record.playbookVariant || "H1+", symbol: record.instrument, crtId: record.crtId, parentTimeframe: record.timeframe,
    direction: rise ? "Rise" : "Fall", state, shadow: true, tradeEligible: false,
    label: bazuCfg.label, configVersion: bazuCfg.config_version, crtConfigVersion: record.configVersion ?? null,
    triggeredAt: finite(record.c3Timestamp) ? record.c3Timestamp : null, entry: finite(entry) ? entry : null, target, secondTarget, invalidation,
    reason: record.rejectionReason || null, rejectionDetail: record.rejectionDetail || null,
    ...crtScore(record, bazuCfg),
    lifetime: null, decision: state === "TRIGGERED" ? "WAIT" : "NONE",
  };
  if (state === "TRIGGERED" && finite(entry) && cfg) {
    const life = crtLifetime({ record, entry, target, invalidation, prices, epochs, allowed, cfg, bazuCfg });
    pkg.lifetime = { estimators: life.estimators, seconds: life.lifetime, duration: life.duration };
    pkg.decision = life.decision;
    pkg.waitReason = life.reason;
  }
  return pkg;
}

/** Map every record of a scan; honours the crt_enabled switch for the market. */
export function mapCrtScan(records, ctx, switches) {
  if (switches && !switches.isEnabled(ctx.symbol)) return [];
  return (records || []).map((r) => mapCrtRecord(r, ctx)).filter(Boolean);
}

/**
 * Runtime switches. crt_enabled defaults true (global and per market). crt_trade_enabled defaults false,
 * is never persisted and is not consulted by any order path in this PR.
 */
export function createCrtSwitches({ storage = null, key = "bazu_crt_switches" } = {}) {
  let enabled = CRT_BAZU_CONFIG.crt_enabled;
  const perMarket = new Map(), tradePerMarket = new Map();
  let trade = false;
  const variants = new Map(), variantTrade = new Map();
  try {
    const saved = storage ? JSON.parse(storage.getItem(key) || "null") : null;
    if (saved) { if (typeof saved.enabled === "boolean") enabled = saved.enabled; for (const [k, v] of Object.entries(saved.markets || {})) if (typeof v === "boolean") perMarket.set(k, v); for (const [k, v] of Object.entries(saved.variants || {})) if (typeof v === "boolean") variants.set(k, v); }
  } catch { /* ignore corrupt storage */ }
  const save = () => { try { storage?.setItem(key, JSON.stringify({ enabled, markets: Object.fromEntries(perMarket), variants: Object.fromEntries(variants) })); } catch { /* quota */ } };
  return {
    isEnabled: (symbol) => enabled && perMarket.get(symbol) !== false,
    isTradeEnabled: (symbol) => trade && tradePerMarket.get(symbol) !== false,
    setEnabled(v) { enabled = !!v; save(); },
    setMarket(symbol, v) { perMarket.set(symbol, !!v); save(); },
    setTradeEnabled(v) { trade = !!v; },
    setTradeMarket(symbol, v) { tradePerMarket.set(symbol, !!v); },
    isVariantEnabled: (variant) => enabled && variants.get(variant) !== false,
    isVariantTradeEnabled: (variant) => trade && variantTrade.get(variant) === true,
    setVariant(variant, v) { variants.set(variant, !!v); save(); },
    setVariantTrade(variant, v) { variantTrade.set(variant, !!v); },
    snapshot: () => ({ crt_enabled: enabled, crt_trade_enabled: trade, tradeMarkets: Object.fromEntries(tradePerMarket), markets: Object.fromEntries(perMarket), variants: Object.fromEntries(["M5", "M15", "M30"].map((k) => [k, { enabled: enabled && variants.get(k) !== false, trade: trade && variantTrade.get(k) === true }])) }),
  };
}
