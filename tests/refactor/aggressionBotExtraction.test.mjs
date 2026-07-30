/**
 * tests/refactor/aggressionBotExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1f: guardrails for the Aggression Bot extraction
 * (src/trading/aggressionBot.js).
 *
 * This slice was chosen after discovering that the sub-decomposition
 * report's "Deriv login/WS flow" (703 lines) is actually TWO interleaved
 * subsystems nested inside one banner-delimited region: the Deriv auth/
 * connect/trade-execution flow (which OWNS the gridWs/gridAuthed/etc.
 * state the existing bridge already exposes to mfxBot.js/dabBot.js --
 * extracting it would require inverting that bridge relationship, well
 * beyond a small safe slice) and the Aggression Bot (fully self-contained
 * aside from three producer-side exports). Only the Aggression Bot is
 * extracted this round; the Deriv flow itself is deferred pending its
 * own dedicated plan (see MSD_FUTURE_PROJECT_PHASE1F_REPORT.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..', '..');

function readIndexHtml() {
  return fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
}

function readModule() {
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'aggressionBot.js'), 'utf8');
}

test('index.html references src/trading/aggressionBot.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/trading\/aggressionBot\.js"><\/script>/);
});

test('index.html no longer contains the old inline Aggression Bot code (aggScoreOf definition moved out)', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function aggScoreOf('), 'aggScoreOf body must have moved to the module, not be duplicated inline');
  assert.ok(!html.includes('let aggCur = null, aggHistory = [], aggLastPrice = null'), 'the Aggression Bot state declarations must have moved to the module');
});

test('the Deriv trade-execution state this slice deliberately left untouched is still declared inline (gridWs/gridAuthed/etc. were NOT moved)', () => {
  const html = readIndexHtml();
  assert.match(html, /let gridWs = null, gridAuthed = false, gridPing = null;/, 'gridWs/gridAuthed must remain in the classic script -- moving them would break the existing bridge that mfxBot.js/dabBot.js depend on');
  assert.match(html, /function gridPlaceTrade\(dir, source\)/, 'gridPlaceTrade must remain a classic-script function declaration (auto-window), not yet extracted');
});

test('index.html has at least the 22 bridge entries accumulated by Phase 1b/1c/1e, and this slice added zero of its own (decimals was already bridged, drawCandleChart/gridPlaceTrade are already auto-window function declarations)', () => {
  const html = readIndexHtml();
  const bridgeCount = (html.match(/bridgeRead(?:Only|Write)\('/g) || []).length;
  assert.ok(bridgeCount >= 22, 'expected at least 22 bridge entries (5 read-only + 15 read-write from Phase 1b/1c, plus $ and signalRecords from Phase 1e) -- this Aggression Bot slice needed none of its own; later slices (Phase 1h+) may add more');
});

test('aggressionBot.js exports window.aggOnTick, window.aggPageInit, window.aggManualTrade for the classic main script to call', () => {
  const modSrc = readModule();
  for (const fn of ['aggOnTick', 'aggPageInit', 'aggManualTrade']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn}`);
  }
});

test('aggressionBot.js does not export identifiers that have no external reference (aggCur, aggHistory, aggScoreOf, aggRenderAll, etc.)', () => {
  const modSrc = readModule();
  const internalOnly = [
    'aggCur', 'aggHistory', 'aggLastPrice', 'aggPageReady', 'aggAlerts',
    'aggNewCandle', 'aggScoreOf', 'aggFinalizeCandle', 'aggRenderAll',
  ];
  for (const name of internalOnly) {
    assert.ok(!modSrc.includes(`window.${name}`), `${name} has no external reference and must not be exposed on window`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
