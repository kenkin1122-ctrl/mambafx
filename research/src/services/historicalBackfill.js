/**
 * research/src/services/historicalBackfill.js
 *
 * Purpose:
 *   Implement the Historical Tick Engine's decision/planning logic (Final
 *   Laboratory Architecture v1.0, Layer 1) — the highest-priority missing
 *   capability identified across every architecture review in this
 *   engagement, elevated from "deferred feature" to a first-class Layer 1
 *   component because it directly multiplies the Laboratory's statistical
 *   power, replication quality, and rare-event discovery rate, all of
 *   which are currently rate-limited by learning only from ticks captured
 *   while a live session happens to be open.
 *
 * Architectural note (why this is a PLANNER, not a live network client):
 *   Historical replay must feed the exact same pipeline the Live Tick
 *   Engine feeds (Event Detection -> Market State Database) — "not a
 *   separate pipeline, the same pipeline fed from a different data
 *   source" (Final Laboratory Architecture v1.0, dependency graph). This
 *   module owns the deterministic, fully-testable half of that: given an
 *   already-acquired, chronologically-ordered tick series, it segments it
 *   into contiguous sessions (so a network outage or reconnect gap cannot
 *   corrupt a run detection by silently bridging two disconnected
 *   periods — a Key Learning already recorded in this project's own
 *   history: "internet outages and WebSocket reconnects should trigger
 *   session segmentation, not experiment rejection"), detects every valid
 *   MSD_RUN_LENGTH-consecutive-tick run per session using the SAME
 *   direction/length definition the legacy Live Tick Engine uses
 *   (ENGINE_MAP.md, MSD Core Engine constants: MSD_RUN_LENGTH = 5,
 *   direction 1 = rise / -1 = fall), and de-duplicates candidate events
 *   against whatever the Laboratory has already captured (via the
 *   existing read-only legacy bridge — services/bridgeToLegacyMsd/read.js
 *   — so re-running a backfill over an overlapping historical range is
 *   always safe).
 *
 *   The LIVE acquisition half (opening a WebSocket to Deriv, issuing
 *   `ticks_history` requests, paging through a bulk historical range,
 *   handling rate limits/backoff) is deliberately NOT implemented here.
 *   That code must run in a browser (or the existing phase8-engine.js
 *   vm-sandbox pattern) and be verified against a real connection —
 *   exactly the same reasoning that kept discoveryDecision.js's final
 *   legacy-engine wiring as an explicit next slice rather than something
 *   completed blind in a Node-only environment. The wire protocol this
 *   module's output is designed to be fed by is documented, not guessed:
 *   confirmed directly from the existing, working `mtf/src/charts/socket.js`
 *   (`{ ticks_history: symbol, style: "ticks", count, start, end, req_id }`,
 *   live ticks arriving as `{ epoch, quote, symbol }`) — this module's
 *   tick-record shape ({epoch, quote}) matches that existing, real
 *   convention exactly, not an invented one.
 *
 *   Persistence of a produced plan (turning candidateEvents into real
 *   `mfx_msd_events`/`mfx_msd_states` rows via the legacy `msdPutEvent`/
 *   `msdCaptureMarketState` functions) requires a small, additive
 *   extension to `bridgeToLegacyMsd/write.js`'s whitelist — proposed, not
 *   implemented, in this phase (see the phase deliverable's explicit
 *   scoping note); write.js's access-control documentation currently
 *   states only stage8-lifecycle imports it, and widening that for a
 *   Historical Tick Engine caller is a small, worth-calling-out boundary
 *   change, not something to fold in silently.
 *
 * Responsibilities:
 *   - segmentSessionsByGap(ticks, {maxGapMs}): splits a chronologically-
 *     sorted tick array into contiguous sessions wherever the gap between
 *     consecutive ticks' epochs exceeds maxGapMs. A run may never span a
 *     segment boundary.
 *   - detectRunsInSession(ticks, {runLength, symbol}): the SAME
 *     consecutive-same-direction-tick-run definition the legacy engine
 *     uses, applied to one already-segmented, gap-free session. Returns
 *     candidate MarketEvent-shaped records (no persistence).
 *   - deduplicateAgainstExisting(candidateEvents, existingEvents): filters
 *     out any candidate whose (symbol, direction, runStartEpoch) already
 *     matches a previously-captured event.
 *   - planBackfillBatch({symbol, ticks, maxGapMs, runLength,
 *     legacyGlobal}): the single orchestrating entry point — segments,
 *     detects, fetches existing events via the read bridge, deduplicates,
 *     and returns a structured, human/machine-reviewable plan.
 *
 * Inputs: a chronologically-ordered array of `{epoch, quote}` tick
 *   records (epoch: unix seconds, quote: price) for ONE symbol, plus
 *   configuration.
 * Outputs: candidate MarketEvent-shaped plain objects (not yet persisted)
 *   and a structured plan summary.
 * Dependencies: services/bridgeToLegacyMsd (read-only: getAllEvents), and
 *   nothing else — this module never touches IndexedDB directly and never
 *   imports write.js.
 *
 * Public API: segmentSessionsByGap, detectRunsInSession,
 *   deduplicateAgainstExisting, planBackfillBatch, InvalidTickSeriesError.
 * Internal API: none.
 *
 * Error handling: a tick series that is not chronologically sorted, or
 *   contains a non-finite epoch/quote, throws InvalidTickSeriesError
 *   synchronously before any detection logic runs — silently sorting or
 *   coercing bad input would risk fabricating runs that never happened,
 *   exactly the kind of "phantom validation" failure mode this project's
 *   own history (R-060) has already been burned by once.
 * Performance notes: segmentSessionsByGap and detectRunsInSession are
 *   O(n) single passes over the tick series; deduplicateAgainstExisting is
 *   O(m + k) using a Set built from the existing events (m = existing
 *   events, k = candidates) rather than an O(m*k) nested scan.
 * Threading model: main-thread only (matches every sibling service
 *   module); pure computation, no I/O of its own beyond the read bridge.
 * Storage usage: none directly.
 * Complexity analysis: O(n) for the tick-series passes, O(m + k) for
 *   deduplication — linear in input size throughout, no quadratic scans
 *   (a discipline this project has been explicitly burned by once before,
 *   per the O(n^2) `msdBestGainOverSorted` lesson recorded in project
 *   memory).
 * Future extension notes: the live acquisition adapter (Deriv
 *   `ticks_history` paging, backoff, dedup-safe resumption across pages)
 *   is the natural next slice, feeding this module's planBackfillBatch()
 *   once built — its output shape ({epoch, quote} arrays) is exactly what
 *   this module already expects, so no interface change should be needed
 *   when it lands.
 */

