import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CRT_LTF_CONFIG, aggregateM30, scanCrtLtf, scanCrtLtfVariant } from "../../src/bazu/crtLtf3m.js";
import { CRT_CONFIG } from "../../src/bazu/crtConfig3m.js";
import { scanCrt } from "../../src/bazu/crt3m.js";
import { mapCrtScan, createCrtSwitches } from "../../src/bazu/crtBazu3m.js";
import { configFor } from "../../src/bazu/config3m.js";
import { allowedDurations } from "../../src/bazu/duration3m.js";

const T0 = 3 * 86400 + 2600 * 604800; // a Monday 00:00 UTC
const D = T0 + 240 * 3600;
const c = (epoch, open, high, low, close) => ({ epoch, open, high, low, close });
const wideCfg = { ...CRT_LTF_CONFIG, poi_proximity: 1000 };

function h1Series() {
  const out = [];
  for (let i = 0; i < 240; i++) {
    const mid = 100 + 0.02 * i + 1.5 * Math.sin((i * 2 * Math.PI) / 40);
    out.push(c(T0 + i * 3600, mid - 0.1, mid + 0.3, mid - 0.3, mid + 0.1));
  }
  return out;
}
function parentSeries(secs, count, endEpoch, c1, c2) {
  const out = [];
  for (let i = 0; i < count - 2; i++) {
    const p = 100 + (i % 2 ? 0.05 : -0.05);
    out.push(c(endEpoch - (count - i) * secs, p, p + 0.1, p - 0.1, p + (i % 2 ? -0.05 : 0.05)));
  }
  out.push(c(endEpoch - 2 * secs, ...c1), c(endEpoch - secs, ...c2));
  return out;
}
const C1 = [100.2, 100.5, 99.9, 100.1];
const C2 = [100.0, 100.2, 99.5, 99.95];
function m1Trigger(startEpoch, extra = true) {
  const rows = [[99.92, 99.93, 99.91, 99.92], [99.92, 99.94, 99.91, 99.93], [99.93, 99.97, 99.92, 99.95], [99.94, 99.94, 99.91, 99.92], [99.92, 99.93, 99.91, 99.92]];
  if (extra) rows.push([99.95, 100.01, 99.93, 100.0]);
  const pre = [0, 1, 2].map((i) => c(startEpoch - (3 - i) * 60, 99.9, 99.9 + 0.01 * i, 99.88, 99.9));
  return [...pre, ...rows.map((r, i) => c(startEpoch + i * 60, ...r))];
}
const fixture = (extra = true) => ({ H1: h1Series(), M1: m1Trigger(D, extra), M5: parentSeries(300, 60, D, C1, C2) });
const scanM5 = (candles, decisionEpoch, cfg = wideCfg) => scanCrtLtfVariant({ symbol: "R_75", variant: "M5", candles, decisionEpoch, minTick: 0.01, cfg });

test("M30 aggregation keeps only complete, aligned, contiguous pairs and nothing that has not closed", () => {
  const m15 = [c(0, 1, 2, 0, 1), c(900, 1, 3, 1, 2), c(1800, 2, 4, 1, 3), c(3600, 3, 5, 2, 4), c(4500, 4, 6, 3, 5)];
  const full = aggregateM30(m15, 100000);
  assert.deepEqual(full.map((x) => x.epoch), [0, 3600]);
  assert.equal(full[0].high, 3);
  assert.equal(full[0].close, 2);
  assert.deepEqual(aggregateM30(m15, 1700).map((x) => x.epoch), [], "second half not closed yet");
  assert.deepEqual(aggregateM30(m15.slice(1), 100000).map((x) => x.epoch), [3600], "misaligned or gapped pairs are dropped");
});

test("an M5 sweep with an M1 MSS triggers a Rise record with its own config version", () => {
  const [r] = scanM5(fixture(), D + 600);
  assert.equal(r.signalStatus, "QUALIFIED", JSON.stringify({ s: r.signalStatus, why: r.rejectionReason, d: r.rejectionDetail }));
  assert.equal(r.direction, "Rise");
  assert.equal(r.configVersion, "crt-ltf-1");
  assert.equal(r.ltfTimeframe, "1m");
  assert.equal(r.triggerSecs, 60);
  assert.ok(r.rrRatio >= CRT_CONFIG.min_rr_ratio);
});

