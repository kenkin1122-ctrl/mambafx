/**
 * ui/smartIntelligencePanel.js
 *
 * The DOM layer for Smart Market Intelligence — takes the narrative engine's
 * structured report and renders it as prose, never surfacing raw numbers,
 * gauges, or indicator values (per the feature's own requirement). Auto-
 * updates on every trigger the spec calls for: selected drawing/candle,
 * timeframe, symbol, replay position, and decomposition — all of which
 * already emit events this module subscribes to, so no new event plumbing
 * was needed beyond what Phases 1-15 already built.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { generateIntelligenceReport } from '../ai/narrativeEngine.js';
import { runProbabilityEngine } from '../ai/probabilityEngine.js';

const BIAS_STYLE = {
  bullish: { label: 'Bullish', color: '#1fdf9b' },
  bearish: { label: 'Bearish', color: '#ff4d6a' },
  ranging: { label: 'Ranging', color: '#94a3b8' },
  neutral: { label: 'Neutral', color: '#94a3b8' },
};

const VERDICT_STYLE = {
  Rise: '#1fdf9b', Fall: '#ff4d6a', Wait: '#ffc857',
};

let updateScheduled = false;

function scheduleUpdate() {
  // Coalesce bursts of events (e.g. a symbol switch fires several triggers
  // in quick succession) into a single report generation, same rAF-style
  // coalescing principle used by the Phase 2 rendering engine — just on a
  // microtask instead of a frame, since this isn't a canvas repaint.
  if (updateScheduled) return;
  updateScheduled = true;
  Promise.resolve().then(() => { updateScheduled = false; render(); });
}

const DIM_NAMES = {
  trend: 'trend direction', momentum: 'momentum', structure: 'market structure', liquidity: 'liquidity behavior',
  orderFlow: 'order flow', historicalSim: 'historical analogs', candleGenome: 'candle-level pattern similarity', mtfAlignment: 'multi-timeframe alignment',
};

/** Translates the dimension score list into one plain-language sentence — the individual weighted scores stay internal (console-inspectable via prob.dimensions), never shown as a raw number table, consistent with "conclusions, not indicators." */
function describeProbabilityFactors(prob) {
  const agreeing = prob.dimensions.filter(d => d.score !== 0 && Math.sign(d.score) === Math.sign(prob.weightedScore || 1));
  const names = agreeing.map(d => DIM_NAMES[d.name]).filter(Boolean);
  if (!names.length) return 'No single factor currently dominates this assessment — the evidence is mixed across trend, momentum, structure, liquidity, order flow, and historical analogs.';
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1] : names[0];
  return `This assessment weighs eight factors together; ${list} currently ${names.length === 1 ? 'points' : 'point'} in the same direction as the stated bias.`;
}

function render() {
  const wrap = $("mtfIntelligenceBody");
  if (!wrap) return;

  const { htf, ltf } = AppState.panels;
  if (!htf) return;

  const report = generateIntelligenceReport(
    htf.candles, ltf ? ltf.candles : [],
    { htfLabel: htf.tf.label, ltfLabel: ltf ? ltf.tf.label : '' }
  );

  if (!report.sufficientData) {
    wrap.innerHTML = `<div class="manager-empty">${report.narrative}</div>`;
    return;
  }

  const biasStyle = BIAS_STYLE[report.bias] || BIAS_STYLE.neutral;
  const verdictColor = VERDICT_STYLE[report.tradeAssessment.verdict] || '#94a3b8';
  const prob = runProbabilityEngine(htf.candles, ltf ? ltf.candles : [], report.bias);

  wrap.innerHTML = `
    <div class="smi-section">
      <div class="smi-bias" style="color:${biasStyle.color}">${biasStyle.label}</div>
      <div class="smi-bias-sub">Overall market bias</div>
    </div>

    <div class="smi-section">
      <div class="smi-title">Market Narrative</div>
      <p class="smi-prose">${report.narrative}</p>
    </div>

    ${report.mtfNarrative.length ? `
    <div class="smi-section">
      <div class="smi-title">Synchronized Timeframe View</div>
      ${report.mtfNarrative.map((r, i) => `
        <div class="smi-tf-rung">
          <div class="smi-tf-label">${r.label}</div>
          <div class="smi-tf-text">${r.text}</div>
        </div>
        ${i < report.mtfNarrative.length - 1 ? '<div class="smi-tf-arrow">↓</div>' : ''}
      `).join('')}
    </div>` : ''}

    <div class="smi-section">
      <div class="smi-title">Trade Assessment</div>
      <div class="smi-verdict" style="color:${verdictColor}">${report.tradeAssessment.verdict}</div>
      ${report.tradeAssessment.reasoning.map(r => `<p class="smi-prose">${r}</p>`).join('')}
    </div>

    ${prob ? `
    <div class="smi-section">
      <div class="smi-title">Probability Assessment</div>
      <div class="smi-prob-row">
        <div class="smi-prob-item"><div class="smi-prob-val" style="color:#1fdf9b">${prob.pContinue}%</div><div class="smi-prob-lab">Continuation</div></div>
        <div class="smi-prob-item"><div class="smi-prob-val" style="color:#ff4d6a">${prob.pReverse}%</div><div class="smi-prob-lab">Reversal</div></div>
        <div class="smi-prob-item"><div class="smi-prob-val" style="color:#ffc857">${prob.confidence}%</div><div class="smi-prob-lab">Confidence</div></div>
      </div>
      <p class="smi-prose">${describeProbabilityFactors(prob)}</p>
      <p class="smi-prose" style="color:var(--mtf-muted);font-size:10.5px">Probabilistic decision support derived from currently loaded data — not a prediction of future price action.</p>
    </div>` : ''}

    <div class="smi-section">
      <div class="smi-title">Key Supporting Evidence</div>
      <ul class="smi-list">${report.evidence.map(e => `<li>${e}</li>`).join('')}</ul>
    </div>

    <div class="smi-section">
      <div class="smi-title">Contradicting Evidence</div>
      <ul class="smi-list smi-list-risk">${report.contradictingEvidence.map(e => `<li>${e}</li>`).join('')}</ul>
    </div>

    <div class="smi-section">
      <div class="smi-title">What Would Invalidate This View</div>
      <ul class="smi-list smi-list-risk">${report.risks.map(r => `<li>${r}</li>`).join('')}</ul>
    </div>

    <div class="smi-section">
      <div class="smi-title">Historical Context</div>
      <p class="smi-prose">${report.historicalContext}</p>
    </div>

    <div class="smi-disclaimer">Deterministic, rule-based synthesis of this module's own analysis engines — not a prediction, not financial advice, and not generated by an external AI model.</div>
  `;
}

export function initSmartIntelligencePanel() {
  eventBus.on('selection:changed', scheduleUpdate);
  eventBus.on('symbol:changed', scheduleUpdate);
  eventBus.on('panel:dataUpdated', scheduleUpdate); // covers timeframe switches AND decomposition (both trigger a data refetch)
  eventBus.on('replay:changed', scheduleUpdate);
  render();
}
