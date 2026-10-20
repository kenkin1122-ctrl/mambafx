import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crtTradeGate, CRT_TRADE_CONFIG } from "../../src/bazu/crtTrade3m.js";
import { createCrtSwitches } from "../../src/bazu/crtBazu3m.js";

const pkg = (o = {}) => ({ crtId: "c1", symbol: "R_75", variant: "H1+", state: "TRIGGERED", decision: "CANDIDATE", lifetime: { duration: "5m" }, triggeredAt: 1000, direction: "Rise", entry: 100, target: 110, invalidation: 95, score: 70, ...o });
const sw = (trade = true, variant = false) => {
  const s = createCrtSwitches();
  if (trade) s.setTradeEnabled(true);
  if (variant) s.setVariantTrade("M5", true);
  return s;
};
const ctx = (o = {}) => ({ pkg: pkg(), nowEpoch: 1030, lastPrice: 102, account: { connected: true, isReal: false }, running: true, switches: sw(), openCrtTrades: [], lastOrderEpoch: {}, tradedIds: new Set(), ...o });

test("happy path passes only with every switch on and a demo account", () => {
  assert.equal(crtTradeGate(ctx()).ok, true);
});
test("default switches keep trading off", () => {
  const r = crtTradeGate(ctx({ switches: createCrtSwitches() }));
  assert.equal(r.ok, false); assert.match(r.reason, /crt_trade_enabled/);
});
test("real, unknown and disconnected accounts refuse", () => {
  assert.match(crtTradeGate(ctx({ account: { connected: true, isReal: true } })).reason, /demo-only/);
  assert.match(crtTradeGate(ctx({ account: { connected: true } })).reason, /demo-only/);
  assert.match(crtTradeGate(ctx({ account: { connected: false } })).reason, /connected/);
});
test("engine not running refuses", () => assert.match(crtTradeGate(ctx({ running: false })).reason, /not started/));
test("variants need their own opt-in", () => {
  const p = pkg({ variant: "M5" });
  assert.match(crtTradeGate(ctx({ pkg: p })).reason, /M5 variant/);
  assert.equal(crtTradeGate(ctx({ pkg: p, switches: sw(true, true) })).ok, true);
});
test("non-triggered, WAIT, stale and future signals refuse", () => {
  assert.match(crtTradeGate(ctx({ pkg: pkg({ state: "ARMED" }) })).reason, /not TRIGGERED/);
  assert.match(crtTradeGate(ctx({ pkg: pkg({ decision: "WAIT", lifetime: {} }) })).reason, /decision/);
  assert.match(crtTradeGate(ctx({ nowEpoch: 1000 + CRT_TRADE_CONFIG.max_signal_age_s + 1 })).reason, /old/);
  assert.match(crtTradeGate(ctx({ nowEpoch: 900 })).reason, /old/);
});
test("invalidation, target reached and missing price refuse", () => {
  assert.match(crtTradeGate(ctx({ lastPrice: 94 })).reason, /invalidation/);
  assert.match(crtTradeGate(ctx({ lastPrice: 111 })).reason, /target/);
  assert.match(crtTradeGate(ctx({ lastPrice: NaN })).reason, /price/);
  const fall = pkg({ direction: "Fall", target: 90, invalidation: 105 });
  assert.match(crtTradeGate(ctx({ pkg: fall, lastPrice: 106 })).reason, /invalidation/);
  assert.equal(crtTradeGate(ctx({ pkg: fall, lastPrice: 98 })).ok, true);
});
test("dedupe, caps and cooldown refuse", () => {
  assert.match(crtTradeGate(ctx({ tradedIds: new Set(["c1"]) })).reason, /already traded/);
  assert.match(crtTradeGate(ctx({ openCrtTrades: [{ market: "R_75" }] })).reason, /already open/);
  assert.match(crtTradeGate(ctx({ openCrtTrades: [{ market: "R_10" }, { market: "R_50" }] })).reason, /cap/);
  assert.match(crtTradeGate(ctx({ lastOrderEpoch: { R_75: 900 } })).reason, /cooldown/);
});
test("min-score guard is off by default and works when set", () => {
  assert.equal(CRT_TRADE_CONFIG.min_score, 0);
  assert.match(crtTradeGate(ctx({ cfg: { ...CRT_TRADE_CONFIG, min_score: 90 } })).reason, /guard/);
});
test("trade switches are never persisted and default off", () => {
  const s = createCrtSwitches();
  assert.equal(s.snapshot().crt_trade_enabled, false);
  assert.equal(s.snapshot().variants.M5.trade, false);
});
test("golden: protected modules contain no CRT code and the gate never buys", () => {
  for (const f of ["predict3m", "choke3m", "signalBook3m", "decision", "execution", "realMode3m", "config3m", "duration3m", "risk"]) {
    assert.doesNotMatch(readFileSync(new URL(`../../src/bazu/${f}.js`, import.meta.url), "utf8"), /crt/i, f);
  }
  assert.doesNotMatch(readFileSync(new URL("../../src/bazu/crtTrade3m.js", import.meta.url), "utf8"), /buyRiseFall|import /);
});

test("live checklist follows state and never changes switches", async () => {
  const { crtChecklist } = await import("../../src/bazu/crtTrade3m.js");
  const s = createCrtSwitches();
  let c = crtChecklist({ switches: s, account: { connected: false }, running: false });
  assert.equal(c.next, "demo"); assert.equal(c.complete, false);
  c = crtChecklist({ switches: s, account: { connected: true, isReal: true }, running: true });
  assert.equal(c.steps.find((x) => x.id === "demo").done, false);
  c = crtChecklist({ switches: s, account: { connected: true, isReal: false }, running: true, signalCount: 1 });
  assert.equal(c.next, "trade_on");
  assert.equal(s.snapshot().crt_trade_enabled, false);
  s.setTradeEnabled(true);
  c = crtChecklist({ switches: s, account: { connected: true, isReal: false }, running: true, signalCount: 1, tradeLog: [{ ok: true }], executedCrtTrades: 1 });
  assert.equal(c.complete, true);
});