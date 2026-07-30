/**
 * tests/refactor/multiplierHelpersExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1g: guardrails for the multiplier-helpers
 * extraction (src/trading/multiplierHelpers.js).
 *
 * This is a micro-slice carved out of the deferred Deriv trade-execution
 * block (see MSD_FUTURE_PROJECT_PHASE1F_REPORT.md / PHASE1G report):
 * only the self-contained multiplier-helper functions moved. The
 * gridWs/gridAuthed/etc. state declarations and the connect/message/
 * trade functions that own them remain inline, untouched -- this test
 * suite explicitly checks that boundary was respected.
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'multiplierHelpers.js'), 'utf8');
}

test('index.html references src/trading/multiplierHelpers.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/trading\/multiplierHelpers\.js"><\/script>/);
});

test('index.html no longer contains the old inline multiplier-helper functions', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function gridMult(){'), 'gridMult body must have moved to the module, not be duplicated inline');
  assert.ok(!html.includes('let _gridMult = null, _digMult = null, _engMult = null;'), 'the private multiplier state must have moved to the module');
});

test('the Deriv state and functions this slice deliberately left untouched are still declared/defined inline', () => {
  const html = readIndexHtml();
  assert.match(html, /let gridWs = null, gridAuthed = false, gridPing = null;/, 'gridWs/gridAuthed must remain in the classic script');
  assert.match(html, /function gridPlaceTrade\(dir, source\)/, 'gridPlaceTrade must remain inline -- it is the caller of gridMult/gridMultStrat, not moved this round');
  assert.match(html, /let gridArmed = false;/, 'the auto-fire state declarations immediately after the old multiplier block must be untouched');
});

test('index.html has at least the 22 bridge entries accumulated by Phase 1b/1c/1e, and this slice added zero of its own', () => {
  const html = readIndexHtml();
  const bridgeCount = (html.match(/bridgeRead(?:Only|Write)\('/g) || []).length;
  assert.ok(bridgeCount >= 22, 'multiplierHelpers.js needed no new bridge entries -- makeMultiplier is an auto-window function declaration and $ was already bridged in Phase 1e; later slices (Phase 1h+) may add more');
});

test('multiplierHelpers.js exports all six multiplier-helper functions on window', () => {
  const modSrc = readModule();
  for (const fn of ['gridMult', 'digMult', 'engMult', 'gridMultStrat', 'digMultStrat', 'engMultStrat']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn}`);
  }
});

test('multiplierHelpers.js does not export the private lazy-singleton state (_gridMult, _digMult, _engMult)', () => {
  const modSrc = readModule();
  for (const name of ['_gridMult', '_digMult', '_engMult']) {
    assert.ok(!modSrc.includes(`window.${name}`), `${name} has no external reference and must not be exposed on window`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
