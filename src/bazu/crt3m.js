import { CRT_CONFIG } from "./crtConfig3m.js";

const DAY_S = 86400;
const WEEK_S = 604800;
const MONDAY_OFFSET_S = 3 * DAY_S;
const LTF_S = Object.freeze({ "1m": 60, "5m": 300 });
const ROUTER_RANK = Object.freeze({ "8H": 1, "4H": 2, "2H": 3, "1H": 4 });

const finite = Number.isFinite;
const barEnd = (bar, seconds) => bar.epoch + seconds;
const barRange = (bar) => bar.high - bar.low;

export function asOf(candles, decisionEpoch, requestedEpoch = decisionEpoch) {
  if (!finite(decisionEpoch) || !finite(requestedEpoch)) throw new TypeError("as_of timestamps must be finite.");
  if (requestedEpoch > decisionEpoch) throw new RangeError("future-data request exceeds the decision timestamp.");
  return candles.filter((c) => c.epoch <= decisionEpoch);
}

export function closedAsOf(candles, seconds, decisionEpoch, requestedEpoch = decisionEpoch) {
  if (!finite(seconds) || seconds <= 0) throw new RangeError("candle duration must be positive.");
  return asOf(candles, decisionEpoch, requestedEpoch).filter((c) => barEnd(c, seconds) <= decisionEpoch);
}

export function wilderAtr(candles, period = CRT_CONFIG.atr_period) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError("ATR period must be a positive integer.");
  if (!Array.isArray(candles) || candles.some((c) => !c || ![c.epoch, c.open, c.high, c.low, c.close].every(finite) || c.high < c.low)) {
    throw new TypeError("ATR requires candles with finite OHLC values.");
  }
  const result = Array(candles.length).fill(null);
  if (candles.length < period) return result;
  const tr = candles.map((c, i) => {
    if (i === 0) return barRange(c);
    const priorClose = candles[i - 1].close;
    return Math.max(barRange(c), Math.abs(c.high - priorClose), Math.abs(c.low - priorClose));
  });
  let atr = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

export function atrRatio(candles, period = CRT_CONFIG.atr_period, averagePeriod = CRT_CONFIG.atr_ratio_sma_period) {
  const values = wilderAtr(candles, period);
  const current = values.at(-1);
  const recent = values.slice(-averagePeriod);
  if (recent.length !== averagePeriod || recent.some((value) => !finite(value) || value <= 0) || !finite(current) || current <= 0) {
    return { atr: finite(current) ? current : null, atrRatio: null };
  }
  const avg = recent.reduce((sum, value) => sum + value, 0) / averagePeriod;
  return { atr: current, atrRatio: avg > 0 ? current / avg : null };
}

function aggregate(candles, seconds, bucketStart) {
  const groups = new Map();
  for (const c of candles) {
    const epoch = bucketStart(c.epoch, seconds);
    let group = groups.get(epoch);
    if (!group) {
      group = { epoch, open: c.open, high: c.high, low: c.low, close: c.close, count: 0, firstEpoch: c.epoch, lastEpoch: null, contiguous: true };
      groups.set(epoch, group);
    } else {
      group.high = Math.max(group.high, c.high);
      group.low = Math.min(group.low, c.low);
      group.close = c.close;
      if (c.epoch !== group.lastEpoch + 3600) group.contiguous = false;
    }
    group.count++;
    group.lastEpoch = c.epoch;
  }
  const childSeconds = 3600, expected = seconds / childSeconds;
  return [...groups.values()]
    .filter((c) => c.count === expected && c.firstEpoch === c.epoch && c.lastEpoch === c.epoch + seconds - childSeconds && c.contiguous)
    .map(({ epoch, open, high, low, close }) => ({ epoch, open, high, low, close }));
}

const utcDayStart = (epoch) => Math.floor(epoch / DAY_S) * DAY_S;
const utcWeekStart = (epoch) => Math.floor((epoch - MONDAY_OFFSET_S) / WEEK_S) * WEEK_S + MONDAY_OFFSET_S;

export function buildCrtFrames(h1Candles, decisionEpoch) {
  const h1 = closedAsOf(h1Candles, 3600, decisionEpoch);
  const completeFrame = (bars, seconds) => bars.filter((c) => barEnd(c, seconds) <= decisionEpoch);
  const frames = {
    "1H": h1,
    "2H": completeFrame(aggregate(h1, 7200, (t, s) => Math.floor(t / s) * s), 7200),
    "4H": completeFrame(aggregate(h1, 14400, (t, s) => Math.floor(t / s) * s), 14400),
    "8H": completeFrame(aggregate(h1, 28800, (t, s) => Math.floor(t / s) * s), 28800),
    "1D": completeFrame(aggregate(h1, DAY_S, utcDayStart), DAY_S),
    "1W": completeFrame(aggregate(h1, WEEK_S, utcWeekStart), WEEK_S),
  };
  return frames;
}