import { getAllEvents } from './bridgeToLegacyMsd/index.js';

export class InvalidTickSeriesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidTickSeriesError';
  }
}

function assertValidTickSeries(ticks) {
  if (!Array.isArray(ticks)) {
    throw new InvalidTickSeriesError('tick series must be an array');
  }
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (!t || !Number.isFinite(t.epoch) || !Number.isFinite(t.quote)) {
      throw new InvalidTickSeriesError(`tick at index ${i} is missing a finite "epoch" or "quote"`);
    }
    if (i > 0 && t.epoch < ticks[i - 1].epoch) {
      throw new InvalidTickSeriesError(
        `tick series is not chronologically sorted: index ${i} (epoch ${t.epoch}) precedes index ${i - 1} (epoch ${ticks[i - 1].epoch})`
      );
    }
  }
}

/**
 * Split a chronologically-sorted tick array into contiguous sessions,
 * breaking wherever the gap between consecutive ticks exceeds maxGapMs.
 * A single out-of-range tick still produces a session of length 1 (never
 * silently dropped) so callers can see exactly what was excluded from run
 * detection and why (too short a session to contain a run).
 */
export function segmentSessionsByGap(ticks, { maxGapMs = 30000 } = {}) {
  assertValidTickSeries(ticks);
  if (ticks.length === 0) return [];
  const sessions = [];
  let current = [ticks[0]];
  for (let i = 1; i < ticks.length; i++) {
    const gapMs = (ticks[i].epoch - ticks[i - 1].epoch) * 1000;
    if (gapMs > maxGapMs) {
      sessions.push(current);
      current = [ticks[i]];
    } else {
      current.push(ticks[i]);
    }
  }
  sessions.push(current);
  return sessions;
}

