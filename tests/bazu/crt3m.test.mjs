import test from "node:test";
import assert from "node:assert/strict";
import { CRT_CONFIG } from "../../src/bazu/crtConfig3m.js";
import {
  atrRatio,
  buildCrtFrames,
  closedAsOf,
  crtExecutionAllowed,
  createCrtTracker,
  createFractalRouter,
  findMss,
  htfBiasAllows,
  routeFractals,
  scorePoiConfluence,
  wilderAtr,
} from "../../src/bazu/crt3m.js";

const candle = (epoch, open, high, low, close) => ({ epoch, open, high, low, close });

test("Wilder ATR seeds with the initial true-range mean and then smooths incrementally", () => {
  const bars = [
    candle(0, 10, 12, 8, 11),
    candle(1, 11, 13, 10, 12),
    candle(2, 12, 15, 11, 14),
    candle(3, 14, 16, 13, 15),
  ];
  assert.deepEqual(wilderAtr(bars, 2), [null, 3.5, 3.75, 3.375]);
  assert.deepEqual(atrRatio(bars, 2, 2), { atr: 3.375, atrRatio: 3.375 / 3.5625 });
});

test("closed candle selection excludes a forming candle and all future candles", () => {
  const bars = [candle(0, 1, 2, 0, 1), candle(300, 1, 3, 1, 2), candle(600, 2, 4, 2, 3)];
  assert.deepEqual(closedAsOf(bars, 300, 600), bars.slice(0, 2));
  assert.deepEqual(closedAsOf(bars, 300, 900), bars);
  assert.throws(() => closedAsOf(bars, 300, 600, 601), /future-data/);
});

test("parent aggregation excludes incomplete and discontinuous hourly groups", () => {
  const complete = Array.from({ length: 8 }, (_, i) => candle(i * 3600, 10 + i, 12 + i, 8 + i, 11 + i));
  const frames = buildCrtFrames(complete, 8 * 3600);
  assert.equal(frames["8H"].length, 1);
  assert.equal(frames["8H"][0].open, 10);
  assert.equal(frames["8H"][0].close, 18);
  assert.equal(frames["1D"].length, 0);

  const gap = complete.filter((_, i) => i !== 3);
  assert.equal(buildCrtFrames(gap, 8 * 3600)["8H"].length, 0);
});

function mssFixture({ compressed = true, invalidate = false } = {}) {
  const bars = Array.from({ length: 9 }, (_, i) => candle(i * 300, 100, 103, 97, 100));
  bars[5] = candle(1500, 101, 110, 100, 105);
  bars[6] = candle(1800, 102, 106, 100, 103);
  bars[7] = compressed ? candle(2100, 102, 104, 100, 103) : candle(2100, 102, 106, 100, 103);
  bars[8] = invalidate ? candle(2400, 100, 102, 88, 89) : candle(2400, 108, 112, 107, 111);
  return bars;
}

test("MSS waits for a confirmed pivot, requires compression, and triggers on a close beyond the swing", () => {
  const result = findMss(mssFixture(), {
    c2CloseEpoch: 1500, decisionEpoch: 2700, sweepSide: "LOW", rangeHigh: 120, rangeLow: 90,
  });
  assert.equal(result.status, "TRIGGERED");
  assert.equal(result.triggerType, "MSS");
  assert.equal(result.c3Timestamp, 2700);
  assert.equal(result.swingLevel, 110);
  assert.equal(result.compressionRatio, 0.4);
});

test("MSS compression failure and close outside the swept range reject the setup", () => {
  const failedCompression = findMss(mssFixture({ compressed: false }), {
    c2CloseEpoch: 1500, decisionEpoch: 2700, sweepSide: "LOW", rangeHigh: 120, rangeLow: 90,
  });
  assert.equal(failedCompression.status, "INVALID");
  assert.equal(failedCompression.reason, "compression_failed");
  assert.equal(failedCompression.R_t5, 6);
  assert.equal(failedCompression.R_pivot, 10);
  assert.match(failedCompression.rejectionDetail, /R_t5=6 R_pivot=10/);
  assert.equal(CRT_CONFIG.compression_gate.default_threshold, 0.85);
  assert.equal(CRT_CONFIG.min_rr_ratio, 0.5);
  assert.equal(CRT_CONFIG.shadow_collection_only, true);
  assert.equal(CRT_CONFIG.live_execution_enabled, false);
  assert.equal(CRT_CONFIG.crt_order_routing, "disabled");

  const invalidated = findMss(mssFixture({ invalidate: true }), {
    c2CloseEpoch: 1500, decisionEpoch: 2700, sweepSide: "LOW", rangeHigh: 120, rangeLow: 90,
  });
  assert.equal(invalidated.status, "INVALID");
  assert.equal(invalidated.reason, "range_invalidation");
});

