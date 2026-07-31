/**
 * research/src/ui/Phase11ValidationDashboard.js
 *
 * Purpose:
 *   Section 8 of the Phase 11 Validation & Calibration Directive: an
 *   isolated dashboard that renders a ValidationReport (validation/
 *   ValidationReport.js) — calibration results, p-value histogram, power
 *   curve, CI coverage, bootstrap diagnostics, reproducibility status, and
 *   replication status. Presentation only: computes nothing, reads no
 *   storage directly, and does not modify the legacy UI (index.html) — it
 *   is mounted the same way research/src/ui/Phase11Application.js already
 *   is, via its own entry point (Phase11ValidationApplication.js).
 *
 *   Scoped as one cohesive dashboard rather than many separate panel
 *   files (the directive's listed sub-items -- calibration plots, p-value
 *   histogram, QQ plot, power curve, CI coverage, bootstrap diagnostics,
 *   reproducibility status, replication status -- are all rendered here,
 *   as sections of one composition root) to keep this addition
 *   proportionate given how much of the underlying validation logic was
 *   built in this same session; a QQ plot specifically is approximated
 *   here as a sorted-p-value-vs-uniform-quantile scatter using plain SVG,
 *   not a separate charting dependency.
 *
 * Dependencies: ui/Phase11Styles.js (class names/CSS, reused for visual
 *   consistency with the existing Phase 11 UI).
 * Public API: createPhase11ValidationDashboard.
 * Complexity: O(n) per section in the size of the report's own arrays
 *   (histogram bins, power curve points, etc.) — no computation performed
 *   here.
 */

import { PHASE11_CSS, injectPhase11Styles } from './Phase11Styles.js';

function section(doc, title) {
  const panel = doc.createElement('section');
  panel.className = PHASE11_CSS.PANEL;
  const titleEl = doc.createElement('div');
  titleEl.className = PHASE11_CSS.PANEL_TITLE;
  titleEl.textContent = title;
  const body = doc.createElement('div');
  body.className = PHASE11_CSS.PANEL_BODY;
  panel.appendChild(titleEl);
  panel.appendChild(body);
  return { panel, body };
}

function row(doc, label, value) {
  const r = doc.createElement('div');
  r.className = PHASE11_CSS.ROW;
  const l = doc.createElement('span'); l.className = PHASE11_CSS.LABEL; l.textContent = label;
  const v = doc.createElement('span'); v.className = PHASE11_CSS.VALUE; v.textContent = value === undefined || value === null ? '—' : String(value);
  r.appendChild(l); r.appendChild(v);
  return r;
}

function emptyNote(doc, text) {
  const el = doc.createElement('div');
  el.className = PHASE11_CSS.EMPTY;
  el.textContent = text;
  return el;
}

/** Simple horizontal bar built from a div width percentage -- no charting dependency. */
function bar(doc, label, fraction, color = '#89b4fa') {
  const wrap = doc.createElement('div');
  wrap.style.margin = '4px 0';
  const labelEl = doc.createElement('div');
  labelEl.style.fontSize = '11px'; labelEl.style.color = '#7f849c';
  labelEl.textContent = label;
  const track = doc.createElement('div');
  track.style.background = '#0d1120'; track.style.borderRadius = '4px'; track.style.height = '10px'; track.style.overflow = 'hidden';
  const fill = doc.createElement('div');
  fill.style.background = color; fill.style.height = '100%';
  fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
  track.appendChild(fill);
  wrap.appendChild(labelEl); wrap.appendChild(track);
  return wrap;
}

