/**
 * tests/refactor/fiveTickSignalEngineExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1d: guardrails for the 5-tick signal engine
 * extraction (src/trading/fiveTickSignalEngine.js).
 *
 * Unlike mfxBot/dabBot (pure consumers of main-script state via the
 * existing window.* accessor bridge), this section is a PRODUCER: the
 * classic main script reads/writes `ENG`/`engPageReady` and calls
 * `engineOnTick`/`engineMetrics`/`renderEngine` by bare name. Since an
 * ES module's top-level declarations do not auto-attach to `window`
 * (unlike a classic script's top-level function/var declarations), the
 * module itself defines the window accessors/exports its external
 * callers need, at its own tail end -- verified below directly, rather
 * than checking for entries in the shared bridge script (there are
 * none to check there for this slice; RUN_LENGTH/decimals, the only
 * two genuine external reads this module makes, were already bridged
 * by Phase 1b).
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'trading', 'fiveTickSignalEngine.js'), 'utf8');
}

test('index.html references src/trading/fiveTickSignalEngine.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/trading\/fiveTickSignalEngine\.js"><\/script>/);
});

test('index.html no longer contains the old inline 5-tick engine code (const ENG = { definition moved out)', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('const ENG = {'), 'the ENG config object literal must have moved to the module, not be duplicated inline');
  assert.ok(!html.includes('function engineOnTick(price, epoch, rawDir)'), 'engineOnTick body must have moved to the module');
});

test('fiveTickSignalEngine.js exports window.ENG (getter-only) and window.engPageReady (read-write) for the classic main script to use', () => {
  const modSrc = readModule();
  assert.match(modSrc, /Object\.defineProperty\(window,\s*'ENG',\s*\{\s*get:\s*\(\)\s*=>\s*ENG/, 'ENG must be exposed via a getter so window.ENG[key]=... mutates the real object in place');
  assert.match(modSrc, /Object\.defineProperty\(window,\s*'engPageReady'/, 'engPageReady must be exposed via an accessor');
  assert.match(modSrc, /set:\s*\(v\)\s*=>\s*\{\s*engPageReady\s*=\s*v;\s*\}/, 'engPageReady must be writable, since the main script sets it to true when the Engine page opens');
});

test('fiveTickSignalEngine.js exports window.engineOnTick, window.engineMetrics, window.renderEngine for the classic main script to call', () => {
  const modSrc = readModule();
  for (const fn of ['engineOnTick', 'engineMetrics', 'renderEngine']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn} so the classic main script's bare call resolves`);
  }
});

test('fiveTickSignalEngine.js does not export identifiers that have no external reference (engTicks, engStats, engLog, setDivBar, drawEngLine, etc.)', () => {
  const modSrc = readModule();
  const internalOnly = [
    'engTicks', 'engCarryDir', 'engPending', 'engStats', 'engLog', 'ENG_BASE',
    'engPrevTDabove', 'engPrevAccelPos', 'engTDbrokeAge', 'engAccelPosAge',
    'setDivBar', 'renderEngineLog', 'drawEngLine', 'drawEngTickCandles',
  ];
  for (const name of internalOnly) {
    assert.ok(!modSrc.includes(`window.${name}`), `${name} has no external reference and must not be exposed on window`);
  }
});

test('index.html already bridges the two genuine external reads this module makes (RUN_LENGTH, decimals) from Phase 1b -- no new bridge entries were needed for this slice', () => {
  const html = readIndexHtml();
  assert.match(html, /bridgeReadOnly\('RUN_LENGTH'/);
  assert.match(html, /bridgeReadWrite\('decimals'/);
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