function confirmedPivots(candles) {
  const highs = [], lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    const before = candles.slice(i - 2, i), after = candles.slice(i + 1, i + 3);
    if (before.every((x) => c.high > x.high) && after.every((x) => c.high > x.high)) highs.push({ index: i, level: c.high, epoch: c.epoch });
    if (before.every((x) => c.low < x.low) && after.every((x) => c.low < x.low)) lows.push({ index: i, level: c.low, epoch: c.epoch });
  }
  return { highs, lows };
}

export function confirmedStructureBias(candles) {
  const { highs, lows } = confirmedPivots(candles);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const [priorHigh, lastHigh] = highs.slice(-2), [priorLow, lastLow] = lows.slice(-2);
  if (lastHigh.level > priorHigh.level && lastLow.level > priorLow.level) return "bullish";
  if (lastHigh.level < priorHigh.level && lastLow.level < priorLow.level) return "bearish";
  return "neutral";
}

function priorLevels(frames, decisionEpoch, direction) {
  const daily = closedAsOf(frames["1D"], DAY_S, decisionEpoch);
  const weekly = closedAsOf(frames["1W"], WEEK_S, decisionEpoch);
  const levels = [];
  if (daily.length) {
    const c = daily.at(-1);
    levels.push({ type: direction > 0 ? "PDL" : "PDH", level: direction > 0 ? c.low : c.high, epoch: c.epoch });
  }
  if (weekly.length) {
    const c = weekly.at(-1);
    levels.push({ type: direction > 0 ? "PWL" : "PWH", level: direction > 0 ? c.low : c.high, epoch: c.epoch });
  }
  return levels;
}

function currentPoi(frames, boundary, atr, direction, decisionEpoch, proximityMultiplier) {
  return scorePoiConfluence(priorLevels(frames, decisionEpoch, direction), boundary, atr, proximityMultiplier);
}

export function scorePoiConfluence(levels, boundary, atr, proximityMultiplier) {
  if (!Array.isArray(levels) || !finite(boundary) || !finite(atr) || atr <= 0 || !finite(proximityMultiplier) || proximityMultiplier < 0) {
    throw new RangeError("POI scoring requires finite levels, boundary, positive ATR, and a nonnegative multiplier.");
  }
  const ranked = levels
    .filter((poi) => poi && finite(poi.level))
    .map((poi) => ({ ...poi, distance: Math.abs(boundary - poi.level), distanceAtr: Math.abs(boundary - poi.level) / atr }))
    .sort((a, b) => a.distance - b.distance);
  const qualifying = ranked.filter((poi) => poi.distance <= atr * proximityMultiplier);
  const nearest = ranked[0] || null;
  const threshold = atr * proximityMultiplier;
  return {
    poiOk: qualifying.length > 0,
    poi: nearest && { type: nearest.type, level: nearest.level, epoch: nearest.epoch },
    poiDistanceAtr: nearest?.distanceAtr ?? null,
    poiProximityThresholdUsed: proximityMultiplier,
    confluenceScore: qualifying.length,
    confluenceDetails: qualifying.map(({ type, level, epoch }) => ({ type, level, epoch })),
  };
}

