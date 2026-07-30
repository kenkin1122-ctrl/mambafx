/**
 * tests/refactor/gridStatusUiExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1h: guardrails for the gridConnState/gridDiag
 * UI-status-helper extraction (src/trading/gridStatusUi.js).
 *
 * Another micro-slice carved out of the deferred Deriv trade-execution
 * block (see MSD_FUTURE_PROJECT_PHASE1F_REPORT.md / PHASE1G report).
 * New finding this round: gridConnState reads gridLoggedIn, which none
 * of the earlier consumer modules (mfxBot/dabBot) needed -- so this is
 * the first new bridge entry added since Phase 1e.
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'gridStatusUi.js'), 'utf8');
}

test('index.html references src/trading/gridStatusUi.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/trading\/gridStatusUi\.js"><\/script>/);
});

test('index.html no longer contains the old inline gridConnState/gridDiag functions', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function gridConnState(state){'), 'gridConnState body must have moved to the module, not be duplicated inline');
  assert.ok(!html.includes('function gridDiag(html, isError){'), 'gridDiag body must have moved to the module');
});

test('the remaining Deriv-flow state/functions this slice deliberately left untouched are still declared/defined inline', () => {
  const html = readIndexHtml();
  // Note: gridSet was itself extracted in a later round (Phase 1i,
  // src/trading/gridSetHelper.js) -- it is intentionally NOT checked
  // here as "still inline" anymore. This test now only re-confirms the
  // boundary THIS slice (Phase 1h) was responsible for respecting.
  assert.match(html, /let gridWs = null, gridAuthed = false, gridPing = null;/, 'gridWs/gridAuthed must remain in the classic script');
  assert.match(html, /function gridPlaceTrade\(dir, source\)/, 'gridPlaceTrade must remain inline');
});

test('index.html gained the gridLoggedIn bridge entry this slice added (later upgraded read-write in Phase 1j once gridCheckSession itself moved)', () => {
  const html = readIndexHtml();
  const bridgeCount = (html.match(/bridgeRead(?:Only|Write)\('/g) || []).length;
  assert.ok(bridgeCount >= 23, 'expected at least 23 entries (22 prior plus the gridLoggedIn entry this slice added); later slices may add more or change its read-only/read-write form');
  assert.match(html, /bridgeRead(?:Only|Write)\('gridLoggedIn'/, 'gridLoggedIn must still have a bridge entry, in whatever form the current round left it');
});

test('gridStatusUi.js exports window.gridConnState and window.gridDiag for the classic main script to call', () => {
  const modSrc = readModule();
  for (const fn of ['gridConnState', 'gridDiag']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn}`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
