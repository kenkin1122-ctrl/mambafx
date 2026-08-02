/**
 * tests/phase12/mfxMsdEventsSchemaExtension.test.mjs
 *
 * Tests for the Phase 12 mfx_msd_events schema extension in index.html
 * (msdOnTick's new tickIndex field, the v1->v2 DB migration adding a
 * sessionId index, and msdWriteEvent's new event-local field
 * computation: sessionId/previousEventId/timeGap/tickGap/protocolVersion/
 * schemaVersion, computed exactly once at insertion time).
 *
 * Unlike a purely static-assertion test (index.html's established
 * pattern elsewhere, since it is not a modular ES file), this file does
 * BOTH: verbatim-extracts the EXACT function/constant source text from
 * index.html (never a hand-copied reimplementation, which could silently
 * drift from the real code) and actually EXECUTES the extracted
 * functions against tests/support/fakeIndexedDB.js's real (if minimal)
 * IndexedDB implementation -- giving genuine functional confidence in
 * the session-boundary logic, gap computation, and append-only write
 * discipline, not just "the right words appear in the file."
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';

const INDEX_HTML_PATH = path.resolve(new URL('../../index.html', import.meta.url).pathname);

function extractIndexHtmlSource() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  function extractBraceBlock(startMarker) {
    const startIdx = html.indexOf(startMarker);
    if (startIdx === -1) throw new Error(`extractBraceBlock: marker not found: ${startMarker}`);
    let depth = 0, i = startIdx, started = false;
    for (; i < html.length; i++) {
      if (html[i] === '{') { depth++; started = true; }
      else if (html[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return html.slice(startIdx, i);
  }

  /** For simple statements with no braces (const X = 'literal';) -- extract up to (and including) a known end marker instead of brace-matching, which would otherwise over-consume into the next brace-containing statement. */
  function extractUpTo(startMarker, endMarkerExclusive) {
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarkerExclusive, startIdx);
    if (startIdx === -1 || endIdx === -1) throw new Error(`extractUpTo: marker not found (${startMarker} .. ${endMarkerExclusive})`);
    return html.slice(startIdx, endIdx);
  }

  const pieces = [
    extractUpTo('const MSD_EVENT_DB_NAME', 'function msdOpenEventDatabase'),
    extractBraceBlock('function msdOpenEventDatabase'),
    extractBraceBlock('async function msdGetLastEventInSession'),
    extractBraceBlock('async function msdWriteEvent'),
    extractBraceBlock('async function msdGetEvent('),
    extractBraceBlock('async function msdGetEventCount'),
  ];
  return pieces.join('\n\n');
}

