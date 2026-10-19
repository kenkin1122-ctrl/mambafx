import { CRT_CONFIG } from "./crtConfig3m.js";
import { scanCrt } from "./crt3m.js";
import { wilson } from "./stats.js?v=15";

export const CRT_JOURNAL_DB = "bazu_crt_shadow";
export const CRT_JOURNAL_VERSION = 1;
export const CRT_JOURNAL_STORE = "signals";
export const CRT_OUTCOME_HORIZON_SECONDS = CRT_CONFIG.base_rate_horizon_seconds;

const finite = Number.isFinite;
const clone = (value) => JSON.parse(JSON.stringify(value));

function compareFields(record) {
  return {
    crtId: record.crtId,
    status: record.status,
    reason: record.reason,
    signalStatus: record.signalStatus,
    rejectionReason: record.rejectionReason,
    direction: record.direction,
    c1Timestamp: record.c1Timestamp,
    c2Timestamp: record.c2Timestamp,
    c2CloseTimestamp: record.c2CloseTimestamp,
    c3Timestamp: record.c3Timestamp,
    rangeHigh: record.rangeHigh,
    rangeLow: record.rangeLow,
    sweepSide: record.sweepSide,
    epsilonUsed: record.epsilonUsed,
    atr14Wilder: record.atr14Wilder,
    atrRatio: record.atrRatio,
    poi: record.poi,
    compressionRatio: record.compressionRatio,
    swingLevel: record.swingLevel,
    triggerCandlesWaited: record.triggerCandlesWaited,
  };
}

function appendFutureBar(bars, seconds, decisionEpoch) {
  const latest = bars.at(-1);
  const epoch = Math.max(latest ? latest.epoch + seconds : 0, Math.floor(decisionEpoch / seconds) * seconds + seconds);
  const base = latest?.close ?? 100;
  return [...bars, { epoch, open: base, high: base + 1000000, low: base - 1000000, close: base + 500000 }];
}

export function runCrtLookaheadTest(records, scanner = scanCrt, requiredSignals = CRT_CONFIG.report_sample_size) {
  if (!Array.isArray(records) || typeof scanner !== "function") throw new TypeError("Lookahead audit requires records and a scanner.");
  if (!Number.isInteger(requiredSignals) || requiredSignals < 1) throw new RangeError("Lookahead audit requires a positive sample size.");
  const failures = [];
  let checked = 0;
  for (const signal of records) {
    const input = signal.auditInput;
    if (!input || !Array.isArray(input.h1Candles) || !Array.isArray(input.ltfCandles) || !finite(input.decisionEpoch)) {
      failures.push({ crtId: signal.crtId, reason: "missing_decision_snapshot" });
      continue;
    }
    const baseline = scanner({ ...input, routeResults: false }).find((candidate) => candidate.crtId === signal.crtId);
    if (!baseline) {
      failures.push({ crtId: signal.crtId, reason: "signal_not_reproduced_from_decision_snapshot" });
      continue;
    }
    const expected = compareFields(signal);
    const actual = compareFields(baseline);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      failures.push({ crtId: signal.crtId, reason: "decision_snapshot_replay_mismatch" });
      continue;
    }
    const futureInput = {
      ...input,
      h1Candles: appendFutureBar(input.h1Candles, 3600, input.decisionEpoch),
      ltfCandles: appendFutureBar(input.ltfCandles, 300, input.decisionEpoch),
    };
    const withFuture = scanner({ ...futureInput, routeResults: false }).find((candidate) => candidate.crtId === signal.crtId);
    if (!withFuture || JSON.stringify(compareFields(withFuture)) !== JSON.stringify(actual)) {
      failures.push({ crtId: signal.crtId, reason: "future_candle_changed_decision" });
      continue;
    }
    checked++;
  }
  return {
    status: failures.length ? "FAIL" : checked >= requiredSignals ? "PASS" : "INCOMPLETE",
    checked,
    required: requiredSignals,
    failureCount: failures.length,
    failures,
    method: "Decision-time replay plus extreme future-candle append invariance; not a profitability test.",
    completedAt: Date.now(),
  };
}

