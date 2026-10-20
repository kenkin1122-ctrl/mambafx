/**
 * src/bazu/crtLtf3m.js  (pure, shadow only)
 * Lower-timeframe CRT variants: parent M5/M15/M30 with M1/M3 triggers.
 * Reuses the existing CRT primitives (ATR, sweep rule, POI scoring, MSS, risk geometry) and never changes them.
 * Own config version and own enable switches; defaults: detect-and-log on, trading off.
 */
import { atrRatio, buildCrtFrames, closedAsOf, confirmedStructureBias, findMss, htfBiasAllows, scorePoiConfluence, applyRiskGeometry } from "./crt3m.js?v=7";
import { CRT_CONFIG } from "./crtConfig3m.js";

export const CRT_LTF_CONFIG = Object.freeze({
  config_version: "crt-ltf-1",
  mode: "A (previous parent candle range) only",
  variants: Object.freeze({
    M5: Object.freeze({ parentSeconds: 300, triggerFrame: "M1", trigger: "1m", triggerSeconds: 60, source: "M5", enabled: true, trade_enabled: false }),
    M15: Object.freeze({ parentSeconds: 900, triggerFrame: "M3", trigger: "3m", triggerSeconds: 3 * 60, source: "M15", enabled: true, trade_enabled: false }),
    M30: Object.freeze({ parentSeconds: 1800, triggerFrame: "M3", trigger: "3m", triggerSeconds: 3 * 60, source: "M15x2", enabled: true, trade_enabled: false }),
  }),
  max_trigger_candles: 10, // 5 candles cannot fit pivot + two confirmation candles + break on 1m/3m triggers
  watch_parent_candles: 1,
  buffer_multiplier: 0.05,
  compression_threshold: 0.85,
  poi_proximity: 2.5,
  min_confluence_score: 1,
});

const finite = Number.isFinite;
const barEnd = (bar, seconds) => bar.epoch + seconds;

/** M15 -> M30, point in time: only complete, aligned, contiguous pairs that closed by the decision epoch. */
export function aggregateM30(m15, decisionEpoch) {
  const bars = closedAsOf(m15, 900, decisionEpoch), out = [];
  for (let i = 0; i + 1 < bars.length; i++) {
    const a = bars[i], b = bars[i + 1];
    if (a.epoch % 1800 !== 0 || b.epoch !== a.epoch + 900) continue;
    out.push({ epoch: a.epoch, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close });
    i++;
  }
  return out;
}

function priorLevels(frames, decisionEpoch, direction) {
  const levels = [], daily = closedAsOf(frames["1D"], 86400, decisionEpoch), weekly = closedAsOf(frames["1W"], 604800, decisionEpoch);
  if (daily.length) { const c = daily.at(-1); levels.push({ type: direction > 0 ? "PDL" : "PDH", level: direction > 0 ? c.low : c.high, epoch: c.epoch }); }
  if (weekly.length) { const c = weekly.at(-1); levels.push({ type: direction > 0 ? "PWL" : "PWH", level: direction > 0 ? c.low : c.high, epoch: c.epoch }); }
  return levels;
}

/**
 * Scan one variant. `candles` = { M1, M3, M5, M15, H1 } (any may be missing).
 * Returns CRT-shaped records (same fields the BAZU mapping reads) plus variant tags.
 */