async function loadRealMsdEventModule(sessionId) {
  const extracted = extractIndexHtmlSource();
  const moduleSource = `
    const msdSessionId = ${JSON.stringify(sessionId)};
    const msdPipelineHealth = { eventWriteTimes: [], writeFailures: 0 };
    function msdNowMs(){ return Date.now(); }
    function msdRecordWriteTime(list, ms){ list.push(ms); }

    ${extracted}

    export { msdWriteEvent, msdGetEvent, msdGetEventCount, msdGetLastEventInSession, msdOpenEventDatabase, MSD_EVENT_DB_VERSION, MSD_PROTOCOL_VERSION, MSD_EVENT_SCHEMA_VERSION };
  `;
  const tmpPath = path.join('/tmp', `msd-event-module-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmpPath, moduleSource);
  try {
    return await import(tmpPath);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

function makeCompletedEvent({ eventId, detectedAt, tickIndex }) {
  return {
    eventId, runStartEpoch: 1000, runStartPrice: 100, runEndEpoch: 1010,
    runEndPrice: 105, actualRunLength: 5, detectedAt, tickIndex,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Static verification
// ═══════════════════════════════════════════════════════════════════════════

test('index.html: MSD_EVENT_DB_VERSION is 2, and MSD_PROTOCOL_VERSION/MSD_EVENT_SCHEMA_VERSION constants exist', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(html, /const MSD_EVENT_DB_VERSION = 2;/);
  assert.match(html, /const MSD_EVENT_SCHEMA_VERSION = '2\.0\.0';/);
  assert.match(html, /const MSD_PROTOCOL_VERSION = 'P12-GAP-v1\.1\.0';/);
});

test('index.html: msdOnTick\'s completedEvent gained tickIndex, with no existing field removed', () => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  assert.match(html, /tickIndex: msdDebugCounters\.ticksProcessed/);
  for (const field of ['eventId: msdRunState.qualifiedEventId', 'runStartEpoch: msdRunState.anchorEpoch', 'runStartPrice: msdRunState.anchorPrice', 'runEndEpoch: epoch', 'runEndPrice: msdRunState.lastPrice', 'actualRunLength: msdRunState.count', 'detectedAt: Date.now()']) {
    assert.ok(html.includes(field), `expected pre-existing field construction "${field}" to still be present verbatim`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Real functional tests -- verbatim-extracted source, executed against
// the real (if minimal) fakeIndexedDB implementation.
// ═══════════════════════════════════════════════════════════════════════════

test('real functional test: the first event of a session gets null previousEventId/timeGap/tickGap -- never a fabricated default', async () => {
  const { teardown } = installFakeIndexedDB();
  try {
    const msd = await loadRealMsdEventModule('session-A');
    const event = makeCompletedEvent({ eventId: 'evt-1', detectedAt: 1000, tickIndex: 50 });
    const result = await msd.msdWriteEvent(event);
    assert.equal(result.ok, true);

    const stored = await msd.msdGetEvent('evt-1');
    assert.equal(stored.sessionId, 'session-A');
    assert.equal(stored.previousEventId, null);
    assert.equal(stored.timeGap, null);
    assert.equal(stored.tickGap, null);
    assert.equal(stored.protocolVersion, 'P12-GAP-v1.1.0');
    assert.equal(stored.schemaVersion, '2.0.0');
  } finally {
    teardown();
  }
});

test('real functional test: the second event of the SAME session gets real, correctly computed previousEventId/timeGap/tickGap', async () => {
  const { teardown } = installFakeIndexedDB();
  try {
    const msd = await loadRealMsdEventModule('session-B');
    await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-1', detectedAt: 1000, tickIndex: 50 }));
    await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-2', detectedAt: 1750, tickIndex: 83 }));

    const stored = await msd.msdGetEvent('evt-2');
    assert.equal(stored.previousEventId, 'evt-1');
    assert.equal(stored.timeGap, 750);
    assert.equal(stored.tickGap, 33);
  } finally {
    teardown();
  }
});

test('real functional test: events written under DIFFERENT sessionId values (simulating separate page loads against the SAME persistent store) never compute a cross-session gap -- each session\'s first event is honestly null', async () => {
  const { teardown } = installFakeIndexedDB();
  try {
    const msdSessionA = await loadRealMsdEventModule('session-C1');
    await msdSessionA.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-c1-1', detectedAt: 1000, tickIndex: 10 }));
    await msdSessionA.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-c1-2', detectedAt: 2000, tickIndex: 20 }));

    const msdSessionB = await loadRealMsdEventModule('session-C2');
    await msdSessionB.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-c2-1', detectedAt: 5000, tickIndex: 100 }));

    const firstOfSessionB = await msdSessionB.msdGetEvent('evt-c2-1');
    assert.equal(firstOfSessionB.sessionId, 'session-C2');
    assert.equal(firstOfSessionB.previousEventId, null, 'must not link back to session-C1\'s last event');
    assert.equal(firstOfSessionB.timeGap, null, 'must not compute a gap across the session boundary');
    assert.equal(firstOfSessionB.tickGap, null);
  } finally {
    teardown();
  }
});

test('real functional test: three events in one session compute a correct chain of gaps, each computed exactly once', async () => {
  const { teardown } = installFakeIndexedDB();
  try {
    const msd = await loadRealMsdEventModule('session-D');
    await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-1', detectedAt: 1000, tickIndex: 10 }));
    await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-2', detectedAt: 1500, tickIndex: 25 }));
    await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-3', detectedAt: 2200, tickIndex: 41 }));

    const e2 = await msd.msdGetEvent('evt-2');
    const e3 = await msd.msdGetEvent('evt-3');
    assert.equal(e2.timeGap, 500); assert.equal(e2.tickGap, 15);
    assert.equal(e3.timeGap, 700); assert.equal(e3.tickGap, 16);
    assert.equal(e3.previousEventId, 'evt-2');
  } finally {
    teardown();
  }
});

test('real functional test: append-only discipline is preserved -- writing a duplicate eventId is rejected, not silently overwritten (real add()-not-put() behavior against the fake store)', async () => {
  const { teardown } = installFakeIndexedDB();
  try {
    const msd = await loadRealMsdEventModule('session-E');
    const first = await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-dup', detectedAt: 1000, tickIndex: 5 }));
    assert.equal(first.ok, true);
    const second = await msd.msdWriteEvent(makeCompletedEvent({ eventId: 'evt-dup', detectedAt: 9999, tickIndex: 500 }));
    assert.equal(second.ok, false);

    const stored = await msd.msdGetEvent('evt-dup');
    assert.equal(stored.detectedAt, 1000, 'the original record must be untouched -- no silent overwrite');
  } finally {
    teardown();
  }
});
