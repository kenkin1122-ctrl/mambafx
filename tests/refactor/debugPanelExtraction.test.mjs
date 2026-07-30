/**
 * tests/refactor/debugPanelExtraction.test.mjs
 *
 * FUTURE PROJECT Phase 1, slice 1: guardrails for the debug-panel-renderer
 * extraction (src/dashboard/debugPanel.js). Confirms the extraction is wired
 * correctly and that the module stays structurally self-contained (no bare
 * cross-script identifier reads sneaking in later), matching the same
 * "check the actual module source, not just that it exists" discipline
 * used throughout research/integration/'s guardrail tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..', '..');

test('index.html references src/dashboard/debugPanel.js as an ES module (not an inline script)', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="src\/dashboard\/debugPanel\.js"><\/script>/);
});

test('index.html no longer contains the old inline debug-panel-renderer code (mfxRenderDebugPanel body moved out)', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  // The function definition itself must be gone from index.html; the
  // static onclick="mfxToggleDebugPanel()" button reference is expected
  // to remain (it looks the function up dynamically at click time).
  assert.ok(!html.includes('window.mfxRenderDebugPanel = function'), 'the function body must have moved to the module, not be duplicated inline');
});

test('src/dashboard/debugPanel.js exists and defines both expected window.* entry points', () => {
  const modSrc = fs.readFileSync(path.join(repoRoot, 'src', 'dashboard', 'debugPanel.js'), 'utf8');
  assert.match(modSrc, /window\.mfxToggleDebugPanel\s*=\s*function/);
  assert.match(modSrc, /window\.mfxRenderDebugPanel\s*=\s*function/);
});

test('src/dashboard/debugPanel.js reads no bare (non-window-qualified) identifier from index.html\'s other scripts -- its only external read is window.__mfxDebug', () => {
  const rawSrc = fs.readFileSync(path.join(repoRoot, 'src', 'dashboard', 'debugPanel.js'), 'utf8');
  // Strip comments before checking -- the module's own header comment
  // explains, in prose, exactly which bare identifiers a SIBLING module
  // (mfxBot) depends on and was therefore NOT extracted in this slice;
  // that explanatory prose must never false-positive this check against
  // the module's own executable code. (The same comment-vs-executable-code
  // lesson already applied throughout research/integration/'s guardrail
  // tests, e.g. scheduler.test.mjs's feature-flag check.)
  const modSrc = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const forbiddenBareIdentifiers = ['gridWs', 'gridAuthed', 'gridPlaceTrade', 'lastPrice', 'SYMBOL', 'decimals', 'MARKETS', 'runLen', 'runDir', 'RUN_LENGTH', 'ticks'];
  for (const ident of forbiddenBareIdentifiers) {
    assert.ok(!modSrc.includes(ident), `debugPanel.js's executable code must never reference "${ident}" -- that identifier only exists as a let/const in index.html's main script and is invisible to an ES module`);
  }
});

test('the Phase 8 seal markers are unaffected by this extraction (still present, still correctly ordered)', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const startIdx = html.indexOf('MSD-PHASE8-SEAL-START');
  const endIdx = html.indexOf('MSD-PHASE8-SEAL-END');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx);
});