export function scanCrtLtfVariant({ symbol, variant, candles, decisionEpoch, minTick, cfg = CRT_LTF_CONFIG }) {
  const v = cfg.variants[variant];
  if (!v) throw new RangeError(`Unknown CRT variant ${variant}`);
  if (!finite(decisionEpoch) || !finite(minTick) || minTick <= 0) throw new RangeError("variant scan needs a decision epoch and a positive minimum tick.");
  const parentAll = variant === "M30" ? aggregateM30(candles.M15 || [], decisionEpoch) : closedAsOf(candles[v.source] || [], v.parentSeconds, decisionEpoch);
  const parent = closedAsOf(parentAll, v.parentSeconds, decisionEpoch);
  if (parent.length < CRT_CONFIG.atr_period + CRT_CONFIG.atr_ratio_sma_period - 1 + 1) return [];
  const c2Index = parent.length - 1, c2 = parent[c2Index], c1 = parent[c2Index - 1];
  const rangeHigh = c1.high, rangeLow = c1.low;
  const { atr: epsAtr } = atrRatio(parent.slice(0, c2Index));
  const { atr, atrRatio: ratio } = atrRatio(parent.slice(0, c2Index + 1));
  const epsilon = finite(epsAtr) ? Math.max(minTick * 3, epsAtr * cfg.buffer_multiplier) : null;
  const high = finite(epsilon) && c2.high > rangeHigh + epsilon && c2.close > rangeLow && c2.close < rangeHigh;
  const low = finite(epsilon) && c2.low < rangeLow - epsilon && c2.close > rangeLow && c2.close < rangeHigh;
  const side = high && low ? "BOTH" : high ? "HIGH" : low ? "LOW" : null;
  const c2Close = barEnd(c2, v.parentSeconds);
  const frames = buildCrtFrames(candles.H1 || [], decisionEpoch);
  const h4 = confirmedStructureBias(frames["4H"]), d1 = confirmedStructureBias(frames["1D"]);
  const boundary = side === "HIGH" ? rangeHigh : side === "LOW" ? rangeLow : null;
  const poi = boundary != null && atr > 0 ? scorePoiConfluence(priorLevels(frames, c2Close, side === "LOW" ? 1 : -1), boundary, atr, cfg.poi_proximity) : null;
  const atrOk = finite(ratio) && ratio >= CRT_CONFIG.atr_sanity.min_atr_ratio && ratio <= CRT_CONFIG.atr_sanity.max_atr_ratio;
  const common = {
    crtId: `${symbol}|LTF_${variant}|${v.parentSeconds}|${c2.epoch}`, variantId: `CRT_LTF_${variant}`, playbookVariant: variant,
    instrument: symbol, timeframe: variant, parentCandleTimeframe: variant, triggerSecs: v.triggerSeconds, ltfTimeframe: v.trigger,
    rangeHigh, rangeLow, crt50: (rangeHigh + rangeLow) / 2, c1Timestamp: c1.epoch, c2Timestamp: c2.epoch, c2CloseTimestamp: c2Close,
    sweptExtreme: side === "HIGH" ? c2.high : side === "LOW" ? c2.low : null, sweepSide: side, epsilonUsed: epsilon,
    bufferMultiplier: cfg.buffer_multiplier, atrValueUsed: atr ?? null, atrRatio: ratio ?? null, atrSanityOk: atrOk,
    wickDepthAtr: side === "HIGH" ? (c2.high - rangeHigh) / atr : side === "LOW" ? (rangeLow - c2.low) / atr : null,
    htfBias: { "4H": h4, "1D": d1 }, htfBiasOk: htfBiasAllows(side, h4, d1), poiOk: !!poi?.poiOk, poi: poi?.poi || null,
    poiDistanceAtr: poi?.poiDistanceAtr ?? null, confluenceScore: poi?.confluenceScore ?? 0,
    configVersion: cfg.config_version, pointInTimeCheck: "PASS", watchExpiresAtEpoch: c2Close + v.parentSeconds * cfg.watch_parent_candles,
  };
  const reject = (reason, extra = {}) => [{ ...common, signalStatus: "REJECTED", rejectionReason: reason, riskStatus: "REJECTED", ...extra }];
  if (!side) return reject("no_sweep_reclaim");
  if (side === "BOTH") return reject("both_side_sweep");
  if (!atrOk) return reject("atr_sanity_failed");
  if (!poi || poi.confluenceScore < cfg.min_confluence_score) return reject("confluence_score_below_minimum", { rejectionDetail: `confluence_score=${poi?.confluenceScore ?? 0} < min ${cfg.min_confluence_score}` });
  if (!common.htfBiasOk) return reject("htf_bias_conflict_or_neutral");
  const trigger = findMss(candles[v.triggerFrame] || [], { c2CloseEpoch: c2Close, decisionEpoch, sweepSide: side, rangeHigh, rangeLow, compressionThreshold: cfg.compression_threshold, maxCandles: cfg.max_trigger_candles, timeframe: v.trigger });
  const record = { ...common, ...trigger, ltfTimeframe: v.trigger, ltfPriorityUsed: `LTF_${v.trigger}` };
  if (trigger.status === "TRIGGERED") {
    record.direction = side === "LOW" ? "Rise" : "Fall";
    record.signalStatus = "QUALIFIED"; record.rejectionReason = null; record.riskStatus = "PENDING";
    applyRiskGeometry(record);
  } else if (trigger.status === "WAITING") {
    record.signalStatus = "WATCH"; record.rejectionReason = trigger.reason; record.riskStatus = "PENDING";
  } else {
    record.signalStatus = "REJECTED"; record.rejectionReason = trigger.reason; record.riskStatus = "REJECTED";
  }
  if (record.signalStatus === "WATCH" && decisionEpoch >= record.watchExpiresAtEpoch) {
    record.signalStatus = "REJECTED"; record.rejectionReason = "watch_expired"; record.riskStatus = "REJECTED"; record.status = "EXPIRED";
  }
  return [record];
}

export function scanCrtLtf({ symbol, candles, decisionEpoch, minTick, isVariantEnabled = () => true, cfg = CRT_LTF_CONFIG }) {
  const out = [];
  for (const variant of Object.keys(cfg.variants)) {
    if (!isVariantEnabled(variant)) continue;
    out.push(...scanCrtLtfVariant({ symbol, variant, candles, decisionEpoch, minTick, cfg }));
  }
  return out;
}
