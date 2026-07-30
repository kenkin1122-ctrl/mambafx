/**
 * tests/phase8/sealExtraction.test.mjs
 *
 * Regression coverage for Phase R0 (FUTURE PROJECT prerequisite): the
 * Phase 8 seal is now extracted from index.html by marker comments
 * ("MSD-PHASE8-SEAL-START"/"MSD-PHASE8-SEAL-END") rather than by a
 * hardcoded absolute line-number range. These tests exist so that any
 * future accidental removal/duplication/reordering of those markers, or
 * any change to the sealed search-space definition itself, is caught by
 * `node --test` rather than relying solely on a manual `getSeal()` check.
 *
 * This does not replace the manual verification step (actually running
 * getSeal() and reading the printed hash) that this project's discipline
 * requires after any change that could plausibly affect the seal -- it's
 * an additional, automated regression pin on top of that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..', '..');

function readIndexHtml() {
  return fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
}

test('index.html contains exactly one MSD-PHASE8-SEAL-START marker and exactly one MSD-PHASE8-SEAL-END marker', () => {
  const html = readIndexHtml();
  const startMatches = html.match(/MSD-PHASE8-SEAL-START/g) || [];
  const endMatches = html.match(/MSD-PHASE8-SEAL-END/g) || [];
  assert.equal(startMatches.length, 1, 'exactly one START marker must exist -- duplicates would make the extraction ambiguous');
  assert.equal(endMatches.length, 1, 'exactly one END marker must exist -- duplicates would make the extraction ambiguous');
});

test('the START marker appears strictly before the END marker in index.html', () => {
  const html = readIndexHtml();
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx, 'markers must be present and correctly ordered');
});

test('getSeal() (marker-based extraction) reproduces the frozen search-space hash', () => {
  // Fresh require via the CJS interop path used elsewhere in this project's
  // Node-side verification (phase8-engine.js is intentionally CommonJS).
  const require = createRequire(import.meta.url);
  const engine = require('../../phase8-engine.js');
  const seal = engine.getSeal();
  assert.equal(seal.searchSpaceHash, '36b45239', 'the search-space hash must be unchanged by the marker-based re-baseline (Phase R0) -- this is a REGRESSION PIN, not a new computation');
  assert.equal(seal.totalCardinality, 80);
  assert.equal(seal.features.length, 16);
  assert.equal(seal.symbol, '1HZ100V');
});

test('the extracted region between the markers is non-empty and contains the expected first/last identifiers', () => {
  const html = readIndexHtml();
  const lines = html.split('\n');
  const startLineIdx = lines.findIndex(l => l.includes('MSD-PHASE8-SEAL-START'));
  const endLineIdx = lines.findIndex(l => l.includes('MSD-PHASE8-SEAL-END'));
  const extracted = lines.slice(startLineIdx + 1, endLineIdx);
  assert.ok(extracted.length > 8000, 'the sealed region is expected to be several thousand lines (was ~8100 pre-Phase-R0)');
  assert.ok(extracted[0].includes('msdEventSeq'), 'the first extracted line must still be the original first sealed identifier');
  assert.ok(extracted[extracted.length - 1].trim() === '' || extracted[extracted.length - 1].includes('MSD_ASSESSMENT'), 'the last extracted line must still match the original tail of the sealed region');
});