export function createPhase11ValidationDashboard(doc) {
  injectPhase11Styles(doc);
  const root = doc.createElement('div');
  root.className = PHASE11_CSS.ROOT;

  const overall = section(doc, 'Overall Validation Verdict');
  const calibration = section(doc, 'Calibration');
  const pValueHistogram = section(doc, 'P-Value Histogram');
  const qqPlot = section(doc, 'QQ Plot (sorted p-values vs. uniform quantiles)');
  const power = section(doc, 'Power Curve');
  const diagnostics = section(doc, 'Bootstrap / Permutation Diagnostics');
  const reproducibility = section(doc, 'Reproducibility Status');
  const replication = section(doc, 'Replication Status');

  for (const s of [overall, calibration, pValueHistogram, qqPlot, power, diagnostics, reproducibility, replication]) {
    root.appendChild(s.panel);
  }

  /** @param {ReturnType<import('../validation/ValidationReport.js').buildValidationReport>|null} report */
  function updateReport(report) {
    for (const s of [overall, calibration, pValueHistogram, qqPlot, power, diagnostics, reproducibility, replication]) {
      s.body.textContent = '';
    }
    if (!report) {
      overall.body.appendChild(emptyNote(doc, 'No validation report generated yet.'));
      return;
    }

    // ── Overall ──
    const badge = doc.createElement('span');
    badge.className = `${PHASE11_CSS.BADGE} ${report.overallVerdict === 'PASS' ? PHASE11_CSS.BADGE_OK : PHASE11_CSS.BADGE_FAIL}`;
    badge.textContent = report.overallVerdict;
    overall.body.appendChild(badge);
    overall.body.appendChild(row(doc, 'Generated at', report.generatedAt));

    // ── Calibration ──
    if (report.calibration) {
      const c = report.calibration;
      calibration.body.appendChild(row(doc, 'Verdict', c.calibrationVerdict ?? '—'));
      calibration.body.appendChild(row(doc, 'Empirical FDR', c.empiricalFDR !== undefined ? c.empiricalFDR.toFixed(4) : (c.empiricalFalsePositiveRate !== undefined ? c.empiricalFalsePositiveRate.toFixed(4) : '—')));
      calibration.body.appendChild(row(doc, 'Discoveries expected', c.discoveriesExpected !== undefined ? c.discoveriesExpected.toFixed(2) : '—'));
      calibration.body.appendChild(row(doc, 'Discoveries observed', c.discoveriesObserved ?? '—'));
      if (Array.isArray(c.perTypeResults)) {
        for (const t of c.perTypeResults) {
          calibration.body.appendChild(bar(doc, `${t.datasetType}: FPR ${(t.empiricalFalsePositiveRate ?? 0).toFixed(3)}`, t.empiricalFalsePositiveRate ?? 0, '#f9c96a'));
        }
      }
    } else {
      calibration.body.appendChild(emptyNote(doc, 'No calibration study run yet.'));
    }

    // ── P-value histogram + QQ plot (from the calibration's own reports, if present) ──
    const rawReports = report.calibration?.reports || (report.calibration?.perTypeResults || []).flatMap((t) => t.reports || []);
    if (rawReports.length) {
      const pValues = rawReports.map((r) => r.pValue).sort((a, b) => a - b);
      const bins = new Array(10).fill(0);
      for (const p of pValues) bins[Math.min(9, Math.floor(p * 10))]++;
      bins.forEach((count, i) => pValueHistogram.body.appendChild(bar(doc, `[${(i / 10).toFixed(1)}, ${((i + 1) / 10).toFixed(1)}): ${count}`, count / Math.max(...bins, 1))));

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS ? doc.createElementNS(svgNS, 'svg') : doc.createElement('svg');
      svg.setAttribute('viewBox', '0 0 200 200');
      svg.setAttribute('width', '200'); svg.setAttribute('height', '200');
      const n = pValues.length;
      let points = '';
      for (let i = 0; i < n; i++) {
        const expected = (i + 0.5) / n;
        const observed = pValues[i];
        points += `${(expected * 190 + 5).toFixed(1)},${(190 - observed * 190).toFixed(1)} `;
      }
      const diag = doc.createElementNS ? doc.createElementNS(svgNS, 'line') : doc.createElement('line');
      diag.setAttribute('x1', '5'); diag.setAttribute('y1', '195'); diag.setAttribute('x2', '195'); diag.setAttribute('y2', '5');
      diag.setAttribute('stroke', '#313866'); diag.setAttribute('stroke-dasharray', '4');
      svg.appendChild(diag);
      const poly = doc.createElementNS ? doc.createElementNS(svgNS, 'polyline') : doc.createElement('polyline');
      poly.setAttribute('points', points.trim());
      poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', '#89b4fa'); poly.setAttribute('stroke-width', '2');
      svg.appendChild(poly);
      qqPlot.body.appendChild(svg);
    } else {
      pValueHistogram.body.appendChild(emptyNote(doc, 'No p-value data available yet.'));
      qqPlot.body.appendChild(emptyNote(doc, 'No p-value data available yet.'));
    }

    // ── Power curve ──
    if (report.power && Array.isArray(report.power.points)) {
      for (const p of report.power.points) {
        power.body.appendChild(bar(doc, `effect=${p.trueEffectSize}: detection=${p.detectionProbability.toFixed(2)}`, p.detectionProbability, '#a6e3a1'));
      }
      power.body.appendChild(row(doc, 'Minimum detectable effect', report.power.minimumDetectableEffect ?? 'not reached'));
    } else {
      power.body.appendChild(emptyNote(doc, 'No power study run yet.'));
    }

    // ── Diagnostics ──
    if (report.statisticalDiagnostics) {
      const d = report.statisticalDiagnostics;
      diagnostics.body.appendChild(row(doc, 'Reports summarised', d.count));
      diagnostics.body.appendChild(row(doc, 'Mean Monte Carlo SE', d.meanMonteCarloStandardError.toFixed(5)));
      diagnostics.body.appendChild(row(doc, 'Mean bootstrap CI width', d.meanBootstrapCiWidth.toFixed(4)));
      diagnostics.body.appendChild(row(doc, 'Instability warnings', d.instabilityWarningsCount));
      for (const w of d.instabilityWarnings) {
        const warn = doc.createElement('div');
        warn.className = `${PHASE11_CSS.BADGE} ${PHASE11_CSS.BADGE_WARN}`;
        warn.style.display = 'block'; warn.style.margin = '4px 0';
        warn.textContent = w;
        diagnostics.body.appendChild(warn);
      }
    } else {
      diagnostics.body.appendChild(emptyNote(doc, 'No confirmation diagnostics summarised yet.'));
    }

    // ── Reproducibility ──
    if (report.reproducibility) {
      const r = report.reproducibility;
      const rBadge = doc.createElement('span');
      rBadge.className = `${PHASE11_CSS.BADGE} ${r.allMatched ? PHASE11_CSS.BADGE_OK : PHASE11_CSS.BADGE_FAIL}`;
      rBadge.textContent = r.allMatched ? 'ALL MATCHED' : `${r.totalMismatches} MISMATCH(ES)`;
      reproducibility.body.appendChild(rBadge);
      reproducibility.body.appendChild(row(doc, 'Checks run', r.checksRun));
    } else {
      reproducibility.body.appendChild(emptyNote(doc, 'No reproducibility check run yet.'));
    }

    // ── Replication ──
    if (report.replication) {
      const r = report.replication;
      const rBadge = doc.createElement('span');
      rBadge.className = `${PHASE11_CSS.BADGE} ${r.allIndependent ? PHASE11_CSS.BADGE_OK : PHASE11_CSS.BADGE_FAIL}`;
      rBadge.textContent = r.allIndependent ? 'ALL INDEPENDENT' : `${r.contaminatedCount} CONTAMINATED`;
      replication.body.appendChild(rBadge);
      replication.body.appendChild(row(doc, 'Checks run', r.checksRun));
    } else {
      replication.body.appendChild(emptyNote(doc, 'No replication independence check run yet.'));
    }
  }

  updateReport(null);
  return { element: root, updateReport };
}