export function findMss(candles, { c2CloseEpoch, decisionEpoch, sweepSide, rangeHigh, rangeLow, compressionThreshold = CRT_CONFIG.compression_gate.default_threshold, maxCandles = CRT_CONFIG.trigger_lifetime.max_ltf_candles_for_trigger, timeframe = CRT_CONFIG.ltf_trigger_policy.primary_ltf } = {}) {
  const seconds = LTF_S[timeframe];
  if (!seconds) throw new RangeError(`Unsupported CRT LTF: ${timeframe}`);
  if (!finite(decisionEpoch) || !finite(c2CloseEpoch) || c2CloseEpoch > decisionEpoch) throw new RangeError("MSS requires a valid point-in-time decision after the sweep close.");
  if (!["LOW", "HIGH"].includes(sweepSide)) throw new RangeError("MSS sweepSide must be LOW or HIGH.");
  if (!finite(rangeHigh) || !finite(rangeLow) || rangeHigh <= rangeLow) throw new RangeError("MSS requires a valid range.");
  if (!Number.isInteger(maxCandles) || maxCandles < 1) throw new RangeError("maxCandles must be a positive integer.");
  if (!finite(compressionThreshold) || compressionThreshold <= 0) throw new RangeError("compressionThreshold must be positive.");
  const closed = closedAsOf(candles, seconds, decisionEpoch);
  let waited = 0;
  const afterC2 = closed.filter((c) => barEnd(c, seconds) > c2CloseEpoch);
  const candidates = [];
  for (let i = 2; i < closed.length - 2; i++) {
    const pivot = closed[i], t4 = closed[i + 1], t5 = closed[i + 2];
    const confirmedAt = barEnd(t5, seconds);
    if (confirmedAt <= c2CloseEpoch) continue;
    const isHighPivot = closed[i - 2].high < pivot.high && closed[i - 1].high < pivot.high && closed[i + 1].high < pivot.high && closed[i + 2].high < pivot.high;
    const isLowPivot = closed[i - 2].low > pivot.low && closed[i - 1].low > pivot.low && closed[i + 1].low > pivot.low && closed[i + 2].low > pivot.low;
    const validPivot = sweepSide === "LOW" ? isHighPivot : isLowPivot;
    if (!validPivot) continue;
    const triggerRange = barRange(t5), pivotRange = barRange(pivot), priorRange = barRange(t4);
    const compressionOk = triggerRange < compressionThreshold * pivotRange && triggerRange < priorRange;
    const candlesWaitedAtConfirmation = closed.filter((x) => barEnd(x, seconds) > c2CloseEpoch && barEnd(x, seconds) <= confirmedAt).length;
    if (candlesWaitedAtConfirmation > maxCandles) continue;
    if (!compressionOk) return { status: "INVALID", reason: "compression_failed", R_t5: triggerRange, R_pivot: pivotRange, R_t4: priorRange, compressionRatio: pivotRange > 0 ? triggerRange / pivotRange : null, rejectionDetail: `compression_failed: R_t5=${triggerRange} R_pivot=${pivotRange} R_t4=${priorRange}; ratio=${pivotRange > 0 ? (triggerRange / pivotRange).toFixed(3) : "n/a"} (need < ${compressionThreshold} and R_t5 < R_t4)`, triggerCandlesWaited: candlesWaitedAtConfirmation, pivot: { epoch: pivot.epoch, high: pivot.high, low: pivot.low, confirmedAt } };
    let counted = 0;
    for (let j = i + 3; j < closed.length; j++) {
      const candle = closed[j], end = barEnd(candle, seconds);
      if (end <= c2CloseEpoch) continue;
      counted = afterC2.filter((x) => barEnd(x, seconds) <= end).length;
      waited = Math.max(waited, counted);
      if (counted > maxCandles) break;
      if ((sweepSide === "LOW" && candle.close < rangeLow) || (sweepSide === "HIGH" && candle.close > rangeHigh)) {
        return { status: "INVALID", reason: "range_invalidation", triggerCandlesWaited: counted, pivot: null };
      }
      const broke = sweepSide === "LOW" ? candle.close > pivot.high : candle.close < pivot.low;
      if (!broke) continue;
      candidates.push({
        status: "TRIGGERED",
        reason: null,
        triggerType: "MSS",
        ltfTimeframe: timeframe,
        ltfPriorityUsed: timeframe === "5m" ? "PRIMARY_5M" : "SECONDARY_1M",
        ltfAbsorbedByPriority: false,
        c3Timestamp: end,
        swingLevel: sweepSide === "LOW" ? pivot.high : pivot.low,
        breakCandle: { epoch: candle.epoch, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
        pivot: { epoch: pivot.epoch, high: pivot.high, low: pivot.low, confirmedAt },
        compressionRatio: pivotRange > 0 ? triggerRange / pivotRange : null,
        compressionWindowUsed: [pivot.epoch, t4.epoch, t5.epoch],
        triggerCandlesWaited: counted,
      });
    }
  }
  if (candidates.length) return candidates.sort((a, b) => a.c3Timestamp - b.c3Timestamp)[0];
  const candlesWaited = afterC2.length;
  if (candlesWaited >= maxCandles || waited >= maxCandles) return { status: "EXPIRED", reason: "trigger_timeout", triggerCandlesWaited: Math.max(candlesWaited, waited), pivot: null };
  return { status: "WAITING", reason: candlesWaited ? "waiting_for_post_sweep_mss" : "waiting_for_ltf_data", triggerCandlesWaited: candlesWaited, pivot: null };
}

function rangeFor(variant, parent, index, lookback) {
  if (variant === "CRT_MODE_A") {
    const c1 = parent[index - 1];
    return c1 ? { c1, rangeHigh: c1.high, rangeLow: c1.low, rangeStartEpoch: c1.epoch } : null;
  }
  const candles = parent.slice(index - lookback, index);
  if (candles.length !== lookback) return null;
  return {
    c1: candles.at(-1),
    rangeHigh: Math.max(...candles.map((c) => c.high)),
    rangeLow: Math.min(...candles.map((c) => c.low)),
    rangeStartEpoch: candles[0].epoch,
  };
}

export function htfBiasAllows(side, h4Bias, dailyBias, strict = CRT_CONFIG.strict_htf_alignment) {
  const wanted = side === "LOW" ? "bullish" : side === "HIGH" ? "bearish" : "neutral";
  if (strict) return h4Bias === dailyBias && h4Bias === wanted;
  return h4Bias === wanted && (dailyBias === wanted || dailyBias === "neutral");
}

function rejectedRecord(base, reason) {
  return { ...base, signalStatus: "REJECTED", rejectionReason: reason, riskStatus: "REJECTED", riskRejectionReason: null };
}

export function scanCrt({ symbol, h1Candles, ltfCandles, decisionEpoch, minTick, bufferMultiplier = CRT_CONFIG.buffer_multiplier, compressionThreshold = CRT_CONFIG.compression_gate.default_threshold, poiProximityMultiplier = CRT_CONFIG.poi_proximity.default_value, fractalRouter = null, routeResults = true } = {}) {
  if (!symbol || !Array.isArray(h1Candles) || !Array.isArray(ltfCandles) || !finite(decisionEpoch)) throw new TypeError("CRT scan requires symbol, candle arrays, and a decision timestamp.");
  if (!finite(minTick) || minTick <= 0) throw new RangeError("CRT requires a positive symbol minimum tick.");
  if (!finite(bufferMultiplier) || bufferMultiplier < CRT_CONFIG.buffer_multiplier_bounds.min || bufferMultiplier > CRT_CONFIG.buffer_multiplier_bounds.max) {
    throw new RangeError(`bufferMultiplier must be in [${CRT_CONFIG.buffer_multiplier_bounds.min}, ${CRT_CONFIG.buffer_multiplier_bounds.max}].`);
  }
  if (!finite(compressionThreshold) || compressionThreshold < CRT_CONFIG.compression_gate.min_threshold || compressionThreshold > CRT_CONFIG.compression_gate.max_threshold) throw new RangeError("compressionThreshold is outside the configured range.");
  if (!finite(poiProximityMultiplier) || poiProximityMultiplier < CRT_CONFIG.poi_proximity.min_value || poiProximityMultiplier > CRT_CONFIG.poi_proximity.max_value) throw new RangeError("poiProximityMultiplier is outside the configured range.");

  const frames = buildCrtFrames(h1Candles, decisionEpoch);
  const ltf = closedAsOf(ltfCandles, 300, decisionEpoch);
  const h4Bias = confirmedStructureBias(frames["4H"]), dailyBias = confirmedStructureBias(frames["1D"]);
  const output = [];
  for (const timeframe of CRT_CONFIG.parent_timeframes) {
    const parentSeconds = CRT_CONFIG.parent_seconds[timeframe], parent = frames[timeframe];
    const closed = closedAsOf(parent, parentSeconds, decisionEpoch);
    if (closed.length < CRT_CONFIG.atr_period + CRT_CONFIG.atr_ratio_sma_period - 1) continue;
    const c2Index = closed.length - 1, c2 = closed[c2Index];
    for (const variant of ["CRT_MODE_A", "CRT_MODE_B"]) {
      if ((variant === "CRT_MODE_A" && !CRT_CONFIG.mode_a_enabled) || (variant === "CRT_MODE_B" && !CRT_CONFIG.mode_b_enabled)) continue;
      const range = rangeFor(variant, closed, c2Index, CRT_CONFIG.mode_b_lookback);
      if (!range) continue;
      const { atr: epsilonAtr } = atrRatio(closed.slice(0, c2Index), CRT_CONFIG.atr_period, CRT_CONFIG.atr_ratio_sma_period);
      const { atr, atrRatio: ratio } = atrRatio(closed.slice(0, c2Index + 1), CRT_CONFIG.atr_period, CRT_CONFIG.atr_ratio_sma_period);
      const epsilon = finite(epsilonAtr) ? Math.max(minTick * 3, epsilonAtr * bufferMultiplier) : null;
      const highSweep = finite(epsilon) && c2.high > range.rangeHigh + epsilon && c2.close > range.rangeLow && c2.close < range.rangeHigh;
      const lowSweep = finite(epsilon) && c2.low < range.rangeLow - epsilon && c2.close > range.rangeLow && c2.close < range.rangeHigh;
      const side = highSweep && lowSweep ? "BOTH" : highSweep ? "HIGH" : lowSweep ? "LOW" : null;
      const boundary = side === "HIGH" ? range.rangeHigh : side === "LOW" ? range.rangeLow : null;
      const poi = boundary != null && atr > 0 ? currentPoi(frames, boundary, atr, side === "LOW" ? 1 : -1, barEnd(c2, parentSeconds), poiProximityMultiplier) : null;
      const atrOk = finite(ratio) && ratio >= CRT_CONFIG.atr_sanity.min_atr_ratio && ratio <= CRT_CONFIG.atr_sanity.max_atr_ratio;
      const id = `${symbol}|${variant}|${timeframe}|${c2.epoch}`;
      const common = {
        crtId: id,
        variantId: variant === "CRT_MODE_A" ? `${variant}_${timeframe}` : variant,
        instrument: symbol,
        timeframe,
        parentCandleTimeframe: timeframe,
        executionMode: CRT_CONFIG.execution_mode,
        triggerType: CRT_CONFIG.trigger_policy.mss_enabled ? "MSS" : null,
        c1Timestamp: range.c1.epoch,
        rangeHigh: range.rangeHigh,
        rangeLow: range.rangeLow,
        crt50: (range.rangeHigh + range.rangeLow) / 2,
        rangeMode: variant === "CRT_MODE_A" ? "A" : "B",
        epsilonUsed: epsilon,
        bufferMultiplier,
        c2Timestamp: c2.epoch,
        c2CloseTimestamp: barEnd(c2, parentSeconds),
        sweepSide: side,
        wickDepthAtr: side === "HIGH" ? (c2.high - range.rangeHigh) / atr : side === "LOW" ? (range.rangeLow - c2.low) / atr : null,
        closeInside: side === "HIGH" || side === "LOW",
        htfBias: { "4H": h4Bias, "1D": dailyBias },
        htfBiasOk: htfBiasAllows(side, h4Bias, dailyBias),
        poiOk: !!poi?.poiOk,
        poi: poi?.poi || null,
        poiDistanceAtr: poi?.poiDistanceAtr ?? null,
        poiProximityThresholdUsed: poiProximityMultiplier,
        atrValueUsed: atr ?? null,
        atr14Wilder: atr ?? null,
        epsilonAtr14Wilder: epsilonAtr ?? null,
        atrRatio: ratio ?? null,
        atrSanityOk: atrOk,
        sessionOk: true,
        pointInTimeCheck: "PASS",
        confluenceScore: poi?.confluenceScore ?? 0,
        confluenceDetails: poi?.confluenceDetails ?? [],
        compressionThresholdUsed: compressionThreshold,
        triggerCandlesWaited: 0,
        fractalScanStatus: "ISOLATED",
        fractalAlignmentScore: 0,
        routedByScanner: false,
        priorityRank: ROUTER_RANK[timeframe],
        absorbedBoundaryDiff: null,
        absorptionToleranceUsed: null,
        absorbedByCrtId: null,
        assetLockoutActive: false,
        lockoutReason: null,
        ltfPriorityUsed: null,
        ltfAbsorbedByPriority: false,
      };
      if (!side) { output.push(rejectedRecord(common, "no_sweep_reclaim")); continue; }
      if (side === "BOTH") { output.push(rejectedRecord(common, "both_side_sweep")); continue; }
      if (!atrOk) { output.push(rejectedRecord(common, "atr_sanity_failed")); continue; }
      if (!poi || poi.confluenceScore < CRT_CONFIG.min_confluence_score) {
        const score = poi?.confluenceScore ?? 0;
        const rejected = rejectedRecord(common, "confluence_score_below_minimum");
        rejected.confluence_score = score;
        rejected.rejectionDetail = `confluence_score=${score} < min ${CRT_CONFIG.min_confluence_score}; nearest POI ${common.poiDistanceAtr == null ? "none" : `${common.poiDistanceAtr.toFixed(3)} ATR`} vs limit ${poiProximityMultiplier} ATR`;
        output.push(rejected);
        continue;
      }
      if (!common.htfBiasOk) { output.push(rejectedRecord(common, "htf_bias_conflict_or_neutral")); continue; }
      if (!CRT_CONFIG.trigger_policy.mss_enabled) { output.push(rejectedRecord(common, "trigger_variant_disabled")); continue; }

      const trigger = findMss(ltf, { c2CloseEpoch: common.c2CloseTimestamp, decisionEpoch, sweepSide: side, rangeHigh: range.rangeHigh, rangeLow: range.rangeLow, compressionThreshold, maxCandles: CRT_CONFIG.trigger_lifetime.max_ltf_candles_for_trigger, timeframe: CRT_CONFIG.ltf_trigger_policy.primary_ltf });
      const record = { ...common, ...trigger };
      record.watchExpiresAtEpoch = common.c2CloseTimestamp + parentSeconds * CRT_CONFIG.watch_parent_candles;
      if (trigger.status === "TRIGGERED") {
        record.direction = side === "LOW" ? "Rise" : "Fall";
        record.signalStatus = "QUALIFIED";
        record.rejectionReason = null;
        record.riskStatus = "PENDING";
        record.riskRejectionReason = null;
        const entry = trigger.breakCandle.close;
        const stop = side === "LOW" ? c2.low : c2.high;
        const tpDistance = side === "LOW" ? common.crt50 - entry : entry - common.crt50;
        const riskDistance = side === "LOW" ? entry - stop : stop - entry;
        const rr = riskDistance > 0 ? tpDistance / riskDistance : null;
        record.rrRatio = rr;
        record.tpDistance = tpDistance;
        record.riskDistance = riskDistance;
        if (!finite(rr) || rr < CRT_CONFIG.min_rr_ratio) {
          record.signalStatus = "REJECTED";
          record.rejectionReason = "risk_router_rr_below_minimum";
          record.riskStatus = "REJECTED";
          record.riskRejectionReason = "rr_below_minimum";
          record.rejectionDetail = `passed POI gate (confluence_score=${common.confluenceScore}) but failed Risk Router: RR=${finite(rr) ? rr.toFixed(3) : "n/a"} < min ${CRT_CONFIG.min_rr_ratio}; TP distance=${tpDistance.toFixed(5)} (entry ${entry} to crt50 ${common.crt50}); risk distance=${riskDistance.toFixed(5)}`;
        }
      } else if (trigger.status === "WAITING") {
        record.signalStatus = "WATCH";
        record.rejectionReason = trigger.reason;
        record.riskStatus = "PENDING";
        record.riskRejectionReason = null;
      } else {
        record.signalStatus = "REJECTED";
        record.rejectionReason = trigger.reason;
        record.riskStatus = "REJECTED";
        record.riskRejectionReason = null;
      }
      if (record.signalStatus === "WATCH" && decisionEpoch >= record.watchExpiresAtEpoch) {
        record.signalStatus = "REJECTED";
        record.rejectionReason = "watch_expired";
        record.riskStatus = "REJECTED";
        record.status = "EXPIRED";
      }
      output.push(record);
    }
  }
  if (!routeResults) return output;
  return fractalRouter ? fractalRouter.route(output, decisionEpoch) : routeFractals(output);
}

export function routeFractals(records, toleranceMultiplier = CRT_CONFIG.fractal_router.boundary_tolerance_multiplier) {
  if (!finite(toleranceMultiplier) || toleranceMultiplier <= 0) throw new RangeError("boundary tolerance must be positive.");
  const groups = new Map();
  records.forEach((record, index) => {
    const key = record.instrument ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, index });
  });
  if (groups.size > 1) {
    const result = Array(records.length);
    for (const rows of groups.values()) {
      const routed = routeFractals(rows.map((row) => row.record), toleranceMultiplier);
      routed.forEach((record, i) => { result[rows[i].index] = record; });
    }
    return result;
  }
  const active = records.filter((r) => ["QUALIFIED", "WATCH", "PENDING"].includes(r.signalStatus));
  const candidates = active.filter((r) => r.signalStatus === "QUALIFIED");
  if (!active.length) return records;
  let conflict = false;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (active[i].sweepSide !== active[j].sweepSide) conflict = true;
    }
  }
  if (conflict) {
    return records.map((r) => ["QUALIFIED", "WATCH", "PENDING"].includes(r.signalStatus)
      ? { ...r, signalStatus: "REJECTED", rejectionReason: "htf_directional_conflict", riskStatus: "REJECTED", fractalScanStatus: "LOCKOUT", assetLockoutActive: true, lockoutReason: "htf_directional_conflict" }
      : r);
  }
  if (!candidates.length) return records;
  candidates.sort((a, b) => a.priorityRank - b.priorityRank || a.crtId.localeCompare(b.crtId));
  const winner = candidates[0];
  return records.map((r) => {
    if (r.signalStatus !== "QUALIFIED") return r;
    if (r.crtId === winner.crtId) return { ...r, fractalScanStatus: candidates.length > 1 ? "ALIGNED" : "ISOLATED", fractalAlignmentScore: candidates.length, routedByScanner: true, riskStatus: "PENDING" };
    const boundaryDiff = Math.abs(winner.sweepSide === "LOW" ? winner.rangeLow - r.rangeLow : winner.rangeHigh - r.rangeHigh);
    const tolerance = Math.max(winner.epsilonUsed, r.epsilonUsed) * toleranceMultiplier;
    const samePool = winner.sweepSide === r.sweepSide && boundaryDiff <= tolerance;
    return {
      ...r,
      signalStatus: samePool ? "REJECTED" : "PENDING",
      rejectionReason: samePool ? "absorbed_by_higher_timeframe_sweep" : "pending_higher_priority_setup",
      fractalScanStatus: "ALIGNED",
      fractalAlignmentScore: candidates.length,
      routedByScanner: false,
      riskStatus: samePool ? "REJECTED" : "PENDING",
      absorbedBoundaryDiff: samePool ? boundaryDiff : null,
      absorptionToleranceUsed: samePool ? tolerance : null,
      absorbedByCrtId: samePool ? winner.crtId : null,
    };
  });
}

