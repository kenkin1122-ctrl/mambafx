/**
 * tests/refactor/gridSessionAuthExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1j: guardrails for the Deriv session/account-
 * management extraction (src/trading/gridSessionAuth.js).
 *
 * Nine functions (gridPageInit, gridStartLogin, gridCheckSession,
 * gridHandleRedirectReturn, gridCheckSessionWithRetry, gridLoadAccounts,
 * gridBuildPicker, gridMergeAccounts, gridSelectAccountFromPicker) moved
 * as one module, split into two non-contiguous source ranges around the
 * existing src/trading/aggressionBot.js module tag (Phase 1f), which
 * this slice was careful to leave completely untouched.
 *
 * This is the first slice in the deferred-Deriv-block series to need a
 * bridge UPGRADE (gridLoggedIn: read-only since Phase 1h -> read-write,
 * because gridCheckSession writes it) in addition to new entries.
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'gridSessionAuth.js'), 'utf8');
}

test('index.html references src/trading/gridSessionAuth.js as an ES module, positioned before the untouched aggressionBot.js tag', () => {
  const html = readIndexHtml();
  const sessionIdx = html.indexOf('<script type="module" src="src/trading/gridSessionAuth.js"></script>');
  const aggIdx = html.indexOf('<script type="module" src="src/trading/aggressionBot.js"></script>');
  assert.ok(sessionIdx >= 0, 'gridSessionAuth.js module reference must exist');
  assert.ok(aggIdx >= 0, 'the pre-existing aggressionBot.js module reference must still exist, untouched');
  assert.ok(sessionIdx < aggIdx, 'gridSessionAuth.js must appear before aggressionBot.js, preserving original document order');
});

test('index.html no longer contains the old inline session/account-management functions', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function gridPageInit(){'), 'gridPageInit body must have moved to the module');
  assert.ok(!html.includes('async function gridLoadAccounts(){'), 'gridLoadAccounts body must have moved to the module');
  assert.ok(!html.includes('function gridBuildPicker(){'), 'gridBuildPicker body must have moved to the module');
});

test('the remaining Deriv-flow state and connect/trade functions were deliberately left untouched', () => {
  const html = readIndexHtml();
  assert.match(html, /let gridWs = null, gridAuthed = false, gridPing = null;/);
  assert.match(html, /async function gridConnect\(\)\{/, 'gridConnect must remain inline -- not part of this slice');
  assert.match(html, /function gridPlaceTrade\(dir, source\)/);
});

test('index.html has the six bridge changes this slice made: gridLoggedIn upgraded to read-write, plus five new entries', () => {
  const html = readIndexHtml();
  assert.match(html, /bridgeReadWrite\('gridLoggedIn', \(\) => gridLoggedIn, v => \{ gridLoggedIn = v; \}\)/, 'gridLoggedIn must now be read-write (gridCheckSession writes it)');
  assert.ok(!html.includes("bridgeReadOnly('gridLoggedIn'"), 'the old read-only gridLoggedIn entry must be gone, not duplicated alongside the new read-write one');
  assert.match(html, /bridgeReadWrite\('gridAccounts',\s*\(\)\s*=>\s*gridAccounts,\s*v\s*=>\s*\{\s*gridAccounts\s*=\s*v;\s*\}\)/);
  assert.match(html, /bridgeReadWrite\('gridPageInited',\s*\(\)\s*=>\s*gridPageInited,\s*v\s*=>\s*\{\s*gridPageInited\s*=\s*v;\s*\}\)/);
  assert.match(html, /bridgeReadOnly\('BACKEND_URL',\s*\(\)\s*=>\s*BACKEND_URL\)/);
  assert.match(html, /bridgeReadOnly\('ACCTID_KEY',\s*\(\)\s*=>\s*ACCTID_KEY\)/);
  assert.match(html, /bridgeReadOnly\('_acctData',\s*\(\)\s*=>\s*_acctData\)/);
});

test('index.html now has 28 bridge entries total (22 through Phase 1e/1h, +1 net for the gridLoggedIn upgrade replacing the old entry, +5 new)', () => {
  const html = readIndexHtml();
  const bridgeCount = (html.match(/bridgeRead(?:Only|Write)\('/g) || []).length;
  assert.equal(bridgeCount, 28, 'expected 23 entries after Phase 1h, minus 1 (old gridLoggedIn readonly removed), plus 1 (new gridLoggedIn readwrite) plus 5 new (gridAccounts, gridPageInited, BACKEND_URL, ACCTID_KEY, _acctData) = 28');
});

test('gridSessionAuth.js exports the six functions with real external callers, and does not export the three purely-internal ones', () => {
  const modSrc = readModule();
  for (const fn of ['gridPageInit', 'gridStartLogin', 'gridHandleRedirectReturn', 'gridLoadAccounts', 'gridMergeAccounts', 'gridSelectAccountFromPicker']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn}`);
  }
  for (const fn of ['gridCheckSession', 'gridCheckSessionWithRetry', 'gridBuildPicker']) {
    assert.ok(!modSrc.includes(`window.${fn} =`), `${fn} has no external callers and must not be exported`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
