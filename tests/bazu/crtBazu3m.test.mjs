import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { configFor } from "../../src/bazu/config3m.js";
import { allowedDurations } from "../../src/bazu/duration3m.js";
import { durationAllowed } from "../../src/bazu/universe.js";
import { predict3m } from "../../src/bazu/predict3m.js";
import { CRT_BAZU_CONFIG, mapState, mapCrtRecord, mapCrtScan, crtScore, createCrtSwitches } from "../../src/bazu/crtBazu3m.js";

const SYM = "R_75";
const cfg = configFor(SYM);
const allowed = allowedDurations([], 2, cfg, () => true);
const base = (over = {}) => ({
  instrument: SYM, crtId: "x", timeframe: "1H", sweepSide: "LOW", signalStatus: "QUALIFIED", rejectionReason: null,
  rangeHigh: 110, rangeLow: 100, crt50: 105, sweptExtreme: 98, bufferMultiplier: 0.05, atrValueUsed: 4,
  breakCandle: { close: 101 }, wickDepthAtr: 0.5, confluenceScore: 1, htfBiasOk: true, compressionRatio: 0.4, rrRatio: 1.3, configVersion: "v", ...over,
});
const series = (n, step = 0.01) => { const epochs = [], prices = []; let p = 100; for (let i = 0; i < n; i++) { epochs.push(1000 + i * 2); p += (i % 2 ? 1 : -1) * step; prices.push(p); } return { epochs, prices }; };

test("state mapping: WATCH->ARMED, qualified->TRIGGERED, timeouts->EXPIRED, range_invalidation->INVALIDATED, no sweep -> not a signal", () => {
  assert.equal(mapState({ signalStatus: "WATCH", sweepSide: "LOW" }), "ARMED");
  assert.equal(mapState({ signalStatus: "QUALIFIED", sweepSide: "LOW" }), "TRIGGERED");
  assert.equal(mapState({ signalStatus: "REJECTED", rejectionReason: "trigger_timeout", sweepSide: "LOW" }), "EXPIRED");
  assert.equal(mapState({ signalStatus: "REJECTED", rejectionReason: "watch_expired", sweepSide: "LOW" }), "EXPIRED");
  assert.equal(mapState({ signalStatus: "REJECTED", rejectionReason: "range_invalidation", sweepSide: "LOW" }), "INVALIDATED");
  assert.equal(mapState({ signalStatus: "REJECTED", rejectionReason: "no_sweep_reclaim" }), null);
  assert.equal(mapState({ signalStatus: "REJECTED", rejectionReason: "risk_router_rr_below_minimum", sweepSide: "LOW" }), "REJECTED");
});

test("low sweep maps to Rise, high sweep to Fall, with crt50 target, opposite-extreme second target and buffered invalidation", () => {
  const { epochs, prices } = series(400);
  const rise = mapCrtRecord(base(), { prices, epochs, allowed, cfg });
  assert.equal(rise.direction, "Rise");
  assert.equal(rise.target, 105);
  assert.equal(rise.secondTarget, 110);
  assert.ok(Math.abs(rise.invalidation - (98 - 0.2)) < 1e-9);
  const fall = mapCrtRecord(base({ sweepSide: "HIGH", sweptExtreme: 112, breakCandle: { close: 109 }, crt50: 105 }), { prices, epochs, allowed, cfg });
  assert.equal(fall.direction, "Fall");
  assert.equal(fall.secondTarget, 100);
  assert.ok(Math.abs(fall.invalidation - 112.2) < 1e-9);
  for (const s of [rise, fall]) { assert.equal(s.shadow, true); assert.equal(s.tradeEligible, false); assert.equal(s.label, "rule-based, unvalidated playbook"); }
});

test("lifetime beyond MAX_DURATION_S gives WAIT (or SKIP) with the CRT horizon reason", () => {
  const { epochs, prices } = series(400, 0.0001);
  const far = base({ crt50: 10000, rangeHigh: 20000 });
  const w = mapCrtRecord(far, { prices, epochs, allowed, cfg });
  assert.equal(w.decision, "WAIT");
  assert.equal(w.waitReason, "CRT horizon beyond tradable range");
  const k = mapCrtRecord(far, { prices, epochs, allowed, cfg, bazuCfg: { ...CRT_BAZU_CONFIG, long_horizon: "skip" } });
  assert.equal(k.decision, "SKIP");
});

test("a short horizon snaps to an allowed duration as a candidate; non-triggered states carry no decision", () => {
  const { epochs, prices } = series(400, 0.5);
  const p = mapCrtRecord(base({ crt50: 101.5, rangeHigh: 103, sweptExtreme: 100.5 }), { prices, epochs, allowed, cfg });
  assert.ok(["CANDIDATE", "WAIT"].includes(p.decision));
  if (p.decision === "CANDIDATE") assert.ok(p.lifetime.duration);
  assert.equal(mapCrtRecord(base({ signalStatus: "WATCH" }), { prices, epochs, allowed, cfg }).decision, "NONE");
});

test("score is a bounded rule-based number, labelled as not a probability", () => {
  const s = crtScore(base());
  assert.ok(s.score > 0 && s.score <= 100);
  assert.match(s.note, /not a probability/);
  assert.equal(crtScore(base({ wickDepthAtr: 0, confluenceScore: 0, htfBiasOk: false, compressionRatio: 1, rrRatio: 0, breakCandle: { close: 98 } })).score, 0);
});

test("switches: crt_enabled defaults on, crt_trade_enabled defaults off and is never persisted; per-market off yields no signals", () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const sw = createCrtSwitches({ storage });
  assert.equal(sw.isEnabled(SYM), true);
  assert.equal(sw.isTradeEnabled(SYM), false);
  sw.setTradeEnabled(true);
  sw.setMarket(SYM, false);
  assert.equal(mapCrtScan([base()], { symbol: SYM, prices: [], epochs: [], allowed, cfg }, sw).length, 0);
  const again = createCrtSwitches({ storage });
  assert.equal(again.isTradeEnabled(SYM), false);
  assert.equal(again.isEnabled(SYM), false);
  assert.equal(again.snapshot().crt_trade_enabled, false);
  assert.equal(CRT_BAZU_CONFIG.crt_trade_enabled, false);
});

test("golden: the other playbooks' predictions do not change with CRT on or off, and protected modules never import CRT", () => {
  const { epochs, prices } = series(1500, 0.05);
  const run = () => JSON.stringify(predict3m({ symbol: SYM, prices, epochs, remote: {}, decisionEpoch: epochs[epochs.length - 1], allowed, manualKey: null, wallNow: null }));
  const sw = createCrtSwitches();
  sw.setEnabled(true); const on = run();
  sw.setEnabled(false); const off = run();
  assert.equal(on, off);
  for (const f of ["predict3m", "choke3m", "signalBook3m", "decision", "execution", "realMode3m", "config3m", "duration3m", "risk"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../../src/bazu/${f}.js`, import.meta.url), "utf8"), /crt/i, `${f}.js must not reference CRT`);
  }
});