/**
 * Detect every valid runLength-consecutive-same-direction-tick run within
 * one already gap-free session, matching the legacy Live Tick Engine's own
 * definition (ENGINE_MAP.md: MSD_RUN_LENGTH = 5, direction 1 = rise / -1 =
 * fall). A "tick" with an unchanged price relative to its predecessor
 * breaks a run (neither a rise nor a fall), exactly as the legacy engine's
 * own consecutive-run counter does.
 */
export function detectRunsInSession(ticks, { runLength = 5, symbol } = {}) {
  assertValidTickSeries(ticks);
  if (!Number.isInteger(runLength) || runLength < 1) {
    throw new InvalidTickSeriesError('runLength must be a positive integer');
  }
  const events = [];
  let streakDirection = 0;
  let streakStartIdx = -1;
  let streakLength = 0;

  for (let i = 1; i < ticks.length; i++) {
    const delta = ticks[i].quote - ticks[i - 1].quote;
    const direction = delta > 0 ? 1 : delta < 0 ? -1 : 0;

    if (direction !== 0 && direction === streakDirection) {
      streakLength++;
    } else {
      streakDirection = direction;
      streakStartIdx = i - 1;
      streakLength = direction === 0 ? 0 : 1;
    }

    if (streakLength === runLength) {
      const startTick = ticks[streakStartIdx];
      const triggerTick = ticks[i];
      events.push({
        symbol: symbol ?? null,
        direction: streakDirection,
        runLength,
        runStartEpoch: startTick.epoch,
        detectedAt: triggerTick.epoch,
        triggerPrice: triggerTick.quote,
      });
      // Match the legacy engine's own semantics: once a run fires, the
      // streak counter resets rather than continuing to fire on every
      // subsequent tick in an even-longer run (a 7-tick rise contains
      // exactly one 5-tick-run event at tick 5, not also one at ticks 6
      // and 7) -- this mirrors resetState()/processTick()'s fire-once
      // behavior for a given streak.
      streakDirection = 0;
      streakStartIdx = -1;
      streakLength = 0;
    }
  }
  return events;
}

/**
 * Filter out any candidate event that matches an already-captured event on
 * (symbol, direction, runStartEpoch) -- the natural identity for a run
 * event, independent of any generated eventId. O(m + k) via a Set, never
 * an O(m*k) nested scan.
 */
export function deduplicateAgainstExisting(candidateEvents, existingEvents) {
  const existingKeys = new Set(
    (existingEvents || []).map((e) => `${e.symbol}::${e.direction}::${e.runStartEpoch}`)
  );
  return candidateEvents.filter((e) => !existingKeys.has(`${e.symbol}::${e.direction}::${e.runStartEpoch}`));
}

/**
 * The single orchestrating entry point: segment -> detect -> dedupe
 * against whatever the Laboratory already has captured (via the read-only
 * legacy bridge). Returns a structured plan; does not persist anything.
 */
export async function planBackfillBatch({ symbol, ticks, maxGapMs = 30000, runLength = 5, legacyGlobal } = {}) {
  if (!symbol || typeof symbol !== 'string') {
    throw new InvalidTickSeriesError('planBackfillBatch: "symbol" must be a non-empty string');
  }
  const sessions = segmentSessionsByGap(ticks, { maxGapMs });
  const allCandidates = sessions.flatMap((session) => detectRunsInSession(session, { runLength, symbol }));

  // Await regardless of whether the injected legacy function is sync
  // (test doubles) or genuinely async (the real msdGetAllEvents(), an
  // IndexedDB read) -- awaiting a non-Promise value is a safe no-op.
  const existingEvents = await getAllEvents(legacyGlobal);
  const deduped = deduplicateAgainstExisting(allCandidates, existingEvents);

  return {
    symbol,
    ticksProcessed: ticks.length,
    sessionsFound: sessions.length,
    runsDetected: allCandidates.length,
    duplicatesSkipped: allCandidates.length - deduped.length,
    candidateEvents: deduped,
  };
}
