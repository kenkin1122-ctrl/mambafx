/**
 * tests/refactor/dabBotExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1c: guardrails for the dabBot widget extraction
 * (src/ui/widgets/dabBot.js) and its one addition to the existing
 * window.* accessor bridge (gridOpenContracts). Dependency list was
 * independently verified for this file (not assumed identical to
 * mfxBot's) -- see the module's own header comment for why the first
 * automated analysis attempt was distrusted and redone.
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
  'MARKETS', 'SYMBOL', 'decimals', 'gridAuthed', 'gridCurrency', 'gridIsVirtual',
  'gridPending', 'gridReqId', 'gridWs', 'lastPrice', 'runDir', 'runLen', 'ticks',
  'gridOpenContracts',
];

function readIndexHtml() {
  return fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
}

test('index.html references src/ui/widgets/dabBot.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/ui\/widgets\/dabBot\.js"><\/script>/);
});

test('index.html no longer contains the old inline dabBot code (window.dabFire body moved out)', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('function dabFire('), 'the function body must have moved to the module, not be duplicated inline');
});

test('every identifier dabBot.js needs has a live window.* accessor bridge in index.html, defined BEFORE the module reference (including the new gridOpenContracts addition)', () => {
  const html = readIndexHtml();
  const bridgeIdx = html.indexOf('FUTURE PROJECT Phase 1b -- live window.* accessor bridge');
  const moduleIdx = html.indexOf('<script type="module" src="src/ui/widgets/dabBot.js">');
  assert.ok(bridgeIdx >= 0, 'the bridge block must exist');
  assert.ok(moduleIdx >= 0, 'the module reference must exist');
  assert.ok(bridgeIdx < moduleIdx, 'the bridge must be defined before dabBot.js is loaded, or the widget would read undefined values on its first tick');

  for (const ident of EXPECTED_BRIDGED_IDENTIFIERS) {
    const pattern = new RegExp(`bridgeRead(?:Only|Write)\\('${ident}'`);
    assert.match(html, pattern, `identifier "${ident}" must have a bridge entry`);
  }
});

test('src/ui/widgets/dabBot.js exists and defines its expected window.* entry points', () => {
  const modSrc = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'widgets', 'dabBot.js'), 'utf8');
  for (const fn of ['dabSetOuDur', 'dabOnContractChange', 'dabFire', 'dabToggleAuto']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*(?:function|dabFire)`), `dabBot.js must still define window.${fn}`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