export function buildCrtBaseRateReport(records, requiredSignals = CRT_CONFIG.report_sample_size) {
  if (!Array.isArray(records)) throw new TypeError("Base-rate report requires a record array.");
  if (!Number.isInteger(requiredSignals) || requiredSignals < 1) throw new RangeError("Base-rate report requires a positive sample size.");
  const results = records.filter((record) => record.outcome?.status === "resolved");
  const wins = results.filter((record) => record.outcome.result === "win").length;
  const losses = results.filter((record) => record.outcome.result === "loss").length;
  const ties = results.filter((record) => record.outcome.result === "tie").length;
  const interval = wilson(wins, results.length);
  const grouped = new Map();
  for (const record of results) {
    const key = `${record.instrument}|${record.direction}`;
    const row = grouped.get(key) || { instrument: record.instrument, direction: record.direction, n: 0, wins: 0, losses: 0, ties: 0 };
    row.n++;
    row[record.outcome.result === "win" ? "wins" : record.outcome.result === "tie" ? "ties" : "losses"]++;
    grouped.set(key, row);
  }
  for (const row of grouped.values()) {
    const ci = wilson(row.wins, row.n);
    row.hitRate = ci.p;
    row.confidence95 = { low: ci.lo, high: ci.hi };
  }
  return {
    status: records.length >= requiredSignals ? "READY" : "COLLECTING",
    signalsLogged: records.length,
    requiredSignals,
    outcomesResolved: results.length,
    outcomesPending: records.filter((record) => record.outcome?.status === "pending").length,
    outcomesUnavailable: records.filter((record) => record.outcome?.status === "unavailable").length,
    wins,
    losses,
    ties,
    hitRate: interval.p,
    confidence95: { low: interval.lo, high: interval.hi },
    horizonSeconds: CRT_OUTCOME_HORIZON_SECONDS,
    tieRule: "A tie is reported separately and is not counted as a win, consistent with Deriv Rise/Fall settlement.",
    groups: [...grouped.values()].sort((a, b) => a.instrument.localeCompare(b.instrument) || a.direction.localeCompare(b.direction)),
    limitation: "Observed CRT directional outcome rate at the configured five-minute horizon; this is not an unconditional market base rate or evidence of profitability.",
    generatedAt: Date.now(),
  };
}

