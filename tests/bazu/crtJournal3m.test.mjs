import test from "node:test";
import assert from "node:assert/strict";
import { buildCrtBaseRateReport, createCrtJournal, runCrtLookaheadTest } from "../../src/bazu/crtJournal3m.js";
import { installFakeIndexedDB } from "../support/fakeIndexedDB.js";

function signal(crtId, overrides = {}) {
  return {
    crtId,
    status: "TRIGGERED",
    reason: null,
    signalStatus: "QUALIFIED",
    rejectionReason: null,
    direction: "Rise",
    c1Timestamp: 100,
    c2Timestamp: 200,
    c2CloseTimestamp: 300,
    c3Timestamp: 1000,
    rangeHigh: 12,
    rangeLow: 8,
    sweepSide: "LOW",
    epsilonUsed: 0.1,
    atr14Wilder: 1,
    atrRatio: 1,
    poi: { type: "PDL", level: 8 },
    compressionRatio: 0.4,
    swingLevel: 11,
    triggerCandlesWaited: 2,
    instrument: "R_100",
    routedByScanner: true,
    breakCandle: { close: 10 },
    auditInput: {
      decisionEpoch: 1000,
      h1Candles: [{ epoch: 0, open: 10, high: 12, low: 8, close: 11 }],
      ltfCandles: [{ epoch: 900, open: 9, high: 11, low: 8, close: 10 }],
    },
    ...overrides,
  };
}

test("journal enforces the sample cap, deduplicates signals, and persists across reopen", async () => {
  const { indexedDB, teardown } = installFakeIndexedDB();
  const first = createCrtJournal({ idb: indexedDB, sampleSize: 2 });
  try {
    await first.ready;
    const added = await first.addQualified(
      [signal("a"), signal("b"), signal("c"), signal("a", { direction: "Fall" })],
      { decisionEpoch: 1000, h1Candles: [], ltfCandles: [] },
    );
    assert.deepEqual(added.map((record) => record.crtId), ["a", "b"]);
    assert.deepEqual((await first.all()).map((record) => record.crtId), ["a", "b"]);
    first.close();

    const reopened = createCrtJournal({ idb: indexedDB, sampleSize: 2 });
    try {
      assert.deepEqual((await reopened.all()).map((record) => record.crtId), ["a", "b"]);
    } finally {
      reopened.close();
    }
  } finally {
    first.close();
    teardown();
  }
});

test("outcome resolver uses the exact five-minute close and reports wins and ties separately", async () => {
  const { indexedDB, teardown } = installFakeIndexedDB();
  const journal = createCrtJournal({ idb: indexedDB, sampleSize: 3 });
  try {
    await journal.ready;
    await journal.addQualified([
      signal("rise"),
      signal("fall", { direction: "Fall", breakCandle: { close: 10 } }),
      signal("tie", { direction: "Fall", breakCandle: { close: 11 } }),
    ], { symbol: "R_100", decisionEpoch: 1000, minTick: 0.01, h1Candles: [], ltfCandles: [] });
    const resolved = await journal.resolveOutcomes("R_100", [
      { epoch: 1000, open: 10, high: 11, low: 9, close: 10 },
    ], 1300);
    assert.equal(resolved.filter((record) => record.outcome.result === "win").length, 1);
    assert.equal(resolved.filter((record) => record.outcome.result === "tie").length, 2);

    const report = await journal.reports();
    assert.equal(report.baseRate.status, "READY");
    assert.equal(report.baseRate.signalsLogged, 3);
    assert.equal(report.baseRate.outcomesResolved, 3);
    assert.equal(report.baseRate.wins, 1);
    assert.equal(report.baseRate.losses, 0);
    assert.equal(report.baseRate.ties, 2);
    assert.equal(report.baseRate.hitRate, 1 / 3);
    assert.equal(report.lookahead.status, "FAIL");
  } finally {
    journal.close();
    teardown();
  }
});

test("base-rate report separates ties, unresolved outcomes, and sample readiness", () => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    instrument: index % 2 ? "R_100" : "R_200",
    direction: "Rise",
    outcome: index < 6
      ? { status: "resolved", result: "win" }
      : index < 8
        ? { status: "resolved", result: "tie" }
        : { status: "pending" },
  }));
  const report = buildCrtBaseRateReport(records);
  assert.equal(report.status, "READY");
  assert.equal(report.signalsLogged, 10);
  assert.equal(report.outcomesResolved, 8);
  assert.equal(report.outcomesPending, 2);
  assert.equal(report.wins, 6);
  assert.equal(report.losses, 0);
  assert.equal(report.ties, 2);
  assert.equal(report.hitRate, 0.75);
  assert.equal(report.groups.length, 2);
  assert.match(report.limitation, /not an unconditional market base rate/);
  assert.equal(buildCrtBaseRateReport(records.slice(0, 9)).status, "COLLECTING");
});

test("lookahead audit replays the decision snapshot and rejects changed decisions after future candles", () => {
  const records = Array.from({ length: 10 }, (_, index) => signal(`signal-${index}`, {
    auditInput: {
      decisionEpoch: 1000 + index,
      h1Candles: [{ epoch: index, open: 10, high: 12, low: 8, close: 11 }],
      ltfCandles: [{ epoch: 900, open: 9, high: 11, low: 8, close: 10 }],
    },
  }));
  const invariantScanner = ({ h1Candles }) => {
    assert.ok(h1Candles.length >= 1);
    return [records[h1Candles[0].epoch]];
  };
  const pass = runCrtLookaheadTest(records, invariantScanner);
  assert.equal(pass.status, "PASS");
  assert.equal(pass.checked, 10);

  const changedByFutureScanner = ({ h1Candles }) => [
    h1Candles.some((bar) => bar.high > 10000)
      ? { ...records[0], swingLevel: records[0].swingLevel + 1 }
      : records[0],
  ];
  const fail = runCrtLookaheadTest([records[0]], changedByFutureScanner);
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.failures[0].reason, "future_candle_changed_decision");
});
