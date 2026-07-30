/**
 * research/src/validation/ContextIndependenceDiagnostics.js
 *
 * Purpose:
 *   Diagnostics that check whether context plugins registered in a ContextRegistry
 *   are (approximately) independent of each other, to guide researchers in avoiding
 *   redundant or collinear context variables in conditional hypotheses.
 *
 *   Checks performed:
 *     1. observableInputs overlap — two plugins sharing all the same observable
 *        inputs are likely measuring highly correlated constructs.
 *     2. Name-prefix collision — two plugins sharing a common display name prefix
 *        may indicate accidental duplication.
 *     3. Single-plugin registry — a registry with only one plugin cannot be
 *        assessed for independence.
 *
 *   These are DIAGNOSTIC (warnings), not hard failures. The function returns
 *   { warnings: string[], checks: CheckResult[] } so the researcher can review
 *   and decide whether the overlaps are intentional.
 *
 * Design philosophy:
 *   Full statistical independence tests (e.g. mutual information, Pearson
 *   correlation) require compute(inputs) results and are out of scope here —
 *   this module performs structural checks on plugin metadata only, which
 *   can run without data. Data-based independence tests belong in hypothesis
 *   testing workflows.
 *
 * Scientific rationale:
 *   Collinear context variables inflate Type I error rates in conditional
 *   hypothesis testing. Even purely structural checks (shared observables,
 *   common naming) are useful early warnings before expensive data-driven tests.
 *
 * Dependencies: context/ContextRegistry.js (type only — no import needed).
 * Public API: runContextIndependenceDiagnostics, ContextIndependenceDiagnostics.
 * Complexity: O(P²·k) where P = plugin count, k = max observableInputs length.
 */

/**
 * @typedef {{ checkName: string, passed: boolean, detail: string }} CheckResult
 */

/**
 * Runs structural independence diagnostics over all plugins in a registry.
 *
 * @param {import('../context/ContextRegistry.js').ContextRegistry} registry
 * @returns {{ warnings: string[], checks: CheckResult[], pluginCount: number }}
 */
export function runContextIndependenceDiagnostics(registry) {
  if (!registry || typeof registry.list !== 'function') {
    return {
      warnings: ['registry: expected a ContextRegistry instance'],
      checks: [],
      pluginCount: 0,
    };
  }

  const plugins = registry.list();
  const warnings = [];
  const checks = [];

  // ── Check 1: registry has at least 2 plugins ───────────────────────────
  const hasEnoughPlugins = plugins.length >= 2;
  checks.push({
    checkName: 'MinimumPluginCount',
    passed: hasEnoughPlugins,
    detail: hasEnoughPlugins
      ? `Registry has ${plugins.length} plugins — independence can be assessed.`
      : `Registry has ${plugins.length} plugin(s) — independence is trivially undefined.`,
  });
  if (!hasEnoughPlugins) {
    return { warnings, checks, pluginCount: plugins.length };
  }

  // Build metadata for each plugin (safely).
  const pluginMeta = plugins.map(p => {
    let meta = null;
    try { meta = p.metadata(); } catch { /* skip */ }
    return { name: meta?.name ?? '(unnamed)', observableInputs: meta?.observableInputs ?? [] };
  });

  // ── Check 2: pairwise observableInputs overlap ─────────────────────────
  for (let i = 0; i < pluginMeta.length; i++) {
    for (let j = i + 1; j < pluginMeta.length; j++) {
      const a = pluginMeta[i];
      const b = pluginMeta[j];
      const aSet = new Set(a.observableInputs);
      const bSet = new Set(b.observableInputs);
      const intersection = [...aSet].filter(v => bSet.has(v));
      const aLen = aSet.size;
      const bLen = bSet.size;
      const fullyOverlaps = aLen > 0 && bLen > 0 && intersection.length === aLen && intersection.length === bLen;
      const partialOverlap = intersection.length > 0 && !fullyOverlaps;

      if (fullyOverlaps) {
        const msg =
          `"${a.name}" and "${b.name}" share ALL observable inputs ` +
          `(${intersection.join(', ')}) — likely correlated; consider merging or removing one.`;
        warnings.push(msg);
        checks.push({ checkName: `FullObservableOverlap(${a.name},${b.name})`, passed: false, detail: msg });
      } else if (partialOverlap) {
        const msg =
          `"${a.name}" and "${b.name}" share observable inputs: ${intersection.join(', ')}. ` +
          `Partial overlap — monitor for collinearity in data-driven independence tests.`;
        checks.push({ checkName: `PartialObservableOverlap(${a.name},${b.name})`, passed: true, detail: msg });
      } else {
        checks.push({
          checkName: `ObservableOverlap(${a.name},${b.name})`,
          passed: true,
          detail: `No observable input overlap between "${a.name}" and "${b.name}".`,
        });
      }
    }
  }

  // ── Check 3: name-prefix collision ─────────────────────────────────────
  const names = pluginMeta.map(m => m.name);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const prefixLen = Math.min(names[i].length, names[j].length, 10);
      const prefixA = names[i].slice(0, prefixLen);
      const prefixB = names[j].slice(0, prefixLen);
      if (prefixA === prefixB) {
        const msg = `"${names[i]}" and "${names[j]}" share a name prefix — verify these are not accidental duplicates.`;
        warnings.push(msg);
        checks.push({ checkName: `NamePrefixCollision(${names[i]},${names[j]})`, passed: false, detail: msg });
      }
    }
  }

  return Object.freeze({ warnings, checks, pluginCount: plugins.length });
}

/**
 * Namespace object for import convenience.
 */
export const ContextIndependenceDiagnostics = Object.freeze({
  runContextIndependenceDiagnostics,
});