export function createCrtJournal({ idb = globalThis.indexedDB, sampleSize = CRT_CONFIG.report_sample_size } = {}) {
  if (!idb) throw new Error("CRT shadow collection requires IndexedDB; no volatile-only fallback is allowed.");
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new RangeError("CRT sample size must be a positive integer.");
  const records = new Map();
  let db;

  const ready = new Promise((resolve, reject) => {
    let request;
    let blocked = false;
    try { request = idb.open(CRT_JOURNAL_DB, CRT_JOURNAL_VERSION); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(CRT_JOURNAL_STORE)) {
        database.createObjectStore(CRT_JOURNAL_STORE, { keyPath: "crtId" });
      }
    };
    request.onerror = () => reject(request.error || new Error("CRT journal IndexedDB open failed."));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("CRT journal IndexedDB open was blocked."));
    };
    request.onsuccess = () => {
      db = request.result;
      if (blocked) {
        db.close();
        db = null;
        return;
      }
      db.onversionchange = () => db.close();
      const tx = db.transaction(CRT_JOURNAL_STORE, "readonly");
      const all = tx.objectStore(CRT_JOURNAL_STORE).getAll();
      all.onsuccess = () => {
        for (const record of all.result || []) records.set(record.crtId, record);
      };
      all.onerror = () => reject(all.error || new Error("CRT journal load failed."));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("CRT journal load transaction failed."));
    };
  });

  function put(record) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(CRT_JOURNAL_STORE, "readwrite");
        tx.objectStore(CRT_JOURNAL_STORE).put(record);
      } catch (error) { reject(error); return; }
      tx.oncomplete = () => { records.set(record.crtId, record); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("CRT journal write failed."));
    });
  }

  return {
    ready,
    async addQualified(qualifiedRecords, auditInput) {
      await ready;
      if (!Array.isArray(qualifiedRecords) || !auditInput) throw new TypeError("CRT journal requires records and their decision-time input.");
      const added = [];
      for (const record of qualifiedRecords) {
        if (record.signalStatus !== "QUALIFIED" || record.routedByScanner !== true || !record.direction || records.has(record.crtId)) continue;
        if (records.size >= sampleSize) break;
        const stored = {
          ...clone(record),
          loggedAt: Date.now(),
          decisionEpoch: auditInput.decisionEpoch,
          outcome: { status: "pending", targetEpoch: record.c3Timestamp + CRT_OUTCOME_HORIZON_SECONDS },
          auditInput: clone(auditInput),
        };
        await new Promise((resolve, reject) => {
          let tx;
          let inserted = false;
          let existingRecord = null;
          try {
            tx = db.transaction(CRT_JOURNAL_STORE, "readwrite");
            const store = tx.objectStore(CRT_JOURNAL_STORE);
            const all = store.getAll();
            all.onsuccess = () => {
              const existing = all.result || [];
              existingRecord = existing.find((item) => item.crtId === stored.crtId) || null;
              if (existingRecord || existing.length >= sampleSize) return;
              const add = store.add(stored);
              add.onsuccess = () => { inserted = true; };
            };
            all.onerror = () => { try { tx.abort(); } catch {} };
          } catch (error) { reject(error); return; }
          tx.oncomplete = () => {
            if (existingRecord) records.set(existingRecord.crtId, existingRecord);
            else if (inserted && !records.has(stored.crtId) && records.size < sampleSize) {
              records.set(stored.crtId, stored);
              added.push(stored);
            }
            resolve();
          };
          tx.onerror = tx.onabort = () => {
            if (tx.error?.name === "ConstraintError") { resolve(); return; }
            reject(tx.error || new Error("CRT signal insert failed."));
          };
        });
      }
      return added;
    },
    async resolveOutcomes(symbol, ltfCandles, decisionEpoch) {
      await ready;
      if (!Array.isArray(ltfCandles) || !finite(decisionEpoch)) throw new TypeError("CRT outcome resolution requires LTF candles and a finite point-in-time timestamp.");
      const completed = [];
      const closed = ltfCandles.filter((bar) => bar.epoch + 300 <= decisionEpoch);
      for (const record of records.values()) {
        if (record.instrument !== symbol || record.outcome?.status !== "pending") continue;
        const targetEpoch = record.outcome.targetEpoch;
        if (!finite(targetEpoch)) throw new TypeError(`CRT signal ${record.crtId} has an invalid outcome target.`);
        const target = closed.find((bar) => bar.epoch + 300 === targetEpoch);
        if (!target) {
          if (decisionEpoch >= targetEpoch && closed.some((bar) => bar.epoch + 300 > targetEpoch)) {
            const unavailable = { ...record, outcome: { ...record.outcome, status: "unavailable", reason: "missing_exact_five_minute_outcome_candle" } };
            await put(unavailable);
          }
          continue;
        }
        const entry = record.breakCandle?.close;
        if (!finite(entry)) throw new TypeError(`CRT signal ${record.crtId} is missing its trigger close price.`);
        const outcomePrice = target.close;
        const won = record.direction === "Rise" ? outcomePrice > entry : outcomePrice < entry;
        const tied = outcomePrice === entry;
        const resolved = {
          ...record,
          outcome: { status: "resolved", result: tied ? "tie" : won ? "win" : "loss", entryPrice: entry, outcomePrice, resolvedAtEpoch: target.epoch + 300 },
        };
        await put(resolved);
        completed.push(resolved);
      }
      return completed;
    },
    async all() {
      await ready;
      return [...records.values()].sort((a, b) => a.loggedAt - b.loggedAt).slice(0, sampleSize);
    },
    async reports() {
      await ready;
      const all = [...records.values()].sort((a, b) => a.loggedAt - b.loggedAt).slice(0, sampleSize);
      if (all.length < sampleSize) return { baseRate: buildCrtBaseRateReport(all, sampleSize), lookahead: null };
      return {
        baseRate: buildCrtBaseRateReport(all, sampleSize),
        lookahead: runCrtLookaheadTest(all, scanCrt, sampleSize),
      };
    },
    close() { db?.close(); db = null; },
  };
}