export function createFractalRouter(toleranceMultiplier = CRT_CONFIG.fractal_router.boundary_tolerance_multiplier) {
  if (!finite(toleranceMultiplier) || toleranceMultiplier <= 0) throw new RangeError("boundary tolerance must be positive.");
  const lockouts = new Map();
  return {
    route(records, decisionEpoch) {
      if (!finite(decisionEpoch)) throw new TypeError("router decision timestamp must be finite.");
      for (const [symbol, expiry] of lockouts) if (decisionEpoch >= expiry) lockouts.delete(symbol);
      const current = records.map((record) => {
        if (!["QUALIFIED", "WATCH", "PENDING"].includes(record.signalStatus) || !finite(record.watchExpiresAtEpoch) || decisionEpoch < record.watchExpiresAtEpoch) return record;
        return { ...record, signalStatus: "REJECTED", rejectionReason: "watch_expired", riskStatus: "REJECTED", status: "EXPIRED" };
      });
      const routed = routeFractals(current, toleranceMultiplier);
      const newLockouts = new Map();
      for (const record of routed) {
        if (record.assetLockoutActive && record.lockoutReason === "htf_directional_conflict") {
          const expiry = Number(record.watchExpiresAtEpoch);
          if (finite(expiry)) newLockouts.set(record.instrument, Math.max(newLockouts.get(record.instrument) || 0, expiry));
        }
      }
      for (const [symbol, expiry] of newLockouts) lockouts.set(symbol, Math.max(lockouts.get(symbol) || 0, expiry));
      return routed.map((record) => {
        const expiry = lockouts.get(record.instrument);
        if (!expiry || decisionEpoch >= expiry) return record;
        if (record.assetLockoutActive) return record;
        const canRoute = ["QUALIFIED", "WATCH", "PENDING"].includes(record.signalStatus);
        return {
          ...record,
          signalStatus: canRoute ? "REJECTED" : record.signalStatus,
          rejectionReason: canRoute ? "htf_directional_conflict" : record.rejectionReason,
          riskStatus: canRoute ? "REJECTED" : record.riskStatus,
          fractalScanStatus: "LOCKOUT",
          assetLockoutActive: true,
          lockoutReason: "htf_directional_conflict",
        };
      });
    },
    isLocked(symbol, decisionEpoch) {
      if (!finite(decisionEpoch)) throw new TypeError("router decision timestamp must be finite.");
      const expiry = lockouts.get(symbol);
      if (!expiry) return false;
      if (decisionEpoch >= expiry) { lockouts.delete(symbol); return false; }
      return true;
    },
    clearExpired(decisionEpoch) {
      if (!finite(decisionEpoch)) throw new TypeError("router decision timestamp must be finite.");
      for (const [symbol, expiry] of lockouts) if (decisionEpoch >= expiry) lockouts.delete(symbol);
    },
    clear() {
      lockouts.clear();
    },
  };
}

