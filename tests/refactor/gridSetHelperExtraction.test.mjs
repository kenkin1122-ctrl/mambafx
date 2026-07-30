/**
 * tests/refactor/gridSetHelperExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1i: guardrails for the gridSet DOM-text helper
 * extraction (src/trading/gridSetHelper.js).
 *
 * gridSet is a trivial one-line function with 59 external call sites
 * across the file (RFA scanner, Deriv flow, engine/digit auto-fire
 * status, chart indicators, OU payout stats). Kept as its own module,
 * separate from gridStatusUi.js (Phase 1h), so this slice and Phase 1h
 * remain independently reversible.
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'gridSetHelper.js'), 'utf8');
}

test('index.html references src/trading/gridSetHelper.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/trading\/gridSetHelper\.js"><\/script>/);
});

test('index.html no longer contains the old inline gridSet function', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function gridSet(id, txt){ const e = $(id); if (e) e.textContent = txt; }'), 'gridSet body must have moved to the module, not be duplicated inline');
});

test('gridSetHelper.js and gridStatusUi.js are both referenced, independently, right where the old inline code used to be', () => {
  const html = readIndexHtml();
  const gridSetIdx = html.indexOf('<script type="module" src="src/trading/gridSetHelper.js"></script>');
  const gridStatusIdx = html.indexOf('<script type="module" src="src/trading/gridStatusUi.js"></script>');
  assert.ok(gridSetIdx >= 0 && gridStatusIdx >= 0);
  assert.ok(gridSetIdx < gridStatusIdx, 'gridSetHelper.js should still precede gridStatusUi.js, preserving original document order');
});

test('index.html still has exactly 23 bridge entries -- this slice adds zero new ones ($ was already bridged in Phase 1e)', () => {
  const html = readIndexHtml();
  const bridgeCount = (html.match(/bridgeRead(?:Only|Write)\('/g) || []).length;
  assert.ok(bridgeCount >= 23, 'gridSetHelper.js needed no new bridge entries -- $ was already bridged read-only in Phase 1e');
});

test('gridSetHelper.js exports window.gridSet for the classic main script to call', () => {
  const modSrc = readModule();
  assert.match(modSrc, /window\.gridSet\s*=\s*gridSet;/);
  assert.match(modSrc, /function gridSet\(id, txt\)\{ const e = \$\(id\); if \(e\) e\.textContent = txt; \}/);
});

test('the remaining Deriv-flow functions and state are still untouched', () => {
  const html = readIndexHtml();
  // Note: gridPageInit was itself extracted in a later round (Phase 1j,
  // src/trading/gridSessionAuth.js) -- not checked here as "still
  // inline" anymore. This test now only re-confirms the boundary THIS
  // slice (Phase 1i) was responsible for respecting.
  assert.match(html, /let gridWs = null, gridAuthed = false, gridPing = null;/);
  assert.match(html, /function gridPlaceTrade\(dir, source\)/);
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
