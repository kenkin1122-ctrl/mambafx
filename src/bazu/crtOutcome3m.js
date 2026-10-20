import { CRT_CONFIG } from "./crtConfig3m.js";

const finite = Number.isFinite;

// Stable FNV-1a fingerprint of the frozen config, so every record and report can be tied to the exact thresholds used.
const canonical = (v) => (v && typeof v === "object"
  ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v));

export function crtConfigFingerprint(config = CRT_CONFIG) {
  const text = canonical(config);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function crtConfigStamp(config = CRT_CONFIG) {
  return `${config.config_version}#${crtConfigFingerprint(config)}`;
}

export function seededUnit(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function lowerBound(epochs, value, strict) {
  let lo = 0, hi = epochs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? epochs[mid] <= value : epochs[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo < epochs.length ? lo : -1;
}

export const firstTickAfter = (epochs, t) => lowerBound(epochs, t, true);
export const firstTickAtOrAfter = (epochs, t) => lowerBound(epochs, t, false);

const resultFor = (direction, entry, exit) => (exit === entry ? "tie" : (direction === "Rise" ? exit > entry : exit < entry) ? "win" : "loss");
const invert = (result) => (result === "win" ? "loss" : result === "loss" ? "win" : "tie");

// c3Timestamp is the CLOSE time of the 5m candle whose close broke the swing (the first moment the signal can exist).
// Entry is the first tick strictly after it; the contract clock starts at that tick's epoch.
export function resolveTickOutcome(record, epochs, prices, horizonSeconds = CRT_CONFIG.base_rate_horizon_seconds) {
  if (!record || !Array.isArray(epochs) || !Array.isArray(prices) || epochs.length !== prices.length) throw new TypeError("Tick outcome requires aligned epoch and price arrays.");
  const signalEpoch = record.c3Timestamp;
  if (!finite(signalEpoch)) throw new TypeError(`CRT signal ${record.crtId} has no trigger close time.`);
  if (!epochs.length) return { status: "pending" };
  if (epochs[0] > signalEpoch) return { status: "unavailable", reason: "ticks_do_not_cover_signal_time" };
  const i0 = firstTickAfter(epochs, signalEpoch);
  if (i0 < 0) return { status: "pending" };
  const entryEpoch = epochs[i0], entryPrice = prices[i0], targetEpoch = entryEpoch + horizonSeconds;
  const i1 = firstTickAtOrAfter(epochs, targetEpoch);
  if (i1 < 0) return { status: "pending", signalEpoch, entryEpoch, entryPrice, targetEpoch };
  const exitPrice = prices[i1], exitEpoch = epochs[i1];
  const sign = record.direction === "Rise" ? 1 : -1;
  const mid = record.crt50, stop = record.sweptExtreme;
  let first = "neither", firstEpoch = null, mfe = 0, mae = 0;
  for (let i = i0; i <= i1; i++) {
    const move = (prices[i] - entryPrice) * sign;
    if (move > mfe) mfe = move;
    if (move < mae) mae = move;
    if (first !== "neither") continue;
    const hitMid = finite(mid) && (sign > 0 ? prices[i] >= mid : prices[i] <= mid);
    const hitStop = finite(stop) && (sign > 0 ? prices[i] <= stop : prices[i] >= stop);
    if (hitStop) { first = "swept_extreme_first"; firstEpoch = epochs[i]; }
    else if (hitMid) { first = "midpoint_first"; firstEpoch = epochs[i]; }
  }
  const result = resultFor(record.direction, entryPrice, exitPrice);
  const randomDirection = seededUnit(`${record.crtId}|control`) < 0.5 ? "Rise" : "Fall";
  return {
    status: "resolved",
    result,
    signalEpoch,
    entryEpoch,
    entryPrice,
    exitEpoch,
    outcomePrice: exitPrice,
    resolvedAtEpoch: exitEpoch,
    clock: "first tick after the 5m break candle closes; exit at first tick at or after entry + horizon",
    thesis: { first, firstEpoch, mfe, mae, horizonSeconds },
    controls: {
      opposite: { direction: record.direction === "Rise" ? "Fall" : "Rise", result: invert(result) },
      random: { direction: randomDirection, result: resultFor(randomDirection, entryPrice, exitPrice) },
    },
  };
}
