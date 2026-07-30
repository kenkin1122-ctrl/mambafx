/**
 * tests/refactor/mfxBotExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1b: guardrails for the mfxBot widget extraction
 * (src/ui/widgets/mfxBot.js) and its prerequisite window.* accessor
 * bridge in index.html. Unlike debugPanel.js (Phase 1 slice 1), this
 * extraction required an additive bridge because mfxBot's code reads
 * several `let`/`const` bindings from index.html's main script that are
 * invisible to an ES module -- these tests confirm the bridge exists,
 * covers every identifier mfxBot needs, and is wired in the correct
 * document order (bridge before the module reference).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..', '..');

const EXPECTED_BRIDGED_IDENTIFIERS = [
  'MARKETS', 'RUN_LENGTH', 'ticks', 'gridPending',
  'SYMBOL', 'lastPrice', 'runDir', 'runLen', 'decimals', 'gridConnecting',
  'gridWs', 'gridLoginId', 'gridTrades', 'gridReqId', 'digTrades',
  'gridAuthed', 'gridBalance', 'gridCurrency', 'gridIsVirtual',
];

function readIndexHtml() {
  return fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
}

test('index.html references src/ui/widgets/mfxBot.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/ui\/widgets\/mfxBot\.js"><\/script>/);
});

test('index.html no longer contains the old inline mfxBot code (window.mfxQuickTrade body moved out)', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('window.mfxQuickTrade = function'), 'the function body must have moved to the module, not be duplicated inline');
});

test('every identifier mfxBot.js needs has a live window.* accessor bridge in index.html, defined BEFORE the module reference', () => {
  const html = readIndexHtml();
  const bridgeIdx = html.indexOf('FUTURE PROJECT Phase 1b -- live window.* accessor bridge');
  const moduleIdx = html.indexOf('<script type="module" src="src/ui/widgets/mfxBot.js">');
  assert.ok(bridgeIdx >= 0, 'the bridge block must exist');
  assert.ok(moduleIdx >= 0, 'the module reference must exist');
  assert.ok(bridgeIdx < moduleIdx, 'the bridge must be defined before mfxBot.js is loaded, or the widget would read undefined values on its first tick');

  for (const ident of EXPECTED_BRIDGED_IDENTIFIERS) {
    const pattern = new RegExp(`bridgeRead(?:Only|Write)\\('${ident}'`);
    assert.match(html, pattern, `identifier "${ident}" must have a bridge entry`);
  }
});

test('src/ui/widgets/mfxBot.js exists and defines its expected window.* entry points', () => {
  const modSrc = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'widgets', 'mfxBot.js'), 'utf8');
  for (const fn of ['mfxOnContractTypeChange', 'mfxSetOuDur', 'mfxShowPlTab', 'mfxQuickTrade', 'mfxToggleRun', 'mfxChangeMarket']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*function`), `mfxBot.js must still define window.${fn}`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
