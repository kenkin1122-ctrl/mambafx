/**
 * tests/refactor/featureEngineeringExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1e: guardrails for the ML feature-engineering
 * block extraction (src/features/featureEngineering.js).
 *
 * Same producer-side pattern as Phase 1d (src/trading/fiveTickSignalEngine.js):
 * the classic main script calls this module's functions and reads its
 * `_FEAT_DEFS` constant by bare name, so the module exports window
 * accessors for its own state/functions rather than relying on the
 * shared bridge (which only has closure access to the MAIN SCRIPT's
 * bindings). This module's own external reads ($ and signalRecords)
 * ARE new entries in that shared bridge, since those are genuinely
 * owned by the main script.
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
  return fs.readFileSync(path.join(repoRoot, 'src', 'features', 'featureEngineering.js'), 'utf8');
}

test('index.html references src/features/featureEngineering.js as an ES module (not an inline script)', () => {
  const html = readIndexHtml();
  assert.match(html, /<script type="module" src="src\/features\/featureEngineering\.js"><\/script>/);
});

test('index.html no longer contains the old inline feature-engineering code (_FEAT_DEFS definition moved out)', () => {
  const html = readIndexHtml();
  assert.ok(!html.includes('const _FEAT_DEFS = (function(){'), 'the _FEAT_DEFS IIFE must have moved to the module, not be duplicated inline');
  assert.ok(!html.includes('function featComputeAll('), 'featComputeAll body must have moved to the module');
});

test('index.html gained exactly two new getter-only bridge entries ($ and signalRecords) for this module\'s own external reads', () => {
  const html = readIndexHtml();
  assert.match(html, /bridgeReadOnly\('\$',\s*\(\)\s*=>\s*\$\)/, '$ (DOM helper) must be bridged read-only -- never reassigned by this module');
  assert.match(html, /bridgeReadOnly\('signalRecords',\s*\(\)\s*=>\s*signalRecords\)/, 'signalRecords must be bridged read-only -- only read, never mutated, by this module');
});

test('featureEngineering.js exports window._FEAT_DEFS (getter-only) and the 7 functions read/called from the classic main script', () => {
  const modSrc = readModule();
  assert.match(modSrc, /Object\.defineProperty\(window,\s*'_FEAT_DEFS',\s*\{\s*get:\s*\(\)\s*=>\s*_FEAT_DEFS/, '_FEAT_DEFS must be exposed via a getter (never reassigned)');
  for (const fn of ['featComputeAll', 'featMutualInfo', 'featRfImportance', 'featShap', 'featPageInit', 'featCompute', 'featExportCsv']) {
    assert.match(modSrc, new RegExp(`window\\.${fn}\\s*=\\s*${fn};`), `${fn} must be assigned to window.${fn}`);
  }
});

test('featureEngineering.js does not export _featCache (no external reference)', () => {
  const modSrc = readModule();
  assert.ok(!modSrc.includes('window._featCache'), '_featCache has no external reference and must not be exposed on window');
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