test("without the break candle the same sweep stays in WATCH", () => {
  const [r] = scanM5(fixture(false), D + 240);
  assert.equal(r.signalStatus, "WATCH");
  const [late] = scanM5(fixture(false), D + 600);
  assert.equal(late.rejectionReason, "watch_expired", "the watch ends when the next parent candle closes");
});

test("point in time: candles after the decision epoch never change the result", () => {
  const f = fixture();
  const at = D + 600;
  const clean = JSON.stringify(scanM5(f, at));
  const future = { ...f, M1: [...f.M1, c(at, 90, 200, 1, 150), c(at + 60, 90, 200, 1, 150)], M5: [...f.M5, c(at, 1, 500, 0, 250)] };
  assert.equal(JSON.stringify(scanM5(future, at)), clean);
  const early = scanM5(f, D + 300);
  assert.notEqual(early[0].signalStatus, "QUALIFIED");
});

test("per-variant switch off removes that variant's records; crt_trade_enabled stays off for every variant", () => {
  const f = fixture();
  const base = { symbol: "R_75", candles: f, decisionEpoch: D + 600, minTick: 0.01, cfg: wideCfg };
  assert.ok(scanCrtLtf({ ...base, isVariantEnabled: () => true }).some((r) => r.playbookVariant === "M5"));
  assert.equal(scanCrtLtf({ ...base, isVariantEnabled: (v) => v !== "M5" }).some((r) => r.playbookVariant === "M5"), false);
  const sw = createCrtSwitches();
  for (const v of Object.keys(CRT_LTF_CONFIG.variants)) { assert.equal(sw.isVariantEnabled(v), true); assert.equal(sw.isVariantTradeEnabled(v), false); assert.equal(CRT_LTF_CONFIG.variants[v].trade_enabled, false); }
  sw.setTradeEnabled(true);
  assert.equal(sw.isVariantTradeEnabled("M5"), false, "variant trade needs its own explicit opt-in");
  sw.setVariant("M5", false);
  assert.equal(sw.isVariantEnabled("M5"), false);
  assert.equal(sw.snapshot().variants.M5.enabled, false);
});

test("mapped variant signal uses its own trigger length for the lifetime estimate and carries the variant name", () => {
  const f = fixture();
  const cfg = configFor("R_75");
  const allowed = allowedDurations([], 2, cfg, () => true);
  const recs = scanM5(f, D + 600);
  const [s] = mapCrtScan(recs, { symbol: "R_75", prices: [], epochs: [], allowed, cfg }, createCrtSwitches());
  assert.equal(s.variant, "M5");
  assert.equal(s.parentTimeframe, "M5");
  assert.equal(s.shadow, true);
  assert.equal(s.tradeEligible, false);
  assert.equal(s.lifetime.estimators.E5, 3 * 60);
});

test("golden: the existing H1+ scanner output is identical to its pre-change behaviour inputs and ignores the variants", () => {
  const h1 = h1Series(), m5 = parentSeries(300, 60, D, C1, C2);
  const args = { symbol: "R_75", h1Candles: h1, ltfCandles: m5, decisionEpoch: D + 600, minTick: 0.01 };
  const a = JSON.stringify(scanCrt(args));
  scanCrtLtf({ symbol: "R_75", candles: { H1: h1, M5: m5, M1: [] }, decisionEpoch: D + 600, minTick: 0.01 });
  assert.equal(JSON.stringify(scanCrt(args)), a);
  assert.equal(CRT_CONFIG.config_version, "crt-3m-3");
  assert.equal(CRT_CONFIG.min_rr_ratio, 0.2);
});

test("protected pipeline modules do not reference the CRT variants", () => {
  for (const f of ["predict3m", "choke3m", "signalBook3m", "decision", "execution", "realMode3m", "config3m", "duration3m", "risk"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../../src/bazu/${f}.js`, import.meta.url), "utf8"), /crt/i, f);
  }
});