export function crtExecutionAllowed({ account, validationStatus = CRT_CONFIG.validation_status } = {}) {
  return CRT_CONFIG.demo_only === true
    && validationStatus === "passed"
    && account?.connected === true
    && account?.isReal === false;
}

export function createCrtTracker({ toleranceMultiplier = CRT_CONFIG.fractal_router.boundary_tolerance_multiplier, scanner = scanCrt } = {}) {
  if (typeof scanner !== "function") throw new TypeError("CRT tracker scanner must be a function.");
  const router = createFractalRouter(toleranceMultiplier), setups = new Map();
  const maxTrackedSetups = 32;
  const isActive = (record) => ["WATCH", "QUALIFIED", "PENDING"].includes(record.signalStatus);
  const expire = (record) => ({
    ...record,
    status: "EXPIRED",
    signalStatus: "REJECTED",
    rejectionReason: "watch_expired",
    riskStatus: "REJECTED",
  });
  const advance = (record, input) => {
    if (record.signalStatus !== "WATCH") return record;
    if (input.decisionEpoch >= record.watchExpiresAtEpoch) return expire(record);
    const trigger = findMss(input.ltfCandles, {
      c2CloseEpoch: record.c2CloseTimestamp,
      decisionEpoch: input.decisionEpoch,
      sweepSide: record.sweepSide,
      rangeHigh: record.rangeHigh,
      rangeLow: record.rangeLow,
      compressionThreshold: record.compressionThresholdUsed,
      maxCandles: CRT_CONFIG.trigger_lifetime.max_ltf_candles_for_trigger,
      timeframe: CRT_CONFIG.ltf_trigger_policy.primary_ltf,
    });
    const next = { ...record, ...trigger };
    if (trigger.status === "TRIGGERED") {
      next.direction = record.sweepSide === "LOW" ? "Rise" : "Fall";
      next.signalStatus = "QUALIFIED";
      next.rejectionReason = null;
      next.riskStatus = "PENDING";
    } else if (trigger.status === "WAITING" && input.decisionEpoch < record.watchExpiresAtEpoch) {
      next.signalStatus = "WATCH";
      next.rejectionReason = trigger.reason;
      next.riskStatus = "PENDING";
    } else {
      next.signalStatus = "REJECTED";
      next.rejectionReason = trigger.reason || "watch_expired";
      next.riskStatus = "REJECTED";
    }
    return next;
  };
  return {
    scan(input) {
      if (!input || !finite(input.decisionEpoch)) throw new TypeError("CRT tracker requires a finite decision timestamp.");
      const now = input.decisionEpoch;
      const fresh = scanner({ ...input, routeResults: false });
      if (!Array.isArray(fresh)) throw new TypeError("CRT scanner must return an array of records.");
      const byId = new Map(), seen = new Set();
      for (const record of fresh) {
        const previous = setups.get(record.crtId);
        seen.add(record.crtId);
        byId.set(record.crtId, previous?.signalStatus === "REJECTED" && previous.watchExpiresAtEpoch > now ? previous : record);
      }
      for (const [id, previous] of setups) {
        if (seen.has(id)) continue;
        if (finite(previous.watchExpiresAtEpoch) && now >= previous.watchExpiresAtEpoch) {
          byId.set(id, expire(previous));
        } else if (isActive(previous)) {
          byId.set(id, advance(previous, input));
        }
      }

      const routed = router.route([...byId.values()], now), transitions = [], trackedRecords = [];
      for (const record of routed) {
        const previous = setups.get(record.crtId);
        const changed = !previous
          ? true
          : previous.signalStatus !== record.signalStatus || previous.rejectionReason !== record.rejectionReason;
        const event = changed && (previous || finite(record.watchExpiresAtEpoch)) ? {
          crtId: record.crtId,
          instrument: record.instrument,
          atEpoch: now,
          from: previous?.signalStatus ?? null,
          to: record.signalStatus,
          reason: record.rejectionReason || record.reason || null,
        } : null;
        const stateTransitions = [...(previous?.stateTransitions || []), ...(event ? [event] : [])].slice(-20);
        const tracked = { ...record, stateTransitions };
        trackedRecords.push(tracked);
        if (finite(record.watchExpiresAtEpoch) && record.watchExpiresAtEpoch > now) {
          setups.set(record.crtId, tracked);
          if (setups.size > maxTrackedSetups) throw new RangeError(`CRT tracker exceeded ${maxTrackedSetups} active or recent setup records.`);
        }
        else setups.delete(record.crtId);
        if (event) transitions.push(event);
      }
      for (const [id, record] of setups) if (!finite(record.watchExpiresAtEpoch) || record.watchExpiresAtEpoch <= now) setups.delete(id);
      return {
        records: trackedRecords,
        transitions,
        rejections: trackedRecords.filter((record) => record.signalStatus === "REJECTED"),
      };
    },
    activeSetups() {
      return [...setups.values()].filter(isActive);
    },
    clear() {
      setups.clear();
      router.clear();
    },
  };
}

export const CRT_VARIANTS = Object.freeze({
  modeA: CRT_CONFIG.parent_timeframes.map((timeframe) => `CRT_MODE_A_${timeframe}`),
  modeB: ["CRT_MODE_B"],
  enabledTriggers: Object.keys(CRT_CONFIG.trigger_policy).filter((name) => CRT_CONFIG.trigger_policy[name]),
});