test("MSS expires after five completed LTF candles and ignores future trigger candles", () => {
  const flat = Array.from({ length: 10 }, (_, i) => candle(i * 300, 100, 103, 97, 100));
  const expired = findMss(flat, {
    c2CloseEpoch: 1500, decisionEpoch: 3000, sweepSide: "LOW", rangeHigh: 120, rangeLow: 90,
  });
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.triggerCandlesWaited, 5);

  const bars = mssFixture();
  const beforeTriggerClose = findMss(bars, {
    c2CloseEpoch: 1500, decisionEpoch: 2699, sweepSide: "LOW", rangeHigh: 120, rangeLow: 90,
  });
  assert.notEqual(beforeTriggerClose.status, "TRIGGERED");
});

test("fractal routing absorbs same-pool lower-priority setups and leaves other pools pending", () => {
  const base = { instrument: "R_100", sweepSide: "LOW", signalStatus: "QUALIFIED", riskStatus: "PENDING", epsilonUsed: 0.1 };
  const routed = routeFractals([
    { ...base, crtId: "high", priorityRank: 1, rangeLow: 100 },
    { ...base, crtId: "same-pool", priorityRank: 2, rangeLow: 100.1 },
    { ...base, crtId: "other-pool", priorityRank: 3, rangeLow: 102 },
  ]);
  assert.equal(routed.find((r) => r.crtId === "high").routedByScanner, true);
  assert.equal(routed.find((r) => r.crtId === "same-pool").rejectionReason, "absorbed_by_higher_timeframe_sweep");
  assert.equal(routed.find((r) => r.crtId === "other-pool").signalStatus, "PENDING");
});

test("POI confluence scores each qualifying prior-day/week level", () => {
  const score = scorePoiConfluence([
    { type: "PDL", level: 100, epoch: 1 },
    { type: "PWL", level: 100.1, epoch: 2 },
    { type: "unqualified", level: 103, epoch: 3 },
  ], 100.05, 1, 0.15);
  assert.equal(score.poiOk, true);
  assert.equal(score.confluenceScore, 2);
  assert.deepEqual(score.confluenceDetails.map((p) => p.type), ["PDL", "PWL"]);
});

test("opposing setups on different instruments do not cause a cross-market lockout", () => {
  const base = { signalStatus: "QUALIFIED", riskStatus: "PENDING", epsilonUsed: 0.1, priorityRank: 1 };
  const routed = routeFractals([
    { ...base, crtId: "a", instrument: "R_100", sweepSide: "LOW", rangeLow: 100 },
    { ...base, crtId: "b", instrument: "R_200", sweepSide: "HIGH", rangeHigh: 200 },
  ]);
  assert.ok(routed.every((r) => r.signalStatus === "QUALIFIED" && r.routedByScanner));
});

test("opposing active setups establish a per-instrument lockout through their WATCH expiry", () => {
  const router = createFractalRouter();
  const records = [
    { crtId: "long", instrument: "R_100", signalStatus: "WATCH", riskStatus: "PENDING", sweepSide: "LOW", watchExpiresAtEpoch: 1000 },
    { crtId: "short", instrument: "R_100", signalStatus: "WATCH", riskStatus: "PENDING", sweepSide: "HIGH", watchExpiresAtEpoch: 1200 },
  ];
  const conflict = router.route(records, 500);
  assert.ok(conflict.every((r) => r.assetLockoutActive));
  assert.equal(router.isLocked("R_100", 1199), true);
  assert.equal(router.isLocked("R_100", 1200), false);
});

test("expired WATCH records cannot recreate a lockout and CRT execution fails closed", () => {
  const router = createFractalRouter();
  const stale = [
    { crtId: "long", instrument: "R_100", signalStatus: "WATCH", riskStatus: "PENDING", sweepSide: "LOW", watchExpiresAtEpoch: 1000 },
    { crtId: "short", instrument: "R_100", signalStatus: "WATCH", riskStatus: "PENDING", sweepSide: "HIGH", watchExpiresAtEpoch: 1000 },
  ];
  assert.ok(router.route(stale, 1000).every((r) => r.status === "EXPIRED" && !r.assetLockoutActive));
  assert.equal(crtExecutionAllowed({ account: { connected: true, isReal: false }, validationStatus: "passed" }), true);
  assert.equal(crtExecutionAllowed({ account: { connected: true, isReal: false }, validationStatus: "not-run" }), false);
  assert.equal(crtExecutionAllowed({ account: { connected: true, isReal: true }, validationStatus: "passed" }), false);
  assert.equal(crtExecutionAllowed({ account: { connected: true }, validationStatus: "passed" }), false);
  assert.equal(crtExecutionAllowed({ account: { connected: false, isReal: false }, validationStatus: "passed" }), false);
});

test("CRT tracker retains WATCH setups and emits bounded, structured state transitions", () => {
  const tracker = createCrtTracker({ scanner: (input) => input.records || [] });
  const watch = {
    crtId: "R_100|CRT_MODE_A|1H|1",
    instrument: "R_100",
    signalStatus: "WATCH",
    rejectionReason: "waiting_for_ltf_data",
    riskStatus: "PENDING",
    sweepSide: "LOW",
    rangeHigh: 110,
    rangeLow: 90,
    c2CloseTimestamp: 0,
    watchExpiresAtEpoch: 100,
    compressionThresholdUsed: 0.5,
  };
  const first = tracker.scan({ decisionEpoch: 10, ltfCandles: [], records: [watch] });
  assert.equal(first.transitions[0].from, null);
  assert.equal(first.transitions[0].to, "WATCH");
  assert.equal(tracker.activeSetups().length, 1);

  const repeated = tracker.scan({ decisionEpoch: 20, ltfCandles: [], records: [watch] });
  assert.deepEqual(repeated.transitions, []);

  const expired = tracker.scan({ decisionEpoch: 100, ltfCandles: [], records: [] });
  assert.equal(expired.records[0].rejectionReason, "watch_expired");
  assert.equal(expired.transitions[0].from, "WATCH");
  assert.equal(expired.transitions[0].to, "REJECTED");
  assert.equal(tracker.activeSetups().length, 0);
});

test("demo-validation RR minimum is 0.5 and must be reverted to 1.0 before live execution", () => {
  assert.equal(CRT_CONFIG.min_rr_ratio, 0.5);
  assert.equal(CRT_CONFIG.validation_status, "not-run");
});

test("loosened filters: POI limit 1.0 ATR, minimum confluence 1, non-strict HTF alignment", () => {
  assert.equal(CRT_CONFIG.poi_proximity.default_value, 1.0);
  assert.equal(CRT_CONFIG.min_confluence_score, 1);
  assert.equal(CRT_CONFIG.strict_htf_alignment, false);
  assert.equal(scorePoiConfluence([{ type: "PDL", level: 100, epoch: 1 }], 100.9, 1, 1.0).poiOk, true);
  assert.equal(scorePoiConfluence([{ type: "PDL", level: 100, epoch: 1 }], 101.1, 1, 1.0).poiOk, false);
  assert.equal(htfBiasAllows("LOW", "bullish", "neutral", false), true);
  assert.equal(htfBiasAllows("LOW", "bullish", "bullish", false), true);
  assert.equal(htfBiasAllows("LOW", "bullish", "bearish", false), false);
  assert.equal(htfBiasAllows("LOW", "neutral", "bullish", false), false);
  assert.equal(htfBiasAllows("LOW", "bearish", "neutral", false), false);
  assert.equal(htfBiasAllows("LOW", "bullish", "neutral", true), false);
});

test("CRT shadow analysis is enabled but execution remains fail-closed until offline validation passes", () => {
  assert.equal(CRT_CONFIG.strategy_enabled, true);
  assert.equal(CRT_CONFIG.demo_only, true);
  assert.equal(CRT_CONFIG.shadow_collection_only, true);
  assert.equal(CRT_CONFIG.report_sample_size, 10);
  assert.equal(CRT_CONFIG.offline_validation_required, true);
  assert.equal(CRT_CONFIG.validation_status, "not-run");
  assert.equal(crtExecutionAllowed({ account: { connected: true, isReal: false } }), false);
  assert.equal(crtExecutionAllowed({ account: { connected: true, isReal: false }, validationStatus: "passed" }), true);
});
